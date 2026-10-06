import type { Database } from "bun:sqlite";
import { MODALITY_FACETS } from "../events/subject.js";

/**
 * The cards a reader marked 👎, with the handles that could cut a whole category out.
 *
 * This is not a measurement and nothing here calibrates a judge: with sixteen thumbs down in the
 * whole newsroom, `reactions` already says there are too few to learn from. It is the material for
 * a conversation. A reader taps 👎 under a card and the reason stays in his head -- "image models,
 * we do not care", "that board is not code" -- and this report lays the card back out beside the
 * handles a rule could actually be written against, so the reason can be said out loud and turned
 * into one.
 *
 * So the cuts matter more than the cards. One 👎 under a vision debut is a mood; three vision cards
 * in a fortnight, all three marked, against seven code cards and none marked, is a category. Every
 * cut therefore carries what it would cost: `cards` is how many arrived, `disliked` how many were
 * marked, and cutting the value means losing the first number.
 */
type DislikedCard = {
  at: string;
  destination: string;
  /** The card as its reader saw it, which is our own text and never an upstream body. */
  headline: string;
  /** The other channels the same batch reached, because "not here" is a different fix from "not at all". */
  alsoSentTo: string[];
  sources: string[];
  signals: string[];
  /** How many events the card carried: one 👎 under a digest is one opinion about all of them. */
  events: number;
  against: number;
  favour: number;
  facets: Facet[];
};

/** One handle a rule could be written against: what it is, and the value this card had. */
type Facet = { axis: string; value: string };

type DislikedCut = {
  axis: string;
  value: string;
  /** Cards carrying this value that were marked, and how many arrived in the window at all. */
  disliked: number;
  cards: number;
  /** The channels those cards went to, so a cut can be made per channel or everywhere. */
  destinations: string[];
};

export type DislikedReport = {
  since: string;
  /** Marked cards against delivered cards, per channel: what share of a channel its reader rejected. */
  channels: { destination: string; cards: number; disliked: number }[];
  cards: DislikedCard[];
  cuts: DislikedCut[];
};

function modalityOf(row: DeliveredRow): string {
  const sides = [row.inputs, row.outputs].filter((side): side is string => typeof side === "string");
  const text = [row.category, row.entity_id, row.name, row.price_fields, ...sides].filter(Boolean).join(" ");
  for (const { modality, pattern } of MODALITY_FACETS) if (pattern.test(text)) return modality;
  return /text/.test(sides.join(" ")) || /text/.test(row.category ?? "") ? "text" : "unknown";
}

/** The handles one event offers: who made it, what it is about, and the board it came from. */
function facetsOf(row: DeliveredRow): Facet[] {
  const facets: Facet[] = [
    { axis: "source", value: row.source },
    { axis: "stream", value: row.stream },
    { axis: "signal", value: row.signal || "unclassified" },
    { axis: "modality", value: modalityOf(row) },
  ];
  if (row.category) facets.push({ axis: "board", value: row.category });
  if (row.maker) facets.push({ axis: "maker", value: row.maker });
  return facets;
}

/**
 * The line a reader actually saw, read back out of the card this service wrote.
 *
 * The body is ours -- Discord's embed or the Telegram text -- so printing it publishes nothing an
 * upstream said. Mentions and custom emoji are stripped because they are addressing, not content,
 * and a role id tells a reader nothing about why he disliked the card.
 */
