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
}
