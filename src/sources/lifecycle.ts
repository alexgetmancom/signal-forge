import { z } from "zod";
import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";
import { htmlText } from "./html.js";
import { fetchText } from "./http.js";

export const GEMINI_DEPRECATIONS_URL = "https://ai.google.dev/gemini-api/docs/deprecations?hl=en";
export const VERTEX_DEPRECATIONS_URL = "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes";
export const AWS_BEDROCK_LIFECYCLE_URL =
  "https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/model-lifecycle-legacy.html";
export const AZURE_FOUNDRY_LIFECYCLE_URL =
  "https://learn.microsoft.com/en-us/azure/foundry/concepts/model-lifecycle-retirement?view=azureml-api-2";
export const GROQ_DEPRECATIONS_URL = "https://console.groq.com/docs/deprecations";
export const COHERE_DEPRECATIONS_URL = "https://docs.cohere.com/docs/deprecations.md";
export const XAI_DEPRECATIONS_URL = "https://docs.x.ai/developers/migration/may-15-retirement";

const lifecycleRecord = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    maker: z.string().min(1),
    provider: z.string().min(1),
    modelId: z.string().nullish(),
    stage: z.string().min(1),
    announced: z.string().nullish(),
    deprecated: z.string().nullish(),
    retirement: z.string().nullish(),
    replacement: z.string().nullish(),
    region: z.string().nullish(),
    context: z.string().nullish(),
    summary: z.string().max(1_200),
    url: z.url(),
  })
  .passthrough();

const lifecycleRecords = z.array(lifecycleRecord).min(1);

