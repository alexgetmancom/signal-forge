import { publishAlerts } from "./alerts.js";
import { loadConfig } from "./config.js";
import { deliverPending, recoverInterruptedDeliveries } from "./delivery.js";
import { createHttpApp } from "./http.js";
import { configureLogger, log } from "./logger.js";
import { pollSources } from "./poller.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { publishStatus } from "./status.js";
import { openDatabase } from "./storage/database.js";
import { HttpCache } from "./storage/httpCache.js";

const config = loadConfig();
configureLogger(config.NODE_ENV === "production");
const db = openDatabase(config.DATABASE_URL);
recoverInterruptedDeliveries(db);
const server = Bun.serve({ hostname: config.BIND_HOST, port: config.PORT, fetch: createHttpApp(config, db).fetch });
const supervisor = new RuntimeSupervisor();
supervisor.register(startIntervalWorker("delivery", 1500, () => deliverPending(db, config)));
supervisor.register(startIntervalWorker("sources", 30_000, () => pollSources(db, config)));
supervisor.register(
  startIntervalWorker("status", 300_000, async () => {
    await publishStatus(db, config);
    await publishAlerts(db, config);
    // Cached bodies for files nobody links to any more; a rebuilt bundle renames everything.
    new HttpCache(db).prune();
  }),
);
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
  await stopServerGracefully(server);
  db.close();
  log("info", "Service stopped");
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
log("info", "Signal Forge started", { port: config.PORT, destinations: config.destinations.length });
