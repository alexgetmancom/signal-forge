import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEntry,
  type Entry,
  type Finding,
  lastAgreement,
  readLedger,
  verdictLine,
} from "../scripts/rehearsalLedger.js";

function anEntry(at: string, base: string, findings: Finding[]): Entry {
  return { at, base, baseSha: `${base}0000000`, head: "head", dirty: false, days: 30, findings };
}
const same = (phase: string, fingerprint: string): Finding => ({ phase, verdict: "same", moved: 0, fingerprint });

describe("the rehearsal ledger", () => {
  test("appends and reads back", () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const path = join(directory, "deeper", "ledger.json");
      appendEntry(path, anEntry("one", "aaaa", [same("cards", "ff")]));
      appendEntry(path, anEntry("two", "bbbb", [same("cards", "ff")]));
      expect(readLedger(path).map((entry) => entry.at)).toEqual(["one", "two"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a ledger that cannot be read is an empty one, not an error", () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const path = join(directory, "ledger.json");
      writeFileSync(path, "{not json");
      expect(readLedger(path)).toEqual([]);
      expect(readLedger(join(directory, "absent.json"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("names the most recent earlier run that produced the same fingerprint", () => {
    const entries = [
      anEntry("2026-09-20T00:00:00Z", "aaaa", [same("cards", "ff")]),
      anEntry("2026-09-21T00:00:00Z", "bbbb", [same("cards", "ff")]),
      anEntry("2026-09-22T00:00:00Z", "cccc", [same("cards", "ee")]),
    ];
    expect(lastAgreement(entries, same("cards", "ff"))).toContain("2026-09-21T00:00:00Z");
    expect(lastAgreement(entries, same("cards", "99"))).toBeNull();
    // A phase that does not reduce to one hash can never agree with anything.
    expect(lastAgreement(entries, { phase: "migration", verdict: "same", moved: 0, fingerprint: null })).toBeNull();
    // Two phases can hold the same hash without that meaning anything, so the phase is part of it.
    expect(lastAgreement(entries, same("policy", "ff"))).toBeNull();
  });

  test("says what moved, and says failure over silence", () => {
    expect(verdictLine(anEntry("now", "aaaa", [same("policy", "a"), same("cards", "b")]))).toEqual(
      "Nothing moved: policy, cards all identical.",
    );
    expect(
      verdictLine(
        anEntry("now", "aaaa", [
          same("policy", "a"),
          { phase: "cards", verdict: "moved", moved: 90, fingerprint: "b" },
        ]),
      ),
    ).toEqual("cards: 90 moved");
    expect(
      verdictLine(
        anEntry("now", "aaaa", [
          { phase: "cards", verdict: "moved", moved: 3, fingerprint: "b" },
          { phase: "policy", verdict: "failed", moved: 0, fingerprint: null },
        ]),
      ),
    ).toEqual("policy failed to run.");
  });
});
