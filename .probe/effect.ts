import type { Database } from "bun:sqlite";
import { isTellableDebut } from "../src/events/boardSignals.js";
import { anotherEffortLeadsThisDebut, followsAnOldLaunch } from "../src/events/debutAge.js";
import type { Event } from "../src/events/types.js";

export default function ({ db }: { db: Database }) {
  const rows = db
    .query<Event, []>(`SELECT * FROM events WHERE stream='leaderboards' AND kind='new' AND detected_at > '2026-09-19'`)
    .all();
  const cards = rows
    .filter((e) => isTellableDebut(e) && !followsAnOldLaunch(db, e) && !anotherEffortLeadsThisDebut(db, e))
    .map((e) => {
      const r = JSON.parse(e.after_json ?? "{}") as { name?: string; rank?: number; category?: string };
      return `${e.detected_at.slice(5, 16)} ${r.category} #${r.rank ?? "-"} ${r.name}`;
    })
    .sort();
  return { cards: cards.length, perDay: +(cards.length / 14).toFixed(2), list: cards };
}
