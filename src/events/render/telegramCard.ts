import type { Banner } from "./banner.js";
import { isPortrait } from "./logos.js";

/**
 * A Telegram message told from the same card Discord gets. The cards are written once, as Discord
 * embeds, and the words, links and pictures carry over: a title in bold, the post as a quote, the
 * banner as the photo above them. What Telegram has no place for stays behind: the stripe's colour,
 * a maker's tile in the corner, a role mention.
 */
export type TelegramMessage = {
  html: string;
  /** The picture the message is sent as: a banner drawn at send time, or a file beside the logos. */
  photo: { banner: Banner } | { filename: string } | null;
};

/** Telegram counts a caption's visible characters, not its markup. */
export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT = 4096;

type Embed = {
  title?: string;
  url?: string;
  description?: string;
  author?: { name?: string };
  fields?: { name: string; value: string }[];
  footer?: { text?: string };
  image?: { url?: string };
  thumbnail?: { url?: string };
};

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const two = (value: number) => String(value).padStart(2, "0");

/** Discord draws a timestamp in each reader's own time; Telegram gets UTC and a count of hours. */
function timestamps(text: string, now: number): string {
  return text
    .replace(/<t:(\d+):t> your time/g, "<t:$1:t>")
    .replace(/<t:(\d+):([tTdDfFR])>/g, (_match, seconds: string, style: string) => {
      const at = new Date(Number(seconds) * 1000);
      if (style === "R") {
        const minutes = Math.round((at.getTime() - now) / 60_000);
        const span = Math.abs(minutes);
        const amount =
          span < 60 ? `${span} min` : span < 48 * 60 ? `${Math.round(span / 60)} h` : `${Math.round(span / 1440)} days`;
        return minutes >= 0 ? `in ${amount}` : `${amount} ago`;
      }
      const clock = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
      const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
      return style === "t" || style === "T" ? clock : style === "d" || style === "D" ? day : `${day}, ${clock}`;
    });
}

/** Discord markdown as Telegram HTML: the text is escaped first, then the marks become tags. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
    )
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_(?!\s)(.+?)_(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function block(text: string, now: number): string {
  const lines = timestamps(text, now).split("\n");
  const out: string[] = [];
  let quote: string[] = [];
  const close = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };
  for (const line of lines) {
    const quoted = line.match(/^>>?>? ?(.*)$/);
    if (quoted) {
      quote.push(inline(quoted[1] ?? ""));
      continue;
    }
    close();
    const heading = line.match(/^#{1,3} (.*)$/);
    const small = line.match(/^-# (.*)$/);
    out.push(
      heading ? `<b>${inline(heading[1] ?? "")}</b>` : small ? `<i>${inline(small[1] ?? "")}</i>` : inline(line),
    );
  }
  close();
  return out.join("\n");
}

/** How much of the message a reader sees, which is what Telegram's limits count. */
export const visibleLength = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").length;

function embedHtml(embed: Embed, now: number): string {
  const title = embed.title
    ? embed.url
      ? `<b><a href="${escapeHtml(embed.url)}">${escapeHtml(embed.title)}</a></b>`
      : `<b>${escapeHtml(embed.title)}</b>`
    : "";
  const fields = (embed.fields ?? []).map((field) => `<b>${inline(field.name)}</b>\n${block(field.value, now)}`);
  return [
    embed.author?.name ? `<i>${escapeHtml(embed.author.name)}</i>` : "",
    title,
    embed.description ? block(embed.description, now) : "",
    ...fields,
    embed.footer?.text ? `<i>${escapeHtml(timestamps(embed.footer.text, now))}</i>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const attachment = (url: string | undefined) => url?.match(/^attachment:\/\/(.+)$/)?.[1] ?? null;

/**
 * The picture a message is sent with: a banner or a poster when one card carries it, or a person's
 * photo. A maker's tile is left off; as a photo it would fill the screen above one line of text.
 */
function photoOf(embeds: Embed[], banners: Banner[]): TelegramMessage["photo"] {
  if (embeds.length !== 1) return null;
  const embed = embeds[0] as Embed;
  const image = attachment(embed.image?.url);
  const banner = banners.find((candidate) => candidate.filename === image);
  if (banner) return { banner };
  const thumbnail = attachment(embed.thumbnail?.url);
  return thumbnail && isPortrait(thumbnail) ? { filename: thumbnail } : null;
}

/** A stored Discord body, `{content, embeds, banners}`, as the Telegram message that tells the same. */
export function telegramMessage(body: string, now = Date.now()): TelegramMessage {
  if (!body.startsWith("{")) return { html: escapeHtml(body), photo: null };
  const payload = JSON.parse(body) as { content?: string; embeds?: Embed[]; banners?: Banner[] };
  const embeds = payload.embeds ?? [];
  // A role mention names a Discord role; in Telegram it is a string of digits.
  const content = (payload.content ?? "").replace(/<@&\d+>/g, "").trim();
  const html = [content ? block(content, now) : "", ...embeds.map((embed) => embedHtml(embed, now))]
    .filter(Boolean)
    .join("\n\n");
  return { html, photo: photoOf(embeds, payload.banners ?? []) };
}

/** A message past Telegram's limit loses its markup rather than a closing tag: plain text, clipped. */
export function clipHtml(html: string): string {
  const plain = html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return escapeHtml(`${plain.slice(0, TEXT_LIMIT - 1)}…`);
}
