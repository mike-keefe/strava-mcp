import { StravaApiError } from "./client.js";

// Throws StravaApiError so handleStravaError can map the status to a known code.
export function assertOk(res: Response): void {
  if (!res.ok) {
    throw new StravaApiError(res.status, res.statusText || `HTTP ${res.status}`);
  }
}

export type McpErrorCode =
  | "STRAVA_RATE_LIMIT"
  | "STRAVA_AUTH"
  | "STRAVA_NOT_FOUND"
  | "STRAVA_SERVER_ERROR"
  | "INVALID_PARAMS"
  | "INTERNAL";

export interface McpError {
  error: {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    retry_after_seconds?: number;
  };
}

export type McpToolResult = { content: [{ type: "text"; text: string }] };

export function errorResult(
  code: McpErrorCode,
  message: string,
  retryable = false,
  retryAfterSeconds?: number
): McpToolResult {
  const err: McpError = {
    error: { code, message, retryable, ...(retryAfterSeconds !== undefined && { retry_after_seconds: retryAfterSeconds }) },
  };
  return { content: [{ type: "text", text: JSON.stringify(err) }] };
}

export function handleStravaError(err: unknown): McpToolResult {
  if (err instanceof StravaApiError) {
    if (err.status === 429) {
      return errorResult("STRAVA_RATE_LIMIT", err.message, true, err.retryAfterSeconds);
    }
    if (err.status === 401 || err.status === 403) {
      return errorResult("STRAVA_AUTH", err.message, false);
    }
    if (err.status === 404) {
      return errorResult("STRAVA_NOT_FOUND", err.message, false);
    }
    if (err.status >= 500) {
      return errorResult("STRAVA_SERVER_ERROR", err.message, true);
    }
  }
  const message = err instanceof Error ? err.message : "An unexpected error occurred";
  return errorResult("INTERNAL", message, false);
}
