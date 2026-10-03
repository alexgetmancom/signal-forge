import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SourceError } from "../src/failure.js";
import { collectDocsProbe, heardNames, observedFamilies, PROBE_SITES } from "../src/sources/probes.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";
import { answering } from "./fixtures/answering.js";

const anthropic = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");

/** A catalogue that has heard of the models named, and of nothing newer. */
function catalogue(ids: readonly string[]): Database {
  const db = openDatabase(":memory:");
  db.query(
    "INSERT INTO snapshots(id,source,collected_at,body,hash,bytes) VALUES(1,'models-dev','2026-09-22T00:00:00.000Z','{}','h',2)",
  ).run();
  const insert = db.query(
    "INSERT INTO model_facts(canonical_id,first_seen_at,updated_at) VALUES(?,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z')",
  );
  for (const id of ids) insert.run(id);
  return db;
}

test("a documentation page that exists for an unannounced model is a sighting", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const agents: string[] = [];
  const pages = answering({
    "https://platform.claude.com/docs/en/models/opus-5-5/overview": "the model we ship",
    "https://platform.claude.com/docs/en/models/opus-6/overview": "the model we have not announced",
  });
  const request = async (url: string, init?: RequestInit) => {
    agents.push(new Headers(init?.headers).get("user-agent") ?? "");
    return pages(url);
  };
  const collection = await collectDocsProbe(catalogue(["claude-opus-5-5", "claude-opus-5-5-fast"]), anthropic, request);
  expect(collection.records.map((record) => record.id)).toEqual(["opus-6"]);
  expect(collection.source).toBe("discovery:docs-anthropic");
  expect(new Set(agents)).toEqual(new Set(["SignalForge/0.1"]));
});

test("a probe whose control has moved is a failure, not an empty answer", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  await expect(collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, answering({}))).rejects.toThrow(
    "opus-5-5 answered HTTP 404",
  );
});

test("a name heard once and served nowhere is asked about; one that is out is not", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const db = catalogue(["gpt-6-sol"]);
  const insert = db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models',?,'new','{}',?,'codename',1)",
  );
  insert.run("gpt-6-vela", "2026-09-23T10:00:00.000Z");
  // Already in the catalogue, so the documentation has nothing to confirm.
  insert.run("openai/gpt-6-sol:served", "2026-09-23T11:00:00.000Z");
  expect(heardNames(db, openai, Date.parse("2026-09-24T00:00:00.000Z"))).toEqual(["gpt-6-vela"]);
});

test("a name heard long ago has stopped being a question", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const db = catalogue(["gpt-6-sol"]);
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models','gpt-6-vela','new','{}','2026-06-01T10:00:00.000Z','codename',1)",
  ).run();
  expect(heardNames(db, openai, Date.parse("2026-09-24T00:00:00.000Z"))).toEqual([]);
});

test("the questions follow the catalogue: what is out is never asked for again", async () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push((String(input).split("/").at(-1) ?? "").replace(/\.md$/, ""));
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol.md") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["gpt-6-sol", "gpt-6-astra", "gpt-5.6-cyber"]), openai, watching);
  // Six is out, so the probe asks past it and never for it.
  expect(asked).toContain("gpt-6.1");
  expect(asked).toContain("gpt-7");
  expect(asked.filter((slug) => slug === "gpt-6")).toEqual([]);
});

test("the highest version of each shape is the one the catalogue has, under its shortest name", () => {
  const google = PROBE_SITES.find((site) => site.id === "discovery:docs-google");
  if (!google) throw new Error("the Google probe is gone");
  const found = observedFamilies(
    catalogue(["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.8-flash-image", "gemini-3.5-pro"]),
    google,
  );
  expect(found).toEqual([
    { family: "gemini-#-pro", version: [3, 5], observed: "gemini-3.5-pro" },
    { family: "gemini-#-flash", version: [3, 8], observed: "gemini-3.8-flash" },
  ]);
});

