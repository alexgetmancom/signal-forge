/**
 * What Discord accepts in one embed, and the last pass every board goes through to stay inside it.
 *
 * The limits live here rather than beside any one board because the board that crosses them is
 * whichever one grew last: the status board did it at 104 visible collectors and then froze at
 * whatever it had last said. The three colours are here for the same reason -- a board that picks
 * its own green is a channel where green means two things.
 */
import { clip } from "../text.js";

export const COLORS = { ok: 0x2ecc71, degraded: 0xf1c40f, down: 0xe74c3c };
/**
 * Discord's own limits on one embed. They are not advisory: an embed one character over is a 400,
 * and a board that cannot be edited freezes at whatever it last said. The status board crossed 6000
 * characters at 104 visible collectors and stopped moving, which nothing noticed for as long as it
 * took somebody to read the timestamps on it.
 */
export const EMBED_CHARACTER_LIMIT = 6000;
const EMBED_FIELD_LIMIT = 25;
const FIELD_VALUE_LIMIT = 1024;
const DESCRIPTION_LIMIT = 4096;

type EmbedField = { name: string; value: string; inline: boolean };

export function embedLength(embed: Record<string, unknown>): number {
  const text = (value: unknown) => (typeof value === "string" ? value.length : 0);
  const fields = (embed.fields as EmbedField[] | undefined) ?? [];
  return (
    text(embed.title) +
    text(embed.description) +
    text((embed.footer as { text?: string } | undefined)?.text) +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/**
 * The last thing a board passes through, so no render can exceed what Discord accepts. Trimming
 * loses information and says so in the board itself; the alternative is an embed that is rejected
 * whole, which loses all of it silently.
 */
export function fitEmbed(embed: Record<string, unknown>): Record<string, unknown> {
  const fitted = { ...embed };
  if (typeof fitted.description === "string") fitted.description = clip(fitted.description, DESCRIPTION_LIMIT);
  const fields = (
    ((fitted.fields as EmbedField[] | undefined) ?? []).map((field) => ({
      ...field,
      value: clip(field.value, FIELD_VALUE_LIMIT),
    })) satisfies EmbedField[]
  ).slice();

  let dropped = 0;
  const marker = (count: number): EmbedField => ({
    name: "…",
    value: `${count} more section${count === 1 ? "" : "s"} not shown — run \`status\` for the full list`,
    inline: false,
  });
  const reserve = marker(fields.length).name.length + marker(fields.length).value.length;
  // Nothing is dropped when everything fits; the marker's room is only reserved once it is needed.
  const fits = fields.length <= EMBED_FIELD_LIMIT && embedLength({ ...fitted, fields }) <= EMBED_CHARACTER_LIMIT;
  while (
    !fits &&
    fields.length > 0 &&
    (fields.length + 1 > EMBED_FIELD_LIMIT ||
      // The marker is appended after the loop, so its room is kept on every pass, not only the first:
      // releasing it once a section was dropped let a 6,038-character board through on 2026-09-17.
      embedLength({ ...fitted, fields }) + reserve > EMBED_CHARACTER_LIMIT)
  ) {
    fields.pop();
    dropped += 1;
  }
  if (dropped) fields.push(marker(dropped));
  fitted.fields = fields;
  return fitted;
}
