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
 */
export type Requirement = { phase: string; because: string; touches: RegExp };

/**
 * Ordered by how expensive being wrong is. A file may owe more than one.
 *
 * `touches` is deliberately wide. A rehearsal that was not needed costs twenty seconds; one that
 * was needed and not run costs a channel full of cards about nothing.
 */
export const REQUIREMENTS: readonly Requirement[] = [
  {
    phase: "cards",
    because: "what a card says",
    touches: /^src\/(events\/render\/|summary\.ts|recap\.ts|events\/naming\.ts|events\/vendors\.ts|text\.ts)/,
  },
  {
    phase: "policy",
    because: "which cards are sent",
    touches:
      /^src\/(events\/(batching|worth|signals|classify|oscillation|rename|variants|witness|breakouts)\.ts|insights\.ts|jev\.ts|delivery\.ts)/,
  },
  {
    phase: "projections",
    because: "a projection built incrementally",
    touches: /^src\/(modelFacts\.ts|hypotheses\.ts|stories\.ts|events\/store\.ts)/,
  },
  {
    phase: "migration",
    because: "the schema production is holding",
    touches: /^src\/storage\/(migrations\/|migrations\.ts|hotQueries\.ts)/,
  },
];

export type Owed = { phase: string; because: string; files: string[] };

/** What the changed files owe, in the order the phases run. */
export function required(changed: readonly string[]): Owed[] {
  return REQUIREMENTS.map((requirement) => ({
    phase: requirement.phase,
    because: requirement.because,
    files: changed.filter((file) => requirement.touches.test(file)),
  })).filter((owed) => owed.files.length > 0);
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
