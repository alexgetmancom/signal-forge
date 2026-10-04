import { expect, test } from "bun:test";
import { pointers } from "../src/reports/pointers.js";
import { openDatabase } from "../src/storage/database.js";
import { anEvent, aRecord } from "./fixtures/build.js";

const now = Date.parse("2026-10-04T12:00:00.000Z");

/**
 * The three answers one question has, and which of them is the one worth watching.
 *
 * A pointer aiming at a model some catalogue here has listed is the ordinary state; one aiming at a
 * name nothing has recorded is a model that exists before it is announced, and it is counted
 * separately because that is the case this report exists for. All eighteen targets on production
 * were listed on 2026-10-04, so the interesting answer is the one a test has to manufacture.
 */
test("pointers answer where each alias aims and whether anything here has listed it", () => {
  const db = openDatabase(":memory:");
  aRecord(db, {
    id: "~openai/gpt-sol-latest",
    body: {
      id: "~openai/gpt-sol-latest",
      name: "OpenAI: GPT Sol Latest",
      aliasTarget: "openai/gpt-6.1-sol",
      created: "2026-09-11T12:48:48.000Z",
    },
  });
  aRecord(db, { id: "openai/gpt-6.1-sol", body: { id: "openai/gpt-6.1-sol", name: "OpenAI: GPT 6.1 Sol" } });
  aRecord(db, {
    id: "~anthropic/claude-opus-latest",
    body: {
      id: "~anthropic/claude-opus-latest",
      name: "Anthropic: Claude Opus Latest",
      aliasTarget: "anthropic/claude-opus-6",
    },
  });
  const report = pointers(db, 30, now);
  expect(report.unlistedTargets).toBe(1);
  expect(report.pointers).toEqual([
    {
      alias: "~anthropic/claude-opus-latest",
      title: "Anthropic: Claude Opus Latest",
      target: "anthropic/claude-opus-6",
      targetListedHere: false,
      createdUpstream: null,
      source: "openrouter",
    },
    {
      alias: "~openai/gpt-sol-latest",
      title: "OpenAI: GPT Sol Latest",
      target: "openai/gpt-6.1-sol",
      targetListedHere: true,
      createdUpstream: "2026-09-11T12:48:48.000Z",
      source: "openrouter",
    },
  ]);
  // A model with neither field is not a pointer and not expiring, and says nothing here.
  expect(report.moves).toEqual([]);
  expect(report.firstRead).toEqual([]);
  expect(report.expiring).toEqual([]);
  db.close();
});

/**
 * A move, and the read that is not one.
 *
 * The field appearing where there was nothing is this service starting to store it, which happened
 * once to eighteen records at once. It is reported, because the report is what somebody reads to
 * find out whether anything moved and a silent omission would answer that question wrongly, but
 * `was: null` is what tells the two apart.
 */
test("a move is reported with what it was, and a field first appearing has no before", () => {
  const db = openDatabase(":memory:");
  anEvent(db, {
    source: "openrouter",
    stream: "openrouter",
    entityId: "~openai/gpt-sol-latest",
    kind: "changed",
    detectedAt: "2026-10-03T07:52:13.233Z",
    beforeJson: JSON.stringify({ id: "~openai/gpt-sol-latest", aliasTarget: "openai/gpt-6-astra" }),
    afterJson: JSON.stringify({ id: "~openai/gpt-sol-latest", aliasTarget: "openai/gpt-6.1-sol" }),
  });
  anEvent(db, {
    source: "openrouter",
    stream: "openrouter",
    entityId: "~x-ai/grok-latest",
    kind: "changed",
    detectedAt: "2026-10-02T07:52:13.233Z",
    beforeJson: JSON.stringify({ id: "~x-ai/grok-latest" }),
    afterJson: JSON.stringify({ id: "~x-ai/grok-latest", aliasTarget: "x-ai/grok-4.7" }),
  });
  // Outside the window, and so not an answer to "what moved this week".
  anEvent(db, {
    source: "openrouter",
    stream: "openrouter",
    entityId: "~z-ai/glm-latest",
    kind: "changed",
    detectedAt: "2026-08-01T07:52:13.233Z",
    beforeJson: JSON.stringify({ id: "~z-ai/glm-latest", aliasTarget: "z-ai/glm-5.2" }),
    afterJson: JSON.stringify({ id: "~z-ai/glm-latest", aliasTarget: "z-ai/glm-5.3" }),
  });
  const report = pointers(db, 30, now);
  expect(report.firstRead).toEqual([
    { eventId: 2, at: "2026-10-02T07:52:13.233Z", alias: "~x-ai/grok-latest", was: null, now: "x-ai/grok-4.7" },
  ]);
  expect(report.moves).toEqual([
    {
      eventId: 1,
      at: "2026-10-03T07:52:13.233Z",
      alias: "~openai/gpt-sol-latest",
      was: "openai/gpt-6-astra",
      now: "openai/gpt-6.1-sol",
    },
  ]);
  expect(pointers(db, 1, now).moves).toEqual([]);
  db.close();
});

/**
 * An expiry date, with the days a reader counts and whether anything is counting them.
 *
 * `deadlineKnown` is the join to `lifecycle-deadlines`, which holds these with no reminder rows. A
 * date here and no deadline there would mean the fold has not run since the field arrived, which is
 * the one failure of this pair that is otherwise invisible.
 */
test("an expiry date is reported with the days left and whether a deadline holds it", () => {
  const db = openDatabase(":memory:");
  aRecord(db, {
    id: "google/gemini-2.5-pro",
    body: { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", expirationDate: "2026-10-20" },
  });
  aRecord(db, {
    id: "z-ai/glm-4.5",
    body: { id: "z-ai/glm-4.5", name: "Z.ai: GLM 4.5", expirationDate: "2026-12-31" },
  });
  const report = pointers(db, 30, now);
  expect(report.expiring).toEqual([
    {
      id: "google/gemini-2.5-pro",
      title: "Google: Gemini 2.5 Pro",
      source: "openrouter",
      expiresAt: "2026-10-20",
      daysLeft: 15,
      deadlineKnown: false,
    },
    {
      id: "z-ai/glm-4.5",
      title: "Z.ai: GLM 4.5",
      source: "openrouter",
      expiresAt: "2026-12-31",
      daysLeft: 87,
      deadlineKnown: false,
    },
  ]);
  db.close();
});
