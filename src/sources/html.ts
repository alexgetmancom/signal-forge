import { SourceError } from "../failure.js";

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

/** React Flight's encoding of the value `undefined`. See the note inside `nextData`. */
const FLIGHT_UNDEFINED = "$undefined";

/**
 * A value embedded in a React server-rendered page, read without running the page.
 *
 * Next.js streams the data its components were rendered from as a series of `self.__next_f.push`
 * chunks. Reading the value the page already shows is the difference between parsing rendered
 * markup -- which changes with every style tweak -- and reading the record the page was built from.
 */
export function nextData(html: string, key: string): unknown {
  let stream = "";
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/g)) {
    const chunk: unknown = JSON.parse(match[1] ?? "null");
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") stream += chunk[1];
  }
  const search = (value: unknown): unknown => {
    if (value && typeof value === "object") {
      if (!Array.isArray(value) && Object.hasOwn(value, key)) {
        const found = (value as Record<string, unknown>)[key];
        // A key that is present and holds nothing is not an answer.
        //
        // React Flight writes the value `undefined` as the string `"$undefined"`, and arena.ai sends
        // exactly that whenever it renders the page without the roster and lets the client fetch it.
        // Returning the placeholder made the parse fail with "response did not match the schema",
        // which is a sentence about our reader and sent whoever read it to the wrong file: measured
        // on production, 30 of arena's 178 attempts in the three days to 2026-09-25 were this, and
        // every one of them said `ZodError`. It is the same case as the key being absent, and it is
        // reported as such -- the page did not carry it this time.
        if (found !== FLIGHT_UNDEFINED) return found;
      }
      for (const nested of Object.values(value)) {
        const found = search(nested);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const line of stream.split("\n")) {
    const text = line.slice(line.indexOf(":") + 1);
    if (!text.startsWith("[") && !text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const found = search(parsed);
    if (found !== undefined) return found;
  }
  throw new SourceError("missing-content", `Public page no longer exposes ${key}`, { evidence: { key } });
}
