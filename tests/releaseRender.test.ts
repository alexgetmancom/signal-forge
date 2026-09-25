import { describe, expect, test } from "bun:test";
import { releaseRender, renderFingerprint } from "../src/reports/releaseRender.js";
import { recordRuntimeStart } from "../src/runtime/observability.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent } from "./fixtures/build.js";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function withEvents(count: number) {
  const db = openDatabase(":memory:");
  for (let index = 0; index < count; index += 1)
    anEvent(db, {
      entityId: `model-${index}`,
      detectedAt: new Date(NOW - 3_600_000).toISOString(),
      afterJson: JSON.stringify({ id: `model-${index}`, name: `Model ${index}` }),
    });
  return db;
}

describe("what this build renders", () => {
  test("the same events under the same build give the same hash", () => {
    const db = withEvents(4);
    const first = renderFingerprint(db, 2, NOW);
    expect(first.cards).toBe(8);
    expect(renderFingerprint(db, 2, NOW).hash).toBe(first.hash);
    // One more event is one more pair of cards and a different fingerprint.
    anEvent(db, { entityId: "model-extra", detectedAt: new Date(NOW - 3_600_000).toISOString() });
    const second = renderFingerprint(db, 2, NOW);
    expect(second.cards).toBe(10);
    expect(second.hash).not.toBe(first.hash);
    db.close();
  });

  test("events outside the window are not part of it", () => {
    const db = withEvents(2);
    anEvent(db, { entityId: "old", detectedAt: new Date(NOW - 40 * 24 * 3_600_000).toISOString() });
    expect(renderFingerprint(db, 2, NOW).cards).toBe(4);
    expect(renderFingerprint(db, 60, NOW).cards).toBe(6);
    db.close();
  });

  test("a process with no recorded start gets no row rather than a row keyed on nothing", () => {
    const db = withEvents(1);
    expect(releaseRender(db, 2, NOW)).toBeNull();
    db.close();
  });

  test("computed once a boot, and compared against the boot before it", () => {
    const db = withEvents(3);
    recordRuntimeStart(db, NOW - 7_200_000, "boot-one");
    const first = releaseRender(db, 2, NOW);
    expect(first?.previous).toBeNull();
    // Asked again in the same boot it is read back, not recomputed.
    expect(releaseRender(db, 2, NOW)?.hash).toBe(first?.hash as string);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM release_renders").get()?.n).toBe(1);

    // A restart with the same code renders the same cards, and says how far back that goes.
    recordRuntimeStart(db, NOW - 3_600_000, "boot-two");
    const second = releaseRender(db, 2, NOW);
    expect(second?.hash).toBe(first?.hash as string);
    expect(second?.previous).toBeNull();
    expect(second?.unchangedSince).toBe(new Date(NOW - 7_200_000).toISOString());

    // A restart after an event arrived renders something else, and names what it differed from.
    anEvent(db, { entityId: "arrived", detectedAt: new Date(NOW - 120_000).toISOString() });
    recordRuntimeStart(db, NOW - 60_000, "boot-three");
    const third = releaseRender(db, 2, NOW);
    expect(third?.hash).not.toBe(first?.hash as string);
    expect(third?.previous?.hash).toBe(first?.hash as string);
    expect(third?.previous?.bootedAt).toBe(new Date(NOW - 3_600_000).toISOString());
    db.close();
  });
});
