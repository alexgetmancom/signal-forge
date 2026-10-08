/**
 * The same model wearing another name.
 *
 * A gateway, a thinking effort, a harness number, a date suffix and a vendor prefix are ways one
 * model is served rather than models of their own, and each of them arrived in the invited room as
 * an unidentified sighting. Every rule here asks one question -- is this a name we already know,
 * plus nothing that can name a different model -- so they share the word list that answers it and
 * the read of what this deployment already knows.
 */

import type { Database } from "bun:sqlite";
import { normalizeIdentity } from "./identity.js";
import { recordFor } from "./record.js";
import { isModelSighting } from "./signals.js";
import type { Event } from "./types.js";
import { vendorOfName, vendorSpelling } from "./vendors.js";

/**
 * The ways one model is served, as opposed to which model it is.
 *
 * `kimi-k3-gateway-max-v3` is Kimi K3 reached through a gateway at maximum thinking effort with the
 * third harness. An arena lists each wiring separately and each one arrived as an unidentified
 * sighting. These words can never distinguish two models, so a name that is a model we already know
 * plus only these is that model.
 */
const SERVING_WORDS = new Set([
  "gateway",
  "official",
  "api",
  "direct",
  "proxy",
  "harness",
  "endpoint",
  "chat",
  "thinking",
  "reasoning",
  "max",
  "high",
  "medium",
  "low",
  "effort",
  // Latency, not a model. `gpt-6-sol-medium-fast` answered in a Codex discussion on 2026-09-25,
  // three days after GPT-6 Sol was announced, and reached the radar as a sighting: `medium` was
  // already read as wiring and `fast` was not, so the pair together was a name nobody knew.
  // `flash` stays out: a maker sells Flash as its own model.
  "fast",
  "slow",
  // Search Arena lists Claude Opus 5 as `claude-opus-5-search`: the released model with a search
  // tool attached, two of them on 2026-09-18.
  "search",
  // The board is not the model. Arena seats one model on several boards and writes the board into
  // the entry: `step-5-preview-agent` and `step-5-preview-webdev` are StepFun's released model on
  // the agent and webdev boards, and on 2026-09-24 the two of them made a codename story about a
  // model the channel had already been told about four days earlier.
  "agent",
  "webdev",
  // Where a model is hosted, not which model it is. `claude-opus-5-5-vertex` reached the radar on
  // 2026-10-04 as a model no catalogue listed, thirteen days after Claude Opus 5.5 was released:
  // `gateway`, `proxy` and `direct` were read as wiring and the clouds that actually serve these
  // models were not, so every one of them named a stranger.
  "vertex",
  "bedrock",
  "azure",
  "sagemaker",
  "foundry",
]);

/** A number straight after the model's name is its version: `grok 4` + `6` is Grok 4.6, not a wiring of Grok 4. */
function servingTail(words: string[]): boolean {
  return (
    words.length > 0 &&
    !/^\d+$/.test(words[0] ?? "") &&
    // A maker's own name appended says which account answers, not which model does:
    // `claude-haiku-4-5-direct-anthropic` is Claude Haiku 4.5 reached on Anthropic's own key.
    // `vendorSpelling` answers only for a word that is a maker's name, where `vendorOfName` would
    // read `sol` as OpenAI and swallow half the tails there are.
    words.every((word) => SERVING_WORDS.has(word) || /^v?\d+$/.test(word) || vendorSpelling(word) !== null)
  );
}

/**
 * The words left once somebody else's namespace is taken off the front.
 *
 * `claude-gpt-6-astra` and `claude-gpt-6` are two routes a third-party multiplexer publishes to
 * OpenAI's model, written the way its own client addresses them; both reached the radar on
 * 2026-09-24 as sightings of models nobody had heard of, three weeks after GPT-6 Astra launched.
 * The tell is that the front of the name belongs to one maker and the rest to another: a maker
 * does not file its own model under a competitor's name, so a leading run that names a different
 * vendor is a namespace rather than part of the model.
 */
function withoutForeignNamespace(words: string[]): string[] | null {
  for (let taken = 1; taken < words.length; taken++) {
    const front = vendorOfName(words.slice(0, taken).join(" "));
    const rest = words.slice(taken);
    if (front !== "Unknown" && vendorOfName(rest.join(" ")) !== front) return rest;
  }
  return null;
}

