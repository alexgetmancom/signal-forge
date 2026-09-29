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
