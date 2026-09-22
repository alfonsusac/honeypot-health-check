/** A bot's real Discord presence, as reported by the gateway (never assigned by us). */
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
/** PresenceStatus, plus "unknown" for when a check itself failed (bot not found, fetch error). */
export type HealthStatus = PresenceStatus | "unknown";

/**
 * The compact presence data retained in per-bot history day files.
 * `replayed` is true when the post was reconciled from a gateway replay after a shard
 * reconnect (Discord does not timestamp replayed events, so the post is arrival-stamped).
 */
export interface PresenceHistoryEntry {
  timestamp: string;
  status: PresenceStatus;
  replayed?: boolean;
}

/**
 * Why a heartbeat is an unconditional gap-closing boundary.
 * - "instance": the whole process (re)started.
 * - "shard": the gateway link dropped and later reconnected while the process stayed up.
 * - false: a regular periodic/event heartbeat.
 */
export type HeartbeatStartup = "instance" | "shard" | false;

export interface HealthCheckResult {
  status: HealthStatus;
  last_seen: string | null;
  latency_ms: number | null;
  error: string | null;
  timestamp: string;
  method: "presence";
  /** True when this check was recovered from a gateway replay after a shard reconnect. */
  replayed?: boolean;
}

/**
 * A watchdog self-heartbeat. `startup` labels gap-closing boundaries: "instance" for a process
 * (re)start, "shard" for a gateway reconnect after a drop (both fired once fresh presence data
 * has been observed), false for regular periodic/event heartbeats.
 */
export interface WatchdogHeartbeat {
  timestamp: string;
  startup: HeartbeatStartup;
  /** Number of events Discord replayed to the resumed shard; only set on "shard" heartbeats. */
  replayed_events?: number;
}

/** HealthCheckResult tagged with which bot it belongs to, used in multi-bot API responses. */
export interface TaggedHealthCheckResult extends HealthCheckResult {
  bot_id: string;
}

export interface LatestCacheFile {
  bots: Record<string, HealthCheckResult>;
  watchdog: WatchdogHeartbeat | null;
  /** ISO timestamp of the last offline alert sent per bot, used to throttle repeat pings. */
  alerts: Record<string, string>;
  updated_at: string;
}

export interface OfflineRange {
  from: string;
  to: string;
  /** What closed the gap: "instance" = process (re)started, "shard" = gateway reconnected after a drop. */
  cause: "instance" | "shard";
  /** "resumed" when the drop and reconnect fell in the same millisecond (from === to): a sub-ms
   * session resume with effectively no downtime, rendered as a single mark rather than a gap. */
  kind: "range" | "resumed";
}

/** Synthetic statuses injected into bot timelines from /watchdog offline ranges when merged. */
export type WatchdogActivityStatus =
  | "instance offline"
  | "instance online"
  | "shard resumed"
  | "shard offline"
  | "shard online";

/** A timeline mark's status: a real Discord presence, or a synthetic watchdog boundary. */
export type MergedStatus = PresenceStatus | WatchdogActivityStatus;

export interface WatchdogStatus {
  current: "online" | "offline";
  last_seen: string | null;
  offlines: OfflineRange[];
  /** Times the gateway shard reconnected after a drop (purely informational, not reconciled). */
  shardResumed: string[];
}

/** A point where a bot's status was observed; holds until the next mark (or now, for the last one).
 * May be a real presence post or a synthetic watchdog boundary (see `WatchdogActivityStatus`). */
export interface StatusMark {
  status: MergedStatus;
  time: string;
  /** True if this post came from a gateway replay after a shard reconnect (arrival-stamped). */
  replayed?: boolean;
}

