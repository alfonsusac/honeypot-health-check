import { config } from "./config";
import type {
  HealthCheckResult,
  HeartbeatStartup,
  LatestCacheFile,
  PresenceHistoryEntry,
  StatusMark,
  WatchdogHeartbeat,
  OfflineRange,
  WatchdogStatus,
} from "./types";

const CACHE_DIR = new URL("../../cache/", import.meta.url);
const LATEST_PATH = new URL("latest.json", CACHE_DIR);
const HISTORY_DIR = new URL("history/", CACHE_DIR);

const EMPTY_LATEST: LatestCacheFile = {
  bots: {},
  watchdog: null,
  alerts: {},
  updated_at: new Date(0).toISOString(),
};

function history_file_path(name: string): URL {
  return new URL(`${name}.json`, HISTORY_DIR);
}

async function ensure_dir(dir: URL): Promise<void> {
  await Bun.$`mkdir -p ${dir.pathname}`.quiet();
}

async function read_json<T>(path: URL, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  try {
    return (await file.json()) as T;
  } catch {
    // Corrupt or partially-written file; treat as empty rather than crash the process.
    return fallback;
  }
}

async function write_json(path: URL, dir: URL, data: unknown): Promise<void> {
  await ensure_dir(dir);
  await Bun.write(path, JSON.stringify(data));
}

/** Appends an entry to a count-capped history file, dropping the oldest past the cap. */
async function append_pruned<T>(name: string, entry: T, cap: number): Promise<void> {
  const path = history_file_path(name);
  const results = await read_json<T[]>(path, []);
  results.push(entry);
  if (results.length > cap) results.splice(0, results.length - cap);
  await write_json(path, HISTORY_DIR, results);
}

async function read_latest(): Promise<LatestCacheFile> {
  const latest = await read_json(LATEST_PATH, structuredClone(EMPTY_LATEST));
  // Defensive against cache files written before a field (e.g. `alerts`) existed.
  latest.bots ??= {};
  latest.watchdog ??= null;
  latest.alerts ??= {};
  return latest;
}

export async function append_result(botId: string, result: HealthCheckResult): Promise<void> {
  // Serialize read-modify-write so concurrent posts (e.g. a burst of replayed gateway events
  // after a shard reconnect) cannot interleave and lose entries.
  result_write_queue = result_write_queue.then(async () => {
    const latest = await read_latest();
    latest.bots[botId] = result;
    latest.updated_at = new Date().toISOString();
    await write_json(LATEST_PATH, CACHE_DIR, latest);

    // "unknown" means the check itself failed (no presence data observed), not a real presence event.
    if (result.status !== "unknown") {
      await append_pruned(
        botId,
        { timestamp: result.timestamp, status: result.status, replayed: result.replayed },
        config.historyEntryCap,
      );
    }
  });
  return result_write_queue;
}

let result_write_queue = Promise.resolve();

export async function append_watchdog_heartbeat(
  timestamp = new Date().toISOString(),
  startup: HeartbeatStartup = false,
  replayed_events?: number,
): Promise<void> {
  heartbeat_write_queue = heartbeat_write_queue.then(async () => {
    const heartbeat: WatchdogHeartbeat = { timestamp, startup, ...(replayed_events !== undefined ? { replayed_events } : {}) };
    const latest = await read_latest();
    latest.watchdog = heartbeat;
    latest.updated_at = timestamp;
    await write_json(LATEST_PATH, CACHE_DIR, latest);
    await append_pruned("watchdog", heartbeat, config.watchdogHeartbeatCap);
  });
  return heartbeat_write_queue;
}

let heartbeat_write_queue = Promise.resolve();

export async function get_latest_all(): Promise<Record<string, HealthCheckResult>> {
  const latest = await read_latest();
  return latest.bots;
}

export async function get_cache_size_bytes(): Promise<number> {
  let total = 0;
  const glob = new Bun.Glob("**/*");

  for await (const name of glob.scan({ cwd: CACHE_DIR.pathname, onlyFiles: true })) {
    total += Bun.file(new URL(name, CACHE_DIR)).size;
  }

  return total;
}

export async function get_latest_for(botId: string): Promise<HealthCheckResult | null> {
  const latest = await read_latest();
  return latest.bots[botId] ?? null;
}

