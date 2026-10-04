import { isUtf8 } from "node:buffer";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { fetchResponse, readResponseBytes, requireOk } from "./http.js";

const QWEN_BLOG_URL = "https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US";
const decoder = new TextDecoder();
type State = "key-first" | "key" | "colon" | "value-first" | "value" | "comma";
type Frame = {
  role: "document" | "root" | "data" | "articles" | "article" | "ignored";
  array: boolean;
  state: State;
  key: string | null;
  id?: unknown;
  title?: unknown;
  selected: Set<string>;
};
const SPACE = new Set([9, 10, 13, 32]);

function stringEnd(bytes: Uint8Array, from: number): number {
  for (let at = from + 1; at < bytes.length; at++) {
    const byte = bytes[at];
    if (byte === 34) return at + 1;
    if (byte === undefined || byte < 32) throw new SourceError("protocol", "Qwen JSON has an invalid string");
    if (byte !== 92) continue;
    const escaped = bytes[++at];
    if (escaped !== 117) {
      if (![34, 47, 92, 98, 102, 110, 114, 116].includes(escaped ?? -1))
        throw new SourceError("protocol", "Qwen JSON has an invalid string escape");
      continue;
    }
    for (let count = 0; count < 4; count++) {
      const hex = bytes[++at] ?? -1;
      if (!(hex >= 48 && hex <= 57) && !(hex >= 65 && hex <= 70) && !(hex >= 97 && hex <= 102))
        throw new SourceError("protocol", "Qwen JSON has an invalid Unicode escape");
    }
  }
  throw new SourceError("protocol", "Qwen JSON has an unterminated string");
}

function scalar(bytes: Uint8Array, from: number, to: number): unknown {
  try {
    return JSON.parse(decoder.decode(bytes.subarray(from, to)));
  } catch {
    throw new SourceError("protocol", "Qwen article list is not valid JSON");
  }
}

function takeValue(frame: Frame, value: unknown): void {
  if (frame.state !== "value" && frame.state !== "value-first")
    throw new SourceError("protocol", "Qwen JSON has an unexpected value");
  if (frame.role === "article" && (frame.key === "id" || frame.key === "title")) frame[frame.key] = value;
  frame.state = "comma";
}

function takeString(frame: Frame, bytes: Uint8Array, from: number, to: number): void {
  if (frame.state !== "key" && frame.state !== "key-first") {
    const wanted = frame.role === "article" && (frame.key === "id" || frame.key === "title");
    takeValue(frame, wanted ? scalar(bytes, from, to) : undefined);
    return;
  }
  frame.key = ["root", "data", "article"].includes(frame.role) ? (scalar(bytes, from, to) as string) : null;
  const selected =
    (frame.role === "root" && frame.key === "data") ||
    (frame.role === "data" && frame.key === "articles") ||
    (frame.role === "article" && (frame.key === "id" || frame.key === "title"));
  if (selected && frame.key !== null) {
    if (frame.selected.has(frame.key)) throw new SourceError("protocol", "Qwen JSON repeats a selected field");
    frame.selected.add(frame.key);
  }
  frame.state = "colon";
}

function openFrame(parent: Frame, array: boolean): Frame {
  const role =
    parent.role === "document" && !array
      ? "root"
      : parent.role === "root" && parent.key === "data" && !array
        ? "data"
        : parent.role === "data" && parent.key === "articles" && array
          ? "articles"
          : parent.role === "articles" && !array
            ? "article"
            : "ignored";
  takeValue(parent, undefined);
  return { role, array, state: array ? "value-first" : "key-first", key: null, selected: new Set() };
}

/**
 * The article index carries 4.78 MB, 99% of it full post text. Only ids and titles are observed.
 * Scan UTF-8 bytes so neither a decoded copy of the response nor its content strings are allocated.
 * JSON structure, discarded string escapes and completeness are still checked: a cut-short body
 * must fail the observation instead of making the remaining posts look withdrawn.
 */
export function qwenPosts(bytes: Uint8Array): RecordData[] {
  if (!isUtf8(bytes)) throw new SourceError("protocol", "Qwen article list is not valid UTF-8");
  const frames: Frame[] = [{ role: "document", array: true, state: "value", key: null, selected: new Set() }];
  const records: RecordData[] = [];
  let articles = false;
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at] ?? -1;
    const frame = frames.at(-1);
    if (!frame) throw new SourceError("protocol", "Qwen JSON has an unexpected end");
    if (SPACE.has(byte)) continue;
    if (byte === 34) {
      const end = stringEnd(bytes, at);
      takeString(frame, bytes, at, end);
      at = end - 1;
    } else if (byte === 123 || byte === 91) {
      if (frames.length >= 128) throw new SourceError("protocol", "Qwen JSON exceeds the nesting limit");
      const next = openFrame(frame, byte === 91);
      if (next.role === "articles") articles = true;
      frames.push(next);
    } else if (byte === 125 || byte === 93) {
      if (
        frames.length === 1 ||
        frame.array !== (byte === 93) ||
        !["comma", "key-first", "value-first"].includes(frame.state)
      )
        throw new SourceError("protocol", "Qwen JSON has an unexpected closing delimiter");
      frames.pop();
      if (frame.role === "article" && typeof frame.id === "string" && typeof frame.title === "string")
        records.push({ id: frame.id, name: frame.title, maker: "Qwen", url: `https://qwen.ai/blog?id=${frame.id}` });
    } else if (byte === 58) {
      if (frame.state !== "colon") throw new SourceError("protocol", "Qwen JSON has an unexpected colon");
      frame.state = "value";
    } else if (byte === 44) {
      if (frames.length === 1 || frame.state !== "comma")
        throw new SourceError("protocol", "Qwen JSON has an unexpected comma");
      frame.state = frame.array ? "value" : "key";
    } else {
      let end = at + 1;
      while (end < bytes.length && !SPACE.has(bytes[end] ?? -1) && ![44, 125, 93].includes(bytes[end] ?? -1)) end++;
      takeValue(frame, scalar(bytes, at, end));
      at = end - 1;
    }
  }
  if (frames.length !== 1 || frames[0]?.state !== "comma") throw new SourceError("protocol", "Qwen JSON is incomplete");
  if (!articles) throw new SourceError("missing-content", "qwen.ai returned no article list");
  return records;
}

export async function collectQwenBlog(request: Fetch = fetch): Promise<Collection> {
  const response = await fetchResponse(QWEN_BLOG_URL, {}, request);
  await requireOk(response);
  const records = qwenPosts(await readResponseBytes(response));
  if (!records.length) throw new SourceError("missing-content", "Qwen's pages list no model");
  return {
    source: "qwen-blog",
    stream: "github",
    url: QWEN_BLOG_URL,
    raw: records
      .map((record) => record.id)
      .sort()
      .join("\n"),
    records,
  };
}
