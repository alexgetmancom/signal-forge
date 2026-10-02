import { expect, test } from "bun:test";
import { collectOpenCodeData } from "../src/sources/opencodeData.js";
import { openDatabase } from "../src/storage/database.js";
import { answering } from "./fixtures/answering.js";

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
      // The followed lab the seed page names, which has to answer: a page that does not is a lab gone
      // quiet, not a lab with nothing in it.
      "https://opencode.ai/data/alibaba": labPage("alibaba", []),
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

/** The seed page and a followed lab, with whatever the lab's own page does. */
function withLab(lab: string | (() => Promise<Response>), stealth: Record<string, string> = {}): typeof fetch {
  const pages = answering({
    "https://opencode.ai/data/moonshotai": labPage("moonshotai", [
      { id: "moonshotai/kimi-k3", slug: "kimi-k3", name: "Kimi K3" },
    ]),
    ...(typeof lab === "string" ? { "https://opencode.ai/data/alibaba": lab } : {}),
    ...stealth,
  });
  return (async (url: string | URL | Request, init?: RequestInit) =>
    typeof lab !== "string" && String(url) === "https://opencode.ai/data/alibaba"
      ? lab()
      : pages(url, init)) as typeof fetch;
}

test("a followed lab whose page does not answer fails the read, because its models would retire as removed", async () => {
  // Skipping it silently left that lab's records out of the collection, and a record missing from
  // enough consecutive collections is retired: one bad minute at OpenCode announced a lab's whole
  // catalogue as gone. The sentence names the maker from our own table (Qwen, for what OpenCode calls Alibaba), not the id the page chose.
  const db = openDatabase(":memory:");
  await expect(
    collectOpenCodeData(
      db,
      withLab(async () => new Response("Bad gateway", { status: 502 })),
    ),
  ).rejects.toMatchObject({ kind: "http", message: expect.stringContaining("the Qwen page answered HTTP 502") });
  await expect(
    collectOpenCodeData(
      db,
      withLab(async () => {
        throw new TypeError("fetch failed");
      }),
    ),
  ).rejects.toThrow("fetch failed");
  db.close();
});

test("a followed lab page that no longer carries a model list is a changed page, and a lab with none listed is not", async () => {
  const db = openDatabase(":memory:");
  await expect(collectOpenCodeData(db, withLab("<html>sign in</html>"))).rejects.toMatchObject({
    kind: "missing-content",
  });
  const empty = await collectOpenCodeData(db, withLab(labPage("alibaba", [])));
  expect(empty.records.map((record) => record.id)).toEqual(["moonshotai/kimi-k3"]);
  expect(empty.raw).toEqual({ moonshotai: 1, alibaba: 0 });
  db.close();
});

test("a stealth page that cannot be read is not the same as one the catalogue does not have", async () => {
  const db = openDatabase(":memory:");
  const lab = labPage("alibaba", []);
  // 404 is how it says a name is not there, and the page for one that is not listed answers it.
  const absent = await collectOpenCodeData(db, withLab(lab));
  expect(absent.records.map((record) => record.id)).toEqual(["moonshotai/kimi-k3"]);
  // Anything else is a probe that did not happen, and a record the last read found would retire on it.
  const pages = answering({
    "https://opencode.ai/data/moonshotai": labPage("moonshotai", []),
    "https://opencode.ai/data/alibaba": lab,
  });
  const failing = (status: number | "network") =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== "https://opencode.ai/data/unknown/space-bunny") return pages(url, init);
      if (status === "network") throw new TypeError("fetch failed");
      return new Response("busy", { status });
    }) as typeof fetch;
  await expect(collectOpenCodeData(db, failing(503))).rejects.toMatchObject({ kind: "http" });
  await expect(collectOpenCodeData(db, failing("network"))).rejects.toThrow("fetch failed");
  db.close();
});
