/**
 * Whether a reader can call this model today.
 *
 * The question a week's arrivals and the report of what was passed over both turn out to be asking,
 * and neither of them was asking it. Gemini 4 Argon was announced on 2026-09-30 and reached no
 * reader, which was the right answer for the wrong reason: a blog post is not a stream that lists
 * models, so the rule that kept it quiet was about where the sentence came from rather than about
 * what a reader could do with it. The day the same model appears in a catalogue behind an access
 * request, that rule passes it.
 *
 * So the rule is written as the question: a catalogue says a model can be called, unless the
 * catalogue's own words say it cannot. Both halves are read off the record, because an availability
 * nobody published is not one this service can claim to know.
 */
import type { RecordData } from "./types.js";

/**
 * The streams that list models a reader can reach. A board, a newsroom, a repository and a
 * documentation page all talk about models; these four are the ones that serve them.
 */
export const CATALOGUE_STREAMS: ReadonlySet<string> = new Set(["api-models", "openrouter", "weights"]);

/**
 * The words a catalogue uses for a listing nobody outside the maker can call.
 *
 * Measured on 2026-10-04: of 232 Vertex Model Garden rows, 152 are `GA`, 63 `PUBLIC_PREVIEW`, 14
 * `EXPERIMENTAL` and 2 `PRIVATE_PREVIEW`. A public preview and an experiment are callable today by
 * anybody who wants them, and are most of what a launch week is made of; a private preview is a
 * listing for an audience this channel's readers are not in.
 */
const UNREACHABLE_STAGES = ["private_preview", "allowlist", "waitlist", "request", "by_request"] as const;

/**
 * Weights behind an approval are still weights a reader cannot pull today.
 *
 * HuggingFace is the only source that publishes this, as `gated`, on 58 of 862 repositories. `open`
 * and `public` are the other two values, and anything unsaid is read as reachable: an absent field
 * is a source that does not answer the question, not a model behind a form.
 */
const UNREACHABLE_ACCESS = ["gated", "manual", "request"] as const;

/**
 * The same two lists as a condition SQLite can apply, over a column holding a record body.
 *
 * A read of "what had already arrived" is a read of the whole archive, which cannot come back here
 * as bodies to be asked one at a time. So the vocabulary is written once, above, and this is the
 * only other reader of it: a second list spelled into a query is a rule that holds until somebody
 * adds a word to one copy.
 */
export function reachableListingSql(body: string): string {
  const quoted = (words: readonly string[]) => words.map((word) => `'${word}'`).join(",");
  const stage = `COALESCE(json_extract(${body},'$.stage'),json_extract(${body},'$.launchStage'),json_extract(${body},'$.availability'),'')`;
  return (
    `replace(replace(lower(${stage}),' ','_'),'-','_') NOT IN (${quoted(UNREACHABLE_STAGES)})` +
    ` AND lower(COALESCE(json_extract(${body},'$.access'),'')) NOT IN (${quoted(UNREACHABLE_ACCESS)})`
  );
}

/** The `stage`, `access` or `availability` a record publishes about itself, lowercased. */
function wordsAboutAccess(record: RecordData | null): { stage: string; access: string } {
  const read = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
  return {
    stage: read(record?.stage ?? record?.launchStage ?? record?.availability),
    access: read(record?.access),
  };
}

/**
 * Null when a reader could call this today, and this vocabulary's own word for why not when they
 * could not. The word is one of the sets above and never the upstream string that matched it: a
 * reason is printed and counted, and nothing upstream belongs in either.
 *
 * Only a listing is asked: a record from a stream that does not serve models says nothing either
 * way, and answering "unreachable" for a blog post would make this rule the reason a newsroom post
 * is not an arrival, which it is not -- "Elevated errors affecting ChatGPT Work mode" is not a model
 * a reader is waiting to call.
 */
export function unreachableBecause(stream: string, record: RecordData | null): string | null {
  if (!CATALOGUE_STREAMS.has(stream)) return null;
  const { stage, access } = wordsAboutAccess(record);
  const flat = stage.replaceAll(/[\s-]+/g, "_");
  for (const word of UNREACHABLE_STAGES) if (word === flat) return word;
  for (const word of UNREACHABLE_ACCESS) if (word === access) return word;
  return null;
}

/**
 * Whether this event is the moment a listing a reader could not call became one they can.
 *
 * The other half of the gate, and the half that makes it a hold rather than a refusal. A catalogue
 * opening a model to everybody does not insert a row -- it edits the one it had -- so the opening is
 * a `changed` event, which no rule about arrivals would ever have looked at. That change is the news
 * a reader was waiting for, and the only date behind it is one this deployment watched happen, which
 * is stronger evidence than the usual "the first time we saw it".
 */
export function becameReachable(event: {
  stream: string;
  kind: string;
  before_json: string | null;
  after_json: string | null;
}): boolean {
  if (event.kind !== "changed") return false;
  const parse = (body: string | null): RecordData | null => {
    if (!body) return null;
    try {
      return JSON.parse(body) as RecordData;
    } catch {
      return null;
    }
  };
  const before = parse(event.before_json);
  if (!before) return false;
  return (
    unreachableBecause(event.stream, before) !== null &&
    unreachableBecause(event.stream, parse(event.after_json)) === null
  );
}
