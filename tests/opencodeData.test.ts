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
