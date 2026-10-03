import { expect, test } from "bun:test";
import { saveCollection } from "../src/events/pipeline.js";
import { collectCodexDocs } from "../src/sources/codex.js";
import { openDatabase } from "../src/storage/database.js";

const root = "https://learn.chatgpt.com/docs/";
const index = `[Models](${root}models.md)\n[Pricing](${root}pricing.md)`;

test("an unchanged documentation page stays in the catalogue without another full raw copy", async () => {
  const db = openDatabase(":memory:");
  const texts: Record<string, string> = {
    [`${root}models.md`]: "# Models\n\nModel A",
    [`${root}pricing.md`]: "# Pricing\n\nPrice A",
  };
  const request = async (url: string) => new Response(url.endsWith("llms.txt") ? index : texts[url]);
  const first = await collectCodexDocs(db, request);
  expect(first.records).toHaveLength(2);
  expect(first.raw).toEqual({ index, ...texts });
  saveCollection(db, first, []);
  const unchanged = await collectCodexDocs(db, request);
  expect(unchanged.records).toEqual(first.records);
  expect(unchanged.raw).toEqual({ index });
  texts[`${root}models.md`] = "# Models\n\nModel B";
  const changed = await collectCodexDocs(db, request);
  expect(changed.records).toHaveLength(2);
  expect(changed.raw).toEqual({ index, [`${root}models.md`]: texts[`${root}models.md`] });
  expect(saveCollection(db, changed, []).events).toBe(1);
  db.close();
});

test("a failed page aborts the observation and does not turn into a disappearance", async () => {
  const db = openDatabase(":memory:");
  await expect(
    collectCodexDocs(db, async (url) => new Response(url.endsWith("llms.txt") ? index : "<html>error</html>")),
  ).rejects.toThrow("expected Markdown");
  expect(db.query("SELECT count(*) AS n FROM records").get()).toEqual({ n: 0 });
  db.close();
});
