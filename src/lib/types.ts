export type HealthStatus = "online" | "offline" | "stale" | "unknown";

export interface HealthCheckResult {
  status: HealthStatus;
  last_seen: string | null;
  latency_ms: number | null;
  error: string | null;
  timestamp: string;
  method: "presence";
}

/** HealthCheckResult tagged with which bot it belongs to, used in multi-bot API responses. */
export interface TaggedHealthCheckResult extends HealthCheckResult {
  bot_id: string;
}

export interface LatestCacheFile {
  bots: Record<string, HealthCheckResult>;
  /** ISO timestamp of the last offline alert sent per bot, used to throttle repeat pings. */
  alerts: Record<string, string>;
  updated_at: string;
}

/** One UTC hour's worth of checks, aggregated down from raw per-check entries. */
export interface HourlyBucket {
  hour: string; // ISO timestamp of the hour's start, e.g. "2026-09-17T07:00:00.000Z"
  total: number;
  online: number;
  offline: number;
  unknown: number;
  uptime_pct: number;
  had_offline: boolean;
}

