import type { StravaClient } from "./client.js";
import { assertOk } from "./errors.js";

export interface ActivitySummary {
  id: number;
  name?: string;
  sport_type?: string;
  type?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_speed?: number;
  max_speed?: number;
  suffer_score?: number;
  start_date_local?: string;
  start_date?: string;
  start_latlng?: number[];
  end_latlng?: number[];
  device_watts?: boolean;
  has_heartrate?: boolean;
  [key: string]: unknown;
}

export interface ActivityLap {
  id: number;
  lap_index: number;
  start_index?: number;
  end_index?: number;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  start_date?: string;
  total_elevation_gain?: number;
  average_speed?: number;
  average_heartrate?: number;
  [key: string]: unknown;
}

const SUMMARY_TTL_SECONDS = 24 * 60 * 60;
const LAPS_TTL_SECONDS = 30 * 24 * 60 * 60;

// Cache key conventions, exported so other modules use the same strings.
export const summaryCacheKey = (id: number) => `activity:${id}:summary`;
export const lapsCacheKey = (id: number) => `laps:${id}`;

// Fetches and caches the activity summary. Activities can be edited (renamed,
// privacy changes), so a 24h TTL balances freshness with avoiding repeat
// hits when several tools touch the same activity in one session.
export async function fetchActivitySummary(
  client: StravaClient,
  cache: KVNamespace,
  activityId: number
): Promise<ActivitySummary> {
  const key = summaryCacheKey(activityId);
  const cached = await cache.get(key);
  if (cached) {
    return JSON.parse(cached) as ActivitySummary;
  }
  const res = await client.fetch(`/activities/${activityId}`);
  assertOk(res);
  const summary = (await res.json()) as ActivitySummary;
  await cache.put(key, JSON.stringify(summary), { expirationTtl: SUMMARY_TTL_SECONDS });
  return summary;
}

// Laps don't change after upload, so a long TTL is fine.
export async function fetchActivityLaps(
  client: StravaClient,
  cache: KVNamespace,
  activityId: number
): Promise<ActivityLap[]> {
  const key = lapsCacheKey(activityId);
  const cached = await cache.get(key);
  if (cached) {
    return JSON.parse(cached) as ActivityLap[];
  }
  const res = await client.fetch(`/activities/${activityId}/laps`);
  assertOk(res);
  const laps = (await res.json()) as ActivityLap[];
  await cache.put(key, JSON.stringify(laps), { expirationTtl: LAPS_TTL_SECONDS });
  return laps;
}
