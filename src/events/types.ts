/**
 * What a reader came for, which is a different question from how solid the evidence is.
 *
 * Confidence says how much the source can be trusted. A signal class says whether a person who
 * subscribed to hear about new things wants this message at all. An unnamed codename on an arena
 * is the weakest evidence in the system and the most interesting thing in it; a first-party
 * retirement date shift is the strongest evidence and the least interesting.
 */
export const SIGNAL_CLASSES = [
  "launch",
  "codename",
  "release",
  "article",
  "evidence",
  "rank",
  "change",
  "incident",
  "reminder",
  "retirement",
  "feature",
  "safety",
  "research",
  "business",
  "debut",
] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export type RecordData = { id: string; name: string; [key: string]: unknown };

export type Confidence = "observed" | "supported" | "confirmed" | "shipped";

export type SourceAuthority = "first_party" | "vendor_owned" | "third_party";

export type EvidenceType =
  | "api_catalogue"
  | "availability_catalogue"
  | "official_news"
  | "arena_roster"
  | "leaderboard"
  | "web_diff"
  | "github_activity"
  | "package_release"
  | "open_weights"
  | "status_page"
  | "deprecation"
  | "unknown";

export type Collection = {
  source: string;
  stream: string;
  url: string;
  records: RecordData[];
  raw: unknown;
  appendOnly?: boolean;
  silentIds?: string[];
  trackChanges?: boolean;
  confirmChanges?: boolean;
  /** A successful omission resolves a retained incident instead of deleting its evidence. */
  resolveMissing?: boolean;
  authority?: SourceAuthority;
  /** Who the source answers for, as its registry entry declares; stored beside its authority. */
  vendor?: string;
  /**
   * Stored records this source has stopped reading on purpose, such as a site section it now
   * ignores. They are dropped without a removal event and before the shrink guard compares counts.
   */
  forget?: (id: string) => boolean;
  /**
   * The collection is a filtered live query, not a catalogue, so rows leave it by meeting the
   * filter rather than by being dropped from an answer. Polymarket asks for open AI markets, and
   * every one of the fifteen rows it "lost" on 2026-09-22 answers `closed: true` when asked for by
   * id: they resolved. The shrink guard reads that as a mass removal and froze the source for two
   * days. Set only where a missing row is the source working, and never on a catalogue, where the
   * guard is the only thing standing between a partial answer and a wave of removals.
   */
  churns?: boolean;
  /**
   * Records this answer could not speak for -- a part of the catalogue that answered empty. They are
   * neither counted missing nor compared by the shrink guard; the stored rows stand as they were.
   */
  keepMissing?: (id: string) => boolean;
};

export type Event = {
  id: number;
  source: string;
  stream: string;
  entity_id: string;
  kind: "new" | "changed" | "removed";
  before_json: string | null;
  after_json: string | null;
  detected_at: string;
  confidence?: Confidence;
  evidence_type?: EvidenceType;
  authority?: SourceAuthority;
  /**
   * The class the store routed this event by; NULL on events stored before it was kept, and on an
   * event that has been built but not yet classified. Required rather than optional: an absent key
   * and a null were the same thing to every reader and three states to the type checker, and the
   * difference cost an afternoon when a spread widened it and narrowing stopped working.
   */
  signal: SignalClass | null;
};
