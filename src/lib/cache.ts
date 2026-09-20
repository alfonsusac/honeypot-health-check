import { config } from "./config";
import type {
  HealthCheckResult,
  HealthStatus,
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

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Formats a date as YYYY-MM-DD in UTC, used as both the day-file name and page key. */
function format_day(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function day_offset(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() - days);
  return copy;
}

function bot_history_dir(botId: string): URL {
  return new URL(`${botId}/`, HISTORY_DIR);
}

function day_file_path(botId: string, date: Date): URL {
  return new URL(`${format_day(date)}.json`, bot_history_dir(botId));
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

async function read_latest(): Promise<LatestCacheFile> {
  const latest = await read_json(LATEST_PATH, structuredClone(EMPTY_LATEST));
  // Defensive against cache files written before a field (e.g. `alerts`) existed.
  latest.bots ??= {};
  latest.watchdog ??= null;
  latest.alerts ??= {};
  return latest;
}

async function read_day<T = PresenceHistoryEntry>(botId: string, date: Date): Promise<T[]> {
  return read_json(day_file_path(botId, date), []);
}

/** Deletes day-files older than the retention window for a single bot. */
async function purge_old_days(botId: string): Promise<void> {
  const dir = bot_history_dir(botId);
  const glob = new Bun.Glob("*.json");
  const cutoff = format_day(day_offset(new Date(), config.retentionDays));

  for await (const name of glob.scan({ cwd: dir.pathname, absolute: false })) {
    const day = name.replace(/\.json$/, "");
    if (day < cutoff) {
      await Bun.file(new URL(name, dir)).delete().catch(() => {});
    }
  }
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
      const today = new Date();
      const dayResults = (await read_day(botId, today)).map(({ timestamp, status, replayed }) => ({ timestamp, status, replayed }));
      dayResults.push({ timestamp: result.timestamp, status: result.status, replayed: result.replayed });
      await write_json(day_file_path(botId, today), bot_history_dir(botId), dayResults);
    }

    await purge_old_days(botId);
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

    const today = new Date(timestamp);
    const dayResults = await read_day<WatchdogHeartbeat>("watchdog", today);
    dayResults.push(heartbeat);
    await write_json(day_file_path("watchdog", today), bot_history_dir("watchdog"), dayResults);
    await purge_old_days("watchdog");
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

export async function get_watchdog_status(days: number): Promise<WatchdogStatus> {
  const latest = await read_latest();
  const lastSeen = latest.watchdog?.timestamp ?? null;
  const current = lastSeen && Date.now() - new Date(lastSeen).getTime() <= config.checkIntervalMs
    ? "online"
    : "offline";
  const heartbeats = await get_sorted_heartbeats(days);
  const offlines = compute_offline_ranges(heartbeats, Date.now() - days * 24 * 60 * 60 * 1000);
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

/** Watchdog heartbeats over the last `days`, oldest first, with a numeric timeMs. */
async function get_sorted_heartbeats(days: number): Promise<Array<WatchdogHeartbeat & { timeMs: number }>> {
  const results = await get_recent_days<WatchdogHeartbeat>("watchdog", days);
  return results
    .map((result) => ({ ...result, timeMs: new Date(result.timestamp).getTime() }))
    .filter((result) => Number.isFinite(result.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
}

/** Detects watchdog-down spans from sorted heartbeats: from a heartbeat to the next `startup` one.
 * Input must be ascending by timeMs; output is chronological with the closing heartbeat's cause. */
function compute_offline_ranges(
  heartbeats: Array<WatchdogHeartbeat & { timeMs: number }>,
  windowStartMs: number,
): OfflineRange[] {
  const offlines: OfflineRange[] = [];

  for (let i = 1; i < heartbeats.length; i++) {
    const previous = heartbeats[i - 1]!;
    const currentHeartbeat = heartbeats[i]!;
    if (!currentHeartbeat.startup || currentHeartbeat.timeMs <= previous.timeMs) continue;
    const fromMs = Math.max(previous.timeMs, windowStartMs);
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

/** Merges the last `days` day-files for a bot, oldest entry first (chronological). */
export async function get_recent_days<T = PresenceHistoryEntry>(botId: string, days: number): Promise<T[]> {
  const safeDays = Math.min(Math.max(Math.floor(days) || 1, 1), config.retentionDays);
  const today = new Date();
  const results: T[] = [];

  for (let i = safeDays - 1; i >= 0; i--) {
    const dayResults = await read_day<T>(botId, day_offset(today, i));
    results.push(...dayResults);
  }

  return results;
}

/** Maps chronological entries into marks; by default collapses to one per actual status change,
 * but can keep every presence event post (e.g. repeated `online`s after startup re-seeds). */
function to_status_marks(results: PresenceHistoryEntry[], collapseRepeats = true): StatusMark[] {
  const marks: StatusMark[] = [];
  for (const entry of results) {
    if (collapseRepeats) {
      const last = marks[marks.length - 1];
      if (last && last.status === entry.status) continue;
    }
    marks.push({ status: entry.status, time: entry.timestamp, ...(entry.replayed ? { replayed: true } : {}) });
  }
  return marks;
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

/** Status-change timeline + time-weighted uptime % over the last `days` days. */
export async function get_status_timeline(
  botId: string,
  days: number,
  options?: { collapseRepeats?: boolean },
): Promise<{ uptime_pct: number; timeline: StatusMark[] }> {
  const results = await get_recent_days(botId, days);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const watchdogResults = await get_recent_days<WatchdogHeartbeat>("watchdog", days);
  const unknownRanges = compute_unknown_ranges(watchdogResults, windowStart.getTime());
  const timeline = to_status_marks(results, options?.collapseRepeats ?? true);
  return { uptime_pct: compute_uptime_pct(timeline, unknownRanges, windowStart, windowEnd), timeline };
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
 * online"` at its end). Entries are sorted chronologically, consecutive identical statuses are
 * collapsed, then the newest `pageSize` marks for the requested page are returned (recent-first).
 * Uptime % is computed from presence marks plus watchdog unknown ranges — synthetic marks are never
 * treated as uptime-relevant, keeping the calculation identical to before.
 */
export async function get_bot_status_timeline(
  botId: string,
  days: number,
  pageSize: number,
  page: number,
): Promise<BotStatusTimelinePage> {
  const results = await get_recent_days(botId, days);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const heartbeats = await get_sorted_heartbeats(days);
  const unknownRanges = compute_unknown_ranges(
    heartbeats.map(({ timeMs, ...heartbeat }) => heartbeat),
    windowStart.getTime(),
  );
  const uptime_pct = compute_uptime_pct(
    to_status_marks(results, false),
    unknownRanges,
    windowStart,
    windowEnd,
  );

  const merged: StatusMark[] = [...to_status_marks(results, false)];
  for (const offline of compute_offline_ranges(heartbeats, windowStart.getTime())) {
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


/** page 0 = today, page 1 = yesterday, etc. */
export async function get_day_page(
  botId: string,
  page: number,
): Promise<{ date: string; results: PresenceHistoryEntry[] }> {
  const date = day_offset(new Date(), page);
  const results = await read_day(botId, date);
  return { date: format_day(date), results: results.reverse() };
}

