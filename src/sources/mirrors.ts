import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Which directory a vendor publishes its own catalogue in. The entry exists to answer one
 * question -- did the vendor list this model itself -- so a family absent from this table makes
 * no claim rather than a guessed one.
 */
const VENDOR_PROVIDER: readonly (readonly [RegExp, string])[] = [
  [/^claude-/, "anthropic"],
  [/^gpt-|^o[134]-/, "openai"],
  [/^gemini-/, "google"],
  [/^grok-/, "xai"],
  [/^mistral-|^magistral-/, "mistral"],
  [/^deepseek-/, "deepseek"],
];

/**
 * Providers whose listing says something a reseller's does not. A model reaching Bedrock is
 * evidence it shipped; the hundredth gateway reselling it an hour later is not, and putting every
 * one of them in the record body would emit a "changed" event for each.
 */
const CORE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "amazon-bedrock",
  "azure",
  "azure-cognitive-services",
  "microsoft-foundry",
  "github-copilot",
  "openrouter",
  "vercel",
  "xai",
  "mistral",
  "deepseek",
  "groq",
  "cerebras",
]);

function depth(path: string): number {
  return path.split("/").length;
}

function vendorProviderFor(slug: string): string | null {
  return VENDOR_PROVIDER.find(([pattern]) => pattern.test(slug))?.[1] ?? null;
}

/**
 * One model written six ways. `us.anthropic.claude-opus-5-v1:0` on Bedrock,
 * `anthropic/claude-opus-5` on a gateway, `claude-opus-5@default` on Vertex and
 * `anthropic-claude-opus-5` on DigitalOcean are the same release, and counting them as four
 * sightings would make a single launch look like independent confirmation.
 */
export function bareModelSlug(id: string): string {
  return (
    (id.split("/").at(-1) ?? id)
      .replace(/^(global|us|eu|apac|au|jp)\./, "")
      .replace(/^(anthropic|openai|meta|deepseek|mistral)\./, "")
      // Only where a family name follows: `mistral-large` and `deepseek-chat` are model names whose
      // first word happens to be their maker, and stripping it leaves `large` and `chat`.
      .replace(/^(anthropic|openai)-(?=claude-|gpt-|o[134]-)/, "")
      .replace(/-v\d+:\d+$/, "")
      .replace(/@[a-z0-9-]+$/, "")
  );
}

const modelsDevModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  family: z.string().nullish(),
  release_date: z.string().nullish(),
  last_updated: z.string().nullish(),
  knowledge: z.string().nullish(),
  status: z.string().nullish(),
  open_weights: z.boolean().nullish(),
  reasoning: z.boolean().nullish(),
  tool_call: z.boolean().nullish(),
  modalities: z.object({ input: z.array(z.string()).default([]), output: z.array(z.string()).default([]) }).nullish(),
  limit: z.object({ context: z.number().nullish(), output: z.number().nullish() }).nullish(),
});

const modelsDevSchema = z
  .record(
    z.string(),
    z.object({ id: z.string().min(1), name: z.string().min(1), models: z.record(z.string(), modelsDevModel) }),
  )
  .refine((value) => Object.keys(value).length > 0, "models.dev catalogue has no providers");

type ModelsDevEntry = z.infer<typeof modelsDevModel>;

const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Every published catalogue at once, keyed by the model rather than by where it is sold. A launch
 * arrives here as one record whose provider count climbs over the following days, which is the
 * shape the propagation actually has.
 */
export async function collectModelsDev(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const raw: unknown = JSON.parse(await fetchText(MODELS_DEV_URL, {}, request, undefined, cache));
  const catalogue = modelsDevSchema.parse(raw);
  const grouped = new Map<string, { entry: ModelsDevEntry; providers: Set<string> }>();
  for (const [providerId, provider] of Object.entries(catalogue))
    for (const model of Object.values(provider.models)) {
      const slug = bareModelSlug(model.id);
      const existing = grouped.get(slug);
      if (existing) existing.providers.add(providerId);
      // The vendor's own entry is the one with the release date and the description worth keeping,
      // so it wins the fields when it is present; otherwise the first sighting stands.
      else grouped.set(slug, { entry: model, providers: new Set([providerId]) });
      if (existing && providerId === vendorProviderFor(slug)) existing.entry = model;
    }
  const records: RecordData[] = [...grouped.entries()]
    .map(([slug, { entry, providers }]) => {
      const vendorProvider = vendorProviderFor(slug);
      return {
        id: slug,
        name: entry.name,
        url: `https://models.dev/#${slug}`,
        family: entry.family ?? null,
        released: entry.release_date ?? null,
        updated: entry.last_updated ?? null,
        knowledge: entry.knowledge ?? null,
        status: entry.status ?? null,
        context: entry.limit?.context ?? null,
        output: entry.limit?.output ?? null,
        input: [...(entry.modalities?.input ?? [])].sort(),
        openWeights: entry.open_weights ?? null,
        reasoning: entry.reasoning ?? null,
        providerCount: providers.size,
        coreProviders: [...providers].filter((id) => CORE_PROVIDERS.has(id)).sort(),
        // Null where no vendor directory is known for the family: an unanswered question, not a no.
        vendorListed: vendorProvider ? providers.has(vendorProvider) : null,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!records.length) throw new Error("models.dev catalogue has no models");
  return { source: "models-dev", stream: "api-models", url: "https://models.dev", raw, records };
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string().min(1), type: z.string().min(1) })).min(1),
});

