import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchActivityStreams } from "../src/strava/streams.js";
import { StravaApiError } from "../src/strava/client.js";
import type { StravaClient } from "../src/strava/client.js";

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

function makeClient(streamsBody: unknown): StravaClient {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(streamsBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ),
    lastRateLimitInfo: null,
  } as unknown as StravaClient;
}

// Minimal stream fixture: 10 seconds of data
function makeStreams(overrides: Record<string, number[]> = {}) {
  const time = overrides.time ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const distance = overrides.distance ?? [0, 3, 6, 9, 12, 15, 18, 21, 24, 27];
  const heartrate = overrides.heartrate ?? [140, 142, 143, 145, 144, 146, 145, 147, 148, 149];
  return [
    { type: "time", data: time, series_type: "time", original_size: time.length, resolution: "high" },
    { type: "distance", data: distance, series_type: "time", original_size: distance.length, resolution: "high" },
    { type: "heartrate", data: heartrate, series_type: "time", original_size: heartrate.length, resolution: "high" },
  ];
}

describe("fetchActivityStreams", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches and returns streams in arrays format", async () => {
    const client = makeClient(makeStreams());
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 123,
      streamTypes: ["time", "distance", "heartrate"],
    });
    expect(result.metadata.stream_types_present).toContain("time");
    expect(result.metadata.stream_types_missing).not.toContain("time");
    expect(result.metadata.gap_count).toBe(0);
    expect((result.data as Record<string, unknown[]>)["time"]).toHaveLength(10);
  });

  it("converts to rows format when requested", async () => {
    const client = makeClient(makeStreams());
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 123,
      streamTypes: ["time", "heartrate"],
      format: "rows",
    });
    const rows = result.data as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty("time");
    expect(rows[0]).toHaveProperty("heartrate");
    expect(rows).toHaveLength(10);
  });

  it("lists missing stream types in metadata", async () => {
    const client = makeClient(makeStreams()); // only has time, distance, heartrate
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 123,
      streamTypes: ["time", "watts", "cadence"], // watts and cadence not in fixture
    });
    expect(result.metadata.stream_types_missing).toContain("watts");
    expect(result.metadata.stream_types_missing).toContain("cadence");
    expect(result.metadata.stream_types_present).toContain("time");
  });

  it("uses cache on second call", async () => {
    const fixture = makeStreams();
    const client = makeClient(fixture);
    const kv = makeKv();

    await fetchActivityStreams(client, kv, { activityId: 123 });
    expect(kv.put).toHaveBeenCalledTimes(1);

    // Second call — should hit cache
    const cachedValue = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const kv2 = makeKv({ "streams:123:all": cachedValue });
    const client2 = makeClient(fixture);
    await fetchActivityStreams(client2, kv2, { activityId: 123 });
    expect((client2.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("detects gaps in the time stream", async () => {
    // Gap between index 4 and 5: 0,1,2,3,4 -> 15 (11-second gap)
    const streams = makeStreams({ time: [0, 1, 2, 3, 4, 15, 16, 17, 18, 19] });
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 456,
      streamTypes: ["time"],
    });
    expect(result.metadata.gap_count).toBe(1);
    expect(result.metadata.gap_locations[0]).toMatchObject({
      start_index: 4,
      end_index: 5,
      duration_seconds: 11,
    });
  });

  it("downsamples streams into N-second buckets", async () => {
    // 10 data points at 1s each, downsample to 5s => 2 buckets
    const client = makeClient(makeStreams());
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 789,
      streamTypes: ["time", "heartrate"],
      downsampleToSeconds: 5,
    });
    const timeArr = (result.data as Record<string, unknown[]>)["time"];
    expect(timeArr.length).toBe(2); // seconds 0-4 and 5-9
  });

  it("simulates a large activity (14400 points) without error", async () => {
    const n = 14400;
    const time = Array.from({ length: n }, (_, i) => i);
    const hr = Array.from({ length: n }, () => 150);
    const streams = [
      { type: "time", data: time, series_type: "time", original_size: n, resolution: "high" },
      { type: "heartrate", data: hr, series_type: "time", original_size: n, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 999,
      streamTypes: ["time", "heartrate"],
    });
    expect(result.metadata.original_size).toBe(n);
    expect((result.data as Record<string, unknown[]>)["time"]).toHaveLength(n);
  });

  // ---------------------------------------------------------------------------
  // A1 — retry on 400 with watts and temp removed (Run with no power meter)
  // ---------------------------------------------------------------------------

  it("retries without watts and temp when Strava returns 400", async () => {
    const fixture = makeStreams();
    const client = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(
          new StravaApiError(400, "Strava API error (400): bad watts", false, undefined, {
            errors: [{ resource: "Stream", field: "watts", code: "invalid" }],
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(fixture), { status: 200 })
        ),
      lastRateLimitInfo: null,
    } as unknown as StravaClient;
    const kv = makeKv();

    const result = await fetchActivityStreams(client, kv, {
      activityId: 18311335874,
      streamTypes: ["time", "distance", "heartrate"],
    });

    expect((client.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    const firstCallPath = (client.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const secondCallPath = (client.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(firstCallPath).toContain("watts");
    expect(secondCallPath).not.toContain("watts");
    expect(secondCallPath).not.toContain("temp");
    expect(result.metadata.returned_types).toContain("time");
    expect(result.metadata.unavailable_types).not.toContain("time");
  });

  it("re-throws the 400 with body when the retry without watts also fails", async () => {
    const errorBody = {
      message: "Bad Request",
      errors: [{ resource: "Activity", field: "id", code: "invalid" }],
    };
    const client = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(
          new StravaApiError(400, "Strava API error (400): first", false, undefined, errorBody)
        )
        .mockRejectedValueOnce(
          new StravaApiError(400, "Strava API error (400): second", false, undefined, errorBody)
        ),
      lastRateLimitInfo: null,
    } as unknown as StravaClient;
    const kv = makeKv();

    const err = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time"],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StravaApiError);
    expect((err as StravaApiError).status).toBe(400);
    expect((err as StravaApiError).body).toEqual(errorBody);
  });

  it("does not catch non-400 errors during the upstream fetch", async () => {
    const client = {
      fetch: vi.fn().mockRejectedValue(new StravaApiError(503, "server error", true)),
      lastRateLimitInfo: null,
    } as unknown as StravaClient;
    const kv = makeKv();

    const err = await fetchActivityStreams(client, kv, { activityId: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(StravaApiError);
    expect((err as StravaApiError).status).toBe(503);
    // No retry should have happened
    expect((client.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("preserves nulls in downsampled output", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2, 3, 4], series_type: "time", original_size: 5, resolution: "high" },
      { type: "heartrate", data: [140, null, null, null, 150], series_type: "time", original_size: 5, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 101,
      streamTypes: ["time", "heartrate"],
      downsampleToSeconds: 3,
    });
    // Bucket 0-2: heartrate has [140, null, null] -> avg of [140] = 140
    // Bucket 3-4: heartrate has [null, 150] -> avg of [150] = 150
    const hrArr = (result.data as Record<string, number[]>)["heartrate"];
    expect(hrArr[0]).toBe(140);
    expect(hrArr[1]).toBe(150);
  });
});
