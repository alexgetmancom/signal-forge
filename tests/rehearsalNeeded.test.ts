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
    expect(required(["src/hypotheses.ts"]).map((owed) => owed.phase)).toEqual(["projections"]);
    expect(required(["src/storage/migrations/054_x.sql"]).map((owed) => owed.phase)).toEqual(["migration"]);
  });

  test("one change can owe several, in the order the phases run", () => {
    const owed = required(["src/modelFacts.ts", "src/events/render/discord.ts", "tests/recap.test.ts"]);
    expect(owed.map((one) => one.phase)).toEqual(["cards", "projections"]);
    expect(owed[0]?.files).toEqual(["src/events/render/discord.ts"]);
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
    expect(REQUIREMENTS.map((one) => one.phase).sort()).toEqual(["cards", "migration", "policy", "projections"]);
  });
});
