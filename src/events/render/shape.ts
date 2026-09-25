/**
 * What a card says first, in one sentence, and which of its facts stay.
 *
 * One function per stream's worth of judgement, in one place, because the decision it makes is
 * always the same trade: the title already said one thing and the fields will say another, so the
 * sentence says only what neither can. Everything it needs to say it comes from the modules beside
 * it. Moved out of discord.ts unchanged.
 */
import { readerStanding } from "../confidence.js";
import type { Event, RecordData } from "../types.js";
import { resetConfirmation, resetDue, resetWords } from "./banners.js";
import { describe, type Fact } from "./common.js";
import type { CardContext } from "./facts.js";
import { mentionSentence, mentionSighting, readerImpact } from "./headline.js";
import { priceSentence } from "./price.js";
import { excerpt, place, present } from "./words.js";

/**
 * What a card says first, in one sentence, and which of its values stay. The facts are the record's;
 * this decides what a reader needs from them for each kind of thing that happened.
 */
export function shape(
  event: Event & CardContext,
  before: RecordData | null,
  after: RecordData | null,
  vendor: string,
  facts: Fact[],
): { sentence: string | null; facts: Fact[] } {
  const record = after ?? before;
  const maker = vendor === "Unknown" ? null : vendor;
  const drop = (...labels: string[]) =>
    facts.filter((fact) => typeof fact === "string" || !labels.includes(fact.label));
  const catalogue = event.stream === "api-models" || event.stream === "openrouter";

  if (event.stream === "deprecations" && event.kind === "new" && after) {
    const shutdown = after.shutdown ?? after.retirement ?? after.deprecated;
    return {
      sentence: null,
      facts: [
        ...(present(after.announced) ? [{ label: "Announced", value: describe(after.announced) }] : []),
        { label: "Shutdown", value: present(shutdown) ? describe(shutdown) : "not announced" },
        { label: "Replacement", value: present(after.replacement) ? describe(after.replacement) : "not named" },
      ],
    };
  }
  if (event.stream === "incidents") {
    const summary = typeof record?.summary === "string" ? excerpt(record.summary, 200) : null;
    return {
      // The icon and stripe already say how bad it is, and a green one that it is over; "This incident
      // has been resolved" under a 🟢 said it a third time.
      // The icon says the status; what a closed one adds is how long it lasted, said as a sentence:
      // a "Lasted" field spent two lines on three words.
      sentence:
        event.kind === "removed" || /resolved/i.test(describe(after?.stage))
          ? (lasted(record, event) ?? (event.kind === "removed" ? "No longer listed on the status page." : null))
          : summary,
      facts: [],
    };
  }
  // The title says what and which version; a sentence under it only said where again.
  if (event.stream === "apps" && after) {
    return {
      sentence:
        event.kind === "new" && !present(after.version)
          ? `Released on ${place(event.source)}.`
          : present(after.version)
            ? null
            : `Updated on ${place(event.source)}.`,
      facts: [],
    };
  }
  if (event.stream === "packages") {
    return {
      sentence: event.kind === "removed" ? `Removed from ${place(event.source)}.` : null,
      facts: drop("Version", "Renamed"),
    };
  }
  // A reset's stage and type were fields under a sentence that already said both.
  if (event.stream === "resets") {
    // A promise with a time counts down on every reader's screen; Discord keeps the timer running.
    const due = resetDue(record);
    return {
      sentence:
        record?.stage === "Applied"
          ? resetConfirmation(record)
          : due !== null
            ? [resetWords(record), `Resets <t:${due}:R> · <t:${due}:t> your time.`].filter(Boolean).join("\n\n")
            : (resetWords(record) ?? readerImpact(event, record)),
      facts: [],
    };
  }
  if (event.stream === "news") {
    const text = [record?.summary, record?.description, record?.message].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    // A changelog arrives as its entries run together: "Added … Fixed … Added …". Three entries
    // read as a list; the rest is behind the link.
    const entries = text ? text.split(/\s+(?=(?:Added|Fixed|Improved|Changed|Removed|Updated|Deprecated) )/) : [];
    return {
      sentence:
        entries.length > 1
          ? entries
              .slice(0, 3)
              .map((entry) => `• ${excerpt(entry, 120)}`)
              .join("\n")
          : text
            ? excerpt(text, 280)
            : null,
      facts: facts.filter((fact) => typeof fact !== "string" && fact.label !== "Version"),
    };
  }
  if (event.stream === "weights" && event.kind === "new") {
    return {
      sentence: `Weights published on ${place(event.source)}.`,
      // `Qwen3_5MoeForConditionalGeneration` is a class name; a reader wants "Qwen3.5 MoE".
      facts: drop("Access", "Author", "Task", "Likes").map((fact) =>
        typeof fact !== "string" && fact.label === "Architecture"
          ? {
              ...fact,
              value: fact.value
                .replace(/For[A-Z]\w*$/, "")
                .replace(/(\d)_(\d)/g, "$1.$2")
                .replace(/Moe$/, " MoE"),
            }
          : fact,
      ),
    };
  }
  if (catalogue && before && after && JSON.stringify(before.pricing) !== JSON.stringify(after.pricing)) {
    return { sentence: priceSentence(event, before, after) ?? `Price changed on ${place(event.source)}.`, facts };
  }
  if (catalogue && event.kind === "new") {
    return {
      sentence: `Added to ${place(event.source)}.`,
      facts: drop("Owner", "Provider", "Maker"),
    };
  }
  if (catalogue && event.kind === "removed") return { sentence: `Removed from ${place(event.source)}.`, facts: [] };
  if (catalogue) return { sentence: `Changed on ${place(event.source)}.`, facts };
  if (event.stream === "web" && before && after) {
    const count = facts.find((fact) => typeof fact !== "string" && fact.label === "Changes");
    const [added, removed] = count && typeof count !== "string" ? (count.value.match(/\d+/g) ?? []) : [];
    const quotes = facts
      .filter((fact): fact is string => typeof fact === "string" && /^[+−] /.test(fact))
      .slice(0, 2)
      .map((line) => `> ${line}`);
    return {
      sentence: added !== undefined ? `${added} line${added === "1" ? "" : "s"} added, ${removed ?? 0} removed.` : null,
      facts: quotes,
    };
  }
  if (event.stream === "arena" && event.kind === "new" && !event.siblings?.length && !event.elsewhere?.length) {
    return {
      sentence: maker
        ? `Listed under ${maker}'s name. ${maker} has not announced it.`
        : "Unknown model on Arena. No maker is listed.",
      facts: drop("Identity"),
    };
  }
  if (event.stream === "leaderboards") return { sentence: null, facts };
  if (mentionSighting(event) && record) return { sentence: mentionSentence(record), facts: [] };
  const impact = readerImpact(event, record);
  // A changed arena row and an entry other catalogues already list say where they stand themselves.
  // A training run's footer already says "unconfirmed"; "Seen by one source, unconfirmed" said it twice.
  const standing =
    event.stream === "training" ||
    (event.stream === "arena" && (event.elsewhere?.length || event.siblings?.length || impact))
      ? null
      : readerStanding(event);
  return { sentence: [standing, impact].filter(Boolean).join(" ") || null, facts };
}

function lasted(record: RecordData | null, event: Event): string | null {
  const started = typeof record?.started === "string" ? Date.parse(record.started) : Number.NaN;
  const minutes = Math.round((Date.parse(event.detected_at) - started) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return `Lasted ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`}.`;
}
