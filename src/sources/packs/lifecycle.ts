import type { SourceContext, SourceEntry } from "../definition.js";
import { collectAnthropicDeprecations, collectOpenAIDeprecations } from "../deprecations.js";
import { type SourceKind, sourcesOfKind } from "../kinds.js";
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

/**
 * A provider's own retirement schedule: the one page a reader has to act on by a date.
 *
 * Nine of these differed only by maker and collector. Hourly because a date that moves is still a
 * date weeks away, and nothing here is ever the first word on anything.
 */
const RETIREMENT_SCHEDULE: SourceKind = {
  kind: "retirement-schedule",
  appendOnly: true,
  authority: "first_party",
  // The provider's own notice with its own dates on it: confirmed, and the one thing here that is
  // evidence about a model's end rather than its arrival.
  evidence: "deprecation",
  confidence: "confirmed",
  group: "Deprecations",
  stream: "deprecations",
  intervalSeconds: 3600,
};

/** A platform's own status page. Its pace is the platform's, so every member overrules it. */
const STATUS_PAGE: SourceKind = {
  kind: "status-page",
  appendOnly: true,
  authority: "first_party",
  // The platform saying what its own service is doing, which nothing else can contradict.
  evidence: "status_page",
  confidence: "confirmed",
  group: "Platform health",
  stream: "incidents",
  intervalSeconds: 300,
};

/** Deprecation schedules, retirement pages, platform status and usage limits. */
export function lifecycleSources({ cache }: SourceContext): SourceEntry[] {
  return [
    {
      id: "codex-resets",
      appendOnly: true,
      authority: "third_party",
      // A third-party tracker watching a limit move. No surface of anybody's is observed, so no
      // evidence type fits; `readerStanding` reads the record to say which of the two it was.
      evidence: "unknown",
      confidence: "observed",
      vendor: "OpenAI",
      group: "Usage limits",
      stream: "resets",
      // Measured over the tracked history: one reset every 6.9 days. A quarter-hour poll is
      // already far finer than the thing it watches.
      intervalSeconds: 900,
      collector: () => collectCodexResets(fetch, cache),
    },
    ...sourcesOfKind(RETIREMENT_SCHEDULE, [
      { id: "openai-deprecations", vendor: "OpenAI", collector: () => collectOpenAIDeprecations() },
      { id: "anthropic-deprecations", vendor: "Anthropic", collector: () => collectAnthropicDeprecations() },
      { id: "gemini-deprecations", vendor: "Google", collector: () => collectGeminiDeprecations() },
      { id: "vertex-deprecations", vendor: "Google", collector: () => collectVertexDeprecations() },
      { id: "aws-bedrock-lifecycle", vendor: "AWS", collector: () => collectAwsBedrockLifecycle() },
      { id: "azure-foundry-lifecycle", vendor: "Microsoft", collector: () => collectAzureFoundryLifecycle() },
      { id: "groq-deprecations", vendor: "Groq", collector: () => collectGroqDeprecations() },
      { id: "cohere-deprecations", vendor: "Cohere", collector: () => collectCohereDeprecations() },
      { id: "xai-deprecations", vendor: "xAI", collector: () => collectXaiDeprecations() },
    ]),
    ...sourcesOfKind(
      STATUS_PAGE,
      PLATFORMS.map((platform) => ({
        id: `status:${platform.id}`,
        vendor: platform.name,
        intervalSeconds: platform.interval,
        collector: () => collectPlatformStatus(platform),
      })),
    ),
  ];
}
