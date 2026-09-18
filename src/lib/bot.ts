import { Client, GatewayIntentBits, Partials, SlashCommandBuilder } from "discord.js"
import type { Interaction, Presence } from "discord.js"
import { config } from "./config"
import { append_watchdog_heartbeat, get_cache_size_bytes, get_latest_all } from "./cache"
import { get_runtime_memory } from "./runtime"
import type { HealthCheckResult } from "./types"

// GuildPresences and GuildMembers are privileged intents — enable them for this
// bot in the Discord Developer Portal (Bot > Privileged Gateway Intents).
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [ Partials.GuildMember ],
})

export async function get_monitored_bot_profiles(): Promise<Array<{
  id: string
  display_name: string | null
  username: string
  tag: string
  icon: string | null
  author: string
  support_server: string
  ping: boolean
  error?: string
}>> {
  return Promise.all(config.botIds.map(async (id) => {
    const metadata = config.botTargets[id]!
    try {
      const user = await client.users.fetch(id)
      return {
        id: user.id,
        display_name: user.globalName,
        username: user.username,
        tag: user.tag,
        icon: user.displayAvatarURL({ extension: "png", size: 256 }),
        author: metadata.author,
        support_server: metadata.support_server,
        ping: metadata.ping,
      }
    } catch (error) {
      return {
        id,
        display_name: null,
        username: "",
        tag: "",
        icon: null,
        author: metadata.author,
        support_server: metadata.support_server,
        ping: metadata.ping,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
}

const health_command = new SlashCommandBuilder()
  .setName("health")
  .setDescription("Show this watchdog's cache and memory usage")

const status_command = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show the current status of monitored bots")

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${ bytes } B`
  const units = [ "KB", "MB", "GB", "TB" ]
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${ value.toFixed(value >= 10 ? 0 : 1) } ${ units[unit] }`
}

function register_commands(): void {
  client.application?.commands.set([ health_command, status_command ], config.guildId).catch((error) => {
    console.error("[bot] failed to register application commands:", error)
  })
}

async function reply_to_health_command(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "health") return

  const [ cacheBytes, memoryBytes ] = await Promise.all([
    get_cache_size_bytes(),
    get_runtime_memory(),
  ])

  await interaction.reply(
    `**Health**: ` +
    `Cache: ${ format_bytes(cacheBytes) } | ` +
    `Memory: ${ format_bytes(memoryBytes) }`,
  )
}

async function reply_to_status_command(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "status") return

  const latest = await get_latest_all()
  const lines = config.botIds.map((botId) => {
    const result = latest[botId]
    if (!result) return `<@${ botId }>: **no data yet**`

    const latency = result.latency_ms === null ? "n/a" : `${ result.latency_ms }ms`
    const error = result.error ? `\n> ${ result.error }` : ""
    return `<@${ botId }>: **${ result.status }** | checked ${ result.timestamp } | latency ${ latency }${ error }`
  })

  await interaction.reply(`**Bot status**\n${ lines.join("\n") || "No bots configured" }`)
}

/**
 * Seeds initial status for all monitored bots with a single one-time member fetch
 * (not polling — just populating the cache before we start relying on presenceUpdate).
 */
async function get_initial_bot_statuses(): Promise<Record<string, HealthCheckResult>> {
  const timestamp = new Date().toISOString()
  const results: Record<string, HealthCheckResult> = {}

  try {
    const guild = client.guilds.cache.get(config.guildId) ?? await client.guilds.fetch(config.guildId)
    const members = await guild.members.fetch({ user: config.botIds })

    for (const botId of config.botIds) {
      const member = members.get(botId)
      if (!member) {
        results[botId] = {
          status: "unknown",
          last_seen: null,
          latency_ms: null,
          error: "bot not found in guild",
          timestamp,
          method: "presence",
        }
        continue
      }

      const presenceStatus = member.presence?.status ?? null
      // A bot with an active but invisible status looks identical to offline here.
      const isOnline = presenceStatus !== null && presenceStatus !== "offline"
      results[botId] = {
        status: isOnline ? "online" : "offline",
        last_seen: isOnline ? timestamp : null,
        latency_ms: null,
        error: null,
        timestamp,
        method: "presence",
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    for (const botId of config.botIds) {
      results[botId] = {
        status: "unknown",
        last_seen: null,
        latency_ms: null,
        error: `startup presence check failed: ${ message }`,
        timestamp,
        method: "presence",
      }
    }
  }

  return results
}

export async function start_bot(
  on_presence_update: (presence: Presence) => Promise<void>,
  on_ready: (initial: Record<string, HealthCheckResult>) => Promise<void>,
): Promise<void> {
  client.once("clientReady", (readyClient) => {
    console.log(`[bot] logged in as ${ readyClient.user.tag }`)
    register_commands()
    // Heartbeat closes the prior gap *before* any presence data is read, so
    // presence marks never land inside an unknown window.
    append_watchdog_heartbeat()
      .then(() => get_initial_bot_statuses())
      .then(on_ready)
      .catch((error) => console.error("[bot] failed to seed initial bot statuses:", error))
  })

  client.on("interactionCreate", (interaction) => {
    reply_to_health_command(interaction).catch((error) => {
      console.error("[bot] failed to handle /health:", error)
    })
    reply_to_status_command(interaction).catch((error) => {
      console.error("[bot] failed to handle /status:", error)
    })
  })

  client.on("presenceUpdate", (_oldPresence, newPresence) => {
    on_presence_update(newPresence).catch((error) => {
      console.error("[bot] failed to handle presence update:", error)
    })
  })

  client.on("error", (error) => {
    console.error("[bot] client error:", error)
  })

  await client.login(config.discordToken)
}
