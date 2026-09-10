import { loadConfig } from "./config.js";
import { operations } from "./operations.js";
import { pollSources } from "./poller.js";
import { measure } from "./runtime/metrics.js";
import { openDatabase } from "./storage/database.js";

const config = loadConfig(),
  db = openDatabase(config.DATABASE_URL);
try {
  const command = Bun.argv[2] ?? "status",
    defs = operations(db, config);
  await measure(db, `cli.command:${command}`, async () => {
    if (command === "poll") await pollSources(db, config, true);
    else if (command === "status") process.stdout.write(`${JSON.stringify(defs.status.handler(), null, 2)}\n`);
    else if (command === "event") {
      const input = defs.event.schema.parse({ id: Number(Bun.argv[3]) });
      process.stdout.write(`${JSON.stringify(defs.event.handler(input), null, 2)}\n`);
    } else if (command === "events" || command === "deliveries")
      process.stdout.write(`${JSON.stringify(defs[command].handler({ limit: 20 }), null, 2)}\n`);
    else if (command === "issues" || command === "capabilities")
      process.stdout.write(`${JSON.stringify(defs[command].handler({}), null, 2)}\n`);
    else if (command === "signal-quality") {
      const input = defs.signal_quality.schema.parse({ days: Number(Bun.argv[3] ?? 7) });
      process.stdout.write(`${JSON.stringify(defs.signal_quality.handler(input), null, 2)}\n`);
    } else if (command === "code-analytics") {
      const input = defs.code_analytics.schema.parse({ days: Number(Bun.argv[3] ?? 7) });
      process.stdout.write(`${JSON.stringify(defs.code_analytics.handler(input), null, 2)}\n`);
    } else if (command === "deepseek-usage") {
      const input = defs.deepseek_usage.schema.parse({ days: Number(Bun.argv[3] ?? 7) });
      process.stdout.write(`${JSON.stringify(defs.deepseek_usage.handler(input), null, 2)}\n`);
    } else if (command === "stories")
      process.stdout.write(
        `${JSON.stringify(defs.stories.handler({ minConfidence: "observed", limit: 50 }), null, 2)}\n`,
      );
    else if (command === "models")
      process.stdout.write(`${JSON.stringify(defs.models.handler({ limit: 50 }), null, 2)}\n`);
    else if (command === "model") {
      const input = defs.model.schema.parse({ canonicalId: Bun.argv.slice(3).join("/") });
      process.stdout.write(`${JSON.stringify(defs.model.handler(input), null, 2)}\n`);
    } else if (command === "hypotheses")
      process.stdout.write(`${JSON.stringify(defs.hypotheses.handler({ limit: 50 }), null, 2)}\n`);
    else if (command === "hypothesis") {
      const input = defs.hypothesis.schema.parse({ id: Number(Bun.argv[3]) });
      process.stdout.write(`${JSON.stringify(defs.hypothesis.handler(input), null, 2)}\n`);
    } else if (command === "deadlines")
      process.stdout.write(`${JSON.stringify(defs.lifecycle_deadlines.handler({ days: 30 }), null, 2)}\n`);
    else if (command === "deliveries-needing-verification")
      process.stdout.write(`${JSON.stringify(defs.deliveries_needing_verification.handler({ limit: 20 }), null, 2)}\n`);
    else if (command === "require-delivery-verification") {
      const input = defs.require_delivery_verification.schema.parse({ id: Number(Bun.argv[3]) });
      process.stdout.write(`${JSON.stringify(defs.require_delivery_verification.handler(input), null, 2)}\n`);
    } else if (command === "resolve-delivery-verification") {
      const externalId = Bun.argv[5];
      const input = defs.resolve_delivery_verification.schema.parse({
        id: Number(Bun.argv[3]),
        outcome: Bun.argv[4],
        ...(externalId === undefined ? {} : { externalId }),
      });
      process.stdout.write(`${JSON.stringify(defs.resolve_delivery_verification.handler(input), null, 2)}\n`);
    } else
      throw new Error(
        "Usage: bun src/cli.ts status|events|event <id>|deliveries|deliveries-needing-verification|require-delivery-verification <id>|resolve-delivery-verification <id> <sent|failed> [external-id]|issues|capabilities|signal-quality [days]|code-analytics [days]|deepseek-usage [days]|stories|models|model <canonical-id>|hypotheses|hypothesis <id>|deadlines|poll",
      );
  });
} finally {
  db.close();
}
