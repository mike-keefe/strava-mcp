import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger, redact, queryKeys } from "../src/strava/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("redact", () => {
  it("redacts sensitive keys recursively", () => {
    const out = redact({
      authorization: "Bearer abc",
      nested: { client_secret: "shh", access_token: "x" },
      ok: "fine",
    }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).client_secret).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect(out.ok).toBe("fine");
  });

  it("scrubs Bearer tokens that appear as values", () => {
    const out = redact({ headers: { Authorization: "Bearer my-token-here" } }) as {
      headers: Record<string, string>;
    };
    // Whole field redacted by key match
    expect(out.headers.Authorization).toBe("[REDACTED]");
  });

  it("scrubs Bearer tokens in non-sensitive keys too", () => {
    expect(redact("Bearer leaked")).toBe("Bearer [REDACTED]");
  });

  it("handles arrays and primitives", () => {
    expect(redact([1, 2, "three"])).toEqual([1, 2, "three"]);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(42)).toBe(42);
  });
});

describe("queryKeys", () => {
  it("extracts only keys, not values", () => {
    expect(queryKeys("/activities/1/streams?keys=time,heartrate&resolution=all")).toEqual([
      "keys",
      "resolution",
    ]);
  });

  it("returns empty for paths without query", () => {
    expect(queryKeys("/athlete")).toEqual([]);
  });
});

describe("Logger", () => {
  it("emits single-line JSON at the configured level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("info");
    log.info("strava.response", { status: 200, duration_ms: 42 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "info", event: "strava.response", status: 200, duration_ms: 42 });
  });

  it("suppresses debug logs at info level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("info");
    log.debug("strava.request", { path: "/athlete" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits debug logs when level is debug", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("debug");
    log.debug("strava.request", { path: "/athlete" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive fields before serialising", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger("info");
    log.info("strava.request", {
      headers: { Authorization: "Bearer secret-value" },
      body: { client_secret: "very-secret" },
    });
    const line = spy.mock.calls[0][0] as string;
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("very-secret");
  });

  it("falls back to info when LOG_LEVEL is missing or invalid", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger(undefined);
    log.info("test", {});
    log.debug("test", {}); // suppressed
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
