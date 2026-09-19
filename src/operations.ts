import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import type { OperationMap } from "./operations/definition.js";
import { deliveryOperations } from "./operations/delivery.js";
import { evidenceOperations } from "./operations/evidence.js";
import { healthOperations } from "./operations/health.js";
import { hostOperations } from "./operations/host.js";
import { sourcesOperations } from "./operations/sources.js";

export { callOperation, cliCommand, type OperationMap, operationCatalog } from "./operations/definition.js";

/**
 * The operation registry. Each section lives in its own file under src/operations/; this only joins
 * them, in the guide's section order. The contract every entry follows, and
 * why every surface is a projection of it, is written in src/operations/definition.ts.
 */
export function operations(db: Database, config: AppConfig): OperationMap {
  const all = (): OperationMap => defs;
  const defs: OperationMap = {
    ...healthOperations(db, config, all),
    ...deliveryOperations(db, config, all),
    ...evidenceOperations(db, config, all),
    ...sourcesOperations(db, config, all),
    ...hostOperations(db, config, all),
  };
  return defs;
}