test("a tier behind the rest is asked the questions the furthest tier earns", async () => {
  const google = PROBE_SITES.find((site) => site.id === "discovery:docs-google");
  if (!google) throw new Error("the Google probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push((String(input).split("/").at(-1) ?? "").replace(/\.md$/, ""));
    return new Response("a page", { status: String(input).endsWith("gemini-3.8-flash") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["gemini-3.8-flash", "gemini-3.1-pro"]), google, watching);
  // Pro is five minors behind flash, and the next pro is likelier to be the next whole number.
  expect(asked).toContain("gemini-4-pro");
  expect(asked).toContain("gemini-3.9-pro");
  expect(asked).toContain("gemini-3.2-pro");
});

test("a version no maker could be at is a spelling, not a version", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  // `gpt-56-sol` is `gpt-5.6-sol` with the dot normalised away, and read as 56 it poisons the probe.
  expect(observedFamilies(catalogue(["gpt-56-sol", "gpt-6-sol"]), openai)).toEqual([
    { family: "gpt", version: [6, 0], observed: "gpt-6-sol" },
  ]);
});

test("a released model written another way is still released", () => {
  const anthropicProbe = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");
  if (!anthropicProbe) throw new Error("the Anthropic probe is gone");
  const db = catalogue(["claude-opus-5-5"]);
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models',?,'new','{}','2026-09-23T10:00:00.000Z','codename',1)",
  ).run(["claude-opus", "5.5"].join("-"));
  expect(heardNames(db, anthropicProbe, Date.parse("2026-09-24T00:00:00.000Z"))).toEqual([]);
});

test("a model the catalogue files under its maker is out, and is not a question", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  // The only spelling of this model in the catalogue carries the maker in front of it, which is how
  // OpenCode writes every id. Read past the prefix it is released; read with it, the probe asks the
  // documentation about a model that shipped in December and calls the answer a new page.
  const db = catalogue(["openai/gpt-5.2-codex", "openai/gpt-6-sol"]);
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('discovery:opencode-data','api-models',?,'new','{}','2026-09-23T10:00:00.000Z','codename',1)",
  ).run("openai/gpt-5.2-codex");
  expect(heardNames(db, openai, Date.parse("2026-09-24T00:00:00.000Z"))).toEqual([]);
});

test("the frontier is read past the maker the catalogue puts in front of a model", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  // Unstripped, none of these match the shape at all: the probe sees an empty catalogue and refuses,
  // or sees only the older unprefixed name and asks questions about the past.
  expect(observedFamilies(catalogue(["gpt-5.6-cyber", "openai/gpt-6-sol"]), openai)).toEqual([
    { family: "gpt", version: [6, 0], observed: "gpt-6-sol" },
  ]);
});

test("a name below the maker's own frontier is still a question", () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const db = catalogue(["gpt-6-sol"]);
  const insert = db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models',?,'new','{}','2026-09-23T10:00:00.000Z','codename',1)",
  );
  /**
   * A maker ships below its own frontier all the time -- a K2.9 for code beside K3.1, a small model
   * after the flagship -- and that release is exactly the one version guessing cannot reach.
   */
  insert.run("gpt-5.7-mini");
  insert.run("gpt-6-vela");
  expect(heardNames(db, openai, Date.parse("2026-09-24T00:00:00.000Z")).sort()).toEqual(["gpt-5.7-mini", "gpt-6-vela"]);
});

test("a name that answered 404 is left alone for a day, and the version guesses are not", async () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const db = catalogue(["gpt-6-sol"]);
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models','gpt-6-vela','new','{}','2026-09-23T10:00:00.000Z','codename',1)",
  ).run();
  const asked: string[][] = [];
  const watching = (async (input: string | URL) => {
    asked.at(-1)?.push((String(input).split("/").at(-1) ?? "").replace(/\.md$/, ""));
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol.md") ? 200 : 404 });
  }) as unknown as typeof fetch;
  const minute = Date.parse("2026-09-24T00:00:00.000Z");
  for (const at of [minute, minute + 300_000, minute + 25 * 3_600_000]) {
    asked.push([]);
    const collection = await collectDocsProbe(db, openai, watching, at);
    storeSnapshot(db, collection.source, new Date(at).toISOString(), JSON.stringify(collection.raw));
  }
  expect(asked[0]).toContain("gpt-6-vela");
  // Five minutes later the heard name is spent, and the versions are asked again regardless.
  expect(asked[1]).not.toContain("gpt-6-vela");
  expect(asked[1]).toContain("gpt-6.1");
  // A day later it is a question again.
  expect(asked[2]).toContain("gpt-6-vela");
});

