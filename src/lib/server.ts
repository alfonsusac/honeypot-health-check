import { config } from "./config";
import { get_cache_history, get_latest_cache } from "./cache";

const JSON_HEADERS = { "content-type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function start_server() {
  return Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }

      switch (url.pathname) {
        case "/health": {
          return json({ ok: true, uptime_s: Math.round(process.uptime()) });
        }

        case "/status": {
          const latest = await get_latest_cache();
          if (!latest) {
            return json({ error: "no health check has run yet" }, 503);
          }
          return json(latest);
        }

        case "/history": {
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;
          const history = await get_cache_history(limit);
          return json({ count: history.length, results: history });
        }

        default:
          return json({ error: "not found" }, 404);
      }
    },
  });
}
