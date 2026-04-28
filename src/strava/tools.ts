import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StravaClient } from "./client.js";
import { handleStravaError } from "./errors.js";
import { fetchActivityStreams } from "./streams.js";
import type { StreamType } from "./types.js";

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerStravaTools(
  server: McpServer,
  client: StravaClient,
  streamCache: KVNamespace
): void {
  // Issue #3 — get_athlete_profile
  server.tool(
    "get_athlete_profile",
    "Returns the authenticated athlete's profile: name, location, weight, FTP, zones preference, and account info.",
    {},
    async () => {
      try {
        const res = await client.fetch("/athlete");
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        const activities: unknown[] = [];
        let page = 1;
        while (activities.length < limit) {
          const perPage = Math.min(200, limit - activities.length);
          const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
          if (before) params.set("before", String(before));
          if (after) params.set("after", String(after));
          const res = await client.fetch(`/athlete/activities?${params}`);
          if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
          const page_data = (await res.json()) as unknown[];
          if (page_data.length === 0) break;
          activities.push(...page_data);
          if (page_data.length < perPage) break;
          page++;
        }
        const filtered = activity_type
          ? activities.filter(
              (a) =>
                (a as Record<string, unknown>)["type"] === activity_type ||
                (a as Record<string, unknown>)["sport_type"] === activity_type
            )
          : activities;
        return ok(filtered.slice(0, limit));
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
    },
    async ({ activity_id, stream_types, resolution, downsample_to_seconds, format }) => {
      try {
        const result = await fetchActivityStreams(client, streamCache, {
          activityId: activity_id,
          streamTypes: stream_types as StreamType[] | undefined,
          resolution: resolution as "low" | "medium" | "high" | "all" | undefined,
          downsampleToSeconds: downsample_to_seconds,
          format: format as "arrays" | "rows" | undefined,
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
    "HR and power zone distribution for an activity, as reported by Strava. No re-bucketing.",
    {
      activity_id: z.number().int().describe("The Strava activity ID"),
    },
    async ({ activity_id }) => {
      try {
        const res = await client.fetch(`/activities/${activity_id}/zones`);
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
        return ok(await res.json());
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        if (!athleteRes.ok) throw Object.assign(new Error(athleteRes.statusText), { status: athleteRes.status });
        const athlete = (await athleteRes.json()) as { id: number };
        const statsRes = await client.fetch(`/athletes/${athlete.id}/stats`);
        if (!statsRes.ok) throw Object.assign(new Error(statsRes.statusText), { status: statsRes.status });
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        const keys = (stream_types ?? ["time", "distance", "altitude", "latlng"]).join(",");
        const res = await client.fetch(
          `/segment_efforts/${effort_id}/streams?keys=${keys}&resolution=all&series_type=time`
        );
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
        const streamsArray = (await res.json()) as { type: string; data: unknown[] }[];
        const present = streamsArray.map((s) => s.type);
        const requested = stream_types ?? ["time", "distance", "altitude", "latlng"];
        const missing = requested.filter((t) => !present.includes(t));
        return ok({
          metadata: {
            stream_types_present: present,
            stream_types_missing: missing,
          },
          data: Object.fromEntries(streamsArray.map((s) => [s.type, s.data])),
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        if (!athleteRes.ok) throw Object.assign(new Error(athleteRes.statusText), { status: athleteRes.status });
        const athlete = (await athleteRes.json()) as { id: number };
        const params = new URLSearchParams({ page: String(page), per_page: String(per_page) });
        const res = await client.fetch(`/athletes/${athlete.id}/routes?${params}`);
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        const [routeRes, streamsRes] = await Promise.all([
          client.fetch(`/routes/${route_id}`),
          client.fetch(`/routes/${route_id}/streams`),
        ]);
        if (!routeRes.ok) throw Object.assign(new Error(routeRes.statusText), { status: routeRes.status });
        const route = await routeRes.json();
        let streams: unknown = null;
        if (streamsRes.ok) {
          streams = await streamsRes.json();
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
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
        if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
        return ok(await res.json());
      } catch (err) {
        return handleStravaError(err);
      }
    }
  );
}