const zai = PROBE_SITES.find((site) => site.id === "discovery:blog-zai");

test("Z.ai publishes a post at the model's own address, and a tier has none", async () => {
  if (!zai) throw new Error("the Z.ai probe is gone");
  // What the catalogues hold spelled four ways, and the post for the release after the newest of
  // them. `GLM-5.3` is the same model as `glm-5.3` to a catalogue and a 404 to the blog.
  const pages = answering({
    "https://z.ai/blog/glm-5.3": "GLM-5.3 is out",
    "https://z.ai/blog/glm-5.4": "GLM-5.4 is out",
  });
  const collection = await collectDocsProbe(
    catalogue(["GLM-5.3", "glm-5.3-flashx", "zai/glm-5.2", "glm-4.7"]),
    zai,
    pages,
  );
  expect(collection.records.map((record) => record.id)).toEqual(["glm-5.4"]);
  expect(collection.records.map((record) => record.url)).toEqual(["https://z.ai/blog/glm-5.4"]);
  expect(collection.source).toBe("discovery:blog-zai");
});

test("Z.ai is asked about no name a catalogue only aliases", async () => {
  if (!zai) throw new Error("the Z.ai probe is gone");
  const asked: string[] = [];
  const pages = answering({ "https://z.ai/blog/glm-5.3": "GLM-5.3 is out" });
  const request = async (url: string, init?: RequestInit) => {
    asked.push(String(url));
    return pages(url, init);
  };
  const collection = await collectDocsProbe(catalogue(["GLM-5.3", "glm-latest", "glm-flash-latest"]), zai, request);
  expect(collection.records).toEqual([]);
  // The next versions of the one shape it follows, and the control. An alias is not a version, and
  // 5.5 is there because this maker uses half steps: GLM-4.5 shipped between GLM-4 and GLM-5.
  expect(asked.map((url) => url.replace("https://z.ai/blog/", "")).sort()).toEqual([
    "glm-5.3",
    "glm-5.4",
    "glm-5.5",
    "glm-6",
    "glm-6.5",
    // The negative control, in the shape this site spells a guess.
    "glm-99.99",
  ]);
});

test("a codename already in use is asked for at the versions the maker has not shipped", async () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push((String(input).split("/").at(-1) ?? "").replace(/\.md$/, ""));
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol.md") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["gpt-6-astra", "gpt-6-sol"]), openai, watching);
  // The release this was written for: `gpt-6-sol` is out, and the next Sol is not `gpt-6.1`.
  expect(asked).toContain("gpt-6.1-sol");
  expect(asked).toContain("gpt-7-sol");
  // A number with no word after it is not a name this maker ships, but the plain guesses stay.
  expect(asked).toContain("gpt-6.1");
  // Asked once each, and `gpt-6-sol` appears only as the control that proves the site is answering.
  expect(asked.filter((slug) => slug === "gpt-6.1-sol")).toHaveLength(1);
});

test("a maker that numbers its models without a codename gains no questions", async () => {
  const anthropicProbe = PROBE_SITES.find((site) => site.id === "discovery:docs-anthropic");
  if (!anthropicProbe) throw new Error("the Anthropic probe is gone");
  const asked: string[] = [];
  const watching = (async (input: string | URL) => {
    asked.push(String(input).split("/").at(-2) ?? "");
    return new Response("a page", { status: String(input).includes("opus-5-5") ? 200 : 404 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["claude-opus-5-5", "claude-sonnet-5"]), anthropicProbe, watching);
  // `opus-5-5` ends in a number, not a word: nothing here is a codename to carry forward.
  expect(asked.filter((slug) => /[a-z]{3,}-\d/.test(slug) && !/^(opus|sonnet|haiku)-/.test(slug))).toEqual([]);
});

const OPUS_5_5 = "https://platform.claude.com/docs/en/models/opus-5-5/overview";

test("a control that fails says which kind of failure it is, by type and not by its sentence", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const serving = (status: number) => (async () => new Response("x", { status })) as unknown as typeof fetch;
  // The addresses moved, the site is limiting, or it is failing: three different things to do about it.
  for (const [status, kind] of [
    [404, "missing-content"],
    [429, "rate-limited"],
    [503, "http"],
  ] as const) {
    const error = await collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, serving(status)).catch((e) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe(kind);
    expect((error as SourceError).message).toContain(`opus-5-5 answered HTTP ${status}`);
  }
});

test("a control that could not be reached at all says so by type, not as an unexpected error", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  // What `askStatus` throws when the request itself fails: no status, no kind, nothing to recognise.
  const unreachable = (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  const error = await collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, unreachable).catch((e) => e);
  expect(error).toBeInstanceOf(SourceError);
  expect((error as SourceError).kind).toBe("network");
});

