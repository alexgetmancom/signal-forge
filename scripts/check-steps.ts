/**
 * The one list of checks this repository runs before code leaves the machine. check.ts runs it
 * serially for readable output, or group-parallel for the pre-push gate.
 *
 * Adding a rule means adding a step here, which is what AGENTS.md means by "`bun run check` is the
 * gate and says what it enforces".
 */
export type CheckStep = {
  name: string;
  args: string[];
  /**
   * Whether `--fast` runs it.
   *
   * The whole gate is fifty seconds and it was run twelve times in one session; the inner loop of
   * editing one report needs lint, types and the tests, which is fifteen. What `--fast` leaves out
   * is everything that cannot change from editing a file and rerunning: `audit` goes to the
   * network for a dependency set that did not move, `build` compiles what `typecheck` just checked,
   * and `check-dead-code` answers a question about the whole tree rather than the change. They all
   * run on push, where the hook is `check --parallel` with nothing left out.
   */
  slow?: boolean;
  /**
   * The command to run instead when a name is given on the command line, with the names appended.
   * Only the test run has one: `check --fast shape` is lint, types and the test files matching
   * `Shape`, which is the one-second loop the whole gate was standing in for. It is spelled out here
   * rather than appended to the `test` script because that script names `./tests` explicitly, and
   * `bun test` ignores its filters once a path is given.
   */
  narrowedBy?: string[];
};

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
    { name: "sql", args: ["check-sql"] },
    { name: "deploy scripts", args: ["check-scripts"] },
    { name: "dead code", args: ["check-dead-code"], slow: true },
    { name: "audit", args: ["check-audit"], slow: true },
  ],
  [
    { name: "test", args: ["test"], narrowedBy: ["bun", "test"] },
    { name: "build", args: ["build"], slow: true },
  ],
];
