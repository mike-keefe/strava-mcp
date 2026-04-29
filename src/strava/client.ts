import type { Env } from "../types.js";
import { stravaTokenCacheKey } from "../oauth.js";
import type { StravaRateLimitInfo } from "./types.js";

const BASE_URL = "https://www.strava.com/api/v3";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const STATIC_TOKEN_KV_KEY = "strava:access_token";
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const ERROR_BODY_PREVIEW_CHARS = 500;

interface CachedToken {
  access_token: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface OAuthTokenRecord {
  clientId: string;
  issuedAt: number;
  stravaRefreshToken?: string;
}

export class StravaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean = false,
    public readonly retryAfterSeconds?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "StravaApiError";
  }
}

export class StravaClient {
  public lastRateLimitInfo: StravaRateLimitInfo | null = null;

  constructor(
    private readonly env: Env,
    // When set, tokens are looked up per-user from TOKEN_CACHE rather than
    // using the static STRAVA_REFRESH_TOKEN secret.
    private readonly userOAuthToken?: string
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.userOAuthToken) {
      return this.getUserAccessToken(this.userOAuthToken);
    }
    return this.getStaticAccessToken();
  }

  // ---------------------------------------------------------------------------
  // Static (single-user) token path — uses env.STRAVA_REFRESH_TOKEN
  // ---------------------------------------------------------------------------

  private async getStaticAccessToken(): Promise<string> {
    const cached = await this.env.TOKEN_CACHE.get(STATIC_TOKEN_KV_KEY);
    if (cached) {
      const { access_token, expires_at } = JSON.parse(cached) as CachedToken;
      if (Math.floor(Date.now() / 1000) < expires_at - TOKEN_EXPIRY_BUFFER_SECONDS) {
        return access_token;
      }
    }

    const data = await this.refreshStravaToken(this.env.STRAVA_REFRESH_TOKEN);

    const ttlSeconds =
      data.expires_at - Math.floor(Date.now() / 1000) - TOKEN_EXPIRY_BUFFER_SECONDS;
    if (ttlSeconds > 0) {
      await this.env.TOKEN_CACHE.put(
        STATIC_TOKEN_KV_KEY,
        JSON.stringify({ access_token: data.access_token, expires_at: data.expires_at }),
        { expirationTtl: ttlSeconds }
      );
    }

    return data.access_token;
  }

  // ---------------------------------------------------------------------------
  // Per-user token path — tokens stored in TOKEN_CACHE keyed by OAuth token
  // ---------------------------------------------------------------------------

  private async getUserAccessToken(oauthToken: string): Promise<string> {
    const cacheKey = stravaTokenCacheKey(oauthToken);

    const cached = await this.env.TOKEN_CACHE.get(cacheKey);
    if (cached) {
      const { access_token, expires_at } = JSON.parse(cached) as CachedToken;
      if (Math.floor(Date.now() / 1000) < expires_at - TOKEN_EXPIRY_BUFFER_SECONDS) {
        return access_token;
      }
    }

    const recordRaw = await this.env.TOKEN_CACHE.get(`oauth:token:${oauthToken}`);
    if (!recordRaw) {
      throw new StravaApiError(401, "OAuth token not found — please re-authorize");
    }
    const record = JSON.parse(recordRaw) as OAuthTokenRecord;
    if (!record.stravaRefreshToken) {
      throw new StravaApiError(401, "No Strava account linked to this token — please re-authorize");
    }

    const data = await this.refreshStravaToken(record.stravaRefreshToken);

    const ttlSeconds =
      data.expires_at - Math.floor(Date.now() / 1000) - TOKEN_EXPIRY_BUFFER_SECONDS;
    if (ttlSeconds > 0) {
      await this.env.TOKEN_CACHE.put(
        cacheKey,
        JSON.stringify({ access_token: data.access_token, expires_at: data.expires_at }),
        { expirationTtl: ttlSeconds }
      );
    }

    // Update the token record if Strava rotated the refresh token
    if (data.refresh_token !== record.stravaRefreshToken) {
      await this.env.TOKEN_CACHE.put(
        `oauth:token:${oauthToken}`,
        JSON.stringify({ ...record, stravaRefreshToken: data.refresh_token }),
        { expirationTtl: TOKEN_TTL_SECONDS }
      );
    }

    return data.access_token;
  }

  private async refreshStravaToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.env.STRAVA_CLIENT_ID,
        client_secret: this.env.STRAVA_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const { body } = await readErrorBody(response);
      throw new StravaApiError(
        response.status,
        `Token refresh failed (${response.status}): ${formatBodyForMessage(body)}`,
        false,
        undefined,
        body
      );
    }

    return (await response.json()) as TokenResponse;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

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
      // Clear the cached access token so the next attempt does a fresh refresh
      const cacheKey = this.userOAuthToken
        ? stravaTokenCacheKey(this.userOAuthToken)
        : STATIC_TOKEN_KV_KEY;
      await this.env.TOKEN_CACHE.delete(cacheKey);
      const freshToken = await this.getAccessToken();
      return this.doFetch(path, freshToken, options, true);
    }

    if (!response.ok) {
      const { body } = await readErrorBody(response);

      if (response.status === 429) {
        const resetHeader = response.headers.get("X-RateLimit-Reset");
        const retryAfterSeconds = resetHeader
          ? Math.max(1, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000))
          : 60;
        throw new StravaApiError(
          429,
          `Strava rate limit exceeded: ${formatBodyForMessage(body)}`,
          true,
          retryAfterSeconds,
          body
        );
      }

      const retryable = response.status >= 500;
      throw new StravaApiError(
        response.status,
        `Strava API error (${response.status}): ${formatBodyForMessage(body)}`,
        retryable,
        undefined,
        body
      );
    }

    return response;
  }
}

// Reads response.text() once and attempts to parse as JSON. Returns the parsed
// body if JSON parsing succeeds, otherwise the raw text. A response body can
// only be read once, so callers must not read again after this.
async function readErrorBody(response: Response): Promise<{ body: unknown }> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { body: null };
  }
  if (!raw) return { body: null };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { body: raw };
  }
}

function formatBodyForMessage(body: unknown): string {
  if (body === null || body === undefined) return "(empty body)";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= ERROR_BODY_PREVIEW_CHARS) return text;
  return text.slice(0, ERROR_BODY_PREVIEW_CHARS) + "…";
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