export async function get_watchdog_status(): Promise<WatchdogStatus> {
  const latest = await read_latest();
  const lastSeen = latest.watchdog?.timestamp ?? null;
  const current = lastSeen && Date.now() - new Date(lastSeen).getTime() <= config.checkIntervalMs
    ? "online"
    : "offline";
  const heartbeats = await get_sorted_heartbeats();
  const offlines = compute_offline_ranges(heartbeats);
  const shardResumed: string[] = [];

  // Any "shard" boundary heartbeat is a reconnect point. Replayed events are arrival-stamped,
  // so the gap is still marked offline (offlines above); this is informational only.
  for (const heartbeat of heartbeats) {
    if (heartbeat.startup === "shard") {
      shardResumed.push(heartbeat.timestamp);
    }
  }

  // Offline ranges are detected oldest-first; expose them most recent first.
  return { current, last_seen: lastSeen, offlines: offlines.reverse(), shardResumed: shardResumed.reverse() };
}

/** All retained watchdog heartbeats, oldest first, with a numeric timeMs. */
async function get_sorted_heartbeats(): Promise<Array<WatchdogHeartbeat & { timeMs: number }>> {
  const results = await read_json(history_file_path("watchdog"), [] as WatchdogHeartbeat[]);
  return results
    .map((result) => ({ ...result, timeMs: new Date(result.timestamp).getTime() }))
    .filter((result) => Number.isFinite(result.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
}

/** Detects watchdog-down spans from sorted heartbeats: from a heartbeat to the next `startup` one.
 * Input must be ascending by timeMs; output is chronological with the closing heartbeat's cause. */
function compute_offline_ranges(
  heartbeats: Array<WatchdogHeartbeat & { timeMs: number }>,
): OfflineRange[] {
  const offlines: OfflineRange[] = [];

  for (let i = 1; i < heartbeats.length; i++) {
    const previous = heartbeats[i - 1]!;
    const currentHeartbeat = heartbeats[i]!;
    if (!currentHeartbeat.startup || currentHeartbeat.timeMs <= previous.timeMs) continue;
    const fromMs = previous.timeMs;
    if (currentHeartbeat.timeMs <= fromMs) continue;
    offlines.push({
      from: new Date(fromMs).toISOString(),
      to: new Date(currentHeartbeat.timeMs).toISOString(),
      cause: currentHeartbeat.startup === "shard" ? "shard" : "instance",
    });
  }

  return offlines;
}

/** Timestamp of the last offline alert sent for a bot, or null if none / never alerted. */
export async function get_last_alert(botId: string): Promise<string | null> {
  const latest = await read_latest();
  return latest.alerts[botId] ?? null;
}

export async function set_last_alert(botId: string, timestamp: string): Promise<void> {
  const latest = await read_latest();
  latest.alerts[botId] = timestamp;
  await write_json(LATEST_PATH, CACHE_DIR, latest);
}

/** Clears the alert cooldown so the next offline detection pings immediately. */
export async function clear_last_alert(botId: string): Promise<void> {
  const latest = await read_latest();
  if (!(botId in latest.alerts)) return;
  delete latest.alerts[botId];
  await write_json(LATEST_PATH, CACHE_DIR, latest);
}

/** Maps chronological presence entries into marks without collapsing (dedup happens after merging). */
function to_status_marks(results: PresenceHistoryEntry[]): StatusMark[] {
  return results.map((entry) => ({
    status: entry.status,
    time: entry.timestamp,
    ...(entry.replayed ? { replayed: true } : {}),
  }));
}

/** A watchdog-down span, per heartbeat evidence: from a heartbeat to the next `startup` one. */
type UpRange = { start: number; end: number };

function compute_unknown_ranges(
  watchdogResults: WatchdogHeartbeat[],
  windowStartMs: number,
): UpRange[] {
  const heartbeats = watchdogResults
    .map((result) => ({ timeMs: new Date(result.timestamp).getTime(), isStartup: result.startup }))
    .filter((heartbeat) => Number.isFinite(heartbeat.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
  const ranges: UpRange[] = [];

  for (let i = 1; i < heartbeats.length; i++) {
    const previous = heartbeats[i - 1]!;
    const current = heartbeats[i]!;
    if (!current.isStartup || current.timeMs <= previous.timeMs) continue;
    const start = Math.max(previous.timeMs, windowStartMs);
    if (current.timeMs > start) ranges.push({ start, end: current.timeMs });
  }

  return ranges;
}

/** Fraction of `[windowStart, windowEnd]` spent "online", by time-weighting each mark's held duration. */
function compute_uptime_pct(
  marks: StatusMark[],
  unknownRanges: UpRange[],
  windowStart: Date,
  windowEnd: Date,
): number {
  if (marks.length === 0) return 0;
  const observedStart = new Date(Math.max(windowStart.getTime(), new Date(marks[0]!.time).getTime()));
  let onlineMs = 0;
  let knownMs = Math.max(0, windowEnd.getTime() - observedStart.getTime());

  for (const range of unknownRanges) {
    const start = Math.max(range.start, observedStart.getTime());
    const end = Math.min(range.end, windowEnd.getTime());
    if (end > start) knownMs -= end - start;
  }

  for (let i = 0; i < marks.length; i++) {
    const segStart = new Date(marks[i]!.time);
    const segEnd = i + 1 < marks.length ? new Date(marks[i + 1]!.time) : windowEnd;
    const clippedStart = segStart < windowStart ? windowStart : segStart;
    const clippedEnd = segEnd > windowEnd ? windowEnd : segEnd;
    if (clippedEnd <= clippedStart) continue;

    const durationMs = clippedEnd.getTime() - clippedStart.getTime();
    if (marks[i]!.status === "offline") continue;
    onlineMs += durationMs;
    for (const range of unknownRanges) {
      const unknownStart = Math.max(clippedStart.getTime(), range.start);
      const unknownEnd = Math.min(clippedEnd.getTime(), range.end);
      if (unknownEnd > unknownStart) onlineMs -= unknownEnd - unknownStart;
    }
  }

  return knownMs > 0 ? Math.round((onlineMs / knownMs) * 10000) / 100 : 0;
}

export interface BotStatusTimelinePage {
  uptime_pct: number;
  total: number;
  page: number;
  page_size: number;
  timeline: StatusMark[];
}

/**
 * Merged, deduped, paginated status timeline for one bot: real presence marks interleaved with
 * synthetic watchdog boundary marks (`"${cause} offline"` at each offline range start, `"${cause}
 * online"` at its end). Works on the bot's retained history (entry-count capped, not time-bounded):
 * entries are sorted chronologically, consecutive identical statuses are collapsed, and the newest
 * `pageSize` marks for the requested page are returned (recent-first).
 * Uptime % is over the bot's retained history span — from its oldest kept mark to now — with
 * watchdog-down ranges excluded as unknown time; synthetic marks are never treated as
 * uptime-relevant.
 */
export async function get_bot_status_timeline(
  botId: string,
  pageSize: number,
  page: number,
): Promise<BotStatusTimelinePage> {
  const results = await read_json(history_file_path(botId), [] as PresenceHistoryEntry[]);
  const windowEnd = new Date();
  const windowStart = results.length > 0 ? new Date(results[0]!.timestamp) : windowEnd;
  const marks = to_status_marks(results);
  const heartbeats = await get_sorted_heartbeats();

  const unknownRanges = compute_unknown_ranges(
    heartbeats.map(({ timeMs, ...heartbeat }) => heartbeat),
    windowStart.getTime(),
  );
  const uptime_pct = compute_uptime_pct(marks, unknownRanges, windowStart, windowEnd);

  const merged: StatusMark[] = [...marks];
  for (const offline of compute_offline_ranges(heartbeats)) {
    merged.push({ status: `${offline.cause} offline` as const, time: offline.from });
    merged.push({ status: `${offline.cause} online` as const, time: offline.to });
  }

  // Chronological, then collapse consecutive identical statuses (e.g. repeated re-seed `online`s,
  // or a watchdog boundary directly replacing a presence post).
  merged.sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
  const deduped: StatusMark[] = [];
  for (const mark of merged) {
    const last = deduped[deduped.length - 1];
    if (last && last.status === mark.status) continue;
    deduped.push(mark);
  }

  const safePage = Math.max(1, Math.floor(page) || 1);
  const recentFirst = deduped.reverse();
  const start = (safePage - 1) * pageSize;
  return {
    uptime_pct,
    total: deduped.length,
    page: safePage,
    page_size: pageSize,
    timeline: recentFirst.slice(start, start + pageSize),
  };
}

