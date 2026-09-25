/**
 * The line a reader decides on, and the meaning printed under it.
 *
 * A card is opened or skipped on its title, so each stream gets the one sentence that is news in
 * that stream: a debut is its place, a package is its version, a sighting in code is that nobody
 * has announced it. The eyebrow above and the impact below are the same judgement at two other
 * sizes, which is why they are one module. Moved out of discord.ts unchanged.
 */
import { sourceLabel } from "../../sources/labels.js";
import { readableName } from "../naming.js";
import { boardPlace, DEBUT_PLACES, scoredDebutIndex } from "../signals.js";
import type { Event, RecordData } from "../types.js";
import { excerpt, pageName, place } from "./words.js";

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
  training: "TRAINING RUN",
};

/** Streams where a new row is a model someone can use or download, told in its maker's colour. */
export const MODEL_STREAMS = new Set(["api-models", "openrouter", "weights"]);

const KIND_ICONS: Record<Event["kind"], string> = { new: "🆕", changed: "✏️", removed: "🗑️" };

export function eyebrow(event: Event): string {
  if (event.source === "codex-docs") return "DOCUMENTATION";
  if (event.stream === "leaderboards") return sourceLabel(event.source).toUpperCase();
  return EYEBROWS[event.stream] ?? "UPDATE";
}

/**
 * The name of the thing, with an icon for what happened to it. The eyebrow above already names the
 * kind of surface and the first line of the body says what it means, so a card that also spells
 * out "Model availability updated" spends a reader's attention on grammar rather than on the name.
 */
/**
 * A reseller row from a maker we do not track reaches a reader as its bare product name: Vercel's
 * `fish-audio/s1` and `fish-audio/s2-pro` went out on 2026-09-18 as "S1" and "S2 Pro", which say
 * nothing about what moved. The row names its maker, so the title does.
 */
export function withUntrackedMaker(name: string, vendor: string, record: RecordData | null): string {
  if (vendor !== "Unknown") return name;
  const maker = typeof record?.maker === "string" ? record.maker.trim() : "";
  if (!maker) return name;
  const readable = /[A-Z]/.test(maker)
    ? maker
    : maker
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  return name.toLowerCase().includes(readable.toLowerCase()) ? name : `${readable} ${name}`;
}

/** A model ID seen in a watched repository's code, commits, issues or pull requests. */
export function mentionSighting(event: Event): boolean {
  return event.stream === "github" && /^github:.+:(?:models|talk)$/.test(event.source);
}

/**
 * What a model ID in a repository means, said plainly. "gpt-6-luna served" over "From the
 * project's repository. Work in progress, not a release. Repository activity is not a release.
 * served" reached the scouts on 2026-09-21 and the owner could not tell what had happened: a
 * backend had answered as `gpt-6-luna`, an unannounced model.
 */
export function mentionSentence(record: RecordData): string {
  const line = typeof record.line === "string" && record.line.trim() ? `> ${excerpt(record.line.trim(), 200)}` : null;
  const lead =
    record.stage === "served" ? "Not in any catalogue yet." : "Not in any catalogue, not seen answering yet.";
  // The quote is the evidence; the commit title under it was grey text the size of the sentence,
  // since Discord draws no small print inside an embed, and the title links to the commit anyway.
  return [lead, line].filter(Boolean).join("\n");
}

