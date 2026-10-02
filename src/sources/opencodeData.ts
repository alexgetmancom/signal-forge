/**
 * OpenCode's data catalogue, read as the catalogue it is.
 *
 * Every page under `/data` ships its data with it: a lab page carries `models:`, which is that lab's
 * whole catalogue -- id, slug, name, description and release date -- and `labs:`, which is all 44
 * labs OpenCode knows. So nothing here has to be guessed, and the version guessing this replaced was
 * wrong in both directions at once. Measured 2026-09-27: it never asked Moonshot, Zhipu, DeepSeek or
 * Alibaba at all, because a hand-written list of five makers decided who could be asked; and
 * `alibaba/qwen3.8-max-prime` was in this catalogue, announced nowhere, with no event of it anywhere
 * in our history -- a listed model that a rule about the next version number cannot reach.
 *
 * The old test for "is this page real" was the words `Completed sessions` and `Token Share` in the
 * HTML, which turned out to answer a different question than it was asked. Those words are the usage
 * section, so `alibaba/qwen3-max` -- listed, released 2025-09-23 -- failed the test for having no
 * sessions, while `moonshotai/kimi-k4`, which this catalogue does not contain, passed it for having
 * a usage row. The catalogue is what says a model exists; a session count says somebody typed an id.
 */

import type { Database } from "bun:sqlite";
import type { Collection, RecordData } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { USER_AGENT } from "./http.js";

