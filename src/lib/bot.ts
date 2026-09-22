import { ApplicationIntegrationType, Client, GatewayIntentBits, InteractionContextType, Partials, SlashCommandBuilder } from "discord.js"
import type { Interaction, Presence, PresenceStatus as DiscordPresenceStatus } from "discord.js"
import { config } from "./config"
import { append_watchdog_heartbeat, get_cache_size_bytes, get_history_usage, get_latest_all } from "./cache"
import { get_runtime_memory } from "./runtime"
import type { HealthCheckResult, PresenceStatus } from "./types"

// Discord only reports "invisible" to the invisible user's own client; other observers
// (us, watching bots) always see "offline" instead, but normalize defensively anyway.
export function normalize_presence_status(status: DiscordPresenceStatus): PresenceStatus {
  return status === "invisible" ? "offline" : status
}

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

// Error-alert throttling: recurring failures (a per-event heartbeat write error, a downed
// revalidate endpoint, ...) are collapsed to one message per distinct context per cooldown.
const last_error_alerts = new Map<string, number>();

export async function post_log(message: string): Promise<void> {
  if (!config.logChannelId) return
  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return
    await channel.send(message)
  } catch (error) {
    console.error("[bot] failed to post log message:", error)
  }
}

export function notify_error(context: string, error: unknown, now: number = Date.now()): Promise<void> {
  const last = last_error_alerts.get(context) ?? 0
  if (now - last < config.errorAlertCooldownMs) return Promise.resolve()
  last_error_alerts.set(context, now)
  const envLabel = config.isProduction ? "production" : "development"
  const detail = error instanceof Error ? error.message : String(error)
  return post_log(`⚠️ [${ envLabel }] ${ context }: ${ detail }`)
}

export async function get_monitored_bot_profiles(): Promise<Array<{
  id: string
  display_name: string | null
  username: string
  tag: string
  icon: string | null
  author: string
  support_server: string
  should_ping: boolean
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
        should_ping: metadata.should_ping,
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
        should_ping: metadata.should_ping,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
}

// User-install (DM) + guild-install support: commands register globally and work both in the
// watchdog's server and in DMs for anyone who installs the app to their account.
function set_install_contexts(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
}

const health_command = set_install_contexts(new SlashCommandBuilder())
  .setName("health")
  .setDescription("Show this watchdog's cache and memory usage")

const status_command = set_install_contexts(new SlashCommandBuilder())
  .setName("status")
  .setDescription("Show the current status of monitored bots")

