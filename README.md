# strava-mcp

A personal, single-user MCP server exposing Strava data to Claude for detailed running analysis. Read-only. Thin data layer — no analysis logic. Deployed to Cloudflare Workers.

---

## Design philosophy

This MCP is intentionally a thin data layer. Its job is to fetch Strava data and return it faithfully. All analysis — smoothing, outlier removal, zone interpretation, drift calculation, cross-run comparisons — happens in conversation with Claude, not inside the server.

**If you are tempted to add a smoothing parameter, a `moving_only` filter, or an `analyse_run` tool: don't.** These decisions belong in conversation, where they can be questioned, adjusted, and applied differently each time. The MCP cannot know what you want; Claude in conversation can.

The one exception to "no server-side processing" is `downsample_to_seconds` on stream fetches — this exists purely for transport (large activities produce large responses), not as an analytical choice.

---

## First deploy — complete walkthrough

Follow these steps in order to go from zero to a working Claude connector.

### 1. Prerequisites

- Node.js 20+ (`node --version`)
- pnpm (`npm install -g pnpm`)
- Cloudflare account (free tier is fine): [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
- GitHub CLI authenticated: `gh auth status`

### 2. Clone and install

```bash
git clone https://github.com/mike-keefe/strava-mcp
cd strava-mcp
pnpm install
```

### 3. Register a Strava API app

1. Go to [https://www.strava.com/settings/api](https://www.strava.com/settings/api) and create an app.
2. Fill in any name and website (e.g. `http://localhost`).
3. Set **Authorization Callback Domain** to `localhost`.
4. Submit. Note your **Client ID** and **Client Secret** from the app page.

The OAuth scopes this server uses: **`read,activity:read_all,profile:read_all`** — read-only, no write scopes ever.

### 4. Get your Strava refresh token

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars — add your STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET

pnpm get-refresh-token
```

This opens Strava in your browser, asks you to authorise the app, and prints your refresh token to the terminal. Copy it into `.dev.vars` as `STRAVA_REFRESH_TOKEN`. The refresh token is long-lived — you only need to do this once.

### 5. Log in to Cloudflare and create KV namespaces

> **Skip this step** if you already have `wrangler.jsonc` populated with real KV IDs (done during initial project setup).

```bash
npx wrangler login

npx wrangler kv namespace create TOKEN_CACHE
npx wrangler kv namespace create STREAM_CACHE
# For local dev, also create preview namespaces:
npx wrangler kv namespace create TOKEN_CACHE --preview
npx wrangler kv namespace create STREAM_CACHE --preview
```

Copy the printed IDs into the `kv_namespaces` section of `wrangler.jsonc`.

### 6. Deploy

```bash
pnpm deploy
```

The Worker URL will be printed at the end: `https://strava-mcp.<your-subdomain>.workers.dev`

### 7. Set Worker secrets

```bash
npx wrangler secret put MCP_AUTH_TOKEN       # the token from your .dev.vars
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
```

Paste each value when prompted.

### 8. Add to Claude

1. In Claude: **Settings → Connectors → Add custom connector**
2. URL: `https://strava-mcp.<your-subdomain>.workers.dev/mcp`
3. Add header: `Authorization: Bearer <your MCP_AUTH_TOKEN>`
4. Save and test with: *"what's my latest activity?"*

---

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in all four values in .dev.vars

pnpm dev
```

The Worker runs locally at `http://localhost:8787`. Use the same `Authorization: Bearer` header to test.

---

## Available tools

| Tool | Description | Status |
|------|-------------|--------|
| `get_athlete_profile` | Athlete profile: name, location, weight, FTP, measurement preference | ✅ |
| `get_recent_activities` | List activities with filters: type, date range, limit (default 30, max 200) | ✅ |
| `get_activity_details` | Full activity: laps, splits, best efforts, segment efforts, all metadata | ✅ |
| `get_activity_streams` | Raw per-second stream data (HR, pace, cadence, altitude, etc.) — no smoothing | ✅ |
| `get_activity_zones` | HR and power zone distribution for an activity, as Strava reports it | ✅ |
| `get_athlete_zones` | Athlete's configured HR and power zone thresholds | ✅ |
| `get_athlete_stats` | Recent (4 weeks) / YTD / all-time totals by sport | ✅ |
| `get_segment_details` | Segment info, grade, elevation, effort counts, athlete PR | ✅ |
| `list_my_segment_efforts` | All efforts on a segment over time, with date filters | ✅ |
| `get_segment_effort_streams` | Per-second streams for a single segment effort | ✅ |
| `explore_segments` | Find segments in a bounding box (up to 10 results) | ✅ |
| `list_routes` | Saved routes with pagination | ✅ |
| `get_route_details` | Full route metadata + stream data (latlng, distance, altitude) | ✅ |
| `list_gear` | Bikes and shoes with mileage | ✅ |
| `get_activity_laps` | Manually-pressed laps for an activity | ✅ |

---

## Development scripts

```bash
pnpm dev               # local dev server (wrangler dev)
pnpm deploy            # deploy to Cloudflare
pnpm test              # run tests in watch mode
pnpm test:run          # run tests once
pnpm lint              # ESLint
pnpm lint:fix          # ESLint with autofix
pnpm typecheck         # TypeScript type checking
pnpm tail              # stream live Worker logs (wrangler tail)
pnpm get-refresh-token # run the Strava OAuth flow to get a refresh token
```

---

## Design philosophy (for contributors)

This MCP is intentionally a thin data layer. Its job is to fetch and return Strava data faithfully — nothing more. All analysis (smoothing, outlier removal, drift calculation, zone analysis, comparisons across activities) happens in conversation with Claude.

Concretely:
- Streams are returned raw. No `smooth` parameter, no `clean_outliers`, no `moving_only` filter.
- The only allowed server-side transformation is `downsample_to_seconds` (transport optimisation only).
- No "analyse_run" or similar derived-metric tools. Those belong in conversation.
- Gap metadata is informational — the MCP never fills or interpolates gaps.

If a future issue suggests adding analytical opinions to the MCP, push back and ask Mike to confirm.
