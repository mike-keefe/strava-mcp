// Single-line JSON logging for Cloudflare Workers (visible in `wrangler tail`
// and the Workers Logs UI). Never logs auth tokens or client secrets even if
// they end up in a logged structure — values containing those keys or that
// look like a Bearer token are redacted before serialisation.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN = /authorization|auth_token|client_secret|refresh_token|access_token|bearer/i;

export class Logger {
  private readonly minRank: number;

  constructor(level: string | undefined) {
    const lvl = (level ?? "info").toLowerCase() as LogLevel;
    this.minRank = LEVEL_RANK[lvl] ?? LEVEL_RANK.info;
  }

  isDebug(): boolean {
    return this.minRank <= LEVEL_RANK.debug;
  }

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.log("debug", event, fields);
  }
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.log("info", event, fields);
  }
  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.log("warn", event, fields);
  }
  error(event: string, fields: Record<string, unknown> = {}): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const redactedFields = redact(fields) as Record<string, unknown>;
    const payload = { level, event, ...redactedFields };
    try {
      console.log(JSON.stringify(payload));
    } catch {
      console.log(JSON.stringify({ level, event, error: "log_serialise_failed" }));
    }
  }
}

// Recursively walk an object and redact any field whose key matches the
// sensitive pattern. Strings that look like a Bearer token header are also
// scrubbed so accidentally-logged Authorization values don't leak.
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubBearer(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function scrubBearer(s: string): string {
  if (/^Bearer\s+\S+/i.test(s)) return "Bearer [REDACTED]";
  return s;
}

// Pulls the query keys (not values) from a path so we can log what was
// requested without leaking IDs or secret-like params.
export function queryKeys(path: string): string[] {
  const q = path.split("?")[1];
  if (!q) return [];
  return q.split("&").map((kv) => kv.split("=")[0]).filter(Boolean);
}
