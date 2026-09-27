import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bundleModelIds, CLI_BUNDLES } from "../src/sources/cliBundles.js";
import { APT_REPOSITORIES, collectAptRepository, collectClaudeDownloads } from "../src/sources/desktop.js";
import {
  collectDocsProbe,
  collectOpenCodeData,
  heardNames,
  observedFamilies,
  PROBE_SITES,
} from "../src/sources/probes.js";
import { openDatabase } from "../src/storage/database.js";
import { storeSnapshot } from "../src/storage/snapshots.js";

function answering(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages[url];
    return new Response(body ?? "Page not found", { status: body === undefined ? 404 : 200 });
  }) as unknown as typeof fetch;
}

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
  expect(collection.appendOnly).toBe(true);
  expect(new Set(agents)).toEqual(new Set(["SignalForge/0.1"]));
});

test("a probe whose control has moved is a failure, not an empty answer", async () => {
  if (!anthropic) throw new Error("the Anthropic probe is gone");
  await expect(collectDocsProbe(catalogue(["claude-opus-5-5"]), anthropic, answering({}))).rejects.toThrow(
    "opus-5-5 answered HTTP 404",
  );
});

/** A lab page as OpenCode serves one: its own models in full, and every lab it knows by name. */
function labPage(
  lab: string,
  models: readonly { id: string; slug: string; name: string; released?: string }[],
): string {
  const entries = models
    .map(
      (model) =>
        `$R[1]={id:"${model.id}",lab:"${lab}",slug:"${model.slug}",name:"${model.name}",description:"a model",family:"f",knowledge:void 0${model.released ? `,releaseDate:"${model.released}",lastUpdated:"${model.released}"` : ""},limit:$R[2]={context:1,output:2}}`,
    )
    .join(",");
  const labs = ['{id:"alibaba",name:"Alibaba",description:"Qwen"}', '{id:"writer",name:"Writer",description:"Writer"}']
    .concat(lab === "alibaba" ? [] : [`{id:"${lab}",name:"Moonshot",description:"Kimi"}`])
    .join(",");
  return `<script>models:$R[0]=[${entries}],labs:$R[9]=[${labs}]</script>`;
}

test("OpenCode is read as the catalogue it publishes, and a lab nobody follows is not read at all", async () => {
  const db = openDatabase(":memory:");
  const pages = answering({
    "https://opencode.ai/data/moonshotai": labPage("moonshotai", [
      { id: "moonshotai/kimi-k3", slug: "kimi-k3", name: "Kimi K3", released: "2026-07-16" },
    ]),
    // The model this catalogue lists that nothing else of ours has heard of, and the date it gives
    // it -- which is the whole find the version guessing could not reach.
    "https://opencode.ai/data/alibaba": labPage("alibaba", [
      {
        id: "alibaba/qwen3.8-max-prime",
        slug: "qwen3-8-max-prime",
        name: "Qwen 3.8 Max Prime",
        released: "2026-09-23",
      },
      { id: "alibaba/qwen3-max", slug: "qwen3-max", name: "Qwen3 Max" },
    ]),
    // A lab page that would answer, for a maker this tracker does not follow. Asking for it at all
    // is what filled a recap with single-model labs.
    "https://opencode.ai/data/writer": labPage("writer", [
      { id: "writer/palmyra-x5", slug: "palmyra-x5", name: "Palmyra X5" },
    ]),
  });
  const asked: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    asked.push(String(url).replace("https://opencode.ai/data/", ""));
    return pages(url, init);
  };
  const collection = await collectOpenCodeData(db, request);
  expect(collection.records.map((record) => record.id)).toEqual([
    "moonshotai/kimi-k3",
    "alibaba/qwen3.8-max-prime",
    "alibaba/qwen3-max",
  ]);
  // The address is read, never spelled: the slug has the version in hyphens where the id has a dot.
  expect(collection.records.map((record) => record.url)).toContain(
    "https://opencode.ai/data/alibaba/qwen3-8-max-prime",
  );
  expect(collection.records.find((record) => record.id === "alibaba/qwen3.8-max-prime")?.created).toBe("2026-09-23");
  expect(asked).not.toContain("writer");
  db.close();
});

test("a page shape that names no lab is a failure, not an empty catalogue", async () => {
  // Every model OpenCode ever listed would retire at once, which is the one mistake a catalogue
  // source must not make quietly.
  await expect(collectOpenCodeData(openDatabase(":memory:"), answering({}))).rejects.toThrow("answered HTTP 404");
  await expect(
    collectOpenCodeData(openDatabase(":memory:"), answering({ "https://opencode.ai/data/moonshotai": "<html/>" })),
  ).rejects.toThrow("named no lab");
});

