import { z } from "zod";
import type { Fetch } from "../delivery.js";
import type { Collection } from "../events.js";
import { fetchText } from "./http.js";

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

const summary = z.object({
  status: z.object({ description: z.string().min(1), indicator: z.string().min(1) }),
  incidents: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: z.string().min(1),
        impact: z.string().min(1),
        shortlink: z.string().nullish(),
        started_at: z.string().nullish(),
        incident_updates: z.array(z.object({ body: z.string() })).default([]),
      }),
    )
    .default([]),
});

/**
 * `interval` is per platform because their bot protection differs: OpenAI's Statuspage tolerates a
 * five-minute poll, Anthropic's WAF started serving a CAPTCHA at that rate and is given room.
 */
export const PLATFORMS: { id: string; name: string; url: string; page: string; interval: number }[] = [
  {
    id: "openai",
    name: "OpenAI",
    url: "https://status.openai.com/api/v2/summary.json",
    page: "https://status.openai.com",
    interval: 300,
  },
  // The Anthropic host redirects to status.claude.com, which is a different origin and therefore
  // refused by the fetcher on purpose; the final address is used directly instead.
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://status.claude.com/api/v2/summary.json",
    page: "https://status.claude.com",
    interval: 900,
  },
];

export function parsePlatformStatus(payload: string, platform: (typeof PLATFORMS)[number]): Collection {
  const data = summary.parse(JSON.parse(payload));
  return {
    source: `status:${platform.id}`,
    stream: "incidents",
    url: platform.page,
    raw: { headline: data.status.description, indicator: data.status.indicator, incidents: data.incidents },
    // A resolved incident leaves the summary. That is the end of the incident, not a deletion of
    // it, and the closing update has already been reported as a change.
    appendOnly: true,
    trackChanges: true,
    records: data.incidents.map((incident) => ({
      id: incident.id,
      name: `${platform.name}: ${incident.name}`,
      url: incident.shortlink ?? platform.page,
      maker: platform.name,
      stage: incident.status,
      impact: incident.impact,
      started: incident.started_at ?? null,
      // Only the newest update: the history is on their page, and repeating it here would resend
      // the whole incident every time a line is appended.
      summary: incident.incident_updates[0]?.body.slice(0, 600) ?? null,
    })),
  };
}

export async function collectPlatformStatus(
  platform: (typeof PLATFORMS)[number],
  request: Fetch = fetch,
): Promise<Collection> {
  return parsePlatformStatus(await fetchText(platform.url, { accept: "application/json" }, request), platform);
}
