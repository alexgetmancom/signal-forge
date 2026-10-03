import { expect, test } from "bun:test";
import { claudeModelIds } from "../src/sources/claudeCode.js";
import { bundleModelIds, CLI_BUNDLES } from "../src/sources/cliBundles.js";
import { commandCodeModelIds } from "../src/sources/codingPlans.js";
import { modelIdsInPatch, modelIdsInText } from "../src/sources/modelMentions.js";

/**
 * One corpus of strings, read by every reader that turns text into model ids.
 *
 * Each of these readers has its own test and each one passed, because each was asked only about the
 * strings its author had in mind. What no test asked was whether they agree, and they are reading
 * the same names out of the same kind of file: a coding client's bundle, a commit, a registry. A
 * disagreement is invisible from inside any one of them -- `claude-mythos-preview` was in the Claude
 * Code binary and the mention reader could not see it, and the shared client-word list in
 * `modelMentions.ts` carries a comment about having lived in `claudeCode.ts` and applying only
 * there. This is the third instance of one bug, so it is a corpus rather than another case.
 *
 * The rule is that silence outside a reader's remit is correct and silence inside it is a
 * disagreement. `claims` is the remit; `declared` is where a difference inside one is allowed, and
 * it must carry the reason, because a difference nobody can explain is the bug this looks for.
 */
type IdReader = {
  name: string;
  /** The ids this reader is answerable for. Outside this, finding nothing is the right answer. */
  claims: (id: string) => boolean;
  read: (text: string) => string[];
};

const anthropic = (id: string) => id.startsWith("claude-");
/** The two makers whose bundles are scanned, in the spelling their own clients write. */
const bundled = (id: string) => /^gemini-\d|^qwen\d/.test(id);

const READERS: readonly IdReader[] = [
  { name: "modelIdsInText", claims: () => true, read: (text) => [...modelIdsInText(text).keys()] },
  {
    name: "modelIdsInPatch",
    claims: () => true,
    // A patch is read for its added lines only, so the corpus line is offered as one.
    read: (text) => [...modelIdsInPatch(`+${text}`).keys()],
  },
  { name: "claudeModelIds", claims: anthropic, read: claudeModelIds },
  {
    name: "commandCodeModelIds",
    // Its other half reads `maker/slug`, which nothing else here spells; the bare names it shares.
    claims: (id) => anthropic(id) || id.startsWith("gpt-"),
    read: commandCodeModelIds,
  },
  {
    name: "bundleModelIds",
    claims: bundled,
    // One reader per maker's spelling, as the collector runs it; the union is what the client knows.
    read: (text) =>
      [
        ...new Set(CLI_BUNDLES.flatMap((bundle) => bundleModelIds(text, new RegExp(bundle.pattern.source, "g")))),
      ].sort(),
  },
];

type Entry = {
  /** What a real file holds. Quoted, because every one of these readers reads a bundle or a diff. */
  text: string;
  /** The models this names, as a reader of the file would say. */
  ids: readonly string[];
  /** Why a reader inside its own remit answers differently, keyed by reader name. */
  declared?: Record<string, { ids: readonly string[]; why: string }>;
};

const CORPUS: readonly Entry[] = [
  {
    text: '"claude-opus-4-8" x "claude-haiku-4-5" x "claude-fable-5-1"',
    ids: ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-4-8"],
  },
  {
    // The case that bought the lead time this source exists for: a stage where a version belongs.
    text: '"claude-mythos-preview"',
    ids: ["claude-mythos-preview"],
    declared: {
      commandCodeModelIds: {
        ids: [],
        why: "its bare-name shape requires a digit, and this registry has never carried a staged name. A digit is what separates a model from a word in `maker/slug` prose, so widening it here would cost more than it buys until Command Code ships one.",
      },
    },
  },
  {
    // Two models in one name: the shape an announcement's address has when it announces both.
    text: '"claude-fable-5-mythos-5"',
    ids: ["claude-fable-5", "claude-mythos-5"],
  },
  {
    // A proxy's alias for what it routes to. Two makers' words, so no maker's own model.
    text: '"claude-gpt-6-astra"',
    ids: [],
  },
  {
    text: '"gemini-3.8-live-extended-thinking" and "gemini-2.5-flash"',
    ids: ["gemini-2.5-flash", "gemini-3.8-live-extended-thinking"],
  },
  { text: '"qwen3.8-plus"', ids: ["qwen3.8-plus"] },
  {
    // A size and a quantisation: one open-weight model served another way, not another model.
    text: '"qwen3-coder-30b-a3b-instruct"',
    ids: [],
  },
  { text: '"gpt-5.6-luna"', ids: ["gpt-5.6-luna"] },
  { text: "Do not reuse GPT-6-specific defaults.", ids: [] },
  {
    // A client of the model, shaped like one. The list that knows this is shared, and this is what
    // keeps it shared.
    text: '"claude-code-2-1-286" x "claude-desktop-3p"',
    ids: [],
  },
  {
    text: '"claude-opus-4-5-20250929"',
    ids: ["claude-opus-4-5"],
    declared: {
      modelIdsInText: {
        ids: ["claude-opus-4-5-20250929"],
        why: "a mention is evidence of what somebody wrote, and a dated checkpoint written in a commit is a sighting of that checkpoint. The catalogues resolve it to the alias; this reader is not a catalogue, and rewriting the id would change the identity of every mention already stored.",
      },
      modelIdsInPatch: {
        ids: ["claude-opus-4-5-20250929"],
        why: "the same reader as `modelIdsInText`, offered the line as a diff, so it differs for the same reason and would be wrong to differ from it.",
      },
      commandCodeModelIds: {
        ids: [],
        why: "it drops a dated name rather than resolving it, because its registry lists aliases and a dated entry there has only ever been a pin of one already listed.",
      },
    },
  },
];

test("every reader of a model id out of text agrees about the same corpus, or says why not", () => {
  const unexplained: string[] = [];
  for (const entry of CORPUS)
    for (const reader of READERS) {
      const declared = entry.declared?.[reader.name];
      const expected = [...(declared ? declared.ids : entry.ids.filter(reader.claims))].sort();
      const actual = [...reader.read(entry.text)].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        unexplained.push(
          `${reader.name} on ${entry.text}\n    expected ${JSON.stringify(expected)}\n    answered ${JSON.stringify(actual)}`,
        );
      // A declaration is a live claim, not a note: when the reader stops differing it has to go, or
      // the next reader added copies a difference that no longer exists.
      if (
        declared &&
        JSON.stringify([...declared.ids].sort()) === JSON.stringify([...entry.ids.filter(reader.claims)].sort())
      )
        unexplained.push(`${reader.name} on ${entry.text} no longer differs: remove the declaration`);
    }
  expect(unexplained).toEqual([]);
});

test("every declared difference carries a reason, and every reader is in the corpus", () => {
  for (const entry of CORPUS)
    for (const [name, declared] of Object.entries(entry.declared ?? {})) {
      expect(READERS.map((reader) => reader.name)).toContain(name);
      // The reason is the whole value of a declaration: it is what a reader of this file weighs
      // against the alternative of making the two agree.
      expect(declared.why.length).toBeGreaterThan(60);
    }
  // A reader added to `src/sources` and not to this list is the bug this file exists for, and it
  // cannot be detected from here. `scripts/check-failures.ts` is the shape that would catch it; the
  // readers are five and each is imported by name, so the next one shows up in review as an import
  // this test does not have.
  expect(READERS).toHaveLength(5);
});
