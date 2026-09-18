export type HealthStatus = "online" | "offline" | "stale" | "unknown";

export interface HealthCheckResult {
  status: HealthStatus;
  last_seen: string | null;
  latency_ms: number | null;
  error: string | null;
  timestamp: string;
  method: "presence" | "heartbeat";
}

/** HealthCheckResult tagged with which bot it belongs to, used in multi-bot API responses. */
export interface TaggedHealthCheckResult extends HealthCheckResult {
  bot_id: string;
}

export interface LatestCacheFile {
  bots: Record<string, HealthCheckResult>;
  watchdog: HealthCheckResult | null;
  /** ISO timestamp of the last offline alert sent per bot, used to throttle repeat pings. */
  alerts: Record<string, string>;
  updated_at: string;
}

export interface WatchdogHourlyBucket {
  hour: string;
  heartbeats: number;
  was_online: boolean;
}

export interface WatchdogStatus {
  current: "online" | "offline";
  last_seen: string | null;
  hourly: WatchdogHourlyBucket[];
}

/** A point where a bot's status changed; holds until the next mark (or now, for the last one). */
export interface StatusMark {
  status: HealthStatus;
  time: string;
}

