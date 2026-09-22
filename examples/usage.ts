/**
 * Client-side types + usage for the honeypot-health-check HTTP API.
 *
 * These TypeScript types match the API's JSON responses and can be copied
 * into (or imported by) a client that consumes the API.
 */

// The bot's real Discord presence, as reported by the gateway — never assigned by us.
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
// PresenceStatus, plus "unknown" for when a check itself failed (bot not found, fetch error).
export type HealthStatus = PresenceStatus | "unknown";

export type HealthCheckResult = {
  status: HealthStatus;
  last_seen: string | null;
  latency_ms: number | null;
  error: string | null;
  timestamp: string;
  method: "presence";
  // True when this check was reconciled from a gateway replay after a shard reconnect
  // (Discord sends no timestamps for replayed events, so the post is arrival-stamped).
  replayed?: boolean;
};

export type HealthResponse = {
  ok: boolean;
  uptime_s: number;
};

// A single merged timeline mark: a real presence post, or a synthetic watchdog boundary.
export type MergedStatus =
  | PresenceStatus
  | "instance offline"
  | "instance online"
  | "shard resumed"
  | "shard offline"
  | "shard online";

export type StatusMark = {
  status: MergedStatus;
  time: string;
  // True when this post came from a gateway replay after a shard reconnect (arrival-stamped).
  replayed?: boolean;
};

// Fields shared by both bot endpoints: profile metadata + latest + uptime + timeline.
export type BotStatus = {
  id: string;
  display_name: string | null;
  username: string;
  tag: string;
  icon: string | null;
  author: string;
  support_server: string;
  should_ping: boolean;
  error?: string;
  latest: HealthCheckResult | null;
  uptime_pct: number;
  timeline: StatusMark[];
};

export type BotsResponse = {
  bots: Array<BotStatus>;
};

export type WatchdogResponse = {
  current: "online" | "offline";
  last_seen: string | null;
  offlines: Array<{
    from: string;
    to: string;
    // "instance" = process (re)started; "shard" = gateway reconnected after a drop.
    cause: "instance" | "shard";
    // "resumed" = a sub-ms shard reconnect (from === to), shown as one "shard resumed" mark.
    kind: "range" | "resumed";
  }>;
  // Times the gateway shard reconnected after a drop (purely informational, not
  // reconciled with bot uptime; replayed events carry no timestamps).
  shardResumed: string[];
};

export type BotStatusResponse = BotStatus & {
  page: number;
  page_size: number;
  // The base page number: 1, since pages are 1-indexed → (page - 1) * page_size
  // positions the page's first item in the newest-first timeline.
  first_page_index: 1;
  // Convenience: Math.ceil(total / page_size); 0 when total is 0.
  total_pages: number;
  total: number;
};

// Pagination metadata for a bot's timeline — no timeline payload. Cheap enough to
// poll; the site uses it to know when the number of pages changes (the watchdog
// separately POSTs a "bot-<id>-pages" revalidate tag on that change).
export type BotPagesResponse = {
  botId: string;
  total: number;
  total_pages: number;
  first_page_index: 1;
  page_size: number;
};

// -- Site revalidation (/revalidate) ------------------------------------------

// The JSON body the watchdog POSTs (application/json) to REVALIDATE_URL whenever
// a new presence mark lands for a bot. `bot-<id>` fires on every mark write;
// `bot-<id>-pages` fires only when the merged timeline's total_pages changed.
// The receiving endpoint must verify `token` and treat only 2xx as success
// (posting is fire-and-forget; failures are logged, never retried).
export type RevalidateRequest = {
  token: string; // REVALIDATE_TOKEN, the shared secret
  tag: string;   // `bot-<id>` or `bot-<id>-pages`
};

// Example literal the watchdog sends:
//   POST https://site.example/revalidate
//   Content-Type: application/json
//   { "token": "s3cret", "tag": "bot-1450060292716494940" }

// Response the receiving endpoint should return. The watchdog checks only
// response.ok, but a structured body is handy for debugging/curl.
export type RevalidateResponse = {
  revalidated: boolean;
  now: number;
  message?: string;
};

// Minimal Next.js App Router implementation (src/app/revalidate/route.ts) that
// accepts the watchdog payload and busts the site's bot-<id> page cache. The
// site's REVALIDATE_TOKEN environment variable must hold the same value as the
// watchdog's, so the incoming `token` can be validated.
//   export async function POST(request: NextRequest) {
//     const body = (await request.json()) as RevalidateRequest;
//     if (body.token !== process.env.REVALIDATE_TOKEN) {
//       return Response.json({ revalidated: false, now: Date.now(), message: "invalid token" }, { status: 401 });
//     }
//     if (!body.tag.startsWith("bot-")) {
//       return Response.json({ revalidated: false, now: Date.now(), message: "unexpected tag" }, { status: 400 });
//     }
//     revalidateTag(body.tag); // busts pages cached under this tag
//     return Response.json({ revalidated: true, now: Date.now() });
//   }

export type ApiError = {
  error: string;
};

// Usage — point DATA_URL at the API base URL: http://localhost:3000/ locally,
// or the VPS URL/domain in production.

const healthResponse = await fetch(new URL("/health", process.env.DATA_URL).toString())
const health = await healthResponse.json() as HealthResponse

const botsResponse = await fetch(new URL("/bots", process.env.DATA_URL).toString())
const bots = await botsResponse.json() as BotsResponse

const botId = "1450060292716494940"
const botResponse = await fetch(new URL(`/bot/${botId}`, process.env.DATA_URL).toString())
const bot = await botResponse.json() as BotStatusResponse

const pageUrl = new URL(`/bot/${botId}`, process.env.DATA_URL)
pageUrl.searchParams.set("page", "2")
const page2Response = await fetch(pageUrl.toString())
const page2 = await page2Response.json() as BotStatusResponse

const pagesResponse = await fetch(new URL(`/bot/${botId}/pages`, process.env.DATA_URL).toString())
const pages = await pagesResponse.json() as BotPagesResponse