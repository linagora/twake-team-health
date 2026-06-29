# Twake Team Health

Engineering-delivery metrics for any GitHub team: PR throughput, review depth, code volume, and release cadence, pulled from GitHub and rendered as charts.

## Stack

SvelteKit 2 and Svelte 5 (runes), deployed as a Node server via `adapter-node`. Tailwind 4 and layerchart for the UI, Postgres via Drizzle ORM for persisted history, Redis (ioredis) for the report cache and cross-replica coordination, Auth.js for OIDC, and a custom GitHub GraphQL client. Tested with Vitest, built with pnpm.

## Quick start

Bring up the full stack (app, Postgres, Redis) with Docker:

```sh
cp .env.example .env     # set GITHUB_TOKEN and ALLOWED_ORGS; OIDC for production
docker compose up -d
```

The app listens on http://localhost:3000 and runs database migrations on start. For a first look, set `AUTH_DISABLED=true` to skip OIDC and run as a dev admin. The [guide](docs/guide.md) walks through pointing it at your org.

## Configuration

All configuration is environment based; the essentials:

- `GITHUB_TOKEN`: read-only token used for every GitHub query.
- `ALLOWED_ORGS`: comma-separated organizations that members and repos may belong to.
- `DEFAULT_TEAMS`: JSON array of preset teams shared with everyone.
- `DATABASE_URL`, `REDIS_URL`: data stores (both optional, recommended for production).
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_SECRET`, `ORIGIN`: SSO, required in production.

`DEFAULT_TEAMS` looks like:

```json
[
  {
    "name": "Platform",
    "members": [{ "login": "octocat", "name": "The Octocat" }],
    "repos": [{ "owner": "octocat", "repo": "Hello-World" }]
  }
]
```

Each signed-in user can also build private teams of their own, which are never shared with others. See [docs/configuration.md](docs/configuration.md) for every variable and the admin-editable settings.

## How it works

Completed months are computed once and persisted in Postgres; the in-progress month is fetched live and kept fresh briefly, so reports reflect today's activity without re-querying history. Redis caches assembled reports and, through a fenced lock, makes a cold cache produce one GitHub fetch rather than one per user. The GitHub client batches queries, caps concurrency, and trips a circuit breaker on rate limits. Access is gated by OIDC. Nothing is written to disk. The [architecture doc](docs/architecture.md) explains the reasoning.

## Documentation

- [Features](docs/features.md): the complete catalog of what the app does.
- [Architecture](docs/architecture.md): how the pieces fit and the design decisions behind them.
- [Configuration](docs/configuration.md): every environment variable and admin setting.
- [GitHub integration](docs/github-integration.md): GraphQL queries, rate limiting, pagination, metrics math.
- [Data and caching](docs/data-and-caching.md): schema, incremental persistence, Redis single-flight, warming.
- [Frontend](docs/frontend.md): pages, runes, resource stores, charts.
- [Guide](docs/guide.md): setup and usage walkthrough.
- [OIDC](docs/oidc.md): authentication setup for any provider, with a local Keycloak example.

## Development

```sh
pnpm install
pnpm dev      # http://localhost:5173
pnpm check    # type-check
pnpm test     # unit tests
```

## License

[MIT](LICENSE)
