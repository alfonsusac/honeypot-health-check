import type { Client, Guild } from "discord.js";
import type { HealthCheckResult } from "./types";

/**
 * Looks up presence for multiple bots in a single guild members fetch — one
 * API call regardless of how many bots are monitored. Read-only: never sends
 * any messages or fakes interactions.
 */
export async function perform_health_checks(
  client: Client,
  guildId: string,
  botIds: string[],
  previousLastSeen: Record<string, string | null>,
): Promise<Record<string, HealthCheckResult>> {
  const timestamp = new Date().toISOString();
  const results: Record<string, HealthCheckResult> = {};

  try {
    let guild: Guild;
    if (client.guilds.cache.has(guildId)) {
      guild = client.guilds.cache.get(guildId)!;
    } else {
      guild = await client.guilds.fetch(guildId);
    }

    const start = Date.now();
    const members = await guild.members.fetch({ user: botIds });
    const latencyMs = Date.now() - start;

    for (const botId of botIds) {
      const member = members.get(botId);

      if (!member) {
        results[botId] = {
          status: "offline",
          last_seen: previousLastSeen[botId] ?? null,
          latency_ms: latencyMs,
          error: "bot not found in guild",
          timestamp,
          method: "presence",
        };
        continue;
      }

      const presenceStatus = member.presence?.status ?? null;

      if (presenceStatus && presenceStatus !== "offline") {
        results[botId] = {
          status: "online",
          last_seen: timestamp,
          latency_ms: latencyMs,
          error: null,
          timestamp,
          method: "presence",
        };
      } else if (presenceStatus === "offline") {
        results[botId] = {
          status: "offline",
          last_seen: previousLastSeen[botId] ?? null,
          latency_ms: latencyMs,
          error: null,
          timestamp,
          method: "presence",
        };
      } else {
        // Member found but no presence data available (e.g. presence intent not
        // fully populated yet). Not enough signal to call it online or offline.
        results[botId] = {
          status: "unknown",
          last_seen: previousLastSeen[botId] ?? null,
          latency_ms: latencyMs,
          error: "member found but no presence data available",
          timestamp,
          method: "presence",
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const botId of botIds) {
      results[botId] = {
        status: "offline",
        last_seen: previousLastSeen[botId] ?? null,
        latency_ms: null,
        error: `presence check failed: ${message}`,
        timestamp,
        method: "presence",
      };
    }
  }

  return results;
}

