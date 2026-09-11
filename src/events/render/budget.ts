/**
 * Discord counts the visible text of every embed in a message against one budget. A page of ten
 * embeds that each carry a long description is a valid request by every per-embed limit and is
 * still rejected as a whole, which used to mean an hourly digest was quietly never delivered.
 */
export const EMBEDS_PER_MESSAGE = 10;
export const MESSAGE_CHARACTERS = 6000;
export const DESCRIPTION_CHARACTERS = 4000;

type Embed = Record<string, unknown>;

function length(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** The characters Discord counts for one embed: author, title, description, fields and footer. */
export function embedCharacters(embed: Embed): number {
  const author = embed.author as { name?: unknown } | undefined;
  const footer = embed.footer as { text?: unknown } | undefined;
  const fields = Array.isArray(embed.fields) ? (embed.fields as { name?: unknown; value?: unknown }[]) : [];
  return (
    length(author?.name) +
    length(embed.title) +
    length(embed.description) +
    length(footer?.text) +
    fields.reduce((total, field) => total + length(field.name) + length(field.value), 0)
  );
}

/**
 * Trims one embed's description until the embed fits the message budget on its own. The embed is
 * trimmed in place: callers pair an embed with the evidence file that belongs to it, and a copy
 * would break that pairing for exactly the largest cards.
 */
function fitAlone(embed: Embed): Embed {
  const overflow = embedCharacters(embed) - MESSAGE_CHARACTERS;
  if (overflow <= 0) return embed;
  const description = typeof embed.description === "string" ? embed.description : "";
  const keep = Math.max(0, description.length - overflow - 1);
  embed.description = keep > 0 ? `${description.slice(0, keep)}…` : "";
  return embed;
}

/**
 * Splits embeds into messages that respect both the count and the character budget. Order is
 * preserved, and no embed is dropped: one that cannot share a message gets one of its own.
 */
export function pageEmbeds(embeds: Embed[]): Embed[][] {
  const pages: Embed[][] = [];
  let page: Embed[] = [];
  let characters = 0;
  for (const embed of embeds) {
    const fitted = fitAlone(embed);
    const size = embedCharacters(fitted);
    if (page.length > 0 && (page.length >= EMBEDS_PER_MESSAGE || characters + size > MESSAGE_CHARACTERS)) {
      pages.push(page);
      page = [];
      characters = 0;
    }
    page.push(fitted);
    characters += size;
  }
  if (page.length) pages.push(page);
  return pages;
}
