import { expect, test } from "bun:test";
import { jsonMembers } from "../src/sources/jsonMembers.js";

test("named members are cut out of a document whose other members are never parsed", () => {
  const payload = JSON.stringify({
    name: "@openai/codex",
    "dist-tags": { latest: "1.2.3" },
    versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/x.tgz" } } },
    time: { "1.2.3": "2026-09-01T00:00:00.000Z" },
  });
  const members = jsonMembers(payload, ["name", "dist-tags", "time"]);
  expect(Object.keys(members).sort()).toEqual(["dist-tags", "name", "time"]);
  expect(JSON.parse(members.name as string)).toBe("@openai/codex");
  expect(JSON.parse(members["dist-tags"] as string)).toEqual({ latest: "1.2.3" });
  expect(JSON.parse(members.time as string)).toEqual({ "1.2.3": "2026-09-01T00:00:00.000Z" });
});

test("structure inside a string value is text, not structure", () => {
  // A value that looks like the end of the document, and an escaped quote before it. Counting braces
  // without reading strings is how a scanner like this stops one member early.
  const payload = JSON.stringify({
    description: 'a }{ "[]" trap \\ with a quote " in it',
    keep: { deep: [1, 2, { closer: "}]}" }] },
    last: 7,
  });
  expect(JSON.parse(jsonMembers(payload, ["keep"]).keep as string)).toEqual({ deep: [1, 2, { closer: "}]}" }] });
  expect(JSON.parse(jsonMembers(payload, ["last"]).last as string)).toBe(7);
});

test("every kind of value has an end, and whitespace between them is not one", () => {
  const payload = '{\n  "a" : null ,\n  "b" : true,\n  "c" : -1.5e3 ,\n  "d" : [ ] ,\n  "e" : "x"\n}';
  const members = jsonMembers(payload, ["a", "b", "c", "d", "e"]);
  expect(members).toEqual({ a: "null", b: "true", c: "-1.5e3", d: "[ ]", e: '"x"' });
});

test("a member that is not there is absent rather than empty, and the scan stops when it has all it asked for", () => {
  expect(jsonMembers('{"a":1}', ["b"])).toEqual({});
  // `unterminated` is never reached: `a` completes the request before the scan gets to it.
  expect(jsonMembers('{"a":1,"unterminated":"', ["a"])).toEqual({ a: "1" });
});

test("a document that is not a JSON object is a protocol failure, named as one", () => {
  expect(() => jsonMembers("[1,2]", ["a"])).toThrow("no JSON object");
  expect(() => jsonMembers('{"a":{"b":1', ["a"])).toThrow("unbalanced");
  expect(() => jsonMembers('{"a":"x', ["z"])).toThrow("unterminated");
  expect(() => jsonMembers("{a:1}", ["a"])).toThrow("malformed");
  expect(() => jsonMembers('{"a" 1}', ["a"])).toThrow("malformed");
});

test("a document cut short before the members asked for is a protocol failure too", () => {
  // The scan has to walk past a member to skip it, so a document cut inside one is unbalanced
  // whether or not that member was wanted. What ends the scan early is having everything asked for.
  expect(() => jsonMembers('{"a":1,"junk":{"deep":', ["a", "b"])).toThrow("unbalanced");
  expect(jsonMembers('{"a":1,"junk":{"deep":', ["a"])).toEqual({ a: "1" });
});
