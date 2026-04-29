import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StravaApiError, RATE_LIMIT_KV_KEY } from "./client.js";
import type { StravaClient } from "./client.js";
import { handleStravaError, assertOk } from "./errors.js";
import { fetchActivityStreams, fetchSegmentEffortStreams } from "./streams.js";
import { fetchActivitySummary, fetchActivityLaps } from "./activity.js";
import type { StreamType } from "./types.js";
import type { Env } from "../types.js";

// Worker version surfaced by the health tool. Updated by hand when the
// package version changes — Wrangler doesn't bake package.json into the
// bundle so we keep this as a constant.
const WORKER_VERSION = "0.1.0";

const ATHLETE_PROFILE_CACHE_KEY = "health:athlete_profile";
const ATHLETE_PROFILE_TTL_SECONDS = 24 * 60 * 60;
const KV_LIST_LIMIT = 1000;

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const MAX_FILTER_PAGES = 10;
const FILTER_PAGE_SIZE = 200;

// Exported for unit testing. Paginates /athlete/activities in fixed-size pages
// and accumulates activities matching activityType until limit is reached or
// MAX_FILTER_PAGES is exhausted — whichever comes first.
export async function fetchFilteredActivities(
  client: Pick<StravaClient, "fetch">,
  limit: number,
  activityType: string,
  before?: number,
  after?: number
): Promise<unknown[]> {
  const matches: unknown[] = [];
  let page = 1;
  while (matches.length < limit && page <= MAX_FILTER_PAGES) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(FILTER_PAGE_SIZE),
    });
    if (before) params.set("before", String(before));
    if (after) params.set("after", String(after));
    const res = await client.fetch(`/athlete/activities?${params}`);
    assertOk(res);
    const pageData = (await res.json()) as unknown[];
    for (const a of pageData) {
      const act = a as Record<string, unknown>;
      if (act["type"] === activityType || act["sport_type"] === activityType) {
        matches.push(a);
        if (matches.length >= limit) break;
      }
    }
    if (pageData.length < FILTER_PAGE_SIZE) break; // no more activities on Strava
    page++;
  }
  return matches;
}

