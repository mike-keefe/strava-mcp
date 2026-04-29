import { StravaApiError } from "./client.js";
import type { StravaClient } from "./client.js";
import type { StreamType, StreamResolution } from "./types.js";

export type StreamsUnitsMode = "raw" | "running" | "cycling" | "auto";

export interface StreamsParams {
  activityId: number;
  streamTypes?: StreamType[];
  resolution?: StreamResolution;
  downsampleToSeconds?: number;
  format?: "arrays" | "rows";
  sportType?: string;
  units?: StreamsUnitsMode;
}

// Anything below this in m/s (~ 22:13 / km) is treated as stopped for the
// purpose of pace conversion. Without a floor, near-zero velocity samples
// produce nonsense pace values; with one, paused sections come back as null.
const PACE_VELOCITY_FLOOR_MS = 0.1;

const DEFAULT_STREAM_TYPES: StreamType[] = [
  "time",
  "distance",
  "heartrate",
  "velocity_smooth",
  "altitude",
  "cadence",
];

// Sport-aware default stream types. Avoids asking for watts on Runs (which
// commonly don't have a power stream) and includes grade_smooth for outdoor
// efforts where elevation matters. Used when the caller doesn't pass an
// explicit stream_types list. The retry-without-watts fix in
// fetchAllStreamsWithRetry still protects us when the device stream set
// disagrees with what these defaults assume.
export function defaultsForSport(sportType: string | undefined): StreamType[] {
  switch (sportType) {
    case "Run":
    case "TrailRun":
    case "Walk":
    case "Hike":
      return ["time", "distance", "heartrate", "velocity_smooth", "altitude", "cadence", "grade_smooth"];
    case "Ride":
    case "VirtualRide":
    case "EBikeRide":
    case "GravelRide":
    case "MountainBikeRide":
      return ["time", "distance", "heartrate", "velocity_smooth", "altitude", "cadence", "watts", "grade_smooth"];
    case "Swim":
      return ["time", "distance", "velocity_smooth", "cadence"];
    default:
      return DEFAULT_STREAM_TYPES;
  }
}

const ALL_STREAM_TYPES: StreamType[] = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
];

// Streams that are commonly absent on consumer GPS watches. When Strava
// returns a 400 for the full key list, we retry without these. The activity
// summary's `device_watts: true` flag is misleading — it indicates *estimated*
// watts on the summary, not the existence of a per-second watts stream. A
// 400 is the only signal we get for "this stream type isn't recorded".
const OPTIONAL_DEVICE_STREAMS: StreamType[] = ["watts", "temp"];

const STREAMS_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const GAP_THRESHOLD_SECONDS = 5;

interface RawStream {
  type: StreamType;
  data: (number | number[] | boolean | null)[];
  series_type: string;
  original_size: number;
  resolution: string;
}

interface GapLocation {
  start_index: number;
  end_index: number;
  duration_seconds: number;
}

interface StreamsMetadata {
  original_size: number;
  resolution_returned: string;
  downsampled_to_seconds: number | null;
  requested_types: StreamType[];
  returned_types: StreamType[];
  unavailable_types: StreamType[];
  units_mode: StreamsUnitsMode;
  derived_types: string[];
  // Legacy fields kept for backwards compat with existing consumers.
  stream_types_present: StreamType[];
  stream_types_missing: StreamType[];
  gap_count: number;
  gap_locations: GapLocation[];
}

type ArraysFormat = Record<string, (number | number[] | boolean | null)[]>;
type RowsFormat = Record<string, number | number[] | boolean | null>[];

export interface StreamsResult {
  metadata: StreamsMetadata;
  data: ArraysFormat | RowsFormat;
}

interface CachedStreams {
  rawStreams: Record<string, RawStream>;
  presentTypes: StreamType[];
}

