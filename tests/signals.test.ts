import { expect, test } from "bun:test";
import { pingWorthy, signalClass } from "../src/events/signals.js";
import type { Event, RecordData } from "../src/events/types.js";

const event = (
  overrides: Partial<Event> & { stream: Event["stream"]; kind: Event["kind"] },
  record: RecordData | null = null,
): Event => ({
  signal: null,
  id: 1,
  source: "openrouter",
  entity_id: "model",
  before_json: null,
  after_json: record ? JSON.stringify(record) : JSON.stringify({ name: "Model" }),
  detected_at: "2026-09-11T00:00:00.000Z",
  ...overrides,
});

test("a reader who came for new models gets the arrivals, and withdrawals keep their own class", () => {
  expect(signalClass(event({ stream: "openrouter", kind: "new" }))).toBe("codename");
  expect(signalClass(event({ stream: "api-models", kind: "new", source: "openai" }))).toBe("launch");
  // Weights in a registry are the earliest word on a model and the furthest from calling one.
  expect(signalClass(event({ stream: "weights", kind: "new", source: "huggingface:openai" }))).toBe("codename");
  // A withdrawal was once read as the same question answered the other way. Measured over the week
  // to 2026-09-15 it was bookkeeping instead: four of the eight cards the launch channel carried
  // were departures, and each ended something that channel had never been told arrived.
  expect(signalClass(event({ stream: "openrouter", kind: "removed" }))).toBe("evidence");
});

test("an entry listed but not yet usable is a codename, not a launch", () => {
  expect(
    signalClass(event({ stream: "openrouter", kind: "new" }, { id: "vendor/model", name: "Model", selectable: false })),
  ).toBe("codename");
  expect(signalClass(event({ stream: "arena", kind: "new", source: "arena" }))).toBe("codename");
  // A niche board is a sighting for the scouts, but only near the top.
  expect(
    signalClass(
      event(
        { stream: "leaderboards", kind: "new", source: "designarena:website" },
        { id: "m", name: "M", category: "designarena/website", rank: 3 },
      ),
    ),
  ).toBe("codename");
  expect(signalClass(event({ stream: "github", kind: "new", source: "discovery:github-agents" }))).toBe("codename");
});

test("a name leaving an arena is a trail, not a sighting", () => {
  // One collection on 2026-09-15 withdrew 193 arena entries at once and every one of them was
  // classed as a sighting: sixteen messages carrying 10 to 21 cards each, inside eleven seconds.
  expect(signalClass(event({ stream: "arena", kind: "removed", source: "arena" }))).toBe("evidence");
  expect(signalClass(event({ stream: "arena", kind: "new", source: "arena" }))).toBe("codename");
});

test("a reseller listing a model is a sighting, and the vendor's own catalogue is a launch", () => {
  const listed = { stream: "openrouter", kind: "new", authority: "third_party" } as const;
  expect(signalClass(event(listed))).toBe("codename");
  expect(
    signalClass(event({ stream: "api-models", kind: "new", source: "models-dev", authority: "third_party" })),
  ).toBe("codename");
  expect(signalClass(event({ stream: "api-models", kind: "new", source: "openai", authority: "first_party" }))).toBe(
    "launch",
  );
  expect(
    signalClass(event({ stream: "weights", kind: "new", source: "huggingface:openai", authority: "vendor_owned" })),
  ).toBe("codename");
});

test("a platform listing another maker's model is a sighting, whoever owns the platform", () => {
  // `glm-5.3` on Alibaba's DashScope reached the public channel on 2026-09-15; Z.ai shipped nothing.
  // The collector stamps the platform as the maker of every row, so the name has to answer.
  const onDashScope = (id: string) =>
    event(
      { signal: null, stream: "api-models", kind: "new", source: "dashscope", authority: "first_party", entity_id: id },
      { id, name: id, maker: "Alibaba Model Studio", owner: "system" },
    );
  expect(signalClass(onDashScope("glm-5.3"))).toBe("codename");
  expect(signalClass(onDashScope("deepseek-v4-pro"))).toBe("codename");
  expect(signalClass(onDashScope("qwen3.7-max"))).toBe("launch");
  // A name that names no maker is the catalogue's own model.
  expect(signalClass(onDashScope("wan2.5-t2v-preview"))).toBe("launch");
  expect(
    signalClass(
      event(
        { signal: null, stream: "api-models", kind: "new", source: "openai", entity_id: "whisper-2" },
        { id: "whisper-2", name: "whisper-2" },
      ),
    ),
  ).toBe("launch");
  // The gateway is recorded as vendor-owned and sells twenty-six makers' models.
  const gateway = event(
    {
      signal: null,
      stream: "api-models",
      kind: "new",
      source: "vercel-gateway",
      authority: "vendor_owned",
      entity_id: "openai/gpt-6",
    },
    { id: "openai/gpt-6", name: "GPT-6", owned_by: "openai" },
  );
  expect(signalClass(gateway)).toBe("codename");
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
  // A scoreboard moving is its own class: the model it ranks did not change.
  expect(signalClass(event({ stream: "leaderboards", kind: "changed", source: "designarena:website" }))).toBe("rank");
  expect(signalClass(event({ stream: "news", kind: "changed", source: "groq-changelog" }))).toBe("change");
});