export function registerStravaTools(
  server: McpServer,
  client: StravaClient,
  env: Env
): void {
  const streamCache = env.STREAM_CACHE;
  const tokenCache = env.TOKEN_CACHE;
  // Issue #3 — get_athlete_profile
  server.tool(
    "get_athlete_profile",
    "Returns the authenticated athlete's profile: name, location, weight, FTP, zones preference, and account info.",
    {},
    async () => {
      try {
        const res = await client.fetch("/athlete");
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #4 — get_recent_activities
  server.tool(
    "get_recent_activities",
    "Lists the athlete's activities. Filters: limit (default 30, max 200), before/after (epoch seconds), activity_type (e.g. 'Run').",
    {
      limit: z.number().int().min(1).max(200).default(30).describe("Max activities to return"),
      before: z.number().int().optional().describe("Only return activities before this epoch timestamp"),
      after: z.number().int().optional().describe("Only return activities after this epoch timestamp"),
      activity_type: z.string().optional().describe("Filter by type, e.g. 'Run', 'Ride'"),
    },
    async ({ limit, before, after, activity_type }) => {
      try {
        if (activity_type) {
          return ok(
            await fetchFilteredActivities(client, limit, activity_type, before, after)
          );
        }
        // Unfiltered path — unchanged: page with per_page=limit to minimise API calls
        const activities: unknown[] = [];
        let page = 1;
        while (activities.length < limit) {
          const perPage = Math.min(200, limit - activities.length);
          const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
          if (before) params.set("before", String(before));
          if (after) params.set("after", String(after));
          const res = await client.fetch(`/athlete/activities?${params}`);
          assertOk(res);
          const page_data = (await res.json()) as unknown[];
          if (page_data.length === 0) break;
          activities.push(...page_data);
          if (page_data.length < perPage) break;
          page++;
        }
        return ok(activities.slice(0, limit));
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #5 — get_activity_details
  server.tool(
    "get_activity_details",
    "Full breakdown for a single activity: laps, splits, best efforts, segment efforts, and all metadata.",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const res = await client.fetch(`/activities/${activity_id}`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #6 — get_activity_streams
  server.tool(
    "get_activity_streams",
    "Raw per-second stream data for an activity. Returns time, distance, HR, pace, cadence, altitude, and more at full resolution. Thin pass-through — no smoothing or outlier removal.",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
      stream_types: z
        .array(
          z.enum([
            "time", "distance", "latlng", "altitude", "velocity_smooth",
            "heartrate", "cadence", "watts", "temp", "moving", "grade_smooth",
          ])
        )
        .optional()
        .describe("Stream types to fetch. Defaults to time, distance, heartrate, velocity_smooth, altitude, cadence"),
      resolution: z
        .enum(["low", "medium", "high", "all"])
        .optional()
        .describe("Data resolution. Default 'all' for maximum fidelity"),
      downsample_to_seconds: z
        .number()
        .int()
        .min(2)
        .optional()
        .describe("Transport optimisation only: average into N-second buckets. Not for analytical use."),
      format: z
        .enum(["arrays", "rows"])
        .optional()
        .describe("'arrays' (default, Strava native) or 'rows' (one object per second)"),
      units: z
        .enum(["raw", "running", "cycling", "auto"])
        .optional()
        .describe(
          "Units mode. 'auto' (default) derives from sport_type: pace_per_km for runs, speed_kmh for rides. 'raw' keeps only velocity_smooth in m/s."
        ),
      include_lap_index: z
        .boolean()
        .optional()
        .describe(
          "If true, include a lap_index array (0-based lap each sample falls within) alongside the streams."
        ),
      time_range_seconds: z
        .object({
          start: z.number().optional(),
          end: z.number().optional(),
        })
        .optional()
        .describe(
          "Optional inclusive window in elapsed seconds. Use to pull only a portion of the activity (e.g. last 5 minutes). Either bound may be omitted."
        ),
      distance_range_meters: z
        .object({
          start: z.number().optional(),
          end: z.number().optional(),
        })
        .optional()
        .describe(
          "Optional inclusive window along the distance stream in metres (e.g. {start: 10000, end: 15000} for kilometres 10–15). Either bound may be omitted."
        ),
    },
    async ({
      activity_id,
      stream_types,
      resolution,
      downsample_to_seconds,
      format,
      units,
      include_lap_index,
      time_range_seconds,
      distance_range_meters,
    }) => {
      try {
        // Sport-aware defaults and 'auto' units mode both need sport_type. The
        // summary is cached, so this is cheap on repeat calls.
        const needSummary = !stream_types || !units || units === "auto";
        let sportType: string | undefined;
        if (needSummary) {
          try {
            const summary = await fetchActivitySummary(client, streamCache, activity_id);
            sportType = summary.sport_type ?? summary.type;
          } catch {
            // If the summary fetch fails we'll fall back to generic defaults.
          }
        }
        const laps = include_lap_index
          ? await fetchActivityLaps(client, streamCache, activity_id).catch(() => undefined)
          : undefined;
        const result = await fetchActivityStreams(client, streamCache, {
          activityId: activity_id,
          streamTypes: stream_types as StreamType[] | undefined,
          resolution: resolution as "low" | "medium" | "high" | "all" | undefined,
          downsampleToSeconds: downsample_to_seconds,
          format: format as "arrays" | "rows" | undefined,
          sportType,
          units: units as "raw" | "running" | "cycling" | "auto" | undefined,
          laps,
          timeRangeSeconds: time_range_seconds,
          distanceRangeMeters: distance_range_meters,
        });
        return ok(result);
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #7 — get_activity_zones
  server.tool(
    "get_activity_zones",
    "HR and power zone distribution for an activity, as reported by Strava. Each zone block is augmented with seconds_in_zone summed from its distribution buckets — no re-bucketing.",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const res = await client.fetch(`/activities/${activity_id}/zones`);
        assertOk(res);
        const zones = (await res.json()) as Array<{
          distribution_buckets?: Array<{ time?: number }>;
          [k: string]: unknown;
        }>;
        const enriched = zones.map((z) => ({
          ...z,
          seconds_in_zone: (z.distribution_buckets ?? []).map((b) => b.time ?? 0),
        }));
        return ok(enriched);
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #8 — get_athlete_zones
  server.tool(
    "get_athlete_zones",
    "The athlete's configured HR and power zone thresholds. Use alongside get_activity_zones to interpret zone distribution.",
    {},
    async () => {
      try {
        const res = await client.fetch("/athlete/zones");
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #9 — get_athlete_stats
  server.tool(
    "get_athlete_stats",
    "Recent (last 4 weeks), YTD, and all-time totals by sport (run, ride, swim): count, distance, time, elevation.",
    {},
    async () => {
      try {
        // Need athlete ID first
        const athleteRes = await client.fetch("/athlete");
        assertOk(athleteRes);
        const athlete = (await athleteRes.json()) as { id: number };
        const statsRes = await client.fetch(`/athletes/${athlete.id}/stats`);
        assertOk(statsRes);
        return ok(await statsRes.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #13 — get_segment_details
  server.tool(
    "get_segment_details",
    "Details for a specific Strava segment: distance, grade, elevation, effort counts, and athlete PR if any.",
    {
      segment_id: z.number().int().describe("The Strava segment ID"),
    },
    async ({ segment_id }) => {
      try {
        const res = await client.fetch(`/segments/${segment_id}`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #14 — list_my_segment_efforts
  server.tool(
    "list_my_segment_efforts",
    "All of the athlete's efforts on a segment over time. Good for tracking improvement on a specific climb.",
    {
      segment_id: z.number().int().describe("The Strava segment ID"),
      start_date_local: z.string().optional().describe("ISO 8601 start date filter, e.g. '2025-01-01T00:00:00Z'"),
      end_date_local: z.string().optional().describe("ISO 8601 end date filter"),
      per_page: z.number().int().min(1).max(200).default(200).describe("Max efforts to return"),
    },
    async ({ segment_id, start_date_local, end_date_local, per_page }) => {
      try {
        const params = new URLSearchParams({ per_page: String(per_page) });
        if (start_date_local) params.set("start_date_local", start_date_local);
        if (end_date_local) params.set("end_date_local", end_date_local);
        const res = await client.fetch(`/segments/${segment_id}/all_efforts?${params}`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #15 — get_segment_effort_streams
  server.tool(
    "get_segment_effort_streams",
    "Per-second stream data for a single segment effort. Same thin pass-through design as get_activity_streams.",
    {
      effort_id: z.number().int().describe("The Strava segment effort ID"),
      stream_types: z
        .array(
          z.enum([
            "time", "distance", "latlng", "altitude", "velocity_smooth",
            "heartrate", "cadence", "watts", "temp", "moving", "grade_smooth",
          ])
        )
        .optional()
        .describe("Stream types to fetch. Defaults to time, distance, altitude, latlng"),
    },
    async ({ effort_id, stream_types }) => {
      try {
        const requested = (stream_types ?? ["time", "distance", "altitude", "latlng"]) as StreamType[];
        const { rawStreams, presentTypes } = await fetchSegmentEffortStreams(
          client,
          effort_id,
          requested
        );
        const missing = requested.filter((t) => !presentTypes.includes(t));
        return ok({
          metadata: {
            requested_types: requested,
            returned_types: presentTypes,
            unavailable_types: missing,
            stream_types_present: presentTypes,
            stream_types_missing: missing,
          },
          data: Object.fromEntries(presentTypes.map((t) => [t, rawStreams[t].data])),
        });
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #16 — explore_segments
  server.tool(
    "explore_segments",
    "Find Strava segments in a bounding box. Returns up to 10 segments.",
    {
      bounds: z
        .string()
        .describe(
          "Bounding box as 'sw_lat,sw_lng,ne_lat,ne_lng', e.g. '37.821,-122.505,37.842,-122.465'"
        ),
      activity_type: z
        .enum(["running", "riding"])
        .optional()
        .describe("Filter by activity type"),
    },
    async ({ bounds, activity_type }) => {
      try {
        const params = new URLSearchParams({ bounds });
        if (activity_type) params.set("activity_type", activity_type);
        const res = await client.fetch(`/segments/explore?${params}`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #17 — list_routes
  server.tool(
    "list_routes",
    "Lists the athlete's saved routes.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(200).default(30).describe("Routes per page"),
    },
    async ({ page, per_page }) => {
      try {
        const athleteRes = await client.fetch("/athlete");
        assertOk(athleteRes);
        const athlete = (await athleteRes.json()) as { id: number };
        const params = new URLSearchParams({ page: String(page), per_page: String(per_page) });
        const res = await client.fetch(`/athletes/${athlete.id}/routes?${params}`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #18 — get_route_details
  server.tool(
    "get_route_details",
    "Full details for a saved route including stream data (latlng, distance, altitude — Strava API limitation for routes).",
    {
      route_id: z.number().int().describe("The Strava route ID"),
    },
    async ({ route_id }) => {
      try {
        const routeRes = await client.fetch(`/routes/${route_id}`);
        assertOk(routeRes);
        const route = await routeRes.json();
        // /routes/:id/streams returns a fixed set (latlng, distance, altitude)
        // and doesn't accept a `keys` parameter, so it shouldn't 400 from
        // missing keys. It can still 403/404 on routes without stream data —
        // tolerate that and return the route with null streams.
        let streams: unknown = null;
        try {
          const streamsRes = await client.fetch(`/routes/${route_id}/streams`);
          if (streamsRes.ok) {
            streams = await streamsRes.json();
          }
        } catch (err) {
          if (!(err instanceof StravaApiError)) throw err;
        }
        return ok({ route, streams });
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #19 — list_gear
  server.tool(
    "list_gear",
    "The athlete's bikes and shoes with mileage. Useful for tracking when shoes are due to be retired.",
    {},
    async () => {
      try {
        const res = await client.fetch("/athlete");
        assertOk(res);
        const athlete = (await res.json()) as { bikes?: unknown[]; shoes?: unknown[] };
        return ok({ bikes: athlete.bikes ?? [], shoes: athlete.shoes ?? [] });
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // Issue #20 — get_activity_laps
  server.tool(
    "get_activity_laps",
    "Manually-pressed laps for an activity (the laps the athlete pressed the lap button for, not auto-splits).",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const res = await client.fetch(`/activities/${activity_id}/laps`);
        assertOk(res);
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // get_activity_best_efforts — projects the Strava-computed best_efforts
  // array off the activity detail. Strava already calculates 1k / 1mi / 5k /
  // 10k / half / full PRs for every Run; this tool returns just that subset
  // so consumers don't have to pull the full activity payload.
  server.tool(
    "get_activity_best_efforts",
    "Returns Strava's pre-computed best efforts (1k, 1mi, 5k, 10k, half marathon, marathon) for a Run activity, including pr_rank when the effort was a PR. Rides have no best_efforts; the response will be empty for those.",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const summary = await fetchActivitySummary(client, streamCache, activity_id);
        const efforts = (summary["best_efforts"] as unknown[]) ?? [];
        return ok({
          activity_id,
          sport_type: summary.sport_type ?? summary.type,
          start_date_local: summary.start_date_local,
          best_efforts: efforts,
        });
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );

  // D2 — health: deployment + cache + rate-limit snapshot for diagnostics.
  server.tool(
    "health",
    "Worker diagnostics: athlete identity, last seen Strava rate limit, cached entry counts, and worker version. Reach for this first when something seems off.",
    {},
    async () => {
      try {
        const athlete = await readAthleteProfile(client, tokenCache);
        const rateLimit = await readLatestRateLimit(tokenCache);
        const cacheStats = await readCacheStats(streamCache);
        return ok({
          worker_version: WORKER_VERSION,
          athlete,
          rate_limit: rateLimit,
          cache: cacheStats,
        });
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );
}

interface HealthAthlete {
  id: number | null;
  username: string | null;
  firstname?: string;
  lastname?: string;
}

async function readAthleteProfile(
  client: StravaClient,
  tokenCache: KVNamespace
): Promise<HealthAthlete> {
  const cached = await tokenCache.get(ATHLETE_PROFILE_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as HealthAthlete;
  }
  const res = await client.fetch("/athlete");
  assertOk(res);
  const a = (await res.json()) as {
    id?: number;
    username?: string;
    firstname?: string;
    lastname?: string;
  };
  const profile: HealthAthlete = {
    id: a.id ?? null,
    username: a.username ?? null,
    firstname: a.firstname,
    lastname: a.lastname,
  };
  await tokenCache.put(ATHLETE_PROFILE_CACHE_KEY, JSON.stringify(profile), {
    expirationTtl: ATHLETE_PROFILE_TTL_SECONDS,
  });
  return profile;
}

interface HealthRateLimit {
  shortTermLimit: number;
  shortTermUsage: number;
  dailyLimit: number;
  dailyUsage: number;
  updated_at: number | null;
}

async function readLatestRateLimit(tokenCache: KVNamespace): Promise<HealthRateLimit | null> {
  const raw = await tokenCache.get(RATE_LIMIT_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HealthRateLimit;
  } catch {
    return null;
  }
}

async function readCacheStats(
  streamCache: KVNamespace
): Promise<{ activity_summaries: number; stream_entries: number; lap_entries: number }> {
  // KV list returns up to 1000 keys per page. We page once: anything beyond
  // that means the cache is large enough that the exact count doesn't matter
  // for diagnostics. Counts saturate at KV_LIST_LIMIT.
  const result = await streamCache.list({ limit: KV_LIST_LIMIT });
  let activitySummaries = 0;
  let streamEntries = 0;
  let lapEntries = 0;
  for (const k of result.keys) {
    if (k.name.startsWith("streams:")) streamEntries++;
    else if (k.name.startsWith("activity:")) activitySummaries++;
    else if (k.name.startsWith("laps:")) lapEntries++;
  }
  return {
    activity_summaries: activitySummaries,
    stream_entries: streamEntries,
    lap_entries: lapEntries,
  };
}
