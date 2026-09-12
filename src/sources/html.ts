const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  ldquo: "“",
  lsquo: "‘",
  mdash: "—",
  ndash: "–",
  rdquo: "”",
  rsquo: "’",
};

/** Decode the small HTML entity set used by public source pages without executing page content. */
export function decodeHtml(value: string): string {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return NAMED_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
    })
    .replace(/\u200b/g, "");
}

/** Convert source HTML to one readable line while ignoring scripts, markup, and layout whitespace. */
export function htmlText(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>(?=\s*)/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

/** Reads one attribute out of a raw HTML tag's attribute string. */
export function attribute(attributes: string, name: string): string | null {
  return attributes.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] ?? null;
}
