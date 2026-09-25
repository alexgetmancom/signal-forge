import { describe, expect, test } from "bun:test";
import { shapeHash, shapeOf } from "../src/shape.js";
import { openDatabase } from "../src/storage/database.js";
import { listSourceShapes, recordSourceShape, shapeDifference } from "../src/storage/sourceShapes.js";

const AT = "2026-09-25T12:00:00.000Z";
const later = (hours: number) => new Date(Date.parse(AT) + hours * 3_600_000).toISOString();

describe("the shape of an answer", () => {
  test("keeps paths and types and no value anywhere", () => {
    const shape = shapeOf([{ id: "claude-opus-5-5", rank: 3, pricing: { input: 1.5 } }]);
    // `[]` is the root itself: an array that came back empty has to be tellable from one that did not.
    expect(Object.keys(shape.paths)).toEqual(["[]", "[].id", "[].pricing.input", "[].rank"]);
    expect(shape.paths["[].id"]).toBe("string");
    expect(JSON.stringify(shape.paths)).not.toContain("claude-opus-5-5");
    // The only number kept is how many entries there were, which is a fact about the contract.
    expect(shape.counts["."]).toBe(1);
  });

  test("a roster of 61 and a roster of 1083 are the same contract", () => {
    const row = { id: "x", rank: 1 };
    const small = shapeOf(Array.from({ length: 61 }, () => row));
    const large = shapeOf(Array.from({ length: 1083 }, () => row));
    expect(shapeHash(small)).toBe(shapeHash(large));
    expect(small.counts["."]).toBe(61);
    expect(large.counts["."]).toBe(1083);
  });

  test("an object keyed by its data is collapsed rather than recorded key by key", () => {
    const keyed = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`model-${index}`, { rank: index }]));
    const shape = shapeOf(keyed);
    expect(Object.keys(shape.paths)).toEqual(["{*}", "{*}.rank"]);
    expect(JSON.stringify(shape.paths)).not.toContain("model-7");
    expect(shape.counts["{*}"]).toBe(200);
  });

  test("a placeholder where an array used to be is a different shape", () => {
    // Exactly what arena.ai served: React Flight's encoding of `undefined` in place of the roster.
    const working = shapeOf([{ id: "x", rank: 1 }]);
    const broken = shapeOf("$undefined");
    expect(shapeHash(working)).not.toBe(shapeHash(broken));
    expect(shapeDifference(working.paths, broken.paths).gone).toContain("[].id");
  });
});

describe("what is stored about it", () => {
  test("a contract that holds is one row with a count, not one row per collection", () => {
    const db = openDatabase(":memory:");
    for (const hour of [0, 1, 2]) recordSourceShape(db, "arena", [{ id: "x", rank: 1 }], later(hour));
    const [stored] = listSourceShapes(db, "arena");
    expect(listSourceShapes(db, "arena")).toHaveLength(1);
    expect(stored?.seen).toBe(3);
    expect(stored?.firstSeenAt).toBe(AT);
    expect(stored?.lastSeenAt).toBe(later(2));
  });

  test("the sizes an array came back as are kept as a range", () => {
    const db = openDatabase(":memory:");
    const roster = (size: number) => Array.from({ length: size }, () => ({ id: "x", rank: 1 }));
    recordSourceShape(db, "arena", roster(1083), AT);
    recordSourceShape(db, "arena", roster(61), later(1));
    recordSourceShape(db, "arena", roster(302), later(2));
    const [stored] = listSourceShapes(db, "arena");
    expect(stored?.counts["."]).toEqual({ min: 61, max: 1083, last: 302 });
  });

  test("a changed contract is a second row, and the difference is readable", () => {
    const db = openDatabase(":memory:");
    recordSourceShape(db, "arena", [{ id: "x", rank: 1 }], AT);
    recordSourceShape(db, "arena", [{ id: "x", place: 1 }], later(1));
    const [newest, previous] = listSourceShapes(db, "arena");
    expect(listSourceShapes(db, "arena")).toHaveLength(2);
    const moved = shapeDifference(previous?.shape ?? {}, newest?.shape ?? {});
    expect(moved.gone).toEqual(["[].rank"]);
    expect(moved.arrived).toEqual(["[].place"]);
  });

  test("an answer nothing can be read from is dropped rather than raised", () => {
    const db = openDatabase(":memory:");
    expect(() => recordSourceShape(db, "arena", undefined, AT)).not.toThrow();
    expect(listSourceShapes(db, "arena")).toEqual([]);
    // A structure that points at itself is stopped by the depth cap rather than by a stack overflow.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => recordSourceShape(db, "arena", circular, AT)).not.toThrow();
    expect(listSourceShapes(db, "arena")[0]?.paths).toBe(1);
  });
});
