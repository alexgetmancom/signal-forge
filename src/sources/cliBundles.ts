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
