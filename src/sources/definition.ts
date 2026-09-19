import type { Database } from "bun:sqlite";
import type { AppConfig, SourceMode, Stream } from "../config.js";
import type { Collection, SourceAuthority } from "../events/types.js";
import type { HttpCache } from "../storage/httpCache.js";

export type SourceDefinition = {
  id: string;
  label: string;
  vendor?: string;
  authority: SourceAuthority;
  group: string;
  stream: Stream;
  intervalSeconds: number;
  capabilityId?: string;
  requiredCapabilities?: readonly string[];
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
