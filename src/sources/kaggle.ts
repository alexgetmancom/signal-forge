import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import type { HttpCache } from "../storage/httpCache.js";
import { fetchText } from "./http.js";

/**
 * Google's model cards on Kaggle, through the API the published SDK dispatches to.
 *
 * Read for coverage of the open side, not for speed, and the measurement says so: on 2026-10-04 the
 * newest card in the whole owner was 2026-09-02, and the two proprietary ones -- `gemini-3-pro-api`
 * and `gemini-3-flash-api` -- were last touched in November and December 2025, while the API
 * catalogue was on 3.8. Anything frontier arrives here months after `gemini` has it, so a card
 * appearing is a card, never a launch. Whether an omission is a withdrawal is the registry's to
 * declare, and the kind this belongs to already says append-only -- the answer is the whole owner,
 * but one page of it is not, and a token that stops early would otherwise read as a hundred
 * withdrawals.
 */
const LIST_MODELS_URL = "https://api.kaggle.com/v1/models.ModelApiService/ListModels";

/** `sortBy: 6` is recently-updated; the owner's whole catalogue is 123 cards over three pages. */
const SORT_RECENTLY_UPDATED = 6;
/** Above the page size the service actually honours, so a short page is not mistaken for the end. */
const PAGE_SIZE = 100;
/** The owner is three pages; a fourth means the contract changed and the loop must not run away. */
const MAX_PAGES = 6;

const listSchema = z.object({
  models: z
    .array(
      z.object({
        ref: z.string().min(1),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        updateTime: z.string().optional(),
        instances: z.array(z.object({ framework: z.string().optional() })).default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

export function parseKaggleModels(pages: readonly string[], owner: string): Collection {
  const records = pages.flatMap((page) =>
    listSchema.parse(JSON.parse(page) as unknown).models.map((model) => {
      const frameworks = [
        ...new Set(model.instances.flatMap((instance) => (instance.framework ? [instance.framework] : []))),
      ];
      return {
        id: model.ref,
        name: model.title ?? model.ref,
        maker: "Google",
        url: `https://www.kaggle.com/models/${model.ref}`,
        ...(model.updateTime ? { updated: model.updateTime } : {}),
        ...(frameworks.length ? { frameworks: frameworks.sort() } : {}),
      } satisfies RecordData;
    }),
  );
  if (!records.length) throw new SourceError("empty", `kaggle:${owner}: the owner answered with no models`);
  return {
    source: `kaggle:${owner}`,
    stream: "weights",
    url: `https://www.kaggle.com/models/${owner}`,
    raw: pages.join("\n"),
    records,
  };
}

export async function collectKaggleModels(
  owner: string,
  request: Fetch = fetch,
  cache?: HttpCache,
): Promise<Collection> {
  const pages: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchText(
      LIST_MODELS_URL,
      { accept: "application/json", "content-type": "application/json" },
      request,
      {
        method: "POST",
        body: JSON.stringify({
          owner,
          pageSize: PAGE_SIZE,
          sortBy: SORT_RECENTLY_UPDATED,
          ...(token ? { pageToken: token } : {}),
        }),
      },
      cache,
    );
    pages.push(body);
    token = listSchema.parse(JSON.parse(body) as unknown).nextPageToken;
    if (!token) return parseKaggleModels(pages, owner);
  }
  throw new SourceError("protocol", `kaggle:${owner}: pagination did not end within ${MAX_PAGES} pages`);
}
