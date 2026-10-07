/**
 * Which rehearsal a change owes, worked out from the files it touched.
 *
 * "Before changing what reaches a reader, run `bun run rehearse`" and "before changing a projection,
 * run `bun run rehearse-projections`" were two of the longest rules in AGENTS.md. Moving them into
 * `bun run guide` made them shorter and no less a thing to remember: they are still sentences that
 * have to be read, matched against what I just edited, and acted on. And the matching is the part
 * a person gets wrong -- `shape.ts` is not obviously a file a reader sees until renaming one
 * sentence in it moves ninety cards.
 *
 * It is a mapping, so it is code. `rehearse --needed` runs exactly the phases the diff asks for,
 * and the gate prints the line rather than failing on it: the rehearsal needs production and the
 * gate must run without it.
 *
 * The mapping was a list of file names, and a list of names is wrong in the direction that does not
 * fail. `standing.ts` holds the forty rules deciding who speaks and owed nothing; `identity.ts`
 * owed nothing on the morning a change to it merged fifty-two stories, and was rehearsed only
 * because someone thought to. Of the 103 files a replayed entry point can reach, 89 were unnamed.
 *
 * So a phase now names what the replay actually loads, and `reaches` asks the import graph for the
 * rest: a file the replay can reach is a file the change can move. A name has to be remembered; an
 * import cannot be forgotten, because the code does not run without it. `touches` stays for what no
 * import leads to -- a migration, an operation's own folder, a rehearsal script's own subject --
 * and the two are a union.
 */
import { resolve } from "node:path";
import { localGraph, reaches } from "./importGraph.js";

export type Requirement = {
  phase: string;
  because: string;
  /** What the replay for this phase imports, from which the graph works out the rest. */
  roots?: readonly string[];
  /** What no import from a root leads to and the phase is about anyway. */
  touches?: RegExp;
};

/**
 * Ordered by how expensive being wrong is. A file may owe more than one.
 *
 * Deliberately wide, both halves of it. A rehearsal that was not needed costs twenty seconds; one
 * that was needed and not run costs a channel full of cards about nothing. 49 of the 309 modules in
 * `src/` are reachable from every replayed root, which is the honest answer for `text.ts` and
 * `record.ts`: a sentence either of them renders is read by all three.
 */
export const REQUIREMENTS: readonly Requirement[] = [
  {
    phase: "cards",
    because: "what a card says",
    roots: ["src/events/render/discord.ts"],
    touches: /^src\/(events\/(batchMessages|naming)\.ts|summary\.ts|recap\.ts)/,
  },
  {
    phase: "policy",
    because: "which cards are sent",
    /**
     * Both halves: the replay, and `batchPolicy.ts` whose twin it is. A file the live gate reads
     * and the replay does not is the case worth being loud about -- a rehearsal that reports
     * nothing moved on a change to `cooldown.ts` has found the twin's blind spot, which is more
     * than the silence it replaces.
     */
    roots: ["src/events/replayPolicy.ts", "src/events/batchPolicy.ts"],
    touches: /^src\/(events\/(batching|batchPolicy|batchMessages)\.ts|insights\.ts|jev\.ts|delivery\.ts)/,
  },
  {
    phase: "reports",
    because: "what a report answers",
    /**
     * Named rather than reached, and the only phase that is. `operations.ts` mounts every
     * operation, so it reaches 268 of the 309 modules here: every collector, every renderer,
     * everything. A requirement that fires on every change says nothing and gets ignored, which is
     * the failure the graph was brought in to fix rather than one to spread.
     */
    touches: /^src\/(reports\/|operations\/|status\.ts|capabilities\.ts)/,
  },
  {
    phase: "stories",
    because: "which events share a story",
    roots: ["src/stories.ts"],
  },
  {
    phase: "projections",
    because: "a projection built incrementally",
    roots: ["src/modelFacts.ts", "src/hypotheses.ts"],
    touches: /^src\/events\/store\.ts/,
  },
  {
    phase: "evidence",
    because: "the form of a stored body, or what reads one",
    roots: ["src/summary/events.ts"],
    touches:
      /^src\/(events\/(web|store|signals)\.ts|events\/render\/(attachment|common)\.ts|storage\/(webEvidence|payloadCodec|snapshots|repack)\.ts)/,
  },
  {
    phase: "retention",
    because: "what a sweep removes, and what it frees",
    touches:
      /^src\/(storage\/(retention|repack|compact)\.ts|runtime\/metricFold\.ts|runtime\/metricRecording\.ts|storage\/collectionDays\.ts)/,
  },
  {
    phase: "migration",
    because: "the schema production is holding",
    touches: /^src\/storage\/(migrations\/|migrations\.ts|hotQueries\.ts)/,
  },
];

export type Owed = { phase: string; because: string; files: string[] };

/**
 * The graph, read once. `required` is called by the gate, by `rehearse --needed` and by its tests,
 * and all three ask about a handful of files against the same working tree.
 */
let cached: Map<string, readonly string[]> | null = null;
function graph(): Map<string, readonly string[]> {
  if (!cached) cached = localGraph(resolve(import.meta.dir, ".."));
  return cached;
}

/** What the changed files owe, in the order the phases run. */
export function required(changed: readonly string[]): Owed[] {
  return REQUIREMENTS.map((requirement) => {
    const reachable = requirement.roots ? reaches(graph(), requirement.roots) : null;
    return {
      phase: requirement.phase,
      because: requirement.because,
      files: changed.filter((file) => requirement.touches?.test(file) || reachable?.has(file)),
    };
  }).filter((owed) => owed.files.length > 0);
}

/** The sentence the gate prints, or null when the change owes nothing. */
export function owedLine(owed: Owed[]): string | null {
  if (owed.length === 0) return null;
  const phases = owed.map((one) => one.phase).join(",");
  const why = owed.map(
    (one) => `${one.phase} (${one.because}: ${one.files[0]}${one.files.length > 1 ? ` +${one.files.length - 1}` : ""})`,
  );
  return `This change owes a rehearsal: ${why.join(", ")}.\nRun \`bun run rehearse --only ${phases}\`, or \`bun run rehearse --needed\` which works this out again.`;
}
