import { dirname, join } from "node:path";
import { publishAlerts, recoverInterruptedAlerts } from "./alerts.js";
import { loadConfig } from "./config.js";
import { deliverPending, recoverInterruptedDeliveries } from "./delivery.js";
import { detectBreakouts } from "./events/breakouts.js";
import { detectCorroborated } from "./events/corroboration.js";
import { createHttpApp } from "./http.js";
import { rebuildHypotheses } from "./hypotheses.js";
import { prepareInsights } from "./insights.js";
import { rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { rebuildModelFacts } from "./modelFacts.js";
import { pollSources } from "./poller.js";
import { promoteVouchedMessages } from "./promotion.js";
import { syncPublications } from "./publications.js";
import { scheduleRecaps } from "./recap.js";
import { measure, pruneCodeMetrics } from "./runtime/metrics.js";
import { logMemoryUsage, recordRuntimeStart, recordRuntimeStop, sampleMemory } from "./runtime/observability.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { buildSourceRegistry, recordSourceIdentities } from "./sources/registry.js";
import { BOARD_ORDER, publishBoard } from "./status.js";
import { openDatabase } from "./storage/database.js";
import { HttpCache } from "./storage/httpCache.js";
import {
  expireSnapshotBodies,
  pruneFailureEvidence,
  pruneOperatorJournal,
  pruneShadowCandidates,
  pruneSnapshots,
  pruneSourceCollectionMetrics,
} from "./storage/retention.js";
import { rebuildStories, rememberStoryProjection } from "./stories.js";
import { readTelegramReactions } from "./telegramReactions.js";

const config = loadConfig();
// Logs live beside the database, on the volume that outlives the container.
configureLogger(config.NODE_ENV === "production", join(dirname(config.DATABASE_URL), "logs"));
const db = openDatabase(config.DATABASE_URL);
const storyProjection = db.transaction(() => {
  recordSourceIdentities(db, buildSourceRegistry(db, config));
  const projection = rebuildStories(db);
  rebuildModelFacts(db);
  rebuildHypotheses(db);
  rebuildLifecycleDeadlines(db);
  return projection;
})();
rememberStoryProjection(db, storyProjection);
recordRuntimeStart(db);
recoverInterruptedDeliveries(db);
recoverInterruptedAlerts(db);
const server = Bun.serve({ hostname: config.BIND_HOST, port: config.PORT, fetch: createHttpApp(config, db).fetch });
const supervisor = new RuntimeSupervisor();
if (config.SOLO_PUBLISHER_MCP_URL) {
  supervisor.register(
    startIntervalWorker(db, "publications", 900_000, async () => {
      await syncPublications(db, config);
    }),
  );
}
supervisor.register(
  startIntervalWorker(db, "lifecycle", 300_000, () => {
    scheduleLifecycleReminders(db, config);
    scheduleRecaps(db, config);
    detectBreakouts(db, config.destinations);
    detectCorroborated(db, config.destinations);
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
// for a day. Discord's are read every five minutes because the scouts' votes promote a card.
supervisor.register(
  startIntervalWorker(db, "telegram-reactions", 3_600_000, async () => {
    // A busy hour is more than one page: read until Telegram has nothing left.
    for (let page = 0; page < 20 && (await readTelegramReactions(db, config)) === 100; page++);
  }),
);
supervisor.register(
  startIntervalWorker(db, "promotion", 300_000, async () => {
    await promoteVouchedMessages(db, config);
  }),
);
supervisor.register(
  startIntervalWorker(db, "sources", 30_000, async () => {
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
    measure(db, "status.prune:metrics", () => pruneCodeMetrics(db));
    measure(db, "status.prune:snapshots", () => pruneSnapshots(db));
    measure(db, "status.prune:collection-metrics", () => pruneSourceCollectionMetrics(db));
    measure(db, "status.prune:journal", () => pruneOperatorJournal(db));
    measure(db, "status.prune:failure-evidence", () => pruneFailureEvidence(db));
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
