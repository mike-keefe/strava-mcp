import { describe, it, expect } from "vitest";
import { errorResult, handleStravaError } from "../src/strava/errors.js";
import { StravaApiError } from "../src/strava/client.js";

describe("errorResult", () => {
  it("returns correct shape for a non-retryable error", () => {
    const result = errorResult("STRAVA_NOT_FOUND", "Activity not found");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      error: { code: "STRAVA_NOT_FOUND", message: "Activity not found", retryable: false },
    });
  });

  it("includes retry_after_seconds when provided", () => {
    const result = errorResult("STRAVA_RATE_LIMIT", "Rate limited", true, 45);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.retry_after_seconds).toBe(45);
    expect(parsed.error.retryable).toBe(true);
  });

  it("omits retry_after_seconds when not provided", () => {
    const result = errorResult("INTERNAL", "Oops");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).not.toHaveProperty("retry_after_seconds");
  });
});

describe("handleStravaError", () => {
  it("maps 429 to STRAVA_RATE_LIMIT with retryable=true", () => {
    const err = new StravaApiError(429, "Rate limit exceeded", true, 30);
    const result = handleStravaError(err);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("STRAVA_RATE_LIMIT");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.retry_after_seconds).toBe(30);
  });

  it("maps 401 to STRAVA_AUTH with retryable=false", () => {
    const err = new StravaApiError(401, "Unauthorized");
    const parsed = JSON.parse(handleStravaError(err).content[0].text);
    expect(parsed.error.code).toBe("STRAVA_AUTH");
    expect(parsed.error.retryable).toBe(false);
  });

  it("maps 404 to STRAVA_NOT_FOUND", () => {
    const err = new StravaApiError(404, "Not found");
    const parsed = JSON.parse(handleStravaError(err).content[0].text);
    expect(parsed.error.code).toBe("STRAVA_NOT_FOUND");
  });

  it("maps 503 to STRAVA_SERVER_ERROR with retryable=true", () => {
    const err = new StravaApiError(503, "Service unavailable", true);
    const parsed = JSON.parse(handleStravaError(err).content[0].text);
    expect(parsed.error.code).toBe("STRAVA_SERVER_ERROR");
    expect(parsed.error.retryable).toBe(true);
  });

  it("maps unknown errors to INTERNAL", () => {
    const parsed = JSON.parse(handleStravaError(new Error("boom")).content[0].text);
    expect(parsed.error.code).toBe("INTERNAL");
  });

  it("maps non-Error throws to INTERNAL", () => {
    const parsed = JSON.parse(handleStravaError("string error").content[0].text);
    expect(parsed.error.code).toBe("INTERNAL");
  });
});
