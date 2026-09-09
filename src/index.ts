import { publishAlerts } from "./alerts.js";
import { loadConfig } from "./config.js";
import { deliverPending, recoverInterruptedDeliveries } from "./delivery.js";
import { createHttpApp } from "./http.js";
import { configureLogger, log } from "./logger.js";
import { pollSources } from "./poller.js";
import { logMemoryUsage, recordRuntimeStart, recordRuntimeStop } from "./runtime/observability.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { publishActivityBoard, publishPlatformBoard, publishStatus } from "./status.js";
import { openDatabase } from "./storage/database.js";
import { HttpCache } from "./storage/httpCache.js";
import { rebuildStories, rememberStoryProjection } from "./stories.js";

const config = loadConfig();
configureLogger(config.NODE_ENV === "production");
const db = openDatabase(config.DATABASE_URL);
const storyProjection = db.transaction(() => rebuildStories(db))();
rememberStoryProjection(db, storyProjection);
recordRuntimeStart(db);
recoverInterruptedDeliveries(db);
const server = Bun.serve({ hostname: config.BIND_HOST, port: config.PORT, fetch: createHttpApp(config, db).fetch });
const supervisor = new RuntimeSupervisor();
supervisor.register(startIntervalWorker(db, "delivery", 1500, () => deliverPending(db, config)));
supervisor.register(startIntervalWorker(db, "sources", 30_000, () => pollSources(db, config)));
supervisor.register(
  startIntervalWorker(db, "status", 300_000, async () => {
    // Order matters on a first run: the channel reads top to bottom, so what happened comes first,
    // then how the vendors are doing, then how we are doing.
    await publishActivityBoard(db, config);
    await publishPlatformBoard(db, config);
    await publishStatus(db, config);
    await publishAlerts(db, config);
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