type LifecycleTableOptions = {
  provider: string;
  url: string;
  stage: string;
  modelHeaders: string[];
  nameHeaders?: string[];
  idHeaders?: string[];
  retirementHeaders?: string[];
  replacementHeaders?: string[];
  deprecatedHeaders?: string[];
  retirementFallback?: string | null;
  inferStageFromRetirement?: boolean;
  announcementPattern?: RegExp;
};

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function headerKey(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type HtmlTable = { rows: string[][]; heading: string };

function previousHeading(html: string, index: number): string {
  const headings = [...html.slice(0, index).matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  return htmlText(headings.at(-1)?.[1] ?? "");
}

function htmlTables(html: string): HtmlTable[] {
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((table) => ({
    heading: previousHeading(html, table.index ?? 0),
    rows: [...(table[1] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => clean(htmlText(cell[1] ?? ""))),
    ),
  }));
}

function markdownTables(markdown: string): string[][][] {
  const lines = markdown.split("\n");
  const tables: string[][][] = [];
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index]?.includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) continue;
    const rows: string[][] = [];
    for (let cursor = index; cursor < lines.length && lines[cursor]?.includes("|"); cursor++) {
      const cells = (lines[cursor] ?? "")
        .split("|")
        .map((cell) => clean(cell.replace(/`/g, "")))
        .filter((cell, cellIndex, all) => !(cellIndex === 0 && !cell) && !(cellIndex === all.length - 1 && !cell));
      if (cells.length) rows.push(cells);
      index = cursor;
    }
    if (rows.length > 1) tables.push(rows.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell))));
  }
  return tables;
}

function rowValue(row: string[], headers: string[], names: string[]): string | null {
  for (const name of names) {
    const exact = headers.indexOf(name);
    if (exact >= 0) return clean(row[exact] ?? "") || null;
    if (/replacement|migration|redirect/.test(name)) {
      const index = headers.findIndex((header) => header.includes(name));
      if (index >= 0) return clean(row[index] ?? "") || null;
    } else {
      const index = headers.findIndex(
        (header) => header.includes(name) && !/(recommended|replacement|migration|redirect)/.test(header),
      );
      if (index >= 0) return clean(row[index] ?? "") || null;
    }
  }
  return null;
}

function parseDateFromText(value: string | null, pattern?: RegExp): string | null {
  if (!value) return null;
  const match = value.match(
    pattern ??
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i,
  );
  return match?.[0] ?? null;
}

function nullable(value: string | null): string | null {
  const normalized = clean(value ?? "");
  return !normalized || /^(?:-|—|n\/a|none|unknown|never|not applicable)$/i.test(normalized) ? null : normalized;
}

function lifecycleStage(value: string | null): string | null {
  const normalized = clean(value ?? "");
  if (!normalized) return null;
  if (/\bpreview\b/i.test(normalized)) return "Preview";
  if (/\bdeprecated|discontinued\b/i.test(normalized)) return "Deprecated";
  if (/\bretired\b/i.test(normalized)) return "Retired";
  if (/\blegacy\b/i.test(normalized)) return "Legacy";
  if (/\bactive\b/i.test(normalized)) return "Active";
  if (/\bga\b/i.test(normalized)) return "GA";
  return null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseTableRecords(html: string, options: LifecycleTableOptions): RecordData[] {
  const records: RecordData[] = [];
  for (const table of htmlTables(html)) {
    let tableStage = lifecycleStage(table.heading) ?? options.stage;
    const headerIndex = table.rows.findIndex((row) =>
      row.some((cell) =>
        options.modelHeaders.some((header) => headerKey(cell) === header || headerKey(cell).includes(header)),
      ),
    );
    if (headerIndex < 0) continue;
    const headers = (table.rows[headerIndex] ?? []).map(headerKey);
    if (!headers.length) continue;
    let previous: string[] = [];
    for (const rawRow of table.rows.slice(headerIndex + 1)) {
      if (rawRow.length === 1) {
        const marker = lifecycleStage(rawRow[0] ?? "");
        if (marker) {
          tableStage = marker;
          previous = [];
          continue;
        }
      }
      const row =
        rawRow.length < headers.length ? [...Array(headers.length - rawRow.length).fill(""), ...rawRow] : rawRow;
      const values = row.map((value, index) => clean(value) || previous[index] || "");
      previous = values;
      const model = rowValue(values, headers, options.modelHeaders);
      if (!model || /^model|^endpoint|^n\/a$|^-$/.test(model.toLowerCase())) continue;
      const name = rowValue(values, headers, options.nameHeaders ?? ["model name", "model"]) ?? model;
      const modelId = rowValue(values, headers, options.idHeaders ?? ["model id", "model"]) ?? model;
      const version = nullable(rowValue(values, headers, ["version", "model version", "api version"]));
      const region = rowValue(values, headers, ["regions", "region"]);
      const retirement = rowValue(
        values,
        headers,
        options.retirementHeaders ?? ["shutdown date", "retirement date", "eol date", "model eol date"],
      );
      const replacement = rowValue(
        values,
        headers,
        options.replacementHeaders ?? [
          "recommended replacement",
          "recommended replacement model id",
          "replacement",
          "recommended endpoint migration",
          "redirect target after may 15",
        ],
      );
      const deprecated = rowValue(
        values,
        headers,
        options.deprecatedHeaders ?? ["deprecated date", "deprecation date"],
      );
      const announced = parseDateFromText(values.join(" "), options.announcementPattern);
      const retirementDate = parseDateFromText(nullable(retirement)) ?? options.retirementFallback ?? null;
      const stage =
        lifecycleStage(rowValue(values, headers, ["lifecycle", "status", "state"])) ??
        (options.inferStageFromRetirement && retirementDate && tableStage === options.stage
          ? "Deprecated"
          : tableStage);
      const key = `${options.provider}:${modelId}:${version ?? ""}:${region ?? ""}`;
      records.push({
        id: slug(key),
        name,
        maker: options.provider,
        provider: options.provider,
        modelId,
        version,
        stage,
        announced,
        deprecated: parseDateFromText(nullable(deprecated)),
        retirement: retirementDate,
        replacement: nullable(replacement),
        region: nullable(region),
        context: rowValue(values, headers, ["context window", "context"]),
        summary: values.join(" · ").slice(0, 1_200),
        url: options.url,
      });
    }
  }
  return lifecycleRecords.parse([...new Map(records.map((record) => [record.id, record])).values()]);
}

function parseMarkdownRecords(markdown: string, options: LifecycleTableOptions): RecordData[] {
  const records: RecordData[] = [];
  for (const table of markdownTables(markdown)) {
    const headers = (table[0] ?? []).map(headerKey);
    if (!headers.some((header) => options.modelHeaders.some((candidate) => header.includes(candidate)))) continue;
    for (const rawRow of table.slice(1)) {
      if (rawRow.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      const row =
        rawRow.length < headers.length ? [...Array(headers.length - rawRow.length).fill(""), ...rawRow] : rawRow;
      const model = rowValue(row, headers, options.modelHeaders);
      if (!model || /^model|^endpoint|^n\/a$|^-$/.test(model.toLowerCase())) continue;
      const modelId = rowValue(row, headers, options.idHeaders ?? ["model id", "model"]) ?? model;
      const version = nullable(rowValue(row, headers, ["version", "model version", "api version"]));
      const region = rowValue(row, headers, ["regions", "region"]);
      const retirement = rowValue(
        row,
        headers,
        options.retirementHeaders ?? ["shutdown date", "retirement date", "eol date"],
      );
      const retirementDate = parseDateFromText(nullable(retirement)) ?? options.retirementFallback ?? null;
      const deprecated = rowValue(row, headers, options.deprecatedHeaders ?? ["deprecated date", "deprecation date"]);
      records.push({
        id: slug(`${options.provider}:${modelId}:${version ?? ""}:${region ?? ""}`),
        name: rowValue(row, headers, options.nameHeaders ?? ["model name", "model"]) ?? model,
        maker: options.provider,
        provider: options.provider,
        modelId,
        version,
        stage: lifecycleStage(rowValue(row, headers, ["lifecycle", "status", "state"])) ?? options.stage,
        announced: parseDateFromText(row.join(" "), options.announcementPattern),
        deprecated: parseDateFromText(nullable(deprecated)),
        retirement: retirementDate,
        replacement: nullable(
          rowValue(
            row,
            headers,
            options.replacementHeaders ?? [
              "recommended replacement",
              "replacement",
              "recommended endpoint migration",
              "redirect target after may 15",
            ],
          ),
        ),
        region: nullable(region),
        context: rowValue(row, headers, ["context window", "context"]),
        summary: row.join(" · ").slice(0, 1_200),
        url: options.url,
      });
    }
  }
  return lifecycleRecords.parse([...new Map(records.map((record) => [record.id, record])).values()]);
}

function parseCollection(source: string, url: string, raw: string, records: RecordData[]): Collection {
  return {
    source,
    stream: "deprecations",
    url,
    raw,
    appendOnly: true,
    trackChanges: true,
    records,
  };
}

export function parseGeminiDeprecations(html: string): Collection {
  return parseCollection(
    "gemini-deprecations",
    GEMINI_DEPRECATIONS_URL,
    html,
    parseTableRecords(html, {
      provider: "Google Gemini",
      url: GEMINI_DEPRECATIONS_URL,
      stage: "Active",
      inferStageFromRetirement: true,
      modelHeaders: ["model"],
      retirementHeaders: ["shutdown date"],
      replacementHeaders: ["recommended replacement"],
    }),
  );
}

export function parseVertexDeprecations(html: string): Collection {
  return parseCollection(
    "vertex-deprecations",
    VERTEX_DEPRECATIONS_URL,
    html,
    parseTableRecords(html, {
      provider: "Google Vertex AI",
      url: VERTEX_DEPRECATIONS_URL,
      stage: "Deprecated",
      modelHeaders: ["discontinued endpoints", "model"],
      replacementHeaders: ["recommended endpoint migration", "replacement"],
    }),
  );
}

export function parseAwsBedrockLifecycle(html: string): Collection {
  return parseCollection(
    "aws-bedrock-lifecycle",
    AWS_BEDROCK_LIFECYCLE_URL,
    html,
    parseTableRecords(html, {
      provider: "AWS Bedrock",
      url: AWS_BEDROCK_LIFECYCLE_URL,
      stage: "Legacy",
      modelHeaders: ["model id", "model name"],
      nameHeaders: ["model name", "model id"],
      idHeaders: ["model id", "model name"],
      retirementHeaders: ["eol date", "model eol date"],
    }),
  );
}

export function parseAzureFoundryLifecycle(html: string): Collection {
  return parseCollection(
    "azure-foundry-lifecycle",
    AZURE_FOUNDRY_LIFECYCLE_URL,
    html,
    parseTableRecords(html, {
      provider: "Microsoft Foundry",
      url: AZURE_FOUNDRY_LIFECYCLE_URL,
      stage: "Deprecated",
      modelHeaders: ["model"],
      retirementHeaders: ["retirement date"],
      replacementHeaders: ["replacement"],
    }),
  );
}

export function parseGroqDeprecations(html: string): Collection {
  return parseCollection(
    "groq-deprecations",
    GROQ_DEPRECATIONS_URL,
    html,
    parseTableRecords(html, {
      provider: "Groq",
      url: GROQ_DEPRECATIONS_URL,
      stage: "Deprecated",
      modelHeaders: ["deprecated model", "model id"],
      retirementHeaders: ["shutdown date"],
      replacementHeaders: ["recommended replacement model id", "recommended replacement"],
    }),
  );
}

export function parseCohereDeprecations(input: string): Collection {
  const options = {
    provider: "Cohere",
    url: COHERE_DEPRECATIONS_URL,
    stage: "Deprecated",
    modelHeaders: ["deprecated model", "model"],
    retirementHeaders: ["shutdown date", "retirement date"],
    replacementHeaders: ["recommended replacement", "replacement"],
  } satisfies LifecycleTableOptions;
  let tableRecords: RecordData[] = [];
  try {
    tableRecords = parseTableRecords(input, options);
  } catch {
    tableRecords = [];
  }
  let markdownRecords: RecordData[] = tableRecords;
  if (!markdownRecords.length)
    try {
      markdownRecords = parseMarkdownRecords(input, options);
    } catch {
      markdownRecords = [];
    }
  if (!markdownRecords.length) {
    const sections = [...input.matchAll(/^###\s+(\d{4}-\d{2}-\d{2}):?[^\n]*\n([\s\S]*?)(?=^###\s+|^#\s+|$)/gm)];
    const fallback: RecordData[] = [];
    for (const section of sections) {
      const date = section[1];
      const body = section[2] ?? "";
      if (!date) continue;
      const codes = [...body.matchAll(/`([^`]+)`/g)]
        .map((match) => clean(match[1] ?? ""))
        .filter((value) => /^[a-z][a-z0-9./_-]{2,}$/i.test(value));
      const replacementText = body.match(/(?:alternatives?|recommend(?:ed)?|use)[\s\S]{0,500}/i)?.[0] ?? "";
      const replacements = [...replacementText.matchAll(/`([^`]+)`/g)]
        .map((match) => clean(match[1] ?? ""))
        .filter((value) => /^[a-z][a-z0-9./_-]{2,}$/i.test(value));
      for (const model of [...new Set(codes)]) {
        fallback.push({
          id: slug(`Cohere:${date}:${model}`),
          name: model,
          maker: "Cohere",
          provider: "Cohere",
          modelId: model,
          stage: /retired|sunset/i.test(body) ? "Retired" : "Deprecated",
          announced: date,
          deprecated: null,
          retirement: /retired|sunset/i.test(body) ? date : null,
          replacement: [...new Set(replacements.filter((value) => value !== model))].join(", ") || null,
          region: null,
          context: null,
          summary: clean(body).slice(0, 1_200),
          url: COHERE_DEPRECATIONS_URL,
        });
      }
    }
    markdownRecords = lifecycleRecords.parse([...new Map(fallback.map((record) => [record.id, record])).values()]);
  }
  return parseCollection("cohere-deprecations", COHERE_DEPRECATIONS_URL, input, markdownRecords);
}

export function parseXaiDeprecations(input: string): Collection {
  const records = parseTableRecords(input, {
    provider: "xAI",
    url: XAI_DEPRECATIONS_URL,
    stage: "Retired",
    modelHeaders: ["model being retired", "model"],
    retirementFallback: parseDateFromText(input, /\bMay\s+15,\s+\d{4}\b/i),
    retirementHeaders: ["retirement date", "shutdown date"],
    replacementHeaders: ["redirect target after may 15", "replacement"],
  });
  return parseCollection("xai-deprecations", XAI_DEPRECATIONS_URL, input, records);
}

export async function collectGeminiDeprecations(request: Fetch = fetch): Promise<Collection> {
  return parseGeminiDeprecations(await fetchText(GEMINI_DEPRECATIONS_URL, {}, request));
}
export async function collectVertexDeprecations(request: Fetch = fetch): Promise<Collection> {
  return parseVertexDeprecations(await fetchText(VERTEX_DEPRECATIONS_URL, {}, request));
}
export async function collectAwsBedrockLifecycle(request: Fetch = fetch): Promise<Collection> {
  return parseAwsBedrockLifecycle(await fetchText(AWS_BEDROCK_LIFECYCLE_URL, {}, request));
}
export async function collectAzureFoundryLifecycle(request: Fetch = fetch): Promise<Collection> {
  return parseAzureFoundryLifecycle(await fetchText(AZURE_FOUNDRY_LIFECYCLE_URL, {}, request));
}
export async function collectGroqDeprecations(request: Fetch = fetch): Promise<Collection> {
  return parseGroqDeprecations(await fetchText(GROQ_DEPRECATIONS_URL, {}, request));
}
export async function collectCohereDeprecations(request: Fetch = fetch): Promise<Collection> {
  return parseCohereDeprecations(await fetchText(COHERE_DEPRECATIONS_URL, {}, request));
}
export async function collectXaiDeprecations(request: Fetch = fetch): Promise<Collection> {
  return parseXaiDeprecations(await fetchText(XAI_DEPRECATIONS_URL, {}, request));
}
