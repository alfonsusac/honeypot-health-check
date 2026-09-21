import { config } from "./config";
import { get_bot_timeline_pages } from "./cache";

// Process-local baseline of each bot's total_pages, so a pages-growth can be detected after
// each mark write without re-reading the whole history every time. Seeded at startup and
// refreshed by the /bot/:botId/pages endpoint.
const last_total_pages = new Map<string, number>();

async function post_revalidate(tag: string): Promise<void> {
  if (!config.revalidateUrl || !config.revalidateToken) return;
  try {
    const response = await fetch(config.revalidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: config.revalidateToken, tag }),
    });
    if (!response.ok) {
      console.error(`[revalidate] ${ tag }: non-OK response ${ response.status }`);
    }
  } catch (error) {
    console.error(`[revalidate] failed to revalidate ${ tag }:`, error);
  }
}

/** Prime the pages baseline for every monitored bot so the first post-restart growth is caught. */
export async function seed_pages_baselines(botIds: string[]): Promise<void> {
  for (const botId of botIds) {
    try {
      const { total_pages } = await get_bot_timeline_pages(botId, config.pageSize);
      last_total_pages.set(botId, total_pages);
    } catch (error) {
      console.error(`[revalidate] failed to seed pages baseline for ${ botId }:`, error);
    }
  }
}

/** Keep the in-process baseline in sync with what a client just observed via /pages. */
export function remember_pages(botId: string, total_pages: number): void {
  last_total_pages.set(botId, total_pages);
}

/**
 * Called after a new presence mark lands for a bot. Fires a `bot-<id>` revalidation always, and a
 * `bot-<id>-pages` revalidation when the merge's total_pages changed versus the last known value.
 * Fire-and-forget from the caller's perspective; failures are logged, never thrown.
 */
export async function bump_bot(botId: string): Promise<void> {
  await post_revalidate(`bot-${ botId }`);
  try {
    const { total_pages } = await get_bot_timeline_pages(botId, config.pageSize);
    const previous = last_total_pages.get(botId);
    last_total_pages.set(botId, total_pages);
    if (previous !== undefined && previous !== total_pages) {
      await post_revalidate(`bot-${ botId }-pages`);
    }
  } catch (error) {
    console.error(`[revalidate] failed to track pages for ${ botId }:`, error);
  }
}