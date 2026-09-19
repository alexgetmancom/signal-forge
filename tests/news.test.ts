import { expect, test } from "bun:test";
import { readMessage } from "../src/news.js";

test("a Discord body reads as its headline and embeds, without the transport", () => {
  const body = JSON.stringify({
    content: "🗞 Hourly digest · 2 stories\n<@&123>",
    embeds: [
      {
        author: { name: "OFFICIAL NEWS · OPENAI" },
        title: "🆕 GPT-6",
        description: "Out now.",
        url: "https://openai.com/x",
      },
      { author: { name: "ARENA" }, title: "🆕 parsley" },
    ],
  });
  expect(readMessage(body)).toEqual({
    headline: "🗞 Hourly digest · 2 stories",
    items: [
      { label: "OFFICIAL NEWS · OPENAI", title: "🆕 GPT-6", description: "Out now.", url: "https://openai.com/x" },
      { label: "ARENA", title: "🆕 parsley", description: null, url: null },
    ],
  });
});

test("a text card reads as its title, details and link, without tags or footer", () => {
  const body =
    "📡 Updates · OpenRouter · 1\n#OpenRouter #Models\n\n✏️ MiniMax: MiniMax M1\n\nInput: $0.4 → $0.55 / 1M tokens\nhttps://openrouter.ai/minimax/minimax-m1\nSignal Forge · 08 Sept, 14:09 UTC · #30";
  expect(readMessage(body)).toEqual({
    headline: "📡 Updates · OpenRouter · 1",
    items: [
      {
        label: null,
        title: "✏️ MiniMax: MiniMax M1",
        description: "Input: $0.4 → $0.55 / 1M tokens",
        url: "https://openrouter.ai/minimax/minimax-m1",
      },
    ],
  });
});
