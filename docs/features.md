# Features

A complete catalog of what Twake Team Health does, grouped by area. For how each
view is used see the [guide](./guide.md); for the math behind the metrics see
[github-integration.md](./github-integration.md).

## Views

- **Team overview (`/`):** delivery velocity, top repositories, top contributors,
  awards, and PR cadence for the selected team and window.
- **Attention (`/attention`):** the live open-PR worklist, bucketed into changes
  requested, unreviewed, stale (no update in `ATTENTION_STALE_DAYS`) and aging
  (older than `ATTENTION_AGING_DAYS`). Automated PRs are filtered out.
- **Flow (`/flow`):** cycle-time and review-health view: time to first review,
  review-to-merge time, total merge time, post-approval wait, and review coverage.
- **Signals (`/signals`):** automated health checks distilled to pass, warn and
  fail, covering cycle time, throughput, review load balance, review coverage,
  knowledge concentration (bus factor) and the open-PR backlog.
- **Charts (`/charts`):** the deep dive, with per-member and per-repo series for
  commits, merged PRs, reviews, comments, lines changed and tickets.
- **Global (`/global`):** organization-wide delivery trends across all configured
  repos.
- **Breakdown (`/breakdown`):** the org trend sliced to a chosen team or repo
  subset.
- **Teams (`/teams`):** create and edit private teams.
- **Bots (`/bots`):** review activity from automated reviewers (CodeRabbit,
  CodeScene, Copilot and similar).
- **People (`/people/[login]`):** a single contributor's commits, merged PRs,
  reviews, repositories touched and lines changed.
- **Settings (`/settings`):** admin-only runtime configuration.
- **Logs (`/logs`):** admin-only audit trail.

## Metrics

### Pull requests and code

- Created, merged and closed PR counts per month.
- Code volume: total additions and deletions, plus median additions and deletions
  per merged PR.
- Median time to merge (days from creation to merge).
- Median comments and reviews per merged PR.

### Issues, bugs and releases

- Issues opened and closed per month.
- Bugs detected by configurable labels (`bugLabels`), or a whole-word `bug`
  heuristic when none are configured.
- Median bug resolution time and the share of a month's bugs already resolved.
- Releases per month, excluding drafts and prereleases.

### Reviews and cycle time

- Review load per reviewer (reviews plus comments), excluding self-reviews and
  pending reviews.
- Cycle-time breakdown per merged PR: first review, review-to-merge, total merge
  time, and wait after the last approval.
- Review coverage (the share of merged PRs that got a human review).

### People and organization

- Commit attribution by linked GitHub identity, falling back to commit email,
  with ambiguous shared emails dropped.
- Per-member rollups: commits, merged PRs, lines changed, repositories touched.
- Member profile with the person's own delivery, review and collaboration record
  over the selected window:
  - Delivery: PRs opened, merged and closed unmerged, merge rate, median PR size,
    median cycle time from open to merge.
  - Review given: distinct PRs reviewed, approvals versus changes requested,
    comments left, median pickup from a PR opening to their first review.
  - Review received: distinct reviewers on their PRs, median wait for a first
    review, and PRs that merged with no human review at all.
  - Collaboration: the peers they exchange review with, in both directions.
  - Monthly trends for commits, pull requests, review activity, cycle time and
    code volume.
  - Bots are excluded from every human review number, self-review does not count
    as review work, and a median is withheld rather than shown when too few PRs
    back it.
- Awards that name the standout contributor per dimension (commits, merged PRs,
  reviews, comments, lines, breadth).
- Org-wide trend with weighted averages across all repos.
- Period comparison: averages computed over slices of the window for
  before-and-after reads.

## Teams and scope

- Shared preset teams defined in `DEFAULT_TEAMS`, read-only for everyone.
- Per-user private teams, stored per OIDC subject and never shared.
- Team membership and repos validated and restricted to `ALLOWED_ORGS`.
- Organization discovery of selectable repos (non-archived) and members.
- Selectable month windows for both team and per-member views.
- Scope (team and range) persisted to local storage and mirrored into the URL, so
  any view is a shareable link.

## Platform and operations

- **Incremental persistence:** completed months are computed once and stored; the
  current month is fetched live and refreshed on a short TTL.
- **Two-tier cache:** Redis when configured, in-memory otherwise, with a fenced
  distributed lock so a cold cache produces one GitHub fetch, not one per user.
- **Cache warming:** `POST /api/cron/warm` (bearer-authenticated with
  `CRON_SECRET`) precomputes preset teams, the global view and the attention
  worklist.
- **Rate-aware GitHub client:** alias-batched GraphQL queries, a concurrency
  semaphore, a circuit breaker for primary and secondary rate limits, retries with
  backoff, and tolerance of partial results.
- **Authentication:** OIDC via Auth.js with encrypted JWT cookie sessions, plus an
  `AUTH_DISABLED` dev bypass.
- **Authorization:** admin gate (`ADMINS` / `ADMIN_SUBS`) over Settings and Logs;
  org allowlist as the data boundary.
- **Runtime settings:** admins can override windows, signal thresholds, attention
  thresholds, GitHub concurrency, org name, global repos and bug labels without a
  redeploy.
- **Audit logging:** every request and semantic action recorded, with suspicious
  activity and per-IP rate-abuse flagging.
- **Theming and export:** light and dark themes, and PDF export via print mode.
- **Stateless and horizontal:** nothing on local disk, multiple replicas
  coordinate through Redis, and the server applies database migrations on boot.
- **Graceful degradation:** runs without Redis (in-memory cache) and without a
  database (live fetch, no persistence), and serves stored data when GitHub is
  rate-limited.
