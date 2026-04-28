import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { validateBearerToken, unauthorizedResponse } from "./auth.js";
import { StravaClient } from "./strava/client.js";
import { registerStravaTools } from "./strava/tools.js";
import type { Env } from "./types.js";

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "strava-mcp",
    version: "0.1.0",
  });
  const client = new StravaClient(env);
  registerStravaTools(server, client);
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!validateBearerToken(request, env.MCP_AUTH_TOKEN)) {
      return unauthorizedResponse();
    }
    const server = buildMcpServer(env);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
