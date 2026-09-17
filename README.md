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

Bots to monitor are configured directly in [src/lib/config.ts](src/lib/config.ts)
via the `botTargets` map — key is the bot's user ID, value is the channel ID
to `@everyone`-ping when that specific bot goes offline:

```ts
export const botTargets: Record<string, string> = {
  "1450060292716494940": "1550031498839588874", // bot A -> alert channel
  "9999999999999999999": "8888888888888888888", // bot B -> a different channel
};
```

All monitored bots are checked together in one API call per interval. Each
bot gets its own cached history and its own alert channel.

## Folder structure

```
honeypot-health-check/
├── package.json
├── tsconfig.json
├── .env.example
├── cache/
│   ├── latest.json                 # { bots: { [botId]: HealthCheckResult }, updated_at }
│   └── history/
│       └── <botId>/
│           ├── 2026-09-17.json      # one file per calendar day (UTC), per bot
│           └── 2026-09-16.json
└── src/
    ├── index.ts                    # wires everything together, check loop, alerts
    └── lib/
        ├── config.ts               # env vars + the botTargets map
        ├── types.ts                # shared types
        ├── bot.ts                  # discord.js client setup
        ├── healthcheck.ts          # batched presence check for all bots
        ├── cache.ts                # per-bot/per-day JSON cache + retention
        └── server.ts               # HTTP API (Bun.serve)
```

## Environment variables

See [.env.example](.env.example):

| Variable            | Required | Description                                    |
| -------------------- | -------- | ------------------------------------------------ |
| `DISCORD_TOKEN`       | yes      | Token for **this watchdog bot**                   |
| `GUILD_ID`            | yes      | Server ID where the monitored bots live            |
| `CHECK_INTERVAL_MS`   | no       | Interval between checks (default `60000`)          |
| `PORT`                | no       | HTTP API port (default `3000`)                     |

Which bots to monitor, and which channel each alerts to, is configured in
`botTargets` in [src/lib/config.ts](src/lib/config.ts) — not env vars.

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
- `GET http://localhost:3000/bots` — monitored IDs; returns `BotsResponse`
- `GET http://localhost:3000/status` — latest + last 5 days of history for all bots; returns `AllBotsStatusResponse`
- `GET http://localhost:3000/status/:botId` — latest + last 7 days of history for one bot; returns `BotStatusResponse`
- `GET http://localhost:3000/status/:botId/page/:number` — one calendar day of raw checks; returns `StatusPageResponse`

Replace `:botId` with a real configured bot ID. The page number is zero-based:
`0` is today, `1` is yesterday, and so on. Successful JSON responses use HTTP
`200`. Unknown bot IDs return HTTP `404` with `{ error: string }`.

### API response types

These TypeScript types match the JSON responses and can be copied into a client:

```ts
type HealthStatus = "online" | "offline" | "stale" | "unknown";

type HealthCheckResult = {
   status: HealthStatus;
   last_seen: string | null;
   latency_ms: number | null;
   error: string | null;
   timestamp: string;
   method: "presence";
};

type HourlyBucket = {
   hour: string;
   total: number;
   online: number;
   offline: number;
   unknown: number;
   uptime_pct: number;
   had_offline: boolean;
};

type HealthResponse = {
   ok: boolean;
   uptime_s: number;
};

type BotsResponse = {
   bots: string[];
};

type AllBotsStatusResponse = {
   days: number;
   bots: Record<string, {
      latest: HealthCheckResult | null;
      hourly: HourlyBucket[];
   }>;
};

type BotStatusResponse = {
   bot_id: string;
   days: number;
   latest: HealthCheckResult | null;
   count: number;
   hourly: HourlyBucket[];
};

type StatusPageResponse = {
   bot_id: string;
   page: number;
   date: string;
   count: number;
   results: HealthCheckResult[];
};

type ApiError = {
   error: string;
};
```

### Copy-paste fetch examples

`fetch()` returns a `Response`, so call `.json()` on it. In TypeScript, the
type assertion belongs after parsing the JSON:

```ts
const health = await fetch("http://localhost:3000/health")
   .then((response) => response.json() as Promise<HealthResponse>);

const bots = await fetch("http://localhost:3000/bots")
   .then((response) => response.json() as Promise<BotsResponse>);

const allStatus = await fetch("http://localhost:3000/status")
   .then((response) => response.json() as Promise<AllBotsStatusResponse>);

const botId = "1450060292716494940";
const botStatus = await fetch(`http://localhost:3000/status/${botId}`)
   .then((response) => response.json() as Promise<BotStatusResponse>);

const page = 0;
const botDay = await fetch(`http://localhost:3000/status/${botId}/page/${page}`)
   .then((response) => response.json() as Promise<StatusPageResponse>);
```

For production, replace `http://localhost:3000` with the VPS URL or domain.

The Discord `/health` command reports the total size of the local cache and
the watchdog process's current memory usage (RSS). The command is registered
for the configured `GUILD_ID` on startup.

The Discord `/status` command reports the latest cached status, check time,
latency, and errors for each monitored bot.

The `/status` and `/status/:botId` responses can get large (roughly 1-1.5 MB
per bot at a 1-minute check interval); the server gzips responses over 1 KB
when the client sends `Accept-Encoding: gzip`.

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
