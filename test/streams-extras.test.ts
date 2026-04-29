import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchActivityStreams,
  defaultsForSport,
  computeLapIndex,
} from "../src/strava/streams.js";
import type { StravaClient } from "../src/strava/client.js";
import type { ActivityLap } from "../src/strava/activity.js";

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

// ---------------------------------------------------------------------------
// C1 — defaultsForSport
// ---------------------------------------------------------------------------

describe("defaultsForSport", () => {
  it("excludes watts for Run", () => {
    const d = defaultsForSport("Run");
    expect(d).not.toContain("watts");
    expect(d).toContain("heartrate");
    expect(d).toContain("grade_smooth");
  });

  it("includes watts for Ride", () => {
    const d = defaultsForSport("Ride");
    expect(d).toContain("watts");
    expect(d).toContain("cadence");
  });

  it("returns swim-friendly subset for Swim", () => {
    const d = defaultsForSport("Swim");
    expect(d).not.toContain("altitude");
    expect(d).not.toContain("heartrate");
    expect(d).toContain("velocity_smooth");
    expect(d).toContain("cadence");
  });

  it("falls back to generic defaults for unknown sport types", () => {
    const generic = defaultsForSport(undefined);
    const unknown = defaultsForSport("Snowboard");
    expect(unknown).toEqual(generic);
  });

  it("treats trail runs and walks like runs", () => {
    expect(defaultsForSport("TrailRun")).not.toContain("watts");
    expect(defaultsForSport("Walk")).not.toContain("watts");
    expect(defaultsForSport("Hike")).not.toContain("watts");
  });
});

// ---------------------------------------------------------------------------
// C2 — pace conversion
// ---------------------------------------------------------------------------

describe("pace conversion (units = running)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("produces null for zero or near-zero velocity samples (not Infinity)", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2, 3, 4], series_type: "time", original_size: 5, resolution: "high" },
      { type: "velocity_smooth", data: [3.0, 0, 0.05, 2.5, 4.0], series_type: "time", original_size: 5, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time", "velocity_smooth"],
      units: "running",
    });
    const data = result.data as Record<string, (number | null)[]>;
    expect(data.pace_per_km).toBeDefined();
    expect(data.pace_per_km[0]).toBeCloseTo(1000 / 3.0, 4);
    expect(data.pace_per_km[1]).toBeNull();
    expect(data.pace_per_km[2]).toBeNull();
    // No infinities anywhere
    for (const v of data.pace_per_km) {
      expect(v === Infinity || v === -Infinity).toBe(false);
    }
    expect(result.metadata.derived_types).toContain("pace_per_km");
    expect(result.metadata.units_mode).toBe("running");
  });

  it("produces speed_kmh in cycling mode", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2], series_type: "time", original_size: 3, resolution: "high" },
      { type: "velocity_smooth", data: [10, 5, 0], series_type: "time", original_size: 3, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time", "velocity_smooth"],
      units: "cycling",
    });
    const data = result.data as Record<string, (number | null)[]>;
    expect(data.speed_kmh).toEqual([36, 18, 0]);
  });

  it("auto mode resolves to running for Run sport_type", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2], series_type: "time", original_size: 3, resolution: "high" },
      { type: "velocity_smooth", data: [3, 3, 3], series_type: "time", original_size: 3, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time", "velocity_smooth"],
      units: "auto",
      sportType: "Run",
    });
    expect(result.metadata.units_mode).toBe("running");
    expect((result.data as Record<string, unknown>)["pace_per_km"]).toBeDefined();
  });

  it("raw mode produces no derived fields", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2], series_type: "time", original_size: 3, resolution: "high" },
      { type: "velocity_smooth", data: [3, 3, 3], series_type: "time", original_size: 3, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const result = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time", "velocity_smooth"],
      units: "raw",
    });
    expect(result.metadata.derived_types).toEqual([]);
    const data = result.data as Record<string, unknown>;
    expect(data.pace_per_km).toBeUndefined();
    expect(data.speed_kmh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C3 — lap_index
// ---------------------------------------------------------------------------

describe("computeLapIndex", () => {
  const laps: ActivityLap[] = [
    { id: 1, lap_index: 1, elapsed_time: 5, moving_time: 5, distance: 10 },
    { id: 2, lap_index: 2, elapsed_time: 5, moving_time: 5, distance: 10 },
  ];

  it("assigns the correct lap to each time sample", () => {
    const time = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = computeLapIndex(time, laps);
    expect(out).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("returns an array of the same length as time", () => {
    const time = Array.from({ length: 100 }, (_, i) => i / 10);
    const out = computeLapIndex(time, laps);
    expect(out).toHaveLength(100);
  });

  it("treats null time samples as null lap", () => {
    const out = computeLapIndex([null, 0, null, 6], laps);
    expect(out).toEqual([null, 0, null, 1]);
  });

  it("includes the very last sample on the final boundary in the last lap", () => {
    const out = computeLapIndex([10], laps);
    expect(out).toEqual([1]);
  });
});

describe("fetchActivityStreams with laps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits lap_index when laps are provided", async () => {
    const streams = [
      { type: "time", data: [0, 1, 2, 3, 4, 5], series_type: "time", original_size: 6, resolution: "high" },
    ];
    const client = makeClient(streams);
    const kv = makeKv();
    const laps: ActivityLap[] = [
      { id: 1, lap_index: 1, elapsed_time: 3, moving_time: 3, distance: 10 },
      { id: 2, lap_index: 2, elapsed_time: 3, moving_time: 3, distance: 10 },
    ];
    const result = await fetchActivityStreams(client, kv, {
      activityId: 1,
      streamTypes: ["time"],
      laps,
    });
    const data = result.data as Record<string, unknown[]>;
    expect(data.lap_index).toEqual([0, 0, 0, 1, 1, 1]);
    expect(result.metadata.derived_types).toContain("lap_index");
  });
});
