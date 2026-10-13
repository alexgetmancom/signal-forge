import type { Collection } from "../events/types.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { type BundleMemory, forgetful, withinPublishRace } from "./bundleMemory.js";
import { scanGzipStream } from "./gzipScan.js";
import { fetchResponse, readResponseStream } from "./http.js";
import { publishedVersion } from "./npmVersion.js";
import type { Vendor } from "./vendors.js";

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

/**
 * The words a client writes after a version: a size, a variant, or a reasoning effort. A closed list
 * on purpose -- it is what lets an id be read out of a string table with no separators in it.
 */
const SUFFIX = [
  "flash",
  "pro",
  "lite",
  "ultra",
  "nano",
  "mini",
  "fast",
  "live",
  "tts",
  "image",
  "preview",
  "exp",
  "thinking",
  "xhigh",
  "high",
  "medium",
  "minimal",
  "low",
  "max",
  "plus",
  "air",
  "instruct",
  "vision",
  "embedding",
];

/** The longest word of the list standing at this position, or null when none of them is. */
function suffixAt(text: string, at: number): string | null {
  let longest: string | null = null;
  for (const word of SUFFIX)
    if (text.startsWith(word, at) && (longest === null || word.length > longest.length)) longest = word;
  return longest;
}

/**
 * Ids out of a binary whose string table has no separators in it.
 *
 * A Go executable writes its strings end to end -- `gemini-4-argon-mediumgemini-3.8-flash-high` is
 * two ids and one run of bytes -- which is why the quoted pattern in `CLI_BUNDLES` reads zero from
 * one and why these clients were read for their version number alone. Nothing here looks for a
 * boundary, because there is none: it reads a family and a version, then takes the words it knows
 * one at a time and stops at the first thing it does not, which is where the next id begins.
 *
 * One word it does not know is allowed, directly after the version, and only when a word it does
 * know follows it or the run of letters ends. That word is the codename, and it is the whole reason
 * to read a binary at all: `gemini-4-argon` and its three efforts were in Antigravity CLI 1.3.4 on
 * 2026-10-13, thirteen days after the model was announced and while the price list still said
 * `gemini-4`. An unknown word with nothing known behind it is two ids run together rather than a
 * name -- `argongemini` -- so the version alone is kept and nothing is invented. A dash is not the
 * end of a run: `gemini-4-argongemini-3-pro` ends its first id at `gemini-4`, because what follows
 * the unknown word is another version and not a word this list holds.
 */
export function runTogetherModelIds(text: string, seed: RegExp): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(seed)) {
    let at = (match.index ?? 0) + match[0].length;
    const parts = [match[0].toLowerCase()];
    const codename = /^-([a-z]{3,12})/.exec(text.slice(at, at + 13))?.[1];
    if (codename && !suffixAt(codename, 0)) {
      const after = at + codename.length + 1;
      const next = text[after];
      // A word it knows behind the codename, or the end of the run of letters. Anything else is the
      // next id's own family read as the tail of this one's name.
      if ((next === "-" && suffixAt(text, after + 1)) || next === undefined || !/[a-z-]/.test(next)) {
        parts.push(codename);
        at = after;
      }
    }
    for (let word = text[at] === "-" ? suffixAt(text, at + 1) : null; word; word = suffixAt(text, at + 1)) {
      parts.push(word);
      at += word.length + 1;
      if (text[at] !== "-") break;
    }
    const id = parts.join("-");
    if (keep(id)) ids.add(id);
  }
  return sortedIds(ids);
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

/** One maker's ids out of a tarball, gathered across the pieces it arrives in. */
async function bundleIdsFromStream(
  body: ReadableStream<ArrayBufferView | ArrayBuffer>,
  pattern: RegExp,
): Promise<string[]> {
  const ids = new Set<string>();
  await scanGzipStream(body, (text) => collectIds(ids, text, pattern));
  return sortedIds(ids);
}

