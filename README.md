# strava-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Tests](https://img.shields.io/badge/tests-121_passing-brightgreen)](#development)
[![Powered by Strava](https://img.shields.io/badge/Powered_by-Strava-FC4C02)](https://strava.com)

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives any MCP-compatible client read-only access to your **Strava** data. Ask questions about your training, analyse rides and runs, explore segments, and track fitness trends — all from a conversation.

```
Your MCP client ─── strava-mcp Worker ─── Strava API ─── Your data
(Claude, Cursor,      (Cloudflare Workers)
 Windsurf, ...)
```

**The server is an intentionally thin data layer.** It fetches Strava data faithfully and returns it to your MCP client. All analysis — zone interpretation, trend spotting, PR hunting, training load — happens in the conversation. No smoothing. No derived metrics. No analytical opinions baked into the server.

**This server does not use Strava data for model training** — not now, not ever. It is a read-only pass-through. Data returned from Strava goes directly to your MCP client and is not retained.

---

## Getting started

### Use the hosted instance

Visit **[mike-keefe.github.io/strava-mcp](https://mike-keefe.github.io/strava-mcp)** for connection instructions. No deployment needed — OAuth through Strava, then add the server URL to your MCP client.

### Deploy your own

See [Deploy your own](#deploy-your-own) below to run your own instance on Cloudflare Workers. Self-hosting means you control all stored data.

---

## Available tools

19 read-only tools covering activities, streams, segments, routes, gear, and diagnostics.

| Tool | Returns |
|------|---------|
| `get_athlete_profile` | Name, location, weight, FTP, measurement preference |
| `get_recent_activities` | Activity list — filterable by type, date range, limit (max 200). Cursor-pageable via `next_after` / `next_before`. |
| `get_activity_details` | Full activity: laps, splits, best efforts, segment efforts, all metadata |
| `get_activity_streams` | Per-second sensor data with sport-aware defaults, optional pace/speed units, time/distance windowing, and lap index overlay |
| `get_activity_best_efforts` | Strava pre-computed best efforts (1k → marathon) with PR ranks |
| `get_athlete_best_efforts` | Best efforts at a single distance across all runs, sorted fastest-first — great for PR-over-time questions |
| `get_athlete_summary` | Weekly or monthly rollups: count, distance, time, elevation, avg HR, avg pace |
| `get_activity_zones` | HR and power zone distribution with seconds per zone |
| `get_activity_laps` | Lap-by-lap breakdown for an activity |
| `get_athlete_zones` | Your configured HR and power zone thresholds |
| `get_athlete_stats` | Recent (4 weeks) / YTD / all-time totals by sport |
| `get_segment_details` | Segment info: distance, grade, elevation, effort count, your PR |
| `list_my_segment_efforts` | All your efforts on a segment with optional date filters |
| `get_segment_effort_streams` | Per-second stream data for a single segment effort |
| `explore_segments` | Segments within a bounding box (up to 10 results) |
| `list_routes` | Your saved routes with pagination |
| `get_route_details` | Full route metadata plus stream data (latlng, distance, altitude) |
| `list_gear` | Bikes and shoes with mileage |
| `health` | Diagnostics: athlete ID, Strava rate limits (overall + read tier), cache stats, worker version |

### Stream data

- **Sport-aware defaults** — Runs get `time, distance, heartrate, velocity_smooth, altitude, cadence, grade_smooth`; Rides add `watts`. Override with `stream_types`.
- **Units** — `units="auto"` (default) adds `pace_per_km` for runs and `speed_kmh` for rides alongside `velocity_smooth`. Pause samples return `null`, not `Infinity`. Pass `"raw"` to disable.
- **Windowing** — `time_range_seconds` and `distance_range_meters` slice responses server-side. The full activity is always cached, so windowed queries cost nothing after the first fetch.
- **Raw fidelity** — `velocity_smooth` and `grade_smooth` are smoothed by Strava's own processing. The MCP does not further transform, interpolate, or smooth any stream data.

---

## Deploy your own

### Prerequisites

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) — free tier is fine
- [Strava API app](https://www.strava.com/settings/api)

### 1. Clone and install

```bash
git clone https://github.com/mike-keefe/strava-mcp
cd strava-mcp
pnpm install
```

### 2. Create a Strava API app

Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an app. Set **Authorization Callback Domain** to `localhost` for now — you'll update it after deploy. Note your **Client ID** and **Client Secret**.

Scopes requested: `read, activity:read_all, profile:read_all` — read-only, no write access.

### 3. Create Cloudflare KV namespaces

```bash
npx wrangler login

npx wrangler kv namespace create TOKEN_CACHE
npx wrangler kv namespace create STREAM_CACHE

# Preview namespaces for local dev:
npx wrangler kv namespace create TOKEN_CACHE --preview
npx wrangler kv namespace create STREAM_CACHE --preview
```

Copy the printed namespace IDs into the `kv_namespaces` section of `wrangler.jsonc`.

### 4. Deploy

```bash
pnpm run deploy
```

Your Worker URL is printed at the end: `https://strava-mcp.<your-subdomain>.workers.dev`

### 5. Set secrets

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_TOKEN        # any strong random string
npx wrangler secret put WEBHOOK_VERIFY_TOKEN  # any strong random string
```

> `STRAVA_REFRESH_TOKEN` is optional — only needed for the static `MCP_AUTH_TOKEN` admin/dev path. Users connecting through Claude don't need it.

### 6. Update Strava callback domain

Go back to [strava.com/settings/api](https://www.strava.com/settings/api) and set **Authorization Callback Domain** to your Worker's hostname (e.g. `strava-mcp.<your-subdomain>.workers.dev`).

### 7. Register the Strava webhook (one-time)

This lets Strava notify the server when a user removes the app, so their tokens are deleted immediately:

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=<STRAVA_CLIENT_ID> \
  -F client_secret=<STRAVA_CLIENT_SECRET> \
  -F callback_url=https://strava-mcp.<your-subdomain>.workers.dev/webhook \
  -F verify_token=<WEBHOOK_VERIFY_TOKEN>
```

Strava immediately hits `GET /webhook?hub.challenge=...` to verify — the Worker responds automatically. On success, Strava returns a subscription ID and no further action is needed.

### 8. Connect your MCP client

**Claude:** Settings → Connectors → Add custom connector → URL: `https://strava-mcp.<your-subdomain>.workers.dev/mcp`

**Cursor / Windsurf / others:** Add an MCP server entry pointing to the same URL. Check your client's documentation for the exact steps — any client that supports remote MCP servers over Streamable HTTP will work.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, MCP_AUTH_TOKEN
pnpm dev
```

The Worker runs at `http://localhost:8787`. You can use `Authorization: Bearer <MCP_AUTH_TOKEN>` to test endpoints directly, or point Claude Desktop at `http://localhost:8787/mcp`.

To get a Strava refresh token for the static auth path:

```bash
pnpm get-refresh-token
```

This opens Strava in your browser and prints the refresh token to the terminal.

---

## Architecture

```
src/
  index.ts        # Worker entry — routing, auth, rate limiting
  auth.ts         # Bearer token validation (static + OAuth paths)
  oauth.ts        # OAuth 2.0 server — RFC 6749, PKCE, RFC 7591, RFC 7009
  types.ts        # Env interface
  strava/
    client.ts     # Strava API client — token refresh, per-user caching, retries
    tools.ts      # MCP tool registrations (19 tools)
    streams.ts    # Stream fetching — caching, windowing, gap detection
    errors.ts     # Structured error types
    types.ts      # Shared Strava types
scripts/
  get-refresh-token.ts   # One-shot OAuth flow for local dev
```

### KV namespaces

| Namespace | Contents |
|-----------|----------|
| `TOKEN_CACHE` | OAuth tokens, Strava access tokens (per-user), registered OAuth clients, Strava rate-limit snapshot |
| `STREAM_CACHE` | Streams (30-day TTL), activity summaries (24h TTL), lap data (30-day TTL) |

### Auth endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /oauth/register` | Dynamic client registration (RFC 7591) |
| `GET /oauth/authorize` | Starts OAuth flow → redirects to Strava |
| `GET /oauth/strava-callback` | Strava redirects here after user approval |
| `POST /oauth/token` | Authorization Code + PKCE exchange |
| `POST /oauth/revoke` | Token revocation (RFC 7009) — deletes all user data |
| `GET /webhook` | Strava hub.challenge verification |
| `POST /webhook` | Strava deauth events — deletes all user data |

### Logging

`LOG_LEVEL` env var (`debug | info | warn | error`, default `info`) controls verbosity. Logs are single-line JSON emitted to `console.log`, viewable via `wrangler tail` or the Workers Logs UI. Auth tokens and client secrets are redacted before serialisation.

---

## Development

```bash
pnpm dev          # local dev server (http://localhost:8787)
pnpm test         # tests in watch mode
pnpm test:run     # run all tests once (121 tests)
pnpm typecheck    # TypeScript type check
pnpm lint         # ESLint
pnpm lint:fix     # ESLint with autofix
pnpm tail         # stream live Worker logs (wrangler tail)
```

Tests use [Vitest](https://vitest.dev/) with `@cloudflare/vitest-pool-workers`. Tool tests run the full MCP client ↔ server path via `InMemoryTransport` — real tool dispatch, Strava HTTP intercepted with mock fetch handlers.

---

## Secrets reference

| Secret | Required | Purpose |
|--------|----------|---------|
| `STRAVA_CLIENT_ID` | Yes | Strava app Client ID |
| `STRAVA_CLIENT_SECRET` | Yes | Strava app Client Secret |
| `MCP_AUTH_TOKEN` | Yes | Bearer token for direct API access |
| `WEBHOOK_VERIFY_TOKEN` | Yes | Verifies Strava push subscription requests |
| `STRAVA_REFRESH_TOKEN` | Optional | Static auth path (admin / local dev only) |

Set via `npx wrangler secret put <NAME>`. Never commit these values.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: PRs for new read-only Strava endpoints, performance improvements, and bug fixes are welcome. PRs that add smoothing, filtering, derived metrics, or analytical logic won't be merged — those belong in Claude.

---

## License

[MIT](LICENSE) — [Mike Keefe](https://github.com/mike-keefe)
