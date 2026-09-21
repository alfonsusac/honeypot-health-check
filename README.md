Vibe coded using copilot

# honeypot-health-check

Lightweight Discord **watchdog** bot that monitors whether one or more bots
are still online — without invoking their commands, spoofing interactions,
or assuming they'll respond to anything. Built with Bun + TypeScript.

## How it decides status

The watchdog fetches guild-member + presence data (`online`/`idle`/`dnd`/`offline`)
for all monitored bots in a **single** guild members request per check cycle.
This is read-only and works for any bot, regardless of whether you control
its code — no messages sent, no commands invoked, no impersonation.

No database is used — results are cached to local JSON files.

## Monitoring multiple bots

Bots to monitor are configured directly in [src/config.ts](src/config.ts) via
the `botTargets` map. Each key is a bot's Discord user ID and each value stores
the bot author, support server, and whether offline/recovery alerts should be
sent:

```ts
export const botTargets: Record<string, {
  author: string;
  support_server: string;
  should_ping: boolean;
}> = {
   "1450060292716494940": {
      author: "author name",
      support_server: "https://discord.gg/example",
      should_ping: true,
   },
};
```

All monitored bots are checked together in one API call per interval. Each bot
gets its own cached history. Leave `support_server` empty when a bot has no
public support server. Set `should_ping: false` to monitor and cache a bot
without sending offline or recovery alerts for it.

## Folder structure

```
honeypot-health-check/
├── package.json
├── tsconfig.json
├── .env.example
├── cache/
│   ├── latest.json                 # { bots: { [botId]: HealthCheckResult }, watchdog, alerts, updated_at }
│   └── history/
│       ├── <botId>.json             # one file per bot: array of presence posts, count-capped
│       └── watchdog.json            # array of watchdog heartbeats, count-capped
└── src/
    ├── index.ts                    # wires everything together, check loop, alerts
    └── lib/
        ├── config.ts               # env vars + the botTargets map + retention caps
        ├── types.ts                # shared types
        ├── bot.ts                  # discord.js client setup
        ├── healthcheck.ts          # batched presence check for all bots
        ├── cache.ts                # per-bot/global JSON cache + count-based retention
        └── server.ts               # HTTP API (Bun.serve)
```

## Environment variables

See [.env.example](.env.example):

| Variable            | Required | Description                                    |
| -------------------- | -------- | ------------------------------------------------ |
| `DISCORD_TOKEN`       | yes      | Token for **this watchdog bot**                   |
| `GUILD_ID`            | yes      | Server ID where the monitored bots live            |
| `CHECK_INTERVAL_MS`   | no       | Interval between checks (default `150000`)         |
| `PORT`                | no       | HTTP API port (default `3000`)                     |
| `PAGE_SIZE`           | no       | Page size for `/bot/:botId` timelines (default `50`) |
| `REVALIDATE_URL`      | no       | Site `/revalidate` endpoint; enables revalidation  |
| `REVALIDATE_TOKEN`    | no       | Shared secret sent to `REVALIDATE_URL`             |

Which bots to monitor and whether each one alerts is configured in
`botTargets` in [src/config.ts](src/config.ts) — not env vars.

## Discord setup

