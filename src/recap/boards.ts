import { boardPlace, DEBUT_PLACES, isMainBoard } from "../events/boardSignals.js";
import { readableName } from "../events/naming.js";
import type { RecordData } from "../events/types.js";
import { sourceLabel } from "../sources/labels.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

/** A climb this steep into the top ten is a model the experts will ask about; smaller moves are churn. */
const CLIMB_PLACES = 5;

/** "Arena text", "Artificial Analysis text-to-image", "DesignArena website": the board as said aloud. */
function boardName(source: string, category: unknown): string {
  const site = sourceLabel(source).split(" · ")[0] ?? source;
  const board = String(category ?? "")
    .split("/")
    .map((part) => (part === "quality" ? "Intelligence Index" : part))
    .filter((part) => part && part !== "overall" && part !== "artificial-analysis" && part !== "designarena")
    .join(" ");
  return board ? `${site} ${board}` : site;
}

/** What the scoreboards did overnight: big climbs, first scores, and boards that are new today. */
export function periodBoards(reading: PeriodReading): {
  climbers: RecapContext["climbers"];
  indexed: RecapContext["indexed"];
  newBoards: RecapContext["newBoards"];
} {
  const { db, classified, period } = reading;
  // Big climbs into the top ten and boards that did not exist yesterday: what the scouts' own
  // sightings do not show, told once a morning beside the new leaders.
  const climbers =
    period !== "day"
      ? []
      : classified
          .filter(({ event }) => event.stream === "leaderboards" && event.kind === "changed")
          .flatMap(({ event }) => {
            const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
            const after = recordOf(event);
            const from = Number(before?.rank);
            const to = Number(after?.rank);
            if (!isMainBoard(after?.category) || !Number.isInteger(from) || !Number.isInteger(to)) return [];
            if (to < 2 || to > DEBUT_PLACES || from - to < CLIMB_PLACES) return [];
            return [{ board: boardName(event.source, after?.category), name: readableName(nameOf(event)), from, to }];
          })
          .sort((one, other) => other.from - other.to - (one.from - one.to))
          .filter((climb, index, all) => all.findIndex((other) => other.name === climb.name) === index)
          .slice(0, 5);
  // Every model Artificial Analysis scored for the first time, wherever it landed: a debut card
  // already told the top ten, and the rest is still the first independent reading of a new model.
  const indexed =
    period !== "day"
      ? []
      : classified
          .filter(({ event }) => event.source === "artificial-analysis" && event.kind === "new")
          .flatMap(({ event }) => {
            const record = recordOf(event);
            const score = record?.score as Record<string, unknown> | undefined;
            const index = score?.artificial_analysis_intelligence_index;
            if (typeof index !== "number") return [];
            return [{ name: readableName(nameOf(event)), index, place: boardPlace(event) }];
          })
          .sort((one, other) => other.index - one.index)
          .slice(0, 5);
  const newBoards: RecapContext["newBoards"] = [];
  if (period === "day") {
    // A board is new when every row it has arrived inside the day. Asking whether any event named it
    // before is not the same question: a board read since the first collection and never moved has
    // no events at all.
    const byBoard = new Map<string, { source: string; category: string; leader: string | null; arrived: number }>();
    for (const { event } of classified) {
      if (event.stream !== "leaderboards" || event.kind !== "new") continue;
      const record = recordOf(event);
      const category = String(record?.category ?? "");
      const key = `${event.source}\u0000${category}`;
      const board = byBoard.get(key) ?? { source: event.source, category, leader: null, arrived: 0 };
      board.arrived++;
      if (boardPlace(event) === 1) board.leader = readableName(nameOf(event));
      byBoard.set(key, board);
    }
    for (const board of byBoard.values()) {
      const rows =
        db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) n FROM records WHERE source=? AND json_extract(body,'$.category')=?",
          )
          .get(board.source, board.category)?.n ?? 0;
      if (board.arrived >= rows && board.arrived >= 3)
        newBoards.push({ board: boardName(board.source, board.category), leader: board.leader });
    }
  }
  return { climbers, indexed, newBoards };
}
