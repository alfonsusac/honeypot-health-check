import { config } from "./lib/config"
import { client, get_pre_outage_latest, is_collecting_replay, is_gateway_connected, normalize_presence_status, start_bot } from "./lib/bot"
import { start_server } from "./lib/server"
import { append_result, append_watchdog_heartbeat, clear_last_alert, get_last_alert, get_latest_for, set_last_alert } from "./lib/cache"
import type { Presence } from "discord.js"
import type { HealthCheckResult, PresenceStatus } from "./lib/types"

const ALERT_COOLDOWN_MS = 60 * 60 * 1000 // only re-ping the same ongoing outage once per hour

// Presence posts reconciled from a gateway replay after a shard reconnect, buffered so the
// "shard reconnected" message can list them. Times are replay arrival (no timestamps in replays).
interface ReplayedChange {
  botId: string
  status: PresenceStatus
  timestamp: string
}
let replayed_changes: ReplayedChange[] = []

// A bot whose presence changed across a shard disconnect/reconnect, for the reconnect alert.
interface ShardChange {
  botId: string
  old: HealthCheckResult["status"] | null
  new: HealthCheckResult["status"] | null
  replayed: boolean
}

async function main() {
  await start_bot(handle_presence_update, handle_initial_statuses)
  start_server()
  console.log(`[server] listening on port ${ config.port }`)

  // First heartbeat fires from the startup sequence (after presence data is read);
  // this just keeps the interval going afterward.
  setInterval(() => {
    run_check_loop().catch((err) => console.error("[healthcheck] loop error:", err))
  }, config.checkIntervalMs)
}

async function handle_presence_update(presence: Presence): Promise<void> {
  const botId = presence.userId
  if (!config.botIds.includes(botId)) return

  const previous = await get_latest_for(botId)
  const timestamp = new Date().toISOString()
  const status = normalize_presence_status(presence.status)
  const replayed = is_collecting_replay()
  const isOffline = status === "offline"
  const result: HealthCheckResult = {
    status,
    last_seen: isOffline ? previous?.last_seen ?? null : timestamp,
    latency_ms: null,
    error: null,
    timestamp,
    method: "presence",
    replayed,
  }

  if (replayed) {
    replayed_changes.push({ botId, status, timestamp })
  }

  // Post the presence update first, then a startup:false heartbeat as the liveness marker, so the
  // heartbeat always lands after the post. The alert is a side effect and must not affect timing.
  await append_result(botId, result)
  console.log(`[presence] bot=${ botId } status=${ result.status }${ replayed ? " (replayed)" : "" }`)
  await append_watchdog_heartbeat()
  await post_status_alert(botId, result, previous?.status ?? null)
}

async function handle_initial_statuses(
  initial: Record<string, HealthCheckResult>,
  origin: "instance" | "shard",
): Promise<void> {
  let changed: ShardChange[] = []
  if (origin === "shard") {
    // Diff against the pre-outage baseline captured at disconnect; replay/re-seed writes already
    // re-touched latest.json, so a fresh get_latest_for() read would be polluted.
    const baseline = get_pre_outage_latest()
    const fallback: Record<string, HealthCheckResult> = {}
    if (!baseline) {
      for (const botId of config.botIds) {
        const current = await get_latest_for(botId)
        if (current) fallback[botId] = current
      }
    }
    const previousFor = (botId: string): HealthCheckResult | null => (baseline ?? fallback)[botId] ?? null
    const replayedBotIds = new Set(replayed_changes.map((change) => change.botId))
    changed = config.botIds
      .map((botId) => {
        const result = initial[botId]
        return {
          botId,
          old: previousFor(botId)?.status ?? null,
          new: result?.status ?? null,
          replayed: replayedBotIds.has(botId),
        }
      })
      .filter((change) => change.old !== change.new || change.replayed)
  }

  // Stamp at write time, not the stale fetch time from get_initial_bot_statuses(), so these
  // presence posts land AFTER the boundary heartbeat that precedes them in the timeline.
  const timestamp = new Date().toISOString()
  for (const botId of config.botIds) {
    const result = initial[botId]
    if (!result) continue
    await append_result(botId, { ...result, timestamp })
    console.log(`[bot] startup status bot=${ botId } status=${ result.status }`)
  }
  await post_startup_messages(initial, origin, changed)
}

