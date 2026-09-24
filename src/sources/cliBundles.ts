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
  const ids = new Set<string>();
  for (const [, id] of text.matchAll(pattern)) if (id && keep(id)) ids.add(id);
  return [...ids].sort();
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
  const text = Buffer.from(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))).toString("latin1");
  const ids = bundleModelIds(text, bundle.pattern);
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
