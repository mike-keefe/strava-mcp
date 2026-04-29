# strava-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude access to your Strava data. Ask Claude to analyse your training, explore routes, track segment PRs, or chart fitness trends — all from a conversation.

Deployed to **Cloudflare Workers**. Multi-user: anyone can connect their own Strava account via OAuth. Read-only. No analysis logic lives in the server — that belongs in conversation with Claude.

---

## How it works

```
Claude ──OAuth 2.0──▶ strava-mcp Worker ──Strava API──▶ Your activity data
```

When you add this as a connector in Claude, it walks you through a standard OAuth flow: you approve access on Strava's own consent screen, your tokens are stored per-user in Cloudflare KV, and Claude can then call any of the 15 available tools on your behalf.

---

## Available tools

| Tool | What it returns |
|------|-----------------|
| `get_athlete_profile` | Name, location, weight, FTP, measurement preference |
| `get_recent_activities` | Activity list with filters: type, date range, limit (default 30, max 200) |
| `get_activity_details` | Full activity: laps, splits, best efforts, segment efforts, all metadata |
| `get_activity_streams` | Per-second stream data with sport-aware defaults, optional pace_per_km / speed_kmh, optional lap_index, and optional time/distance windowing |
| `get_activity_best_efforts` | Strava's pre-computed best efforts (1k / 1mi / 5k / 10k / half / full) for a Run, with PR ranks |
| `get_activity_zones` | HR and power zone distribution, with `seconds_in_zone` summed per zone |
| `get_activity_laps` | Manually-pressed laps for an activity |
| `get_athlete_zones` | Your configured HR and power zone thresholds |
| `get_athlete_stats` | Recent (4 weeks) / YTD / all-time totals by sport |
| `get_segment_details` | Segment info: distance, grade, elevation, effort counts, your PR |
| `list_my_segment_efforts` | All your efforts on a segment over time, with date filters |
| `get_segment_effort_streams` | Per-second streams for a single segment effort |
| `explore_segments` | Find segments in a bounding box (up to 10 results) |
| `list_routes` | Your saved routes with pagination |
| `get_route_details` | Full route metadata plus stream data (latlng, distance, altitude) |
| `list_gear` | Bikes and shoes with mileage |
| `health` | Diagnostics: athlete identity, last-seen Strava rate limit, cache stats, worker version |

### Notes on streams

- Stream defaults are sport-aware: Runs/Walks/Hikes get `time, distance, heartrate, velocity_smooth, altitude, cadence, grade_smooth`; Rides add `watts`. Override with `stream_types`.
- `units="auto"` (the default) adds `pace_per_km` (sec/km) for runs and `speed_kmh` for rides alongside `velocity_smooth`. Pause samples come back as `null`, not `Infinity`. Pass `"raw"` to disable derivation.
- `velocity_smooth` and `grade_smooth` are smoothed by Strava itself — the MCP does not smooth or process them further.
- `time_range_seconds` and `distance_range_meters` slice the response server-side. The cached payload is always the full activity, so windowed queries are free after the first fetch.
- `include_lap_index: true` adds a `lap_index` array of the same length as `time`.
- `downsample_to_seconds` is a transport optimisation only. Per-second fidelity is the default.

### Design philosophy

The server is an intentionally **thin data layer**. Its job is to fetch Strava data and return it faithfully. All analysis — smoothing, outlier removal, zone interpretation, drift calculation, cross-run comparisons — happens in conversation with Claude.

The only server-side data transformation is `downsample_to_seconds` on stream fetches, which exists purely for transport (large activities produce large responses), not as an analytical choice. There are no `smooth`, `clean_outliers`, `moving_only`, or `analyse_run` parameters, and there never will be.

---

## Deploy your own

### Prerequisites