test("an edit to an old changelog entry is a trail, and a preview replacing a preview retires nothing", () => {
  // OpenAI reworded its entry of 2026-02-24 on 2026-09-17 and it reached the public channel.
  const edited = event(
    { stream: "news", kind: "changed", source: "openai-api-changelog", detected_at: "2026-09-17T16:10:41.392Z" },
    { id: "entry", name: "Expanded input file support", published: "2026-02-24T00:00:00.000Z" },
  );
  expect(signalClass(edited)).toBe("evidence");
  expect(
    signalClass({ ...edited, after_json: JSON.stringify({ id: "entry", published: "2026-09-15T00:00:00.000Z" }) }),
  ).toBe("change");
  const gemini = (summary: string) =>
    event(
      { stream: "news", kind: "new", source: "gemini-api-changelog" },
      { id: "2026-09-17", name: "Gemini API changelog · 2026-09-17", summary },
    );
  expect(
    signalClass(
      gemini(
        "Antigravity Agent 09-2026 : Released antigravity-preview-09-2026 , which replaces and deprecates antigravity-preview-05-2026 .",
      ),
    ),
  ).toBe("evidence");
  expect(signalClass(gemini("gemini-2.5-flash will be retired on 2026-10-30."))).toBe("retirement");
  expect(signalClass(event({ stream: "news", kind: "new", source: "openai-api-changelog" }))).toBe("evidence");
});

test("a post first seen long after it was published is a trail, and Claude's blog speaks only for what shipped", () => {
  const post = (source: string, name: string, published: string) =>
    event(
      { stream: "news", kind: "new", source, detected_at: "2026-09-17T18:00:00.000Z" },
      { id: name, name, published },
    );
  // The newsroom fix surfaced the Fable 5.1 launch sixteen days late.
  expect(
    signalClass(
      post("anthropic-news", "Introducing Claude Fable 5.1 and Claude Mythos 5.1", "2026-09-01T00:00:00.000Z"),
    ),
  ).toBe("evidence");
  expect(signalClass(post("anthropic-news", "Introducing Claude Fable 5.2", "2026-09-17T00:00:00.000Z"))).toBe(
    "launch",
  );
  expect(
    signalClass(post("claude-blog", "Claude Cowork and chat are now one Claude", "2026-09-16T00:00:00.000Z")),
  ).toBe("release");
  expect(
    signalClass(post("claude-blog", "What 1,000 small business owners taught us about AI", "2026-09-16T00:00:00.000Z")),
  ).toBe("article");
  expect(signalClass(event({ stream: "training", kind: "new", source: "mimo-training" }))).toBe("codename");
  expect(signalClass(event({ stream: "training", kind: "changed", source: "mimo-training" }))).toBe("codename");
});

test("a tool readers work in shipping a build is a release; an app, an SDK or a hardware feed is not", () => {
  expect(signalClass(event({ stream: "apps", kind: "new", source: "app:ios:chatgpt" }))).toBe("evidence");
  expect(signalClass(event({ stream: "apps", kind: "changed", source: "app:ios:claude" }))).toBe("evidence");
  expect(signalClass(event({ stream: "news", kind: "new", source: "claude-code-changelog" }))).toBe("release");
  expect(signalClass(event({ stream: "news", kind: "new", source: "anthropic-sdk-releases" }))).toBe("evidence");
  expect(signalClass(event({ stream: "news", kind: "new", source: "nvidia-ai-feed" }))).toBe("evidence");
  expect(signalClass(event({ stream: "github", kind: "new", source: "github:openai/codex:releases" }))).toBe("release");
  expect(pingWorthy(event({ stream: "apps", kind: "new", source: "app:ios:chatgpt" }))).toBe(false);
});

