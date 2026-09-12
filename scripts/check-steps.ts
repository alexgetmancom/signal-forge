/**
 * The one list of checks this repository runs before code leaves the machine. check.ts runs it
 * serially for readable output, or group-parallel for the pre-push gate.
 *
 * Adding a rule means adding a step here, which is what CLAUDE.md means by "`bun run check` is the
 * gate and says what it enforces".
 */
export type CheckStep = { name: string; args: string[] };

/** Ordered: a group only starts once the previous one passed. Within a group nothing depends on a
 * sibling, so the order inside it is arbitrary and the whole group can run at once. */
export const CHECK_GROUPS: CheckStep[][] = [
  // Non-English text is the cheapest failure to find and the most confusing one to read past, so
  // it reports before anything else floods the terminal.
  [{ name: "language", args: ["check-language"] }],
  [
    { name: "lint", args: ["lint"] },
    { name: "typecheck", args: ["typecheck"] },
    { name: "architecture", args: ["check-architecture"] },
    { name: "migrations", args: ["check-migrations"] },
    { name: "dead code", args: ["check-dead-code"] },
    { name: "audit", args: ["check-audit"] },
  ],
  [
    { name: "test", args: ["test"] },
    { name: "build", args: ["build"] },
  ],
];
