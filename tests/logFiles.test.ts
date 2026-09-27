import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogger, log } from "../src/logger.js";
import { parseOfficialFeed } from "../src/sources/feeds.js";

const dirs: string[] = [];
afterEach(() => {
  configureLogger(false);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("every line is kept in a daily file, redacted, beside the console", () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  dirs.push(dir);
  configureLogger(true, dir);
  log("warn", "Delivery settled", { deliveryId: 1, token: "secret-value" });
  const day = new Date().toISOString().slice(0, 10);
  const [line] = readFileSync(join(dir, `${day}.jsonl`), "utf8")
    .trim()
    .split("\n");
  const entry = JSON.parse(line ?? "{}");
  expect(entry.level).toBe("warn");
  expect(entry.message).toBe("Delivery settled");
  expect(entry.details).toEqual({ deliveryId: 1, token: "[REDACTED]" });
});

test("files past the retention window are removed and recent ones kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "2000-01-01.jsonl"), "{}\n");
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, `${recent}.jsonl`), "{}\n");
  writeFileSync(join(dir, "notes.txt"), "kept");
  configureLogger(true, dir);
  log("info", "first line of the day");
  expect(existsSync(join(dir, "2000-01-01.jsonl"))).toBe(false);
  expect(existsSync(join(dir, `${recent}.jsonl`))).toBe(true);
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
});

test("a rejected feed item logs its field, not the upstream value", () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-logs-"));
  dirs.push(dir);
  configureLogger(true, dir);
  const upstreamValue = "unexpected-signed-value";
  const feed = `<rss><channel><item><title>Valid</title><link>https://example.test/valid</link><pubDate>2026-09-15</pubDate></item><item><title>Invalid</title><link>https://example.test/invalid</link><pubDate>${upstreamValue}</pubDate></item></channel></rss>`;
  const parsed = parseOfficialFeed(feed, {
    source: "feed-test",
    maker: "Test",
    url: "https://example.test/feed.xml",
  });
  expect(parsed.records).toHaveLength(1);
  const line = readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  expect(line).not.toContain(upstreamValue);
  expect(JSON.parse(line).details).toEqual({
    source: "feed-test",
    index: 1,
    reason: "Official feed item has invalid publication date",
  });
});
