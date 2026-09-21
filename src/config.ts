export const botTargets: Record<string, {
  author: string;
  support_server: string;
  should_ping: boolean;
}> = {
  "1450060292716494940": { author: "risky", support_server: "https://discord.com/servers/riskys-server-894705593087049729", should_ping: true },
  "1491864770490532061": { author: "risky", support_server: "https://discord.com/servers/riskys-server-894705593087049729", should_ping: true },
  "1540722224288366682": { author: "risky", support_server: "https://discord.com/servers/riskys-server-894705593087049729", should_ping: true },
  "1477798978362933340": { author: "matt", support_server: "https://discord.gg/ZrFDT7quVq", should_ping: true },
  "1436973163211657278": { author: "giftedly", support_server: "https://discord.gg/PczBt78", should_ping: true },
  "1549993724249899098": { author: "alfon", support_server: "", should_ping: true },
}
export const watchdogConfig = {
  heartbeatIntervalMs: 150_000,
} as const;