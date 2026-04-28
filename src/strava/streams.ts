import type { StravaClient } from "./client.js";
import type { StreamType, StreamResolution } from "./types.js";

export interface StreamsParams {
  activityId: number;
  streamTypes?: StreamType[];
  resolution?: StreamResolution;
  downsampleToSeconds?: number;
  format?: "arrays" | "rows";
}

const DEFAULT_STREAM_TYPES: StreamType[] = [
  "time",
  "distance",
  "heartrate",
  "velocity_smooth",
  "altitude",
  "cadence",
];

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

export async function fetchActivityStreams(
  client: StravaClient,
  streamCache: KVNamespace,
  params: StreamsParams
): Promise<StreamsResult> {
  const {
    activityId,
    streamTypes = DEFAULT_STREAM_TYPES,
    resolution = "all",
    downsampleToSeconds,
    format = "arrays",
  } = params;

  const requestedTypes = streamTypes.filter((t): t is StreamType =>
    ALL_STREAM_TYPES.includes(t)
  );

  // Fetch raw streams — cache by activity ID (activities are immutable)
  const cacheKey = `streams:${activityId}:all`;
  let rawStreams: Record<string, RawStream>;

  const cached = await streamCache.get(cacheKey);
  if (cached) {
    rawStreams = JSON.parse(cached) as Record<string, RawStream>;
  } else {
    const keys = ALL_STREAM_TYPES.join(",");
    const query = `?keys=${keys}&resolution=all&series_type=time`;
    const response = await client.fetch(`/activities/${activityId}/streams${query}`);
    if (!response.ok) {
      throw Object.assign(new Error(`Strava API error: ${response.status}`), {
        status: response.status,
      });
    }
    const streamsArray = (await response.json()) as RawStream[];
    rawStreams = Object.fromEntries(streamsArray.map((s) => [s.type, s]));
    await streamCache.put(cacheKey, JSON.stringify(rawStreams), {
      expirationTtl: 30 * 24 * 60 * 60,
    });
  }

  const presentTypes = requestedTypes.filter((t) => rawStreams[t] !== undefined);
  const missingTypes = requestedTypes.filter((t) => rawStreams[t] === undefined);

  const timeStream = rawStreams["time"];
  const originalSize = timeStream?.data?.length ?? 0;

  // Detect gaps in the time stream
  const { gapCount, gapLocations } = detectGaps(timeStream?.data as number[] | undefined);

  // Downsample if requested
  let outputData: Record<string, (number | number[] | boolean | null)[]>;
  if (downsampleToSeconds && downsampleToSeconds > 1 && timeStream) {
    outputData = downsample(rawStreams, presentTypes, downsampleToSeconds);
  } else {
    outputData = Object.fromEntries(
      presentTypes.map((t) => [t, rawStreams[t].data as (number | number[] | boolean | null)[]])
    );
  }

  const resolutionReturned =
    resolution === "all" ? "all" : (timeStream?.resolution ?? "high");

  const metadata: StreamsMetadata = {
    original_size: originalSize,
    resolution_returned: resolutionReturned,
    downsampled_to_seconds: downsampleToSeconds ?? null,
    stream_types_present: presentTypes,
    stream_types_missing: missingTypes,
    gap_count: gapCount,
    gap_locations: gapLocations,
  };

  if (format === "rows") {
    const length = outputData["time"]?.length ?? outputData[presentTypes[0]]?.length ?? 0;
    const rows: RowsFormat = [];
    for (let i = 0; i < length; i++) {
      const row: Record<string, number | number[] | boolean | null> = {};
      for (const t of presentTypes) {
        row[t] = (outputData[t]?.[i] ?? null) as number | number[] | boolean | null;
      }
      rows.push(row);
    }
    return { metadata, data: rows };
  }

  return { metadata, data: outputData };
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
