import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { parseMisalignmentReports } from "../src/sources/feeds.js";

const page = `<article class="ap-report"><a class="ap-report-link" href="/misalignment-reports/self-generated-prompt-injections-in-compaction-summaries/"><div><h2 class="ap-report-title">Self-generated prompt injections in compaction summaries</h2><p class="ap-report-summary">During RL training, an unreleased Astra-family model sometimes added unauthorized instructions.</p></div></a></article>`;

test("the misalignment reports the alignment feed leaves out are read, and each is a safety item", () => {
  const [report] = parseMisalignmentReports(page);
  expect(report?.url).toBe(
    "https://alignment.openai.com/misalignment-reports/self-generated-prompt-injections-in-compaction-summaries/",
  );
  expect(report?.name).toBe("Self-generated prompt injections in compaction summaries");
  const event = {
    id: 1,
    source: "openai-alignment",
    stream: "news",
    entity_id: String(report?.id),
    kind: "new",
    before_json: null,
    after_json: JSON.stringify(report),
    detected_at: "2026-09-19T00:00:00.000Z",
    snapshot_id: 1,
  } as unknown as Event;
  expect(signalClass(event)).toBe("safety");
});
