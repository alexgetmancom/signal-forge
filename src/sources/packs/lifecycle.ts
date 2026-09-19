import type { SourceContext, SourceEntry } from "../definition.js";
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "../deprecations.js";
import {
  collectAwsBedrockLifecycle,
  collectAzureFoundryLifecycle,
  collectCohereDeprecations,
  collectGeminiDeprecations,
  collectGroqDeprecations,
  collectVertexDeprecations,
  collectXaiDeprecations,
} from "../lifecycle.js";
import { collectPlatformStatus, PLATFORMS } from "../platforms.js";
import { collectCodexResets } from "../resets.js";

/** Deprecation schedules, retirement pages, platform status and usage limits. */
export function lifecycleSources({ cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "codex-resets",
      authority: "third_party",
      vendor: "OpenAI",
      group: "Usage limits",
      stream: "resets",
      // Measured over the tracked history: one reset every 6.9 days. A quarter-hour poll is
      // already far finer than the thing it watches.
      intervalSeconds: 900,
      collector: () => collectCodexResets(fetch, cache),
    },
    {
      id: "openai-deprecations",
      authority: "first_party",
      vendor: "OpenAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectOpenAIDeprecations(),
    },
    {
      id: "anthropic-deprecations",
      authority: "first_party",
      vendor: "Anthropic",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAnthropicDeprecations(),
    },
    {
      id: "gemini-deprecations",
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGeminiDeprecations(),
    },
    {
      id: "vertex-deprecations",
      authority: "first_party",
      vendor: "Google",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectVertexDeprecations(),
    },
    {
      id: "aws-bedrock-lifecycle",
      authority: "first_party",
      vendor: "AWS",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAwsBedrockLifecycle(),
    },
    {
      id: "azure-foundry-lifecycle",
      authority: "first_party",
      vendor: "Microsoft",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectAzureFoundryLifecycle(),
    },
    {
      id: "groq-deprecations",
      authority: "first_party",
      vendor: "Groq",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectGroqDeprecations(),
    },
    {
      id: "cohere-deprecations",
      authority: "first_party",
      vendor: "Cohere",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectCohereDeprecations(),
    },
    {
      id: "xai-deprecations",
      authority: "first_party",
      vendor: "xAI",
      group: "Deprecations",
      stream: "deprecations",
      intervalSeconds: 3600,
      collector: () => collectXaiDeprecations(),
    },
    ...PLATFORMS.map(
      (platform): SourceEntry => ({
        id: `status:${platform.id}`,
        authority: "first_party",
        vendor: platform.name,
        group: "Platform health",
        stream: "incidents",
        intervalSeconds: platform.interval,
        collector: () => collectPlatformStatus(platform),
      }),
    ),
  ];
}
