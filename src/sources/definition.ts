import type { Database } from "bun:sqlite";
import type { AppConfig, CredentialName, SourceMode, Stream } from "../config.js";
import type { Collection, Confidence, EvidenceType, SourceAuthority } from "../events/types.js";
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
  /**
   * What kind of evidence this source produces, and how much an event of it is worth before anything
   * corroborates it. Both were a ladder of `if`s over source id prefixes in `confidenceFor`, so the
   * strength of a new source depended on what it had been named and an unrecognised name fell
   * silently to `observed`: the same class of rule AGENTS.md forbids for failure messages, applied
   * to identifiers. They are declared here instead, once per kind, and a source that declares
   * neither does not compile.
   */
  evidence: EvidenceType;
  confidence: Confidence;
  /**
   * Whether an omission from this source is a withdrawal or just a window moving.
   *
   * A feed, a changelog and a commit log answer with the most recent entries and nothing else, so
   * a record that has fallen out of the answer was never retired -- while a catalogue that stops
   * naming a model is the vendor withdrawing it, which is the whole reason `sources` keeps
   * anything at all. `saveCollection` reads it, and every report that asks why a source is silent
   * needs it: a catalogue with no events may be broken, an append-only feed with no events is a
   * lab that published nothing this week, and the two are indistinguishable without this field.
   *
   * It was a property of the returned `Collection`, which meant it could only be known during a
   * live poll and no report could see it at all. It is a static fact about the surface being read,
   * so it is declared here beside authority, evidence and confidence, and the poller spreads it
   * onto the collection. Same move as 5c57f3c, for the same reason.
   *
   * `trackChanges`, `resolveMissing` and `confirmChanges` are the same class of field and are
   * still returned by collectors. They are not moved here yet because no report asks for them;
   * when one does, they belong here and not in a column.
   */
  appendOnly?: boolean;
  group: string;
  /** Host shared with other collectors when failures may have one upstream cause. */
  upstream?: string;
  stream: Stream;
  intervalSeconds: number;
  capabilityId?: string;
  requiredCapabilities?: readonly CredentialName[];
  pace?: { group: string; seconds: number };
  collector: () => Promise<Collection>;
  enabled: boolean;
  mode: SourceMode;
  restrictedReason?: string;
  /**
   * Answers with megabytes; collected one at a time with other heavy sources.
   *
   * The threshold is what a body costs once it is in memory rather than what it weighs on the
   * wire: measured on 2026-09-26, parsing a stored body adds about two and a half times its own
   * size in objects, so the 15 MB npm document is 54 MB and polymarket's three pages are 15 MB of
   * JSON and 38 MB of objects. Anything over a megabyte of body belongs in this lane; everything
   * this service reads is either under two megabytes or already here.
   */
  heavy?: boolean;
};

/** What a source pack writes per source; label, enabled and mode are derived from the id by the registry. */
export type SourceEntry = Omit<SourceDefinition, "mode" | "label" | "enabled">;

/** What every pack is handed: one database, one config and the HTTP cache shared across a cycle. */
export type SourceContext = { db: Database; config: AppConfig; cache: HttpCache };
