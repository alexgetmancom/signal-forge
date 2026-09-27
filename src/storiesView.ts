/**
 * 6 declarations moved out of stories.ts unchanged.
 *
 * Every read of the stories tables: the view a caller gets back, the query that names which stories,
 * and the evidence each one carries. The correlation projector and its writes stay in stories.ts.
 */

import type { Database } from "bun:sqlite";
import { CONFIDENCE_LEVELS } from "./events/confidence.js";
import {
  type IdentityColumnRow,
  identityColumns,
  identityFor,
  identityRecordOf,
  type ModelIdentity,
  mergeIdentities,
} from "./events/identity.js";
import { sourceFamily, sourceIndependenceFamily } from "./events/sourceFamily.js";
import type { Confidence, Event, EvidenceType, SourceAuthority } from "./events/types.js";
import type { StoryEvent } from "./stories.js";

/**
 * One piece of evidence as the story list reads it: the columns it answers with, the identity keys in
 * place of the bodies they were parsed out of, and no body. Selecting `before_json` and `after_json`
 * here cost 170 MB of permanent floor for a hundred stories -- 27.6 MB of text to keep seven fields
 * per event -- and the `batch_events` join it replaces fanned every one of those bodies out per row
 * before grouping them back.
 */
type StoryEvidenceRow = Omit<StoryEvent, "before_json" | "after_json"> & {
  url: string | null;
  evidence_type: EvidenceType;
  vendor: string | null;
} & IdentityColumnRow;
export type StoryView = {
  id: string;
  title: string;
  vendor: string;
  canonicalId: string | null;
  identityStatus: ModelIdentity["status"];
  aliases: string[];
  firstSeenAt: string;
  /** The date the subject itself came out, when a catalogue claimed one; null is no claim. */
  releasedAt: string | null;
  updatedAt: string;
  confidence: Confidence;
  currentStatus: "active" | "removed";
  authorities: SourceAuthority[];
  sources: string[];
  sourceFamilies: string[];
  evidenceCoverage: {
    eventCount: number;
    sourceCount: number;
    sourceFamilies: string[];
    evidenceTypes: EvidenceType[];
    independentSourceCount: number;
    corroborated: boolean;
  };
  eventIds: number[];
  evidence: {
    eventId: number;
    source: string;
    kind: Event["kind"];
    confidence: Confidence;
    evidenceType: EvidenceType;
    authority: SourceAuthority;
    sourceFamily: string;
    canonicalId: string | null;
    identityStatus: ModelIdentity["status"];
    aliases: string[];
    detectedAt: string;
    url: string | null;
  }[];
};

export type StoryQuery = {
  since?: string | undefined;
  minConfidence?: Confidence;
  vendor?: string | undefined;
  limit?: number;
  /**
   * Only stories that began in the window, applied after the limit: a story merely touched -- a
   * catalogue re-reading ninety old models after a key was replaced -- is not news. `news` filtered
   * this in JavaScript over a hundred fully built views, which meant building the evidence of every
   * story it was about to throw away.
   */
  startedSince?: string | undefined;
};

type StoryRow = {
  id: number;
  stable_key: string;
  title: string;
  vendor: string;
  first_seen_at: string;
  released_at: string | null;
  updated_at: string;
  confidence: Confidence;
  current_status: "active" | "removed";
};

/**
 * The stories a query names, chosen in SQL.
 *
 * Every filter was a `.filter()` over all 2,761 rows, and the limit a `.slice()` after them. Ranked
 * confidence becomes the set of levels at or above the floor, and the two instants compare as text
 * because both columns are ISO-with-milliseconds-in-Z by a CHECK constraint -- the argument is put
 * through `Date` first, so an offset like `+02:00` still means the instant it always meant. A vendor
 * compares in lower case, which is ASCII-only here where `toLowerCase` was not; every vendor in the
 * registry is ASCII, and a non-ASCII one would want a stored normalized column rather than a scan.
 */
