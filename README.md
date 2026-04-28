# strava-mcp

A personal, single-user MCP server exposing Strava data to Claude for detailed running analysis. Read-only. Thin data layer — no analysis logic. Deployed to Cloudflare Workers.

---

## Design philosophy

This MCP is intentionally a thin data layer. Its job is to fetch Strava data and return it faithfully. All analysis — smoothing, outlier removal, zone interpretation, drift calculation, cross-run comparisons — happens in conversation with Claude, not inside the server.

**If you are tempted to add a smoothing parameter, a `moving_only` filter, or an `analyse_run` tool: don't.** These decisions belong in conversation, where they can be questioned, adjusted, and applied differently each time. The MCP cannot know what you want; Claude in conversation can.

The one exception to "no server-side processing" is `downsample_to_seconds` on stream fetches — this exists purely for transport (large activities produce large responses), not as an analytical choice.

---

## Strava app setup

1. Go to [developers.strava.com](https://www.strava.com/settings/api) and create an app.
2. Set **Authorization Callback Domain** to `localhost` for now.
3. Note your **Client ID** and **Client Secret**.
4. The exact OAuth scopes this server uses: `read,activity:read_all,profile:read_all`
   - `activity:write`, `profile:write`, and all other write scopes must **never** be requested. This MCP is read-only by design.
5. After getting your Client ID and Secret, follow **issue #1** to obtain your refresh token.

---

## Setup (local dev)

```bash
git clone https://github.com/mike-keefe/strava-mcp
cd strava-mcp
pnpm install

# Create Cloudflare KV namespaces (requires wrangler login first)
npx wrangler login
npx wrangler kv namespace create TOKEN_CACHE
npx wrangler kv namespace create STREAM_CACHE
# Copy the IDs printed above into wrangler.jsonc

# Copy and fill in dev secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values

pnpm dev
```

---

## Deployment

```bash
# One-time: login and create KV namespaces (see Setup above)
npx wrangler login

# Set secrets (run each and paste the value when prompted)
npx wrangler secret put MCP_AUTH_TOKEN      # use the token printed during initial setup
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN

# Deploy
pnpm deploy
```

See **issue #12** for the full first-deploy walkthrough.

---

## Adding to Claude

1. Deploy (above).
2. In Claude: **Settings → Connectors → Add custom connector**.
3. Enter your deployed Worker URL (e.g. `https://strava-mcp.your-subdomain.workers.dev/mcp`).
4. Add a header: `Authorization: Bearer <your MCP_AUTH_TOKEN>`.
5. Test with: *"what's my latest activity?"*

---

## Available tools

| Tool | Description | Issue |
|------|-------------|-------|
| `get_athlete_profile` | Athlete profile (name, FTP, weight, zones config) | #3 |
| `get_recent_activities` | List activities with filters (type, date range, limit) | #4 |
| `get_activity_details` | Full activity breakdown — laps, splits, best efforts, segments | #5 |
| `get_activity_streams` | Raw per-second stream data (HR, pace, cadence, altitude, etc.) | #6 |
| `get_activity_zones` | HR and power zone distribution for an activity | #7 |
| `get_athlete_zones` | Athlete's configured HR and power zone thresholds | #8 |
| `get_athlete_stats` | Recent / YTD / all-time totals by sport | #9 |
| `get_segment_details` | Segment info and athlete PR | #13 |
| `list_my_segment_efforts` | All efforts on a segment over time | #14 |
| `get_segment_effort_streams` | Per-second streams for a single segment effort | #15 |
| `explore_segments` | Find segments in a bounding box | #16 |
| `list_routes` | Saved routes | #17 |
| `get_route_details` | Full route with stream data | #18 |
| `list_gear` | Bikes and shoes with mileage | #19 |
| `get_activity_laps` | Manually-pressed laps for an activity | #20 |

*All tools marked with an issue number are stubs pending that issue.*

---

## Development scripts

```bash
pnpm dev        # local dev server (wrangler dev)
pnpm deploy     # deploy to Cloudflare
pnpm test       # run tests in watch mode
pnpm test:run   # run tests once
pnpm lint       # ESLint
pnpm lint:fix   # ESLint with autofix
pnpm typecheck  # TypeScript type checking
pnpm tail       # stream live Worker logs (wrangler tail)
```
