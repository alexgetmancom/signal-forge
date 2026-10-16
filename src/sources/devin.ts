import type { Collection } from "../events/types.js";
import { httpFailure, SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { type BundleMemory, forgetful, withinPublishRace } from "./bundleMemory.js";
import { scanGzipStream } from "./gzipScan.js";
import { fetchResponse, readResponseStream } from "./http.js";
import { publishedVersion } from "./npmVersion.js";

/**
 * Anthropic's model ids out of a client Anthropic does not publish.
 *
 * Every other `shipped-binary` here reads a maker's own client, which is why that kind is
 * `vendor_owned`. This one reads Cognition's: `devin`, "Devin for Terminal", a Rust executable
 * whose string table carries the ids it routes to. A third party's client has to know a name in
 * order to call it, and it is told that name under an agreement rather than by a catalogue, so
 * what turns up here is the set a maker has handed to a partner and published nowhere -- the
 * reason the kind beside this one is `third-party-client-binary` and `third_party`.
 *
 * Read 2026-10-16, build 3000.11.92-linux-x64: five names no source here had ever said --
 * `claude-vanilla`, `claude-verrine`, `claude-onigiri`, `claude-orzata`, `claude-odango` -- while
 * every versioned id in the same table (`claude-opus-5-5`, `claude-fable-5-1`, `claude-haiku-5-5`)
 * was already carried by two hundred sightings elsewhere. The versioned ids are read anyway, and
 * not for their news: see `FLOOR`.
 *
 * 68.3 MB compressed, 200.4 MB unpacked, so it is streamed rather than held and read only when the
 * published version moves. The platform build is the one with the executable in it; `latest` is the
 * installer shim and names no model.
 */
const PACKAGE = "devin";

/**
 * The platform whose build is read. One of six, because the names in it are the service's rather
 * than the host's, and reading a second buys another 68 MB of the same answer. Not `latest`: that
 * tag is the shim, and a floor measured against it would fail every poll.
 */
const CHANNELS = ["linux-x64"];

/**
 * Below this the read found the shim, a repackaged client or a build with no model table, and the
 * answer is not a catalogue.
 *
 * It counts the versioned ids alone, which is the whole reason they are read. A codename reader on
 * its own cannot tell "the partner names no unreleased model this week" from "the scan found
 * nothing at all", and the first of those is an ordinary answer while the second is a source that
 * has quietly stopped working. Seventeen versioned ids were in the build read on 2026-10-16.
 */
const FLOOR = 10;

/**
 * The versioned ids, which have a family word and a version and are unambiguous in a table with no
 * separators in it. Deliberately not `runTogetherModelIds`: the words this client writes after a
 * version are routing efforts rather than variants -- `claude-opus-5-5-xhigh-priority-usa` is one
 * model on four knobs -- and reading them as part of the name would invent eleven models per id.
 */
const VERSIONED = /claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)?/g;

/**
 * `claude-sonnet-4-20250514` is a checkpoint of the id it dates. The date is cut rather than the
 * whole name dropped: the version this client writes is the one the maker ships, and a build that
 * names only the dated spelling would otherwise lose the model entirely.
 */
const DATED = /-\d{8}$/;

/**
 * A codename on the early-access channel: `claude-vanilla-eap`.
 *
 * The suffix is matched loosely and then dropped, because the table cuts it. Strings are packed
 * end to end and aligned to sixteen bytes only when they overflow, so `claude-vanilla-eap` and
 * `claude-orzata-eap` are written whole and padded while `claude-verrine-e`, `claude-onigiri-e`
 * and `claude-odango-ea` are what is left of eighteen characters in a sixteen-byte slot. Anything
 * reconstructed from that is a guess, so nothing is: what is stored is `claude-<codename>`, which
 * is the part every spelling agrees on. `-eap` is a channel the name is offered on rather than
 * part of it, the way `-usa` and `-fast` are not part of `claude-opus-5-5`.
 *
 * What follows the suffix is the next id or the padding, never a letter continuing this word --
 * which is what keeps `claude-verrine-eclaude-onigiri-e` two names and not one.
 */
const CODENAME = /claude-([a-z]{3,12})-e(?:ap?)?(?=claude-|[^a-z]|$)/g;

/** The family words above. A codename is a word that is not one of these. */
const FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** What one chunk of the executable names: the versioned ids, and the codenames beside them. */
export function devinModelIds(text: string): { versioned: string[]; codenames: string[] } {
  const versioned = new Set<string>();
  for (const [id] of text.matchAll(VERSIONED)) versioned.add(id.replace(DATED, ""));
  const codenames = new Set<string>();
  for (const [, word] of text.matchAll(CODENAME)) if (word && !FAMILIES.has(word)) codenames.add(`claude-${word}`);
  return { versioned: [...versioned].sort(), codenames: [...codenames].sort() };
}

/** Whether the published build is the one already read through, asked without downloading it. */
export async function devinModelsUnchanged(request: Fetch = fetch, memory: BundleMemory = forgetful): Promise<boolean> {
  const version = await publishedVersion(PACKAGE, CHANNELS, request);
  return version !== null && memory.lastVersion() === version && memory.ids().length >= FLOOR;
}

/** The model ids Devin's terminal client ships knowing about, read once per published build. */
export async function collectDevinModels(
  request: Fetch = fetch,
  memory: BundleMemory = forgetful,
): Promise<Collection> {
  const version = await publishedVersion(PACKAGE, CHANNELS, request);
  if (!version) throw new SourceError("empty", `${PACKAGE} publishes no build for ${CHANNELS.join(", ")}`);
  if (memory.lastVersion() === version) {
    const known = memory.ids();
    if (known.length >= FLOOR) return collection(version, known);
  }
  const response = await fetchResponse(
    `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`,
    {},
    request,
  );
  // A dist-tag that moves before the tarball is served is npm catching up with itself, not a source
  // failing; see `withinPublishRace`. The version is not remembered, so the next poll downloads it.
  const pending = memory.ids();
  if (response.status === 404 && pending.length >= FLOOR && withinPublishRace(memory, version))
    return collection(memory.lastVersion() ?? version, pending);
  if (!response.ok) throw httpFailure(`Devin CLI ${version}: HTTP ${response.status}`, response.status);
  if (!response.body) throw new SourceError("protocol", `Devin CLI ${version}: no body`);
  const versioned = new Set<string>();
  const codenames = new Set<string>();
  await scanGzipStream(readResponseStream(response), (text) => {
    const found = devinModelIds(text);
    for (const id of found.versioned) versioned.add(id);
    for (const id of found.codenames) codenames.add(id);
  });
  if (versioned.size < FLOOR)
    throw new SourceError("missing-content", `Devin CLI ${version} names ${versioned.size} versioned models`);
  const ids = [...new Set([...versioned, ...codenames])].sort();
  memory.remember(version);
  return collection(version, ids);
}

/**
 * The maker is Anthropic on every record and Cognition on none of them. The vendor of a source is
 * the maker its names belong to -- `stories` correlates on it -- and who published the client that
 * wrote them down is `authority`'s question, which this kind answers with `third_party`.
 */
function collection(version: string, ids: readonly string[]): Collection {
  return {
    source: "devin-cli-models",
    stream: "github",
    url: `https://www.npmjs.com/package/${PACKAGE}/v/${version}`,
    raw: ids.join("\n"),
    records: ids.map((id) => ({ id, name: id, maker: "Anthropic" })),
  };
}
