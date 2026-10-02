import { readableName } from "../events/naming.js";
import { recordFor } from "../events/record.js";
import { parseRecord } from "../events/recordBody.js";
import { vendorOfName, vendorRank } from "../events/vendors.js";
import { nameOf, type PeriodReading } from "./reading.js";
import type { RecapContext } from "./schema.js";

/** A board changing hands at the top is the one ranking move a reader repeats to somebody else. */
export function periodLeaders(reading: PeriodReading): RecapContext["leaders"] {
  const { classified } = reading;
  const leaders = classified
    .filter(({ event }) => event.stream === "leaderboards" && event.kind === "changed")
    .flatMap(({ event }) => {
      const before = parseRecord(event.before_json);
      const after = recordFor(event);
      // A board that starts counting places is not a model taking first: the Intelligence Index gained
      // ranks on 2026-09-20, and every row's first place would otherwise read as a new leader.
      if (Number(after?.rank) !== 1 || !Number.isInteger(Number(before?.rank)) || Number(before?.rank) === 1) return [];
      return [{ board: String(after?.category ?? event.source), name: readableName(nameOf(event)) }];
    })
    .filter((leader, index, all) => all.findIndex((other) => other.board === leader.board) === index)
    // The three makers a reader of this feed pays for are read first, here as everywhere a ranking
    // is listed; the boards keep the order they came in behind them.
    .sort((one, other) => vendorRank(vendorOfName(one.name)) - vendorRank(vendorOfName(other.name)))
    .slice(0, 5);
  return leaders;
}
