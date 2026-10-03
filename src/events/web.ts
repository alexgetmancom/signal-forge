const WEB_SIGNAL_TERMS =
  /\b(Claude|model|agent|Cowork|Code|browser|connector|plugin|skill|MCP|API|usage|context|remote|project|worktree|GitHub|Slack|memory|plan|tool|SSH|Bedrock|security|permission|approval)\b/i;

/**
 * A string on a vendor's own site that tells something before it is announced: a versioned model
 * name, or the words a product uses for what is not out yet. "Opus 5 is in research preview" tells;
 * "A connector named ‘{name}’ already exists" is copy. Only the first kind is worth a scout.
 *
 * "Preview" tells as a stage, not as a verb: "Allow Claude to preview this page?" was the one tell
 * among 516 strings claude.ai added on 2026-09-18, and it reached the scouts.
 */
const TELLING_WEB_STRING =
  /\b(?:(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|grok|codex|llama|qwen|deepseek|kimi|glm|mistral)[\s-]?\d[\w.-]*|beta|(?:in|research|public|developer|early|limited) preview|preview(?=\))|coming soon|waitlist|early access|new model|introducing|now available)\b/i;

export function tellingWebString(value: string): boolean {
  return TELLING_WEB_STRING.test(normalizeWebString(value));
}

/** Turn Markdown-shaped source paragraphs into readable notification evidence. */
export function normalizeWebString(value: string): string {
  return value
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A string that says the thing it names is out.
 *
 * The caveat under a web diff -- "not shipped yet" -- was written for the whole `web` stream, and
 * the stream is where documentation diffs arrive too. On 2026-09-29 a Codex docs card carried
 * "GitHub code review is generally available" over a footer saying it had not shipped. A caveat
 * that contradicts the quote above it is worse than no caveat: it tells a reader the card cannot
 * read what it just printed.
 */
const SHIPPED_WEB_STRING =
  /\b(?:generally available|general availability|now available|available now|now live|is live|has shipped|now shipping|rolled out|rolling out|out now|now supports)\b/i;

export function saysItShipped(value: string): boolean {
  return SHIPPED_WEB_STRING.test(normalizeWebString(value));
}

export function meaningfulWebString(value: string): boolean {
  const normalized = normalizeWebString(value);
  if (normalized.length < 18 || normalized.length > 500 || /^[-+\d\s.,:;/()]+$/.test(normalized)) return false;
  return WEB_SIGNAL_TERMS.test(normalized);
}

/** Keep only user-facing web strings that can describe a product or capability change. */
export function selectMeaningfulWebStrings(values: readonly unknown[]): string[] {
  const selected = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeWebString(value);
    if (meaningfulWebString(normalized)) selected.add(normalized);
  }
  return [...selected].sort();
}

/**
 * A web change event keeps the strings that changed, not the page they changed on.
 *
 * `claude-web` publishes some four thousand interface strings and rewrites a handful of them per
 * deploy. The event stored the whole table twice -- once as `before_json`, once as `after_json` --
 * so on 2026-10-03 forty-two of them held 26 MB of a 47 MB `events` table and the largest single
 * one weighed 916 KB. Codex's docs held another 8.9 MB the same way.
 *
 * Every reader of these strings consumes `webStringChanges(before, after)`: the card quotes the
 * diff, the attachment carries the diff, the summariser is handed the diff, the scouts read what
 * the diff added. None of them reads the table for its own sake. Change detection does not read
 * the event at all -- it compares the `records` table, which keeps the current body per entity --
 * so narrowing an event cannot make the next collection miss a change.
 *
 * Each side therefore keeps only the raw strings the other side does not have. The two sides are
 * disjoint by construction, which makes `webStringChanges` of the narrowed pair return exactly
 * what it returned for the full tables, and makes narrowing idempotent: narrowing an already
 * narrowed pair changes nothing. The raw text is kept rather than the normalized form, because
 * `namesOnlyKnownModels` and `classify` match on the string as it was published.
 *
 * A side that is absent or is not a string table is left exactly as it was: a first sighting has
 * no `before_json` to diff against, and its `after_json` is the record's state rather than a change.
 */
export function narrowWebEvidence(before: string | null, after: string | null): [string | null, string | null] {
  const table = (json: string | null): (Record<string, unknown> & { strings: unknown[] }) | null => {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.strings)) return null;
      return parsed as Record<string, unknown> & { strings: unknown[] };
    } catch {
      return null;
    }
  };
  const previous = table(before);
  const current = table(after);
  if (!previous || !current) return [before, after];
  // Normalized for the comparison, because that is what every reader compares; raw in what is kept.
  const spoken = (strings: unknown[]): Set<string> =>
    new Set(
      strings
        .filter((value): value is string => typeof value === "string")
        .map(normalizeWebString)
        .filter(Boolean),
    );
  const previousSpoken = spoken(previous.strings);
  const currentSpoken = spoken(current.strings);
  const only = (strings: unknown[], others: Set<string>): string[] =>
    strings.filter((value): value is string => {
      if (typeof value !== "string") return false;
      const normalized = normalizeWebString(value);
      return Boolean(normalized) && !others.has(normalized);
    });
  return [
    JSON.stringify({ ...previous, strings: only(previous.strings, currentSpoken) }),
    JSON.stringify({ ...current, strings: only(current.strings, previousSpoken) }),
  ];
}
