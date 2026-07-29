# Frontend

The UI is SvelteKit with Svelte 5 runes, Tailwind 4 and layerchart. The whole
client is built around one idea: a small set of reactive resource stores that fetch
from the JSON API, driven by a shared scope (the selected team and month range)
that is mirrored into the URL.

## Pages

| Route | What it shows |
| --- | --- |
| `/` | Team overview: delivery velocity, top repos, contributors, awards, PR cadence. |
| `/attention` | Open-PR worklist: changes requested, unreviewed, stale and aging PRs. |
| `/flow` | Cycle time and review health: time to first review, merge latency, coverage. |
| `/signals` | Automated health checks across cycle time, throughput, review load, bus factor. |
| `/charts` | Detailed charts: commits, PRs, reviews by member and repo, tickets. |
| `/global` | Org-wide delivery trends across all repos. |
| `/breakdown` | Org trends filtered to a team or repo subset. |
| `/teams` | Create and edit private teams. |
| `/bots` | Bot review activity on merged PRs. |
| `/people/[login]` | One contributor: commits, PRs, repos and lines, plus their delivery, review-given, review-received and collaboration record with monthly trends. |
| `/settings` | Admin configuration (admins only). |
| `/logs` | Audit trail (admins only). |

## The resource store pattern

`client/resource.svelte.ts` defines a small `Resource<T>` base class with three
runes: `loading`, `error` and `data`. It exposes `run(key, fetcher)` for explicit
loads and `ensureKey(key, fetcher)` for idempotent loads that only fire when the
key changes. A sequence guard makes sure a slower earlier request can never
overwrite a newer one, and a `401` redirects to sign-in.

The concrete stores extend it, one per API endpoint:

- `metrics` and `globalMetrics` POST a selection to `/api/metrics`.
- `attention` POSTs the team's repos to `/api/attention`.
- `flow` POSTs repos plus the month window to `/api/flow`.
- `person` POSTs the same selection as `metrics` plus a member login to
  `/api/person`. Only the profile page loads it, so it is driven by an effect on
  that page rather than by the scope store.
- `discovery` fetches the org repo and member lists once.

A page reads `store.data` (with a server-rendered initial value as fallback),
`store.loading` and `store.error`, and the UI reacts automatically.

## Scope and URL state

`client/scope.svelte.ts` holds the shared selection as runes: active team id, month
windows and the "to" anchor. Changing the team or range updates the state, persists
it to localStorage, mirrors it into the URL query string (`client/url.ts`, which
retries until the router is ready and merges with other param writers), and calls
`reload()` to refetch the active store. This is why a dashboard link is shareable:
the scope round-trips through the URL.

## Runes in practice

State management follows the standard Svelte 5 idiom rather than external stores:

- `$state` for the reactive sources (store fields, scope, theme, the drawer).
- `$derived` and `$derived.by` for read-only computations: picking the active store
  by pathname, the page title, ranked top repos and authors, monthly rollups.
- `$effect` for side effects: initializing scope from server data once, syncing the
  URL after navigation, and calling `ensure(...)` on a store when the active team's
  repos change.

## Charts

Charts use layerchart with d3-shape curves, wrapped by `MetricChart.svelte`. It
takes a data array, an x column, and a series description, and renders a line, area
or bar chart with overlap, stack or group layouts. Two details matter:

- Series keys (logins, repo names) are mapped to safe CSS variable names so special
  characters do not break the per-series colors emitted by `chart-style.svelte`.
- Charts mount lazily through an `IntersectionObserver`, so a long charts page does
  not render everything at once. Print mode forces them all to render so PDF export
  captures the full page.

## Client-side computed views

Some views are pure transforms of the fetched data, computed in the browser:

- `charts.ts` reshapes the metrics result into per-repo series, per-member monthly
  series, the org trend with weighted averages, and the tickets breakdown.
- `awards.ts` finds the standout contributor per dimension (most commits, merged
  PRs, reviews, comments, lines, breadth) and renders them as trophy cards.
- `signals.ts` turns flow, attention and metrics into a sorted list of health
  signals (ok, warn, bad) covering cycle time, review coverage, throughput,
  knowledge concentration and the open-PR backlog.

## Theming and print

`theme.svelte.ts` toggles a `dark` class on the root element and remembers the
choice in localStorage; a boot script in `app.html` sets it before first paint to
avoid a flash. `print.svelte.ts` drives PDF export: it flips a printing flag, waits
for layerchart to measure and paint the now-forced charts, then calls
`window.print()`.
