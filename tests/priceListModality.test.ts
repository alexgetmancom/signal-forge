import { expect, test } from "bun:test";
import { isTheModalityOfAPricedModel } from "../src/events/worth.js";
import { openDatabase } from "../src/storage/database.js";

function catalogue(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  const add = (source: string, id: string, name = id) =>
    db
      .query(
        "INSERT INTO records(source,id,body,stream,observed_at) VALUES(?,?,?,'api-models','2026-09-24T00:00:00.000Z')",
      )
      .run(source, id, JSON.stringify({ id, name }));
  for (const id of [
    "gemini-3.8-live",
    "gemini-3.8-live-image",
    "gemini-2.5-flash",
    "gemini-2.5-flash-image",
    "gemini-3.8-flash-cyber",
  ])
    add("google-skus", id);
  // Nano Banana is a real model that four other catalogues carry; the phantom has no witness.
  add("openrouter", "google/gemini-2.5-flash-image", "gemini-2.5-flash-image");
  return db;
}

const arrival = (id: string) =>
  ({
    source: "google-skus",
    stream: "api-models",
    kind: "new",
    entity_id: id,
    after_json: JSON.stringify({ name: id }),
  }) as never;

test("a price list charging a listed model for image tokens is not a model, unless a second catalogue says it is", () => {
  const db = catalogue();
  // "Generate content input token count gemini 3.8 live image" is image tokens on Gemini 3.8 Live.
  expect(isTheModalityOfAPricedModel(db, arrival("gemini-3.8-live-image"))).toBe(true);
  // Nano Banana carries the same suffix and is a model, which is why the word cannot just be stripped.
  expect(isTheModalityOfAPricedModel(db, arrival("gemini-2.5-flash-image"))).toBe(false);
  // Nothing on the list reads as its base, so this is a name the price list saw first and it speaks.
  expect(isTheModalityOfAPricedModel(db, arrival("gemini-3.8-flash-cyber"))).toBe(false);
  expect(isTheModalityOfAPricedModel(db, arrival("gemini-3.8-live"))).toBe(false);
});
