import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { validateBearerToken, unauthorizedResponse } from "./auth.js";
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

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "strava-mcp",
    version: "0.1.0",
  });
  const client = new StravaClient(env);
  registerStravaTools(server, client, env.STREAM_CACHE);
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!validateBearerToken(request, env.MCP_AUTH_TOKEN)) {
      return unauthorizedResponse();
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return rateLimitedResponse();
    }

    const server = buildMcpServer(env);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
