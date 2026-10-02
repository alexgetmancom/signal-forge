import { expect, test } from "bun:test";
import { APT_REPOSITORIES, collectAptRepository, collectClaudeDownloads } from "../src/sources/desktop.js";
import { answering } from "./fixtures/answering.js";

test("an Anthropic download manifest that answers is a product, and the rest are 404s", async () => {
  const collection = await collectClaudeDownloads(
    answering({
      "https://downloads.claude.ai/claude-science/latest/manifest.json": JSON.stringify({
        version: "0.1.52",
        buildDate: "2026-09-22T23:17:30Z",
      }),
      "https://downloads.claude.ai/claude-cowork/latest/manifest.json": JSON.stringify({ version: "0.0.1" }),
    }),
  );
  expect(collection.records.map((record) => record.id)).toEqual(["claude-science", "claude-cowork"]);
  expect(collection.records[0]).toMatchObject({ version: "0.1.52", maker: "Anthropic" });
});

test("a download page that answers nothing at all is a failure, not an empty catalogue", async () => {
  await expect(collectClaudeDownloads(answering({}))).rejects.toThrow("not even Claude Science");
});

test("a Debian index is read for the newest build of the client", async () => {
  const claude = APT_REPOSITORIES.find((repository) => repository.source === "claude-desktop-apt");
  if (!claude) throw new Error("the Claude Desktop repository is gone");
  const index = [
    "Package: claude-desktop\nVersion: 2.2553.13\nSize: 173779072",
    "Package: claude-desktop\nVersion: 2.7032.0\nSize: 174864804",
    "Package: something-else\nVersion: 9.9.9\nSize: 1",
  ].join("\n\n");
  const collection = await collectAptRepository(
    claude,
    answering({
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages": index,
    }),
  );
  expect(collection.records[0]).toMatchObject({ version: "2.7032.0", versions: 2, bytes: 174864804 });
});

test("an index that stops naming the package is a failure, not a release", async () => {
  const chatgpt = APT_REPOSITORIES.find((repository) => repository.source === "chatgpt-desktop-apt");
  if (!chatgpt) throw new Error("the ChatGPT repository is gone");
  await expect(
    collectAptRepository(
      chatgpt,
      answering({
        "https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-amd64/Packages":
          "Package: gnome-calculator\nVersion: 1.0\n",
      }),
    ),
  ).rejects.toThrow("names no chatgpt");
});
