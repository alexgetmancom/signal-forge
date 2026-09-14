import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Fetch } from "./http-client.js";
import { lockHolder, withActionLock } from "./runtime/actionLock.js";

/**
 * The editorial archive, read from Solo Publisher and never written to.
 *
 * The two services stay independent: neither imports the other or touches the other's database.
 * This reads the Studio's existing `ops_recent` and `ops_post_text` MCP operations every fifteen
 * minutes, with `SOLO_PUBLISHER_MCP_URL` and `SOLO_PUBLISHER_MCP_TOKEN` configured together in the
 * deployment environment. The token is a Studio credential: only these two read operations are ever
 * called, but the credential itself is not read-only, so it is never logged and never reaches an
 * error message.
 *
 * What the upstream can and cannot answer shapes everything below. It returns at most fifty text
 * publications, so each refresh updates that window and retains rows seen before it -- absence is
 * never deletion. Older history, video publications and edits to posts that have left the window
 * are outside the contract, and losing overlap with a full next window is a permanent coverage gap:
 * conversion must not be calculated across one. `publishedAt` is the Studio's own publication date,
 * not a verified per-platform send.
 *
 * These rows are editorial outcomes and never corroborating evidence for a signal. Nothing here
 * matches stories, calculates conversion, creates drafts or notifies subscribers.
 */
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const target = z.object({
  target: z.string(),
  status: z.string(),
  url: z.string().url().nullable(),
  partial: z.boolean(),
});
const publication = z.object({
  ref: z.string().regex(/^post:\d+$/),
  postId: z.number().int().positive(),
  at: instant.nullable(),
  status: z.string(),
  headline: z.string(),
  targets: z.array(target),
});
const recent = z.object({ posts: z.array(publication).max(50) });
/**
 * The archive keeps the English copy and nothing else: every word this service stores is English,
 * and a post whose English text has not been written yet is stored without one.
 */
const copy = z.object({
  ref: z.string(),
  postId: z.number().int().positive(),
  at: instant.nullable(),
  en: z.string().nullable(),
});
const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })).length(1),
    isError: z.literal(false).optional(),
  }),
});
const syncState = z.object({
  endpoint: z.string(),
  checkedAt: instant,
  windowRefs: z.array(z.string()),
  gapDetected: z.boolean(),
});
const STATE_KEY = "solo-publisher";

function storedState(db: Database) {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key=?").get(STATE_KEY);
  return row ? syncState.parse(JSON.parse(row.value)) : null;
}

/** Only the two existing read operations are callable; the Studio never receives a write. */
async function readStudio(
  endpoint: string,
  token: string,
  name: "ops_recent" | "ops_post_text",
  args: Record<string, unknown>,
  request: Fetch,
  signal: AbortSignal,
): Promise<unknown> {
  const id = crypto.randomUUID();
  try {
    const response = await request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      redirect: "error",
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!response.ok) throw new Error();
    const message = envelope.parse(await response.json());
    if (message.id !== id) throw new Error();
    return JSON.parse(message.result.content[0]?.text ?? "");
  } catch {
    // Neither a fetch exception nor an upstream body may reveal the Studio credential.
    throw new Error(`Solo Publisher ${name} failed or returned an invalid response`);
  }
}

