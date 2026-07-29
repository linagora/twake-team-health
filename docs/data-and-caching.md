# Data, persistence and caching

This is the heart of why the app is fast and gentle on GitHub. It has three layers
that work together: a Postgres store of historical metrics, a per-month freshness
rule that decides what to fetch, and a Redis-backed report cache with cross-replica
single-flight.

## The incremental model

The guiding rule: **completed months are computed once and persisted forever; the
in-progress month is fetched live and kept fresh briefly.**

The report builder (`report.ts`) implements it:

- `freshnessFloor(month)` returns the instant before which a stored row counts as
  stale. For a completed month that floor is the end of the month, so a row is
  valid as long as it was fetched after the month closed. For the current month the
  floor is `now - CURRENT_MONTH_TTL_MS` (default 6 hours).
- `monthsToFetch()` walks the requested window and marks a month stale if any of
  its expected rows is missing or older than the floor.
- Only stale months are fetched from GitHub, per repo. Results are upserted; the
  current month is refreshed in place on its TTL, completed months effectively
  never again.

Because persistence happens as a side effect of requests, the database fills in
gradually as people use the app. There is no separate sync job to run or babysit.

### Partial-failure behavior

Refresh is per repo and atomic per upsert batch. If repo N fails partway through a
refresh, repos 1 through N-1 are already persisted and the next request retries
only what is still stale. A report is served from whatever is persisted; it only
errors out when there is nothing stored and the live fetch also fails.

### No-database mode

When `DATABASE_URL` is unset, `hasDb()` is false and everything is fetched live
with no persistence. Useful for a demo, but it means every uncached request hits
GitHub, so it is not for production.

## Schema

Drizzle ORM over the postgres-js driver, defined in
`src/lib/server/db/schema.ts`. Six tables:

- **repo_month** keyed by `(owner, repo, month)`: the per-repo monthly rollup. PR
  counts (created, merged, closed), code volume, the per-PR medians, issue and bug
  counts, open counts, releases, bug resolution days and rate, and a `fetched_at`
  timestamp that drives the freshness rule. One row is shared by every team that
  includes that repo.
- **member_repo_month** keyed by `(login, owner, repo, month)`: per-member commits,
  merged PRs, additions and deletions, plus `fetched_at`. Missing tuples are stored
  as zeros so `fetched_at` marks the month as complete rather than leaving holes.
- **review_repo_month** keyed by `(reviewer, owner, repo, month)`: reviews and
  comments per reviewer (including non-members), with a secondary index on
  `(owner, repo, month)` for reads that do not filter by reviewer.
- **team** keyed by a UUID with an `owner_sub` index: per-user private teams, with
  `name`, `members` and `repos` stored as JSONB.
- **app_config**: a single row (`id = 'app'`) holding the admin settings override
  blob as JSONB. See [configuration.md](./configuration.md).
- **audit_log**: one row per request and per semantic action, with user, kind
  (`http`, `action`, `security`), the action or `METHOD /path`, HTTP metadata, a
  `suspicious` flag and a JSONB `detail`. Indexed by user, time, kind and
  suspicious.

## Report assembly

`assemble.ts` is a pure function: it folds persisted rows (with the live current
month already merged into the same arrays by the builder) into the shape the UI
needs. It canonicalizes member logins case-insensitively, credits non-members to an
"Others" bucket, and produces per-member commit, merge, line and review rollups
plus the per-repo and per-month series. Being pure makes it cheap to unit test and
free of side effects.

## Caching

### Two tiers, one interface

`cache/index.ts` exposes a small `Cache` interface (`get`, `set`, `getOrCompute`).
`createCache(name, ttlMs)` returns a Redis-backed cache when `REDIS_URL` is set and
an in-memory one otherwise, so the rest of the code never branches on which backend
is live. Values are JSON serialized. A Redis hiccup is treated as a cache miss
rather than an error, so a flaky cache never fails a request.

### Single-flight and the thundering herd

The Redis cache does more than store values. When a key is missing it acquires a
fenced lock (`SET lockKey token PX <ttl> NX`, released with a compare-and-delete Lua
script using a per-acquisition token). The holder computes the value; concurrent
callers on other replicas poll for the result instead of recomputing. Within a
single process, an in-flight map collapses concurrent callers of the same key onto
one promise. Together these guarantee that a cold cache produces one GitHub fetch,
not one per waiting user. If the lock holder disappears, waiters fall back to
computing locally after `CACHE_LOCK_TTL_MS`.

### Per-feature caches and TTLs

Each view has its own cache with a key built from the sorted inputs plus a schema
version (so a shape change invalidates old entries automatically):

| Cache | What it holds | Key inputs | Default TTL |
| --- | --- | --- | --- |
| metrics | assembled team or org report | repos, members (login plus email), months, memberMonths, to | 20 min |
| flow | cycle time and review health | repos, months, to | 30 min |
| attention | open-PR worklist | repos | 10 min |
| person | one member's delivery, review and collaboration record | subject login, repos, members (login plus email), months, memberMonths, to | 20 min |
| discovery | org repos and members | allowed orgs | 6 hours |

The current-month freshness (`CURRENT_MONTH_TTL_MS`) is separate from these report
TTLs: the report cache controls how long an assembled view is reused, while the
freshness floor controls how often the underlying current-month data is re-fetched
from GitHub.

## Cache warming

`warm.ts` precomputes the expensive views so the first real user gets a warm cache:
each preset team's metrics, the global metrics, the default selection, and the
attention report. Jobs run sequentially to avoid bursting the GitHub rate limit,
and a failure in one does not abort the rest.

It is triggered by `POST /api/cron/warm`, authenticated with a constant-time
comparison of the `Authorization: Bearer <CRON_SECRET>` header against `CRON_SECRET`
(`cron-auth.ts`). With no secret configured the endpoint stays disabled and returns
`401`. There is no built-in schedule; point any external scheduler at the endpoint
at whatever cadence you like (every few hours pairs well with the 6-hour
current-month TTL). The response reports which views were warmed, which failed, and
how many repos were touched.

## Migrations and connection handling

Migrations are generated by drizzle-kit into `drizzle/` and applied on boot:
`scripts/migrate.js` runs the postgres-js migrator with a single connection before
the server starts (the container command is `node scripts/migrate.js && node
build`). The runtime image carries only `drizzle-orm`, not drizzle-kit, so the
production image stays lean. The app connection is a lazily created postgres-js
pool (`DATABASE_POOL_MAX`, default 10) wrapped by Drizzle, and `hasDb()` lets the
app boot and run without a database at all.