export async function fetchActivityStreams(
  client: StravaClient,
  streamCache: KVNamespace,
  params: StreamsParams
): Promise<StreamsResult> {
  const {
    activityId,
    streamTypes,
    resolution = "all",
    downsampleToSeconds,
    format = "arrays",
    sportType,
    units = "auto",
  } = params;

  const effectiveStreamTypes = streamTypes ?? defaultsForSport(sportType);
  const requestedTypes = effectiveStreamTypes.filter((t): t is StreamType =>
    ALL_STREAM_TYPES.includes(t)
  );

  // Per-activity cache (activities are immutable). The cached payload always
  // contains the full safe stream set Strava actually returned; we filter to
  // the user's requested types on the way out.
  const cacheKey = `streams:${activityId}:all`;
  const cached = await readCachedStreams(streamCache, cacheKey);

  let rawStreams: Record<string, RawStream>;
  let presentInPayload: StreamType[];

  if (cached) {
    rawStreams = cached.rawStreams;
    presentInPayload = cached.presentTypes;
  } else {
    const fetched = await fetchAllStreamsWithRetry(client, activityId);
    rawStreams = fetched.rawStreams;
    presentInPayload = fetched.presentTypes;

    const cacheValue: CachedStreams = { rawStreams, presentTypes: presentInPayload };
    await streamCache.put(cacheKey, JSON.stringify(cacheValue), {
      expirationTtl: STREAMS_CACHE_TTL_SECONDS,
    });
  }

  // Anything the user asked for that isn't in the cached payload is
  // unavailable upstream — surface it in metadata, do not re-fetch.
  const returnedTypes = requestedTypes.filter((t) => rawStreams[t] !== undefined);
  const unavailableTypes = requestedTypes.filter((t) => rawStreams[t] === undefined);

  const timeStream = rawStreams["time"];
  const originalSize = timeStream?.data?.length ?? 0;

  const { gapCount, gapLocations } = detectGaps(timeStream?.data as number[] | undefined);

  let outputData: Record<string, (number | number[] | boolean | null)[]>;
  if (downsampleToSeconds && downsampleToSeconds > 1 && timeStream) {
    outputData = downsample(rawStreams, returnedTypes, downsampleToSeconds);
  } else {
    outputData = Object.fromEntries(
      returnedTypes.map((t) => [t, rawStreams[t].data as (number | number[] | boolean | null)[]])
    );
  }

  const resolutionReturned =
    resolution === "all" ? "all" : (timeStream?.resolution ?? "high");

  const resolvedUnits = resolveUnitsMode(units, sportType);
  const derivedTypes: string[] = [];
  if (resolvedUnits !== "raw" && returnedTypes.includes("velocity_smooth")) {
    const velocity = outputData["velocity_smooth"] as (number | null)[];
    if (resolvedUnits === "running") {
      outputData["pace_per_km"] = velocity.map((v) =>
        v !== null && typeof v === "number" && v > PACE_VELOCITY_FLOOR_MS ? 1000 / v : null
      );
      derivedTypes.push("pace_per_km");
    } else if (resolvedUnits === "cycling") {
      outputData["speed_kmh"] = velocity.map((v) =>
        v !== null && typeof v === "number" ? v * 3.6 : null
      );
      derivedTypes.push("speed_kmh");
    }
  }

  const metadata: StreamsMetadata = {
    original_size: originalSize,
    resolution_returned: resolutionReturned,
    downsampled_to_seconds: downsampleToSeconds ?? null,
    requested_types: requestedTypes,
    returned_types: returnedTypes,
    unavailable_types: unavailableTypes,
    units_mode: resolvedUnits,
    derived_types: derivedTypes,
    stream_types_present: returnedTypes,
    stream_types_missing: unavailableTypes,
    gap_count: gapCount,
    gap_locations: gapLocations,
  };

  if (format === "rows") {
    const length = outputData["time"]?.length ?? outputData[returnedTypes[0]]?.length ?? 0;
    const allKeys = [...returnedTypes, ...derivedTypes];
    const rows: RowsFormat = [];
    for (let i = 0; i < length; i++) {
      const row: Record<string, number | number[] | boolean | null> = {};
      for (const t of allKeys) {
        row[t] = (outputData[t]?.[i] ?? null) as number | number[] | boolean | null;
      }
      rows.push(row);
    }
    return { metadata, data: rows };
  }

  return { metadata, data: outputData };
}

