/**
 * A story this reader has already been told.
 *
 * A model reaches its maker's catalogue, then a gateway, then a router, then a release note that
 * names it, and each arrival is the earliest word on nothing. Every rule here dates the telling --
 * against what was delivered, against the date the record puts on the model itself, against the
 * maker's own listing -- and the model names they all read are matched with one word list.
 */

import type { Database } from "bun:sqlite";
import { normalizeIdentity } from "./identity.js";
import { recordFor } from "./record.js";
import { parseRecord } from "./recordBody.js";
import { createdBefore } from "./releaseDate.js";
import { CATALOGUE_MAKER } from "./resellers.js";
import type { Event } from "./types.js";
import { releasedModelSubject } from "./variants.js";
import { vendorOfName } from "./vendors.js";
import { meaningfulWebString, normalizeWebString, tellingWebString } from "./web.js";
import { subjectKey } from "./witness.js";

/** The versioned model names a string mentions. */
const MODEL_NAME =
  /\b(?:claude|opus|sonnet|haiku|gpt|o\d|gemini|grok|codex|llama|qwen|deepseek|kimi|glm|mistral)[\s-]?\d[\w.-]*/gi;

/** How long a model stays told, for a release note that names nothing else. */
const TOLD_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * A release note whose every named model this destination has already been sent.
 *
 * ChatGPT's release notes said "GPT-6 Sol and Luna in Work and Codex" on 2026-09-23, nine hours
 * after both models reached the same readers as launches. An interface catching up with a model is
 * not a second piece of news about it. A note that names a model nobody here has heard of still
 * speaks, and so does one that names none at all, which is most of them.
 */
export function retellsToldModels(
  db: Database,
  event: Event,
  destinationId: string,
  now: number,
  asOf?: string,
): boolean {
  if (event.stream !== "news" || event.kind !== "new") return false;
  const body = recordFor(event);
  const named = `${String(body?.name ?? "")} ${String(body?.summary ?? "")}`.match(MODEL_NAME) ?? [];
  if (!named.length) return false;
  /**
   * The window is measured from the moment being judged, never from the clock. This read
   * `new Date()` when no cutoff was given, which is every call from the delivery path, so the one
   * rule here that looked at wall time disagreed with `releaseTold` and `announcementTold` beside
   * it -- and a test whose fixtures were a week old failed for reasons its subject had nothing to
   * do with.
   */
  const at = asOf ?? new Date(now).toISOString();
  const since = new Date(Date.parse(at) - TOLD_WINDOW_MS).toISOString();
  const told = db
    .query<{ name: string }, [string, string, string]>(
      `SELECT COALESCE(json_extract(e.after_json,'$.name'),e.entity_id) AS name
       FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN events e ON e.id=de.event_id
       WHERE d.destination_id=? AND d.status='sent' AND e.detected_at>=? AND e.detected_at<=?`,
    )
    .all(destinationId, since, at)
    .map((row) => normalizeIdentity(String(row.name)));
  if (!told.length) return false;
  return named.every((model) => {
    const name = normalizeIdentity(model);
    return told.some((one) => one === name || one.startsWith(`${name} `) || one.includes(name));
  });
}

/**
 * A documentation diff whose only tell is a model this deployment already knows./**
 * A documentation diff whose only tell is a model this deployment already knows.
 *
 * Codex's subagent page swapped `gpt-5.3-codex-spark` for `gpt-5.6-luna` in two TOML examples on
 * 2026-09-18 and reached the scouts as a sighting; GPT-5.6 Luna had been on OpenRouter and the
 * Arena since 2026-09-09. A string that also says preview, beta or coming soon still speaks.
 */
export function namesOnlyKnownModels(event: Event, known: readonly string[][]): boolean {
  if (event.stream !== "web" || event.kind !== "changed") return false;
  const before = parseRecord(event.before_json);
  const after = parseRecord(event.after_json);
  const old = new Set(Array.isArray(before?.strings) ? before.strings : []);
  const telling = (Array.isArray(after?.strings) ? after.strings : []).filter(
    (value): value is string =>
      typeof value === "string" && !old.has(value) && meaningfulWebString(value) && tellingWebString(value),
  );
  if (!telling.length) return false;
  const names = known.map((words) => words.join(" "));
  return telling.every((value) => {
    const normalized = normalizeWebString(value);
    const models = normalized.match(MODEL_NAME) ?? [];
    if (!models.length || tellingWebString(normalized.replace(MODEL_NAME, " "))) return false;
    return models.every((model) => {
      const name = normalizeIdentity(model);
      return names.some((knownName) => knownName === name || knownName.startsWith(`${name} `));
    });
  });
}

