import { Client, GatewayIntentBits, Partials } from "discord.js"
import { config } from "./config"

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

export async function start_bot(): Promise<void> {
  client.once("clientReady", (readyClient) => {
    console.log(`[bot] logged in as ${ readyClient.user.tag }`)
  })

  client.on("error", (error) => {
    console.error("[bot] client error:", error)
  })

  await client.login(config.discordToken)
}
