import { expect, test } from "bun:test";
import {
  type IdentityColumnRow,
  type IdentitySubject,
  identityColumns,
  identityFor,
  identityRecordOf,
} from "../src/events/identity.js";
import { recordFor } from "../src/events/record.js";
import type { Event } from "../src/events/types.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent } from "./fixtures/build.js";

/**
 * The story list stopped selecting event bodies and selects the seven keys identity reads instead.
 * The two paths have to agree on every shape a stored body takes, including the ones SQLite and
 * JavaScript disagree about: a key holding an object, a body that is not JSON at all, and a record
 * that lives in `before_json` because the event removed something.
 */
const bodies: { label: string; afterJson: string | null; beforeJson?: string | null }[] = [
  { label: "a plain record", afterJson: JSON.stringify({ id: "openai/gpt-6", name: "GPT-6", vendor: "OpenAI" }) },
  { label: "an explicit canonical id", afterJson: JSON.stringify({ id: "x", name: "X", canonical_id: "openai/x" }) },
  { label: "the camel spelling of it", afterJson: JSON.stringify({ id: "x", name: "X", canonicalId: "openai/x" }) },
  { label: "a name that is an object", afterJson: JSON.stringify({ id: "x", name: { en: "X" } }) },
  { label: "a name that is a number", afterJson: JSON.stringify({ id: "x", name: 7 }) },
  { label: "a name that is only spaces", afterJson: JSON.stringify({ id: "x", name: "   " }) },
  { label: "no record at all", afterJson: null },
  { label: "a body that is not JSON", afterJson: "not json at all" },
  { label: "a record that was removed", afterJson: null, beforeJson: JSON.stringify({ id: "x", name: "Gone" }) },
];

test("identity read from columns is identity read from the body", () => {
  const db = openDatabase(":memory:");
  for (const body of bodies)
    anEvent(db, {
      stream: "api-models",
      entityId: "entity",
      afterJson: body.afterJson,
      ...(body.beforeJson === undefined ? {} : { beforeJson: body.beforeJson }),
    });
  const rows = db
    .query<Event & IdentityColumnRow, []>(`SELECT e.*, ${identityColumns()} FROM events e ORDER BY e.id`)
    .all();
  expect(rows).toHaveLength(bodies.length);
  rows.forEach((row, index) => {
    const subject: IdentitySubject = row;
    expect({ [bodies[index]?.label ?? ""]: identityFor(subject, identityRecordOf(row)) }).toEqual({
      [bodies[index]?.label ?? ""]: identityFor(subject, recordFor(row)),
    });
  });
  db.close();
});

test("a row with no identity column set stands for no record", () => {
  expect(
    identityRecordOf({
      ident_name: null,
      ident_model: null,
      ident_modelKey: null,
      ident_canonical_id: null,
      ident_canonicalId: null,
      ident_modelId: null,
      ident_id: null,
    }),
  ).toBeNull();
});