function storyRows(db: Database, query: StoryQuery): StoryRow[] {
  const levels = CONFIDENCE_LEVELS.slice(CONFIDENCE_LEVELS.indexOf(query.minConfidence ?? "observed"));
  const instant = (value: string | undefined): string | null =>
    value === undefined ? null : new Date(Date.parse(value)).toISOString();
  const since = instant(query.since);
  const startedSince = instant(query.startedSince);
  const vendor = query.vendor ? query.vendor.toLowerCase() : null;
  // The column list is written out twice rather than interpolated once: `check-sql` prepares every
  // statement in `src/` with the interpolations replaced by placeholders, and a column list that
  // arrives as `?` leaves the outer query unable to name what the inner one selected.
  return db
    .query<StoryRow, (string | number | null)[]>(
      `SELECT id,stable_key,title,vendor,first_seen_at,updated_at,confidence,current_status,released_at FROM (
         SELECT id,stable_key,title,vendor,first_seen_at,updated_at,confidence,current_status,released_at FROM stories
          WHERE confidence IN (${levels.map(() => "?").join(",")})
            AND (? IS NULL OR updated_at>=?)
            AND (? IS NULL OR lower(vendor)=?)
          ORDER BY updated_at DESC LIMIT ?)
        WHERE ? IS NULL OR first_seen_at>=?`,
    )
    .all(...levels, since, since, vendor, vendor, query.limit ?? 50, startedSince, startedSince);
}

/** Returns a compact agent-facing story view with event IDs that lead back to immutable evidence. */
export function listStories(db: Database, query: StoryQuery = {}): StoryView[] {
  const evidenceOf = db.query<StoryEvidenceRow, [number]>(
    `SELECT e.id,e.source,e.stream,e.entity_id,e.kind,e.detected_at,e.confidence,e.evidence_type,e.authority,src.vendor,
            ${identityColumns()},
            COALESCE(NULLIF(json_extract(e.after_json,'$.url'),''),NULLIF(json_extract(e.before_json,'$.url'),''),
                     (SELECT MIN(be.url) FROM batch_events be WHERE be.event_id=e.id)) AS url
       FROM story_events se JOIN events e ON e.id=se.event_id
       LEFT JOIN sources src ON src.id=e.source
      WHERE se.story_id=? ORDER BY e.detected_at,e.id`,
  );
  return storyRows(db, query).map((row) => {
    const evidence = evidenceOf.all(row.id).map((event) => {
      const identity = identityFor(event, identityRecordOf(event));
      return {
        eventId: event.id,
        source: event.source,
        kind: event.kind,
        confidence: event.confidence,
        evidenceType: event.evidence_type,
        authority: event.authority,
        sourceFamily: sourceFamily(event.source, event.stream),
        independenceFamily: sourceIndependenceFamily(event),
        canonicalId: identity.canonicalId,
        identityStatus: identity.status,
        aliases: identity.aliases,
        detectedAt: event.detected_at,
        url: event.url,
      };
    });
    const sources = [...new Set(evidence.map((event) => event.source))];
    const sourceFamilies = [...new Set(evidence.map((event) => event.sourceFamily))];
    const evidenceTypes = [...new Set(evidence.map((event) => event.evidenceType))];
    const authorities = [...new Set(evidence.map((event) => event.authority))];
    const independentSources = new Set(evidence.map((event) => event.independenceFamily));
    const identity = evidence.reduce<ModelIdentity>(
      (merged, event) =>
        mergeIdentities(merged, {
          canonicalId: event.canonicalId,
          displayName: row.title,
          aliases: event.aliases,
          status: event.identityStatus,
        }),
      { canonicalId: null, displayName: row.title, aliases: [], status: "unknown" },
    );
    return {
      id: row.stable_key,
      title: row.title,
      vendor: row.vendor,
      canonicalId: identity.canonicalId,
      identityStatus: identity.status,
      aliases: identity.aliases,
      firstSeenAt: row.first_seen_at,
      releasedAt: row.released_at,
      updatedAt: row.updated_at,
      confidence: row.confidence,
      currentStatus: row.current_status,
      authorities,
      sources,
      sourceFamilies,
      evidenceCoverage: {
        eventCount: evidence.length,
        sourceCount: sources.length,
        sourceFamilies,
        evidenceTypes,
        independentSourceCount: independentSources.size,
        corroborated: independentSources.size >= 2,
      },
      eventIds: evidence.map((event) => event.eventId),
      evidence,
    };
  });
}