/** Read a page that may reveal a model before the vendor announces it. */
async function probe(url: string, request: Fetch): Promise<{ status: number; body: string }> {
  const response = await request(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * A lab page carries every lab, so one page names them all. Moonshot's is the smallest of the ones
 * we follow, and which lab is read first has no effect on what is found.
 */
const OPENCODE_SEED_LAB = "moonshotai";

function opencodeLabUrl(lab: string): string {
  return `https://opencode.ai/data/${lab}`;
}

function opencodeUrl(maker: string, slug: string): string {
  return `https://opencode.ai/data/${maker}/${slug}`;
}

/** The labs a page names, in OpenCode's spelling of each. */
function parseOpenCodeLabs(body: string): { id: string; name: string }[] {
  const labs = new Map<string, string>();
  for (const [, id = "", name = ""] of body.matchAll(/\{id:"([a-z0-9][a-z0-9.-]*)",name:"([^"]+)",description:/g))
    labs.set(id, name);
  return [...labs].map(([id, name]) => ({ id, name }));
}

/**
 * The models a lab page lists.
 *
 * The slug is read rather than spelled: OpenCode writes `qwen3-8-max-prime` in the address of a
 * model it calls `Qwen 3.8 Max Prime`, and the rule that turned one into the other by hand is the
 * reason `muse-spark-1-4-contributor` and `muse-spark-1.4-contributor` were both asked for.
 */
function parseOpenCodeModels(body: string, lab: string): RecordData[] {
  const records = new Map<string, RecordData>();
  // One entry at a time, because the fields after the name are optional and in no fixed order: a
  // single expression over the whole entry matched the shortest thing that satisfied it and read
  // every release date as absent.
  for (const start of [...body.matchAll(new RegExp(`\\{id:"[^"]+",lab:"${lab}",slug:"`, "g"))]) {
    const entry = body.slice(start.index, start.index + 1200);
    const head = /^\{id:"([^"]+)",lab:"[^"]+",slug:"([^"]+)",name:"([^"]*)"/.exec(entry);
    if (!head) continue;
    const [, id = "", slug = "", name = ""] = head;
    if (!id || records.has(id)) continue;
    // The date the lab gave the model, which is the one thing here no other catalogue of ours
    // carries for a model nobody has announced.
    const released = /,releaseDate:"(\d{4}-\d{2}-\d{2})"/.exec(entry)?.[1];
    records.set(id, {
      id,
      name,
      url: opencodeUrl(lab, slug),
      maker: lab,
      source: "opencode-data",
      ...(released ? { created: released } : {}),
    });
  }
  return [...records.values()];
}

/**
 * Whether this is a page for a model at all.
 *
 * A structural test, not a wording one: the payload carries `entry:` for a model the catalogue has
 * and `entry:null` for one it does not, so a redesign of the page cannot turn a miss into a
 * sighting. `moonshotai/kimi-k5` and `alibaba/qwen4-max` answer 200 with `entry:null`, which is the
 * whole reason a status code cannot be the test here.
 */
function opencodeHasEntry(body: string): boolean {
  return /entry:(?:\$R\[\d+\]=)?\{id:"/.test(body);
}

/** Stealth names, which no catalogue lists and no version rule reaches. */
const OPENCODE_STEALTH: readonly { maker: string; slug: string }[] = [
  { maker: "unknown", slug: "space-bunny" },
  { maker: "unknown", slug: "sonoma-sky" },
  { maker: "unknown", slug: "stealth-model" },
];

/**
 * Whether a source other than the probes already has this model. A data page spells the version
 * with a hyphen -- `gpt-5-6` for `gpt-5.6` -- so both spellings are asked about.
 */
function alreadyListed(db: Database, slug: string): boolean {
  // OpenCode's own suffix for a model served on contributed capacity is not part of the name.
  const bare = slug.replace(/-contributor(?:-free)?$/, "");
  const spellings = [...new Set([bare, bare.replace(/-(\d)-(\d)(?=-|$)/, "-$1.$2")])];
  const query = db.query(
    "SELECT 1 FROM records WHERE source NOT LIKE 'discovery:%' AND (lower(id)=?1 OR lower(id) LIKE '%/' || ?1) LIMIT 1",
  );
  return spellings.some((spelling) => Boolean(query.get(spelling.toLowerCase())));
}

/**
 * Every model OpenCode lists for a lab this tracker follows, and the stealth names it does not list.
 *
 * One page per followed lab, which is where the records are, plus the seed page that names the labs.
 * A lab nobody here follows is skipped rather than stored: OpenCode names 44 of them, most of a
 * single model, and a recap that counts them counts the catalogue rather than the field.
 */
export async function collectOpenCodeData(db: Database, request: Fetch = fetch): Promise<Collection> {
  const seed = await probe(opencodeLabUrl(OPENCODE_SEED_LAB), request);
  if (seed.status !== 200)
    throw httpFailure(`discovery:opencode-data: /data/${OPENCODE_SEED_LAB} answered HTTP ${seed.status}`, seed.status);
  const labs = parseOpenCodeLabs(seed.body);
  // An empty list is the page shape having moved, which is the one thing a catalogue source must
  // not read as "the catalogue is empty": every model it ever listed would retire at once.
  if (!labs.length)
    throw new SourceError(
      "missing-content",
      "discovery:opencode-data: the page named no lab, so its shape has changed",
    );
  const followed = labs.filter((lab) => vendorOfName(lab.name) !== "Unknown" || vendorOfName(lab.id) !== "Unknown");
  const records: RecordData[] = [...parseOpenCodeModels(seed.body, OPENCODE_SEED_LAB)];
  const read: Record<string, number> = { [OPENCODE_SEED_LAB]: records.length };
  for (const lab of followed) {
    if (lab.id === OPENCODE_SEED_LAB) continue;
    const page = await probe(opencodeLabUrl(lab.id), request).catch(() => null);
    if (!page || page.status !== 200) continue;
    const listed = parseOpenCodeModels(page.body, lab.id);
    read[lab.id] = listed.length;
    records.push(...listed);
  }
  for (const { maker, slug } of OPENCODE_STEALTH) {
    if (alreadyListed(db, slug)) continue;
    const url = opencodeUrl(maker, slug);
    const answer = await probe(url, request).catch(() => null);
    if (!answer || answer.status !== 200 || !opencodeHasEntry(answer.body)) continue;
    records.push({
      id: `${maker}/${slug}`,
      name: slug,
      url,
      maker: maker === "unknown" ? null : maker,
      source: "opencode-data",
    });
  }
  return {
    source: "discovery:opencode-data",
    stream: "api-models",
    url: "https://opencode.ai/data",
    // How many each lab listed, which is what says a lab went quiet rather than empty.
    raw: read,
    records,
  };
}
