import { expect, test } from "bun:test";
import { pingWorthy, signalClass } from "../src/events/signals.js";
import type { Event, RecordData } from "../src/events/types.js";

const event = (
  overrides: Partial<Event> & { stream: Event["stream"]; kind: Event["kind"] },
  record: RecordData | null = null,
): Event => ({
  id: 1,
  source: "openrouter",
  entity_id: "vendor/model",
  before_json: null,
  after_json: record ? JSON.stringify(record) : JSON.stringify({ name: "Model" }),
  detected_at: "2026-09-11T00:00:00.000Z",
  ...overrides,
});

test("a reader who came for new models gets catalogue arrivals and withdrawals", () => {
  expect(signalClass(event({ stream: "openrouter", kind: "new" }))).toBe("launch");
  expect(signalClass(event({ stream: "api-models", kind: "new", source: "openai" }))).toBe("launch");
  expect(signalClass(event({ stream: "weights", kind: "new", source: "huggingface:openai" }))).toBe("launch");
  // A withdrawal is the same question answered the other way: can a reader still use it.
  expect(signalClass(event({ stream: "openrouter", kind: "removed" }))).toBe("launch");
});

test("an entry listed but not yet usable is a codename, not a launch", () => {
  expect(
    signalClass(event({ stream: "openrouter", kind: "new" }, { id: "vendor/model", name: "Model", selectable: false })),
  ).toBe("codename");
  expect(signalClass(event({ stream: "arena", kind: "new", source: "arena" }))).toBe("codename");
  expect(signalClass(event({ stream: "arena", kind: "removed", source: "arena" }))).toBe("codename");
  expect(signalClass(event({ stream: "leaderboards", kind: "new", source: "designarena:website" }))).toBe("codename");
  expect(signalClass(event({ stream: "github", kind: "new", source: "discovery:github-agents" }))).toBe("codename");
});

test("a retirement notice speaks only when it names the successor", () => {
  const named = event(
    { stream: "deprecations", kind: "new", source: "azure-foundry-lifecycle" },
    { id: "gpt-4o-2024-05-13", name: "gpt-4o", replacement: "gpt-5.1" },
  );
  const unnamed = event(
    { stream: "deprecations", kind: "new", source: "aws-bedrock-lifecycle" },
    { id: "jamba-1-5-large", name: "Jamba 1.5 Large", replacement: null },
  );
  expect(signalClass(named)).toBe("codename");
  expect(signalClass(unnamed)).toBe("evidence");
  // A shifted date is read by whoever runs the model being retired, which is the invited room.
  expect(signalClass({ ...named, kind: "changed" })).toBe("evidence");
});

test("raw trails stay in the evidence class", () => {
  expect(signalClass(event({ stream: "web", kind: "changed", source: "claude-web" }))).toBe("evidence");
  expect(signalClass(event({ stream: "packages", kind: "changed", source: "npm:@openai/codex" }))).toBe("evidence");
  expect(signalClass(event({ stream: "github", kind: "new", source: "github:openai/codex:commits" }))).toBe("evidence");
});

test("a number that moved is a change, whatever produced it", () => {
  expect(signalClass(event({ stream: "openrouter", kind: "changed" }))).toBe("change");
  expect(signalClass(event({ stream: "api-models", kind: "changed", source: "openai" }))).toBe("change");
  expect(signalClass(event({ stream: "leaderboards", kind: "changed", source: "designarena:website" }))).toBe("change");
  expect(signalClass(event({ stream: "news", kind: "changed", source: "groq-changelog" }))).toBe("change");
});

test("software shipped around the models is a release and never interrupts", () => {
  expect(signalClass(event({ stream: "apps", kind: "new", source: "app:ios:chatgpt" }))).toBe("release");
  expect(signalClass(event({ stream: "apps", kind: "changed", source: "app:ios:claude" }))).toBe("release");
  expect(signalClass(event({ stream: "news", kind: "new", source: "claude-code-changelog" }))).toBe("release");
  expect(signalClass(event({ stream: "github", kind: "new", source: "github:openai/codex:releases" }))).toBe("release");
  expect(pingWorthy(event({ stream: "apps", kind: "new", source: "app:ios:chatgpt" }))).toBe(false);
});

test("a newsroom post is what the vendor said, not a model a reader can use", () => {
  expect(signalClass(event({ stream: "news", kind: "new", source: "openai-news" }))).toBe("article");
  expect(signalClass(event({ stream: "news", kind: "changed", source: "anthropic-news" }))).toBe("article");
  expect(pingWorthy(event({ stream: "news", kind: "new", source: "openai-news" }))).toBe(false);
  // The launch itself is observed in the catalogue, which still interrupts.
  expect(pingWorthy(event({ stream: "api-models", kind: "new", source: "openai" }))).toBe(true);
});

test("only an outage the vendor calls severe reaches a reader, and it reaches the launches", () => {
  const incident = (impact: string) =>
    event({
      stream: "incidents",
      kind: "new",
      source: "status:openai",
      after_json: JSON.stringify({ name: "OpenAI: Elevated errors", impact, stage: "investigating" }),
    });
  expect(signalClass(incident("major"))).toBe("launch");
  expect(signalClass(incident("critical"))).toBe("launch");
  expect(pingWorthy(incident("major"))).toBe(true);
  // The Platform health board already shows these, and no destination subscribes to the class.
  expect(signalClass(incident("minor"))).toBe("incident");
  expect(signalClass(incident("none"))).toBe("incident");
});

test("only the two classes a reader subscribed for carry a role mention", () => {
  expect(pingWorthy(event({ stream: "openrouter", kind: "new" }))).toBe(true);
  expect(pingWorthy(event({ stream: "arena", kind: "new", source: "arena" }))).toBe(true);
  expect(pingWorthy(event({ stream: "openrouter", kind: "changed" }))).toBe(false);
  expect(pingWorthy(event({ stream: "web", kind: "changed", source: "claude-web" }))).toBe(false);
  expect(pingWorthy(event({ stream: "news", kind: "changed", source: "openai-news" }))).toBe(false);
});
