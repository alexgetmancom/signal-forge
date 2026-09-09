import { canonical } from "../canonical.js";

/** Observation metadata that is useful in evidence but not useful in a notification. */
export const NOISE = new Set(["head", "updated", "published", "created", "started", "url", "detected"]);

export const fieldLabels: Record<string, string> = {
  name: "Name",
  context: "Context",
  input: "Input",
  output: "Output",
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
};

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

export function meaningfulWebString(value: string): boolean {
  if (value.length < 18 || value.length > 500 || /^[-+\d\s.,:;/()]+$/.test(value)) return false;
  return /\b(Claude|model|agent|Cowork|Code|browser|connector|plugin|skill|MCP|API|usage|context|remote|project|worktree|GitHub|Slack|memory|plan|tool|SSH|Bedrock|security|permission|approval)\b/i.test(
    value,
  );
}

/** A small catalogue price drift is evidence, but not subscriber-facing news. */
export const MIN_PRICE_CHANGE_PER_MILLION = 0.01;
export const MIN_PRICE_CHANGE_RATIO = 0.1;

function significantPriceChange(before: unknown, after: unknown): boolean {
  if (before === null || before === undefined || after === null || after === undefined) return true;
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return true;
  const delta = Number((Math.abs(from - to) * 1_000_000).toFixed(2));
  if (delta > MIN_PRICE_CHANGE_PER_MILLION) return true;
  const base = Math.max(Math.abs(from), Math.abs(to));
  return base > 0 && delta / (base * 1_000_000) >= MIN_PRICE_CHANGE_RATIO;
}

export function rankMove(before: unknown, after: unknown): string {
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return `Rank: ${describe(before)} → ${describe(after)}`;
  const distance = Math.abs(to - from);
  const arrow = to < from ? "🔼" : "🔽";
  return `Rank ${to} ${arrow} ${distance} (was ${from})`;
}

export function prices(before: unknown, after: unknown): string[] {
  const old = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
  const next = after && typeof after === "object" ? (after as Record<string, unknown>) : {};
  const labels: Record<string, string> = {
    prompt: "Input",
    completion: "Output",
    input_cache_read: "Cache read",
    input_cache_write: "Cache write",
  };
  const money = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)
      return describe(value);
    const perMillion = Number(value) * 1_000_000;
    const rounded = perMillion >= 1 ? perMillion.toFixed(2) : perMillion.toPrecision(2);
    return `$${Number(rounded)}`;
  };
  const result: string[] = [];
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (canonical(old[key]) === canonical(next[key])) continue;
    if (labels[key]) {
      if (!significantPriceChange(old[key], next[key])) continue;
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
