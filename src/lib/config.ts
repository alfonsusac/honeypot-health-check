import { botTargets, botTimelinePageSize, historyEntryCap, watchdogConfig, watchdogHeartbeatCap } from "../config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const isProduction = process.env.NODE_ENV === "production";

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  guildId: required("GUILD_ID"),
  checkIntervalMs: int("CHECK_INTERVAL_MS", watchdogConfig.heartbeatIntervalMs),
  port: int("PORT", 3000),
  pageSize: int("PAGE_SIZE", botTimelinePageSize),
  // Site revalidation: when set, /revalidate (REVALIDATE_URL) is POSTed with REVALIDATE_TOKEN
  // and a tag after presence marks and total_pages changes. Unset disables revalidation.
  revalidateUrl: optional("REVALIDATE_URL"),
  revalidateToken: optional("REVALIDATE_TOKEN"),
  isProduction,
  // Keep startup and status alerts separate per environment so local dev runs
  // don't spam the real channel.
  logChannelId: isProduction ? optional("LOG_CHANNEL_ID_PROD") : optional("LOG_CHANNEL_ID_DEV"),
  historyEntryCap,
  watchdogHeartbeatCap,
  botTargets,
  botIds: Object.keys(botTargets),
} as const;