test("a newsroom post announcing a maker's model is the launch as its maker tells it", () => {
  const post = (name: string) =>
    event({ stream: "news", kind: "new", source: "google-ai-blog", after_json: JSON.stringify({ name }) });
  expect(signalClass(post("Introducing Gemini 3.8 Live and 3.8 Live Extended Thinking"))).toBe("launch");
  expect(signalClass(post("How Fyxer built an AI executive assistant on GPT-5"))).toBe("article");
  expect(signalClass(post("Introducing our new office in Zurich"))).toBe("article");
});

test("an interface that starts naming a versioned model or a preview is a sighting", () => {
  const diff = (added: string) =>
    event({
      stream: "web",
      kind: "changed",
      source: "claude-web",
      before_json: JSON.stringify({ strings: ["Start a new chat with Claude"] }),
      after_json: JSON.stringify({ strings: ["Start a new chat with Claude", added] }),
    });
  expect(signalClass(diff("Try Claude Opus 5 in research preview for your project"))).toBe("codename");
  expect(signalClass(diff("A connector named ‘{name}’ already exists in this project"))).toBe("evidence");
});

test("a newsroom post is what the vendor said, not a model a reader can use", () => {
  expect(signalClass(event({ stream: "news", kind: "new", source: "openai-news" }))).toBe("article");
  expect(signalClass(event({ stream: "news", kind: "changed", source: "anthropic-news" }))).toBe("article");
  expect(pingWorthy(event({ stream: "news", kind: "new", source: "openai-news" }))).toBe(false);
  // The launch itself is observed in the catalogue, which still interrupts.
  expect(pingWorthy(event({ stream: "api-models", kind: "new", source: "openai" }))).toBe(true);
});

test("only an outage the vendor calls severe reaches a reader, and it reaches the launches", () => {
  const incident = (impact: string, components = ["ChatGPT", "Codex"]) =>
    event({
      stream: "incidents",
      kind: "new",
      source: "status:openai",
      after_json: JSON.stringify({ name: "OpenAI: Elevated errors", impact, stage: "investigating", components }),
    });
  expect(signalClass(incident("major"))).toBe("launch");
  expect(signalClass(incident("critical"))).toBe("launch");
  expect(pingWorthy(incident("major"))).toBe(true);
  // The Platform health board already shows these, and no destination subscribes to the class.
  expect(signalClass(incident("minor"))).toBe("incident");
  expect(signalClass(incident("none"))).toBe("incident");
  // A subscriber on a $20 plan feels ChatGPT, Codex, claude.ai or Claude Code going down, not the API.
  expect(signalClass(incident("major", ["Claude API (api.anthropic.com)"]))).toBe("incident");
  expect(signalClass(incident("major", ["claude.ai", "Claude API (api.anthropic.com)"]))).toBe("launch");
  expect(signalClass(incident("major", []))).toBe("incident");
});

test("only the two classes a reader subscribed for carry a role mention", () => {
  expect(pingWorthy(event({ stream: "openrouter", kind: "new" }))).toBe(true);
  expect(pingWorthy(event({ stream: "arena", kind: "new", source: "arena" }))).toBe(true);
  expect(pingWorthy(event({ stream: "openrouter", kind: "changed" }))).toBe(false);
  expect(pingWorthy(event({ stream: "web", kind: "changed", source: "claude-web" }))).toBe(false);
  expect(pingWorthy(event({ stream: "news", kind: "changed", source: "openai-news" }))).toBe(false);
});

test("a listed entry becoming selectable is a sighting on an arena and a launch in its maker's catalogue", () => {
  const flip = (source: string, stream: string, name: string): Event => ({
    signal: null,
    id: 1,
    source,
    stream,
    entity_id: name,
    kind: "changed",
    before_json: JSON.stringify({ id: name, name, selectable: false }),
    after_json: JSON.stringify({ id: name, name, selectable: true }),
    detected_at: "2026-09-09T14:53:45.684Z",
  });
  expect(signalClass(flip("arena", "arena", "spicy-mayo"))).toBe("codename");
  expect(signalClass(flip("openai", "api-models", "gpt-live-1"))).toBe("launch");
  expect(signalClass(flip("groq", "api-models", "openai/gpt-oss-240b"))).toBe("codename");
  expect(
    signalClass({
      ...flip("arena", "arena", "spicy-mayo"),
      after_json: JSON.stringify({ selectable: false, name: "x" }),
    }),
  ).toBe("evidence");
});

