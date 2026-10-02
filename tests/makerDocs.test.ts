import { expect, test } from "bun:test";
import { parseAnthropicModelIndex, parseOpenAIModelIndex } from "../src/sources/modelIndex.js";
import { parseOpenAIDocsIndex, parseOpenAIPricing } from "../src/sources/openaiDocs.js";

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

const docsIndex = `# OpenAI API docs

## Guides
- [Error codes](https://developers.openai.com/api/docs/guides/error-codes.md): An overview of error codes, including solutions.
- [Upgrading to GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md): Machine-readable guidance for migrating to GPT-5.6 Sol.
- [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md): Learn how to use GPT-6 Astra, GPT-6.1 Sol and GPT-6 Luna.
`;

test("a guide is kept when it names a model and passed over when it does not", () => {
  const collection = parseOpenAIDocsIndex(docsIndex);
  expect(collection.records.map((record) => record.id)).toEqual([
    "guides/upgrading-to-gpt-5p6-sol",
    "guides/latest-model/gpt-6-astra",
  ]);
  expect(collection.records[0]).toMatchObject({
    name: "Upgrading to GPT-5.6 Sol",
    url: "https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol",
  });
});

test("an index this parser can no longer read is a failure, not a site that documents nothing", () => {
  expect(() => parseOpenAIDocsIndex("# OpenAI API docs\n\nSomething else entirely.\n")).toThrow("listed no page");
});

const pricing = `# Pricing

Standard

### Standard pricing data

| Model | Input | Output |
| --- | --- | --- |
| gpt-6.1-sol | $2.00 | $10.00 |
| gpt-6-luna | $0.10 | $0.50 |

Batch

### Standard pricing data

| Model | Input | Output |
| --- | --- | --- |
| gpt-6.1-sol | $1.00 | $5.00 |
`;

test("one model priced in two modes is two rows, each under the column names of its own table", () => {
  const collection = parseOpenAIPricing(pricing);
  expect(collection.records.map((record) => record.id)).toEqual([
    "Standard pricing data / Standard:gpt-6.1-sol",
    "Standard pricing data / Standard:gpt-6-luna",
    "Standard pricing data / Batch:gpt-6.1-sol",
  ]);
  expect(collection.records[0]).toMatchObject({
    model: "gpt-6.1-sol",
    tier: "Standard pricing data / Standard",
    prices: { Input: 2, Output: 10 },
  });
  // A price that moved has to be re-read before it is believed, like every other price here.
  expect(collection.confirmChanges).toBe(true);
});

const groupedPricing = `# Pricing

Standard

### Grouped Pricing Table data

| Category | Model | Input | Output |
| --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $14.00 |
| Life Sciences | gpt-rosalind-research | $5.00 | $25.00 |

Fast

### Grouped Pricing Table data

| Category | Model | Input | Output |
| --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $28.00 |

### Grouped Pricing Table data

| Model | Modality | Input | Output |
| --- | --- | --- | --- |
| gpt-realtime-2.1 | Audio | $32.00 | $64.00 |
| gpt-realtime-2.1 | Text | $4.00 | $24.00 |

### Pricing Table data

| Model | Price per minute |
| --- | --- |
| gpt-live-1 | $0.05 |
| Whisper | $0.006 |
`;

test("a table says which of its columns is the model, and the rest of the row is what sets it apart", () => {
  const collection = parseOpenAIPricing(groupedPricing);
  expect(collection.records.map((record) => record.id)).toEqual([
    // The model is the second column here, and the first is the group it is sold in.
    "Grouped Pricing Table data / Standard:gpt-5.3-codex",
    "Grouped Pricing Table data / Standard:gpt-rosalind-research",
    "Grouped Pricing Table data / Fast:gpt-5.3-codex",
    // One model priced per modality is one row per modality, not the first of them.
    "Grouped Pricing Table data / Audio:gpt-realtime-2.1",
    "Grouped Pricing Table data / Text:gpt-realtime-2.1",
    // A table that states no mode is not priced in the mode of the table above it.
    "Pricing Table data:gpt-live-1",
  ]);
});

test("a row whose first column is a tool is not a model, and a parenthesised ceiling is not another one", () => {
  const collection = parseOpenAIPricing(`# Pricing

### Pricing Table data

| Model | Input | Output |
| --- | --- | --- |
| gpt-5.5 | $5.00 | $30.00 |
| gpt-5.5 (<272K context length) | $2.50 | $15.00 |
| Web search | $10.00 | - |
`);
  expect(collection.records.map((record) => record.id)).toEqual([
    "Pricing Table data:gpt-5.5",
    "Pricing Table data / <272K context length:gpt-5.5",
  ]);
  expect(collection.records[1]).toMatchObject({ model: "gpt-5.5" });
});

test("a price table whose shape moved is a failure, not every model losing its price", () => {
  expect(() => parseOpenAIPricing("# Pricing\n\n| Model | Input |\n| --- | --- |\n")).toThrow("no priced model");
});
