import { config } from "./lib/config"
import { client, start_bot } from "./lib/bot"
import { start_server } from "./lib/server"
import { append_result, clear_last_alert, get_last_alert, get_latest_for, set_last_alert } from "./lib/cache"
import { perform_health_checks } from "./lib/healthcheck"
import type { HealthCheckResult } from "./lib/types"

const ALERT_COOLDOWN_MS = 60 * 60 * 1000 // only re-ping the same ongoing outage once per hour

async function main() {
  await start_bot()
  start_server()
  console.log(`[server] listening on port ${ config.port }`)

  await post_startup_messages()

  // Run once immediately, then on the configured interval.
  await run_check_loop()
  setInterval(() => {
    run_check_loop().catch((err) => console.error("[healthcheck] loop error:", err))
  }, config.checkIntervalMs)
}

main().catch((err) => {
  console.error("[index] fatal startup error:", err)
  process.exit(1)
})




async function run_check_loop(): Promise<void> {
  const botIds = config.botIds
  const previousLastSeen: Record<string, string | null> = {}

  for (const botId of botIds) {
    const latest = await get_latest_for(botId)
    previousLastSeen[botId] = latest?.last_seen ?? null
  }

  const results = await perform_health_checks(client, config.guildId, botIds, previousLastSeen)

  for (const botId of botIds) {
    const result = results[botId]
    if (!result) continue

    const previous = await get_latest_for(botId)
    await append_result(botId, result)
    console.log(
      `[healthcheck] bot=${ botId } status=${ result.status } latency=${ result.latency_ms }ms`,
    )
    await post_status_alert(botId, result, previous?.status ?? null)
  }
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

async function post_startup_messages(): Promise<void> {
  if (!config.logChannelId) return

  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    const mentions = config.botIds.map((id) => `<@${ id }>`).join(", ") || "no bots configured"
    const envLabel = config.isProduction ? "production" : "development"
    await channel.send(
      `🟢 [${ envLabel }] health-check watchdog is online, monitoring ${ mentions } ` +
      `(checking every ${ Math.round(config.checkIntervalMs / 1000) }s)`,
    )
  } catch (err) {
    console.error("[index] failed to post startup message:", err)
  }
}