test("a patch build stays out of the release class; a minor, major or named release does not", () => {
  const changelog = (source: string, record: { name: string; version?: string }) =>
    event({ stream: "news", kind: "new", source }, { id: "entry", ...record });
  const release = (name: string) =>
    event({ stream: "github", kind: "new", source: "github:openai/codex:releases" }, { id: name, name });
  expect(signalClass(changelog("claude-code-changelog", { name: "Claude Code 2.1.278", version: "2.1.278" }))).toBe(
    "evidence",
  );
  expect(signalClass(changelog("openai-codex-changelog", { name: "Codex CLI Release: 0.155.1" }))).toBe("evidence");
  expect(signalClass(release("0.155.1"))).toBe("evidence");
  expect(signalClass(changelog("claude-code-changelog", { name: "Claude Code 2.2.0", version: "2.2.0" }))).toBe(
    "release",
  );
  // The readers of this feed run the desktop clients. A build named for the command line is about
  // a program they never open, unless it ships something -- a model, a price, a limit -- and then
  // it is about that.
  expect(signalClass(changelog("openai-codex-changelog", { name: "Codex CLI Release: 0.155.0" }))).toBe("evidence");
  expect(signalClass(release("0.155.0"))).toBe("release");
  expect(signalClass(changelog("kimi-code-changelog", { name: "Kimi Code CLI v2.0.0", version: "v2.0.0" }))).toBe(
    "evidence",
  );
  expect(
    signalClass(
      changelog("openai-codex-changelog", {
        name: "Codex CLI Release: 0.156.0",
        summary: "GPT-6 Sol is now the default model.",
      } as { name: string; version?: string }),
    ),
  ).toBe("release");
  expect(signalClass(changelog("kimi-code-changelog", { name: "Kimi K2.7 Code", version: "Kimi K2.7 Code" }))).toBe(
    "release",
  );
  expect(signalClass(changelog("cursor-changelog", { name: "Cursor Projects" }))).toBe("release");
});

test("a model new to a board is news only in the top ten, and a debut only on a board people quote", () => {
  const entry = (category: string, rank: unknown) =>
    signalClass(
      event({ stream: "leaderboards", kind: "new", source: "arena-leaderboards" }, {
        id: "m",
        name: "M",
        category,
        rank,
      } as never),
    );
  expect(entry("text/overall", 7)).toBe("debut");
  expect(entry("artificial-analysis/text-to-image", 1)).toBe("debut");
  expect(entry("designarena/website", 4)).toBe("codename");
  expect(entry("text/overall", 11)).toBe("rank");
  // DeepSeek v4.1 Flash arrived at #0 on 2026-09-10: a board's blank, not first place.
  expect(entry("code/overall", 0)).toBe("rank");
  expect(entry("text/overall", undefined)).toBe("rank");
});

test("a model Artificial Analysis measured is a sighting, however far down the board it lands", () => {
  // Step 5 Preview as the site reported it on 2026-09-19: an index, and no place, because only the
  // leading twenty are ranked. Before this it was a `rank` -- a class with nothing ever delivered.
  const measured = (score: object, overrides: object = {}) =>
    signalClass(
      event({ stream: "leaderboards", kind: "new", source: "artificial-analysis" }, {
        id: "step-5-preview",
        name: "Step 5 Preview",
        category: "artificial-analysis/quality",
        score,
        ...overrides,
      } as never),
    );
  expect(measured({ artificial_analysis_intelligence_index: 43.6 })).toBe("codename");
  // The top ten is still the public wire, and the number does not promote it there.
  expect(measured({ artificial_analysis_intelligence_index: 70 }, { rank: 3 })).toBe("debut");
  // A row with no measurement behind it is still a row, and so is one on somebody else's board.
  expect(measured({ hle: 0.465 })).toBe("rank");
  expect(measured({}, { category: "designarena/website" })).toBe("rank");
  expect(
    signalClass(
      event({ stream: "leaderboards", kind: "new", source: "arena-leaderboards" }, {
        id: "m",
        name: "M",
        category: "text/overall",
        score: { artificial_analysis_intelligence_index: 43.6 },
      } as never),
    ),
  ).toBe("rank");
});

test("a lab's post is sorted into what it is about", () => {
  const post = (name: string, source = "openai-news") =>
    signalClass(event({ stream: "news", kind: "new", source }, { id: name, name }));
  expect(post("Operation “Trolling Stone”: Russia-linked influence activity")).toBe("safety");
  expect(post("Our framework for reporting model misalignment")).toBe("safety");
  expect(post("Measurements for understanding the pace of AI development inside frontier labs", "anthropic-news")).toBe(
    "research",
  );
  expect(post("Introducing the Agents API")).toBe("feature");
  expect(post("Build more natural voice experiences with GPT‑Live‑1 in the API")).toBe("feature");
  expect(post("Introducing ChatGPT for Financial Services")).toBe("business");
  expect(post("1Password increases engineering productivity 21% with Codex")).toBe("business");
  expect(post("DevFest is back", "google-ai-blog")).toBe("business");
  expect(post("How Cooley is accelerating IPO work with ChatGPT")).toBe("business");
  expect(post("Hex turns complex analysis into visual reports with GPT‑6 Astra")).toBe("business");
  expect(post("Prompting fundamentals")).toBe("article");
  // Somebody else saying a product changed is not the vendor shipping it.
  expect(post("Claude Code now reads AGENTS.md if there is no Claude.md", "hackernews")).toBe("article");
  expect(post("ZCode, the GLM coding agent, silently uploads your Git history", "hackernews")).toBe("safety");
});

