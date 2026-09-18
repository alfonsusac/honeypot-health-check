import { config } from "./lib/config"
import { client, start_bot } from "./lib/bot"
import { start_server } from "./lib/server"
import { append_result, append_watchdog_heartbeat, clear_last_alert, get_last_alert, get_latest_for, set_last_alert } from "./lib/cache"
import type { Presence } from "discord.js"
import type { HealthCheckResult } from "./lib/types"

const ALERT_COOLDOWN_MS = 60 * 60 * 1000 // only re-ping the same ongoing outage once per hour

async function main() {
  await start_bot(handle_presence_update, handle_initial_statuses)
  start_server()
  console.log(`[server] listening on port ${ config.port }`)

  // Run once immediately, then on the configured interval — watchdog self-heartbeat only;
  // bot status now comes purely from the presenceUpdate event.
  await run_check_loop()
  setInterval(() => {
    run_check_loop().catch((err) => console.error("[healthcheck] loop error:", err))
  }, config.checkIntervalMs)
}

async function handle_presence_update(presence: Presence): Promise<void> {
  const botId = presence.userId
  if (!config.botIds.includes(botId)) return

  const previous = await get_latest_for(botId)
  const timestamp = new Date().toISOString()
  const isOffline = presence.status === "offline"
  const result: HealthCheckResult = {
    status: isOffline ? "offline" : "online",
    last_seen: isOffline ? previous?.last_seen ?? null : timestamp,
    latency_ms: null,
    error: null,
    timestamp,
    method: "presence",
  }

  await append_result(botId, result)
  console.log(`[presence] bot=${ botId } status=${ result.status }`)
  await post_status_alert(botId, result, previous?.status ?? null)
}

async function handle_initial_statuses(initial: Record<string, HealthCheckResult>): Promise<void> {
  for (const botId of config.botIds) {
    const result = initial[botId]
    if (!result) continue
    await append_result(botId, result)
    console.log(`[bot] startup status bot=${ botId } status=${ result.status }`)
  }
  await post_startup_messages(initial)
}

main().catch((err) => {
  console.error("[index] fatal startup error:", err)
  process.exit(1)
})




async function run_check_loop(): Promise<void> {
  await append_watchdog_heartbeat()
}




async function post_status_alert(
  botId: string,
  result: HealthCheckResult,
  previousStatus: HealthCheckResult["status"] | null,
): Promise<void> {
  const isOffline = result.status === "offline"
  const isRecovery = result.status === "online" && previousStatus === "offline"
  if (!isOffline && !isRecovery) return
  if (!config.botTargets[botId]?.ping) return

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

async function post_startup_messages(initial: Record<string, HealthCheckResult>): Promise<void> {
  if (!config.logChannelId) return

  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    const envLabel = config.isProduction ? "production" : "development"
    const statusLines = config.botIds.map((id) => {
      const result = initial[id]
      const emoji = result?.status === "online" ? "🟢" : result?.status === "offline" ? "🔴" : "⚪"
      return `${ emoji } <@${ id }>: **${ result?.status ?? "unknown" }**`
    })

    await channel.send(
      `🟢 [${ envLabel }] health-check watchdog is online\n${ statusLines.join("\n") || "no bots configured" }`,
    )
  } catch (err) {
    console.error("[index] failed to post startup message:", err)
  }
}