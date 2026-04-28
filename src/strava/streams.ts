import type { StravaClient } from "./client.js";
import type { StreamType, StreamResolution } from "./types.js";

export interface StreamsParams {
  activityId: number;
  streamTypes?: StreamType[];
  resolution?: StreamResolution;
  downsampleToSeconds?: number;
  format?: "arrays" | "rows";
}

// Stub: implemented in issue #6
export async function fetchActivityStreams(
  _client: StravaClient,
  _params: StreamsParams
): Promise<unknown> {
  throw new Error("Not implemented — see issue #6");
}
