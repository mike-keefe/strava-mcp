import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StravaClient } from "./client.js";

// Stubs — each tool is implemented in its corresponding GitHub issue.
// Issue #3: get_athlete_profile
// Issue #4: get_recent_activities
// Issue #5: get_activity_details
// Issue #6: get_activity_streams
// Issue #7: get_activity_zones
// Issue #8: get_athlete_zones
// Issue #9: get_athlete_stats
export function registerStravaTools(server: McpServer, _client: StravaClient): void {
  server.tool(
    "get_athlete_profile",
    "Stub — see issue #3",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #3)" }] })
  );

  server.tool(
    "get_recent_activities",
    "Stub — see issue #4",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #4)" }] })
  );

  server.tool(
    "get_activity_details",
    "Stub — see issue #5",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #5)" }] })
  );

  server.tool(
    "get_activity_streams",
    "Stub — see issue #6",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #6)" }] })
  );

  server.tool(
    "get_activity_zones",
    "Stub — see issue #7",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #7)" }] })
  );

  server.tool(
    "get_athlete_zones",
    "Stub — see issue #8",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #8)" }] })
  );

  server.tool(
    "get_athlete_stats",
    "Stub — see issue #9",
    {},
    async () => ({ content: [{ type: "text" as const, text: "Not yet implemented (issue #9)" }] })
  );
}
