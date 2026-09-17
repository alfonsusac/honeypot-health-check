import { Client, GatewayIntentBits, Partials, SlashCommandBuilder } from "discord.js"
import type { Interaction } from "discord.js"
import { config } from "./config"
import { get_cache_size_bytes } from "./cache"
import { get_runtime_memory } from "./runtime"

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

const health_command = new SlashCommandBuilder()
  .setName("health")
  .setDescription("Show this watchdog's cache and memory usage")

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
  client.application?.commands.set([ health_command ], config.guildId).catch((error) => {
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

export async function start_bot(): Promise<void> {
  client.once("clientReady", (readyClient) => {
    console.log(`[bot] logged in as ${ readyClient.user.tag }`)
    register_commands()
  })

  client.on("interactionCreate", (interaction) => {
    reply_to_health_command(interaction).catch((error) => {
      console.error("[bot] failed to handle /health:", error)
    })
  })

  client.on("error", (error) => {
    console.error("[bot] client error:", error)
  })

  await client.login(config.discordToken)
}
