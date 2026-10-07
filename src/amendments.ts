import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { incidentEnded } from "./events/incidents.js";
import { borrowedFacts } from "./events/priceWorth.js";
import { type Fact, prices } from "./events/render/common.js";
import { CAPTION_LIMIT, clipHtml, TEXT_LIMIT, telegramMessage, visibleLength } from "./events/render/telegramCard.js";
import { stealthSubject } from "./events/resellers.js";
import type { Event } from "./events/types.js";
import type { Fetch } from "./http-client.js";
import { log } from "./logger.js";
import { sourceLabel } from "./sources/labels.js";

/**
 * Cards that change after they were sent, edited where the reader already saw them.
 *
 * The wire carries the start of a major outage and nothing after it, because a second message for
 * the end is a second interruption for news the reader discovers by using the service. Discord edits
 * notify nobody, so the card that said "it is broken" can say "it is fixed" at no cost to anyone's
 * attention. OpenAI's `01M2KQNE5C42NEZPX6V01NHH5W` on 2026-09-15 is the shape: started, identified,
 * monitoring and resolved inside an hour, and a reader who saw the start never learned the rest.
 */
const LOOKBACK_MS = 3 * 24 * 3_600_000;
/** A Telegram post older than a day has scrolled away; editing it would only surprise whoever scrolls back. */
const TELEGRAM_EDIT_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const RESOLVED_COLOUR = 0x2ecc71;

/** Queues an edit for every single-card message that announced an incident which has now ended. */
export function queueIncidentAmendments(db: Database, now = Date.now()): number {
  const endings = db
    .query<Event, [string]>(
      `SELECT e.* FROM events e WHERE e.stream='incidents' AND e.kind IN ('changed','removed') AND e.detected_at>=?
         AND NOT EXISTS (SELECT 1 FROM card_amendments a WHERE a.event_id=e.id)`,
    )
    .all(new Date(now - LOOKBACK_MS).toISOString())
    .filter(incidentEnded);
  let queued = 0;
  for (const ending of endings) {
    // Only a message carrying this one event: editing a digest would rewrite cards about other things.
    const cards = db
      .query<{ id: number }, [string, string, string]>(
        `SELECT d.id FROM deliveries d
         JOIN delivery_events de ON de.delivery_id=d.id JOIN events start ON start.id=de.event_id
         WHERE start.source=? AND start.entity_id=? AND start.kind='new' AND d.status='sent'
           AND d.external_id IS NOT NULL
           AND (json_extract(d.destination_json,'$.platform')='discord'
             OR (json_extract(d.destination_json,'$.platform')='telegram' AND d.updated_at>=?))
           AND (SELECT COUNT(*) FROM delivery_events other WHERE other.delivery_id=d.id)=1`,
      )
      .all(ending.source, ending.entity_id, new Date(now - TELEGRAM_EDIT_MS).toISOString());
    for (const card of cards)
      queued += db
        .query("INSERT OR IGNORE INTO card_amendments(event_id,delivery_id,updated_at) VALUES(?,?,?)")
        .run(ending.id, card.id, new Date(now).toISOString()).changes;
  }
  return queued;
}

/**
 * How long after a launch a price is still worth adding to the card that went without one.
 *
 * The window is the news cycle of the launch itself, not of the price. A rate that turns up three
 * days later is a price change and has a card of its own; a rate that turns up within the day is
 * the number the launch card was missing, arriving late.
 */
const PRICE_WINDOW_MS = 24 * 3_600_000;

/**
 * Launch cards that went out without a price, for models that have one now.
 *
 * The maker ships the model and prices it on a different page, read by a different source on its
 * own clock, so the two do not arrive together and on the evidence they never will: on 2026-10-07
 * Anthropic's API answered Claude Haiku 5.5 at 17:51 and the first price anywhere appeared at
 * 18:13. Holding the card back until a price exists would trade the lead this tracker is for
 * against a number that is not news; sending a second card would interrupt a reader twice for one
 * launch. A Discord edit notifies nobody, so the card a reader already has can simply gain the
 * line.
 *
 * Only a card about one thing, as with an incident: editing a digest would rewrite entries about
 * other models. Only a card that carries no price already -- the point is the blank, not the rate.
 */
export function queuePriceAmendments(db: Database, now = Date.now()): number {
  const candidates = db
    .query<{ event_id: number; delivery_id: number }, [string]>(
      `SELECT de.event_id AS event_id, d.id AS delivery_id
       FROM deliveries d
       JOIN delivery_events de ON de.delivery_id=d.id
       JOIN events e ON e.id=de.event_id
       WHERE e.kind='new' AND e.detected_at>=? AND d.status='sent' AND d.external_id IS NOT NULL
         AND json_extract(d.destination_json,'$.platform')='discord'
         AND d.body NOT LIKE '%$%'
         AND NOT EXISTS (SELECT 1 FROM card_amendments a WHERE a.delivery_id=d.id)
         AND (SELECT COUNT(*) FROM delivery_events other WHERE other.delivery_id=d.id)=1
       ORDER BY de.event_id`,
    )
    .all(new Date(now - PRICE_WINDOW_MS).toISOString());
  let queued = 0;
  for (const candidate of candidates) {
    const event = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(candidate.event_id);
    if (!event) continue;
    const borrowed = borrowedFacts(db, event, stealthSubject(event));
    if (!priceLine(borrowed)) continue;
    queued += db
      .query("INSERT OR IGNORE INTO card_amendments(event_id,delivery_id,kind,updated_at) VALUES(?,?,'priced',?)")
      .run(candidate.event_id, candidate.delivery_id, new Date(now).toISOString()).changes;
  }
  return queued;
}