/** Refresh the bounded upstream window atomically. Absence from it never means deletion. */
export async function syncPublications(db: Database, config: AppConfig, request: Fetch = fetch) {
  const endpoint = config.SOLO_PUBLISHER_MCP_URL;
  const token = config.SOLO_PUBLISHER_MCP_TOKEN;
  if (!endpoint || !token) throw new Error("Solo Publisher is not configured");
  const outcome = await withActionLock(db, STATE_KEY, lockHolder("publications"), 180_000, async () => {
    const previous = storedState(db);
    if (previous && previous.endpoint !== endpoint)
      throw new Error("Solo Publisher endpoint differs from the stored publication archive");
    const signal = AbortSignal.timeout(120_000);
    let rows: z.infer<typeof recent>["posts"];
    try {
      rows = recent.parse(await readStudio(endpoint, token, "ops_recent", { limit: 50 }, request, signal)).posts;
    } catch {
      throw new Error("Solo Publisher recent publications could not be validated");
    }
    if (new Set(rows.map((row) => row.ref)).size !== rows.length)
      throw new Error("Solo Publisher returned duplicate publications");
    if (!rows.length && previous?.windowRefs.length)
      throw new Error("Solo Publisher returned an unexpected empty publication window");
    const values: (z.infer<typeof publication> & { en: string | null })[] = [];
    for (const row of rows) {
      let text: z.infer<typeof copy>;
      try {
        text = copy.parse(await readStudio(endpoint, token, "ops_post_text", { ref: row.ref }, request, signal));
      } catch {
        throw new Error("Solo Publisher publication text could not be validated");
      }
      if (text.ref !== row.ref || text.postId !== row.postId || row.ref !== `post:${row.postId}`)
        throw new Error("Solo Publisher publication text belongs to a different post");
      values.push({ ...row, en: text.en });
    }
    const gapDetected = Boolean(
      previous?.gapDetected ||
        (previous?.windowRefs.length &&
          rows.length === 50 &&
          !rows.some((row) => previous.windowRefs.includes(row.ref))),
    );
    const checkedAt = new Date().toISOString();
    db.transaction(() => {
      const lease = db
        .query<{ holder: string }, [string]>(
          "SELECT holder FROM action_locks WHERE name=? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        )
        .get(STATE_KEY);
      if (lease?.holder !== lockHolder("publications")) throw new Error("Solo Publisher synchronization lease expired");
      const upsert =
        db.query(`INSERT INTO publications(ref,post_id,published_at,status,headline,text_en,targets_json,checked_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET published_at=excluded.published_at,status=excluded.status,
        headline=excluded.headline,text_en=excluded.text_en,targets_json=excluded.targets_json,checked_at=excluded.checked_at`);
      for (const row of values)
        upsert.run(
          row.ref,
          row.postId,
          row.at,
          row.status,
          row.headline,
          row.en,
          JSON.stringify(row.targets),
          checkedAt,
        );
      db.query("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
        STATE_KEY,
        JSON.stringify({ endpoint, checkedAt, windowRefs: rows.map((row) => row.ref), gapDetected }),
      );
    })();
    if (gapDetected) throw new Error("Solo Publisher publication window lost overlap; archive coverage has a gap");
    return { refreshed: values.length, checkedAt };
  });
  return outcome.acquired ? outcome.result : { busy: true };
}

export function listPublications(db: Database, config: AppConfig, limit = 20) {
  const state = storedState(db);
  const rows = db
    .query<
      {
        ref: string;
        post_id: number;
        published_at: string | null;
        status: string;
        headline: string;
        text_en: string | null;
        targets_json: string;
        checked_at: string;
      },
      [number]
    >("SELECT * FROM publications ORDER BY published_at DESC,post_id DESC LIMIT ?")
    .all(limit);
  return {
    configured: Boolean(config.SOLO_PUBLISHER_MCP_URL && config.SOLO_PUBLISHER_MCP_TOKEN),
    checkedAt: state?.checkedAt ?? null,
    stale: !state || Date.now() - Date.parse(state.checkedAt) > 30 * 60_000,
    gapDetected: state?.gapDetected ?? false,
    coverage:
      "Recent 50 text publications per sync, retained locally. Older history and video publications are not covered. Posts outside the latest window are no longer refreshed. Publication dates are supplied by Studio, not per-target delivery times.",
    total: db.query<{ count: number }, []>("SELECT count(*) AS count FROM publications").get()?.count ?? 0,
    publications: rows.map((row) => ({
      ref: row.ref,
      postId: row.post_id,
      publishedAt: row.published_at,
      status: row.status,
      headline: row.headline,
      textEn: row.text_en,
      targets: z.array(target).parse(JSON.parse(row.targets_json)),
      checkedAt: row.checked_at,
    })),
  };
}
