import { readableName } from "../events/naming.js";
import type { RecordData } from "../events/types.js";
import { nameOf, type PeriodReading, recordOf } from "./reading.js";
import type { RecapContext } from "./schema.js";

/** A board changing hands at the top is the one ranking move a reader repeats to somebody else. */
export function periodLeaders(reading: PeriodReading): RecapContext["leaders"] {
  const { classified } = reading;
  const leaders = classified
    .filter(({ event }) => event.stream === "leaderboards" && event.kind === "changed")
    .flatMap(({ event }) => {
      const before = event.before_json ? (JSON.parse(event.before_json) as RecordData) : null;
      const after = recordOf(event);
      // A board that starts counting places is not a model taking first: the Intelligence Index gained
      // ranks on 2026-09-20, and every row's first place would otherwise read as a new leader.
      if (Number(after?.rank) !== 1 || !Number.isInteger(Number(before?.rank)) || Number(before?.rank) === 1) return [];
      return [{ board: String(after?.category ?? event.source), name: readableName(nameOf(event)) }];
    })
    .filter((leader, index, all) => all.findIndex((other) => other.board === leader.board) === index)
    .slice(0, 5);
  return leaders;
}
