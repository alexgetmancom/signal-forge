import { sourceLabel } from "../../sources/labels.js";
import { readerStanding } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import type { Event, RecordData } from "../types.js";
import { DESCRIPTION_CHARACTERS } from "./budget.js";
import { describe, type Fact, factText, pricePair, withoutMakerPrefix } from "./common.js";
import { type CardContext, eventFactParts } from "./facts.js";
import { sourceLogo, vendorLogo } from "./logos.js";

const EYEBROWS: Record<string, string> = {
  "api-models": "MODEL CATALOGUE",
  openrouter: "AVAILABILITY",
  arena: "ARENA",
  leaderboards: "LEADERBOARD",
  news: "OFFICIAL NEWS",
  web: "INTERFACE",
  github: "REPOSITORY",
  weights: "OPEN WEIGHTS",
  packages: "PACKAGE",
  incidents: "PLATFORM HEALTH",
  deprecations: "RETIREMENT",
  apps: "APP RELEASE",
  pages: "NEW PAGES",
  resets: "USAGE LIMITS",
};

const KIND_COLORS: Record<Event["kind"], number> = { new: 0x2ecc71, changed: 0xf1c40f, removed: 0xe74c3c };

const KIND_ICONS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };

function eyebrow(event: Event): string {
  if (event.source === "codex-docs") return "DOCUMENTATION";
  if (event.stream === "leaderboards") return sourceLabel(event.source).toUpperCase();
  return EYEBROWS[event.stream] ?? "UPDATE";
}

/**
 * The name of the thing, with an icon for what happened to it. The eyebrow above already names the
 * kind of surface and the first line of the body says what it means, so a card that also spells
 * out "Model availability updated" spends a reader's attention on grammar rather than on the name.
 */
function eventHeadline(event: Event, name: string, incident: Incident | null): string {
  if (event.stream === "deprecations" && event.kind === "new") return `⚠️ ${name} is being retired`;
  if (incident) return `${incident.icon} ${name}`;
  return `${KIND_ICONS[event.kind]} ${name}`;
}

/** What the observation means for someone deciding whether to care. */
function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  // A first Arena sighting already says this in its own words; repeating it costs a line.
  if (event.stream === "arena" && event.kind !== "new")
    return record?.selectable === false
      ? "Visible on Arena, but not selectable yet."
      : "Visible and selectable on Arena.";
  if (event.stream === "resets") {
    if (record?.stage !== "Applied") {
      const when = typeof record?.expected === "string" ? ` Expected ${record.expected}.` : "";
      return record?.resetType === "banked"
        ? `A reset credit is promised.${when} Nothing has been credited yet.`
        : `A reset is promised.${when} Limits have not come back yet.`;
    }
    return record?.resetType === "banked"
      ? "A reset credit was granted; it applies to a later limit window."
      : "Usage limits are back for everyone.";
  }
  return null;
}

type Detail = "brief" | "evidence";

/** How sure the source is, in the words of someone who does not work here. */
export const TRUST: Record<string, string> = {
  observed: "unconfirmed",
  supported: "the maker's own words",
  confirmed: "confirmed by the provider",
  shipped: "out now",
};

/** A catalogue's name without its section: "Alibaba Model Studio API", "OpenRouter", "PyPI". */
function place(source: string): string {
  return sourceLabel(source).split(" · ")[0] ?? source;
}

type Incident = { icon: string; color: number };