export type Bundle = {
  source: string;
  package: string;
  vendor: Vendor;
  page: string;
  /** Matches one quoted model id in the bundle; group one is the id. */
  pattern: RegExp;
  /** Below this, the read found the wrong file and the answer is not a catalogue. */
  floor: number;
  /**
   * The channels this package publishes to, in the order it uses them; the first one that exists is
   * read. A client knows a model's name in order to call it, and it knows it on whichever channel
   * the vendor ships to first, which is rarely `latest`.
   *
   * A channel only belongs here if it leads. `@qwen-code/qwen-code` keeps a `nightly` that trails
   * its own `latest` -- 0.24.7 against 0.25.0 on 2026-10-07 -- and reading it would walk this source
   * backwards onto an older bundle, where every name the newer one added reads as a model that was
   * removed.
   */
  channels: readonly string[];
};

export const CLI_BUNDLES: readonly Bundle[] = [
  {
    source: "gemini-cli-models",
    package: "@google/gemini-cli",
    vendor: "Google",
    page: "https://www.npmjs.com/package/@google/gemini-cli",
    pattern: /"(gemini-\d+(?:\.\d+)?(?:-[a-z][a-z0-9]*)+)"/g,
    floor: 5,
    // `nightly` runs two minors ahead of `latest` -- 0.65.0 against 0.63.0 on 2026-10-07 -- and this
    // source had produced no event at all while it read the slower of the two.
    channels: ["nightly", "preview", "latest"],
  },
  {
    source: "qwen-code-models",
    package: "@qwen-code/qwen-code",
    vendor: "Alibaba",
    page: "https://www.npmjs.com/package/@qwen-code/qwen-code",
    pattern: /"(qwen\d+(?:\.\d+)?(?:-[a-z][a-z0-9]*)+)"/g,
    floor: 5,
    // No `nightly`: this package's trails its `latest`. See `channels`.
    channels: ["preview", "latest"],
  },
];

export async function collectCliBundle(
  bundle: Bundle,
  request: Fetch = fetch,
  memory: BundleMemory = forgetful,
): Promise<Collection> {
  const version = await publishedVersion(bundle.package, bundle.channels, request);
  if (!version) throw new SourceError("empty", `${bundle.package} has no published version`);
  // Only a new version is downloaded, and what counts as already read lives in the database rather
  // than in this process: see src/sources/bundleMemory.ts.
  if (memory.lastVersion() === version) {
    const known = memory.ids();
    if (known.length >= bundle.floor) return collected(bundle, version, known);
  }
  const name = bundle.package.split("/").at(-1);
  const response = await fetchResponse(
    `https://registry.npmjs.org/${bundle.package}/-/${name}-${version}.tgz`,
    {},
    request,
  );
  // A tarball that 404s minutes after its dist-tag moved is npm catching up with itself, not a
  // source failing; see `withinPublishRace`. Not remembered, so the next poll downloads it.
  const pending = memory.ids();
  if (response.status === 404 && pending.length >= bundle.floor && withinPublishRace(memory, version))
    return collected(bundle, memory.lastVersion() ?? version, pending);
  if (!response.ok) throw httpFailure(`${bundle.package}: HTTP ${response.status}`, response.status);
  if (!response.body) throw new SourceError("protocol", `${bundle.package}: no body`);
  const ids = await bundleIdsFromStream(readResponseStream(response), bundle.pattern);
  if (ids.length < bundle.floor)
    throw new SourceError("missing-content", `${bundle.package} names ${ids.length} models`);
  memory.remember(version);
  return collected(bundle, version, ids);
}

/** The same question `claudeCodeUnchanged` asks, for the other shipped bundles. */
export async function cliBundleUnchanged(
  bundle: Bundle,
  request: Fetch = fetch,
  memory: BundleMemory = forgetful,
): Promise<boolean> {
  const version = await publishedVersion(bundle.package, bundle.channels, request);
  return version !== null && memory.lastVersion() === version && memory.ids().length >= bundle.floor;
}

function collected(bundle: Bundle, version: string, ids: readonly string[]): Collection {
  return {
    source: bundle.source,
    stream: "github",
    url: `${bundle.page}/v/${version}`,
    raw: ids.join("\n"),
    records: ids.map((id) => ({ id, name: id, maker: bundle.vendor })),
  };
}
