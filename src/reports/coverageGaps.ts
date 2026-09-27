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

/**
 * A headline the matcher cannot judge. "Ask HN" and "Tell HN" are a reader's question, not news a
 * source could carry, and a headline with fewer than two significant words ("I hate you Microsoft",
 * "Hacking OpenAI") can never share two with anything, so it would be listed as a gap every week.
 * Both were most of the noise in the first report, on 2026-09-19.
 */
function unjudgeable(title: string, words: Set<string>): boolean {
  return /^(ask|tell) hn\b/i.test(title) || words.size < 2;
}

const AROUND_MS = 7 * 24 * 3_600_000;
const AFTER_MS = 2 * 24 * 3_600_000;

/**
 * One key of the record an event carries, as a column, so the body it lives in is never selected.
 *
 * This report claimed 62 MB of a floor that is never given back to answer with 8.5 KB, measured on
 * a copy of production 2026-09-27, and all of it was the two reads below: they selected
 * `after_json` and `before_json` whole for every event of fourteen days -- the week asked about and
 * the week of context around it -- to keep a URL and two short strings of each. The same mistake
 * `listStories` made, and the same fix: ask SQLite for what the answer is derived from.
 *
 * `json_valid` guards a body that is not JSON, which `json_extract` answers with an error where
 * `JSON.parse` answered by failing the whole report. `json_type` keeps only a scalar: an object
 * arrives from `json_extract` as its own JSON text, where `String()` produced `[object Object]`,
 * and a headline shares no significant word with either -- the two disagree only where neither is
 * a name.
 */
function keyColumn(body: string, key: string): string {
  const scalar = `json_valid(${body}) AND json_type(${body},'$.${key}') IN ('text','integer','real')`;
  return `CASE WHEN ${scalar} THEN json_extract(${body},'$.${key}') END AS ${key}`;
}

/** The keys of a Hacker News story this report reads, and nothing else it holds. */
const STORY_KEYS = ["name", "url", "discussion"] as const;
/** The keys of any other event, which are only ever reduced to a link and a set of words. */
const OTHER_KEYS = ["name", "id", "url"] as const;

type StoryRow = { [Key in (typeof STORY_KEYS)[number]]: unknown } & { detected_at: string };
type OtherRow = { [Key in (typeof OTHER_KEYS)[number]]: unknown } & { detected_at: string };

/**
 * Everything the other sources recorded around the window, as what the matcher asks of it.
 *
 * A word to the events that used it, rather than an event to its words. Both answer the same
 * question and the inverted one is the smaller half by a long way: a `Set` of words per event
 * stored "qwen" and "3.8" once for every event that mentioned them and paid a `Set`'s own overhead
 * fifteen thousand times over, which was 14 MB of a floor that is never given back for a read that
 * answers with 8.5 KB. Here each word is one string and one array of the positions that hold it.
 *
 * `at` is parallel to those positions and holds the only other thing the matcher needs, which is
 * when. Nothing else about an event survives building this.
 */
type Context = { at: number[]; links: Set<string>; byWord: Map<string, number[]> };

function contextAround(db: Database, since: string): Context {
  // `COALESCE` picks the body rather than the key, as identity does: a name from the new record
  // beside an id from the old one describes a record neither side ever held.
  const columns = OTHER_KEYS.map((key) => keyColumn("COALESCE(after_json,before_json)", key)).join(",");
  const rows = db
    .query<OtherRow, [string]>(
      `SELECT ${columns},detected_at FROM events WHERE source<>'hackernews' AND detected_at>=?`,
    )
    .iterate(since) as IterableIterator<OtherRow>;
  const context: Context = { at: [], links: new Set(), byWord: new Map() };
  for (const row of rows) {
    const index = context.at.push(Date.parse(row.detected_at)) - 1;
    const url = normalisedUrl(row.url);
    if (url) context.links.add(url);
    const subject = `${String(row.name ?? "")} ${String(row.id ?? "")}`.replaceAll(/[-_/]/g, " ");
    for (const word of significant(subject)) {
      const holding = context.byWord.get(word);
      if (holding) holding.push(index);
      else context.byWord.set(word, [index]);
    }
  }
  return context;
}

/**
 * Whether anything else recorded, in the days around this story, something whose name shares two
 * significant words with the headline. The same predicate the scan over every event answered, asked
 * only of the events that hold one of the words: a headline shares nothing with most of the week.
 */
function corroborated(context: Context, words: Set<string>, at: number): boolean {
  const shared = new Map<number, number>();
  for (const word of words)
    for (const index of context.byWord.get(word) ?? []) {
      const when = context.at[index] as number;
      if (when < at - AROUND_MS || when > at + AFTER_MS) continue;
      const count = (shared.get(index) ?? 0) + 1;
      if (count >= 2) return true;
      shared.set(index, count);
    }
  return false;
}

export function coverageGaps(
  db: Database,
  days = 7,
  now = Date.now(),
): { since: string; stories: number; covered: number; unjudged: number; gaps: CoverageGap[] } {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  // A story is always a `new` event, so its record is `after_json` and the old code read that
  // column and no other. Widening it to the older body here would answer about a different record.
  const storyColumns = STORY_KEYS.map((key) => keyColumn("after_json", key)).join(",");
  const discussed = db
    .query<StoryRow, [string]>(
      `SELECT ${storyColumns},detected_at
       FROM events WHERE source='hackernews' AND kind='new' AND detected_at>=? ORDER BY id`,
    )
    .all(since);
  const context = contextAround(db, new Date(Date.parse(since) - AROUND_MS).toISOString());
  const gaps: CoverageGap[] = [];
  let unjudged = 0;
  for (const row of discussed) {
    const title = String(row.name ?? "");
    const url = normalisedUrl(row.url);
    if (url && context.links.has(url)) continue;
    const words = significant(title);
    if (unjudgeable(title, words)) {
      unjudged++;
      continue;
    }
    if (!corroborated(context, words, Date.parse(row.detected_at)))
      gaps.push({
        title,
        url: typeof row.url === "string" ? row.url : null,
        discussion: typeof row.discussion === "string" ? row.discussion : null,
        seenAt: row.detected_at,
      });
  }
  return { since, stories: discussed.length, covered: discussed.length - gaps.length - unjudged, unjudged, gaps };
}
