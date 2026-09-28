import type { Confidence, Event, EvidenceType, SourceAuthority } from "./types.js";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["observed", "supported", "confirmed"];

export const SOURCE_AUTHORITIES: readonly SourceAuthority[] = ["first_party", "vendor_owned", "third_party"];

const evidenceLabels: Record<EvidenceType, string> = {
  api_catalogue: "API catalogue",
  availability_catalogue: "availability catalogue",
  official_news: "official news",
  arena_roster: "Arena roster",
  leaderboard: "leaderboard",
  web_diff: "web diff",
  github_activity: "GitHub activity",
  package_release: "package release",
  open_weights: "open weights registry",
  status_page: "status page",
  deprecation: "deprecation notice",
  unknown: "unknown evidence",
};

/**
 * The evidence type of an event.
 *
 * Every stored event has carried one since the column was added, and the poller now takes it from
 * the source's registry entry rather than re-deriving it from the id. An event assembled in memory
 * without one claims the least, which is what `unknown` means here and everywhere else: no evidence
 * type fits, so no sentence is put in the source's mouth.
 */
export function eventEvidenceType(event: Event): EvidenceType {
  return event.evidence_type ?? "unknown";
}

export function evidenceLabel(type: EvidenceType): string {
  return evidenceLabels[type];
}

/** Where a confidence label sits on the `observed` -> `confirmed` scale. */
export function confidenceRank(value: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(value);
}

/**
 * How solid this is, in the words someone who does not work here would use.
 *
 * `observed`, `supported` and `confirmed` are accurate and mean nothing to a reader:
 * the difference between a rumour and a fact was carried in a footer that read
 * "Evidence: arena roster · Confidence: observed". The sentence is keyed on the evidence type
 * because that is a source contract rather than a judgement, and it never claims more than the
 * source proves — a reseller's catalogue is not the vendor saying so.
 */
const standings: Record<EvidenceType, string> = {
  api_catalogue: "Listed in the provider's own API.",
  availability_catalogue: "Seen in a reseller's catalogue.",
  official_news: "The maker announced this themselves.",
  arena_roster: "Spotted on a public arena.",
  leaderboard: "Reported by a public leaderboard.",
  web_diff: "On the maker's own site.",
  github_activity: "From the project's repository. Work in progress, not a release.",
  package_release: "Published to the registry. You can install it now.",
  open_weights: "Published to an open-weights registry. The files are downloadable.",
  status_page: "From the provider's own status page.",
  deprecation: "From the provider's own retirement notice.",
  unknown: "",
};

const fallback: Record<Confidence, string> = {
  observed: "Seen by one source, unconfirmed.",
  supported: "Backed by the maker's own words.",
  confirmed: "Confirmed by the provider directly.",
};

/**
 * How long ago the maker said it, in the words a reader would use.
 *
 * A sighting of something already announced is the card's most useful fact and the one it used to
 * get backwards, so it is said first and in days rather than as a timestamp.
 */
function announcedAgo(at: string, detectedAt: string): string {
  const days = Math.floor((Date.parse(detectedAt) - Date.parse(at)) / 86_400_000);
  if (days >= 2) return `The maker announced this ${days} days ago.`;
  if (days === 1) return "The maker announced this yesterday.";
  return "The maker has already announced this.";
}

/**
 * One sentence about how much weight the observation carries, or null when it adds nothing.
 *
 * Discord cards only. The Telegram renderer's line offsets are read back by `needsSummary`, so an
 * extra line there would quietly move the summarisation threshold for every event, and no Telegram
 * destination is configured to benefit from it.
 *
 * These sentences say what the evidence type proves and stop there. Three of them used to append a
 * claim about the rest of the world -- "Not announced yet", "not announced by the maker", "Nobody
 * has said what it is yet" -- which no source here establishes and which this service cannot
 * establish either, since it has only been collecting since 2026-09-08. On 2026-09-25 that put
 * "On the maker's own site. Not announced yet." under OpenAI's GPT-5.6 Cyber docs page, 45 days
 * after the press release, the X post and the trade coverage. The negative is gone; the positive
 * is said whenever `announced` carries an announcement this database actually holds.
 */
export function readerStanding(event: Event & { announced?: { at: string } }): string | null {
  // A reset is the one observation here whose weight differs record by record: most are a post by
  // the OpenAI staff member who announces them, and some were only noticed happening. The record
  // says which, so the sentence is read from the record rather than from the stream.
  if (event.stream === "resets") {
    const record = event.after_json ?? event.before_json;
    const announcement = record ? (JSON.parse(record) as { announcement?: unknown }).announcement : null;
    return typeof announcement === "string" && announcement.startsWith("Posted")
      ? "Announced by the OpenAI staff member who announces these, via a third-party tracker."
      : "Noticed by a third-party tracker with no announcement behind it.";
  }
  const type = eventEvidenceType(event);
  const sentence = standings[type] || fallback[event.confidence ?? "observed"];
  const announced = event.announced ? announcedAgo(event.announced.at, event.detected_at) : null;
  return [sentence, announced].filter(Boolean).join(" ") || null;
}