test("a catalogue with no model of any shape the probe follows is an empty answer, by type", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const error = await collectDocsProbe(catalogue([]), anthropic, answering({})).catch((e) => e);
  expect(error).toBeInstanceOf(SourceError);
  expect((error as SourceError).kind).toBe("empty");
});

test("the control is asked first, so a site that is failing is asked nothing else", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const asked: string[] = [];
  const failing = (async (input: string | URL) => {
    asked.push(String(input));
    return new Response("x", { status: 503 });
  }) as unknown as typeof fetch;
  await collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, failing).catch(() => null);
  expect(asked).toEqual([OPUS_5_5]);
});

test("a heard name that met a server error was not answered, so it is asked again at once", async () => {
  const openai = PROBE_SITES.find((site) => site.id === "discovery:docs-openai");
  if (!openai) throw new Error("the OpenAI probe is gone");
  const db = catalogue(["gpt-6-sol"]);
  db.query(
    "INSERT INTO events(source,stream,entity_id,kind,after_json,detected_at,signal,snapshot_id) VALUES('models-dev','api-models','gpt-6-vela','new','{}','2026-09-23T10:00:00.000Z','codename',1)",
  ).run();
  const asked: string[][] = [];
  const watching = (async (input: string | URL) => {
    const slug = (String(input).split("/").at(-1) ?? "").replace(/\.md$/, "");
    asked.at(-1)?.push(slug);
    return new Response("x", { status: slug === "gpt-6-sol" ? 200 : slug === "gpt-6-vela" ? 503 : 404 });
  }) as unknown as typeof fetch;
  const minute = Date.parse("2026-09-24T00:00:00.000Z");
  for (const at of [minute, minute + 300_000]) {
    asked.push([]);
    const collection = await collectDocsProbe(db, openai, watching, at);
    storeSnapshot(db, collection.source, new Date(at).toISOString(), JSON.stringify(collection.raw));
  }
  expect(asked[0]).toContain("gpt-6-vela");
  // A 503 is not an answer, so five minutes later the name is still a question; a 404 would not be.
  expect(asked[1]).toContain("gpt-6-vela");
});

test("a site that answers 200 for an address that cannot exist publishes nothing from this poll", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const asked: string[] = [];
  // What `platform.claude.com` began doing on 2026-09-30: every path under the models directory is
  // a 200, so the positive control passes and every guess looks like a sighting.
  const catchAll = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response("the documentation shell", { status: 200 });
  }) as unknown as typeof fetch;
  const failure = await collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, catchAll).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SourceError);
  expect((failure as SourceError).kind).toBe("indiscriminate");
  // Two addresses and no more: the guesses are never asked, because nothing they could answer would
  // mean anything.
  expect(asked).toEqual([
    "https://platform.claude.com/docs/en/models/opus-5-5/overview",
    "https://platform.claude.com/docs/en/models/opus-99-99/overview",
  ]);
});

test("the negative control is asked in the shape of a guess, and a 404 from it lets the poll proceed", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  const asked: string[] = [];
  const pages = answering({
    "https://platform.claude.com/docs/en/models/opus-5-5/overview": "the model we ship",
    "https://platform.claude.com/docs/en/models/opus-6/overview": "the model we have not announced",
  });
  const request = async (url: string) => {
    asked.push(url);
    return pages(url);
  };
  const collection = await collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, request);
  expect(collection.records.map((record) => record.id)).toEqual(["opus-6"]);
  // Asked second, before any guess, through the same slug and address the guesses use.
  expect(asked[1]).toBe("https://platform.claude.com/docs/en/models/opus-99-99/overview");
  // And kept beside them, so the day a site turns indiscriminate is answerable afterwards.
  expect((collection.raw as Record<string, { status: number }>)["opus-99-99"]).toMatchObject({ status: 404 });
});