function headlineOf(body: string): string {
  let text = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const card = parsed as { content?: unknown; embeds?: { title?: unknown; description?: unknown }[] };
      const embed = Array.isArray(card.embeds) ? card.embeds[0] : undefined;
      const title = typeof embed?.title === "string" ? embed.title : "";
      text = title || (typeof card.content === "string" ? card.content : body);
    }
  } catch {
    text = body;
  }
  return text
    .replace(/<@&\d+>/g, "")
    .replace(/<:[a-z_]+:\d+>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

type DeliveredRow = {
  delivery_id: number;
  batch_id: number;
  destination_id: string;
  body: string;
  updated_at: string;
  favour: number;
  against: number;
  source: string;
  stream: string;
  signal: string | null;
  /** The handful of keys the facets are derived from. The record itself is never read: a body costs
   * what the archive has grown to, and five scalars are what this answer keeps. */
  entity_id: string | null;
  category: string | null;
  maker: string | null;
  name: string | null;
  inputs: string | null;
  outputs: string | null;
  /** The price table's field names, which is where Vercel says a model speaks and nothing else does. */
  price_fields: string | null;
};

/** Every card that reached a channel in the window, with its events and whatever a reader did to it. */
function delivered(db: Database, since: string): DeliveredRow[] {
  return db
    .query<DeliveredRow, [string]>(
      `SELECT d.id delivery_id, d.batch_id, d.destination_id, d.body, d.updated_at,
              COALESCE(r.votes,0) favour, COALESCE(r.against,0) against,
              e.source, e.stream, e.signal,
              json_extract(e.after_json,'$.id') entity_id,
              json_extract(e.after_json,'$.category') category,
              json_extract(e.after_json,'$.maker') maker,
              json_extract(e.after_json,'$.name') name,
              json_extract(e.after_json,'$.input') inputs,
              json_extract(e.after_json,'$.output') outputs,
              (SELECT group_concat(key) FROM json_each(e.after_json,'$.pricing')) price_fields
         FROM deliveries d
         JOIN delivery_events de ON de.delivery_id = d.id
         JOIN events e ON e.id = de.event_id
         LEFT JOIN scout_reactions r ON r.delivery_id = d.id
        WHERE d.status = 'sent' AND d.updated_at >= ?
        ORDER BY d.updated_at DESC`,
    )
    .all(since);
}

type Card = DislikedCard & { batchId: number; facetKeys: Set<string> };

/** The rows of one delivery folded into the card its reader saw. */
function assemble(rows: readonly DeliveredRow[]): Map<number, Card> {
  const cards = new Map<number, Card>();
  for (const row of rows) {
    let card = cards.get(row.delivery_id);
    if (!card) {
      card = {
        at: row.updated_at,
        destination: row.destination_id,
        headline: headlineOf(row.body),
        alsoSentTo: [],
        sources: [],
        signals: [],
        events: 0,
        against: row.against,
        favour: row.favour,
        facets: [],
        batchId: row.batch_id,
        facetKeys: new Set(),
      };
      cards.set(row.delivery_id, card);
    }
    card.events += 1;
    if (!card.sources.includes(row.source)) card.sources.push(row.source);
    const signal = row.signal || "unclassified";
    if (!card.signals.includes(signal)) card.signals.push(signal);
    for (const facet of facetsOf(row)) {
      const key = `${facet.axis}=${facet.value}`;
      if (card.facetKeys.has(key)) continue;
      card.facetKeys.add(key);
      card.facets.push(facet);
    }
  }
  return cards;
}

/** Which other channels the same batch reached, which is what makes "move it" a possible answer. */
function fillAlsoSentTo(cards: Map<number, Card>): void {
  const byBatch = new Map<number, string[]>();
  for (const card of cards.values()) {
    const seen = byBatch.get(card.batchId) ?? [];
    if (!seen.includes(card.destination)) seen.push(card.destination);
    byBatch.set(card.batchId, seen);
  }
  for (const card of cards.values())
    card.alsoSentTo = (byBatch.get(card.batchId) ?? []).filter((id) => id !== card.destination);
}

/** Every value of every axis that a marked card carried, with what cutting it would also take. */
function cutsOf(cards: readonly Card[]): DislikedCut[] {
  const cuts = new Map<string, DislikedCut>();
  for (const card of cards)
    for (const facet of card.facets) {
      const key = `${facet.axis}=${facet.value}`;
      const cut = cuts.get(key) ?? { axis: facet.axis, value: facet.value, disliked: 0, cards: 0, destinations: [] };
      cut.cards += 1;
      if (card.against > 0) {
        cut.disliked += 1;
        if (!cut.destinations.includes(card.destination)) cut.destinations.push(card.destination);
      }
      cuts.set(key, cut);
    }
  return [...cuts.values()]
    .filter((cut) => cut.disliked > 0)
    .sort((one, other) => other.disliked - one.disliked || one.cards - other.cards);
}

/**
 * What the readers rejected, and what could be cut because of it.
 *
 * Read with `reactions`, which says how many thumbs there are in total, and before changing a
 * routing rule, which is the only thing that acts on any of this.
 */
export function dislikedCards(db: Database, days = 14, now = Date.now()): DislikedReport {
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const cards = assemble(delivered(db, since));
  fillAlsoSentTo(cards);
  const all = [...cards.values()];
  const channels = new Map<string, { destination: string; cards: number; disliked: number }>();
  for (const card of all) {
    const channel = channels.get(card.destination) ?? { destination: card.destination, cards: 0, disliked: 0 };
    channel.cards += 1;
    if (card.against > 0) channel.disliked += 1;
    channels.set(card.destination, channel);
  }
  const strip = ({ batchId: _batch, facetKeys: _keys, ...card }: Card): DislikedCard => card;
  return {
    since,
    channels: [...channels.values()].sort((one, other) => other.disliked - one.disliked),
    cards: all.filter((card) => card.against > 0).map(strip),
    cuts: cutsOf(all),
  };
}