/** The borrowed sheet as the one line a card has room for, or nothing when it holds no rate. */
function priceLine(borrowed: Record<string, unknown>): string | null {
  const found = prices(null, borrowed.pricing, String(borrowed.pricingSource ?? "")).find(
    (fact): fact is Exclude<Fact, string> => typeof fact !== "string" && fact.label === "Price",
  );
  return found ? found.value : null;
}

/**
 * The card with the price it was sent without, and nothing else touched.
 *
 * A field rather than a chip on the picture: the banner is drawn at send time and travels as an
 * upload, so putting the rate there would mean re-drawing and re-uploading an image to say one
 * number. The field sits under the description where the window already is.
 */
function pricedCard(body: string, line: string, source: string): Record<string, unknown> | null {
  const payload = JSON.parse(body) as { content?: string; embeds?: Record<string, unknown>[] };
  const embed = payload.embeds?.[0];
  if (!embed || payload.embeds?.length !== 1) return null;
  const fields = Array.isArray(embed.fields) ? (embed.fields as Record<string, unknown>[]) : [];
  // Twice is worse than not at all: an amendment that ran against a card already carrying the rate
  // would stack a second Price field under the first.
  if (fields.some((field) => String(field.name ?? "") === "Price")) return null;
  return {
    content: payload.content ?? "",
    embeds: [
      {
        ...embed,
        // Named, as a borrowed rate is wherever one is printed: a second catalogue's number is not
        // the maker's unless the maker is who it came from.
        fields: [...fields, { name: "Price", value: `${line} · ${sourceLabel(source)}`.slice(0, 1024), inline: false }],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** "40 min", "5 h 12 min", "2 d 3 h": how long it was broken, as a reader would say it. */
export function outageLength(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

/** Updates that say nothing about the outage itself: the page's closing formula, our own note. */
const BOILERPLATE = /^(?:this incident has been resolved\.?|incident no longer listed by the status page\.?)$/i;

type Ending = { startedAt: string; endedAt: string; lastWord: string | null };

/**
 * When it started and ended, and the vendor's last sentence that said something. The card that went
 * out said "we are investigating"; a reader looking at it afterwards wants how long it lasted and
 * what came of it, not the first guess.
 */
function endingOf(db: Database, eventId: number): Ending | null {
  const ending = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(eventId);
  if (!ending) return null;
  const history = db
    .query<{ after_json: string | null; detected_at: string; kind: string }, [string, string, number]>(
      "SELECT after_json,detected_at,kind FROM events WHERE source=? AND entity_id=? AND id<=? ORDER BY id",
    )
    .all(ending.source, ending.entity_id, ending.id);
  const records = history.map((row) => (row.after_json ? (JSON.parse(row.after_json) as Record<string, unknown>) : {}));
  const started = records.map((record) => record.started).find((value) => typeof value === "string") as
    | string
    | undefined;
  const lastWord =
    records
      .map((record) => (typeof record.summary === "string" ? record.summary.trim() : ""))
      .filter((summary) => summary && !BOILERPLATE.test(summary))
      .at(-1) ?? null;
  return {
    startedAt: started ?? history.find((row) => row.kind === "new")?.detected_at ?? ending.detected_at,
    endedAt: ending.detected_at,
    lastWord,
  };
}

/**
 * The card rewritten for the end: fixed, after how long, in the vendor's last words. Nothing it
 * says pings, and the rest of the card -- logo, link, footer -- stays as it was sent.
 */
function resolvedCard(body: string, ending: Ending): Record<string, unknown> | null {
  const payload = JSON.parse(body) as { content?: string; embeds?: Record<string, unknown>[] };
  const embed = payload.embeds?.[0];
  if (!embed || payload.embeds?.length !== 1) return null;
  const title = String(embed.title ?? "").replace(/^\S+\s/, "");
  const lasted = outageLength(Date.parse(ending.endedAt) - Date.parse(ending.startedAt));
  const description = [`Working again after ${lasted}.`, ending.lastWord ? `\n${ending.lastWord}` : ""].join("");
  return {
    content: payload.content ?? "",
    embeds: [
      {
        ...embed,
        title: `✅ Fixed · ${title}`.slice(0, 250),
        color: RESOLVED_COLOUR,
        description: description.slice(0, 4096),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

type Edit = { url: string; headers: Record<string, string>; method: string; body: unknown };

/** Telegram edits text and captions with different calls, and a post is one or the other. */
function telegramEdits(config: AppConfig, chatId: string, messageId: string, original: string, card: string): Edit[] {
  const base = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
  const html = telegramMessage(card).html;
  const text = visibleLength(html) > TEXT_LIMIT ? clipHtml(html) : html;
  const common = { chat_id: chatId, message_id: Number(messageId), parse_mode: "HTML" };
  const headers = { "content-type": "application/json" };
  const asText: Edit = {
    url: `${base}/editMessageText`,
    method: "POST",
    headers,
    body: { ...common, text, link_preview_options: { is_disabled: true } },
  };
  const asCaption: Edit = {
    url: `${base}/editMessageCaption`,
    method: "POST",
    headers,
    body: { ...common, caption: text },
  };
  // The way it was sent: a card with a picture and a caption that fit went out as a photo.
  const sent = telegramMessage(original);
  const wasPhoto =
    Boolean(sent.photo) && visibleLength(sent.html) <= CAPTION_LIMIT && visibleLength(text) <= CAPTION_LIMIT;
  return wasPhoto ? [asCaption, asText] : [asText, asCaption];
}

/** An incident card rewritten for the end it has now reached. */
function resolved(db: Database, amendment: { event_id: number; body: string }): Record<string, unknown> | null {
  const ending = endingOf(db, amendment.event_id);
  return ending ? resolvedCard(amendment.body, ending) : null;
}

/**
 * A launch card given the rate that arrived after it.
 *
 * Read again here rather than carried from the queue: an amendment waits its turn and is retried,
 * and the sheet it was queued on may have moved by the time the edit goes out. The card should say
 * what is true when it is written, not what was true when it was noticed.
 */
function repriced(db: Database, amendment: { event_id: number; body: string }): Record<string, unknown> | null {
  const event = db.query<Event, [number]>("SELECT * FROM events WHERE id=?").get(amendment.event_id);
  if (!event) return null;
  const borrowed = borrowedFacts(db, event, stealthSubject(event));
  const line = priceLine(borrowed);
  return line ? pricedCard(amendment.body, line, String(borrowed.pricingSource ?? "")) : null;
}

export async function applyCardAmendments(db: Database, config: AppConfig, request: Fetch = fetch): Promise<void> {
  const pending = db
    .query<
      {
        event_id: number;
        delivery_id: number;
        attempts: number;
        body: string;
        external_id: string;
        platform: string;
        channel: string | null;
        chat: string | number | null;
        kind: string;
      },
      [number]
    >(
      `SELECT a.event_id,a.delivery_id,a.attempts,a.kind,d.body,d.external_id,
         json_extract(d.destination_json,'$.platform') AS platform,
         json_extract(d.destination_json,'$.channelId') AS channel,
         json_extract(d.destination_json,'$.chatId') AS chat
       FROM card_amendments a JOIN deliveries d ON d.id=a.delivery_id
       WHERE a.status='pending' AND a.attempts<? ORDER BY a.event_id LIMIT 5`,
    )
    .all(MAX_ATTEMPTS);
  for (const amendment of pending) {
    const telegram = amendment.platform === "telegram";
    if (telegram ? !config.TELEGRAM_BOT_TOKEN : !config.DISCORD_BOT_TOKEN) continue;
    const card = amendment.kind === "priced" ? repriced(db, amendment) : resolved(db, amendment);
    let status: "pending" | "edited" | "failed" = "failed";
    if (card) {
      const edits: Edit[] = telegram
        ? telegramEdits(config, String(amendment.chat), amendment.external_id, amendment.body, JSON.stringify(card))
        : [
            {
              url: `https://discord.com/api/v10/channels/${amendment.channel}/messages/${amendment.external_id}`,
              method: "PATCH",
              headers: { "content-type": "application/json", Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
              body: card,
            },
          ];
      try {
        for (const edit of edits) {
          const response = await request(edit.url, {
            method: edit.method,
            headers: edit.headers,
            body: JSON.stringify(edit.body),
            signal: AbortSignal.timeout(20_000),
            redirect: "error",
          });
          const said = telegram
            ? String(((await response.json().catch(() => null)) as { description?: string } | null)?.description ?? "")
            : "";
          if (!telegram) await response.body?.cancel();
          // An edit is idempotent, so a failure short of a refusal is simply tried again later.
          if (response.ok) {
            status = "edited";
            break;
          }
          // Telegram says so when the post is the other kind, or when it already reads this way.
          if (telegram && /message is not modified/i.test(said)) {
            status = "edited";
            break;
          }
          if (telegram && response.status === 400 && /no text|no caption|there is no/i.test(said)) continue;
          status = response.status === 404 || response.status === 403 || response.status === 400 ? "failed" : "pending";
          break;
        }
      } catch {
        status = "pending";
      }
    }
    db.query(
      "UPDATE card_amendments SET status=?,attempts=attempts+1,updated_at=? WHERE event_id=? AND delivery_id=?",
    ).run(status, new Date().toISOString(), amendment.event_id, amendment.delivery_id);
    log(status === "edited" ? "info" : "warn", "Card amendment settled", {
      deliveryId: amendment.delivery_id,
      status,
    });
  }
}