test("a reseller listing a small company's model is a trail, a followed lab's or a stealth model's a sighting", () => {
  const listed = (id: string, name: string, maker?: string) =>
    signalClass(
      event({ stream: "api-models", kind: "new", source: "vercel-gateway" }, { id, name, ...(maker ? { maker } : {}) }),
    );
  // What reached the scouts on 2026-09-19.
  expect(listed("mixedbread/toast-1", "Toast 1", "mixedbread")).toBe("evidence");
  expect(listed("quiverai/arrow-2", "Arrow 2", "quiverai")).toBe("evidence");
  // Followed since Jev: the gateway was where it was seen first.
  expect(listed("typesafe-ai/jev", "Jev", "typesafe-ai")).toBe("codename");
  // First seen on the gateway before their makers listed them.
  expect(listed("alibaba/qwen3.8-omni-flash", "Qwen 3.8 Omni Flash", "alibaba")).toBe("codename");
  expect(listed("zai/glm-5.3-flashx", "GLM 5.3 FlashX", "zai")).toBe("codename");
  // Hiding the maker is the point of a stealth model, and it is what the scouts are for.
  expect(listed("stealth/union-alpha", "Union Alpha")).toBe("codename");
  // A row that names nobody cannot be judged small.
  expect(listed("union", "Union")).toBe("codename");
});

test("a voice or an embedding in a maker's own catalogue is a sighting, not a launch", () => {
  const google = { stream: "api-models" as const, kind: "new" as const, source: "gemini" };
  expect(
    signalClass(
      event(
        { signal: null, ...google, entity_id: "gemini-3.8-flash-tts" },
        { id: "gemini-3.8-flash-tts", name: "gemini-3.8-flash-tts" },
      ),
    ),
  ).toBe("codename");
  expect(
    signalClass(
      event(
        { signal: null, ...google, entity_id: "gemini-embedding-002" },
        { id: "gemini-embedding-002", name: "gemini-embedding-002" },
      ),
    ),
  ).toBe("codename");
  expect(
    signalClass(
      event(
        { signal: null, ...google, entity_id: "gemini-3.8-flash" },
        { id: "gemini-3.8-flash", name: "gemini-3.8-flash" },
      ),
    ),
  ).toBe("launch");
});

test("a consumer app's release notes are evidence at Mistral as they are at ChatGPT", () => {
  const entry = (source: string, name: string, audience?: string) =>
    signalClass(
      event(
        { signal: null, stream: "news", kind: "new", source, entity_id: name },
        { id: name, name, ...(audience ? { audience } : {}) },
      ),
    );
  expect(entry("mistral-release-notes", "Le Chat: memories you can edit", "consumers")).toBe("evidence");
  expect(entry("mistral-release-notes", "New voices in Le Chat")).toBe("evidence");
  expect(entry("mistral-release-notes", "Mistral Large 3 is available in the API", "developers")).not.toBe("evidence");
});

test("a page about making pictures or speech is a trail, not news", () => {
  const page = (path: string) =>
    ({
      signal: null,
      id: 1,
      source: "pages:google",
      stream: "pages",
      entity_id: path,
      kind: "new",
      after_json: JSON.stringify({ id: path, name: `Google AI for Developers: ${path.split("/").at(-1)}`, path }),
      detected_at: "2026-09-23T15:48:00.000Z",
    }) as unknown as Event;
  // Google published its TTS models as eight pages on 2026-09-23 and the survivor reached the news
  // channel: a reader who came for coding models was told about a voice.
  // A page naming a versioned model is a sighting whatever the model does, and the radar is where
  // a sighting belongs; the manual beside it is not even that.
  expect(signalClass(page("/gemini-api/docs/models/gemini-3.8-flash-tts"))).toBe("codename");
  expect(signalClass(page("/gemini-api/docs/generate-content/voice-design"))).toBe("evidence");
  expect(signalClass(page("/gemini-api/docs/voices"))).toBe("evidence");
  expect(signalClass(page("/gemini-api/docs/quickstart"))).not.toBe("codename");
});
