# Contributing to strava-mcp

Thanks for your interest. Before you start, one design principle shapes everything here:

**This server is a thin data layer.** Its job is to fetch Strava data and return it faithfully to Claude. All analysis — zone interpretation, trend spotting, PR hunting, training load — belongs in the conversation, not in the server.

## What's welcome

- New read-only Strava API endpoints ([Strava API reference](https://developers.strava.com/docs/reference/))
- Performance improvements (caching strategy, response size, latency)
- Bug fixes
- Better error messages and diagnostics
- Tests

## What won't be merged

- Smoothing, filtering, interpolation, or outlier removal on stream data
- Derived metrics (VDOT, TSS, normalised power, IF, etc.)
- Tools that embed analytical logic (`analyse_run`, `clean_outliers`, etc.)
- Write operations — no Strava write scopes are used or will ever be added

If you're unsure whether something fits the design, open an issue first.

## How to contribute

1. Fork and clone the repo
2. Create a branch: `feature/my-thing` or `fix/my-bug`
3. Install dependencies: `pnpm install`
4. Make your changes and add tests
5. Verify: `pnpm typecheck && pnpm lint && pnpm test:run`
6. Open a PR with a clear description of what and why

## Development setup

Follow the [Deploy your own](README.md#deploy-your-own) section in the README. For local dev you only need `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `MCP_AUTH_TOKEN` in `.dev.vars` — you don't need a Cloudflare account until you're ready to deploy.

```bash
cp .dev.vars.example .dev.vars
# Fill in the three values above
pnpm dev   # Worker at http://localhost:8787
```

## Testing

Tests use [Vitest](https://vitest.dev/) with `@cloudflare/vitest-pool-workers`.

- Tool tests (`test/tools.test.ts`) run the full MCP client ↔ server path via `InMemoryTransport` — real tool dispatch, no mocked HTTP at the MCP layer.
- Stream tests cover caching, windowing, gap detection, and downsampling.
- Strava API calls are intercepted with mock fetch handlers inside the test environment.

When adding a new tool, add tests in `test/tools.test.ts`. For stream changes, add to `test/streams.test.ts` or `test/streams-extras.test.ts`.

```bash
pnpm test:run   # run all tests once
pnpm test       # watch mode
```
