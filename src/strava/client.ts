import type { Env } from "../types.js";
import type { StravaRateLimitInfo } from "./types.js";

const BASE_URL = "https://www.strava.com/api/v3";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const TOKEN_KV_KEY = "strava:access_token";
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;

interface CachedToken {
  access_token: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

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

  async getAccessToken(): Promise<string> {
    const cached = await this.env.TOKEN_CACHE.get(TOKEN_KV_KEY);
    if (cached) {
      const { access_token, expires_at } = JSON.parse(cached) as CachedToken;
      if (Math.floor(Date.now() / 1000) < expires_at - TOKEN_EXPIRY_BUFFER_SECONDS) {
        return access_token;
      }
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.env.STRAVA_CLIENT_ID,
        client_secret: this.env.STRAVA_CLIENT_SECRET,
        refresh_token: this.env.STRAVA_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new StravaApiError(
        response.status,
        `Token refresh failed (${response.status}): ${response.statusText}`
      );
    }

    const data = (await response.json()) as TokenResponse;
    const ttlSeconds =
      data.expires_at - Math.floor(Date.now() / 1000) - TOKEN_EXPIRY_BUFFER_SECONDS;

    if (ttlSeconds > 0) {
      await this.env.TOKEN_CACHE.put(
        TOKEN_KV_KEY,
        JSON.stringify({ access_token: data.access_token, expires_at: data.expires_at }),
        { expirationTtl: ttlSeconds }
      );
    }

    return data.access_token;
  }

  async fetch(path: string, options?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    return this.doFetch(path, token, options, false);
  }

  private async doFetch(
    path: string,
    token: string,
    options: RequestInit | undefined,
    isRetry: boolean
  ): Promise<Response> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${token}`,
      },
    });

    this.lastRateLimitInfo = parseRateLimitHeaders(response.headers);

    if (response.status === 401 && !isRetry) {
      await this.env.TOKEN_CACHE.delete(TOKEN_KV_KEY);
      const freshToken = await this.getAccessToken();
      return this.doFetch(path, freshToken, options, true);
    }

    if (response.status === 429) {
      const resetHeader = response.headers.get("X-RateLimit-Reset");
      const retryAfterSeconds = resetHeader
        ? Math.max(1, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000))
        : 60;
      throw new StravaApiError(429, "Strava rate limit exceeded", true, retryAfterSeconds);
    }

    if (response.status >= 500) {
      throw new StravaApiError(
        response.status,
        `Strava server error (${response.status}): ${response.statusText}`,
        true
      );
    }

    return response;
  }
}

function parseRateLimitHeaders(headers: Headers): StravaRateLimitInfo | null {
  const limit = headers.get("X-RateLimit-Limit");
  const usage = headers.get("X-RateLimit-Usage");
  if (!limit || !usage) return null;
  const [shortTermLimit, dailyLimit] = limit.split(",").map(Number);
  const [shortTermUsage, dailyUsage] = usage.split(",").map(Number);
  if ([shortTermLimit, dailyLimit, shortTermUsage, dailyUsage].some(isNaN)) return null;
  return { shortTermLimit, shortTermUsage, dailyLimit, dailyUsage };
}
