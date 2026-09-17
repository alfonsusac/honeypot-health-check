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

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  guildId: required("GUILD_ID"),
  mainBotId: required("MAIN_BOT_ID"),
  // Optional: custom health-check message is only sent if this is set,
  // and only works if the main bot is explicitly coded to reply to it.
  healthChannelId: optional("HEALTH_CHANNEL_ID"),
  logChannelId: optional("LOG_CHANNEL_ID"),
  checkIntervalMs: int("CHECK_INTERVAL_MS", 60_000),
  timeoutMs: int("TIMEOUT_MS", 5_000),
  port: int("PORT", 3000),
  retentionDays: 30,
  maxHistoryEntries: 500,
} as const;
