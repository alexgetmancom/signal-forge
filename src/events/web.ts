const WEB_SIGNAL_TERMS =
  /\b(Claude|model|agent|Cowork|Code|browser|connector|plugin|skill|MCP|API|usage|context|remote|project|worktree|GitHub|Slack|memory|plan|tool|SSH|Bedrock|security|permission|approval)\b/i;

/** Turn Markdown-shaped source paragraphs into readable notification evidence. */
export function normalizeWebString(value: string): string {
  return value
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