/** An outage is read by its severity first: a red card for a major one, green once it is over. */
function incidentLook(event: Event, record: RecordData | null): Incident | null {
  if (event.stream !== "incidents") return null;
  const stage = String(record?.stage ?? "").toLowerCase();
  const impact = String(record?.impact ?? "").toLowerCase();
  if (event.kind === "removed" || ["resolved", "unlisted", "postmortem", "completed"].includes(stage))
    return { icon: "🟢", color: 0x2ecc71 };
  if (["critical", "major"].includes(impact)) return { icon: "🔴", color: 0xe74c3c };
  if (impact === "minor") return { icon: "🟠", color: 0xe67e22 };
  return { icon: "🟡", color: 0xf1c40f };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The first sentence or two of a published text, cut at a sentence rather than mid-word. */
function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  // A sentence ends at a stop followed by a space: "gpt-image-2.5-flare" is not two sentences.
  let kept = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (`${kept} ${sentence}`.trim().length > limit) break;
    kept = `${kept} ${sentence}`.trim();
  }
  return kept || `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** "2× more expensive on OpenRouter", "30% cheaper on OpenRouter", from the rate a reader pays most. */
function priceSentence(event: Event, before: RecordData, after: RecordData): string | null {
  const old = (before.pricing ?? {}) as Record<string, unknown>;
  const next = (after.pricing ?? {}) as Record<string, unknown>;
  const key = ["completion", "output", "prompt", "input"].find((name) =>
    pricePair(old[name], next[name], event.source),
  );
  const pair = key ? pricePair(old[key], next[key], event.source) : null;
  if (!pair || pair.from <= 0 || pair.from === pair.to) return null;
  const where = place(event.source);
  if (pair.to < pair.from) return `${Math.round((1 - pair.to / pair.from) * 100)}% cheaper on ${where}.`;
  const ratio = pair.to / pair.from;
  return ratio >= 1.95
    ? `${Number(ratio.toFixed(1))}× more expensive on ${where}.`
    : `${Math.round((ratio - 1) * 100)}% more expensive on ${where}.`;
}

/**
 * What a card says first, in one sentence, and which of its values stay. The facts are the record's;
 * this decides what a reader needs from them for each kind of thing that happened.
 */
function shape(
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
    const status = (value: unknown) => capital(describe(value).replace(/^unlisted$/, "no longer listed"));
    return {
      sentence: event.kind === "removed" ? "No longer listed on the status page." : summary,
      facts: [
        ...(present(record?.impact) ? [{ label: "Impact", value: capital(describe(record?.impact)) }] : []),
        ...(present(after?.stage)
          ? [
              {
                label: "Status",
                value:
                  before && canonicalText(before.stage) !== canonicalText(after?.stage)
                    ? `${status(before.stage)} → ${status(after?.stage)}`
                    : status(after?.stage),
              },
            ]
          : []),
      ],
    };
  }
  if (event.stream === "apps" && after) {
    return {
      sentence:
        event.kind === "new"
          ? `Released on ${place(event.source)}.`
          : present(after.version)
            ? `Updated to ${describe(after.version)}.`
            : `Updated on ${place(event.source)}.`,
      facts: [],
    };
  }
  if (event.stream === "packages") {
    return {
      sentence:
        event.kind === "removed" ? `Removed from ${place(event.source)}.` : `Released on ${place(event.source)}.`,
      facts: drop("Version", "Renamed"),
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
      sentence: added !== undefined ? `Interface text changed: ${added} strings added, ${removed ?? 0} removed.` : null,
      facts: quotes,
    };
  }
  if (event.stream === "arena" && event.kind === "new" && !event.siblings?.length && !event.elsewhere?.length) {
    return {
      sentence: maker
        ? `New on Arena under ${maker}'s name. ${maker} has not announced it.`
        : "Unknown model on Arena. No maker is listed.",
      facts: drop("Identity"),
    };
  }
  if (event.stream === "leaderboards") return { sentence: null, facts };
  const impact = readerImpact(event, record);
  // A changed arena row and an entry other catalogues already list say where they stand themselves.
  const standing =
    event.stream === "arena" && (event.elsewhere?.length || event.siblings?.length || impact)
      ? null
      : readerStanding(event);
  return { sentence: [standing, impact].filter(Boolean).join(" ") || null, facts };
}

const canonicalText = (value: unknown) => describe(value).toLowerCase();

function present(raw: unknown): boolean {
  return !(raw === null || raw === undefined || raw === "");
}

