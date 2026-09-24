import { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { count, type OperationMap } from "./definition.js";

/**
 * Reading the database directly, for the question no command answers yet.
 *
 * Every other operation is a question somebody knew to ask twice. The first time, it is asked by
 * hand: on 2026-09-24 a card went out for `claude-gpt-6-astra`, and answering why meant a script
 * copied to the host, into the container, and run there -- four steps, three of which failed on
 * the schema before one worked. This is that, in one call, and the schema is askable.
 *
 * The connection is opened read-only, so a statement that writes fails instead of landing. That is
 * the guarantee, not the parsing of the text: a check that reads the query and decides it is a
 * SELECT is a check that can be fooled, and this one cannot.
 */
export function databaseOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  const readOnly = () => new Database(config.DATABASE_URL, { readonly: true });
  return {
    sql: {
      section: "evidence",
      summary: "Run one read-only query and get the rows as JSON.",
      startHere: "a question about the stored data that no command answers",
      note:
        "Read-only: a write fails rather than lands. A gzipped body comes back as text, and any " +
        "other blob as its size, so `SELECT body FROM snapshots` is readable. Ask `schema` first.",
      mutates: false,
      agent: true,
      schema: z.object({ query: z.string().min(1), limit: count(2_000, 200) }),
      cli: {
        args: [{ name: "query" }, { name: "limit", optional: true }],
      },
      handler: (input: { query: string; limit: number }) => {
        const connection = readOnly();
        try {
          const rows: Record<string, unknown>[] = [];
          // Taken one at a time: a question asked by hand is often a question asked wrongly, and a
          // missing WHERE should cost the rows asked for rather than the whole table.
          for (const row of connection.query(input.query).iterate() as Iterable<Record<string, unknown>>) {
            rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, readable(value)])));
            if (rows.length >= input.limit) break;
          }
          return { rows, count: rows.length, truncated: rows.length >= input.limit };
        } finally {
          connection.close();
        }
      },
    },
    schema: {
      section: "evidence",
      summary: "Every table, its columns and how many rows it holds.",
      startHere: "what is stored here, and under what column name",
      note: "Name a table for its columns alone. Without one, every table is listed.",
      mutates: false,
      agent: true,
      schema: z.object({ table: z.string().min(1).optional() }),
      cli: { args: [{ name: "table", optional: true }] },
      handler: (input: { table?: string | undefined }) => {
        const connection = readOnly();
        try {
          const tables = connection
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all()
            .map((row) => row.name)
            .filter((name) => !input.table || name === input.table);
          if (input.table && tables.length === 0) throw new Error(`No such table: ${input.table}`);
          return tables.map((name) => ({
            table: name,
            rows: (connection.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
            columns: connection
              .query<{ name: string; type: string; notnull: number }, []>(`PRAGMA table_info("${name}")`)
              .all()
              .map((column) => `${column.name} ${column.type}${column.notnull ? " NOT NULL" : ""}`),
          }));
        } finally {
          connection.close();
        }
      },
    },
    snapshot: {
      section: "evidence",
      summary: "The newest payload a source collected, unzipped.",
      startHere: "what a source actually served last time",
      mutates: false,
      agent: true,
      schema: z.object({ source: z.string().min(1), chars: count(200_000, 4_000) }),
      cli: {
        args: [{ name: "source" }, { name: "chars", optional: true }],
      },
      notFoundWhenEmpty: true,
      handler: (input: { source: string; chars: number }) => {
        const body = readLatestSnapshot(db, input.source);
        if (body === null) return null;
        const collected = db
          .query<{ collected_at: string }, [string]>(
            "SELECT collected_at FROM snapshots WHERE source=? ORDER BY id DESC LIMIT 1",
          )
          .get(input.source);
        return {
          source: input.source,
          collectedAt: collected?.collected_at ?? null,
          bytes: Buffer.byteLength(body),
          truncated: body.length > input.chars,
          body: body.slice(0, input.chars),
        };
      },
    },
  };
}

/**
 * How much of an unzipped body a row shows. A catalogue poll is a megabyte of JSON, and a row of a
 * table is not where anyone reads one: `snapshot` gives the whole payload, of one named source.
 */
const BLOB_CHARS = 2_000;

/** A gzipped snapshot body prints as itself, cut short; any other blob prints as its size. */
function readable(value: unknown): unknown {
  if (!(value instanceof Uint8Array)) return value;
  if (value[0] === 0x1f && value[1] === 0x8b) {
    try {
      const text = Buffer.from(Bun.gunzipSync(new Uint8Array(value))).toString("utf8");
      return text.length > BLOB_CHARS ? `${text.slice(0, BLOB_CHARS)}… (${text.length} chars, see \`snapshot\`)` : text;
    } catch {
      return `<gzip, ${value.byteLength} bytes, unreadable>`;
    }
  }
  return `<blob, ${value.byteLength} bytes>`;
}
