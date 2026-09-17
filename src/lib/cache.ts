import { config } from "./config";
import type { HealthCheckResult, HourlyBucket, LatestCacheFile } from "./types";

const CACHE_DIR = new URL("../../cache/", import.meta.url);
const LATEST_PATH = new URL("latest.json", CACHE_DIR);
const HISTORY_DIR = new URL("history/", CACHE_DIR);

const EMPTY_LATEST: LatestCacheFile = {
  bots: {},
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

/** Merges the last `days` day-files for a bot (today first), newest entries first. */
export async function get_recent_days(botId: string, days: number): Promise<HealthCheckResult[]> {
  const safeDays = Math.min(Math.max(Math.floor(days) || 1, 1), config.retentionDays);
  const today = new Date();
  const results: HealthCheckResult[] = [];

  for (let i = 0; i < safeDays; i++) {
    const dayResults = await read_day(botId, day_offset(today, i));
    results.push(...dayResults);
  }

  return results.reverse();
}

function hour_key(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function aggregate_hourly(results: HealthCheckResult[]): HourlyBucket[] {
  const buckets = new Map<string, { total: number; online: number; offline: number; unknown: number }>();

  for (const entry of results) {
    const key = hour_key(entry.timestamp);
    const bucket = buckets.get(key) ?? { total: 0, online: 0, offline: 0, unknown: 0 };
    bucket.total += 1;
    if (entry.status === "online") bucket.online += 1;
    else if (entry.status === "offline") bucket.offline += 1;
    else bucket.unknown += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, counts]) => ({
      hour,
      total: counts.total,
      online: counts.online,
      offline: counts.offline,
      unknown: counts.unknown,
      uptime_pct: counts.total > 0 ? Math.round((counts.online / counts.total) * 10000) / 100 : 0,
      had_offline: counts.offline > 0,
    }));
}

/** Hourly rollup (online/offline/unknown counts + uptime %) over the last `days` days. */
export async function get_hourly_history(botId: string, days: number): Promise<HourlyBucket[]> {
  const results = await get_recent_days(botId, days);
  return aggregate_hourly(results);
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

