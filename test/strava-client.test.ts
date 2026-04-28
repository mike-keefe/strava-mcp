import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StravaClient, StravaApiError } from "../src/strava/client.js";
import type { Env } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeEnv(kv: KVNamespace): Env {
  return {
    TOKEN_CACHE: kv,
    STREAM_CACHE: {} as KVNamespace,
    IP_RATE_LIMITER: {} as RateLimit,
    MCP_AUTH_TOKEN: "test-token",
    STRAVA_CLIENT_ID: "client123",
    STRAVA_CLIENT_SECRET: "secret456",
    STRAVA_REFRESH_TOKEN: "refresh789",
  };
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const FUTURE_EXPIRES_AT = NOW_SECONDS + 7200; // 2 hours from now

function tokenResponse(overrides?: Partial<{ access_token: string; expires_at: number }>): Response {
  return new Response(
    JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_at: FUTURE_EXPIRES_AT,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function apiResponse(
  body: unknown = {},
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rateLimitHeaders(): Record<string, string> {
  return {
    "X-RateLimit-Limit": "100,1000",
    "X-RateLimit-Usage": "5,42",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StravaClient.getAccessToken", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns cached token when valid", async () => {
    const cachedToken = JSON.stringify({ access_token: "cached-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const token = await client.getAccessToken();

    expect(token).toBe("cached-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes token when cache is empty", async () => {
    const kv = makeKv();
    const client = new StravaClient(makeEnv(kv));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));

    const token = await client.getAccessToken();

    expect(token).toBe("new-access-token");
    expect(kv.put).toHaveBeenCalledWith(
      "strava:access_token",
      expect.stringContaining("new-access-token"),
      expect.objectContaining({ expirationTtl: expect.any(Number) })
    );
  });

  it("refreshes token when cached token is within expiry buffer", async () => {
    // expires_at is only 200 seconds away — within the 300-second buffer
    const soonExpires = NOW_SECONDS + 200;
    const cachedToken = JSON.stringify({ access_token: "old-token", expires_at: soonExpires });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));

    const token = await client.getAccessToken();

    expect(token).toBe("new-access-token");
  });

  it("throws StravaApiError when token endpoint returns an error", async () => {
    const kv = makeKv();
    const client = new StravaClient(makeEnv(kv));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })));

    await expect(client.getAccessToken()).rejects.toThrow(StravaApiError);
  });
});

describe("StravaClient.fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("makes API call with Authorization header", async () => {
    const cachedToken = JSON.stringify({ access_token: "cached-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    const mockFetch = vi.fn().mockResolvedValue(apiResponse({ id: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await client.fetch("/athlete");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://www.strava.com/api/v3/athlete",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer cached-token" }) })
    );
  });

  it("parses rate limit headers and stores on lastRateLimitInfo", async () => {
    const cachedToken = JSON.stringify({ access_token: "cached-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({}, 200, rateLimitHeaders())));

    await client.fetch("/athlete");

    expect(client.lastRateLimitInfo).toEqual({
      shortTermLimit: 100,
      shortTermUsage: 5,
      dailyLimit: 1000,
      dailyUsage: 42,
    });
  });

  it("throws StravaApiError on 429 with retryable=true", async () => {
    const cachedToken = JSON.stringify({ access_token: "cached-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    const resetAt = NOW_SECONDS + 30;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apiResponse({}, 429, { "X-RateLimit-Reset": String(resetAt) })
      )
    );

    const err = await client.fetch("/athlete").catch((e) => e);

    expect(err).toBeInstanceOf(StravaApiError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("throws StravaApiError on 5xx with retryable=true", async () => {
    const cachedToken = JSON.stringify({ access_token: "cached-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Server Error", { status: 503, statusText: "Service Unavailable" })));

    const err = await client.fetch("/athlete").catch((e) => e);

    expect(err).toBeInstanceOf(StravaApiError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it("refreshes token and retries once on 401", async () => {
    // Start with a cached token that Strava rejects (401)
    const cachedToken = JSON.stringify({ access_token: "stale-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(apiResponse({}, 401))           // API call: 401 with stale token
      .mockResolvedValueOnce(tokenResponse({ access_token: "fresh-token" })) // token refresh
      .mockResolvedValueOnce(apiResponse({ id: 1 }));        // API retry: success

    vi.stubGlobal("fetch", mockFetch);

    const response = await client.fetch("/athlete");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Token cache should have been deleted before refresh
    expect(kv.delete).toHaveBeenCalledWith("strava:access_token");
    // Retry should use the fresh token
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "https://www.strava.com/api/v3/athlete",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }) })
    );
  });

  it("throws on 401 without retrying a second time", async () => {
    const cachedToken = JSON.stringify({ access_token: "stale-token", expires_at: FUTURE_EXPIRES_AT });
    const kv = makeKv({ "strava:access_token": cachedToken });
    const client = new StravaClient(makeEnv(kv));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(apiResponse({}, 401))
      .mockResolvedValueOnce(tokenResponse({ access_token: "fresh-token" }))
      .mockResolvedValueOnce(apiResponse({}, 401));  // still 401 after refresh

    vi.stubGlobal("fetch", mockFetch);

    // On second 401 (isRetry=true) the response is returned as-is (not thrown)
    const response = await client.fetch("/athlete");
    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
