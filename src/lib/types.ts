export type HealthStatus = "online" | "offline" | "stale" | "unknown";

export interface HealthCheckResult {
  status: HealthStatus;
  last_seen: string | null;
  latency_ms: number | null;
  error: string | null;
  timestamp: string;
  method: "presence";
}

export interface CacheFile {
  latest: HealthCheckResult | null;
  history: HealthCheckResult[];
  updated_at: string;
}
