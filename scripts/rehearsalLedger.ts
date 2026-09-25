/**
 * What the last rehearsal found, kept between runs.
 *
 * A rehearsal is expensive and its answer is thrown away the moment the terminal scrolls. Nothing
 * recorded whether the cards were identical yesterday, so "did this change anything?" could only
 * ever be asked about the working tree against one base, never about a week of commits. The card
 * replay already reduces every card it rendered to one sha256, and the policy replay can do the
 * same with its verdicts, so a rehearsal's whole finding is a handful of bytes and there is no
 * reason not to keep it.
 *
 * Kept as JSON in `.rehearsal/`, beside the database copy and ignored with it: it describes this
 * machine's runs, not the repository's history.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Finding = {
  phase: string;
  verdict: "same" | "moved" | "failed";
  /** How many things moved, where the phase counts things. */
  moved: number;
  /** One hash over everything the phase produced, or null where a phase does not reduce to one. */
  fingerprint: string | null;
};

export type Entry = {
  at: string;
  /** The ref asked for, and what it resolved to: `HEAD` means something different tomorrow. */
  base: string;
  baseSha: string;
  head: string;
  /** Whether the working tree had uncommitted changes, which is what makes a run unrepeatable. */
  dirty: boolean;
  days: number;
  findings: Finding[];
};

/** Enough to cover a week of work; this is a notebook, not a record. */
const KEPT = 60;

export function readLedger(path: string): Entry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    // A notebook that cannot be read is a notebook that gets rewritten, not an error to stop for.
    return [];
  }
}

export function appendEntry(path: string, entry: Entry): Entry[] {
  const kept = [...readLedger(path), entry].slice(-KEPT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

/**
 * What the ledger can say that a single run cannot: when this phase last produced these exact
 * bytes, and against which base. A fingerprint that matches one from four commits ago means those
 * four commits did not reach a reader, which is a stronger claim than "nothing moved since HEAD".
 */
export function lastAgreement(entries: Entry[], finding: Finding): string | null {
  if (finding.fingerprint === null) return null;
  const earlier = entries
    .filter((entry) =>
      entry.findings.some((seen) => seen.phase === finding.phase && seen.fingerprint === finding.fingerprint),
    )
    .at(-1);
  if (!earlier) return null;
  return `same ${finding.phase} fingerprint as the run at ${earlier.at} against ${earlier.base} (${earlier.baseSha.slice(0, 7)})`;
}

/** The one line a human wants after a rehearsal: what moved, and what did not. */
export function verdictLine(entry: Entry): string {
  const moved = entry.findings.filter((finding) => finding.verdict === "moved");
  const failed = entry.findings.filter((finding) => finding.verdict === "failed");
  if (failed.length > 0) return `${failed.map((finding) => finding.phase).join(", ")} failed to run.`;
  if (moved.length === 0)
    return `Nothing moved: ${entry.findings.map((finding) => finding.phase).join(", ")} all identical.`;
  return moved.map((finding) => `${finding.phase}: ${finding.moved} moved`).join(", ");
}
