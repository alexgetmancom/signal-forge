import type { Database } from "bun:sqlite";

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
export type DislikedCard = {
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
export type Facet = { axis: string; value: string };

export type DislikedCut = {
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

/**
 * What a card is about, in the terms a reader rejects things in.
 *
 * A vibe-coding channel does not care about image or video models anywhere, which is a cut across
 * every source at once -- and no source says "modality" in a field of its own. Arena spells it in
 * the board (`image-edit/overall`), OpenRouter in the input and output arrays, Vercel only in a
 * price per character of speech, and the rest only in the name. So it is derived from whatever the
 * record happens to carry, and a record that says none of it stays `unknown` rather than being
 * guessed into a bucket somebody would then cut.
 */
const MODALITY_WORDS: readonly { modality: string; pattern: RegExp }[] = [
  { modality: "image", pattern: /image|imagine|vision|diffusion|flux|canvas|photo/i },
  { modality: "video", pattern: /video|sora|veo|runway|motion/i },
  { modality: "audio", pattern: /voice|speech|tts|audio|whisper|music|eleven/i },
  { modality: "embedding", pattern: /embed|rerank|retrieval/i },
  { modality: "code", pattern: /code|coder|webdev|web-dev|swe/i },
];

function modalityOf(record: Record<string, unknown>, entityId: string): string {
  const category = typeof record.category === "string" ? record.category : "";
  const name = `${category} ${entityId} ${typeof record.name === "string" ? record.name : ""}`;
  const arrays = [record.input, record.output].flatMap((side) => (Array.isArray(side) ? side : []));
  const pricing = record.pricing && typeof record.pricing === "object" ? Object.keys(record.pricing) : [];
  const text = [name, ...arrays.map(String), ...pricing].join(" ");
  for (const { modality, pattern } of MODALITY_WORDS) if (pattern.test(text)) return modality;
  return arrays.includes("text") || /text/.test(category) ? "text" : "unknown";
}

/** The handles one event offers: who made it, what it is about, and the board it came from. */
function facetsOf(event: {
  source: string;
  stream: string;
  signal: string | null;
  after_json: string | null;
}): Facet[] {
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.after_json ?? "{}");
    if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
  } catch {
    record = {};
  }
  const entityId = typeof record.id === "string" ? record.id : "";
  const facets: Facet[] = [
    { axis: "source", value: event.source },
    { axis: "stream", value: event.stream },
    { axis: "signal", value: event.signal || "unclassified" },
    { axis: "modality", value: modalityOf(record, entityId) },
  ];
  if (typeof record.category === "string") facets.push({ axis: "board", value: record.category });
  if (typeof record.maker === "string") facets.push({ axis: "maker", value: record.maker });
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
  after_json: string | null;
};

/** Every card that reached a channel in the window, with its events and whatever a reader did to it. */
function delivered(db: Database, since: string): DeliveredRow[] {
  return db
    .query<DeliveredRow, [string]>(
      `SELECT d.id delivery_id, d.batch_id, d.destination_id, d.body, d.updated_at,
              COALESCE(r.votes,0) favour, COALESCE(r.against,0) against,
              e.source, e.stream, e.signal, e.after_json
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
