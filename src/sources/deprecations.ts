import type { Fetch } from "../delivery.js";
import type { Collection, RecordData } from "../events.js";
import { fetchText } from "./http.js";

/**
 * Retirement dates. Every other stream here reports something new to try; this one reports work a
 * reader has to schedule, because a model they depend on stops answering on a date. Both vendors
 * publish the page as markdown, which is why this parses text rather than a rendered page.
 */

/** `### 2026-08-26: Transcription models` — the announcement heading OpenAI uses. */
const ANNOUNCEMENT = /^###\s+(\d{4}-\d{2}-\d{2}):\s*(.+)$/;

export function parseOpenAIDeprecations(markdown: string): Collection {
  const lines = markdown.split("\n");
  const records: RecordData[] = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = ANNOUNCEMENT.exec(lines[index] ?? "");
    if (!heading) continue;
    const [, date, title] = heading;
    if (!date || !title) continue;
    // The first prose paragraph after the heading carries the models and the shutdown date.
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && body.length < 4; cursor++) {
      const line = (lines[cursor] ?? "").trim();
      if (line.startsWith("#")) break;
      if (!line || line.startsWith("|") || line.startsWith("<")) continue;
      body.push(line);
    }
    records.push({
      id: `${date}-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      name: `${title} (announced ${date})`,
      url: "https://platform.openai.com/docs/deprecations",
      maker: "OpenAI",
      summary: body.join(" ").slice(0, 800),
    });
  }
  if (!records.length) throw new Error("Public page no longer exposes deprecation announcements");
  return {
    source: "openai-deprecations",
    stream: "deprecations",
    url: "https://platform.openai.com/docs/deprecations",
    raw: records,
    // Announcements are historical record: one leaving the page would be an edit to history, not
    // a retraction we should report as a removal.
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

export async function collectOpenAIDeprecations(request: Fetch = fetch): Promise<Collection> {
  // platform.openai.com redirects the markdown to developers.openai.com, a different origin, which
  // the fetcher refuses on purpose; the final address is used directly.
  return parseOpenAIDeprecations(
    await fetchText("https://developers.openai.com/api/docs/deprecations.md", {}, request),
  );
}

/** One row of Anthropic's model status table: name, state, deprecation date, retirement date. */
const STATUS_ROW = /^\|\s*([a-z0-9.-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

export function parseAnthropicDeprecations(markdown: string): Collection {
  const records: RecordData[] = [];
  for (const line of markdown.split("\n")) {
    const row = STATUS_ROW.exec(line);
    if (!row) continue;
    const [, model, state, deprecated, retirement] = row;
    if (!model || !state || !model.startsWith("claude")) continue;
    records.push({
      id: model,
      name: model,
      url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      maker: "Anthropic",
      // The state is the story: Active → Deprecated → Retired, with the date moving as it goes.
      stage: state,
      deprecated: deprecated === "N/A" ? null : deprecated,
      retirement: retirement ?? null,
    });
  }
  if (!records.length) throw new Error("Public page no longer exposes the model status table");
  return {
    source: "anthropic-deprecations",
    stream: "deprecations",
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    raw: records,
    // A model dropping off the table has been retired long ago; the retirement itself was already
    // reported as a change of state.
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

export async function collectAnthropicDeprecations(request: Fetch = fetch): Promise<Collection> {
  // docs.claude.com redirects to platform.claude.com — a different origin, which the fetcher
  // refuses on purpose, so the final address is used directly.
  return parseAnthropicDeprecations(
    await fetchText("https://platform.claude.com/docs/en/about-claude/model-deprecations.md", {}, request),
  );
}
