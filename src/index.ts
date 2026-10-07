import { dirname, join } from "node:path";
import { publishAlerts, recoverInterruptedAlerts } from "./alerts.js";
import { BOARD_ORDER } from "./boards/keys.js";
import { loadConfig } from "./config.js";
import { deliverPending, recoverInterruptedDeliveries } from "./delivery.js";
import { detectBreakouts } from "./events/breakouts.js";
import { detectCorroborated } from "./events/corroboration.js";
import { featureEnabled } from "./features.js";
import { createHttpApp } from "./http.js";
import { rebuildHypotheses } from "./hypotheses.js";
import { prepareInsights } from "./insights.js";
import { rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { rebuildModelFacts } from "./modelFacts.js";
import { pollSources, SOURCE_CYCLE_MS } from "./poller.js";
import { readReactionsAndPublish } from "./promotion.js";
import { syncPublications } from "./publications.js";
import { scheduleRecaps } from "./recapSchedule.js";
import { foldCodeMetricDays } from "./runtime/metricFold.js";
import { measure, pruneCodeMetrics } from "./runtime/metricRecording.js";
import { logMemoryUsage, recordRuntimeStart, recordRuntimeStop, sampleMemory } from "./runtime/observability.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { buildSourceRegistry, recordSourceIdentities } from "./sources/registry.js";
import { publishBoard } from "./status.js";
import { foldCollectionDays } from "./storage/collectionDays.js";
import { openDatabase } from "./storage/database.js";
import { HttpCache } from "./storage/httpCache.js";
import {
  expireSnapshotBodies,
  pruneFailureEvidence,
  pruneOperatorJournal,
  pruneReleaseRenders,
  pruneShadowCandidates,
  pruneSnapshots,
  pruneSourceCollectionMetrics,
  pruneSourceShapes,
  pruneSourceTraffic,
} from "./storage/retention.js";
import { writeTransaction } from "./storage/transaction.js";
import { rebuildStories, rememberStoryProjection } from "./stories.js";
import { readTelegramReactions } from "./telegramReactions.js";

const config = loadConfig();
// Logs live beside the database, on the volume that outlives the container.
configureLogger(config.NODE_ENV === "production", join(dirname(config.DATABASE_URL), "logs"));
const db = openDatabase(config.DATABASE_URL);
// Each phase of the load is timed and weighed on its own. A boot is the worst moment this process
// ever has, and RSS is never given back, so what a phase adds to the peak here is the floor the
// service stands on for the rest of its life. They run in sequence inside one transaction, which is
// what makes the numbers each phase's own: one mark, one process, and nothing overlapping to charge
// twice. Until this, every number about it came from one run of a script on a laptop.
const storyProjection = writeTransaction(db, () => {
  const retired = measure(db, "boot.source-identities", () =>
    recordSourceIdentities(db, buildSourceRegistry(db, config)),
  );
  if (retired.length) log("info", "Sources left the registry", { sources: retired });
  const projection = measure(db, "boot.stories", () => rebuildStories(db));
  measure(db, "boot.model-facts", () => rebuildModelFacts(db));
  measure(db, "boot.hypotheses", () => rebuildHypotheses(db));
  measure(db, "boot.lifecycle-deadlines", () => rebuildLifecycleDeadlines(db));
  return projection;
});
rememberStoryProjection(db, storyProjection);
recordRuntimeStart(db);
recoverInterruptedDeliveries(db);
recoverInterruptedAlerts(db);
const server = Bun.serve({ hostname: config.BIND_HOST, port: config.PORT, fetch: createHttpApp(config, db).fetch });
const supervisor = new RuntimeSupervisor();
if (featureEnabled(config, "publications-sync")) {
  supervisor.register(
    startIntervalWorker(db, "publications", 900_000, async () => {
      await syncPublications(db, config);
    }),
  );
}
supervisor.register(
  startIntervalWorker(db, "lifecycle", 300_000, async () => {
    scheduleLifecycleReminders(db, config);
    await scheduleRecaps(db, config);
    // Both detectors read stored evidence and speak on their own, so the switch is here: they take
    // the destinations rather than the config, and a reading nobody asked for is not worth running.
    if (featureEnabled(config, "breakouts")) detectBreakouts(db, config.destinations);
    if (featureEnabled(config, "corroboration")) detectCorroborated(db, config.destinations);
  }),
);
// Jev's judgements and DeepSeek's recap lines, read ahead of the morning messages that use them.
supervisor.register(
  startIntervalWorker(db, "insights", 300_000, async () => {
    await prepareInsights(db, config);
  }),
);
supervisor.register(startIntervalWorker(db, "delivery", 1500, () => deliverPending(db, config)));
// Hourly: the Telegram counts feed no decision, only the reports, and Telegram keeps what is unread
// for a day. Discord's are read every minute, because one of them is a door out of the channel.
supervisor.register(
  startIntervalWorker(db, "telegram-reactions", 3_600_000, async () => {
    // A busy hour is more than one page: read until Telegram has nothing left.
    for (let page = 0; page < 20 && (await readTelegramReactions(db, config)) === 100; page++);
  }),
);
supervisor.register(
  /**
   * A minute, because one pass does both halves of the wait and five minutes paid for each twice.
   *
   * The same pass offers the mark and reads it back, so a card sent at 18:13 on 2026-10-07 had no
   * publish mark under it until 18:25 and was carried at 18:30: twelve minutes before the owner had
   * anything to press, five more before the press was seen. Neither is the service refusing, and
   * from the outside both read as one.
   *
   * It is one request per Discord channel, and there are four of them. The cost of asking four
   * times a minute is not the reason this was ever five.
   */
  startIntervalWorker(db, "promotion", 60_000, async () => {
    // Said out loud because silence here reads as "it did not work": the owner presses the mark and
    // nothing moves until the next pass, and with the count dropped there was no way to tell a card
    // that was refused from one no pass had seen yet. Delivery 898 on 2026-10-07 cost a trip to the
    // database to learn it had travelled four minutes after the press, exactly as written.
    const promoted = await readReactionsAndPublish(db, config);
    if (promoted) log("info", "Cards promoted to the wire", { promoted });
  }),
);
supervisor.register(
  startIntervalWorker(db, "sources", SOURCE_CYCLE_MS, async () => {
    await pollSources(db, config);
  }),
);
supervisor.register(
  startIntervalWorker(db, "status", 300_000, async () => {
    // Order matters on a first run: the channel reads top to bottom, and one board that cannot be
    // sent must not stop the rest.
    for (const board of BOARD_ORDER) {
      try {
        await measure(db, `status.board:${board}`, () => publishBoard(db, config, board));
      } catch (error) {
        log("error", "Board probe failed", { board, error });
      }
    }
    try {
      await measure(db, "status.alerts", () => publishAlerts(db, config));
    } catch (error) {
      log("error", "Operational alert probe failed", { error });
    }
    // Each step is timed on its own: the cycle takes seconds and its total does not say which.
    // Folded before pruned: a day that has become one row is a day the ninety-day horizon can
    // afford to keep, and folding after deleting would fold what is left of a day half gone.
    measure(db, "status.fold:metric-days", () => foldCodeMetricDays(db));
    measure(db, "status.prune:metrics", () => pruneCodeMetrics(db));
    measure(db, "status.prune:snapshots", () => pruneSnapshots(db));
    // Folded before pruned, and in that order: the prune refuses to delete a day the fold has not
    // recorded, so a cycle that folds first is a cycle that can also shrink the raw table.
    measure(db, "status.fold:collection-days", () => foldCollectionDays(db));
    measure(db, "status.prune:collection-metrics", () => pruneSourceCollectionMetrics(db));
    measure(db, "status.prune:traffic", () => pruneSourceTraffic(db));
    measure(db, "status.prune:journal", () => pruneOperatorJournal(db));
    measure(db, "status.prune:failure-evidence", () => pruneFailureEvidence(db));
    measure(db, "status.prune:source-shapes", () => pruneSourceShapes(db));
    measure(db, "status.prune:release-renders", () => pruneReleaseRenders(db));
    measure(db, "status.prune:snapshot-bodies", () => expireSnapshotBodies(db));
    measure(db, "status.prune:shadow-candidates", () =>
      pruneShadowCandidates(
        db,
        buildSourceRegistry(db, config)
          .filter((source) => source.mode === "shadow")
          .map((source) => source.id),
      ),
    );
    // Cached bodies for files nobody links to any more; a rebuilt bundle renames everything.
    measure(db, "status.prune:http-cache", () => new HttpCache(db).prune());
    // Statistics decide whether the indexes get used at all: the planner ignored four of the five
    // added in migration 049 until ANALYZE ran. `optimize` re-analyses only what has moved enough
    // to matter, so this stays cheap while the tables it reads about keep growing.
    measure(db, "status.optimize", () => db.exec("PRAGMA optimize"));
  }),
);
supervisor.register(startIntervalWorker(db, "memory", 3_600_000, logMemoryUsage));
supervisor.register(startIntervalWorker(db, "memory-sample", 300_000, () => sampleMemory(db)));
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
  await stopServerGracefully(server);
  recordRuntimeStop(db);
  db.close();
  log("info", "Service stopped");
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
log("info", "Signal Forge started", { port: config.PORT, destinations: config.destinations.length });
