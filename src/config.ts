import { readFileSync } from "node:fs";
import { z } from "zod";

export const streamSchema = z.enum([
  "api-models",
  "openrouter",
  "news",
  "arena",
  "leaderboards",
  "web",
  "github",
  "weights",
  "packages",
  "incidents",
  "deprecations",
]);
export type Stream = z.infer<typeof streamSchema>;
export const sourceModeSchema = z.enum(["active", "shadow"]);
export type SourceMode = z.infer<typeof sourceModeSchema>;
const streams = z.array(streamSchema).min(1);
export const destinationSchema = z.discriminatedUnion("platform", [
  z.object({
    id: z.string().min(1),
    platform: z.literal("telegram"),
    chatId: z.string().regex(/^-?\d+$/),
    topicId: z.number().int().positive().optional(),
    streams,
  }),
  z.object({ id: z.string().min(1), platform: z.literal("discord"), channelId: z.string().regex(/^\d+$/), streams }),
]);
export type Destination = z.infer<typeof destinationSchema>;
const optionalSecret = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BIND_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("./data/app.db"),
  CONFIG_PATH: z.string().default("./signal-forge.json"),
  MCP_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32).optional()),
  TELEGRAM_BOT_TOKEN: optionalSecret,
  DISCORD_BOT_TOKEN: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  HF_TOKEN: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
});
export const settingsSchema = z
  .object({
    pollSeconds: z.number().int().min(60).default(300),
    /** Optional collectors are requested by default; set a source to false to disable it deliberately. */
    sourceEnabled: z.record(z.string(), z.boolean()).default({}),
    /** A running source may collect evidence without creating subscriber delivery work. */
    sourceMode: z.record(z.string(), sourceModeSchema).default({}),
    destinations: z.array(destinationSchema).default([]),
    /** One Discord channel holding a status board that is edited in place, not a stream of posts. */
    statusChannelId: z.string().regex(/^\d+$/).optional(),
    /**
     * Vendor name (as `vendorOf` resolves it) to the Discord role that follows that vendor. A
     * subscriber picks the makers they care about instead of a channel they cannot filter.
     */
    vendorRoles: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
    /** Channel holding the platform status board, edited in place. Defaults to the status channel. */
    platformBoardChannelId: z.string().regex(/^\d+$/).optional(),
    /** Private channel for operational alerts: collector outages, not model news. */
    alertChannelId: z.string().regex(/^\d+$/).optional(),
    github: z
      .array(
        z.object({
          repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
          paths: z.array(z.string().min(1)).min(1),
        }),
      )
      .default([
        {
          repo: "openai/codex",
          paths: [
            "docs/",
            "codex-rs/core/models.json",
            "codex-rs/core/src/config/",
            "codex-rs/core/src/tools/",
            "codex-rs/protocol/",
          ],
        },
      ]),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.destinations.map((d) => d.id)).size !== v.destinations.length)
      ctx.addIssue({ code: "custom", message: "Destination IDs must be unique" });
    const addresses = v.destinations.map((d) =>
      d.platform === "telegram" ? `telegram:${d.chatId}:${d.topicId ?? 0}` : `discord:${d.channelId}`,
    );
    if (new Set(addresses).size !== addresses.length)
      ctx.addIssue({ code: "custom", message: "Each destination address must appear once; combine its streams" });
  });
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const config = envSchema.parse(env);
  const settings = settingsSchema.parse(JSON.parse(readFileSync(config.CONFIG_PATH, "utf8")));
  for (const d of settings.destinations) {
    if (d.platform === "telegram" && !config.TELEGRAM_BOT_TOKEN)
      throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram destinations");
    if (d.platform === "discord" && !config.DISCORD_BOT_TOKEN)
      throw new Error("DISCORD_BOT_TOKEN is required for Discord destinations");
  }
  return { ...config, ...settings };
}
export type AppConfig = ReturnType<typeof loadConfig>;
