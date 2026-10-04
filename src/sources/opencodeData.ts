/**
 * The canonical model catalogue behind OpenCode's data pages.
 *
 * Measured 2026-10-04: its 406 KB carries all 416 followed models from 32 pages totalling 4.25 MB,
 * with the same ids, names and page slugs. The pages' model entries come from this catalogue too,
 * so probing them separately cannot find another entry. Full metadata stays in the snapshot.
 * Reading dates from objects also stops an undated model borrowing the next model's release date.
 *
 * This reads what OpenCode lists, and a model nobody has listed is not its question. The three
 * stealth slugs this used to probe by hand -- `/data/unknown/space-bunny` and two that now answer
 * 404 -- are gone with that, because the catalogue has never carried a single entry under the
 * `unknown` lab, and the page that still answers 200 answers `entry:null`, which the probe read as
 * a miss too. An unannounced name reaches us from the sources that publish one rather than from a
 * guess at an address: `openrouter` had `stealth/space-bunny-alpha` the same day, and so did
 * `models-dev`, `opencode-zen`, `opencode-go`, `voxelbench` and `openrouter-usage`.
 */
import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import { vendorOfName } from "../events/vendors.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

export const OPENCODE_MODELS_URL = "https://models.opencode.ai/models.json";
const catalogueSchema = z
  .record(
    z.string(),
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9.-]*\/\S+$/),
      name: z.string().min(1),
      release_date: z.string().nullish(),
    }),
  )
  .refine((models) => Object.keys(models).length > 0, "OpenCode catalogue has no models")
  .refine((models) => Object.entries(models).every(([id, model]) => id === model.id), "OpenCode model ids disagree");

export async function collectOpenCodeData(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const text = await fetchText(OPENCODE_MODELS_URL, { accept: "application/json" }, request, undefined, cache);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SourceError("schema", "OpenCode canonical catalogue is not JSON");
  }
  const catalogue = catalogueSchema.parse(raw);
  const records: RecordData[] = [];
  for (const model of Object.values(catalogue)) {
    const [lab = "", ...parts] = model.id.split("/");
    // This is the slug function the site applies to a canonical id, not its stats alias lookup.
    const slug = parts
      .join("/")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // A lab this repository does not follow: OpenCode names 44 of them, most of a single model.
    if (vendorOfName(lab) === "Unknown") continue;
    records.push({
      id: model.id,
      name: model.name,
      url: `https://opencode.ai/data/${lab}/${slug}`,
      maker: lab === "unknown" ? null : lab,
      source: "opencode-data",
      ...(model.release_date ? { created: model.release_date } : {}),
    });
  }
  if (!records.length) throw new SourceError("empty", "OpenCode catalogue has no followed models");
  return {
    source: "discovery:opencode-data",
    stream: "api-models",
    url: OPENCODE_MODELS_URL,
    raw,
    records,
  };
}