/** Models something in this database already identifies, as normalized word lists. */
export function knownModelNames(db: Database): string[][] {
  const names = new Set<string>();
  for (const row of db
    .query<{ body: string }, []>(
      "SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights','deprecations')",
    )
    .all()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const value of [parsed.name, parsed.id])
      if (typeof value === "string" && value.trim()) {
        // A catalogue writes "DeepSeek: DeepSeek V4 Flash"; the maker's prefix is not part of the
        // model's name, and an arena never repeats it.
        const stripped = value.replace(/^[^:/]+[:/]\s*/, "");
        names.add(normalizeIdentity(stripped));
      }
  }
  return [...names].filter((name) => name.split(" ").length >= 2).map((name) => name.split(" "));
}

/**
 * True when this sighting is a known model with only its wiring around it.
 *
 * An arena seats one model per wiring and writes the wiring into the entry. A repository does the
 * same in its own dialect: `claude-haiku-4-5-direct-anthropic` in a litellm discussion and
 * `gpt-6-sol-medium-fast` in a Codex one are a routing alias and an effort setting, and both
 * reached the radar on 2026-09-25 headlined "is answering requests" -- one for a model released in
 * October 2025 that every catalogue carries, the other three days after its model was announced. A
 * model answering under a name we can already resolve is not a sighting of anything.
 */
export function isAnotherServing(event: Event, known: readonly string[][]): boolean {
  if (event.kind !== "new") return false;
  if (event.stream !== "arena" && !isModelSighting(event)) return false;
  const body = recordFor(event);
  // The wiring is written wherever the venue keeps its own key: `name` is the display name, and
  // step-5-preview's two seats differed only in `model`, so reading the name alone saw one model
  // twice and called it an unidentified sighting. A repository sighting keys the stage into
  // `entity_id` ("...:served"), which is why the record's own `model` is read beside it.
  const written = [body?.name, body?.model, body?.modelKey, event.entity_id].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const servesKnown = (words: string[]): boolean =>
    known.some(
      (model) =>
        words.length > model.length &&
        model.every((word, index) => words[index] === word) &&
        servingTail(words.slice(model.length)),
    );
  // A repository mention is a name somebody typed, not a row somebody published, so the plain case
  // counts there too: `gpt-6.0-sol` in a Codex issue on 2026-09-29 is exactly the GPT-6 Sol its
  // maker had been selling for a week, and "is answering requests" said it had been glimpsed. A
  // catalogue relisting a model it already lists is the separate question `isAnotherTierOfAListedModel`
  // asks, which is why an exact match still does not count for one.
  const isTheModelItself = (words: string[]): boolean =>
    isModelSighting(event) && known.some((model) => model.join(" ") === words.join(" "));
  return written.some((value) => {
    const words = normalizeIdentity(value).split(" ").filter(Boolean);
    if (isTheModelItself(words) || servesKnown(words)) return true;
    const inner = withoutForeignNamespace(words);
    // Nothing appended, only the namespace taken off: `claude-gpt-6` is exactly GPT-6.
    return inner !== null && (servesKnown(inner) || known.some((model) => model.join(" ") === inner.join(" ")));
  });
}

/**
 * Whether this row names a model this deployment already holds a record of -- the same knowledge
 * `isAnotherServing` acts on, offered as a fact rather than as a verdict.
 *
 * Jev judges every sighting with no memory of the ones before it, and the 31 events the rules held
 * back over the fourteen days to 2026-09-27 were held back almost entirely for knowing something it
 * could not: `already_out_at_its_maker` five times, `weights_published_long_ago` four,
 * `another_serving_of_a_known_model` on arena. Asked to rate a renamed variant or a second serving
 * it cannot do anything but rate the model, and arena is where the two readers disagree hardest
 * (worth 1.15 delivered against 1.95 held back). So the fact is handed over, one boolean, no value
 * from upstream: whether the name in front of it resolves to something already here.
 *
 * Wider than `isAnotherServing` in the one way that matters for a reader who is being told rather
 * than obeyed: an exact match counts. A row whose name *is* a known model is the plainest case of
 * already knowing it, and the suppression rule skips that case on purpose, because a catalogue
 * relisting a model it already lists is a different question from a venue serving one.
 */