const usages_command = set_install_contexts(new SlashCommandBuilder())
  .setName("usages")
  .setDescription("Show cache history usage (% filled) per bot and the watchdog")

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
  // Global registration (no guildId): required for user-install commands, and they still appear
  // in every server the app is added to via the GuildInstall integration type.
  client.application?.commands.set([ health_command, status_command, usages_command ]).catch(async (error) => {
    console.error("[bot] failed to register application commands:", error)
    await notify_error("failed to register application commands", error)
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

async function reply_to_usages_command(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "usages") return

  const { bots, watchdog } = await get_history_usage()
  const botLines = config.botIds.map((botId) => {
    const usage = bots[botId]!
    return `<@${ botId }>: ${ usage.entries.toLocaleString() }/${ usage.cap.toLocaleString() } (${ usage.used_pct }%) — ${ format_bytes(usage.bytes) }`
  })
  const watchdogLine =
    `Watchdog heartbeats: ${ watchdog.entries.toLocaleString() }/${ watchdog.cap.toLocaleString() } ` +
    `(${ watchdog.used_pct }%) — ${ format_bytes(watchdog.bytes) }`

  await interaction.reply(`**Cache usage**\n${ botLines.join("\n") }\n${ watchdogLine }`)
}

async function reply_to_status_command(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "status") return

  const latest = await get_latest_all()
  const lines = config.botIds.map((botId) => {
    const result = latest[botId]
    if (!result) return `<@${ botId }>: **no data yet**`

    const latency = result.latency_ms === null ? "n/a" : `${ result.latency_ms }ms`
    const error = result.error ? `\n> ${ result.error }` : ""
    const checkedUnix = Math.floor(new Date(result.timestamp).getTime() / 1000)
    return `<@${ botId }>: **${ result.status }** | checked <t:${ checkedUnix }:R> | latency ${ latency }${ error }`
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
    // withPresences forces the multi-member fetch path (fresh REQUEST_GUILD_MEMBERS), so after a shard
    // reconnect we always hit the API for a genuinely fresh snapshot rather than returning stale cache.
    const members = await guild.members.fetch({ user: config.botIds, withPresences: true })

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

      // No presence data at all (e.g. presence intent gap) is treated the same as offline.
      const status = member.presence ? normalize_presence_status(member.presence.status) : "offline"
      results[botId] = {
        status,
        last_seen: status === "offline" ? null : timestamp,
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

// Gates the per-event heartbeat listener until the startup sequence (heartbeat + status + heartbeat) lands.
let startup_heartbeat_sent = false
// True once the instance startup sequence has completed; distinguishes first-connect READY from
// later re-identifies (which are handled as a "shard" re-seed).
let instance_started = false
// Whether a gateway shard is currently connected; the periodic check loop pauses heartbeats while
// false so shard outages surface as real offline ranges.
let gateway_connected = false
// Set while Discord replays missed events right after a shard reconnect; posts reconciled in this
// window are flagged `replayed` (approximation — the replay carries no timestamps).
let collecting_replay = false

export function is_gateway_connected(): boolean {
  return gateway_connected
}

export function is_collecting_replay(): boolean {
  return collecting_replay
}

// Snapshot of bot statuses taken at shard disconnect — the true pre-outage state, captured before
// any replay/re-seed writes touch the cache. Used to diff presence changes on the reconnect alert.
let pre_outage_latest: Record<string, HealthCheckResult> | null = null

export function get_pre_outage_latest(): Record<string, HealthCheckResult> | null {
  return pre_outage_latest
}

/**
 * Re-seeds presence-derived bot statuses, then closes any prior gap. For an "instance" startup the
 * boundary heartbeat goes out after presence is verified; for a "shard" reconnect the "shard"
 * heartbeat is written FIRST so the reconnect gap is bounded before any replayed-event heartbeats
 * can interleave. Either way the bot status is posted afterward, then a regular heartbeat covers the
 * span until the periodic check loop takes over.
 */
async function refresh_presence_and_heartbeat(
  on_ready: (initial: Record<string, HealthCheckResult>, origin: "instance" | "shard") => Promise<void>,
  origin: "instance" | "shard",
  replayed_events?: number,
): Promise<void> {
  if (origin === "shard") {
    await append_watchdog_heartbeat(new Date().toISOString(), "shard", replayed_events)
  }
  const initial = await get_initial_bot_statuses()
  if (origin === "instance") {
    await append_watchdog_heartbeat(new Date().toISOString(), "instance")
  }
  await on_ready(initial, origin)
  await append_watchdog_heartbeat()
  startup_heartbeat_sent = true
}

export async function start_bot(
  on_presence_update: (presence: Presence) => Promise<void>,
  on_ready: (initial: Record<string, HealthCheckResult>, origin: "instance" | "shard") => Promise<void>,
): Promise<void> {
  let resolve_ready!: () => void
  let reject_ready!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolve_ready = resolve
    reject_ready = reject
  })

  client.once("clientReady", (readyClient) => {
    console.log(`[bot] logged in as ${ readyClient.user.tag }`)
    register_commands()
    instance_started = true
    gateway_connected = true
    refresh_presence_and_heartbeat(on_ready, "instance").catch(async (error) => {
      console.error("[bot] failed to seed initial bot statuses:", error)
      await notify_error("initial status seed failed", error)
      reject_ready(error)
    }).then(() => {
      resolve_ready()
    })
  })

  // Fires when a shard reconnects to the gateway after a drop; the session resumes and Discord
  // replays missed events (no timestamps). Presence data may be stale, so re-seed it — the "shard"
  // heartbeat is written first to bound the reconnect gap before replayed-event heartbeats can land.
  client.on("shardResume", (_shardId, replayedEvents) => {
    console.log(`[bot] shard resumed after reconnect (replayed ${ replayedEvents } events)`)
    gateway_connected = true
    collecting_replay = true
    refresh_presence_and_heartbeat(on_ready, "shard", replayedEvents).catch(async (error) => {
      console.error("[bot] failed to refresh bot statuses after reconnect:", error)
      await notify_error("refresh bot statuses after reconnect failed", error)
    }).finally(() => {
      collecting_replay = false
    })
  })

  // A shard got a fresh READY. First connect is owned by clientReady ("instance"); any later READY
  // means the session could not resume after a drop, so run the same "shard" re-seed sequence.
  client.on("shardReady", (_shardId) => {
    gateway_connected = true
    if (!instance_started) return
    console.log("[bot] shard re-identified after reconnect")
    collecting_replay = true
    refresh_presence_and_heartbeat(on_ready, "shard").catch(async (error) => {
      console.error("[bot] failed to refresh bot statuses after re-identify:", error)
      await notify_error("refresh bot statuses after re-identify failed", error)
    }).finally(() => {
      collecting_replay = false
    })
  })

  client.on("shardDisconnect", (_closeEvent) => {
    gateway_connected = false
    // Best-effort capture of the pre-outage statuses for the reconnect alert's change diff.
    get_latest_all().then((latest) => {
      pre_outage_latest = latest
    }).catch(async (error) => {
      console.error("[bot] failed to capture pre-outage statuses:", error)
      await notify_error("capture pre-outage statuses failed", error)
      pre_outage_latest = null
    })
  })

  client.on("interactionCreate", (interaction) => {
    reply_to_health_command(interaction).catch(async (error) => {
      console.error("[bot] failed to handle /health:", error)
      await notify_error("/health command failed", error)
    })
    reply_to_status_command(interaction).catch(async (error) => {
      console.error("[bot] failed to handle /status:", error)
      await notify_error("/status command failed", error)
    })
    reply_to_usages_command(interaction).catch(async (error) => {
      console.error("[bot] failed to handle /usages:", error)
      await notify_error("/usages command failed", error)
    })
  })

  client.on("presenceUpdate", (_oldPresence, newPresence) => {
    on_presence_update(newPresence).catch(async (error) => {
      console.error("[bot] failed to handle presence update:", error)
      await notify_error(`presence update bot=${ newPresence.userId } failed`, error)
    })
  })

  // Every gateway dispatch is evidence that the watchdog process is connected. Monitored presence
  // updates are handled by handle_presence_update (which owns the post-then-heartbeat ordering);
  // every other event heartbeats here to prove liveness.
  client.on("raw", (data: { t?: string; d?: { user?: { id?: string } } }) => {
    if (!startup_heartbeat_sent) return
    if (data.t === "PRESENCE_UPDATE") {
      const userId = data.d?.user?.id
      if (userId && config.botIds.includes(userId)) return
    }
    append_watchdog_heartbeat().catch(async (error) => {
      console.error("[bot] failed to write event heartbeat:", error)
      await notify_error("event heartbeat write failed", error)
    })
  })

  client.on("error", async (error) => {
    console.error("[bot] client error:", error)
    await notify_error("discord client error", error)
  })

  await client.login(config.discordToken)
  await ready
}
