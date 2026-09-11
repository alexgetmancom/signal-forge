import { canonical } from "../canonical.js";
import { meaningfulWebString, normalizeWebString } from "../web.js";

/** Observation metadata that is useful in evidence but not useful in a notification. */
export const NOISE = new Set(["head", "updated", "published", "created", "started", "url", "detected", "sampledAt"]);

export const fieldLabels: Record<string, string> = {
  name: "Name",
  context: "Context",
  input: "Accepts",
  output: "Returns",
  parameters: "Parameters",
  provider: "Provider",
  maker: "Maker",
  selectable: "Selectable",
  model: "Model",
  created: "Created",
  published: "Published",
  stage: "Stage",
  author: "Author",
  association: "Repository association",
  owner: "Owner",
  category: "Category",
  modelKey: "Variant",
  score: "Score",
  scoreUpper: "Score upper bound",
  scoreLower: "Score lower bound",
  votes: "Votes",
  sampledAt: "Sampled",
  license: "License",
  methods: "Methods",
  inputTokenLimit: "Input token limit",
  outputTokenLimit: "Output token limit",
  announced: "Announced",
  deprecated: "Deprecated",
  retirement: "Retirement",
  shutdown: "Shutdown",
  replacement: "Replacement",
  modelId: "Model ID",
  region: "Region",
  access: "Access",
  version: "Version",
};

/** A context window reads as 131K, not as 131072. */
export function compactCount(value: unknown): string {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(count) || Math.abs(count) < 1000) return describe(value);
  const millions = count / 1_000_000;
  if (Math.abs(count) >= 1_000_000)
    return `${millions.toFixed(millions >= 10 || Number.isInteger(millions) ? 0 : 2).replace(/\.?0+$/, "")}M`;
  return `${Math.round(count / 1000)}K`;
}

export function describe(value: unknown): string {
  if (value === null || value === undefined || value === "") return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(describe).join(", ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([key, nested]) => (nested === true ? key : `${key}: ${describe(nested)}`))
      .join(", ");
  return String(value);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function utcStamp(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/** Convert retained GitHub patch evidence into the only diff information readers need in a feed. */
export function githubChangeStats(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const files = [...value.matchAll(/^(.+?) \(\+(\d+)\/−(\d+)\)$/gm)];
  if (!files.length) return null;
  const additions = files.reduce((total, match) => total + Number(match[2]), 0);
  const deletions = files.reduce((total, match) => total + Number(match[3]), 0);
  const fileCount = files.length;
  return `Changes: ${fileCount} file${fileCount === 1 ? "" : "s"} · +${additions}/−${deletions} lines`;
}

export function webStringChanges(before: unknown, after: unknown) {
  const strings = (value: unknown) =>
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === "string")
        .map(normalizeWebString)
        .filter(Boolean),
    );
  const previous = strings(before);
  const current = strings(after);
  const added = [...current].filter((value) => !previous.has(value));
  const removed = [...previous].filter((value) => !current.has(value));
  return {
    added,
    removed,
    meaningfulAdded: added.filter(meaningfulWebString),
    meaningfulRemoved: removed.filter(meaningfulWebString),
  };
}

/** A small catalogue price drift is evidence, but not subscriber-facing news. */
export const MIN_PRICE_CHANGE_PER_MILLION = 1;
export const MIN_PRICE_CHANGE_RATIO = 0.1;

type PriceUnit = "per-token" | "per-million";

function priceUnitForSource(source?: string, value?: unknown): PriceUnit {
  if (source === "deepseek-pricing") return "per-million";
  // Keep the pure formatting helper useful for callers without source metadata; production
  // event rendering always passes the source and therefore never infers units from a JS type.
  if (!source) return typeof value === "number" ? "per-million" : "per-token";
  return "per-token";
}

function pricePerMillion(value: unknown, unit: PriceUnit): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return unit === "per-million" ? value : value * 1_000_000;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? (unit === "per-million" ? parsed : parsed * 1_000_000) : null;
}

export function significantPriceChange(before: unknown, after: unknown, source?: string): boolean {
  if (before === null || before === undefined || after === null || after === undefined) return true;
  const unit = priceUnitForSource(source, before);
  const from = pricePerMillion(before, unit);
  const to = pricePerMillion(after, unit);
  if (from === null || to === null) return true;
  const delta = Math.abs(from - to);
  const base = Math.max(Math.abs(from), Math.abs(to));
  return delta >= MIN_PRICE_CHANGE_PER_MILLION || (base > 0 && delta / base >= MIN_PRICE_CHANGE_RATIO);
}

export function rankMove(before: unknown, after: unknown): string {
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return `Rank: ${describe(before)} → ${describe(after)}`;
  const distance = Math.abs(to - from);
  const arrow = to < from ? "🔼" : "🔽";
  return `Rank ${to} ${arrow} ${distance} (was ${from})`;
}

export function prices(before: unknown, after: unknown, source?: string): string[] {
  const old = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
  const next = after && typeof after === "object" ? (after as Record<string, unknown>) : {};
  const labels: Record<string, string> = {
    prompt: "Input price",
    completion: "Output price",
    input_cache_read: "Cache read",
    input_cache_write: "Cache write",
    inputCacheHitOffPeak: "Cache hit off-peak",
    inputCacheHitPeak: "Cache hit peak",
    inputCacheMissOffPeak: "Input off-peak",
    inputCacheMissPeak: "Input peak",
    outputOffPeak: "Output off-peak",
    outputPeak: "Output peak",
  };
  /** A first listing has nothing to compare against, so its rates read as one price line. */
  const shorthand: Record<string, string> = {
    prompt: "in",
    completion: "out",
    input_cache_read: "cache read",
    input_cache_write: "cache write",
  };
  const money = (value: unknown) => {
    const perMillion = pricePerMillion(value, priceUnitForSource(source, value));
    if (perMillion === null) return describe(value);
    const rounded = perMillion >= 1 ? perMillion.toFixed(2) : perMillion.toPrecision(2);
    return `$${Number(rounded)}`;
  };
  const result: string[] = [];
  if (!before) {
    const parts = Object.keys(shorthand)
      .filter((key) => next[key] !== undefined && next[key] !== null && next[key] !== "")
      .map((key) => `${money(next[key])} ${shorthand[key]}`);
    const extras = Object.keys(next).filter((key) => !labels[key] && !shorthand[key]);
    return [
      ...(parts.length ? [`Price: ${parts.join(" · ")} / 1M tokens`] : []),
      ...extras.map((key) => `Pricing ${key}: ${describe(next[key])}`),
    ];
  }
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (canonical(old[key]) === canonical(next[key])) continue;
    if (labels[key]) {
      if (!significantPriceChange(old[key], next[key], source)) continue;
      const from = money(old[key]);
      const to = money(next[key]);
      if (before && from === to) continue;
      result.push(`${labels[key]}: ${before ? `${from} → ` : ""}${to} / 1M tokens`);
    } else result.push(`Pricing ${key}: ${before ? `${describe(old[key])} → ` : ""}${describe(next[key])}`);
  }
  return result;
}

export const MAX_DETAIL_LINES = 8;
const MAX_DETAIL_CHARS = 300;

export function collapseDetails(details: string[], max = MAX_DETAIL_LINES): string[] {
  const trimmed = details.map((line) =>
    line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}\u2026` : line,
  );
  if (trimmed.length <= max) return trimmed;
  const hidden = trimmed.length - max;
  return [...trimmed.slice(0, max), `\u2026and ${hidden} more change${hidden === 1 ? "" : "s"} not shown`];
}
