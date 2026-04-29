import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStravaTools } from "../src/strava/tools.js";
import { fetchFilteredActivities } from "../src/strava/tools.js";
import type { StravaClient } from "../src/strava/client.js";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

type FetchRoute = [string, unknown, number?]; // [path-substring, body, status=200]

function mockStravaClient(routes: FetchRoute[]): Pick<StravaClient, "fetch"> & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn().mockImplementation(async (path: string) => {
      // Strip query string for matching so exact patterns work with parameterised URLs
      const pathBase = path.split("?")[0];
      const route = routes.find(([pattern]) => pathBase === pattern);
      if (!route) return new Response("Not Found", { status: 404, statusText: "Not Found" });
      const [, body, status = 200] = route;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  };
}

function mockKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn().mockImplementation(async (key: string) => { store.delete(key); }),
    list: vi.fn().mockImplementation(async (opts?: { prefix?: string; limit?: number }) => {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

interface Harness {
  mcpClient: Client;
  mockFetch: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

interface HarnessOptions {
  tokenCache?: KVNamespace;
  streamCache?: KVNamespace;
}

function makeEnv(opts: HarnessOptions = {}): import("../src/types.js").Env {
  return {
    TOKEN_CACHE: opts.tokenCache ?? mockKv(),
    STREAM_CACHE: opts.streamCache ?? mockKv(),
    IP_RATE_LIMITER: {} as RateLimit,
    MCP_AUTH_TOKEN: "test-token",
    STRAVA_CLIENT_ID: "client123",
    STRAVA_CLIENT_SECRET: "secret456",
    STRAVA_REFRESH_TOKEN: "refresh789",
    WEBHOOK_VERIFY_TOKEN: "webhook-secret",
  };
}

async function createHarness(routes: FetchRoute[], opts: HarnessOptions = {}): Promise<Harness> {
  const stravaClient = mockStravaClient(routes);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerStravaTools(server, stravaClient as unknown as StravaClient, makeEnv(opts));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  return {
    mcpClient,
    mockFetch: stravaClient.fetch,
    close: () => mcpClient.close(),
  };
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as { type: string; text?: string }[];
  const text = content.find((c) => c.type === "text");
  return text?.text ? JSON.parse(text.text) : null;
}

// ---------------------------------------------------------------------------
// fetchFilteredActivities unit tests (called directly, no harness needed)
// ---------------------------------------------------------------------------

const run = (id: number) => ({ id, type: "Run", sport_type: "Run" });
const ride = (id: number) => ({ id, type: "Ride", sport_type: "Ride" });

function mockPaginatedClient(pages: unknown[][]): Pick<StravaClient, "fetch"> {
  let page = 0;
  return {
    fetch: vi.fn().mockImplementation(async () => {
      const data = pages[page++] ?? [];
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  };
}

describe("fetchFilteredActivities", () => {
  it("paginates past a first page with no type matches", async () => {
    const fullRunPage = Array.from({ length: 200 }, (_, i) => run(i));
    const client = mockPaginatedClient([fullRunPage, [ride(201), ride(202)]]);
    const result = await fetchFilteredActivities(client, 1, "Ride");
    expect(result).toHaveLength(1);
    expect((result[0] as { id: number }).id).toBe(201);
    expect((client.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("threads before/after params through every page fetch", async () => {
    const client = mockPaginatedClient([[run(1)], [ride(2)]]);
    await fetchFilteredActivities(client, 1, "Ride", 1700000000, 1600000000);
    const calls = (client.fetch as ReturnType<typeof vi.fn>).mock.calls as [string][];
    for (const [path] of calls) {
      expect(path).toContain("before=1700000000");
      expect(path).toContain("after=1600000000");
    }
  });

  it("stops at the page cap and returns what was found — does not error", async () => {
    const fullRunPage = Array.from({ length: 200 }, (_, i) => run(i));
    const pages = Array.from({ length: 11 }, () => fullRunPage);
    const client = mockPaginatedClient(pages);
    const result = await fetchFilteredActivities(client, 5, "Ride");
    expect(result).toHaveLength(0);
    expect((client.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("stops early when limit is satisfied mid-page", async () => {
    const client = mockPaginatedClient([[ride(1), ride(2), ride(3)]]);
    const result = await fetchFilteredActivities(client, 2, "Ride");
    expect(result).toHaveLength(2);
    expect((client.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool integration tests (full MCP Client ↔ Server path via InMemoryTransport)
// ---------------------------------------------------------------------------

describe("get_athlete_profile", () => {
  it("returns the athlete object from /athlete", async () => {
    const h = await createHarness([["/athlete", { id: 1, firstname: "Ada", lastname: "L" }]]);
    afterEach(() => h.close());
    const data = parseResult(await h.mcpClient.callTool({ name: "get_athlete_profile", arguments: {} })) as { id: number };
    expect(data.id).toBe(1);
    expect(h.mockFetch).toHaveBeenCalledWith("/athlete");
  });
});

describe("get_recent_activities", () => {
  it("unfiltered: returns {activities, count, next_after, next_before}", async () => {
    const activities = [
      { id: 1, start_date: "2025-04-10T08:00:00Z" },
      { id: 2, start_date: "2025-04-08T08:00:00Z" },
    ];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_recent_activities", arguments: { limit: 2 } })
    ) as { activities: { id: number }[]; count: number; next_after: number; next_before: number };
    expect(data.activities).toHaveLength(2);
    expect(data.count).toBe(2);
    // Newest activity in the list is the next_after seed for "newer than this"
    expect(data.next_after).toBe(Math.floor(new Date("2025-04-10T08:00:00Z").getTime() / 1000));
    expect(data.next_before).toBe(Math.floor(new Date("2025-04-08T08:00:00Z").getTime() / 1000));
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("per_page=2");
  });

  it("type-filtered: paginates until enough matches are found", async () => {
    // First full page of runs, second page with a ride
    const runPage = Array.from({ length: 200 }, () => ({ type: "Run", sport_type: "Run" }));
    let callCount = 0;
    const h = await createHarness([]);
    afterEach(() => h.close());
    h.mockFetch.mockImplementation(async () => {
      const data =
        callCount++ === 0
          ? runPage
          : [{ id: 77, type: "Ride", sport_type: "Ride", start_date: "2025-04-01T07:00:00Z" }];
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_recent_activities", arguments: { limit: 1, activity_type: "Ride" } })
    ) as { activities: { id: number }[] };
    expect(data.activities).toHaveLength(1);
    expect(data.activities[0].id).toBe(77);
    expect(h.mockFetch.mock.calls.length).toBe(2);
  });

  it("fields filter restricts each activity to the whitelist", async () => {
    const activities = [
      {
        id: 1,
        name: "Morning Run",
        start_date: "2025-04-10T08:00:00Z",
        distance: 5000,
        moving_time: 1500,
        average_heartrate: 145,
        kudos_count: 7,
        comment_count: 0,
        photo_count: 0,
      },
    ];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_recent_activities",
        arguments: {
          limit: 1,
          fields: ["id", "name", "distance", "moving_time", "average_heartrate"],
        },
      })
    ) as { activities: Array<Record<string, unknown>> };
    expect(Object.keys(data.activities[0]).sort()).toEqual([
      "average_heartrate",
      "distance",
      "id",
      "moving_time",
      "name",
    ]);
    // Excluded fields really are gone (not just undefined)
    expect(data.activities[0]).not.toHaveProperty("kudos_count");
    expect(data.activities[0]).not.toHaveProperty("start_date");
  });

  it("returns null cursors when no activities matched", async () => {
    const h = await createHarness([["/athlete/activities", []]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_recent_activities", arguments: { limit: 5 } })
    ) as { count: number; next_after: number | null; next_before: number | null };
    expect(data.count).toBe(0);
    expect(data.next_after).toBeNull();
    expect(data.next_before).toBeNull();
  });
});

describe("get_activity_details", () => {
  it("fetches /activities/:id and returns the response", async () => {
    const h = await createHarness([["/activities/123", { id: 123, name: "Morning Run" }]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_details", arguments: { activity_id: 123 } })
    ) as { id: number; name: string };
    expect(data.id).toBe(123);
    expect(data.name).toBe("Morning Run");
  });

  it("returns STRAVA_NOT_FOUND when the Strava fetch returns 404", async () => {
    const h = await createHarness([["/activities/999", { message: "Record Not Found" }, 404]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_details", arguments: { activity_id: 999 } })
    ) as { error: { code: string } };
    expect(data.error.code).toBe("STRAVA_NOT_FOUND");
  });
});

describe("get_activity_zones", () => {
  it("fetches /activities/:id/zones", async () => {
    const zones = [{ type: "heartrate", sensor_based: true, points: 10 }];
    const h = await createHarness([["/activities/5/zones", zones]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_zones", arguments: { activity_id: 5 } })
    ) as unknown[];
    expect(data).toHaveLength(1);
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("/activities/5/zones");
  });

  it("includes seconds_in_zone summed from distribution_buckets", async () => {
    const zones = [
      {
        type: "heartrate",
        sensor_based: true,
        points: 10,
        distribution_buckets: [
          { min: 0, max: 100, time: 60 },
          { min: 100, max: 130, time: 300 },
          { min: 130, max: 150, time: 1200 },
          { min: 150, max: 170, time: 240 },
        ],
      },
      {
        type: "power",
        distribution_buckets: [
          { min: 0, max: 100, time: 90 },
          { min: 100, max: 200, time: 600 },
        ],
      },
    ];
    const h = await createHarness([["/activities/5/zones", zones]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_zones", arguments: { activity_id: 5 } })
    ) as Array<{ seconds_in_zone: number[] }>;
    expect(data[0].seconds_in_zone).toEqual([60, 300, 1200, 240]);
    expect(data[1].seconds_in_zone).toEqual([90, 600]);
    // Sums match the moving-time-style total per zone block
    expect(data[0].seconds_in_zone.reduce((a, b) => a + b, 0)).toBe(1800);
  });

  it("handles zone blocks with missing distribution_buckets gracefully", async () => {
    const zones = [{ type: "heartrate", sensor_based: false }];
    const h = await createHarness([["/activities/9/zones", zones]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_zones", arguments: { activity_id: 9 } })
    ) as Array<{ seconds_in_zone: number[] }>;
    expect(data[0].seconds_in_zone).toEqual([]);
  });
});

describe("get_athlete_zones", () => {
  it("fetches /athlete/zones", async () => {
    const h = await createHarness([["/athlete/zones", { heart_rate: { zones: [] } }]]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({ name: "get_athlete_zones", arguments: {} });
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toBe("/athlete/zones");
  });
});

describe("get_athlete_stats", () => {
  it("uses the athlete id from /athlete for the stats URL", async () => {
    const h = await createHarness([
      ["/athlete", { id: 42 }],
      ["/athletes/42/stats", { recent_run_totals: { count: 5 } }],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_athlete_stats", arguments: {} })
    ) as { recent_run_totals: { count: number } };
    expect(data.recent_run_totals.count).toBe(5);
    const paths = (h.mockFetch.mock.calls as [string][]).map(([p]) => p);
    expect(paths[0]).toBe("/athlete");
    expect(paths[1]).toContain("/athletes/42/stats");
  });

  it("returns STRAVA_AUTH when the athlete fetch returns 401", async () => {
    const h = await createHarness([["/athlete", null, 401]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_athlete_stats", arguments: {} })
    ) as { error: { code: string } };
    expect(data.error.code).toBe("STRAVA_AUTH");
  });
});

describe("get_segment_details", () => {
  it("fetches /segments/:id", async () => {
    const h = await createHarness([["/segments/88", { id: 88, name: "Hard Climb" }]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_segment_details", arguments: { segment_id: 88 } })
    ) as { id: number };
    expect(data.id).toBe(88);
  });
});

describe("list_my_segment_efforts", () => {
  it("passes date filters through to the Strava URL", async () => {
    const h = await createHarness([["/segments/77/all_efforts", [{ id: 1 }]]]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({
      name: "list_my_segment_efforts",
      arguments: { segment_id: 77, start_date_local: "2025-01-01T00:00:00Z", end_date_local: "2025-06-01T00:00:00Z" },
    });
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("start_date_local=2025-01-01T00%3A00%3A00Z");
    expect(path).toContain("end_date_local=2025-06-01T00%3A00%3A00Z");
  });

  it("works without date filters", async () => {
    const h = await createHarness([["/segments/77/all_efforts", [{ id: 1 }, { id: 2 }]]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "list_my_segment_efforts", arguments: { segment_id: 77 } })
    ) as unknown[];
    expect(data).toHaveLength(2);
  });
});

describe("get_segment_effort_streams", () => {
  const streamData = [
    { type: "time", data: [0, 1, 2] },
    { type: "distance", data: [0.0, 5.1, 10.2] },
  ];

  it("reports which requested stream types are present vs missing", async () => {
    const h = await createHarness([["/segment_efforts/55/streams", streamData]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_segment_effort_streams",
        arguments: { effort_id: 55, stream_types: ["time", "distance", "altitude"] },
      })
    ) as { metadata: { stream_types_present: string[]; stream_types_missing: string[] }; data: Record<string, unknown> };
    expect(data.metadata.stream_types_present).toEqual(["time", "distance"]);
    expect(data.metadata.stream_types_missing).toEqual(["altitude"]);
  });

  it("uses default stream types when none specified", async () => {
    const h = await createHarness([["/segment_efforts/55/streams", streamData]]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({ name: "get_segment_effort_streams", arguments: { effort_id: 55 } });
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("time");
    expect(path).toContain("distance");
    expect(path).toContain("altitude");
    expect(path).toContain("latlng");
  });

  it("places stream arrays in the data field keyed by type", async () => {
    const h = await createHarness([["/segment_efforts/55/streams", streamData]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_segment_effort_streams", arguments: { effort_id: 55 } })
    ) as { data: { time?: number[]; distance?: number[] } };
    expect(data.data.time).toEqual([0, 1, 2]);
    expect(data.data.distance).toEqual([0.0, 5.1, 10.2]);
  });
});

describe("explore_segments", () => {
  it("passes the bounds param to Strava", async () => {
    const h = await createHarness([["/segments/explore", { segments: [] }]]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({
      name: "explore_segments",
      arguments: { bounds: "37.821,-122.505,37.842,-122.465" },
    });
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("bounds=37.821");
  });

  it("includes activity_type when specified", async () => {
    const h = await createHarness([["/segments/explore", { segments: [] }]]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({
      name: "explore_segments",
      arguments: { bounds: "0,0,1,1", activity_type: "running" },
    });
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("activity_type=running");
  });
});

describe("list_routes", () => {
  it("uses the athlete id from /athlete in the routes URL", async () => {
    const h = await createHarness([
      ["/athlete", { id: 99 }],
      ["/athletes/99/routes", [{ id: 1 }]],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "list_routes", arguments: { page: 1, per_page: 10 } })
    ) as unknown[];
    expect(data).toHaveLength(1);
    const paths = (h.mockFetch.mock.calls as [string][]).map(([p]) => p);
    expect(paths[1]).toContain("/athletes/99/routes");
  });

  it("passes page and per_page params through", async () => {
    const h = await createHarness([
      ["/athlete", { id: 99 }],
      ["/athletes/99/routes", []],
    ]);
    afterEach(() => h.close());
    await h.mcpClient.callTool({ name: "list_routes", arguments: { page: 3, per_page: 50 } });
    const [path] = h.mockFetch.mock.calls[1] as [string];
    expect(path).toContain("page=3");
    expect(path).toContain("per_page=50");
  });
});

describe("get_route_details", () => {
  it("returns both route data and stream data on success", async () => {
    const h = await createHarness([
      ["/routes/10", { id: 10, name: "Sunday Loop" }],
      ["/routes/10/streams", [{ type: "latlng", data: [] }]],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_route_details", arguments: { route_id: 10 } })
    ) as { route: { id: number }; streams: unknown };
    expect(data.route.id).toBe(10);
    expect(data.streams).not.toBeNull();
  });

  it("returns route with null streams when the streams fetch returns non-ok", async () => {
    const h = await createHarness([
      ["/routes/10", { id: 10 }],
      ["/routes/10/streams", null, 403],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_route_details", arguments: { route_id: 10 } })
    ) as { route: { id: number }; streams: unknown };
    expect(data.route.id).toBe(10);
    expect(data.streams).toBeNull();
  });

  it("returns STRAVA_NOT_FOUND when the route fetch returns 404", async () => {
    const h = await createHarness([
      ["/routes/10", null, 404],
      ["/routes/10/streams", null, 404],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_route_details", arguments: { route_id: 10 } })
    ) as { error: { code: string } };
    expect(data.error.code).toBe("STRAVA_NOT_FOUND");
  });
});

describe("list_gear", () => {
  it("extracts bikes and shoes from the athlete response", async () => {
    const h = await createHarness([[
      "/athlete",
      { bikes: [{ id: "b1", name: "Trek" }], shoes: [{ id: "g1", name: "Nike" }] },
    ]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "list_gear", arguments: {} })
    ) as { bikes: unknown[]; shoes: unknown[] };
    expect(data.bikes).toHaveLength(1);
    expect(data.shoes).toHaveLength(1);
  });

  it("returns empty arrays when the athlete has no gear fields", async () => {
    const h = await createHarness([["/athlete", { id: 1 }]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "list_gear", arguments: {} })
    ) as { bikes: unknown[]; shoes: unknown[] };
    expect(data.bikes).toEqual([]);
    expect(data.shoes).toEqual([]);
  });
});

describe("get_activity_laps", () => {
  it("fetches /activities/:id/laps", async () => {
    const laps = [{ id: 1, lap_index: 1 }, { id: 2, lap_index: 2 }];
    const h = await createHarness([["/activities/321/laps", laps]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_laps", arguments: { activity_id: 321 } })
    ) as unknown[];
    expect(data).toHaveLength(2);
    const [path] = h.mockFetch.mock.calls[0] as [string];
    expect(path).toContain("/activities/321/laps");
  });
});

describe("get_athlete_summary", () => {
  it("aggregates monthly buckets with weighted avg HR and pace", async () => {
    // Three activities: two in Apr 2025, one in May 2025.
    const activities = [
      { id: 1, sport_type: "Run", start_date: "2025-04-05T08:00:00Z", start_date_local: "2025-04-05T08:00:00Z", distance: 5000, moving_time: 1500, elapsed_time: 1600, total_elevation_gain: 30, average_heartrate: 150 },
      { id: 2, sport_type: "Run", start_date: "2025-04-20T08:00:00Z", start_date_local: "2025-04-20T08:00:00Z", distance: 10000, moving_time: 3000, elapsed_time: 3100, total_elevation_gain: 80, average_heartrate: 155 },
      { id: 3, sport_type: "Run", start_date: "2025-05-02T08:00:00Z", start_date_local: "2025-05-02T08:00:00Z", distance: 3000, moving_time: 900, elapsed_time: 920, total_elevation_gain: 10 },
    ];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_athlete_summary",
        arguments: { granularity: "month" },
      })
    ) as {
      buckets: Array<{
        period_start: string;
        count: number;
        total_distance_m: number;
        avg_heartrate: number | null;
        avg_pace_per_km: number | null;
      }>;
      activity_count: number;
    };
    expect(data.activity_count).toBe(3);
    expect(data.buckets).toHaveLength(2);
    const apr = data.buckets.find((b) => b.period_start === "2025-04-01")!;
    expect(apr.count).toBe(2);
    expect(apr.total_distance_m).toBe(15000);
    // Weighted avg HR: (150*1500 + 155*3000) / 4500 = 153.33...
    expect(apr.avg_heartrate).toBeCloseTo((150 * 1500 + 155 * 3000) / 4500, 4);
    // Avg pace: 4500 / 15 = 300 sec/km
    expect(apr.avg_pace_per_km).toBeCloseTo(300, 4);
    const may = data.buckets.find((b) => b.period_start === "2025-05-01")!;
    expect(may.count).toBe(1);
    // No HR data on the May activity → null avg
    expect(may.avg_heartrate).toBeNull();
  });

  it("filters by activity_type", async () => {
    const activities = [
      { id: 1, sport_type: "Run", start_date: "2025-04-05T08:00:00Z", distance: 5000, moving_time: 1500 },
      { id: 2, sport_type: "Ride", start_date: "2025-04-06T08:00:00Z", distance: 30000, moving_time: 3600 },
    ];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_athlete_summary",
        arguments: { activity_type: "Run", granularity: "month" },
      })
    ) as { activity_count: number; buckets: Array<{ count: number }> };
    expect(data.activity_count).toBe(1);
    expect(data.buckets[0].count).toBe(1);
  });

  it("supports week granularity (Monday-start ISO weeks)", async () => {
    // Monday 2025-04-07 → Sunday 2025-04-13 is one ISO week.
    const activities = [
      { id: 1, sport_type: "Run", start_date: "2025-04-08T08:00:00Z", distance: 5000, moving_time: 1500 },
      { id: 2, sport_type: "Run", start_date: "2025-04-13T08:00:00Z", distance: 7000, moving_time: 2000 },
    ];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_athlete_summary",
        arguments: { granularity: "week" },
      })
    ) as { buckets: Array<{ period_start: string; period_end: string; count: number }> };
    expect(data.buckets).toHaveLength(1);
    expect(data.buckets[0].period_start).toBe("2025-04-07");
    expect(data.buckets[0].period_end).toBe("2025-04-13");
    expect(data.buckets[0].count).toBe(2);
  });
});

describe("get_athlete_best_efforts", () => {
  it("scans Run activities and returns matching best_efforts sorted fastest-first", async () => {
    const listPage = [
      { id: 1, type: "Run", sport_type: "Run", start_date: "2025-04-10T08:00:00Z" },
      { id: 2, type: "Ride", sport_type: "Ride", start_date: "2025-04-08T08:00:00Z" },
      { id: 3, type: "Run", sport_type: "Run", start_date: "2025-04-05T08:00:00Z" },
    ];
    const h = await createHarness([
      ["/athlete/activities", listPage],
      ["/activities/1", {
        id: 1,
        name: "Tuesday Tempo",
        sport_type: "Run",
        start_date_local: "2025-04-10T08:00:00Z",
        best_efforts: [
          { name: "5k", distance: 5000, moving_time: 1240, elapsed_time: 1245, pr_rank: null, is_kom: false, id: 11 },
        ],
      }],
      ["/activities/3", {
        id: 3,
        name: "Friday Fast 5",
        sport_type: "Run",
        start_date_local: "2025-04-05T08:00:00Z",
        best_efforts: [
          { name: "5k", distance: 5000, moving_time: 1180, elapsed_time: 1185, pr_rank: 1, is_kom: false, id: 33 },
          { name: "10k", distance: 10000, moving_time: 2500 },
        ],
      }],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_athlete_best_efforts",
        arguments: { distance: "5k" },
      })
    ) as {
      results: Array<{ activity_id: number; moving_time: number; pr_rank: number | null }>;
      activities_scanned: number;
      activities_with_best_efforts: number;
    };
    expect(data.activities_scanned).toBe(2); // Two Runs (the Ride was filtered out)
    expect(data.activities_with_best_efforts).toBe(2);
    expect(data.results).toHaveLength(2);
    // Fastest first
    expect(data.results[0].moving_time).toBe(1180);
    expect(data.results[0].pr_rank).toBe(1);
    expect(data.results[1].moving_time).toBe(1240);
  });

  it("returns an empty result list when no activities have a matching distance", async () => {
    const listPage = [
      { id: 1, type: "Run", sport_type: "Run", start_date: "2025-04-10T08:00:00Z" },
    ];
    const h = await createHarness([
      ["/athlete/activities", listPage],
      ["/activities/1", { id: 1, sport_type: "Run", best_efforts: [{ name: "10k", distance: 10000, moving_time: 2500 }] }],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({
        name: "get_athlete_best_efforts",
        arguments: { distance: "marathon" },
      })
    ) as { results: unknown[] };
    expect(data.results).toEqual([]);
  });
});

describe("get_activity_best_efforts", () => {
  it("returns Strava's best_efforts list for a Run", async () => {
    const summary = {
      id: 1,
      sport_type: "Run",
      start_date_local: "2025-04-01T08:00:00Z",
      best_efforts: [
        { name: "5k", distance: 5000, moving_time: 1200, pr_rank: 2 },
        { name: "10k", distance: 10000, moving_time: 2500, pr_rank: null },
      ],
    };
    const h = await createHarness([["/activities/1", summary]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_best_efforts", arguments: { activity_id: 1 } })
    ) as { sport_type: string; best_efforts: Array<{ name: string }> };
    expect(data.sport_type).toBe("Run");
    expect(data.best_efforts).toHaveLength(2);
    expect(data.best_efforts[0].name).toBe("5k");
  });

  it("returns an empty list for activities without best_efforts (e.g. Rides)", async () => {
    const summary = { id: 2, sport_type: "Ride", start_date_local: "2025-04-02T07:00:00Z" };
    const h = await createHarness([["/activities/2", summary]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_activity_best_efforts", arguments: { activity_id: 2 } })
    ) as { best_efforts: unknown[] };
    expect(data.best_efforts).toEqual([]);
  });
});

describe("health (D2)", () => {
  it("returns expected shape on a fresh deploy (no cached athlete, no rate-limit history)", async () => {
    const h = await createHarness([
      ["/athlete", { id: 42, username: "ada", firstname: "Ada", lastname: "L" }],
    ]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "health", arguments: {} })
    ) as {
      worker_version: string;
      athlete: { id: number; username: string };
      rate_limit: unknown;
      cache: { activity_summaries: number; stream_entries: number; lap_entries: number };
    };
    expect(typeof data.worker_version).toBe("string");
    expect(data.athlete.id).toBe(42);
    expect(data.athlete.username).toBe("ada");
    // Fresh deploy: nothing stored yet
    expect(data.rate_limit).toBeNull();
    expect(data.cache).toEqual({ activity_summaries: 0, stream_entries: 0, lap_entries: 0 });
  });

  it("surfaces the latest rate-limit snapshot when one is cached", async () => {
    const tokenCache = mockKv();
    await tokenCache.put(
      "rate_limit:latest",
      JSON.stringify({
        shortTermLimit: 100,
        shortTermUsage: 7,
        dailyLimit: 1000,
        dailyUsage: 88,
        updated_at: 1700000000,
      })
    );
    const h = await createHarness(
      [["/athlete", { id: 1, username: "u" }]],
      { tokenCache }
    );
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "health", arguments: {} })
    ) as { rate_limit: { shortTermUsage: number; dailyUsage: number } };
    expect(data.rate_limit.shortTermUsage).toBe(7);
    expect(data.rate_limit.dailyUsage).toBe(88);
  });

  it("counts cache entries by prefix", async () => {
    const streamCache = mockKv();
    await streamCache.put("streams:1:all", "{}");
    await streamCache.put("streams:2:all", "{}");
    await streamCache.put("activity:1:summary", "{}");
    await streamCache.put("laps:1", "[]");
    await streamCache.put("laps:2", "[]");
    await streamCache.put("laps:3", "[]");
    const h = await createHarness(
      [["/athlete", { id: 1, username: "u" }]],
      { streamCache }
    );
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "health", arguments: {} })
    ) as { cache: { activity_summaries: number; stream_entries: number; lap_entries: number } };
    expect(data.cache).toEqual({ activity_summaries: 1, stream_entries: 2, lap_entries: 3 });
  });
});
