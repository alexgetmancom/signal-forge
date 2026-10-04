import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.js";
import { calibrationOperations } from "./operations/calibration.js";
import { databaseOperations } from "./operations/database.js";
import type { OperationMap } from "./operations/definition.js";
import { deliveryOperations } from "./operations/delivery.js";
import { evidenceOperations } from "./operations/evidence.js";
import { featureOperations } from "./operations/features.js";
import { healthOperations } from "./operations/health.js";
import { hostOperations } from "./operations/host.js";
import { judgeCalibrationOperations } from "./operations/judgeCalibration.js";
import { pointerOperations } from "./operations/pointers.js";
import { policyOperations } from "./operations/policy.js";
import { sourceProfileOperations } from "./operations/sourceProfile.js";
import { sourceSettlementOperations } from "./operations/sourceSettlement.js";
import { sourcesOperations } from "./operations/sources.js";
import { storageOperations } from "./operations/storage.js";
import { vendorTableOperations } from "./operations/vendorTable.js";
import { webEvidenceOperations } from "./operations/webEvidence.js";

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
    ...featureOperations(db, config),
    ...deliveryOperations(db, config, all),
    ...evidenceOperations(db, config, all),
    ...pointerOperations(db, config),
    ...sourceProfileOperations(db, config),
    ...storageOperations(db, config),
    ...webEvidenceOperations(db, config),
    ...sourceSettlementOperations(db, config),
    ...sourcesOperations(db, config, all),
    ...policyOperations(db, config),
    ...judgeCalibrationOperations(db, config),
    ...vendorTableOperations(db, config),
    ...calibrationOperations(db, config, all),
    ...databaseOperations(db, config, all),
    ...hostOperations(db, config, all),
  };
  return defs;
}