/** The two directories this source exists for: nowhere else publishes a provider deployment version. */
const AZURE_DIRECTORIES = ["microsoft-foundry", "azure-ai-foundry"];

const TRUEFOUNDRY_TREE_URL = "https://api.github.com/repos/truefoundry/models/git/trees/main?recursive=1";

/**
 * A trailing `-2` on an Azure slug is the provider's deployment version, not a new model.
 *
 * `claude-opus-5-2` appeared on 2026-09-04 and read as an unannounced Opus 5.2, down to an
 * auto-generated pull request title that said so. It is Opus 5 on Microsoft Foundry version 2, and
 * the tree says which: a real release is listed in the vendor's own directory, and all four
 * version artifacts measured on 2026-09-15 were absent from it while their base model was present.
 *
 * The check is deliberately narrow. `claude-opus-4-5` also ends in a digit and `claude-opus-4`
 * also exists, and it is a real model precisely because Anthropic lists it -- so vendor presence,
 * not the suffix, is what decides. A genuine Opus 5.2 launching on Azure before Anthropic lists it
 * would be misread here; that case belongs to the operator, and the record keeps the evidence for
 * it rather than hiding the suffix.
 */
export function providerVersionBase(
  slug: string,
  providersBySlug: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const base = /^(.+)-(\d)$/.exec(slug)?.[1];
  if (!base || !providersBySlug.has(base)) return null;
  const vendor = vendorProviderFor(slug);
  if (!vendor || !providersBySlug.get(base)?.has(vendor)) return null;
  return providersBySlug.get(slug)?.has(vendor) ? null : base;
}

/**
 * The deployment layer the normalised catalogues drop. Only the Azure directories are reported;
 * the rest of the tree is read to answer whether a vendor lists a slug at all.
 */
export async function collectTrueFoundryAzure(
  token: string,
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  if (!token) throw new Error("GITHUB_TOKEN is required for the TrueFoundry catalogue");
  const raw: unknown = JSON.parse(
    await fetchText(
      TRUEFOUNDRY_TREE_URL,
      { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` },
      request,
      undefined,
      cache,
    ),
  );
  const tree = treeSchema.parse(raw);
  if (tree.truncated) throw new Error("TrueFoundry tree was truncated; the catalogue would be incomplete");
  const providersBySlug = new Map<string, Set<string>>();
  const entries: { provider: string; slug: string; path: string }[] = [];
  for (const node of tree.tree) {
    const match = /^providers\/([^/]+)\/(.+)\.yaml$/.exec(node.path);
    if (!match || node.type !== "blob") continue;
    const provider = match[1] as string;
    const slug = bareModelSlug(match[2] as string);
    entries.push({ provider, slug, path: node.path });
    const seen = providersBySlug.get(slug);
    if (seen) seen.add(provider);
    else providersBySlug.set(slug, new Set([provider]));
  }
  if (!providersBySlug.size) throw new Error("TrueFoundry tree has no provider catalogue");
  // The same deployment is filed twice: `grok-3.yaml` and `azure_ai/global/grok-3.yaml` are one
  // model in one provider, and emitting both is a duplicate record ID rather than two sightings.
  // The shallower path is the catalogue entry; the nested one is a routing variant of it.
  const deduplicated = new Map<string, (typeof entries)[number]>();
  for (const entry of entries.filter((item) => AZURE_DIRECTORIES.includes(item.provider))) {
    const key = `${entry.provider}/${entry.slug}`;
    const held = deduplicated.get(key);
    if (
      !held ||
      depth(entry.path) < depth(held.path) ||
      (depth(entry.path) === depth(held.path) && entry.path < held.path)
    )
      deduplicated.set(key, entry);
  }
  const records: RecordData[] = [...deduplicated.values()]
    .map((entry) => {
      const base = providerVersionBase(entry.slug, providersBySlug);
      return {
        id: `${entry.provider}/${entry.slug}`,
        name: entry.slug,
        url: `https://github.com/truefoundry/models/blob/main/${entry.path}`,
        provider: entry.provider,
        model: entry.slug,
        // Set only where the evidence carries it, so the deployment version merges into the model
        // it deploys instead of arriving as a release of its own.
        canonical_id: base ?? entry.slug,
        providerVersionOf: base,
        vendorListed: vendorProviderFor(entry.slug)
          ? (providersBySlug.get(entry.slug)?.has(vendorProviderFor(entry.slug) as string) ?? false)
          : null,
        providers: [...(providersBySlug.get(entry.slug) ?? [])].sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!records.length) throw new Error("TrueFoundry tree has no Azure catalogue");
  return {
    source: "truefoundry-azure",
    stream: "api-models",
    url: "https://github.com/truefoundry/models/tree/main/providers/microsoft-foundry",
    raw,
    records,
  };
}
