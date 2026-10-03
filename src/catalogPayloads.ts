import { z } from "zod";

/** The model fields consumed by collectors and retained in their snapshot evidence. */
export const openRouterSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        created: z.number(),
        context_length: z.number().nullable(),
        pricing: z.record(z.string(), z.unknown()),
        architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
        supported_parameters: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

export const gatewayModels = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().nullish(),
        owned_by: z.string().nullish(),
        context_window: z.number().nullish(),
        max_tokens: z.number().nullish(),
        pricing: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .min(1),
});
