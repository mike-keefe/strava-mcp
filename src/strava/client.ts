import type { Env } from "../types.js";
import type { StravaTokenResponse, StravaRateLimitInfo } from "./types.js";

// Strava access tokens expire in 6 hours (21600s). Refresh 5 minutes early.
export const TOKEN_EXPIRY_BUFFER_SECONDS = 300;

export class StravaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean = false,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "StravaApiError";
  }
}

export class StravaClient {
  public lastRateLimitInfo: StravaRateLimitInfo | null = null;

  constructor(private readonly env: Env) {}

  // Stub: implemented in issue #2
  async getAccessToken(): Promise<string> {
    void this.env;
    throw new Error("Not implemented — see issue #2");
  }

  // Stub: implemented in issue #2
  async fetch(_path: string, _options?: RequestInit): Promise<Response> {
    throw new Error("Not implemented — see issue #2");
  }
}

export type { StravaTokenResponse };
