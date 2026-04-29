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
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

interface Harness {
  mcpClient: Client;
  mockFetch: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

async function createHarness(routes: FetchRoute[]): Promise<Harness> {
  const stravaClient = mockStravaClient(routes);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerStravaTools(server, stravaClient as unknown as StravaClient, mockKv());

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
  it("unfiltered: fetches with per_page=limit and returns the result", async () => {
    const activities = [{ id: 1 }, { id: 2 }];
    const h = await createHarness([["/athlete/activities", activities]]);
    afterEach(() => h.close());
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_recent_activities", arguments: { limit: 2 } })
    ) as unknown[];
    expect(data).toHaveLength(2);
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
      const data = callCount++ === 0 ? runPage : [{ id: 77, type: "Ride", sport_type: "Ride" }];
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const data = parseResult(
      await h.mcpClient.callTool({ name: "get_recent_activities", arguments: { limit: 1, activity_type: "Ride" } })
    ) as { id: number }[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(77);
    expect(h.mockFetch.mock.calls.length).toBe(2);
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
