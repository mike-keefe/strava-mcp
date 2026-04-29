import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { extractBearerToken, isStaticTokenValid, unauthorizedResponse } from "./auth.js";
import { isOAuthPath, handleOAuth, isValidOAuthToken } from "./oauth.js";
import { StravaClient } from "./strava/client.js";
import { registerStravaTools } from "./strava/tools.js";
import type { Env } from "./types.js";

function rateLimitedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "RATE_LIMITED", message: "Too many requests. Slow down and try again." },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

function buildMcpServer(env: Env, userOAuthToken?: string): McpServer {
  const server = new McpServer({ name: "strava-mcp", version: "0.1.0" });
  const client = new StravaClient(env, userOAuthToken);
  registerStravaTools(server, client, env);
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // OAuth endpoints are unauthenticated — handle before the token check
    if (isOAuthPath(url.pathname)) {
      return handleOAuth(request, env);
    }

    // Accept static admin token (fast, sync) OR a KV-stored OAuth access token
    const token = extractBearerToken(request);
    const isStaticAuth = token !== null && isStaticTokenValid(token, env.MCP_AUTH_TOKEN);
    const isOAuthAuth = !isStaticAuth && token !== null && (await isValidOAuthToken(token, env));

    if (!isStaticAuth && !isOAuthAuth) {
      return unauthorizedResponse(url.origin);
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return rateLimitedResponse();
    }

    // Static token uses the shared STRAVA_REFRESH_TOKEN; OAuth tokens are per-user
    const server = buildMcpServer(env, isOAuthAuth ? token! : undefined);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
