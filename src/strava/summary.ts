import type { StravaClient } from "./client.js";
import { assertOk } from "./errors.js";

export type SummaryGranularity = "week" | "month";

export interface SummaryBucket {
  period_start: string; // YYYY-MM-DD (UTC)
  period_end: string; // YYYY-MM-DD (UTC, inclusive)
  count: number;
  total_distance_m: number;
  total_moving_time_s: number;
  total_elapsed_time_s: number;
  total_elevation_gain_m: number;
  // Weighted by moving_time across the activities in the bucket. Null when
  // no activity in the bucket reported HR.
  avg_heartrate: number | null;
  // total_distance_m / total_moving_time_s, expressed as seconds per km. Null
  // when total_distance_m is zero (rest week with only stationary efforts).
  avg_pace_per_km: number | null;
  // Convenience field — same number expressed as km/h for ride-heavy weeks.
  avg_speed_kmh: number | null;
  longest_distance_m: number;
  longest_moving_time_s: number;
}

interface ActivitySummary {
  start_date?: string;
  start_date_local?: string;
  type?: string;
  sport_type?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
}

interface BucketAccumulator {
  period_start: string;
  period_end: string;
  count: number;
  total_distance: number;
  total_moving_time: number;
  total_elapsed_time: number;
  total_elevation_gain: number;
  hr_numerator: number; // sum of avg_hr * moving_time for activities with HR
  hr_denominator: number; // sum of moving_time for activities with HR
  longest_distance: number;
  longest_moving_time: number;
}

const ATHLETE_ACTIVITIES_PATH = "/athlete/activities";
const PAGE_SIZE = 200;
// 10 pages × 200 = 2000 activities. Enough for ~10 years of running for most
// people. If a query needs more, the caller should narrow with `after` /
// `before`. We cap to keep one tool call from doing unbounded Strava work.
const MAX_PAGES = 10;

export async function buildAthleteSummary(
  client: Pick<StravaClient, "fetch">,
  opts: {
    after?: number;
    before?: number;
    activityType?: string;
    granularity: SummaryGranularity;
  }
): Promise<{ buckets: SummaryBucket[]; activity_count: number; pages_fetched: number }> {
  const buckets = new Map<string, BucketAccumulator>();
  let activityCount = 0;
  let page = 1;
  let pagesFetched = 0;

  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    if (opts.before) params.set("before", String(opts.before));
    if (opts.after) params.set("after", String(opts.after));
    const res = await client.fetch(`${ATHLETE_ACTIVITIES_PATH}?${params}`);
    assertOk(res);
    pagesFetched++;
    const pageData = (await res.json()) as ActivitySummary[];
    if (pageData.length === 0) break;

    for (const a of pageData) {
      if (
        opts.activityType &&
        a.sport_type !== opts.activityType &&
        a.type !== opts.activityType
      ) {
        continue;
      }
      const dateStr = a.start_date_local ?? a.start_date;
      if (!dateStr) continue;
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) continue;

      const key = bucketKey(date, opts.granularity);
      const existing = buckets.get(key.key) ?? newAccumulator(key.periodStart, key.periodEnd);
      existing.count++;
      existing.total_distance += a.distance ?? 0;
      existing.total_moving_time += a.moving_time ?? 0;
      existing.total_elapsed_time += a.elapsed_time ?? 0;
      existing.total_elevation_gain += a.total_elevation_gain ?? 0;
      if (typeof a.average_heartrate === "number" && (a.moving_time ?? 0) > 0) {
        existing.hr_numerator += a.average_heartrate * (a.moving_time ?? 0);
        existing.hr_denominator += a.moving_time ?? 0;
      }
      if ((a.distance ?? 0) > existing.longest_distance) {
        existing.longest_distance = a.distance ?? 0;
      }
      if ((a.moving_time ?? 0) > existing.longest_moving_time) {
        existing.longest_moving_time = a.moving_time ?? 0;
      }
      buckets.set(key.key, existing);
      activityCount++;
    }

    if (pageData.length < PAGE_SIZE) break;
    page++;
  }

  const sorted = [...buckets.values()].sort((a, b) =>
    a.period_start.localeCompare(b.period_start)
  );
  return {
    buckets: sorted.map(finalize),
    activity_count: activityCount,
    pages_fetched: pagesFetched,
  };
}

function newAccumulator(period_start: string, period_end: string): BucketAccumulator {
  return {
    period_start,
    period_end,
    count: 0,
    total_distance: 0,
    total_moving_time: 0,
    total_elapsed_time: 0,
    total_elevation_gain: 0,
    hr_numerator: 0,
    hr_denominator: 0,
    longest_distance: 0,
    longest_moving_time: 0,
  };
}

function finalize(b: BucketAccumulator): SummaryBucket {
  const avgHr = b.hr_denominator > 0 ? b.hr_numerator / b.hr_denominator : null;
  const avgPace =
    b.total_distance > 0 ? b.total_moving_time / (b.total_distance / 1000) : null;
  const avgSpeedKmh =
    b.total_moving_time > 0 ? (b.total_distance / 1000) / (b.total_moving_time / 3600) : null;
  return {
    period_start: b.period_start,
    period_end: b.period_end,
    count: b.count,
    total_distance_m: b.total_distance,
    total_moving_time_s: b.total_moving_time,
    total_elapsed_time_s: b.total_elapsed_time,
    total_elevation_gain_m: b.total_elevation_gain,
    avg_heartrate: avgHr,
    avg_pace_per_km: avgPace,
    avg_speed_kmh: avgSpeedKmh,
    longest_distance_m: b.longest_distance,
    longest_moving_time_s: b.longest_moving_time,
  };
}

// Returns the bucket key plus the [period_start, period_end] dates covered.
// Both dates are YYYY-MM-DD UTC strings; period_end is inclusive (the last
// day in the bucket).
export function bucketKey(
  date: Date,
  granularity: SummaryGranularity
): { key: string; periodStart: string; periodEnd: string } {
  if (granularity === "month") {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return {
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      periodStart: dateOnly(start),
      periodEnd: dateOnly(end),
    };
  }
  // ISO weeks start on Monday. JS Date.getUTCDay returns Sunday=0, Monday=1.
  const day = date.getUTCDay();
  const offsetToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offsetToMonday)
  );
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    key: dateOnly(monday),
    periodStart: dateOnly(monday),
    periodEnd: dateOnly(sunday),
  };
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
