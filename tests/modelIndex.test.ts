import { expect, test } from "bun:test";
import { parseAnthropicModelIndex, parseOpenAIModelIndex } from "../src/sources/modelIndex.js";

const openaiIndex = `# All models

> Browse models and compare their capabilities.

[Models](/api/docs/models.md) · [Compare models](/api/docs/models/compare.md)

## Flagship models

- [GPT-6 Astra](/api/docs/models/gpt-6-astra.md): Our most capable model for the most demanding work.
- [GPT-6.1 Sol](/api/docs/models/gpt-6.1-sol.md): Near-Astra performance for complex work at a lower cost.

## Image

- [All models](/api/docs/models/all.md): Browse the complete OpenAI API model catalog.
`;

test("the model index names every page the maker documents, and not the pages that index them", () => {
  const collection = parseOpenAIModelIndex(openaiIndex);
  expect(collection.records.map((record) => record.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  // The reader is sent to the page itself, not to the Markdown twin this was read from.
  expect(collection.records[1]).toMatchObject({
    name: "GPT-6.1 Sol",
    url: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    maker: "OpenAI",
    summary: "Near-Astra performance for complex work at a lower cost.",
  });
});

test("an index that names no model is a failure, not an empty catalogue", () => {
  // A redesign that moves the list would otherwise read as every model being withdrawn at once.
  expect(() => parseOpenAIModelIndex("# All models\n\nNothing here.\n")).toThrow("named no model");
  expect(() => parseAnthropicModelIndex("| Nothing | at | all |")).toThrow("named no model");
});

test("one Anthropic model is one record however many platforms spell it", () => {
  const collection = parseAnthropicModelIndex(
    [
      "| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-haiku-4-5-20251001` |",
      "| Bedrock ID | `anthropic.claude-fable-5-1` | `anthropic.claude-opus-5-5` | `anthropic.claude-haiku-4-5` |",
      "| Vertex ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-haiku-4-5@20251001` |",
    ].join("\n"),
  );
  // The dated snapshot and the alias are the same model, and the reseller prefix is not part of it.
  expect(collection.records.map((record) => record.id)).toEqual([
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-haiku-4-5",
  ]);
  expect(collection.records.every((record) => record.maker === "Anthropic")).toBe(true);
});
