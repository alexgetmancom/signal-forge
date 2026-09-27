/**
 * What each read costs the process that answers it, and which of them should not be answered in the
 * long-lived one.
 *
 * `source-cost` asks this of collectors. Nothing asked it of reads, and reads turned out to be the
 * larger half: measured 2026-09-27, asking all 42 read operations once took the mark of one process
 * from 79 MB to 658. `news` alone claimed 225 MB to answer with 11 KB, because the story list it
 * called read 27.6 MB of event bodies to keep seven fields of each.
 *
 * The number that matters is the same one `source-cost` reports and for the same reason: RSS is the
 * high-water mark of the allocator and is never returned, so the worst moment of a process becomes
 * its floor. A read answered by `bun run prod <command>` costs nothing lasting -- that is a process
 * that exits -- but the same read over HTTP or MCP is answered inside the service and raises its
 * floor for as long as it lives. That is the measurement here.
 *
 *   bun run read-cost              every read that needs no argument
 *   bun run read-cost news         only those whose name contains it
 *
 * It runs each read twice: the first claim includes whatever the code path warms up once, the second
 * is what every later ask adds again. A read whose second claim keeps growing is the one to look at
 * first, whatever its first number.
 *
 * Operations that mutate are skipped, as are those that need an argument -- `event`, `model`,
 * `preview` and the rest are only meaningful about something in particular, and the reports they
 * share the cost with are all here. It reads a private copy of production, because `verify` writes
 * on first ask.
 */
import { copyFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { operations } from "../src/operations.js";
import { peakMb } from "../src/runtime/peak.js";
import { openWithoutMigrating } from "../src/storage/database.js";
import { prodCopy } from "./prodCopy.js";

/** Above this, a read is worth answering somewhere that ends. `source-cost` uses the same figure. */
const WORTH_A_CHILD_MB = 32;

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

const filter = Bun.argv.slice(2).find((value) => !value.startsWith("-")) ?? "";
const shared = await prodCopy(Bun.argv.includes("--fresh"), say);
if (shared === null) {
  say("Could not copy the database. Measuring against the stale local one would measure the wrong reads.");
  process.exit(1);
}
const path = join(tmpdir(), `read-cost-${process.pid}.db`);
copyFileSync(shared, path);

const db = openWithoutMigrating(path);
try {
  const asked = new Map<string, { first: number; second: number; ms: number; bytes: number; failed: string | null }>();
  const all = operations(db, loadConfig());
  const start = peakMb();
  for (const pass of [1, 2] as const) {
    for (const [name, definition] of Object.entries(all)) {
      if (definition.mutates || !name.includes(filter)) continue;
      let input: unknown;
      try {
        input = definition.schema.parse({});
      } catch {
        continue;
      }
      const before = peakMb();
      const started = Bun.nanoseconds();
      let bytes = 0;
      let failed: string | null = null;
      try {
        bytes = JSON.stringify(await (definition.handler as (value: unknown) => unknown)(input))?.length ?? 0;
      } catch (error) {
        failed = error instanceof Error ? error.message.slice(0, 60) : "unknown";
      }
      const claim = peakMb() - before;
      const ms = Math.round((Bun.nanoseconds() - started) / 1e6);
      const seen = asked.get(name);
      if (pass === 1) asked.set(name, { first: claim, second: 0, ms, bytes, failed });
      else if (seen) seen.second = claim;
    }
  }
  const rows = [...asked]
    .map(([name, value]) => ({ name, ...value }))
    .sort((left, right) => right.first - left.first || right.second - left.second);
  console.table(
    rows.map((row) => ({
      read: row.name,
      "claim MB": row.first,
      "again MB": row.second,
      ms: row.ms,
      "answer KB": Math.round(row.bytes / 102.4) / 10,
      failed: row.failed ?? "",
    })),
  );
  const tooBig = rows.filter((row) => row.first >= WORTH_A_CHILD_MB && !row.failed);
  console.log(
    JSON.stringify(
      {
        reads: rows.length,
        startPeakMb: start,
        endPeakMb: peakMb(),
        firstPassClaimMb: rows.reduce((total, row) => total + row.first, 0),
        secondPassClaimMb: rows.reduce((total, row) => total + row.second, 0),
        addedNothingOnSecondPass: rows.filter((row) => row.second <= 0).length,
        couldNotBeAsked: rows.filter((row) => row.failed).length,
        worthAChild: tooBig.map((row) => `${row.name} (${row.first} MB)`),
      },
      null,
      2,
    ),
  );
  if (tooBig.length)
    say(
      `\n${tooBig.length} read(s) claim ${WORTH_A_CHILD_MB} MB or more of a floor that is never given back. Either the read holds less -- ask SQL for what the answer keeps, not for the rows it was derived from -- or it is answered in a process that ends, as src/sources/subprocess.ts does for a heavy collector.`,
    );
} finally {
  db.close();
  unlinkSync(path);
}
