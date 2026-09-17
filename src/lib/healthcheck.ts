import type { Client, Guild, GuildMember } from "discord.js";
import { config } from "./config";
import type { HealthCheckResult } from "./types";

/**
 * Look up the main bot's guild member + presence.
 * This never sends any messages or fakes interactions — it just reads state
 * Discord already exposes to any bot with the (privileged) presence intent.
 */
async function check_presence(client: Client, guildId: string, mainBotId: string) {
  const start = Date.now();

  let guild: Guild;
  if (client.guilds.cache.has(guildId)) {
    guild = client.guilds.cache.get(guildId)!;
  } else {
    guild = await client.guilds.fetch(guildId);
  }

  const member: GuildMember = await guild.members.fetch(mainBotId);
  const latencyMs = Date.now() - start;
  const presenceStatus = member.presence?.status ?? null;

  return { presenceStatus, latencyMs };
}



export async function perform_health_check(
  client: Client,
  previousLastSeen: string | null,
): Promise<HealthCheckResult> {
  const timestamp = new Date().toISOString();

  try {
    const { presenceStatus, latencyMs } = await check_presence(
      client,
      config.guildId,
      config.mainBotId,
    );

    if (presenceStatus && presenceStatus !== "offline") {
      return {
        status: "online",
        last_seen: timestamp,
        latency_ms: latencyMs,
        error: null,
        timestamp,
        method: "presence",
      };
    }

    if (presenceStatus === "offline") {
      return {
        status: "offline",
        last_seen: previousLastSeen,
        latency_ms: latencyMs,
        error: null,
        timestamp,
        method: "presence",
      };
    }

    // Member found but no presence data available (e.g. presence intent not
    // fully populated yet). Not enough signal to call it online or offline.
    return {
      status: "unknown",
      last_seen: previousLastSeen,
      latency_ms: latencyMs,
      error: "member found but no presence data available",
      timestamp,
      method: "presence",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "offline",
      last_seen: previousLastSeen,
      latency_ms: null,
      error: `presence check failed: ${message}`,
      timestamp,
      method: "presence",
    };
  }
}
