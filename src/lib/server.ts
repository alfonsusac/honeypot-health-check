import { config } from "./config";
import { get_monitored_bot_profiles } from "./bot";
import { get_day_page, get_latest_all, get_latest_for, get_status_timeline, get_watchdog_status } from "./cache";

const ENDPOINTS_TEXT = `honeypot-health-check API

GET /                              this list
GET /health                        liveness probe
GET /bots                          bot profiles
GET /watchdog                      watchdog heartbeat status, last ${5} days
GET /status                        latest + uptime % + status timeline, last ${5} days, all bots
GET /status/:botId                 latest + uptime % + status timeline, last ${7} days, one bot
GET /status/:botId/page/:number    one calendar day of raw checks (0 = today, 1 = yesterday, ...)
`;

const STATUS_ALL_DAYS = 5;
const STATUS_BOT_DAYS = 7;

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
        return json({ bots: await get_monitored_bot_profiles() }, 200, req);
      }

      if (url.pathname === "/watchdog") {
        return json(await get_watchdog_status(STATUS_ALL_DAYS), 200, req);
      }

      if (url.pathname === "/status") {
        const latest = await get_latest_all();
        const bots: Record<string, { latest: unknown; uptime_pct: number; timeline: Awaited<ReturnType<typeof get_status_timeline>>["timeline"] }> = {};

        for (const botId of config.botIds) {
          const { uptime_pct, timeline } = await get_status_timeline(botId, STATUS_ALL_DAYS);
          bots[botId] = {
            latest: latest[botId] ?? null,
            uptime_pct,
            timeline,
          };
        }

        return json({ days: STATUS_ALL_DAYS, bots }, 200, req);
      }

      const pageMatch = url.pathname.match(/^\/status\/([^/]+)\/page\/(\d+)$/);
      if (pageMatch) {
        const botId = pageMatch[1]!;
        const pageParam = pageMatch[2]!;
        if (!config.botIds.includes(botId)) {
          return json({ error: `unknown bot_id: ${botId}` }, 404, req);
        }

        const page = Number.parseInt(pageParam, 10);
        const { date, results } = await get_day_page(botId, page);
        return json({ bot_id: botId, page, date, count: results.length, results }, 200, req);
      }

      const botMatch = url.pathname.match(/^\/status\/([^/]+)$/);
      if (botMatch) {
        const botId = botMatch[1]!;
        if (!config.botIds.includes(botId)) {
          return json({ error: `unknown bot_id: ${botId}` }, 404, req);
        }

        const latest = await get_latest_for(botId);
        const { uptime_pct, timeline } = await get_status_timeline(botId, STATUS_BOT_DAYS);
        return json(
          { bot_id: botId, days: STATUS_BOT_DAYS, latest, uptime_pct, timeline },
          200,
          req,
        );
      }

      return json({ error: "not found" }, 404, req);
    },
  });
}