function resolveUnitsMode(
  units: StreamsUnitsMode,
  sportType: string | undefined
): StreamsUnitsMode {
  if (units !== "auto") return units;
  switch (sportType) {
    case "Run":
    case "TrailRun":
    case "Walk":
    case "Hike":
      return "running";
    case "Ride":
    case "VirtualRide":
    case "EBikeRide":
    case "GravelRide":
    case "MountainBikeRide":
      return "cycling";
    default:
      return "raw";
  }
}

// Reads the streams cache, tolerating both the new {rawStreams, presentTypes}
// shape and legacy entries that stored only the rawStreams map directly.
async function readCachedStreams(
  streamCache: KVNamespace,
  cacheKey: string
): Promise<CachedStreams | null> {
  const raw = await streamCache.get(cacheKey);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "rawStreams" in parsed &&
    "presentTypes" in parsed
  ) {
    const c = parsed as CachedStreams;
    return { rawStreams: c.rawStreams, presentTypes: c.presentTypes };
  }
  // Legacy entry — derive presentTypes from the keys.
  const legacy = parsed as Record<string, RawStream>;
  return {
    rawStreams: legacy,
    presentTypes: Object.keys(legacy) as StreamType[],
  };
}

// Fetches the full stream set from Strava, retrying once on 400 with watts
// and temp removed (these are commonly absent on GPS watches without a power
// meter or thermometer).
async function fetchAllStreamsWithRetry(
  client: StravaClient,
  activityId: number
): Promise<{ rawStreams: Record<string, RawStream>; presentTypes: StreamType[] }> {
  try {
    return await fetchStreamsForKeys(client, activityId, ALL_STREAM_TYPES);
  } catch (err) {
    if (!(err instanceof StravaApiError) || err.status !== 400) {
      throw err;
    }
    const safeKeys = ALL_STREAM_TYPES.filter((k) => !OPTIONAL_DEVICE_STREAMS.includes(k));
    return fetchStreamsForKeys(client, activityId, safeKeys);
  }
}

async function fetchStreamsForKeys(
  client: StravaClient,
  activityId: number,
  keys: StreamType[]
): Promise<{ rawStreams: Record<string, RawStream>; presentTypes: StreamType[] }> {
  const query = `?keys=${keys.join(",")}&resolution=all&series_type=time`;
  const response = await client.fetch(`/activities/${activityId}/streams${query}`);
  const streamsArray = (await response.json()) as RawStream[];
  const rawStreams = Object.fromEntries(streamsArray.map((s) => [s.type, s]));
  return {
    rawStreams,
    presentTypes: Object.keys(rawStreams) as StreamType[],
  };
}

// Fetches segment effort streams. Strava's `/segment_efforts/:id/streams`
// endpoint accepts a `keys` parameter and, like activities, returns 400 if
// any requested key isn't recorded for that effort. We retry once with watts
// and temp removed.
export async function fetchSegmentEffortStreams(
  client: StravaClient,
  effortId: number,
  keys: StreamType[]
): Promise<{ rawStreams: Record<string, RawStream>; presentTypes: StreamType[] }> {
  try {
    return await fetchEffortStreamsForKeys(client, effortId, keys);
  } catch (err) {
    if (!(err instanceof StravaApiError) || err.status !== 400) {
      throw err;
    }
    const requestedOptionalKeys = keys.filter((k) => OPTIONAL_DEVICE_STREAMS.includes(k));
    if (requestedOptionalKeys.length === 0) {
      throw err;
    }
    const safeKeys = keys.filter((k) => !OPTIONAL_DEVICE_STREAMS.includes(k));
    if (safeKeys.length === 0) {
      throw err;
    }
    return fetchEffortStreamsForKeys(client, effortId, safeKeys);
  }
}

