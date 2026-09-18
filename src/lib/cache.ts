import { config } from "./config";
import type {
  HealthCheckResult,
  LatestCacheFile,
  StatusMark,
  WatchdogHourlyBucket,
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

async function read_day(botId: string, date: Date): Promise<HealthCheckResult[]> {
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
  const latest = await read_latest();
  latest.bots[botId] = result;
  latest.updated_at = new Date().toISOString();
  await write_json(LATEST_PATH, CACHE_DIR, latest);

  const today = new Date();
  const dayResults = await read_day(botId, today);
  dayResults.push(result);
  await write_json(day_file_path(botId, today), bot_history_dir(botId), dayResults);

  await purge_old_days(botId);
}

export async function append_watchdog_heartbeat(timestamp = new Date().toISOString()): Promise<void> {
  const heartbeat: HealthCheckResult = {
    status: "online",
    last_seen: timestamp,
    latency_ms: null,
    error: null,
    timestamp,
    method: "heartbeat",
  };
  const latest = await read_latest();
  latest.watchdog = heartbeat;
  latest.updated_at = timestamp;
  await write_json(LATEST_PATH, CACHE_DIR, latest);

  const today = new Date(timestamp);
  const dayResults = await read_day("watchdog", today);
  dayResults.push(heartbeat);
  await write_json(day_file_path("watchdog", today), bot_history_dir("watchdog"), dayResults);
  await purge_old_days("watchdog");
}

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
  const results = await get_recent_days("watchdog", days);
  const now = new Date();
  const firstHour = new Date(now);
  firstHour.setUTCMinutes(0, 0, 0);
  firstHour.setUTCHours(firstHour.getUTCHours() - (days * 24 - 1));
  const heartbeatsByHour = new Map<string, number>();

  for (const result of results) {
    const key = hour_key(result.timestamp);
    heartbeatsByHour.set(key, (heartbeatsByHour.get(key) ?? 0) + 1);
  }

  const hourly: WatchdogHourlyBucket[] = [];
  for (let hour = new Date(firstHour); hour <= now; hour.setUTCHours(hour.getUTCHours() + 1)) {
    const key = hour.toISOString();
    const heartbeats = heartbeatsByHour.get(key) ?? 0;
    hourly.push({ hour: key, heartbeats, was_online: heartbeats > 0 });
  }

  return { current, last_seen: lastSeen, hourly };
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
export async function get_recent_days(botId: string, days: number): Promise<HealthCheckResult[]> {
  const safeDays = Math.min(Math.max(Math.floor(days) || 1, 1), config.retentionDays);
  const today = new Date();
  const results: HealthCheckResult[] = [];

  for (let i = safeDays - 1; i >= 0; i--) {
    const dayResults = await read_day(botId, day_offset(today, i));
    results.push(...dayResults);
  }

  return results;
}

function hour_key(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

/** Collapses chronological entries into marks, one per actual status change. */
function to_status_marks(results: HealthCheckResult[]): StatusMark[] {
  const marks: StatusMark[] = [];
  for (const entry of results) {
    const last = marks[marks.length - 1];
    if (!last || last.status !== entry.status) {
      marks.push({ status: entry.status, time: entry.timestamp });
    }
  }
  return marks;
}

/** Fraction of `[windowStart, windowEnd]` spent "online", by time-weighting each mark's held duration. */
function compute_uptime_pct(marks: StatusMark[], windowStart: Date, windowEnd: Date): number {
  let onlineMs = 0;
  let totalMs = 0;

  for (let i = 0; i < marks.length; i++) {
    const segStart = new Date(marks[i]!.time);
    const segEnd = i + 1 < marks.length ? new Date(marks[i + 1]!.time) : windowEnd;
    const clippedStart = segStart < windowStart ? windowStart : segStart;
    const clippedEnd = segEnd > windowEnd ? windowEnd : segEnd;
    if (clippedEnd <= clippedStart) continue;

    const durationMs = clippedEnd.getTime() - clippedStart.getTime();
    totalMs += durationMs;
    if (marks[i]!.status === "online") onlineMs += durationMs;
  }

  return totalMs > 0 ? Math.round((onlineMs / totalMs) * 10000) / 100 : 0;
}

/** Status-change timeline + time-weighted uptime % over the last `days` days. */
export async function get_status_timeline(
  botId: string,
  days: number,
): Promise<{ uptime_pct: number; timeline: StatusMark[] }> {
  const results = await get_recent_days(botId, days);
  const timeline = to_status_marks(results);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  return { uptime_pct: compute_uptime_pct(timeline, windowStart, windowEnd), timeline };
}


/** page 0 = today, page 1 = yesterday, etc. */
export async function get_day_page(
  botId: string,
  page: number,
): Promise<{ date: string; results: HealthCheckResult[] }> {
  const date = day_offset(new Date(), page);
  const results = await read_day(botId, date);
  return { date: format_day(date), results: results.reverse() };
}