main().catch((err) => {
  console.error("[index] fatal startup error:", err)
  process.exit(1)
})




async function run_check_loop(): Promise<void> {
  // Pause while the gateway is down so shard outages surface as real offline ranges in /watchdog;
  // the re-seed sequence on reconnect closes the gap.
  if (!is_gateway_connected()) return
  await append_watchdog_heartbeat()
}




async function post_status_alert(
  botId: string,
  result: HealthCheckResult,
  previousStatus: HealthCheckResult["status"] | null,
): Promise<void> {
  const isOffline = result.status === "offline"
  const isRecovery = result.status !== "offline" && result.status !== "unknown" && previousStatus === "offline"
  if (!isOffline && !isRecovery) return
  if (!config.botTargets[botId]?.should_ping) return

  if (isOffline) {
    const lastAlertAt = await get_last_alert(botId)
    const elapsedMs = lastAlertAt ? Date.now() - new Date(lastAlertAt).getTime() : Infinity
    const isNewOutage = previousStatus !== "offline"
    if (!isNewOutage && elapsedMs < ALERT_COOLDOWN_MS) {
      console.log(`[index] suppressing repeat offline alert for ${ botId } (cooldown)`)
      return
    }
  }

  // All status alerts use the environment-specific log channel.
  const channelId = config.logChannelId
  if (!channelId) return

  try {
    const channel = await client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    const latency = result.latency_ms !== null ? `${ result.latency_ms }ms` : "n/a"
    const emoji = isOffline ? "🔴" : "🟢"
    await channel.send({
      content: `@everyone ${ emoji } bot <@${ botId }> status: **${ result.status }** (via ${ result.method }, latency ${ latency })` +
        (result.error ? `\n> ${ result.error }` : ""),
      allowedMentions: { parse: [ "everyone" ] },
    })
    if (isOffline) await set_last_alert(botId, new Date().toISOString())
    else await clear_last_alert(botId)
  } catch (err) {
    console.error(`[index] failed to post status alert for ${ botId }:`, err)
  }
}

async function post_startup_messages(
  initial: Record<string, HealthCheckResult>,
  origin: "instance" | "shard",
  changed: ShardChange[] = [],
): Promise<void> {
  if (!config.logChannelId) return

  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    const envLabel = config.isProduction ? "production" : "development"

    if (origin === "shard") {
      replayed_changes = []

      // Only alert when some bot's presence actually changed across the outage.
      if (changed.length === 0) {
        console.log("[index] shard reconnected with no presence changes — skipped alert")
        return
      }

      // Replayed events carry no timestamps, so no times are shown; replay-sourced changes are
      // just marked "replayed" (arrival order is the only approximation).
      const changeLines = changed.map((change) => {
        const emoji = change.new === "offline" ? "🔴" : change.new === "unknown" ? "🟡" : "🟢"
        const details: string[] = []
        if (change.old && change.old !== change.new) details.push(`was ${ change.old }`)
        if (change.replayed) details.push("replayed — order approximate")
        const suffix = details.length ? ` (${ details.join(", ") })` : ""
        return `${ emoji } <@${ change.botId }>: **${ change.new ?? "unknown" }**${ suffix }`
      })

      await channel.send(
        `🟡 [${ envLabel }] shard reconnected — presence changes\n${ changeLines.join("\n") }`,
      )
      return
    }

    const statusLines = config.botIds.map((id) => {
      const result = initial[id]
      const emoji = result && result.status !== "offline" && result.status !== "unknown" ? "🟢" : result?.status === "offline" ? "🔴" : "⚪"
      return `${ emoji } <@${ id }>: **${ result?.status ?? "unknown" }**`
    })

    await channel.send(
      `🟢 [${ envLabel }] health-check watchdog is online\n${ statusLines.join("\n") || "no bots configured" }`,
    )
  } catch (err) {
    console.error("[index] failed to post startup message:", err)
  }
}