import { config } from "./config";
import type { CacheFile, HealthCheckResult } from "./types";

const CACHE_DIR = new URL("../cache/", import.meta.url);
const LATEST_PATH = new URL("latest.json", CACHE_DIR);

const EMPTY_CACHE: CacheFile = {
  latest: null,
  history: [],
  updated_at: new Date(0).toISOString(),
};

async function ensure_cache_dir(): Promise<void> {
  await Bun.$`mkdir -p ${CACHE_DIR.pathname}`.quiet();
}

async function read_cache(): Promise<CacheFile> {
  const file = Bun.file(LATEST_PATH);
  if (!(await file.exists())) {
    return structuredClone(EMPTY_CACHE);
  }
  try {
    return (await file.json()) as CacheFile;
  } catch {
    // Corrupt or partially-written file; start fresh rather than crash the process.
    return structuredClone(EMPTY_CACHE);
  }
}

async function write_cache(cache: CacheFile): Promise<void> {
  await ensure_cache_dir();
  await Bun.write(LATEST_PATH, JSON.stringify(cache, null, 2));
}

function purge_old_entries(history: HealthCheckResult[]): HealthCheckResult[] {
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  return history.filter((entry) => new Date(entry.timestamp).getTime() >= cutoff);
}





export async function append_result(result: HealthCheckResult): Promise<CacheFile> {
  const cache = await read_cache();

  cache.latest = result;
  cache.history.push(result);
  cache.history = purge_old_entries(cache.history);

  // Cap history length in addition to time-based retention to bound file size.
  if (cache.history.length > config.maxHistoryEntries) {
    cache.history = cache.history.slice(cache.history.length - config.maxHistoryEntries);
  }

  cache.updated_at = new Date().toISOString();

  await write_cache(cache);
  return cache;
}





export async function get_latest_cache(): Promise<HealthCheckResult | null> {
  const cache = await read_cache();
  return cache.latest;
}

export async function get_cache_history(limit: number): Promise<HealthCheckResult[]> {
  const cache = await read_cache();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  return cache.history.slice(-safeLimit).reverse();
}