async function fetchEffortStreamsForKeys(
  client: StravaClient,
  effortId: number,
  keys: StreamType[]
): Promise<{ rawStreams: Record<string, RawStream>; presentTypes: StreamType[] }> {
  const query = `?keys=${keys.join(",")}&resolution=all&series_type=time`;
  const response = await client.fetch(`/segment_efforts/${effortId}/streams${query}`);
  const json = (await response.json()) as RawStream[];
  const rawStreams = Object.fromEntries(json.map((s) => [s.type, s]));
  return {
    rawStreams,
    presentTypes: Object.keys(rawStreams) as StreamType[],
  };
}

function detectGaps(
  timeData: number[] | undefined
): { gapCount: number; gapLocations: GapLocation[] } {
  if (!timeData || timeData.length < 2) {
    return { gapCount: 0, gapLocations: [] };
  }
  const gaps: GapLocation[] = [];
  for (let i = 1; i < timeData.length; i++) {
    const delta = timeData[i] - timeData[i - 1];
    if (delta > GAP_THRESHOLD_SECONDS) {
      gaps.push({ start_index: i - 1, end_index: i, duration_seconds: delta });
    }
  }
  return { gapCount: gaps.length, gapLocations: gaps };
}

function downsample(
  rawStreams: Record<string, RawStream>,
  presentTypes: StreamType[],
  bucketSeconds: number
): Record<string, (number | number[] | boolean | null)[]> {
  const timeData = rawStreams["time"]?.data as number[] | undefined;
  if (!timeData || timeData.length === 0) {
    return {};
  }

  const buckets: Map<number, Record<StreamType, (number | number[] | boolean | null)[]>> =
    new Map();

  for (let i = 0; i < timeData.length; i++) {
    const t = timeData[i];
    if (t === null || t === undefined) continue;
    const bucketKey = Math.floor(t / bucketSeconds) * bucketSeconds;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {} as Record<StreamType, (number | number[] | boolean | null)[]>);
    }
    const bucket = buckets.get(bucketKey)!;
    for (const type of presentTypes) {
      if (!bucket[type]) bucket[type] = [];
      const val = rawStreams[type]?.data?.[i] ?? null;
      bucket[type].push(val);
    }
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  const result: Record<string, (number | number[] | boolean | null)[]> = {};

  for (const type of presentTypes) {
    result[type] = [];
  }

  for (const bucketKey of sortedKeys) {
    const bucket = buckets.get(bucketKey)!;
    for (const type of presentTypes) {
      const vals = bucket[type] ?? [];
      if (type === "moving") {
        // Last-value for boolean streams
        const lastVal = vals.filter((v) => v !== null).at(-1) ?? null;
        result[type].push(lastVal);
      } else if (type === "latlng") {
        // Average latlng pairs
        const validPairs = vals.filter(
          (v): v is number[] => Array.isArray(v) && v.length === 2
        );
        if (validPairs.length === 0) {
          result[type].push(null);
        } else {
          const avgLat = validPairs.reduce((s, p) => s + p[0], 0) / validPairs.length;
          const avgLng = validPairs.reduce((s, p) => s + p[1], 0) / validPairs.length;
          result[type].push([avgLat, avgLng]);
        }
      } else {
        // Mean for numeric streams, preserving nulls
        const numericVals = vals.filter((v): v is number => v !== null && typeof v === "number");
        if (numericVals.length === 0) {
          result[type].push(null);
        } else {
          result[type].push(numericVals.reduce((s, v) => s + v, 0) / numericVals.length);
        }
      }
    }
  }

  return result;
}
