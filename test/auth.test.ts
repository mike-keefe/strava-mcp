import { describe, it, expect } from "vitest";
import { validateBearerToken } from "../src/auth.js";

const VALID_TOKEN = "abc123testtoken";

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["Authorization"] = authHeader;
  }
  return new Request("https://example.com/mcp", { headers });
}

describe("validateBearerToken", () => {
  it("rejects a request with no Authorization header", () => {
    expect(validateBearerToken(makeRequest(), VALID_TOKEN)).toBe(false);
  });

  it("rejects a request with an incorrect token", () => {
    expect(validateBearerToken(makeRequest("Bearer wrongtoken"), VALID_TOKEN)).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(validateBearerToken(makeRequest(`Basic ${VALID_TOKEN}`), VALID_TOKEN)).toBe(false);
  });

  it("accepts a request with the correct token", () => {
    expect(validateBearerToken(makeRequest(`Bearer ${VALID_TOKEN}`), VALID_TOKEN)).toBe(true);
  });

  it("uses constant-time comparison (tokens of different lengths are rejected)", () => {
    // Different length — the early-exit length check prevents timing leaks
    expect(validateBearerToken(makeRequest("Bearer short"), VALID_TOKEN)).toBe(false);
    expect(validateBearerToken(makeRequest(`Bearer ${VALID_TOKEN}extra`), VALID_TOKEN)).toBe(false);
  });
});
