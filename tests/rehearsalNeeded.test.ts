import { describe, expect, test } from "bun:test";
import { owedLine, REQUIREMENTS, required } from "../scripts/rehearsalNeeded.js";

describe("what a change owes", () => {
  test("a file a reader sees owes the card replay, even when it does not look like one", () => {
    // Renaming one sentence in shape.ts moved ninety cards, because eventEmbed suppresses that
    // sentence by matching its first two words. That is the case this mapping exists for.
    expect(required(["src/events/render/shape.ts"]).map((owed) => owed.phase)).toEqual(["cards"]);
    expect(required(["src/summary.ts"]).map((owed) => owed.phase)).toEqual(["cards"]);
  });

  test("a routing rule owes the policy replay and a projection owes its own", () => {
    expect(required(["src/events/batching.ts"]).map((owed) => owed.phase)).toEqual(["policy"]);
    expect(required(["src/events/batchPolicy.ts"]).map((owed) => owed.phase)).toEqual(["policy"]);
    expect(required(["src/events/replayPolicy.ts"]).map((owed) => owed.phase)).toEqual(["policy"]);
    expect(required(["src/events/batchMessages.ts"]).map((owed) => owed.phase)).toEqual(["cards", "policy"]);
    expect(required(["src/hypotheses.ts"]).map((owed) => owed.phase)).toEqual(["projections"]);
    expect(required(["src/storage/migrations/054_x.sql"]).map((owed) => owed.phase)).toEqual(["migration"]);
  });

  test("one change can owe several, in the order the phases run", () => {
    const owed = required(["src/modelFacts.ts", "src/events/render/discord.ts", "tests/recap.test.ts"]);
    expect(owed.map((one) => one.phase)).toEqual(["cards", "projections"]);
    expect(owed[0]?.files).toEqual(["src/events/render/discord.ts"]);
  });

  test("a file the replay reaches owes it, named or not", () => {
    // The mapping was a list of names, and these are the files that list forgot. `standing.ts`
    // holds the forty rules deciding who speaks; `identity.ts` decides what shares a story, and a
    // change to it merged fifty-two of them on a morning when it owed nothing at all.
    expect(required(["src/events/standing.ts"]).map((one) => one.phase)).toEqual(["policy"]);
    expect(required(["src/events/toldBefore.ts"]).map((one) => one.phase)).toEqual(["policy"]);
    expect(required(["src/events/identity.ts"]).map((one) => one.phase)).toContain("stories");
    expect(required(["src/stories.ts"]).map((one) => one.phase)).toEqual(["stories"]);
    // A gate the live path reads and the replay does not still owes it: see the roots of `policy`.
    expect(required(["src/events/cooldown.ts"]).map((one) => one.phase)).toEqual(["policy"]);
  });

  test("a collector owes nothing a replay answers for, and neither does the gate", () => {
    // Reaching the other way would make every change owe every phase, which is the mapping saying
    // nothing in a longer sentence: `operations.ts` alone reaches 268 of the 309 modules in src/.
    expect(required(["src/sources/codingPlans.ts"])).toEqual([]);
    expect(required(["scripts/importGraph.ts"])).toEqual([]);
  });

  test("a change that owes nothing says nothing", () => {
    expect(required(["scripts/check.ts", "AGENTS.md", "tests/tsv.test.ts"])).toEqual([]);
    expect(owedLine([])).toBeNull();
  });

  test("the sentence names the phases, the reason and the command", () => {
    const line = owedLine(required(["src/events/render/shape.ts", "src/recap.ts"])) as string;
    expect(line).toContain("cards (what a card says: src/events/render/shape.ts +1)");
    expect(line).toContain("rehearse --only cards");
    // Every phase named here has to be one `rehearse` actually has.
    expect(REQUIREMENTS.map((one) => one.phase).sort()).toEqual([
      "cards",
      "evidence",
      "migration",
      "policy",
      "projections",
      "reports",
      "retention",
      "stories",
    ]);
  });
});

describe("the form of a stored body", () => {
  test("changing how evidence is stored owes the evidence rehearsal", () => {
    // The commit that took the events table from 47 MB to 16 MB touched these three, and the
    // reader it moved was `summary/events.ts`, which no card replay goes through.
    for (const file of ["src/events/web.ts", "src/events/store.ts", "src/storage/webEvidence.ts"])
      expect(required([file]).map((one) => one.phase)).toContain("evidence");
    expect(required(["src/summary/events.ts"]).map((one) => one.phase)).toContain("evidence");
  });

  test("a reader of a stored body owes it too, not only the writer", () => {
    expect(required(["src/events/render/attachment.ts"]).map((one) => one.phase)).toContain("evidence");
    expect(required(["src/events/signals.ts"]).map((one) => one.phase)).toContain("evidence");
    expect(required(["src/storage/repack.ts"]).map((one) => one.phase)).toEqual(["evidence", "retention"]);
    expect(required(["src/storage/compact.ts"]).map((one) => one.phase)).toEqual(["retention"]);
  });
});
