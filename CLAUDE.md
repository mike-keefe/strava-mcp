# strava-mcp — Claude Code Session Guide

## What this project is

A personal, single-user remote MCP server that exposes Strava data to Claude for detailed running analysis. Deployed to Cloudflare Workers. The model does the analysis; the MCP fetches the data.

## Hard constraints — read before touching anything

- **Read-only.** This MCP must never expose write operations. The OAuth scopes are exactly `read,activity:read_all,profile:read_all`. No other scopes. No `activity:write`, no `profile:write`, ever.
- **No analytical opinions in the MCP.** No smoothing parameters. No `clean_outliers` flags. No `moving_only` filters. No `analyse_run` tools. No derived metrics. All of that belongs in conversation with Claude. If an issue asks you to add one of these, stop and ask Mike to confirm before proceeding.
- **Streams are raw.** `get_activity_streams` returns data faithfully from Strava. The only server-side data transformation allowed is `downsample_to_seconds` (transport optimisation only).
- **Defensive stream handling.** Stream types can be missing (device didn't record them). The time stream can have gaps. Never fail a whole request because one stream type is absent. Never silently fill gaps or interpolate. Surface missing types and gaps in metadata.

## Workflow — always follow this

1. **At session start:** run `gh issue list --state open` and ask which issue to work on if not specified.
2. **Branch naming:** `issue-<number>-<short-slug>` (e.g. `issue-3-streams`)
3. **Commit messages:** conventional commits, ending with `(refs #<issue>)`
4. **PRs:** open with `gh pr create`, body must include `Closes #<issue>`, title prefixed with `[#<issue>]`
5. **Before opening a PR:** `pnpm typecheck && pnpm lint && pnpm test:run` must all pass
6. **Definition of done per issue:** code + tests + types pass + lint passes + README "Available tools" table updated if a new tool was added + issue's acceptance criteria met

## Never

- Never commit secrets, `.dev.vars`, or `.wrangler/` contents
- Never push directly to `main` — always via PR
- Never use `npm` or `yarn` — this project uses `pnpm`
- Never guess at Cloudflare Workers MCP patterns or Strava API shapes — check the docs

## Tech stack

- TypeScript, Cloudflare Workers, `wrangler`
- MCP SDK: `@modelcontextprotocol/sdk` (McpServer), `agents` package (createMcpHandler)
- KV: `TOKEN_CACHE` (Strava access token caching), `STREAM_CACHE` (stream response caching)
- Tests: Vitest
- Lint: ESLint + Prettier

## Strava API notes

- Base URL: `https://www.strava.com/api/v3`
- Auth: refresh token → access token via `https://www.strava.com/oauth/token`
- Rate limits are in `X-RateLimit-Limit` and `X-RateLimit-Usage` headers (both 15-min and daily windows)
- Access tokens expire in 6 hours; cache them in TOKEN_CACHE KV with a 5-minute safety buffer
- Stream data can be sparse. `null` values mean the sensor didn't record at that second. Don't interpolate.
- Strava docs: https://developers.strava.com/docs/reference/

## Secrets

Set via `npx wrangler secret put <NAME>` after deploy. Never commit them.

| Secret | Description |
|--------|-------------|
| `MCP_AUTH_TOKEN` | Bearer token for Claude connector auth |
| `STRAVA_CLIENT_ID` | Strava app Client ID |
| `STRAVA_CLIENT_SECRET` | Strava app Client Secret |
| `STRAVA_REFRESH_TOKEN` | Long-lived refresh token (scopes: read,activity:read_all,profile:read_all) |
