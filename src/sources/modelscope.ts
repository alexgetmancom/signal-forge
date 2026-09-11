import { z } from "zod";
import type { Collection } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Several Chinese labs publish weights to ModelScope first and to Hugging Face later, or only
 * there. The listing endpoint the site's own catalogue uses is public, so one request covers every
 * organisation worth watching.
 */
export const MODELSCOPE_ORGS: readonly string[] = [
  "deepseek-ai",
  "Qwen",
  "ZhipuAI",
  "MiniMax",
  "moonshotai",
  "OpenBMB",
  "Tencent-Hunyuan",
  "XiaomiMiMo",
  "Skywork",
  "StepFun",
  "baidu",
  "iic",
];

const listing = z.object({
  Code: z.number().int(),
  Data: z.object({
    Model: z.object({
      Models: z
        .array(
          z.object({
            Path: z.string().min(1),
            Name: z.string().min(1),
            CreatedTime: z.number().int().nullable().optional(),
            License: z.string().nullable().optional(),
            ChineseName: z.string().nullable().optional(),
          }),
        )
        .nullable(),
    }),
  }),
});

function iso(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== "number" || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

export function parseModelScope(payload: string, organisations: readonly string[] = MODELSCOPE_ORGS): Collection {
  const data = listing.parse(JSON.parse(payload));
  const models = data.Data.Model.Models ?? [];
  // A listing that returned nothing is a failed read of a registry that certainly has models.
  if (!models.length) throw new Error("ModelScope returned no models");
  const watched = new Set(organisations.map((name) => name.toLowerCase()));
  return {
    source: "modelscope:recent",
    stream: "weights",
    url: "https://modelscope.cn/models",
    raw: models.length,
    // Downloads and stars move on every poll and say nothing about the model, so the record keeps
    // only what identifies a release.
    records: models
      .filter((model) => watched.has(model.Path.toLowerCase()))
      .map((model) => ({
        id: `${model.Path}/${model.Name}`,
        name: `${model.Path}: ${model.Name}`,
        url: `https://modelscope.cn/models/${model.Path}/${model.Name}`,
        maker: model.Path,
        access: "public",
        ...(model.License ? { license: model.License } : {}),
        ...(iso(model.CreatedTime) ? { created: iso(model.CreatedTime) } : {}),
        ...(model.ChineseName ? { alsoKnownAs: model.ChineseName } : {}),
      })),
  };
}

export async function collectModelScope(request: Fetch = fetch, cache?: HttpCache): Promise<Collection> {
  const payload = await fetchText(
    "https://modelscope.cn/api/v1/dolphin/models",
    { "content-type": "application/json", accept: "application/json" },
    request,
    { method: "PUT", body: JSON.stringify({ PageSize: 60, PageNumber: 1, SortBy: "Default", Criterion: [] }) },
    cache,
  );
  return parseModelScope(payload);
}