export function namesAModelKnownHere(event: Event, known: readonly string[][]): boolean {
  const body = recordFor(event);
  const written = [body?.name, body?.model, body?.modelKey, event.entity_id].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return written.some((value) => {
    // The maker's prefix is not part of the name, exactly as `knownModelNames` strips it when it
    // reads a catalogue: `Qwen/Qwen-Image-2.1` is the repository, `qwen image 2 1` is the model.
    const words = normalizeIdentity(value.replace(/^[^:/]+[:/]\s*/, ""))
      .split(" ")
      .filter(Boolean);
    return known.some(
      (model) =>
        model.every((word, index) => words[index] === word) &&
        (words.length === model.length || servingTail(words.slice(model.length))),
    );
  });
}

/**
 * A dated snapshot or a billing tier of a model the same catalogue already lists.
 *
 * OpenAI listed `gpt-image-2.5-flare` and `gpt-image-2.5-flare-2026-09-08` in the collection of
 * 2026-09-09 17:07, and both reached the wire as launches: four cards for two models. OpenRouter
 * lists Mistral's models a second time as `:batch` rows -- five of them in one hour on 2026-09-10,
 * each a sighting in the invited room of a model that shipped months before. Either is news only
 * when the plain row is not there: a model can first appear as its snapshot, and that one speaks.
 * `-preview` is not a tier. Google launches under it.
 */
const TIER_SUFFIX = /(-\d{4}-\d{2}-\d{2}|:(batch|free|beta|extended|thinking|floor|nitro|online))$/i;

export function isAnotherTierOfAListedModel(db: Database, event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const plain = event.entity_id.replace(TIER_SUFFIX, "");
  if (plain === event.entity_id) return false;
  return Boolean(db.query("SELECT 1 FROM records WHERE source=? AND id=?").get(event.source, plain));
}

/**
 * The tail that says how big a picture is, not which model drew it.
 *
 * An image arena seats one model once per output size. `gemini-nano-banana-2.1-2k` arrived on
 * 2026-10-08 under Google's name with nothing announced, two days after `gemini-nano-banana-2.1`
 * had reached the scouts from the same board with the same provider and the same input and output
 * shape. The second card said the same thing as the first and spent the room's attention on a
 * resolution. A codename is worth telling once; the sizes it is served at are not sightings.
 */
const SIZE_TAIL = /^(?:\d+k|\d+p|\d+x\d+)$/;

/**
 * Whether an arena seat is a size of a name this arena has already shown us.
 *
 * Asked of the events rather than of the records, because an arena rotates its roster: the plain
 * `gemini-nano-banana-2.1` row was gone from the board by the time the 2k one appeared, so the
 * catalogue of what is seated now cannot answer, and what we already told a reader can. For the
 * same reason `isAnotherTierOfAListedModel` cannot be widened to cover this -- it asks whether a
 * catalogue still lists the plain row, which is the right question for a catalogue and the wrong
 * one for a board.
 */
export function isAnotherSizeOfASightedName(db: Database, event: Event): boolean {
  if (event.stream !== "arena" || event.kind !== "new") return false;
  const record = recordFor(event);
  const written = [record?.model, record?.name].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!written) return false;
  const words = normalizeIdentity(written).split(" ").filter(Boolean);
  // Two words left once the size is off, so a bare `2k` or a one-word name cannot stand for a model.
  if (words.length < 3 || !SIZE_TAIL.test(words.at(-1) ?? "")) return false;
  const base = words.slice(0, -1).join(" ");
  return db
    .query<{ model: string | null; name: string | null }, [string, number]>(
      `SELECT json_extract(after_json,'$.model') AS model, json_extract(after_json,'$.name') AS name
         FROM events WHERE source=?1 AND kind='new' AND id<?2 AND json_valid(after_json)`,
    )
    .all(event.source, event.id)
    .some((row) =>
      [row.model, row.name].some(
        (value) => typeof value === "string" && normalizeIdentity(value).split(" ").filter(Boolean).join(" ") === base,
      ),
    );
}

/**
 * A row that exists to point at whatever is newest.
 *
 * `~deepseek/deepseek-v4-flash-latest` is not a model: it is a promise to route to one. Its every
 * move duplicates a card the model behind it already produced.
 */
export function isAliasRow(event: Event): boolean {
  const name = String(recordFor(event)?.name ?? event.entity_id);
  return /[:\s/-]latest$/i.test(name.trim()) || event.entity_id.startsWith("~");
}
