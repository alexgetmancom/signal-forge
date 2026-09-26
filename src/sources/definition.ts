import type { Database } from "bun:sqlite";
import type { AppConfig, CredentialName, SourceMode, Stream } from "../config.js";
import type { Collection, SourceAuthority } from "../events/types.js";
import type { HttpCache } from "../storage/httpCache.js";

export type SourceDefinition = {
  id: string;
  label: string;
  vendor?: string;
  /**
   * The family this source belongs to, from src/sources/kinds.ts. Documentation only -- never
   * stored, never delivered -- but `sources kinds` counts by it, so a source that is nobody's kind
   * is a source whose family nobody named.
   */
  kind?: string;
  authority: SourceAuthority;
  group: string;
  stream: Stream;
  intervalSeconds: number;
  capabilityId?: string;
  requiredCapabilities?: readonly CredentialName[];
  pace?: { group: string; seconds: number };
  collector: () => Promise<Collection>;
  enabled: boolean;
  mode: SourceMode;
  restrictedReason?: string;
  /** Answers with tens of megabytes; collected one at a time with other heavy sources. */
  heavy?: boolean;
};

/** What a source pack writes per source; label, enabled and mode are derived from the id by the registry. */
export type SourceEntry = Omit<SourceDefinition, "mode" | "label" | "enabled">;

/** What every pack is handed: one database, one config and the HTTP cache shared across a cycle. */
export type SourceContext = { db: Database; config: AppConfig; cache: HttpCache };
