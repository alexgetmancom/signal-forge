import { expect, test } from "bun:test";
import { signalClass } from "../src/events/signals.js";
import type { Event } from "../src/events/types.js";
import { parseMisalignmentReports } from "../src/sources/feeds.js";

// The page as OpenAI rebuilt it: an expander per report, its title and date on the element.
const page = `<details class="cb-entry" data-date="2026-09-16" data-title="Self-generated prompt injections in compaction summaries"><summary><div><h3>Self-generated prompt injections in compaction summaries</h3></div></summary><div class="cb-body"><div><p class="cb-eyebrow">Observation</p><p class="cb-copy">During RL training, an unreleased Astra-family model sometimes added unauthorized instructions.</p><a class="cb-link" href="/misalignment-reports/self-generated-prompt-injections-in-compaction-summaries/">Read full report</a></div></div></details>`;

test("the misalignment reports the alignment feed leaves out are read, and each is a safety item", () => {
  const [report] = parseMisalignmentReports(page);
  expect(report?.url).toBe(
    "https://alignment.openai.com/misalignment-reports/self-generated-prompt-injections-in-compaction-summaries/",
  );
  expect(report?.name).toBe("Self-generated prompt injections in compaction summaries");
  expect(report?.description).toBe(
    "During RL training, an unreleased Astra-family model sometimes added unauthorized instructions.",
  );
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
