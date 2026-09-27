import type { Database } from "bun:sqlite";
import { sourceIndependenceFamily } from "../events/sourceFamily.js";
import type { SourceAuthority } from "../events/types.js";
import { vendorOfEvidence } from "../events/vendors.js";

/**
 * The makers the vendor table does not know, ranked by how many independent catalogues named them.
 *
 * `vendorOf` answers Unknown for anything no pattern in `src/events/vendors.ts` matches, and an
 * Unknown maker is not a maker to a reader: its models carry no vendor on their cards, join no
 * vendor's story and sort behind everything in the weekly recap. The table is edited by hand, so it
 * falls behind by construction, and the way that was noticed until now was a person missing Gemma
 * in a Sunday digest.
 *
 * The ranking is the whole point. A handle no pattern matches is either a laboratory we should
 * follow or somebody's checkpoint, and the cheapest thing that tells them apart is how many
 * independent sources bothered to list it: AI21 appeared in three catalogues in a month and a
 * Hugging Face nickname appeared in one. So this counts independence families, the same unit the
 * corroboration rule uses, and a row at the top of the table is a row to add to `VENDORS`.
 *
 * It deliberately reads only the catalogue streams. A newsroom post or a repository is about a
 * maker we already follow; a model appearing in a catalogue under a name we cannot place is what
 * this is looking for.
 */
type UnknownMaker = {
  /** What the catalogues publish it under: the handle before the slash or the colon, lowercased. */
  handle: string;
  /**
   * How many independent sources named it, which is the number to sort a decision by.
   *
   * Two catalogues owned by the same gateway are one family here, exactly as they are to the
   * corroboration rule, so a model mirrored across one operator's surfaces does not look like a
   * laboratory the field has noticed.
   */
  independentSourceCount: number;
  sources: string[];
  eventCount: number;
  /** A few of the model names, for reading the row without opening the database. */
  names: string[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export type UnknownMakersReport = {
  days: number;
  /** Events in the window whose maker no pattern matched, before grouping. */
  unplacedEvents: number;
  makers: UnknownMaker[];
};

/** The streams that list models under a maker's own handle. */
const CATALOGUE_STREAMS = ["api-models", "openrouter", "weights"];

type Row = {
  source: string;
  stream: string;
  authority: SourceAuthority;
  source_vendor: string | null;
  entity_id: string;
  detected_at: string;
  name: string | null;
  maker: string | null;
  provider: string | null;
  owner: string | null;
};

/**
 * The four fields `vendorOf` reads, taken by `json_extract` rather than by lifting the bodies.
 *
 * A month of catalogue events is tens of megabytes of record, and this needs four short strings out
 * of each one. `check-sql` has a list of the reads that carry whole bodies on purpose; the point of
 * asking this way is not to be on it.
 */
function rows(db: Database, since: string): Row[] {
  const streams = CATALOGUE_STREAMS.map(() => "?").join(",");
  return db
    .query<Row, [string, ...string[]]>(
      `SELECT e.source, e.stream, e.authority, s.vendor AS source_vendor, e.entity_id, e.detected_at,
              COALESCE(json_extract(e.after_json, '$.name'), json_extract(e.before_json, '$.name')) AS name,
              COALESCE(json_extract(e.after_json, '$.maker'), json_extract(e.before_json, '$.maker')) AS maker,
              COALESCE(json_extract(e.after_json, '$.provider'), json_extract(e.before_json, '$.provider')) AS provider,
              COALESCE(json_extract(e.after_json, '$.owner'), json_extract(e.before_json, '$.owner')) AS owner
         FROM events e
         LEFT JOIN sources s ON s.id = e.source
        WHERE e.detected_at > ? AND e.stream IN (${streams})`,
    )
    .all(since, ...CATALOGUE_STREAMS);
}

/**
 * The publisher part of a catalogue's name for a model.
 *
 * The same laboratory is written three ways by three catalogues: `ibm-granite/granite-4.2-30b` on
 * the Hugging Face router, `IBM: Granite 4.2 8B` on OpenRouter and `Granite 4.2 30B` on models.dev.
 * The first two carry the publisher and the third does not, so a name with no separator groups
 * under itself and shows up as the single-source row it is.
 */
function handleOf(name: string): string {
  // A trailing parenthetical is the catalogue's own annotation, not part of the name: models.dev
  // writes "Muse Glimmer 30B (Deep Infra)" and OpenRouter writes "Nex-N2.5-Mini (free)" for rows
  // that are the same model on two plans, and counting them apart splits one handle into four.
  const [publisher] = name.replace(/\s*\([^()]*\)\s*$/, "").split(/\s*[/:]\s*/);
  return (publisher ?? name).toLowerCase().trim();
}

type Tally = { families: Set<string>; sources: Set<string>; names: Set<string>; count: number; seen: string[] };

function tally(rows: Row[]): Map<string, Tally> {
  const grouped = new Map<string, Tally>();
  for (const row of rows) {
    const name = row.name ?? row.entity_id;
    const vendor = vendorOfEvidence({ ...row, name, entityId: row.entity_id });
    if (vendor !== "Unknown") continue;
    const handle = handleOf(name);
    if (!handle) continue;
    const entry = grouped.get(handle) ?? {
      families: new Set<string>(),
      sources: new Set<string>(),
      names: new Set<string>(),
      count: 0,
      seen: [],
    };
    entry.families.add(
      sourceIndependenceFamily({
        source: row.source,
        stream: row.stream,
        authority: row.authority,
        vendor: row.source_vendor,
      }),
    );
    entry.sources.add(row.source);
    entry.names.add(name);
    entry.count += 1;
    entry.seen.push(row.detected_at);
    grouped.set(handle, entry);
  }
  return grouped;
}

/** How many names of a handle are worth printing before the row stops being readable. */
const NAMES_SHOWN = 4;

export function unknownMakers(db: Database, days = 30, limit = 40, now = Date.now()): UnknownMakersReport {
  // The instant is an argument for the reason `passedOver` takes one: a test that writes its
  // fixtures relative to the real clock passes until the day the window moves past them.
  const since = new Date(now - days * 24 * 3_600_000).toISOString();
  const grouped = tally(rows(db, since));
  const makers = [...grouped]
    .map(([handle, entry]) => ({
      handle,
      independentSourceCount: entry.families.size,
      sources: [...entry.sources].sort(),
      eventCount: entry.count,
      names: [...entry.names].sort().slice(0, NAMES_SHOWN),
      firstSeenAt: entry.seen.reduce((earliest, seen) => (seen < earliest ? seen : earliest)),
      lastSeenAt: entry.seen.reduce((latest, seen) => (seen > latest ? seen : latest)),
    }))
    .sort(
      (left, right) =>
        right.independentSourceCount - left.independentSourceCount ||
        right.eventCount - left.eventCount ||
        left.handle.localeCompare(right.handle),
    );
  return {
    days,
    unplacedEvents: [...grouped.values()].reduce((total, entry) => total + entry.count, 0),
    makers: makers.slice(0, limit),
  };
}
