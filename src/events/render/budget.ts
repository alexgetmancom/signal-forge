/**
 * Discord counts the visible text of every embed in a message against one budget. A page of ten
 * embeds that each carry a long description is a valid request by every per-embed limit and is
 * still rejected as a whole, which used to mean an hourly digest was quietly never delivered.
 */
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
 * The embeds one message carries, and the ones left over for its footer.
 *
 * A message carries one card. Fifteen documentation pages that changed because Codex started
 * naming gpt-6-sol are one thing that happened, and on 2026-09-22 they arrived as fifteen embeds
 * across two messages in the scouts room: a wall is skipped whole, which loses the card in it that
 * mattered. A digest of separate stories may show a few, and the rest of either travel as links on
 * one line rather than as another message nobody asked for.
 */
/** `budget` is the platform's budget: Telegram fits a message of cards in 4096 where Discord fits 6000. */
export function oneMessage(embeds: Embed[], budget = MESSAGE_CHARACTERS, cap = 1): { page: Embed[]; extra: Embed[] } {
  const page: Embed[] = [];
  let characters = 0;
  for (const embed of embeds) {
    if (page.length >= cap) break;
    const fitted = fitAlone(embed);
    const size = embedCharacters(fitted);
    if (page.length > 0 && characters + size > budget) break;
    page.push(fitted);
    characters += size;
  }
  return { page, extra: embeds.slice(page.length) };
}
