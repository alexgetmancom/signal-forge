import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { fetchText } from "./http.js";
import type { Vendor } from "./vendors.js";

/**
 * Platform health. Unlike everything else here this is not about what a vendor released — it is
 * about whether their API answers at all, which is the one thing a reader may need to know within
 * minutes rather than hours.
 *
 * Only vendors that actually run Statuspage are here. `status.x.ai` refuses its own API with 403 and
 * renders the page in the browser, and Google publishes a different document shape for the whole
 * cloud; both would need their own parser rather than another entry in this list.
 *
 * Statuspage exposes both halves in one document: a headline for the board, and the open incidents,
 * which are the events. Only the incidents flow through the pipeline; the headline is read off the
 * stored snapshot so a flapping description cannot manufacture news.
 */

const incident = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  impact: z.string().min(1),
  shortlink: z.string().nullish(),
  started_at: z.string().nullish(),
  resolved_at: z.string().nullish(),
  incident_updates: z.array(z.object({ body: z.string() })).default([]),
  components: z.array(z.object({ name: z.string() })).default([]),
});

const summary = z.object({
  status: z.object({ description: z.string().min(1), indicator: z.string().min(1) }),
  components: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: z.string().min(1),
        group: z.boolean().default(false),
        group_id: z.string().nullish(),
      }),
    )
    .default([]),
  incidents: z.array(incident).default([]),
});

const history = z.object({ incidents: z.array(incident).default([]) });

/**
 * How long after a vendor closes an incident its closing is still collected.
 *
 * The summary lists open incidents only, so an end is an absence: two consecutive polls without the
 * row turn into an `unlisted` change, and the card is amended with our own wording rather than the
 * vendor's. Anthropic resolved `ch27pb90bn85` at 12:43 UTC on 2026-10-06 and the amendment landed at
 * 13:10, twenty-nine minutes later, still carrying "we are working on a fix" as the newest update.
 * `/api/v2/incidents.json` carries the same incident with `status: resolved` and the sentence that
 * closed it, at the first poll after it happened. A day is long enough for the slowest interval here
 * (900s) and short enough that the first collection does not import a quarter of the page's history.
 */
const CLOSING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `interval` is per platform because their bot protection differs: OpenAI's Statuspage tolerates a
 * five-minute poll, Anthropic's WAF started serving a CAPTCHA at that rate and is given room.
 */
/**
 * `name` is a `Vendor` rather than a string because it is the maker a status source answers for, and
 * the registry only allows the spellings in src/sources/vendors.ts. It is also printed into an
 * incident's title, which is why one field serves both.
 */
/**
 * The components a reader of this board is actually on a plan for, by Statuspage's stable id rather
 * than by name, because a page renames a component without telling anybody and a name match would
 * then silently watch nothing. A vendor-wide headline says nothing about which of these is down:
 * OpenAI's "Partial System Degradation" has meant Images alone, and `Claude Code` was operational
 * through an incident on `claude.ai`.
 */
export const PLATFORMS: {
  id: string;
  name: Vendor;
  url: string;
  page: string;
  interval: number;
  watch: string[];
}[] = [
  {
    id: "openai",
    name: "OpenAI",
    url: "https://status.openai.com/api/v2/summary.json",
    page: "https://status.openai.com",
    interval: 300,
    // Codex Web, Codex API and the CLI have their own components, but only in
    // `/api/v2/components.json`: the summary omits them. This is the part of Codex the summary has.
    watch: [
      "01KMKFAMWKQ81YWSE1Z18R6VHR", // Codex in ChatGPT Desktop
      "01JP8CD9JR3HR6Y7G4Q75N4DVW", // Responses
      "01JMXBRMFE6N2NNT7DG6XZQ6PW", // Chat Completions
    ],
  },
  // `status.claude.com` answers every client with a CloudFront 405 challenge since 2026-09-17 01:30
  // UTC, from production and from elsewhere alike. The Statuspage origin behind it serves the same
  // page (`tymt9n04zgry`, "Claude") without the challenge, the way DeepSeek's does below.
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://anthropic.statuspage.io/api/v2/summary.json",
    page: "https://status.claude.com",
    interval: 900,
    watch: [
      "yyzkbfz2thpt", // Claude Code
      "k8w3r06qmzrp", // Claude API (api.anthropic.com)
      "rwppv331jlwc", // claude.ai
    ],
  },
  // DeepSeek's public page is custom-hosted, but its machine-readable Statuspage summary remains
  // available on the original host. The payload links back to the official public page.
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://deepseek.statuspage.io/api/v2/summary.json",
    page: "https://status.deepseek.com",
    interval: 900,
    watch: ["j4n367d9mh3x"], // API Service
  },
  {
    id: "moonshot",
    name: "Moonshot",
    url: "https://status.moonshot.cn/api/v2/summary.json",
    page: "https://status.moonshot.cn",
    interval: 900,
    // Moonshot publishes no component named for Kimi's coding plan; these are the API behind it.
    watch: [
      "rf64wcbxt3r2", // API Service
      "8psr5dfdld0s", // Open API
      "x0zsqgy57b75", // Model
    ],
  },
];

