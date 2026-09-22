import type { Database } from "bun:sqlite";
import { identityFor, normalizeIdentity } from "../events/identity.js";
import { recordFor } from "../events/record.js";
import { sourceFamily } from "../events/sourceFamily.js";
import type { Event } from "../events/types.js";
import { sourceLabel } from "../sources/labels.js";

/**
 * How each model released this week reached us: which source named it first, how long after the
 * place that published it, and whether a card went out.
 *
 * The question was asked by hand after MiMo V2.6 on 2026-09-21, and the answer lives in three
 * tables no one reads together. A card leaves seconds after our first sighting, so the lag worth
 * measuring is against the model's own timestamp: the `created` the maker's own API gives it.
 *
 * One model is listed under several names — `mimo-v2.6-pro` by Xiaomi, `xiaomi/mimo-v2.6-pro` by
 * OpenRouter — so the maker's prefix is dropped before names are compared. A name counts as a
 * release when two families of sources saw it or it made a card: a lone catalogue row is not one.
 */
export type ReleaseAuditRow = {
  model: string;
  firstSource: string;
  firstLabel: string;
  firstSeenAt: string;
  /** The earliest time any source gave for the model itself, when one gave a time of day. */
  upstreamAt: string | null;
  /** Minutes from that time to our first sighting; null when no source gave one. */
  lagMinutes: number | null;
  families: number;
  cardAt: string | null;
};

type EventRow = Event & { card_at: string | null; authority: string | null };

function modelKey(canonicalId: string): string {
  return normalizeIdentity(canonicalId.split("/").pop() ?? canonicalId);
}

/**
 * A docs page names its model only in its path — `/gemini-api/docs/models/gemini-3.8-live` — and
 * carries no model id, so the card it made on 2026-09-15 read as "no card" until the slug counted.
 */
function slugModel(event: Event): string | null {
  const slug = event.entity_id.replace(/\/$/, "").split("/").at(-1) ?? "";
  return /^[a-z][a-z0-9.-]*\d[a-z0-9.-]*$/i.test(slug) ? slug : null;
}

/**
 * Only the maker dates its own model: OpenRouter's `created` is when OpenRouter set the model up,
 * which put nex-n2.5-mini thirteen days before anyone could call it. A Hugging Face repository is
 * dated when it was made, often private for weeks: Qwen-Image-2.1 by six days, GLM-4.7-FP8 by nine
 * months. Only the maker's own API says when a model became callable.
 *
 * A `created` that falls on a whole hour is a date written as a time — xAI's midnight, Z.ai's
 * midnight in Beijing — and would put the release hours before it happened.
 */
function upstreamTime(event: Event & { authority?: string | null }): string | null {
  if (event.authority !== "first_party") return null;
  const created = (JSON.parse(event.after_json ?? "{}") as { created?: unknown }).created;
  if (typeof created !== "string" || !Number.isFinite(Date.parse(created))) return null;
  return /:00:00(?:\.000)?Z$/.test(created) ? null : new Date(created).toISOString();
}

export function releaseAudit(db: Database, days = 7, now = Date.now()): { since: string; releases: ReleaseAuditRow[] } {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const known = new Map<string, string>();
  for (const row of db
    .query<{ canonical_id: string; first_seen_at: string }, []>("SELECT canonical_id,first_seen_at FROM model_facts")
    .all()) {
    const key = modelKey(row.canonical_id);
    const seen = known.get(key);
    if (!seen || row.first_seen_at < seen) known.set(key, row.first_seen_at);
  }

  const events = db
    .query<EventRow, [string]>(
      `SELECT e.*,
         (SELECT MIN(d.updated_at) FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
          WHERE de.event_id=e.id AND d.status='sent') AS card_at
       FROM events e WHERE e.kind='new' AND e.detected_at>=? ORDER BY e.detected_at, e.id`,
    )
    .all(since);

  const groups = new Map<
    string,
    { model: string; first: EventRow; families: Set<string>; upstreamAt: string | null; cardAt: string | null }
  >();
  for (const event of events) {
    const canonicalId = identityFor(event, recordFor(event)).canonicalId ?? slugModel(event);
    if (!canonicalId) continue;
    const key = modelKey(canonicalId);
    // A model known before the window is not this week's release, only a new listing of it.
    if ((known.get(key) ?? event.detected_at) < since) continue;
    const group = groups.get(key) ?? {
      model: canonicalId.split("/").pop() ?? canonicalId,
      first: event,
      families: new Set<string>(),
      upstreamAt: null,
      cardAt: null,
    };
    group.families.add(sourceFamily(event.source, event.stream));
    const upstream = upstreamTime(event);
    if (upstream && (!group.upstreamAt || upstream < group.upstreamAt)) group.upstreamAt = upstream;
    if (event.card_at && (!group.cardAt || event.card_at < group.cardAt)) group.cardAt = event.card_at;
    groups.set(key, group);
  }

  const releases = [...groups.values()]
    .filter((group) => group.families.size >= 2 || group.cardAt)
    .map((group): ReleaseAuditRow => {
      const firstSeenAt = group.first.detected_at;
      const lag = group.upstreamAt ? (Date.parse(firstSeenAt) - Date.parse(group.upstreamAt)) / 60_000 : null;
      return {
        model: group.model,
        firstSource: group.first.source,
        firstLabel: sourceLabel(group.first.source),
        firstSeenAt,
        upstreamAt: group.upstreamAt,
        lagMinutes: lag === null ? null : Math.max(0, Math.round(lag)),
        families: group.families.size,
        cardAt: group.cardAt,
      };
    });
  return { since, releases };
}
