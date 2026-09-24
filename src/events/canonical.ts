export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      // Codepoint order, not locale order: these bytes are the identity of a record, and
      // `localeCompare` answers to the runtime's ICU tables rather than to the data. Two hosts on
      // different ICU versions would disagree about what the same record is.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function splitMessage(text: string, limit = 1900): string[] {
  const parts: string[] = [];
  while (text.length > limit) {
    let end = text.lastIndexOf("\n", limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
    if (text.startsWith("\n")) text = text.slice(1);
  }
  if (text) parts.push(text);
  return parts;
}
