import { expect, test } from "bun:test";
import { recordFor } from "../src/events/record.js";
import { parseRecord } from "../src/events/recordBody.js";

test("a body that is an object is a record, and every other body is no record at all", () => {
  expect(parseRecord('{"id":"a","name":"A","size":3}')).toEqual({ id: "a", name: "A", size: 3 });
  // Each of these is valid JSON or none, and none of them has a `.name` to read: the `null` is the
  // one that threw a TypeError inside a report, the array and the number are what a cast let through.
  for (const body of ["null", "[]", "[1,2]", "5", '"text"', "true", "oops", "{", "", null, undefined])
    expect(parseRecord(body)).toBeNull();
});

test("an event's record is the state after the change, or the state before it for a removal", () => {
  const after = '{"id":"a","name":"after"}';
  const before = '{"id":"a","name":"before"}';
  expect(recordFor({ after_json: after, before_json: before })?.name).toBe("after");
  expect(recordFor({ after_json: null, before_json: before })?.name).toBe("before");
  expect(recordFor({ after_json: null, before_json: null })).toBeNull();
  // A body that is damaged is absent, not a reason to fall back to the other side of the change.
  expect(recordFor({ after_json: "oops", before_json: before })).toBeNull();
});