test("a stealth page counts because the catalogue has an entry for it, not because it counts sessions", async () => {
  const db = openDatabase(":memory:");
  const collection = await collectOpenCodeData(
    db,
    answering({
      "https://opencode.ai/data/moonshotai": labPage("moonshotai", [
        { id: "moonshotai/kimi-k3", slug: "kimi-k3", name: "Kimi K3" },
      ]),
      // An entry the catalogue has, under the lab where a model whose maker is unknown lands.
      "https://opencode.ai/data/unknown/space-bunny": '<script>entry:$R[3]={id:"unknown/space-bunny"}</script>',
      // The usage section for a name the catalogue does not have. `kimi-k4`, `glm-5.5-flash` and
      // `deepseek-v4.1-pro` all looked like this on 2026-09-27 and none of them is in any catalogue.
      "https://opencode.ai/data/unknown/sonoma-sky": "<script>entry:null</script>Completed sessions ... Token Share",
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["moonshotai/kimi-k3", "unknown/space-bunny"]);
  db.close();
});

test("a client's bundle names its models and not its fixtures", () => {
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");
  const text = '"gemini-3.8-flash" "gemini-9001-super-duper" "gemini-3-flash-base" "gemini-3.1-pro-preview"';
  expect(bundleModelIds(text, gemini.pattern)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash"]);
});

test("a bundle is read in pieces, and an id written across the join between two is still found", async () => {
  const { collectCliBundle } = await import("../src/sources/cliBundles.js");
  const gemini = CLI_BUNDLES.find((bundle) => bundle.source === "gemini-cli-models");
  if (!gemini) throw new Error("the Gemini CLI bundle is gone");

  // The decompressor hands its output back in 16 KB pieces, so two of these names are written across
  // a join on purpose: one straddling the first, one straddling the second. Before the tail of each
  // piece was carried into the next, both were missed -- and a bundle naming four models instead of
  // six passes its floor and says nothing about what it lost.
  const names = [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-pro",
    "gemini-2.5-flash",
    "gemini-3.1-flash-live-preview",
  ];
  const bytes = Buffer.alloc(49_152, "x");
  const write = (name: string, at: number) => bytes.write(`"${name}"`, at, "latin1");
  write(names[0] as string, 16_384 - 9);
  write(names[1] as string, 32_768 - 4);
  for (const [index, name] of names.slice(2).entries()) write(name, 2_048 + index * 4_096);
  const gzipped = Bun.gzipSync(bytes);

  const request = async (url: string | URL | Request) =>
    String(url).endsWith("/dist-tags") ? Response.json({ latest: "1.2.3" }) : new Response(gzipped);
  const collection = await collectCliBundle(gemini, request);
  expect(collection.records.map((record) => record.id)).toEqual([...names].sort());
  expect(collection.url).toBe("https://www.npmjs.com/package/@google/gemini-cli/v/1.2.3");
});

test("a dated alias is the model it dates, not a second one", () => {
  const qwen = CLI_BUNDLES.find((bundle) => bundle.source === "qwen-code-models");
  if (!qwen) throw new Error("the Qwen Code bundle is gone");
  expect(bundleModelIds('"qwen3.8-max" "qwen3.8-max-0902" "qwen3-max-2026-01-23"', qwen.pattern)).toEqual([
    "qwen3.8-max",
  ]);
});

test("an Anthropic download manifest that answers is a product, and the rest are 404s", async () => {
  const collection = await collectClaudeDownloads(
    answering({
      "https://downloads.claude.ai/claude-science/latest/manifest.json": JSON.stringify({
        version: "0.1.52",
        buildDate: "2026-09-22T23:17:30Z",
      }),
      "https://downloads.claude.ai/claude-cowork/latest/manifest.json": JSON.stringify({ version: "0.0.1" }),
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["claude-science", "claude-cowork"]);
  expect(collection.records[0]).toMatchObject({ version: "0.1.52", maker: "Anthropic" });
});

test("a download page that answers nothing at all is a failure, not an empty catalogue", async () => {
  await expect(collectClaudeDownloads(answering({}))).rejects.toThrow("not even Claude Science");
});

test("a Debian index is read for the newest build of the client", async () => {
  const claude = APT_REPOSITORIES.find((repository) => repository.source === "claude-desktop-apt");
  if (!claude) throw new Error("the Claude Desktop repository is gone");
  const index = [
    "Package: claude-desktop\nVersion: 2.2553.13\nSize: 173779072",
    "Package: claude-desktop\nVersion: 2.7032.0\nSize: 174864804",
    "Package: something-else\nVersion: 9.9.9\nSize: 1",
  ].join("\n\n");
  const collection = await collectAptRepository(
    claude,
    answering({
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages": index,
    }),
  );
  expect(collection.records[0]).toMatchObject({ version: "2.7032.0", versions: 2, bytes: 174864804 });
});

test("an index that stops naming the package is a failure, not a release", async () => {
  const chatgpt = APT_REPOSITORIES.find((repository) => repository.source === "chatgpt-desktop-apt");
  if (!chatgpt) throw new Error("the ChatGPT repository is gone");
  await expect(
    collectAptRepository(
      chatgpt,
      answering({
        "https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-amd64/Packages":
          "Package: gnome-calculator\nVersion: 1.0\n",
      }),
    ),
  ).rejects.toThrow("names no chatgpt");
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
    asked.push(String(input).split("/").at(-1) ?? "");
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol") ? 200 : 404 });
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
    asked.push(String(input).split("/").at(-1) ?? "");
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
    asked.at(-1)?.push(String(input).split("/").at(-1) ?? "");
    return new Response("a page", { status: String(input).endsWith("gpt-6-sol") ? 200 : 404 });
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
  // The next three versions of the one shape it follows, and the control. An alias is not a version.
  expect(asked.map((url) => url.replace("https://z.ai/blog/", "")).sort()).toEqual([
    "glm-5.3",
    "glm-5.4",
    "glm-6",
    "glm-6.5",
  ]);
});
