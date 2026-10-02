import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { clearCredentialCircuit } from "../credentials.js";
import { listOperatorActions } from "../journal.js";
import { collectNamedSource, pollSources } from "../poller.js";
import { syncPublications } from "../publications.js";
import { sourceJobs } from "../sources/registry.js";
import { seedWeightTotals } from "../weights.js";
import { count, nearest, type OperationMap } from "./definition.js";

/** The "host" section of the operation registry; src/operations.ts joins the sections. */
export function hostOperations(db: Database, config: AppConfig, _all: () => OperationMap): OperationMap {
  return {
    sync_publications: {
      section: "host",
      summary: "Refresh the recent Solo Publisher archive without publishing or changing anything in Studio.",
      mutates: true,
      agent: false,
      schema: z.object({}),
      cli: {},
      handler: () => syncPublications(db, config),
    },
    "seed-weight-totals": {
      section: "host",
      summary: "Hold every parameter count of the established catalogue for the laboratory that published it.",
      note:
        "Run once after the ledger is created, and again only if it is rebuilt. Reads the public " +
        "catalogue; a count already held by an earlier publication is left alone.",
      mutates: true,
      agent: false,
      schema: z.object({}),
      cli: {},
      handler: () => seedWeightTotals(db),
    },
    clear_credential_circuit: {
      section: "host",
      summary: "Declare one refused credential replaced, so its sources are scheduled again.",
      note: "Rotate the credential and restart the service first; nothing here re-checks it.",
      mutates: true,
      // Credentials are the owner's, not an agent's.
      agent: false,
      schema: z.object({ capabilityId: z.string().min(1) }),
      cli: { args: [{ name: "capabilityId" }] },
      http: { method: "post", path: "/api/credentials/:capabilityId/clear" },
      handler: (input: { capabilityId: string }) => clearCredentialCircuit(db, input.capabilityId),
    },
    journal: {
      section: "host",
      summary: "Every mutation an operator has run, on whichever surface they ran it from.",
      startHere: "has somebody already settled this by hand",
      mutates: false,
      agent: true,
      schema: z.object({ operation: z.string().min(1).optional(), limit: count(200, 20) }),
      cli: { args: [{ name: "limit", optional: true }] },
      http: { method: "get", path: "/api/journal" },
      handler: (input: { operation?: string | undefined; limit: number }) => listOperatorActions(db, input),
    },
    collect: {
      section: "host",
      summary: "Collect one named source once, now, under the collection lock.",
      note:
        "`poll` forces all of them, which is two hundred requests to answer a question about one, " +
        "and a paced source can still lose the cycle's slot to a sibling on the same host. This " +
        "takes no slot. It still waits out a Retry-After the server set for itself, and answers " +
        "`unchanged` when upstream says the body has not moved -- which is not zero records.",
      mutates: true,
      // Collecting is a write to the source's state and a possible delivery, as `poll` is.
      agent: false,
      schema: z.object({ source: z.string().min(2) }),
      cli: { args: [{ name: "source" }] },
      handler: (input: { source: string }) => {
        const known = sourceJobs(db, config).map((job) => job.id);
        // The registry rather than the table: `sources` keeps a row for every source that ever ran,
        // and suggesting a retired one suggests a name that fails differently.
        if (!known.includes(input.source))
          throw new Error(`${input.source} is not a source this deployment collects. ${nearest(input.source, known)}`);
        return collectNamedSource(db, config, input.source);
      },
    },
    poll: {
      section: "host",
      summary: "Collect every due source once, in this process, under the collection lock.",
      note: "The running service polls on its own schedule; this is for a source being investigated.",
      mutates: true,
      // A collector run from an agent is a write to every source's state and a possible delivery.
      agent: false,
      schema: z.object({}),
      cli: {},
      handler: async () => {
        const outcome = await pollSources(db, config, true);
        return {
          ...outcome,
          message: outcome.collected
            ? `Collection cycle finished over ${outcome.sources} due source${outcome.sources === 1 ? "" : "s"}`
            : "Another collection cycle is running; nothing was collected",
        };
      },
    },
  };
}
