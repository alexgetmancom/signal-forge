import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { readRuntime } from "../runtime/observability.js";
import { buildSourceRegistry } from "../sources/registry.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import { type RenderFingerprint, releaseRender } from "./releaseRender.js";

/**
 * Did the release that just landed actually land, and has anything broken since it did.
 *
 * Confirming a deployment took six separate questions on 2026-09-24: grep the built code for a
 * symbol that did not exist before, check the migration applied, check the indexes are there,
 * check `doctor`, check `issues`, count failures since the restart. Six calls for one question,
 * asked in the minutes when getting the answer wrong is most expensive.
 *
 * `symbol` is the half that cannot be inferred from the database: a container can be running last
 * week's image while every other check passes, because the database outlives the image. Name
 * something the release added and this looks for it in the code that is actually loaded.
 */
export type ReleaseCheck = {
  ok: boolean;
  schema: { expected: number; applied: number; ok: boolean };
  symbol: { name: string | null; found: boolean | null; files: string[] };
  indexes: { missing: string[]; analysed: boolean };
  sinceBoot: { bootedAt: string | null; failedOperations: number; failedCollections: number };
  issues: number;
  /**
   * Rows of `sources` carrying a failure that belong to no registered source.
   *
   * `sources` keeps a row for everything that has ever run and the registry is what is still being
   * asked; eight rows on production belong to neither, and this count used to fold them into
   * `issues`. A collector retired on purpose read as a deployment that had just broken something.
   */
  retiredFailing: number;
  /**
   * Whether this build renders the cards the last one did.
   *
   * Every other field here answers "is the new image running". This is the only one that answers
   * "does the new image say anything different", which is the part of a release a reader is on the
   * other end of. Null when the process has not recorded a start, which is a process still starting.
   */
  cards: RenderFingerprint | null;
};

/** The indexes the hot paths depend on; a missing one is a slowdown nothing else reports. */
const REQUIRED_INDEXES = [
  "events_detected_at",
  "events_source_entity",
  "batches_open_ready",
  "records_stream",
  "source_collection_metrics_collected",
];

/** Every built file that mentions the symbol, relative to the build directory. */
function symbolInBuild(name: string, directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        try {
          if (readFileSync(full, "utf8").includes(name)) found.push(full.slice(directory.length + 1));
        } catch {
          // A file that cannot be read is not evidence either way.
        }
      }
    }
  };
  try {
    walk(directory);
  } catch {
    return [];
  }
  return found;
}

export function releaseCheck(
  db: Database,
  config: AppConfig,
  input: { symbol?: string | undefined; directory?: string | undefined; cardDays?: number | undefined },
): ReleaseCheck {
  const applied = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const present = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => row.name),
  );
  const analysed =
    (db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'")
      .get()?.n ?? 0) > 0 && (db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_stat1").get()?.n ?? 0) > 0;

  const bootedAt = readRuntime(db)?.bootedAt ?? null;
  const since = bootedAt ?? new Date(Date.now() - 3_600_000).toISOString();
  const failedOperations =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) n FROM operator_journal WHERE outcome='failed' AND recorded_at>=?",
      )
      .get(since)?.n ?? 0;
  const failedCollections =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) n FROM source_collection_metrics WHERE success=0 AND collected_at>=?",
      )
      .get(since)?.n ?? 0;
  const registered = new Set(buildSourceRegistry(db, config).map((definition) => definition.id));
  const failing = db.query<{ id: string }, []>("SELECT id FROM sources WHERE failures>0").all();
  const issues = failing.filter((row) => registered.has(row.id)).length;

  const files = input.symbol ? symbolInBuild(input.symbol, input.directory ?? "./dist") : [];
  const schemaOk = applied === CURRENT_SCHEMA_VERSION;
  const missing = REQUIRED_INDEXES.filter((name) => !present.has(name));
  return {
    // `ok` is about the deployment, so it is the schema, the indexes and the image -- not
    // `failedOperations`. That count includes an operator mistyping a column name in a read, which
    // is what it caught the first time this was asked on production, and a typo in somebody's query
    // is not a bad release. It is reported below because it is worth seeing, not voted on here.
    ok: schemaOk && missing.length === 0 && (!input.symbol || files.length > 0),
    schema: { expected: CURRENT_SCHEMA_VERSION, applied, ok: schemaOk },
    symbol: { name: input.symbol ?? null, found: input.symbol ? files.length > 0 : null, files: files.slice(0, 10) },
    indexes: { missing, analysed },
    sinceBoot: { bootedAt, failedOperations, failedCollections },
    issues,
    retiredFailing: failing.length - issues,
    cards: releaseRender(db, input.cardDays ?? 2),
  };
}