- **Node.js 20+** and **pnpm** (`npm install -g pnpm`)
- **Cloudflare account** (free tier is fine) — [sign up](https://dash.cloudflare.com/sign-up)
- **Strava API app** — [create one](https://www.strava.com/settings/api)

### 1. Clone and install

```bash
git clone https://github.com/mike-keefe/strava-mcp
cd strava-mcp
pnpm install
```

### 2. Register a Strava API app

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an app.
2. Set **Authorization Callback Domain** to your Worker URL once you have it (e.g. `strava-mcp.<your-subdomain>.workers.dev`). You can set it to `localhost` for now and update it after deploy.
3. Note your **Client ID** and **Client Secret**.

Scopes this server requests from Strava: `read,activity:read_all,profile:read_all` — read-only, no write scopes.

### 3. Log in to Cloudflare and create KV namespaces

```bash
npx wrangler login

npx wrangler kv namespace create TOKEN_CACHE
npx wrangler kv namespace create STREAM_CACHE
# Preview namespaces for local dev:
npx wrangler kv namespace create TOKEN_CACHE --preview
npx wrangler kv namespace create STREAM_CACHE --preview
```

Copy the printed IDs into the `kv_namespaces` section of `wrangler.jsonc`.

### 4. Deploy

```bash
pnpm run deploy
```

The Worker URL is printed at the end: `https://strava-mcp.<your-subdomain>.workers.dev`

### 5. Set secrets

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_TOKEN   # any random string — used for direct API access
```

> **Note:** `STRAVA_REFRESH_TOKEN` is only needed if you want to use the static `MCP_AUTH_TOKEN` admin path. Users connecting through Claude's OAuth flow don't need it.

### 6. Update Strava callback domain

Go back to [strava.com/settings/api](https://www.strava.com/settings/api) and set the **Authorization Callback Domain** to your Worker's domain (e.g. `strava-mcp.<your-subdomain>.workers.dev`).

### 7. Connect to Claude

1. In Claude: **Settings → Connectors → Add custom connector**
2. URL: `https://strava-mcp.<your-subdomain>.workers.dev/mcp`
3. Click **Connect** — Claude opens a browser window for you to authorise via Strava.
4. Test: *"what's my latest activity?"*

> Anyone with the URL can connect their own Strava account through the same OAuth flow. Each user's tokens are stored and refreshed independently in KV.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, MCP_AUTH_TOKEN
# Optionally: STRAVA_REFRESH_TOKEN (for the static auth path)

pnpm dev
```

The Worker runs at `http://localhost:8787`. Use `Authorization: Bearer <MCP_AUTH_TOKEN>` to test directly, or run through Claude Desktop pointing at `http://localhost:8787/mcp`.

To get a Strava refresh token for the static auth path:

```bash
pnpm get-refresh-token
```

This opens Strava in your browser and prints the refresh token to the terminal.

---

## Architecture

```
src/
  index.ts          # Worker entry point — routing, auth, rate limiting
  auth.ts           # Bearer token validation (static + OAuth)
  oauth.ts          # OAuth 2.0 authorization server (RFC 6749 + PKCE + RFC 7591)
  types.ts          # Env interface
  strava/
    client.ts       # Strava API client — token refresh, per-user KV caching, retries
    tools.ts        # MCP tool registrations (15 tools)
    streams.ts      # Stream fetching — gap detection, downsampling, caching
    errors.ts       # Structured error responses
    types.ts        # Shared Strava types
scripts/
  get-refresh-token.ts   # One-shot Strava OAuth flow for local dev
```

**KV namespaces:**
- `TOKEN_CACHE` — OAuth tokens, Strava access tokens (per-user), registered OAuth clients, latest Strava rate-limit snapshot, cached athlete profile for `health`
- `STREAM_CACHE` — Cached streams (30-day TTL), activity summaries (24h TTL), laps (30-day TTL)

**Logging:**
- `LOG_LEVEL` env var (debug | info | warn | error, default `info`) controls verbosity. Logs are emitted as single-line JSON to `console.log`, viewable via `wrangler tail` or the Workers Logs UI. Auth tokens and client secrets are redacted before serialisation.

**Auth:**
- `POST /oauth/register` — Dynamic client registration (RFC 7591)
- `GET /oauth/authorize` → redirects to Strava → `GET /oauth/strava-callback` → issues our token
- `POST /oauth/token` — Authorization Code + PKCE exchange
- Static `MCP_AUTH_TOKEN` Bearer header also accepted (admin/testing path)

---

## Development

```bash
pnpm dev          # local dev server
pnpm test         # tests in watch mode
pnpm test:run     # tests once (61 tests across 5 files)
pnpm typecheck    # TypeScript
pnpm lint         # ESLint
pnpm lint:fix     # ESLint with autofix
pnpm tail         # stream live Worker logs
```

Tests use [Vitest](https://vitest.dev/) with `@cloudflare/vitest-pool-workers`. Tool tests run the full MCP Client ↔ Server path via `InMemoryTransport` — no mocked HTTP, real tool dispatch.

---

## Secrets reference

| Secret | Required | Description |
|--------|----------|-------------|
| `STRAVA_CLIENT_ID` | Yes | Strava app Client ID |
| `STRAVA_CLIENT_SECRET` | Yes | Strava app Client Secret |
| `MCP_AUTH_TOKEN` | Yes | Bearer token for direct API access |
| `STRAVA_REFRESH_TOKEN` | Optional | Long-lived refresh token for the static auth path |

Set via `npx wrangler secret put <NAME>`. Never commit these.

---

## Contributing

The thin-data-layer design is intentional. Before opening a PR that adds smoothing, filtering, derived metrics, or analytical opinions to the server: don't. Those belong in conversation with Claude. If you're unsure, open an issue first.

PRs welcome for: new read-only Strava endpoints, performance improvements, bug fixes, better error messages.
