import { expect, test } from "bun:test";
import { displayTitle, readableName, versioned } from "../src/events/naming.js";
import { fieldLabel } from "../src/events/render/common.js";
import { eventFactParts } from "../src/events/render/facts.js";
import { sourceLabel } from "../src/sources/labels.js";

test("a docs page slug reads as a version, and dates and number runs stay as they were", () => {
  expect(versioned("Grok 4 8")).toBe("Grok 4.8");
  expect(versioned("Claude 3 5 sonnet")).toBe("Claude 3.5 sonnet");
  expect(versioned("Gemini 2 0 flash")).toBe("Gemini 2.0 flash");
  expect(versioned("Release notes 2026 09 21")).toBe("Release notes 2026 09 21");
  expect(versioned("Steps 1 2 3")).toBe("Steps 1 2 3");
  expect(versioned("Models")).toBe("Models");
});

test("a source is named by what it reads, never by a default that fits one of them", () => {
  // `models` reads the code and `talk` reads issues and discussions; only `pulls` reads a pull
  // request. The card for `minimax-m3.1` said "PR" under a name a test file had carried.
  expect(sourceLabel("github:MiniMax-AI/minimax-code:models")).toBe("GitHub · MiniMax-AI/minimax-code · code");
  expect(sourceLabel("github:openai/codex:talk")).toBe("GitHub · openai/codex · discussions");
  expect(sourceLabel("github:openai/codex:pulls")).toBe("GitHub · openai/codex · PR");
  expect(sourceLabel("github:openai/codex:commits")).toBe("GitHub · openai/codex · commits");
  // An id nobody named reached the reader as itself, in a title and in a footer.
  expect(sourceLabel("discovery:opencode-data")).toBe("OpenCode · discovery");
  expect(sourceLabel("nvidia-ai-feed")).toBe("NVIDIA · AI feed");
});

test("a handle is spoken as a name where the card prints the handle underneath", () => {
  expect(displayTitle("muse-spark-1-4-contributor", "api-models", "discovery:opencode-data")).toBe(
    "Muse Spark 1.4 Contributor",
  );
  expect(readableName("minimax-m3.1")).toBe("MiniMax M3.1");
  // A slug's version keeps its dot wherever a name is written for a reader, not only on page names.
  expect(readableName("claude-opus-5-5")).toBe("Claude Opus 5.5");
  // A date is not a version, and a literal sighting is the evidence itself.
  expect(readableName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4 5 20251001");
  expect(displayTitle("openai/some-repo", "github", "discovery:github-ai")).toBe("openai/some-repo");
});

test("a field is labelled in words, and never repeats the handle above it", () => {
  expect(fieldLabel("canonical_id")).toBe("Canonical id");
  expect(fieldLabel("providers")).toBe("Providers");
  expect(fieldLabel("context")).toBe("Context");
  const facts = eventFactParts({
    id: 1,
    source: "truefoundry-azure",
    stream: "api-models",
    entity_id: "microsoft-foundry/provider-config",
    kind: "new",
    detected_at: "2026-09-24T00:00:00.000Z",
    before_json: null,
    after_json: JSON.stringify({
      id: "microsoft-foundry/provider-config",
      name: "provider-config",
      canonical_id: "provider-config",
      model: "provider-config",
      providers: ["azure-ai-foundry"],
    }),
  } as never);
  expect(facts.map((fact) => (typeof fact === "string" ? fact : fact.label))).toEqual(["Providers"]);
});

test("a release titled with its version says what released", () => {
  // `0.156.0` reached the public channel three times as a bare number.
  expect(displayTitle("0.156.0", "packages", "openai-codex-changelog")).toBe("OpenAI Codex 0.156.0");
  expect(displayTitle("v2.0.0", "packages", "kimi-code-changelog")).toBe("Kimi Code 2.0.0");
  // The publisher alone, where the feed's name adds nothing.
  expect(displayTitle("3.4", "packages", "gemini-api-changelog")).toBe("Gemini 3.4");
  // A title that is already words is left alone.
  expect(displayTitle("A simpler Vibe experience", "packages", "mistral-release-notes")).toBe(
    "A simpler Vibe experience",
  );
});
