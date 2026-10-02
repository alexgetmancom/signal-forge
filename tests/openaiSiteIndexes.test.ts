import { expect, test } from "bun:test";
import { parseOpenAIDocsIndex, parseOpenAILearnIndex, parseOpenAIShowcaseIndex } from "../src/sources/openaiDocs.js";

// The learn index as it answered on 2026-09-29: its own guides, the cookbook it curates, and the
// GitHub, YouTube and platform.openai.com addresses that make up most of it.
const learn = `# Learn

## Documentation sets
- [Combined learn docs](https://developers.openai.com/learn/llms-full.txt): Single-file Markdown export of learn docs.

## Code
- [Agents SDK — Python](https://github.com/openai/openai-agents-python): Python SDK for developing agents with GPT-6.

## Cookbook
- [GPT-5.2 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide): Cookbook to prompt GPT-5.2 for enterprise workflows.
- [Doing RAG on PDFs](https://developers.openai.com/cookbook/examples/file_search_responses): Cookbook to search PDFs with the Responses API.

## Docs
- [Upgrading to GPT-6.1 Sol](https://developers.openai.com/learn/upgrade-gpt-6-1.md): What changes when you move to GPT-6.1 Sol.
- [Upgrading to GPT-6.1 Sol](https://developers.openai.com/learn/upgrade-gpt-6-1): What changes when you move to GPT-6.1 Sol.

## Guide
- [API deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist): Checklist for tuning GPT-6 applications before launch.
- [Audio guide](https://platform.openai.com/docs/guides/audio): Overview of speech with GPT-6.
`;

test("the learn index keeps its own pages and the cookbook, and leaves everyone else's addresses alone", () => {
  const { records } = parseOpenAILearnIndex(learn);
  expect(records.map((record) => record.id)).toEqual([
    "cookbook/examples/gpt-5/gpt-5-2_prompting_guide",
    "upgrade-gpt-6-1",
  ]);
  // A guide the documentation index already carries would otherwise arrive twice under two ids.
  expect(records.some((record) => String(record.url).includes("/api/docs/"))).toBe(false);
  // The bulk export names every model the whole site mentions, and is not a page.
  expect(records.some((record) => String(record.url).endsWith(".txt"))).toBe(false);
});

// The showcase says which model built each project in as many words.
const showcase = `# OpenAI developer showcase

## Showcase projects
- [Abyssal](https://developers.openai.com/showcase/abyssal): A procedural underwater scene. Built with: Codex + GPT-6 Astra. Models: gpt-6. Products: Codex.
- [Crossword Desk](https://developers.openai.com/showcase/crossword-desk): Build crosswords from a themed word pool. Built with: Codex and Sites.
- [Arcade Bar](https://developers.openai.com/showcase/arcade-bar): A landing page with generated art. Built with: Codex + GPT-5.5 + GPT Image 2. Models: gpt-5.5, gpt-image-2. Use cases: landing-pages.
- [Turn-based RPG](https://developers.openai.com/showcase/turn-based-rpg): Play a turn-based RPG where GPT-5.4 drives encounters. Built with: Codex + gpt-5.4. Technologies: Next.js.
`;

test("a showcase project carries the models it is tagged with, and an untagged project is not a sighting", () => {
  const { records } = parseOpenAIShowcaseIndex(showcase);
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({ id: "abyssal", name: "Abyssal", models: ["gpt-6"] });
  /**
   * The tag is a declaration, so it is read as one: `gpt-image-2` is a model to the showcase and
   * not to a rule that has to tell a model from a sentence, and the version in `gpt-5.5` is not
   * the end of the list it sits in.
   */
  expect(records[1]).toMatchObject({ id: "arcade-bar", models: ["gpt-5.5", "gpt-image-2"] });
  /**
   * The declaration is read as well as the sentences and not instead of them: three of the
   * seventy-three projects on 2026-10-02 declared nothing and named a model in the description,
   * and a project is not untagged just because it was written without the field.
   */
  expect(records[2]).toMatchObject({ id: "turn-based-rpg", models: ["gpt-5.4"] });
});

// The documentation index, whose entries must keep the ids they have always had.
const docs = `# OpenAI API

## Docs
- [Migrate to GPT-6](https://developers.openai.com/api/docs/guides/migrate-to-gpt-6.md): Move your application to GPT-6.
- [Error codes](https://developers.openai.com/api/docs/guides/error-codes.md): What each error code means.
`;

test("a documentation page is identified by its path below the index, and only pages naming a model are kept", () => {
  const { records } = parseOpenAIDocsIndex(docs);
  expect(records.map((record) => record.id)).toEqual(["guides/migrate-to-gpt-6"]);
  expect(records[0]?.url).toBe("https://developers.openai.com/api/docs/guides/migrate-to-gpt-6");
  // The documentation index is not read for tags; only the showcase states its models.
  expect(records[0]).not.toHaveProperty("models");
});

test("an index this parser can no longer read is a failure, not a site that documents nothing", () => {
  expect(() => parseOpenAILearnIndex("# Learn\n\nNothing here.\n")).toThrow("openai-learn-index");
});
