import type { Event } from "../events/types.js";
import { vendorOf } from "../events/vendors.js";
import { isNewsworthyStory, worthCutoffs } from "../insights.js";
import { judgementOf } from "../jev.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

/**
 * The labs' own newsrooms and sites, whose posts are the day's official news. Not Hacker News,
 * which is other people talking about it, not a help centre, and not a source still on trial in
 * shadow: NVIDIA's blog was removed once as marketing and has to earn its way back in.
 */
const NEWS_DESKS = new Set([
  "openai-news",
  "anthropic-news",
  "claude-blog",
  "google-ai-blog",
  "gemini-models-blog",
  "gemini-app-blog",
  "deepmind-blog",
  "pages:openai",
  "pages:anthropic",
  "pages:xai",
  "pages:deepmind",
  "pages:google-devs",
  "pages:mistral",
  "pages:zai",
]);
export const HEADLINES = 10;
/**
 * Lines one maker may take in one section before the rest are counted. OpenAI filed eight misuse
 * reports on 2026-09-17, each on its newsroom and again on its site: sixteen lines about one
 * afternoon would be the whole message.
 */
const PER_MAKER = 2;
/** The sections of the day's news, in the order they are read. Business is kept and never sent. */
const TOPICS = { safety: "safety", research: "research", article: "other" } as const;

// The day's news in three sections: what went wrong or could, what was found, and what else the
// labs said. Hacker News is read for the first two only: other people's safety and research
// stories are news, other people's opinions are not.
export function periodHeadlines(reading: PeriodReading): RecapContext["headlines"] {
  const { db, classified, carded, period, to } = reading;
  const headlines: RecapContext["headlines"] = [];
  if (period === "news") {
    // A front-page story no pattern placed is still read when Jev judged it about a model, a product
    // or a risk: "Alibaba open-sources a model that detects 150 conditions" was nobody's on 2026-09-19.
    // Read once: the cutoff is a property of the period, not of each story in it.
    const storyCutoff = worthCutoffs(db, new Date(to)).story;
    const told = (event: Event, signal: string) =>
      signal === "article"
        ? NEWS_DESKS.has(event.source) ||
          (event.source === "hackernews" && isNewsworthyStory(judgementOf(db, event.id), storyCutoff))
        : NEWS_DESKS.has(event.source) || event.source === "hackernews";
    // A lab's own feed first, its site second, the front page last: the same post is often on all three.
    const order = (source: string) => (source === "hackernews" ? 2 : source.startsWith("pages:") ? 1 : 0);
    for (const [signal, topic] of Object.entries(TOPICS) as [
      keyof typeof TOPICS,
      (typeof TOPICS)[keyof typeof TOPICS],
    ][]) {
      const lines = classified
        .filter(
          ({ event, signal: seen }) =>
            seen === signal && event.kind === "new" && told(event, signal) && !carded.has(event.id),
        )
        .sort((one, other) => order(one.event.source) - order(other.event.source) || one.event.id - other.event.id)
        .map(({ event }) => {
          const record = recordOf(event);
          // Site pages are titled "OpenAI: Detecting wildfires early"; the vendor is the line's own label.
          const title = nameOf(event).replace(/^[^:]{1,40}:\s+/, "");
          // A front-page story is somebody else's; when it names no maker, the line says where it was read.
          const vendor = vendorOf(event, record);
          return {
            vendor: vendor === "Unknown" && event.source === "hackernews" ? "Hacker News" : vendor,
            desk: event.source !== "hackernews",
            title,
            url: typeof record?.url === "string" ? record.url : null,
            summary:
              topic === "other"
                ? null
                : (db.query<{ text: string }, [number]>("SELECT text FROM summaries WHERE event_id=?").get(event.id)
                    ?.text ?? null),
          };
        })
        .filter((line, index, all) => all.findIndex((other) => other.title === line.title) === index);
      const shown = new Map<string, RecapContext["headlines"][number]>();
      const count = new Map<string, number>();
      for (const line of lines) {
        const held = count.get(line.vendor) ?? 0;
        count.set(line.vendor, held + 1);
        if (held < PER_MAKER) {
          const entry = { ...line, topic, more: 0 };
          headlines.push(entry);
          shown.set(line.vendor, entry);
        } else {
          const last = shown.get(line.vendor);
          if (last) last.more++;
        }
      }
    }
  }
  return headlines;
}
