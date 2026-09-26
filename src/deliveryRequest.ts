/**
 * 8 declarations moved out of delivery.ts unchanged.
 *
 * Say here what they have in common, because that is the only reason this file exists.
 */
import { type AppConfig, type Destination, destinationSchema } from "./config.js";
import { type Banner, bannerPng } from "./events/render/banner.js";
import { logoFiles } from "./events/render/logos.js";
import { CAPTION_LIMIT, clipHtml, TEXT_LIMIT, telegramMessage, visibleLength } from "./events/render/telegramCard.js";
import { log } from "./logger.js";

export type Job = { id: number; destination_json: string; body: string; attempts: number };

export type PreparedDelivery = {
  destination: Destination;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Evidence too long for a card, and the logos its cards show, travel as files beside it. */
  files?: { filename: string; content: string | Uint8Array }[];
};

/** Discord's limit on the files one message carries. */
const MAX_FILES = 10;
/** A card keeps a logo only when its message carries the file; Discord shows nothing for the rest. */
function withoutMissingLogos(embed: Record<string, unknown>, carried: Set<string>): Record<string, unknown> {
  const missing = (url: unknown) =>
    typeof url === "string" && url.startsWith("attachment://") && !carried.has(url.slice("attachment://".length));
  const { thumbnail, image, author, ...rest } = embed as {
    thumbnail?: { url?: unknown };
    image?: { url?: unknown };
    author?: { icon_url?: unknown };
  };
  const { icon_url, ...name } = author ?? {};
  return {
    ...rest,
    ...(thumbnail && !missing(thumbnail.url) ? { thumbnail } : {}),
    ...(image && !missing(image.url) ? { image } : {}),
    ...(author ? { author: missing(icon_url) ? name : author } : {}),
  };
}

/** Discord takes a message and its files as one multipart request with the payload as a field. */
export function multipart(prepared: PreparedDelivery): FormData {
  const form = new FormData();
  // Telegram takes each field as its own part and the photo by name; Discord takes one JSON part.
  if (prepared.destination.platform === "telegram") {
    for (const [key, value] of Object.entries(prepared.body as Record<string, unknown>))
      if (value !== undefined) form.append(key, String(value));
    const [photo] = prepared.files ?? [];
    if (photo) form.append("photo", new Blob([photo.content], { type: "image/png" }), photo.filename);
    return form;
  }
  form.append("payload_json", JSON.stringify(prepared.body));
  (prepared.files ?? []).forEach((file, index) => {
    const type = typeof file.content === "string" ? "text/plain" : "image/png";
    form.append(`files[${index}]`, new Blob([file.content], { type }), file.filename);
  });
  return form;
}

/** A card too long for a caption is sent as text; a picture is a caption's worth of message. */
async function telegramRequest(
  job: Job,
  destination: Extract<Destination, { platform: "telegram" }>,
  config: AppConfig,
): Promise<PreparedDelivery> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("missing Telegram token");
  const message = telegramMessage(job.body);
  const text = visibleLength(message.html) > TEXT_LIMIT ? clipHtml(message.html) : message.html;
  let photo: { filename: string; content: Uint8Array } | null = null;
  if (message.photo && visibleLength(text) <= CAPTION_LIMIT) {
    try {
      photo =
        "banner" in message.photo
          ? {
              filename: message.photo.banner.filename,
              content: await bannerPng(message.photo.banner, config.signature),
            }
          : (logoFiles(`attachment://${message.photo.filename}`)[0] ?? null);
    } catch (failure) {
      log("warn", "Banner not drawn", { error: failure instanceof Error ? failure.message : String(failure) });
    }
  }
  const base = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
  const common = { chat_id: destination.chatId, message_thread_id: destination.topicId, parse_mode: "HTML" };
  return photo
    ? { destination, url: `${base}/sendPhoto`, headers: {}, body: { ...common, caption: text }, files: [photo] }
    : {
        destination,
        url: `${base}/sendMessage`,
        headers: { "content-type": "application/json" },
        body: { ...common, text, link_preview_options: { is_disabled: true } },
      };
}

/** Evidence, banners and logos travel beside the embeds, in that order of claim on the ten files. */
async function discordRequest(
  job: Job,
  destination: Extract<Destination, { platform: "discord" }>,
  config: AppConfig,
): Promise<PreparedDelivery> {
  if (!config.DISCORD_BOT_TOKEN) throw new Error("missing Discord token");
  const parsed = job.body.startsWith("{") ? (JSON.parse(job.body) as Record<string, unknown>) : { content: job.body };
  const {
    files: text = [],
    banners = [],
    ...payload
  } = parsed as Record<string, unknown> & { files?: { filename: string; content: string }[]; banners?: Banner[] };
  const evidence: { filename: string; content: string | Uint8Array }[] = [...text];
  // A banner that fails to draw costs the card its picture, never the message.
  for (const banner of banners.slice(0, MAX_FILES - evidence.length)) {
    try {
      evidence.push({ filename: banner.filename, content: await bannerPng(banner, config.signature) });
    } catch (failure) {
      log("warn", "Banner not drawn", { error: failure instanceof Error ? failure.message : String(failure) });
    }
  }
  // Evidence first: a logo is decoration, and one that does not fit is taken off the card.
  const logos = logoFiles(payload).slice(0, Math.max(0, MAX_FILES - evidence.length));
  const carried = new Set([...logos, ...evidence].map((file) => file.filename));
  if (Array.isArray(payload.embeds))
    payload.embeds = (payload.embeds as Record<string, unknown>[]).map((embed) => withoutMissingLogos(embed, carried));
  const files = [...evidence, ...logos];
  // SUPPRESS_EMBEDS (4) hides every embed on the message, our own included — setting it on a
  // message built out of embeds delivers a bare header and nothing else.
  const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
  return {
    destination,
    url: `https://discord.com/api/v10/channels/${destination.channelId}/messages`,
    // A multipart request carries its own boundary, so the content type is left to fetch.
    headers: {
      ...(files.length ? {} : { "content-type": "application/json" }),
      Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
    },
    body: {
      allowed_mentions: { parse: [] },
      ...payload,
      ...(hasEmbeds ? {} : { flags: 4 }),
      nonce: `sf-${job.id}`,
      enforce_nonce: true,
    },
    ...(files.length ? { files } : {}),
  };
}

/**
 * The job's stored destination and body as one request, or a throw.
 *
 * Everything here happens before the provider is spoken to, so every failure it can have is a
 * local one the caller records as `failed`: an outcome cannot be ambiguous when no request was
 * made. Nothing in here may send.
 */
export async function prepareRequest(job: Job, config: AppConfig): Promise<PreparedDelivery> {
  const destination = destinationSchema.parse(JSON.parse(job.destination_json));
  return destination.platform === "telegram"
    ? await telegramRequest(job, destination, config)
    : await discordRequest(job, destination, config);
}