export function eventHeadline(event: Event, name: string, incident: Incident | null): string {
  if (event.stream === "deprecations" && event.kind === "new") return `⚠️ ${name} is being retired`;
  if (incident) return `${incident.icon} ${incident.icon === "🟢" ? "Resolved · " : ""}${name}`;
  if (mentionSighting(event)) {
    const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const model = typeof record?.model === "string" ? record.model : name;
    // The handle is the evidence and the card prints it underneath, quoted from the file it was
    // read in; the headline is where a reader decides whether to keep reading, and `minimax-m3.1`
    // is not how anyone says it.
    const spoken = readableName(model);
    if (record?.stage === "served") return `📡 ${spoken} is answering requests`;
    if (event.kind === "new") return `🔎 ${spoken} named in code`;
  }
  if (event.stream === "arena" && event.kind === "new") return `🆕 ${name} appears on Arena`;
  // A page names itself "Pricing" or "Overview", which is a heading, not a headline: whose pricing
  // is the news, and it was left to the footer four lines down.
  if (event.stream === "web" && event.kind === "changed") {
    const site = place(event.source);
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!plain(name).includes(plain(site))) return `${KIND_ICONS[event.kind]} ${site} · ${name}`;
  }
  // A docs page for a model nobody sells yet: the page is the sighting, not a new model.
  if (event.stream === "pages" && event.kind === "new") return `📄 New page: ${pageName(name)}`;
  if (event.stream === "training") {
    const record = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    const maker = typeof record?.maker === "string" ? `${record.maker} ` : "";
    if (record?.ended) return `🏁 ${maker}finished training ${name}`;
    if (event.kind === "new") return `🧪 ${maker}is training ${name}`;
  }
  // A debut is read for one number, the place, so the title says it before the reader opens the card.
  if (event.stream === "leaderboards" && event.kind === "new") {
    const place = boardPlace(event);
    if (place !== null && place <= DEBUT_PLACES) return `🏆 ${name} debuts at #${place}`;
    // Below the ranked places there is no place to report, so the card leads on the measurement,
    // which is the only reason the arrival is being told at all.
    const index = scoredDebutIndex(event);
    if (index !== null) return `🧠 ${name} enters at ${index} on the Intelligence Index`;
  }
  // A release is its name and version; "Released on npm." under "🆕 codex@latest" was the title again.
  const release = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
  const version = typeof release?.version === "string" ? release.version : null;
  if (event.stream === "packages" && event.kind !== "removed" && version)
    return `📦 ${name.replace(/@[^@/]+$/, "")} ${version} on ${place(event.source)}`;
  if (event.stream === "apps" && event.kind !== "removed" && version) return `📱 ${name} ${version}`;
  if (event.stream === "resets") {
    const reset = event.after_json ? (JSON.parse(event.after_json) as RecordData) : null;
    // Confirmed: the tracker moved it into its history once the announcer said it had propagated.
    if (reset?.stage === "Applied")
      return reset.resetType === "banked"
        ? "💳 A free Codex reset is banked for everyone"
        : "🎉 Codex limits are back — for everyone";
    return `⏳ ${name.replace(/ usage limits /, " limits ")}`;
  }
  return `${KIND_ICONS[event.kind]} ${name}`;
}

/** Early signs of a model, read on the scouts channel, and outages: each card is about one maker. */
export const SIGHTINGS = new Set([
  "github",
  "pages",
  "arena",
  "training",
  "incidents",
  "packages",
  "apps",
  "web",
  "resets",
]);

/** What the observation means for someone deciding whether to care. */
export function readerImpact(event: Event, record: RecordData | null): string | null {
  if (event.stream === "github" && !event.source.endsWith(":releases")) return "Repository activity is not a release.";
  if (event.stream === "training")
    return record?.ended
      ? "The training run is over, which is the step before a release. Nothing is announced yet."
      : "A training run in public, before any release or announcement.";
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

type Incident = { icon: string; color: number };

/** An outage is read by its severity first: a red card for a major one, green once it is over. */
export function incidentLook(event: Event, record: RecordData | null): Incident | null {
  if (event.stream !== "incidents") return null;
  const stage = String(record?.stage ?? "").toLowerCase();
  const impact = String(record?.impact ?? "").toLowerCase();
  if (event.kind === "removed" || ["resolved", "unlisted", "postmortem", "completed"].includes(stage))
    return { icon: "🟢", color: 0x2ecc71 };
  if (["critical", "major"].includes(impact)) return { icon: "🔴", color: 0xe74c3c };
  if (impact === "minor") return { icon: "🟠", color: 0xe67e22 };
  return { icon: "🟡", color: 0xf1c40f };
}
