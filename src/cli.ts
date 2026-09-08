import { loadConfig } from "./config.js";
import { operations } from "./operations.js";
import { pollSources } from "./poller.js";
import { openDatabase } from "./storage/database.js";

const config = loadConfig(),
  db = openDatabase(config.DATABASE_URL);
try {
  const command = Bun.argv[2] ?? "status",
    defs = operations(db, config);
  if (command === "poll") await pollSources(db, config, true);
  else if (command === "status") process.stdout.write(`${JSON.stringify(defs.status.handler(), null, 2)}\n`);
  else if (command === "event") {
    const input = defs.event.schema.parse({ id: Number(Bun.argv[3]) });
    process.stdout.write(`${JSON.stringify(defs.event.handler(input), null, 2)}\n`);
  } else if (command === "events" || command === "deliveries")
    process.stdout.write(`${JSON.stringify(defs[command].handler({ limit: 20 }), null, 2)}\n`);
  else throw new Error("Usage: bun src/cli.ts status|events|event <id>|deliveries|poll");
} finally {
  db.close();
}
