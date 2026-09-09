export type AttentionScore = {
  score: number;
  reasons: string[];
};

export type AttentionInput = {
  name?: string | null;
  description?: string | null;
  topics?: readonly string[] | null;
  created?: string | null;
  stars?: number | null;
  forks?: number | null;
  downloads?: number | null;
  likes?: number | null;
  pipelineTag?: string | null;
  tags?: readonly string[] | null;
};

const TECHNICAL_TERMS = [
  "model",
  "llm",
  "agent",
  "mcp",
  "inference",
  "reasoning",
  "multimodal",
  "benchmark",
  "weights",
  "transformer",
] as const;

const AI_TERMS = [
  "artificial intelligence",
  "artificial-intelligence",
  "machine learning",
  "deep learning",
  ...TECHNICAL_TERMS,
] as const;

function searchable(input: AttentionInput): string {
  return [input.name, input.description, ...(input.topics ?? []), input.pipelineTag, ...(input.tags ?? [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/.-]+/g, " ");
}

function hasTerm(text: string, term: string): boolean {
  return new RegExp(`(?:^|\\s)${term.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`, "i").test(text);
}

function recencyScore(created: string | null | undefined, now: number, reasons: string[]): number {
  if (!created) return 0;
  const timestamp = Date.parse(created);
  if (!Number.isFinite(timestamp) || timestamp > now) return 0;
  const age = now - timestamp;
  if (age <= 24 * 3_600_000) {
    reasons.push("created-within-24h");
    return 20;
  }
  if (age <= 72 * 3_600_000) {
    reasons.push("created-within-72h");
    return 15;
  }
  if (age <= 7 * 24 * 3_600_000) {
    reasons.push("created-within-7d");
    return 10;
  }
  return 0;
}

function thresholdScore(
  value: number | null | undefined,
  thresholds: readonly [number, number, string][],
  reasons: string[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  for (const [threshold, score, reason] of thresholds) {
    if (value >= threshold) {
      reasons.push(reason);
      return score;
    }
  }
  return 0;
}

/** Deterministic attention for repository and catalogue observations. It never changes confidence. */
export function attentionScore(input: AttentionInput, now = Date.now()): AttentionScore {
  const reasons: string[] = [];
  const text = searchable(input);
  let score = recencyScore(input.created, now, reasons);
  score += thresholdScore(
    input.stars,
    [
      [100, 25, "stars-100-plus"],
      [50, 20, "stars-50-plus"],
      [20, 15, "stars-20-plus"],
      [10, 10, "stars-10-plus"],
    ],
    reasons,
  );
  score += thresholdScore(
    input.forks,
    [
      [10, 10, "forks-10-plus"],
      [3, 5, "forks-3-plus"],
    ],
    reasons,
  );
  if (AI_TERMS.some((term) => hasTerm(text, term))) {
    score += 15;
    reasons.push("ai-keyword-match");
  }
  if (TECHNICAL_TERMS.some((term) => hasTerm(text, term))) {
    score += 10;
    reasons.push("technical-term-match");
  }
  return { score: Math.min(100, Math.max(0, score)), reasons };
}

/** A deterministic extension of the base score for Hugging Face model discovery. */
export function huggingFaceAttentionScore(input: AttentionInput, now = Date.now()): AttentionScore {
  const base = attentionScore(input, now);
  const reasons = [...base.reasons];
  let score = base.score;
  score += thresholdScore(
    input.downloads,
    [
      [100_000, 20, "downloads-100k-plus"],
      [10_000, 15, "downloads-10k-plus"],
      [1_000, 10, "downloads-1k-plus"],
    ],
    reasons,
  );
  score += thresholdScore(
    input.likes,
    [
      [100, 10, "likes-100-plus"],
      [20, 5, "likes-20-plus"],
    ],
    reasons,
  );
  if (
    input.pipelineTag ||
    (input.tags ?? []).some((tag) => /text-generation|image|audio|multimodal|embedding/i.test(tag))
  ) {
    score += 10;
    reasons.push("model-pipeline-match");
  }
  return { score: Math.min(100, Math.max(0, score)), reasons };
}
