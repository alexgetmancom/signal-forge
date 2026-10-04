import { expect, test } from "bun:test";
import { parseAntigravityChangelog, parseAntigravityModels } from "../src/sources/antigravity.js";
import { parseJulesChangelog } from "../src/sources/jules.js";
import { parseKaggleModels } from "../src/sources/kaggle.js";

/**
 * The shapes below are the ones production read on 2026-10-04, cut to the rows each rule is about.
 */

const CHANGELOG = `# Changelog

Track new features across Google Antigravity surfaces.

## Antigravity 2.0

### [v2.19.1](/releases?tab=hub&version=2.19.1 "View release 2.19.1")

Latest

September 30, 2026

### Message subagents directly

You can now send messages straight to a subagent.

---

### [v2.18.1](/releases?tab=hub&version=2.18.1 "View release 2.18.1")

September 28, 2026

### Manage & Install plugins in AGY

This release introduces a Customizations tab.

## Antigravity CLI

### [v1.2.14](/releases?tab=cli&version=1.2.14 "View release 1.2.14")

September 29, 2026

### Faster startup

The CLI now starts faster.
`;

test("a changelog entry belongs to the surface it sits under, and 'Latest' is not its date", () => {
  const collection = parseAntigravityChangelog(CHANGELOG);
  const ids = collection.records.map((record) => record.id);
  expect(ids).toEqual([
    "antigravity:antigravity-2-0:2.19.1",
    "antigravity:antigravity-2-0:2.18.1",
    "antigravity:antigravity-cli:1.2.14",
  ]);
  // The newest entry carries "Latest" above its date; the date is the first line that reads as one.
  expect(collection.records[0]?.published).toBe("2026-09-30T00:00:00.000Z");
  // A CLI release is not filed under the app heading two sections above it.
  expect(collection.records[2]?.surface).toBe("Antigravity CLI");
  expect(collection.records[2]?.version).toBe("1.2.14");
});

test("a changelog with no versioned entries is missing content rather than an empty answer", () => {
  expect(() => parseAntigravityChangelog("# Changelog\n\nNothing here yet.\n")).toThrow(/no versioned entries/);
});

const MODELS = `# Models

## Reasoning model

| Model | Free & Google AI Plus | Google AI Pro | Google AI Ultra | Enterprise |
| --- | --- | --- | --- | --- |
| [Gemini 3.8 Flash](/blog/gemini-3-8-flash-in-google-antigravity) | ✅ | ✅ | ✅ | ✅ |
| Claude Opus 5.5 (thinking)\\*\\* | ❌ | ✅\\*\\* | ✅ | ❌ |
| GPT-OSS-120b\\* | ✅ | ✅ | ✅ | ❌ |

\\* Will be removed on November 2, 2026.
`;

test("the plan matrix keeps every model a tier can select, including the ones Google does not make", () => {
  const collection = parseAntigravityModels(MODELS);
  expect(collection.records.map((record) => record.name)).toEqual([
    "Gemini 3.8 Flash",
    "Claude Opus 5.5 (thinking)",
    "GPT-OSS-120b",
  ]);
  // A link in the cell is the model's page, not part of its name.
  expect(collection.records[0]?.id).toBe("antigravity-model:gemini-3.8-flash");
  // Which tiers may select it is the fact worth an event when it changes.
  expect(collection.records[1]?.plans).toEqual(["Google AI Pro", "Google AI Ultra"]);
  expect(collection.records[2]?.plans).toEqual(["Free & Google AI Plus", "Google AI Pro", "Google AI Ultra"]);
});

const JULES = `<nav class="changelog-sidebar"><ul class="changelog-list">
<li><a href="/docs/changelog/" class="changelog-entry current"><span class="changelog-title">All Updates</span></a></li>
<li><a href="/docs/changelog/2026-03-09" class="changelog-entry"> <span class="changelog-title">Gemini 3.1 Pro is now available in Jules</span> <span class="changelog-date">Mar 09, 2026</span> </a></li>
<li><a href="/docs/changelog/2026-01-30" class="changelog-entry"> <span class="changelog-title">Gemini 3 Flash is now the base model in Jules</span> <span class="changelog-date">Jan 30, 2026</span> </a></li>
</ul></nav>`;

test("the Jules index gives one record per dated entry, and its 'All Updates' link is not one", () => {
  const collection = parseJulesChangelog(JULES);
  expect(collection.records).toHaveLength(2);
  expect(collection.records[0]?.id).toBe("jules:2026-03-09");
  expect(collection.records[0]?.name).toBe("Gemini 3.1 Pro is now available in Jules");
  expect(collection.records[0]?.published).toBe("2026-03-09T00:00:00.000Z");
});

const KAGGLE_PAGE_ONE = JSON.stringify({
  models: [
    {
      ref: "google/gemma-4",
      title: "Gemma 4",
      updateTime: "2026-06-05T00:00:00Z",
      instances: [{ framework: "MODEL_FRAMEWORK_TRANSFORMERS" }, { framework: "MODEL_FRAMEWORK_GGUF" }],
    },
  ],
  nextPageToken: "token",
});
const KAGGLE_PAGE_TWO = JSON.stringify({
  models: [
    {
      ref: "google/gemini-3-flash-api",
      title: "Gemini 3 Flash API",
      updateTime: "2025-12-19T00:00:00Z",
      instances: [],
    },
  ],
});

test("a Kaggle owner is the pages joined, and a card's frameworks are kept once each", () => {
  const collection = parseKaggleModels([KAGGLE_PAGE_ONE, KAGGLE_PAGE_TWO], "google");
  expect(collection.records.map((record) => record.id)).toEqual(["google/gemma-4", "google/gemini-3-flash-api"]);
  expect(collection.records[0]?.frameworks).toEqual(["MODEL_FRAMEWORK_GGUF", "MODEL_FRAMEWORK_TRANSFORMERS"]);
  // A card that only the second page carried is still the owner's, so the pages are one answer.
  expect(collection.raw).toContain("gemini-3-flash-api");
});