/** What a news reader is spared: identity bookkeeping and the values only a scout checks. */
const EVIDENCE_ONLY = new Set(["Identity", "Also known as", "Variant", "Votes", "Architecture", "Provider", "Changes"]);

/** Discord shows at most 25 fields; a card with more than this many is a table nobody reads. */
const MAX_FIELDS = 6;
/** A value longer than this breaks a three-column row and gets the full width instead. */
const INLINE_CHARACTERS = 28;

/**
 * Labelled facts become the card's fields; sentences stay in the description. The fields follow the
 * facts' own order, and a fact past the field budget goes back into the text rather than away.
 */
function factLayout(facts: Fact[]): { lines: string[]; fields: Record<string, unknown>[] } {
  const lines: string[] = [];
  const fields: Record<string, unknown>[] = [];
  for (const fact of facts) {
    if (typeof fact === "string") lines.push(fact);
    else if (fields.length < MAX_FIELDS)
      fields.push({
        name: fact.label.slice(0, 256),
        value: fact.value.slice(0, 1024) || "—",
        inline: fact.value.length <= INLINE_CHARACTERS,
      });
    else lines.push(factText(fact));
  }
  return { lines, fields };
}

/** The source a card came from, and for a scout how sure that source is. */
export function footerText(source: string, confidence: string, detail: Detail, caveat?: string): string {
  return [
    sourceLabel(source),
    ...(detail === "evidence" ? [TRUST[confidence] ?? confidence] : []),
    ...(caveat ? [caveat] : []),
  ].join(" · ");
}

export function eventEmbed(
  event: Event & CardContext,
  url: string,
  summary?: string,
  detail: Detail = "evidence",
): Record<string, unknown> {
  const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
  const after = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const record = after ?? before;
  const link =
    typeof record?.url === "string" && record.url.trim()
      ? record.url
      : event.source === "openrouter"
        ? `https://openrouter.ai/${event.entity_id}`
        : url;
  const vendor = vendorOf(event, record);
  const rawName = String(record?.name ?? event.entity_id);
  const shown = displayTitle(rawName, event.stream, event.source);
  const stripped = withoutMakerPrefix(shown);
  const name = stripped === shown ? shown : capital(stripped);
  const all = eventFactParts(event).filter((fact) => factText(fact).toLowerCase() !== `maker: ${vendor.toLowerCase()}`);
  const shaped = shape(event, before, after, vendor, all);
  const facts = shaped.facts.filter(
    (fact) =>
      detail === "evidence" || (typeof fact === "string" ? !/^> [+−] /.test(fact) : !EVIDENCE_ONLY.has(fact.label)),
  );
  const { lines, fields } = factLayout(facts);
  // The name a scout copies into an API call, when the headline prettified it.
  const handle =
    detail === "evidence" && rawName !== name && !/\s/.test(rawName) && event.stream !== "packages"
      ? `\`${rawName}\``
      : null;
  const description = [
    ...(summary ? [`*${summary}*`] : []),
    ...(shaped.sentence ? [shaped.sentence] : []),
    ...lines,
    ...(handle ? [handle] : []),
  ]
    .join("\n")
    .slice(0, DESCRIPTION_CHARACTERS);
  const incident = incidentLook(event, record);
  const sourceIcon = sourceLogo(event.source);
  const embed: Record<string, unknown> = {
    author: {
      name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
      ...(sourceIcon ? { icon_url: sourceIcon } : {}),
    },
    title: eventHeadline(event, name, incident).slice(0, 250),
    color: incident?.color ?? (event.stream === "deprecations" ? 0xe67e22 : KIND_COLORS[event.kind]),
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    // Discord renders its own timestamp in the reader's timezone, which is one line of card spent
    // on something the client already does.
    timestamp: new Date(event.detected_at).toISOString(),
    footer: {
      text: footerText(
        event.source,
        event.confidence ?? "observed",
        detail,
        event.stream === "web" ? "a text change is not a shipped feature" : undefined,
      ),
    },
  };
  const thumbnail = vendorLogo(vendor);
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (link) embed.url = link;
  return embed;
}
