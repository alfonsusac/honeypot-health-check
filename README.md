# honeypot-health-check

Lightweight Discord **watchdog** bot that monitors whether your main bot is
still online — without invoking its commands, spoofing interactions, or
assuming it will respond to anything. Built with Bun + TypeScript.

## How it decides status

1. **Primary: presence / member state.** The watchdog fetches the main bot's
   guild member and reads its Discord presence (`online`/`idle`/`dnd`/`offline`).
   This is read-only and works for any bot, regardless of whether you control
   its code.
2. **Secondary (optional): custom health message.** If `HEALTH_CHANNEL_ID` is
   set, the watchdog will send `!health-check:<nonce>` and wait briefly for a
   reply from `MAIN_BOT_ID`. This is **only useful if the main bot is
   explicitly coded to reply** — if it isn't, a missing reply is treated as
   "no signal", not proof of an outage. It is never used to invoke slash
   commands or impersonate a user.

No database is used — results are cached to a local JSON file.

## Folder structure

```
honeypot-health-check/
├── package.json
├── tsconfig.json
├── .env.example
├── cache/
│   └── latest.json        # created at runtime: { latest, history, updated_at }
└── src/
    ├── config.ts           # env var loading/validation
    ├── types.ts             # shared types
    ├── bot.ts               # discord.js client setup
    ├── healthcheck.ts       # presence + optional custom-message logic
    ├── cache.ts             # JSON cache read/write/retention
    ├── server.ts            # HTTP API (Bun.serve)
    └── index.ts             # wires everything together
```

## Environment variables

See [.env.example](.env.example):

| Variable            | Required | Description                                               |
| -------------------- | -------- | ----------------------------------------------------------- |
| `DISCORD_TOKEN`       | yes      | Token for **this watchdog bot** (a separate bot application) |
| `GUILD_ID`            | yes      | Server ID where the main bot lives                          |
| `MAIN_BOT_ID`         | yes      | User ID of the main bot being monitored                     |
| `HEALTH_CHANNEL_ID`   | no       | Channel for the optional custom health-check message         |
| `LOG_CHANNEL_ID`      | no       | Channel to post status summaries to                          |
| `CHECK_INTERVAL_MS`   | no       | Interval between checks (default `60000`)                    |
| `TIMEOUT_MS`          | no       | How long to wait for a custom-message reply (default `5000`) |
| `PORT`                | no       | HTTP API port (default `3000`)                               |

## Discord setup

1. Create a **separate** bot application in the
   [Discord Developer Portal](https://discord.com/developers/applications) —
   don't reuse the main bot's token.
2. Under **Bot > Privileged Gateway Intents**, enable:
   - `Presence Intent`
   - `Server Members Intent`
   - `Message Content Intent` (only needed if you use the optional custom message)
3. Invite the watchdog bot to the same guild as the main bot with at minimum
   `View Channels` and `Send Messages` (if using log/health channels).

## Local development

```bash
bun install
cp .env.example .env   # fill in values
bun run dev
```

- `GET http://localhost:3000/health` — liveness probe
- `GET http://localhost:3000/status` — latest check result
- `GET http://localhost:3000/history?limit=20` — recent checks (newest first)

## VPS deployment

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

- Never invokes the main bot's slash commands or fakes interaction payloads.
- Never impersonates a user or self-bots.
- The custom health-check message is opt-in, best-effort, and only produces a
  signal if the main bot's own code chooses to reply — the watchdog makes no
  assumptions otherwise.
- All monitoring is based on data Discord already exposes to any bot in the
  guild (member list, presence).
