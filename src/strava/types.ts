export type StreamType =
  | "time"
  | "distance"
  | "latlng"
  | "altitude"
  | "velocity_smooth"
  | "heartrate"
  | "cadence"
  | "watts"
  | "temp"
  | "moving"
  | "grade_smooth";

export type StreamResolution = "low" | "medium" | "high" | "all";

export interface StravaStream {
  type: StreamType;
  data: number[] | number[][] | boolean[];
  series_type: "time" | "distance";
  original_size: number;
  resolution: "low" | "medium" | "high";
}

export interface StravaStreamSet {
  [key: string]: StravaStream;
}

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

export interface StravaRateLimitInfo {
  shortTermLimit: number;
  shortTermUsage: number;
  dailyLimit: number;
  dailyUsage: number;
}

export interface StravaError {
  message: string;
  locations: unknown[];
  field: string;
  resource: string;
  code: string;
}

export interface StravaApiError {
  message: string;
  errors: StravaError[];
}
