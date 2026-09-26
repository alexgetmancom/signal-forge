import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";

/**
 * The models Google's and Alibaba's command-line clients ship knowing about.
 *
 * Claude Code's binary has been read this way since it started naming models before Anthropic did;
 * these two ship the same thing and were read only for their version number. Their bundles are not
 * shy: on 2026-09-24 the Gemini CLI carried `gemini-3.8-flash` and `gemini-3.5-flash-lite`, and Qwen
 * Code carried `qwen3.8-max`, `qwen3.8-flash` and `qwen3-coder-next` -- names a client has to know
 * to call, written down before anyone announces them.
 *
 * A bundle also carries its own tests, and a test invents models: `gemini-9001-super-duper` sits in
 * the Gemini CLI's fixtures. A version number no maker would print is how those give themselves
 * away, so anything past the ninth major is dropped.
 */
const MAX_MAJOR = 9;

/** A dated alias -- `qwen3.8-max-0902`, `qwen3-max-2026-01-23` -- is the same model as the id it dates. */
const DATED = /-(?:\d{4}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4})$/;

/** Words a client uses for its own plumbing, never for a model it can call. */
const PLUMBING = /(?:^|-)(?:cli|a2a|base|customtools|test|fake|mock|workspace|published|sha256)(?:-|$)/;

function keep(id: string): boolean {
  const major = Number(/\d+/.exec(id)?.[0] ?? "0");
  return major > 0 && major <= MAX_MAJOR && !PLUMBING.test(id) && !DATED.test(id);
}

/** Model ids written into a coding client's bundle, for one maker's spelling of them. */
export function bundleModelIds(text: string, pattern: RegExp): string[] {
  return sortedIds(collectIds(new Set(), text, pattern));
}

function collectIds(ids: Set<string>, text: string, pattern: RegExp): Set<string> {
  for (const [, id] of text.matchAll(pattern)) if (id && keep(id)) ids.add(id);
  return ids;
}

function sortedIds(ids: Set<string>): string[] {
  return [...ids].sort();
}

/**
 * The longest match this scan will look for across a chunk boundary.
 *
 * A bundle is read in pieces, and an id written across the join between two of them would be missed
 * by both. The tail of each piece is therefore carried into the next. 200 bytes is many times the
 * longest id any of these patterns can match -- `gemini-3.1-pro-preview` is 22 -- and it is the
 * whole cost of not holding the bundle in memory.
 */
const CARRIED_BYTES = 200;

/**
 * Model ids in a gzipped bundle, read as it arrives.
 *
 * The Gemini CLI's tarball is 19.8 MB compressed and 94.1 MB unpacked (measured 2026-09-26, version
 * 0.61.0). Reading it whole meant three copies at once -- the downloaded bytes, the unpacked bytes
 * and the string decoded from them, about 208 MB -- to run a regular expression over it and keep a
 * handful of names. Decompressed in pieces, with the tail of each piece carried into the next, the
 * peak is a chunk and the names found so far.
 *
 * `latin1` decodes a byte to the character of that code, so it never fails and never merges bytes:
 * a UTF-8 sequence becomes two characters, neither of which any of these patterns can match, and an
 * id spelled in ASCII reads as itself. Which is the whole of what this needs from a decoder.
 */
async function bundleIdsFromStream(
  body: ReadableStream<ArrayBufferView | ArrayBuffer>,
  pattern: RegExp,
): Promise<string[]> {
  const ids = new Set<string>();
  let carried = "";
  const gunzip = new DecompressionStream("gzip");
  // Written to on one side and read from the other rather than piped through: a decompressor's ends
  // are typed in terms of any buffer, and a stream of one kind of buffer is not a stream of that
  // union. A failure on the way in errors the readable side, so the loop below is where it is raised;
  // catching here is only so that the same failure is not also an unhandled rejection.
  const piped = body.pipeTo(gunzip.writable).catch(() => {});
  for await (const chunk of gunzip.readable) {
    const text = carried + Buffer.from(chunk as Uint8Array).toString("latin1");
    collectIds(ids, text, pattern);
    carried = text.slice(-CARRIED_BYTES);
  }
  await piped;
  return sortedIds(ids);
}

type Bundle = {
  source: string;
  package: string;
  vendor: string;
  page: string;
  /** Matches one quoted model id in the bundle; group one is the id. */
  pattern: RegExp;
  /** Below this, the read found the wrong file and the answer is not a catalogue. */
  floor: number;
};

export const CLI_BUNDLES: readonly Bundle[] = [
  {
    source: "gemini-cli-models",
    package: "@google/gemini-cli",
    vendor: "Google",
    page: "https://www.npmjs.com/package/@google/gemini-cli",
    pattern: /"(gemini-\d+(?:\.\d+)?(?:-[a-z][a-z0-9]*)+)"/g,
    floor: 5,
  },
  {
    source: "qwen-code-models",
    package: "@qwen-code/qwen-code",
    vendor: "Alibaba",
    page: "https://www.npmjs.com/package/@qwen-code/qwen-code",
    pattern: /"(qwen\d+(?:\.\d+)?(?:-[a-z][a-z0-9]*)+)"/g,
    floor: 5,
  },
];

/** Only a new version is downloaded; the tarball is read in memory and not kept. */
const read = new Map<string, { version: string; collection: Collection }>();

export async function collectCliBundle(bundle: Bundle, request: Fetch = fetch): Promise<Collection> {
  const tags = (await (
    await request(`https://registry.npmjs.org/-/package/${bundle.package}/dist-tags`)
  ).json()) as Record<string, string>;
  const version = tags.latest;
  if (!version) throw new Error(`${bundle.package} has no published version`);
  const seen = read.get(bundle.source);
  if (seen?.version === version) return seen.collection;
  const name = bundle.package.split("/").at(-1);
  const response = await request(`https://registry.npmjs.org/${bundle.package}/-/${name}-${version}.tgz`);
  if (!response.ok) throw new Error(`${bundle.package} ${version}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${bundle.package} ${version}: no body`);
  const ids = await bundleIdsFromStream(response.body, bundle.pattern);
  if (ids.length < bundle.floor) throw new Error(`${bundle.package} ${version} names ${ids.length} models`);
  const collection: Collection = {
    source: bundle.source,
    stream: "github",
    url: `${bundle.page}/v/${version}`,
    raw: ids.join("\n"),
    records: ids.map((id) => ({ id, name: id, maker: bundle.vendor })),
  };
  read.set(bundle.source, { version, collection });
  return collection;
}
