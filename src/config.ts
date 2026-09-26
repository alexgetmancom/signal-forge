import { readFileSync } from "node:fs";
import { z } from "zod";
import { SIGNAL_CLASSES } from "./events/signals.js";

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
  "apps",
  "pages",
  "resets",
  "training",
  "markets",
]);
export type Stream = z.infer<typeof streamSchema>;
const sourceModeSchema = z.enum(["active", "shadow"]);
export type SourceMode = z.infer<typeof sourceModeSchema>;
/**
 * A destination subscribes to what its readers came for, not to the sources that happen to
 * produce it. `signalClass` derives the class of every event from the same evidence the card is
 * rendered from.
 */
const signals = z.array(z.enum(SIGNAL_CLASSES)).min(1);
export const destinationSchema = z.discriminatedUnion("platform", [
  z.object({
    id: z.string().min(1),
    platform: z.literal("telegram"),
    chatId: z.string().regex(/^-?\d+$/),
    topicId: z.number().int().positive().optional(),
    signals,
    /** As a Discord channel's: a Telegram topic reads the same cards, told in its markup. */
    detail: z.enum(["brief", "evidence"]).optional(),
  }),
  z.object({
    id: z.string().min(1),
    platform: z.literal("discord"),
    channelId: z.string().regex(/^\d+$/),
    signals,
    /**
     * How much of a card its readers get. `brief` is a news reader's card: what happened and the one
     * or two values behind it. `evidence` adds what a scout checks it against: raw ids, other names,
     * the strings that changed and how sure the source is. Which signals a channel carries is still
     * being decided, so the depth belongs to the channel rather than to the signal. Absent is
     * `evidence`, which is what every channel carried before readers were told apart.
     */
    detail: z.enum(["brief", "evidence"]).optional(),
  }),
]);
export type Destination = z.infer<typeof destinationSchema>;
const optionalSecret = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BIND_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("./data/app.db"),
  CONFIG_PATH: z.string().default("./signal-forge.json"),
  /** Where the nightly backup job leaves its archives and the marker it writes after verifying one. */
  BACKUP_DIRECTORY: z.string().default("./backups"),
  SOLO_PUBLISHER_MCP_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
      }, "Solo Publisher requires an HTTPS URL without credentials, query or fragment")
      .optional(),
  ),
  SOLO_PUBLISHER_MCP_TOKEN: optionalSecret,
  MCP_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32).optional()),
  TELEGRAM_BOT_TOKEN: optionalSecret,
  DISCORD_BOT_TOKEN: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  HF_TOKEN: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
  /** Jev, TypeSafe's judgement model: typed answers about events, stored beside the rules' class. */
  TYPESAFE_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  GOOGLE_CLOUD_SERVICE_ACCOUNT: optionalSecret,
  XAI_API_KEY: optionalSecret,
  ZAI_API_KEY: optionalSecret,
  MOONSHOT_API_KEY: optionalSecret,
  KIMI_API_KEY: optionalSecret,
  MISTRAL_API_KEY: optionalSecret,
  GROQ_API_KEY: optionalSecret,
  MINIMAX_API_KEY: optionalSecret,
  STEPFUN_API_KEY: optionalSecret,
  DASHSCOPE_API_KEY: optionalSecret,
  CEREBRAS_API_KEY: optionalSecret,
  MIMO_API_KEY: optionalSecret,
  POOLSIDE_API_KEY: optionalSecret,
  DEEPINFRA_API_KEY: optionalSecret,
  LLAMA_API_KEY: optionalSecret,
  AWS_ACCESS_KEY_ID: optionalSecret,
  AWS_SECRET_ACCESS_KEY: optionalSecret,
  ARTIFICIAL_ANALYSIS_API_KEY: optionalSecret,
});
export const settingsSchema = z
  .object({
    pollSeconds: z.number().int().min(60).default(300),
    /** Optional collectors are requested by default; set a source to false to disable it deliberately. */
    sourceEnabled: z.record(z.string(), z.boolean()).default({}),
    /** A running source may collect evidence without creating subscriber delivery work. */
    sourceMode: z.record(z.string(), sourceModeSchema).default({}),
    /**
     * Everything that is not a collector and can still be switched off: see src/features.ts for the
     * list, its defaults and what each one costs a reader. A key absent means the default, which is
     * why a retired feature stays in the file as `false` rather than as an edit to the code.
     */
    featureEnabled: z.record(z.string(), z.boolean()).default({}),
    destinations: z.array(destinationSchema).default([]),
    /**
     * A role for readers who follow every launch and codename rather than one vendor. It is
     * mentioned beside the vendor role, never instead of it, and never on routine movement.
     */
    allSignalsRole: z.string().regex(/^\d+$/).optional(),
    /**
     * The publication's own name, drawn small in the corner of every banner it sends. Cards are
     * screenshotted and passed on, and the signature is what carries a reader back to the site.
     * Left out, banners are unsigned: somebody else's install signs with their name or with nothing.
     */
    signature: z.string().min(1).max(40).optional(),
    /** One Discord channel holding a status board that is edited in place, not a stream of posts. */
    statusChannelId: z.string().regex(/^\d+$/).optional(),
    /**
     * Vendor name (as `vendorOf` resolves it) to the Discord role that follows that vendor. A
     * subscriber picks the makers they care about instead of a channel they cannot filter.
     */
    vendorRoles: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
    /** Channel holding the platform status board, edited in place. Defaults to the status channel. */
    platformBoardChannelId: z.string().regex(/^\d+$/).optional(),
    /**
     * How many readers it takes to vouch for an early signal.
     *
     * `radar` carries what is unconfirmed; whether a stranger should be shown it is a judgement, and
     * its readers are what makes it. An `ownerUserId` whose single like settled this alone was
     * dropped on 2026-09-20: it mattered while `radar` was hidden and promotion was the only way to
     * publish, and both channels are now open. A key left in the file is ignored.
     */
    promotion: z
      .object({
        // One pair, put under every card by the bot itself: a reader answers by pressing, not by
        // finding the right emoji.
        likeEmoji: z.string().min(1).default("👍"),
        dislikeEmoji: z.string().min(1).default("👎"),
        readerVotes: z.number().int().min(2).default(3),
      })
      .optional(),
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
            "codex-rs/models-manager/",
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
  if (Boolean(config.SOLO_PUBLISHER_MCP_URL) !== Boolean(config.SOLO_PUBLISHER_MCP_TOKEN))
    throw new Error("SOLO_PUBLISHER_MCP_URL and SOLO_PUBLISHER_MCP_TOKEN must be configured together");
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

/**
 * A credential this config actually declares, by name.
 *
 * `requiredCapabilities` used to be `string[]`, read with `config as unknown as Record<string,
 * unknown>`, so a misspelled credential was not an error anywhere: the capability simply never
 * reads as ready, the scheduler never asks for the source, and it appears as a source that has
 * never been polled -- the exact symptom this repository spent a session learning to name, and the
 * only one of its three causes that is a bug rather than a missing key. Spelled as a type, the
 * misspelling is a compile error instead.
 */
export type CredentialName = Extract<
  keyof AppConfig,
  `${string}_KEY` | `${string}_KEY_ID` | `${string}_TOKEN` | `${string}_SERVICE_ACCOUNT`
>;
