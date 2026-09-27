/**
 * What each source costs the process it runs in, and which of them should not be running in the
 * long-lived one.
 *
 * RSS is the high-water mark of the allocator and is never returned to the operating system -- not
 * by `Bun.gc(true)`, not after hours of idling, not with `--smol`. So the worst moment of a process
 * becomes its floor, and the floor is the sum of every claim any code path in it ever made. That is
 * the whole of this service's memory behaviour, and it means the useful number is not how much a
 * collector uses while it runs but how much it permanently adds to the mark the first time it runs.
 *
 * Measured 2026-09-27, all 188 light sources twice in one process: the first pass took the mark from
 * 71 MB to 658, the second pass added 29, and 171 of the 188 added nothing at all on it. Five
 * sources were 384 MB of the 587. They are marked `heavy` now, which collects them in a child
 * process that exits and takes its claim with it.
 *
 * This is the instrument that found them, kept as a command because the finding will drift: a new
 * long page, a vendor's sitemap that doubles, a feed that starts carrying whole posts. Anything this
 * reports above the threshold and not already marked is the next one.
 *
 *   bun run source-cost                 every light source
 *   bun run source-cost pages:          only those whose id starts with it
 *
 * Two things it cannot do, both learned the hard way. It runs one source at a time, because the
 * poller runs three light sources at once and a high-water mark that moved while three were running
 * cannot be attributed to one of them. And it runs each source in the same process as every other,
 * because a per-process harness charges every source the one-time warm-up of any library it happens
 * to touch first -- that harness reported `pages:google` at 316 MB where this one reports 192.
 *
 * It reads a private copy of production. It does collect from upstream, which is why it is a
 * development command and not an operation: 188 collectors in one process is the memory event this
 * exists to measure, and doing that inside the container would be doing it next to the service.
 */
import { copyFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { peakMb, WORTH_A_CHILD_MB } from "../src/runtime/peak.js";
import { buildSourceRegistry } from "../src/sources/registry.js";
import { openWithoutMigrating } from "../src/storage/database.js";
import { prodCopy } from "./prodCopy.js";

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

const prefix = Bun.argv.slice(2).find((value) => !value.startsWith("-")) ?? "";
const shared = await prodCopy(Bun.argv.includes("--fresh"), say);
if (shared === null) {
  say("Could not copy the database. Measuring against the stale local one would measure the wrong sources.");
  process.exit(1);
}
// A private copy, because a collector writes: the registry times every one of them into
// `code_metrics`, and the shared copy is opened readonly by `probe`.
const path = join(tmpdir(), `source-cost-${process.pid}.db`);
copyFileSync(shared, path);

const config = loadConfig();
const db = openWithoutMigrating(path);
try {
  const jobs = buildSourceRegistry(db, config).filter((job) => !job.heavy && job.id.startsWith(prefix));
  if (!jobs.length) {
    say(`No light source's id starts with ${JSON.stringify(prefix)}.`);
    process.exit(2);
  }
  const claimed = new Map<string, { first: number; second: number; records: number; failed: string | null }>();
  const start = peakMb();
  for (const pass of [1, 2] as const) {
    for (const job of jobs) {
      const before = peakMb();
      let records = 0;
      let failed: string | null = null;
      try {
        records = (await job.collector()).records.length;
      } catch (error) {
        failed = error instanceof Error ? error.message.slice(0, 80) : "unknown";
      }
      const claim = peakMb() - before;
      const seen = claimed.get(job.id);
      if (pass === 1) claimed.set(job.id, { first: claim, second: 0, records, failed });
      else if (seen) seen.second = claim;
    }
  }
  const rows = [...claimed]
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => right.first - left.first || right.second - left.second);
  console.table(
    rows.map((row) => ({
      source: row.id,
      "claim MB": row.first,
      "again MB": row.second,
      records: row.failed ? "-" : row.records,
      failed: row.failed ?? "",
    })),
  );
  const shouldBeHeavy = rows.filter((row) => row.first >= WORTH_A_CHILD_MB && !row.failed);
  console.log(
    JSON.stringify(
      {
        sources: rows.length,
        startPeakMb: start,
        endPeakMb: peakMb(),
        firstPassClaimMb: rows.reduce((total, row) => total + row.first, 0),
        secondPassClaimMb: rows.reduce((total, row) => total + row.second, 0),
        addedNothingOnSecondPass: rows.filter((row) => row.second <= 0).length,
        couldNotBeRead: rows.filter((row) => row.failed).length,
        worthAChild: shouldBeHeavy.map((row) => `${row.id} (${row.first} MB)`),
      },
      null,
      2,
    ),
  );
  if (shouldBeHeavy.length)
    say(
      `\n${shouldBeHeavy.length} source(s) claim ${WORTH_A_CHILD_MB} MB or more of a floor that is never given back. Mark them \`heavy\`: the poller collects a heavy source in a child process, and src/sources/subprocess.ts is what that costs.`,
    );
} finally {
  db.close();
  unlinkSync(path);
}
