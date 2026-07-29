# Configuration

All configuration is environment based. A subset can also be overridden at runtime
by admins through the Settings page, in which case the database value wins over the
environment default. Authorization-relevant values (the GitHub token, the allowed
orgs, and auth settings) are intentionally environment only and cannot be changed
from the UI.

Copy `.env.example` to `.env` and fill it in. Nothing here is written to disk at
runtime; these are read on boot and on demand.

## Required

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Read-only token used for every GitHub GraphQL query. Fine-grained with read scopes, or a classic token with `repo` (read) and `read:org`. The app cannot fetch anything without it. |
| `ALLOWED_ORGS` | Comma-separated organizations whose members and repositories may be selected. This is an authorization boundary: repos outside these orgs are rejected during validation. The code ships a placeholder fallback, so always set it explicitly for your deployment. |
| `ORIGIN` | Public base URL of the deployment. Auth.js uses it to build the OIDC callback redirect. |

In production you also need the OIDC and `AUTH_SECRET` values below.

## Data stores

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | (none) | Postgres connection string. If unset, the app runs with no persistence: metrics are fetched live every time, teams are not saved, and the audit log is disabled. Fine for a quick demo, not for production. |
| `DATABASE_POOL_MAX` | `10` | Max connections in the postgres-js pool. |
| `REDIS_URL` | (none) | Redis connection string. If unset, an in-memory cache is used instead, which is correct only for a single replica. |

## Authentication and access

| Variable | Default | Purpose |
| --- | --- | --- |
| `OIDC_ISSUER` | (none) | OIDC provider issuer URL. |
| `OIDC_CLIENT_ID` | (none) | OIDC client id. |
| `OIDC_CLIENT_SECRET` | (none) | OIDC client secret. |
| `AUTH_SECRET` | (none) | Secret that signs and encrypts the session cookie. Required whenever auth is enabled. |
| `AUTH_DISABLED` | unset | Set to `true` to bypass auth and run as a synthetic dev user who is always admin. Also implied in dev mode when no `OIDC_ISSUER` is set. Never set this in production. |
| `ADMINS` | (none) | Comma-separated admin emails or OIDC subjects. Admins can open Settings and the activity log. |
| `ADMIN_SUBS` | (none) | Back-compat admin list matched on subject only. Used when `ADMINS` is not set. |

If neither `ADMINS` nor `ADMIN_SUBS` is set, nobody is an admin and settings stay
environment only. The callback URL to register with your provider is
`{ORIGIN}/auth/callback/oidc`. See [oidc.md](./oidc.md) for provider setup.

## Preset teams and windows

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_TEAMS` | one demo team | JSON array of teams shared with everyone as read-only presets. Real rosters belong here, not in code. |
| `GLOBAL_REPOS` | union of preset team repos | JSON array of repos for the org-wide trend view. Accepts `[{"owner":"o","repo":"r"}]` or `["o/r"]`. |
| `DEFAULT_MONTHS` | `12` | Default month window for team metrics. |
| `DEFAULT_MEMBER_MONTHS` | `3` | Default month window for per-member metrics. |
| `GLOBAL_MONTHS` | `12` | Month window for the org-wide view. |
| `ORG_NAME` | `''` | Organization name shown in the sidebar. |

`DEFAULT_TEAMS` shape:

```json
[
  {
    "name": "Platform",
    "members": [{ "login": "octocat", "name": "The Octocat" }],
    "repos": [{ "owner": "octocat", "repo": "Hello-World" }]
  }
]
```

Preset teams get stable ids (`builtin:0`, `builtin:1`, ...). Each signed-in user
can also build private teams of their own, stored per user and never shared.

## GitHub load and caching

All optional; defaults are tuned for a mid-size org. See
[data-and-caching.md](./data-and-caching.md) and
[github-integration.md](./github-integration.md) for what each one controls.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_MAX_CONCURRENCY` | `8` (max 32) | Max in-flight GraphQL calls. The semaphore that keeps the app from tripping GitHub's rate limit. |
| `CURRENT_MONTH_TTL_MS` | `21600000` (6h) | How long the in-progress month is reused before re-fetching. Completed months are never re-fetched. Set `0` to always refetch the current month. |
| `METRICS_CACHE_TTL_MS` | `1200000` (20m) | Assembled team/global report cache TTL. |
| `FLOW_CACHE_TTL_MS` | `1800000` (30m) | Cycle-time and review-health report cache TTL. |
| `ATTENTION_CACHE_TTL_MS` | `600000` (10m) | Open-PR worklist cache TTL. |
| `PERSON_CACHE_TTL_MS` | `1200000` (20m) | Per-member profile report cache TTL. |
| `DISCOVERY_CACHE_TTL_MS` | `21600000` (6h) | Org repo and member discovery cache TTL. |
| `CACHE_LOCK_TTL_MS` | `600000` (10m) | Distributed lock timeout that powers cross-replica single-flight. |

## Attention thresholds

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATTENTION_STALE_DAYS` | `7` | An open PR with no update in this many days is flagged stale. |
| `ATTENTION_AGING_DAYS` | `14` | An open PR older than this is flagged aging. |

## Cache warming

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | (none) | Bearer secret guarding `POST /api/cron/warm`. When set, a scheduler can keep caches warm by calling that endpoint. Unset leaves the endpoint disabled (returns `401`). |

## Admin-editable settings (database overrides)

Admins can override a subset of the above at runtime from `/settings`. These are
stored as a single JSON row in the `app_config` table and merged over the
environment defaults, with a 60-second read cache. The overridable fields are:
`globalRepos`, `globalMonths`, `defaultMonths`, `defaultMemberMonths`, the signal
targets, `attentionStaleDays`, `attentionAgingDays`, `fetchConcurrency` (the live
GitHub concurrency, clamped 1 to 32), `orgName`, and `bugLabels` (custom labels
that count as bugs, up to 30 labels).

`ALLOWED_ORGS`, `GITHUB_TOKEN` and the auth settings are never overridable from the
UI, because they define the trust boundary of the deployment.