/**
 * The maker a listing belongs to, when the listing is the maker's own. Weights under the maker's own
 * Hugging Face organisation are that maker releasing the model: GLM-4.7 Flash reached the scouts
 * from Vertex Model Garden on 2026-09-18, eight months after `zai-org` published it, because Z.ai's
 * API catalogue no longer lists it.
 */
function makerOfListing(source: string): string | undefined {
  if (source.startsWith("huggingface:")) return vendorOfName(source.slice("huggingface:".length));
  return CATALOGUE_MAKER[source];
}

/**
 * A sighting of a model its maker already sells.
 *
 * `glm-5.3-flashx` reached the scouts from the Vercel gateway on 2026-09-18 three minutes after Z.ai's
 * own catalogue put it on the public channel, and a fourth Arena entry for the released
 * `mimo-v2.5-pro` followed. A sighting is the earliest word on a model; after the maker's own
 * catalogue it is the latest.
 *
 * Not on an arena. That Arena entry was created at 06:02 on 2026-09-18 (its id is a UUIDv7) with no
 * provider, while the released one is served by `xiaomiV1` and Xiaomi had been training
 * mimo-v2.6-pro in public since 2026-09-15; a bare `gemini-3.8-flash` appeared the same way on
 * 2026-09-17, which readers took for the next Gemini. A released name is how a successor is tested
 * blind, so a new entry under one is a sighting, not a repeat.
 */
export function isAlreadyOutAtItsMaker(event: Event, elsewhere: readonly string[]): boolean {
  if (event.kind !== "new" || event.stream === "arena") return false;
  const maker = vendorOfName(`${event.entity_id} ${String(recordFor(event)?.name ?? "")}`);
  return maker !== "Unknown" && elsewhere.some((source) => makerOfListing(source) === maker);
}

/** Past this, a catalogue adding a model is catching up with a release, not carrying one. */
const ALREADY_OUT_MS = 30 * 24 * 3_600_000;

/**
 * A model that was already out when this catalogue listed it, on a row that names no maker.
 *
 * `isAlreadyOutAtItsMaker` asks who published the model and finds the maker's own listing beside
 * this one. An importer defeats that by naming nobody: Azure's row for Meta's Muse Glimmer 30B is
 * `azure-ai-foundry/Muse-Glimmer-30B` and says "microsoft-foundry", so the model read as new on
 * 2026-09-21, six weeks after Meta uploaded it and while five catalogues were already selling it.
 *
 * What the row does not say, another catalogue's record does: OpenRouter and Hugging Face both carry
 * the date a model was created. Reading it there dates the release without a lookup, and a month is
 * long enough that no reader is still waiting for the news.
 */
export function wasReleasedLongBefore(db: Database, event: Event): boolean {
  if (event.kind !== "new" || (event.stream !== "api-models" && event.stream !== "openrouter")) return false;
  const cutoff = Date.parse(event.detected_at) - ALREADY_OUT_MS;
  if (createdBefore(recordFor(event), cutoff)) return true;
  const id = (recordFor(event)?.id ?? event.entity_id) as string;
  const name = String(id).split("/").at(-1)?.toLowerCase() ?? "";
  // A name without a digit and a separator is a word, and a word matches half the catalogue.
  if (name.length < 6 || !/\d/.test(name) || !/[-_.]/.test(name)) return false;
  return db
    .query<{ body: string }, [string]>(
      `SELECT body FROM records WHERE stream IN ('api-models','openrouter','weights')
       AND lower(id) LIKE '%' || ? || '%' LIMIT 20`,
    )
    .all(name)
    .some((row) => {
      try {
        return createdBefore(JSON.parse(row.body) as Record<string, unknown>, cutoff);
      } catch {
        return false;
      }
    });
}

/**
 * A sighting of a route to a model that is already out.
 *
 * LiteLLM's model map named `grok-4.20-beta-latest-non-reasoning` and seven more spellings of the
 * same model on 2026-09-23, and each one reached the radar as a name in no catalogue. Grok 4.20 had
 * been answering since March: the strings are routing, not news. A radar exists for models nobody
 * can call yet, and this is the opposite of one.
 */
export function isARouteToAReleasedModel(event: Event, released: ReadonlySet<string>): boolean {
  if (event.kind !== "new") return false;
  const name = String(recordFor(event)?.name ?? "");
  const keys = new Set([releasedModelSubject(event.entity_id), releasedModelSubject(name || event.entity_id)]);
  // The name as written is the sighting itself; only a shorter reading of it can be the model.
  return [...keys].some(
    (key) => key.length > 3 && released.has(key) && !released.has(subjectKey(name || event.entity_id)),
  );
}