1. Create a **separate** bot application in the
   [Discord Developer Portal](https://discord.com/developers/applications) —
   don't reuse any monitored bot's token.
2. Under **Bot > Privileged Gateway Intents**, enable:
   - `Presence Intent`
   - `Server Members Intent`
3. Invite the watchdog bot to the same guild as the monitored bots with at
   minimum `View Channels`, `Send Messages`, and the Discord permission
   **Mention @everyone, @here, and All Roles** on the alert channels. Check
   both the server role permissions and any channel-specific permission
   overrides; without this permission, Discord will not deliver the
   `@everyone` ping even though the bot sends it with `allowedMentions`.

`/health` and `/status` are registered globally with both **server install**
and **user install** integration types, so they also work in DMs for anyone
who installs the app to their own account (no server membership needed for the
commands; the watchdog's guild-side monitoring is unchanged). To enable this:

- In the [Developer Portal](https://discord.com/developers/applications), open
  the app's **Installation** page and enable both **User Install** and
  **Server Install** install contexts.
- Make sure the **`applications.commands`** OAuth2 scope is included in the
  install URL/authorization scopes.
- Share the generated user-install link; anyone who installs it can run
  `/health` and `/status` in their DMs with the bot.

User-install here still means a bot application in the portal — Discord does
not support attaching commands to a personal user account (self-botting).

Because the commands are registered globally, note that Discord caches their
availability: changes can take from a few minutes up to about an hour to
propagate.

## Local development

```bash
bun install
cp .env.example .env   # fill in values
bun run dev
```

Development does not require Docker. Run it directly with Bun so `bun --watch`
reloads the TypeScript source as you edit it. The `dev` script uses
`NODE_ENV=development` and therefore uses `LOG_CHANNEL_ID_DEV`.

- `GET http://localhost:3000/` — plain-text list of endpoints
- `GET http://localhost:3000/health` — liveness probe; returns `HealthResponse`
- `GET http://localhost:3000/bots` — profiles + latest + uptime % + merged status timeline (first 10) for all bots; returns `BotsResponse`
- `GET http://localhost:3000/watchdog` — current watchdog state, offline ranges, and shard reconnect times; returns `WatchdogResponse`
- `GET http://localhost:3000/bot/:botId` — one bot's profile + latest + uptime % + merged status timeline, `PAGE_SIZE` (default 50) per page; returns `BotStatusResponse`
- `GET http://localhost:3000/bot/:botId?page=2` — next page of the merged status timeline
- `GET http://localhost:3000/bot/:botId/pages` — pagination metadata only (`total`, `total_pages`, `first_page_index`, `page_size`) — cheap enough to poll for cache planning; returns `BotPagesResponse`

Replace `:botId` with a real configured bot ID. Both bot timelines are
**count-bounded**: `/bots` shows the 10 most recent merged marks (no pagination),
`/bot/:botId` pages through all of them `PAGE_SIZE` at a time via `?page=`; neither is
bounded by time. Successful JSON responses use HTTP
`200`. Unknown bot IDs return HTTP `404` with `{ error: string }`.

When `REVALIDATE_URL` and `REVALIDATE_TOKEN` are set, the watchdog pushes site
cache invalidation. Every time a new presence mark lands for a bot (presence
update, startup re-seed, or shard-reconnect re-seed) it `POST`s `{ token,
REVALIDATE_TOKEN, tag: "bot-<id>" }` to `REVALIDATE_URL`. Afterward it recomputes the
bot's `total_pages`; if the page count changed versus the last known value it also
`POST`s `{ token, tag: "bot-<id>-pages" }`. Posting is fire-and-forget and never
affects check/heartbeat timing. `/bot/:botId/pages` returns the exact page metadata
(`PAGE_SIZE`-sized) so the site can cache a single page only when the surrounding
pages stay stable. Typically the same Next.js handler as the GitHub Actions
`/revalidate` workflow below:

### API types + usage

The client-side TypeScript types and copy-paste fetch examples live in
[examples/usage.ts](examples/usage.ts). The types match the JSON responses and
can be copied into (or imported by) a client that consumes the API.

The Discord `/health` command reports the total size of the local cache and
the watchdog process's current memory usage (RSS). The command is registered
for the configured `GUILD_ID` on startup.

The Discord `/status` command reports the latest cached status, check time,
latency, and errors for each monitored bot.

The watchdog writes a heartbeat every `CHECK_INTERVAL_MS` and after every
gateway event. On startup (`instance`) it waits for guild presence data, then
writes an `startup:"instance"` heartbeat, posts the bot statuses, and writes a
regular heartbeat before the periodic loop takes over. When a gateway shard
drops while the process stays up (connection lost / heavy restart), the
periodic heartbeats are paused, so the outage shows up as a real offline range;
on reconnect (`shard` / resume or re-identify) it writes a `startup:"shard"`
heartbeat first to bound the gap, re-fetches fresh presence, posts the bot
statuses, and resumes periodic heartbeats. Any later startup heartbeat closes
an offline range from the previous heartbeat to that startup heartbeat. Each
`offlines[]` entry in `/watchdog` is tagged with the cause of its gap: an
`"instance"` gap means the whole process (re)started (e.g. a deploy or crash
restart), a `"shard"` gap means the gateway dropped and later reconnected while
the process stayed up. If a drop ends with a full process restart, the closing
boundary is the restart's `"instance"` heartbeat, so it is labeled `"instance"`.

Discord replayed events after a shard reconnect carry no timestamps: posts
reconciled from the replay are arrival-stamped and flagged `replayed: true`
(both in `/bots` and `/bot/:botId` timelines and in the "shard reconnected"
Discord message, which lists the replayed presence changes with an "approximate"
label). Between the drop and the reconnect the gateway delivers nothing, so
that span is excluded from bot uptime as unknown time.

The `/bots` and `/bot/:botId` timelines pre-merge the bot's Discord presence
posts with the `/watchdog` offline ranges: each offline range contributes two
synthetic marks — `` `${cause} offline` `` at its `from` and `` `${cause} online` ``
at its `to` (`"instance offline"`/`"instance online"`/`"shard offline"`/`"shard
online"`). The merged marks are sorted chronologically, consecutive identical
statuses are collapsed (so repeated re-seed `online`s disappear), and the
result is listed most recent first. History is retained by **entry count**, not
by time: each bot keeps up to `historyEntryCap` (2000) presence posts and the
watchdog keeps up to `watchdogHeartbeatCap` (20000) heartbeats, dropping the
oldest past the cap — see [src/config.ts](src/config.ts). `/bots` returns the 10
most recent marks per bot (no pagination); `/bot/:botId` pages through all of
them, 50 per page, via `?page=2` (and so on), echoing `page`, `page_size`,
`first_page_index`, `total`, and `total_pages` (pages are 1-indexed, so
`first_page_index` is `1` and item offset is `(page - 1) * page_size`).
Uptime excludes watchdog-down ranges as unknown time and is measured over each
bot's retained history span (its oldest kept mark to now).
Monitored bot presence changes are also handled immediately through Discord's
Gateway `presenceUpdate` event — the post is written, a liveness heartbeat
follows, then a status alert is sent (alerts are @ping-gated per-bot and never
affect timing). The periodic check remains as a fallback reconciliation path.

The `/bots` and `/bot/:botId` merged timelines are count-bounded (10 and 50
marks per response respectively), so responses stay small; the server still
gzips responses over 1 KB when the client sends `Accept-Encoding: gzip`.

## Docker production deployment

Docker is configured for production only; it is not needed for local
development. The image runs the watchdog with Bun, while the Compose bind
mount keeps `cache/` and its health history on the host across container
rebuilds or replacements.

```bash
# on the VPS
git clone https://github.com/alfonsusac/honeypot-health-check.git honeypot-health-check
cd honeypot-health-check
cp .env.example .env   # fill in values, including production channel ID
mkdir -p cache
# The image runs as Bun user 1000 and must be able to write the bind-mounted cache.
sudo chown -R 1000:1000 cache
docker compose pull
docker compose up -d
docker compose logs -f
```

Every push to `main` publishes a new image to GitHub Container Registry. After
the workflow completes, update the VPS with `docker compose pull && docker
compose up -d`. If the repository or package is private, authenticate first
with `docker login ghcr.io` using a GitHub token that can read packages.

The `Revalidate deployment` GitHub Actions workflow POSTs to
`https://check-bot-health.alfon.dev/revalidate` after a push to `main` changes
anything under `src/`. Add the deployment token in the repository settings at
**Settings > Secrets and variables > Actions** as a repository secret named
`REVALIDATE_TOKEN`. Merged pull requests targeting `main` trigger this because
they produce a push to `main`. You can also trigger it manually from the
repository's **Actions** tab by selecting **Revalidate deployment** and
clicking **Run workflow**.

The workflow sends a JSON body (`{"token": "<REVALIDATE_TOKEN>"}`). The status
page that owns the endpoint (not this repo) must expose a matching `POST
/revalidate`. A minimal Next.js App Router implementation:

```ts
// src/app/revalidate/route.ts
import { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (body.token === process.env.REVALIDATE_TOKEN || process.env.NODE_ENV === "development") {
    revalidatePath("/");
  }
}
```

The status page's `REVALIDATE_TOKEN` environment variable must hold the same
value as the GitHub Actions secret (and the dev bypass is only for local
testing).

The API is available on the configured `PORT` (default `3000`). Stop it with
`docker compose down`; the host `cache/` directory is left intact.

## VPS deployment without Docker

```bash
# on the VPS
git clone <your-repo-url> honeypot-health-check
cd honeypot-health-check
bun install
cp .env.example .env   # fill in values
bun run start
```

### Optional: run as a systemd service

Create `/etc/systemd/system/honeypot-health-check.service`:

```ini
[Unit]
Description=Discord health-check watchdog
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/honeypot-health-check
EnvironmentFile=/opt/honeypot-health-check/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
User=bunapp

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now honeypot-health-check
sudo systemctl status honeypot-health-check
```

### Optional: run with pm2

```bash
pm2 start "bun run src/index.ts" --name honeypot-health-check
pm2 save
```

## Notes on safety / policy compliance

- Never invokes any monitored bot's slash commands or fakes interaction payloads.
- Never impersonates a user or self-bots.
- All monitoring is based on data Discord already exposes to any bot in the
  guild (member list, presence).
