import { publishAlerts, recoverInterruptedAlerts } from "./alerts.js";
import { loadConfig } from "./config.js";
import { deliverPending, recoverInterruptedDeliveries } from "./delivery.js";
import { createHttpApp } from "./http.js";
import { rebuildHypotheses } from "./hypotheses.js";
import { rebuildLifecycleDeadlines, scheduleLifecycleReminders } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { rebuildModelFacts } from "./modelFacts.js";
import { pollSources } from "./poller.js";
import { pruneCodeMetrics } from "./runtime/metrics.js";
import { logMemoryUsage, recordRuntimeStart, recordRuntimeStop } from "./runtime/observability.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { buildSourceRegistry } from "./sources/registry.js";
import { BOARD_ORDER, publishBoard } from "./status.js";
import { openDatabase } from "./storage/database.js";
import { HttpCache } from "./storage/httpCache.js";
import { expireSnapshotBodies, pruneShadowCandidates, pruneSnapshots } from "./storage/retention.js";
import { rebuildStories, rememberStoryProjection } from "./stories.js";

const config = loadConfig();
configureLogger(config.NODE_ENV === "production");
const db = openDatabase(config.DATABASE_URL);
const storyProjection = db.transaction(() => {
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
supervisor.register(
  startIntervalWorker(db, "lifecycle", 300_000, () => {
    scheduleLifecycleReminders(db, config);
  }),
);
supervisor.register(startIntervalWorker(db, "delivery", 1500, () => deliverPending(db, config)));
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
        await publishBoard(db, config, board);
      } catch (error) {
        log("error", "Board probe failed", { board, error });
      }
    }
    try {
      await publishAlerts(db, config);
    } catch (error) {
      log("error", "Operational alert probe failed", { error });
    }
    pruneCodeMetrics(db);
    pruneSnapshots(db);
    expireSnapshotBodies(db);
    pruneShadowCandidates(
      db,
      buildSourceRegistry(db, config)
        .filter((source) => source.mode === "shadow")
        .map((source) => source.id),
    );
    // Cached bodies for files nobody links to any more; a rebuilt bundle renames everything.
    new HttpCache(db).prune();
  }),
);
supervisor.register(startIntervalWorker(db, "memory", 3_600_000, logMemoryUsage));
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