/** The incidents this page closed recently, newest first, excluding any the summary still lists. */
function closedRecently(
  payload: string | null,
  open: z.infer<typeof incident>[],
  now: number,
): z.infer<typeof incident>[] {
  if (!payload) return [];
  const listed = new Set(open.map((one) => one.id));
  return history
    .parse(JSON.parse(payload))
    .incidents.filter(
      (one) =>
        !listed.has(one.id) &&
        typeof one.resolved_at === "string" &&
        Number.isFinite(Date.parse(one.resolved_at)) &&
        now - Date.parse(one.resolved_at) <= CLOSING_WINDOW_MS,
    );
}

export function parsePlatformStatus(
  payload: string,
  platform: (typeof PLATFORMS)[number],
  closed: string | null = null,
  now: number = Date.now(),
): Collection {
  const data = summary.parse(JSON.parse(payload));
  const groups = new Map(data.components.filter((c) => c.group).map((c) => [c.id, c.name]));
  // Ordered by the registry rather than by the page, so a component moving in their document does
  // not reorder the board, and so a watched id the page has dropped is absent instead of unknown.
  const watched = platform.watch.flatMap((id) => {
    const component = data.components.find((candidate) => candidate.id === id);
    return component
      ? [
          {
            id: component.id,
            name: component.name,
            status: component.status,
            group: component.group_id ? (groups.get(component.group_id) ?? null) : null,
          },
        ]
      : [];
  });
  return {
    source: `status:${platform.id}`,
    stream: "incidents",
    url: platform.page,
    raw: {
      headline: data.status.description,
      indicator: data.status.indicator,
      components: watched,
      incidents: data.incidents,
      // Whether the closing endpoint answered this time, so a page that starts refusing it is
      // visible in the snapshot instead of looking like a page that simply closes nothing.
      closingsRead: closed !== null,
    },
    // A resolved incident can leave the summary. Two successful omissions turn it into an explicit
    // resolved change, keeping the incident evidence without treating recovery as deletion.
    trackChanges: true,
    resolveMissing: true,
    records: [...data.incidents, ...closedRecently(closed, data.incidents, now)].map((incident) => ({
      id: incident.id,
      name: `${platform.name}: ${incident.name}`,
      url: incident.shortlink ?? platform.page,
      maker: platform.name,
      stage: incident.status,
      impact: incident.impact,
      started: incident.started_at ?? null,
      // What broke, as the page names it: "claude.ai", "Claude API", "Codex". An outage of the API
      // alone is nothing a reader on a $20 plan feels.
      components: incident.components.map((component) => component.name),
      // Only the newest update: the history is on their page, and repeating it here would resend
      // the whole incident every time a line is appended.
      summary: incident.incident_updates[0]?.body.slice(0, 600) ?? null,
    })),
  };
}

/** The same page's incident history, which is the only document that spells out a resolution. */
export function closingsUrl(platform: (typeof PLATFORMS)[number]): string {
  return platform.url.replace(/summary\.json$/, "incidents.json");
}

export async function collectPlatformStatus(
  platform: (typeof PLATFORMS)[number],
  request: Fetch = fetch,
): Promise<Collection> {
  const [open, closed] = await Promise.all([
    fetchText(platform.url, { accept: "application/json" }, request),
    // A page that refuses its history still has an outage to report, and that is the urgent half.
    // The cost of losing this document is a slower end, which is what the summary already gives.
    fetchText(closingsUrl(platform), { accept: "application/json" }, request).catch(() => null),
  ]);
  return parsePlatformStatus(open, platform, closed);
}
