import type { Database } from "bun:sqlite";

/**
 * What the field talked about that nothing we collect saw.
 *
 * On 2026-09-19 the week was compared with Hacker News by hand, and that is how "Mistral X Mozilla",
 * "Claude Cowork and chat are now one Claude" and NVIDIA's CUDA for Rust were found missing: each
 * was a front-page story about a vendor this tracker follows, and no other source held a record of
 * it. The Hacker News collector already keeps only stories that name a followed vendor, so every
 * one of its stories is a question with a checkable answer: did anything else see this?
 *
 * A story is covered when another source holds the same link, or when another source recorded
 * something in the days around it whose name shares two significant words with the headline.
 * Words are a blunt instrument, so the report lists candidates for a person to read, never a verdict,
 * and it errs towards calling a story covered: a false gap costs a minute, a hidden one costs the
 * point of having the report.
 */
export type CoverageGap = { title: string; url: string | null; discussion: string | null; seenAt: string };

const STOPWORDS = new Set(
  (
    "the and for with from into that this your their about what when will more than have been over " +
    "into after before under using used uses just only also make made makes most much many into ai llm " +
    "llms model models agent agents new now how why its it's are was were can not all one two you our " +
    "openai anthropic google deepmind gemini claude gpt grok xai mistral meta nvidia qwen alibaba deepseek " +
    "moonshot kimi microsoft apple amazon z.ai glm show ask introducing announcing launch launches"
  ).split(" "),
);
/** Versions are the most telling token a headline has: "3.8" names one model and not its sibling. */
function significant(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^a-z0-9.]+/)
      .map((word) => word.replace(/^\.+|\.+$/g, ""))
      .filter((word) => (word.length >= 4 || /\d/.test(word)) && !STOPWORDS.has(word)),
  );
}

function normalisedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

const AROUND_MS = 7 * 24 * 3_600_000;
const AFTER_MS = 2 * 24 * 3_600_000;

export function coverageGaps(
  db: Database,
  days = 7,
  now = Date.now(),
): { since: string; stories: number; covered: number; gaps: CoverageGap[] } {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const discussed = db
    .query<{ after_json: string; detected_at: string }, [string]>(
      "SELECT after_json, detected_at FROM events WHERE source='hackernews' AND kind='new' AND detected_at>=? ORDER BY id",
    )
    .all(since);
  const others = db
    .query<{ after_json: string | null; before_json: string | null; detected_at: string }, [string]>(
      "SELECT after_json, before_json, detected_at FROM events WHERE source<>'hackernews' AND detected_at>=?",
    )
    .all(new Date(Date.parse(since) - AROUND_MS).toISOString())
    .map((row) => {
      const record = JSON.parse(row.after_json ?? row.before_json ?? "{}") as Record<string, unknown>;
      return {
        at: Date.parse(row.detected_at),
        url: normalisedUrl(record.url),
        words: significant(`${String(record.name ?? "")} ${String(record.id ?? "")}`.replaceAll(/[-_/]/g, " ")),
      };
    });
  const links = new Set(others.map((other) => other.url).filter(Boolean));
  const gaps: CoverageGap[] = [];
  for (const row of discussed) {
    const story = JSON.parse(row.after_json) as Record<string, unknown>;
    const title = String(story.name ?? "");
    const url = normalisedUrl(story.url);
    if (url && links.has(url)) continue;
    const at = Date.parse(row.detected_at);
    const words = significant(title);
    const seen = others.some((other) => {
      if (other.at < at - AROUND_MS || other.at > at + AFTER_MS) return false;
      let shared = 0;
      for (const word of words) if (other.words.has(word) && ++shared >= 2) return true;
      return false;
    });
    if (!seen)
      gaps.push({
        title,
        url: typeof story.url === "string" ? story.url : null,
        discussion: typeof story.discussion === "string" ? story.discussion : null,
        seenAt: row.detected_at,
      });
  }
  return { since, stories: discussed.length, covered: discussed.length - gaps.length, gaps };
}
