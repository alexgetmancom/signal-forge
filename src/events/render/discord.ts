import { sourceLabel } from "../../sources/labels.js";
import { eventEvidenceType, evidenceLabel, readerStanding } from "../confidence.js";
import { vendorOf } from "../interpretation.js";
import { displayTitle } from "../naming.js";
import type { Event, RecordData } from "../types.js";
import { DESCRIPTION_CHARACTERS } from "./budget.js";
import { type Fact, factText } from "./common.js";
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
function eventHeadline(event: Event, record: RecordData | null): string {
  const name = displayTitle(String(record?.name ?? event.entity_id), event.stream, event.source);
  if (event.stream === "deprecations" && event.kind === "new") return `⚠️ Action required · ${name}`;
  return `${KIND_ICONS[event.kind]} ${name}`;
}

/** What the observation means for someone deciding whether to care. */
function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "deprecations")
    return "Check the notice for the deadline and replacement before changing integrations.";
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  if (event.stream === "openrouter" && record?.selectable === true) return "Available to use from this catalogue.";
  if (event.stream === "openrouter" && record?.selectable === false)
    return "Listed in this catalogue, but not selectable yet.";
  // A first Arena sighting already says this in its own words; repeating it costs a line.
  if (event.stream === "arena" && event.kind !== "new")
    return record?.selectable === false
      ? "Visible on Arena, but not selectable yet."
      : "Visible and selectable on Arena.";
  if (event.kind === "removed") return "No longer present in this source's latest observation.";
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

/** "Arena · Arena roster · observed" names the arena twice; the evidence label that starts with the source says both. */
export function footerText(source: string | null, evidence: string, confidence: string): string {
  // A leaderboard's eyebrow is already its source's name.
  const label = source ? sourceLabel(source) : "";
  const said = !label || evidence.toLowerCase().startsWith(label.toLowerCase());
  const text = [...(said ? [] : [label]), evidence, confidence].join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Discord shows at most 25 fields; a card with more than this many is a table nobody reads. */
const MAX_FIELDS = 9;
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

export function eventEmbed(event: Event & CardContext, url: string, summary?: string): Record<string, unknown> {
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
  const facts = eventFactParts(event).filter(
    (fact) => factText(fact).toLowerCase() !== `maker: ${vendor.toLowerCase()}`,
  );
  const { lines, fields } = factLayout(facts);
  const impact = readerImpact(event, record);
  // How solid this is, before what it means: a reader decides whether to believe a card before
  // deciding whether to act on it. An arena entry other catalogues already list says so in its own
  // fact line; the generic "nobody has said what it is" beside it contradicted it.
  // A changed arena row says where it stands in its own impact sentence.
  const standing = event.stream === "arena" && (event.elsewhere?.length || impact) ? null : readerStanding(event);
  const rawName = String(record?.name ?? event.entity_id);
  const title = displayTitle(rawName, event.stream, event.source);
  // The name a reader copies into an API call, when the headline prettified it.
  const handle = rawName !== title && !/\s/.test(rawName) ? `\`${rawName}\`` : null;
  // One voice per line: the model's own summary, then how solid it is, then what it means, then the
  // evidence that is a sentence rather than a value.
  const description = [
    ...(handle ? [handle] : []),
    ...(summary ? [`*${summary}*`] : []),
    ...(standing ? [standing] : []),
    ...(impact ? [impact] : []),
    ...lines,
  ]
    .join("\n")
    .slice(0, DESCRIPTION_CHARACTERS);
  const evidenceType = eventEvidenceType(event);

  const sourceIcon = sourceLogo(event.source);
  const embed: Record<string, unknown> = {
    author: {
      name: [eyebrow(event), vendor === "Unknown" ? null : vendor.toUpperCase()].filter(Boolean).join(" · "),
      ...(sourceIcon ? { icon_url: sourceIcon } : {}),
    },
    title: eventHeadline(event, record).slice(0, 250),
    color: KIND_COLORS[event.kind],
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    // Discord renders its own timestamp in the reader's timezone, which is one line of card spent
    // on something the client already does.
    timestamp: new Date(event.detected_at).toISOString(),
    footer: {
      text: footerText(
        event.stream === "leaderboards" ? null : event.source,
        event.stream === "resets" ? "usage limit reset" : evidenceLabel(evidenceType),
        event.confidence ?? "observed",
      ),
    },
  };
  const thumbnail = vendorLogo(vendor);
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (link) embed.url = link;
  return embed;
}
