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
};
