import { config } from "./config";
import { get_monitored_bot_profiles } from "./bot";
import { get_bot_status_timeline, get_latest_all, get_latest_for, get_watchdog_status } from "./cache";

const ENDPOINTS_TEXT = `honeypot-health-check API

GET /                      this list
GET /health                liveness probe
GET /watchdog              watchdog heartbeat status + offline ranges
GET /bots                  profiles + latest + uptime % + merged status timeline (first 10)
GET /bot/:botId            one bot's profile + latest + uptime % + merged status timeline (50 per page)
GET /bot/:botId?page=2     next page of the merged status timeline
`;

const STATUS_ALL_PAGE_SIZE = 10;
const STATUS_BOT_PAGE_SIZE = 50;

function json(body: unknown, status = 200, req?: Request): Response {
  const payload = JSON.stringify(body);
  const acceptsGzip = req?.headers.get("accept-encoding")?.includes("gzip") ?? false;

  // Day-level history responses are repetitive JSON and compress well (~8-10x);
  // gzip anything large enough for that to matter.
  if (acceptsGzip && payload.length > 1024) {
    const compressed = Bun.gzipSync(Buffer.from(payload));
    return new Response(compressed, {
      status,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
    });
  }

  return new Response(payload, { status, headers: { "content-type": "application/json" } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function start_server() {
  return Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "GET") {
        return json({ error: "method not allowed" }, 405, req);
      }

      if (url.pathname === "/") {
        return text(ENDPOINTS_TEXT);
      }

      if (url.pathname === "/health") {
        return json({ ok: true, uptime_s: Math.round(process.uptime()) }, 200, req);
      }

      if (url.pathname === "/bots") {
        const profiles = await get_monitored_bot_profiles();
        const latest = await get_latest_all();
        const bots = await Promise.all(profiles.map(async (bot) => {
          const { uptime_pct, timeline } = await get_bot_status_timeline(bot.id, STATUS_ALL_PAGE_SIZE, 1);
          return {
            ...bot,
            latest: latest[bot.id] ?? null,
            uptime_pct,
            timeline,
          };
        }));
        return json({ bots }, 200, req);
      }

      if (url.pathname === "/watchdog") {
        return json(await get_watchdog_status(), 200, req);
      }

      const botMatch = url.pathname.match(/^\/bot\/([^/]+)$/);
      if (botMatch) {
        const botId = botMatch[1]!;
        if (!config.botIds.includes(botId)) {
          return json({ error: `unknown bot_id: ${botId}` }, 404, req);
        }

        const pageParam = url.searchParams.get("page");
        const page = pageParam ? (Number.parseInt(pageParam, 10) || 1) : 1;
        const profiles = await get_monitored_bot_profiles();
        const profile = profiles.find((candidate) => candidate.id === botId);
        const latest = await get_latest_for(botId);
        const { uptime_pct, page: resolvedPage, page_size, total, timeline } = await get_bot_status_timeline(
          botId,
          STATUS_BOT_PAGE_SIZE,
          page,
        );
        return json(
          {
            ...(profile ?? { id: botId }),
            latest,
            uptime_pct,
            page: resolvedPage,
            page_size,
            total,
            timeline,
          },
          200,
          req,
        );
      }

      return json({ error: "not found" }, 404, req);
    },
  });
}

