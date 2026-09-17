import { config } from "./lib/config"
import { client, start_bot } from "./lib/bot"
import { start_server } from "./lib/server"
import { append_result, get_latest_cache } from "./lib/cache"
import { perform_health_check } from "./lib/healthcheck"
import type { HealthCheckResult } from "./lib/types"

async function main() {
  await start_bot()
  start_server()
  console.log(`[server] listening on port ${ config.port }`)

  await post_startup_message()

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
  const previous = await get_latest_cache()
  const result = await perform_health_check(client, previous?.last_seen ?? null)
  await append_result(result)
  console.log(
    `[healthcheck] status=${ result.status } method=${ result.method } latency=${ result.latency_ms }ms`,
  )
  await post_log_summary(result)
}





async function post_log_summary(result: HealthCheckResult): Promise<void> {
  if (!config.logChannelId) return
  if (result.status !== "offline") return

  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    const emoji = "🔴"
    const latency = result.latency_ms !== null ? `${ result.latency_ms }ms` : "n/a"
    await channel.send({
      content: `@everyone ${ emoji } main bot status: **${ result.status }** (via ${ result.method }, latency ${ latency })` +
        (result.error ? `\n> ${ result.error }` : ""),
      allowedMentions: { parse: [ "everyone" ] },
    })
  } catch (err) {
    console.error("[index] failed to post log summary:", err)
  }
}

async function post_startup_message(): Promise<void> {
  if (!config.logChannelId) return

  try {
    const channel = await client.channels.fetch(config.logChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) return

    await channel.send(
      `🟢 health-check watchdog is online and monitoring <@${ config.mainBotId }> ` +
      `(checking every ${ Math.round(config.checkIntervalMs / 1000) }s)`,
    )
  } catch (err) {
    console.error("[index] failed to post startup message:", err)
  }
}