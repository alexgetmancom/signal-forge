import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A card shows who made the thing on the right and where it was seen beside the eyebrow. The PNGs
 * live beside this file and travel with the message as attachments: a stored delivery carries only
 * `attachment://<name>.png`, and the bytes are read when it is sent, so a queued body stays text.
 *
 * A maker without a logo gets none, and neither does Unknown: a logo is a claim about identity.
 */
const VENDOR_LOGOS: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  xAI: "xai",
  DeepSeek: "deepseek",
  Qwen: "qwen",
  NVIDIA: "nvidia",
  Moonshot: "moonshot",
  "Z.ai": "zai",
  Meta: "meta",
  Mistral: "mistral",
  MiniMax: "minimax",
  ByteDance: "bytedance",
  Tencent: "tencent",
  Xiaomi: "xiaomi",
};

/**
 * Each maker's own colour, for the stripe beside a card that introduces one of its models. The
 * logos are the same colour tiles, so the stripe and the corner read as one brand in a screenshot.
 */
const VENDOR_COLORS: Record<string, number> = {
  // Discord reads a colour of 0 as none and draws its default grey; this is black on screen.
  OpenAI: 0x0a0a0a,
  Anthropic: 0xd97757,
  Google: 0x4285f4,
  xAI: 0xffffff,
  DeepSeek: 0x4d6bfe,
  Qwen: 0x615ced,
  NVIDIA: 0x76b900,
  Moonshot: 0x0a0a0a,
  "Z.ai": 0x1f63ec,
  Meta: 0x0668e1,
  Mistral: 0xfa520f,
  MiniMax: 0xe73562,
  ByteDance: 0x325ab4,
  Tencent: 0x0052d9,
  Xiaomi: 0xff6900,
};

export function vendorColor(vendor: string): number | null {
  return VENDOR_COLORS[vendor] ?? null;
}

const SOURCE_LOGOS: [RegExp, string][] = [
  [/^openrouter(?:-usage)?$/, "openrouter"],
  [/^arena(?:-leaderboards)?$/, "arena"],
  [/^(?:discovery:)?huggingface[-:]/, "huggingface"],
  [/^designarena:/, "designarena"],
  [/^cursor-/, "cursor"],
  [/^gemini(?:-|$)|^app:ios:gemini$/, "gemini"],
];

const ATTACHMENT = /attachment:\/\/([a-z0-9-]+\.png)/g;

export function vendorLogo(vendor: string): string | null {
  const name = VENDOR_LOGOS[vendor];
  return name ? `attachment://${name}.png` : null;
}

export function sourceLogo(source: string): string | null {
  const name = SOURCE_LOGOS.find(([pattern]) => pattern.test(source))?.[1];
  return name ? `attachment://${name}.png` : null;
}

/** The logo files a Discord payload refers to, each once however many cards on the page share it. */
export function logoFiles(payload: unknown): { filename: string; content: Uint8Array }[] {
  const names = new Set([...JSON.stringify(payload).matchAll(ATTACHMENT)].map((match) => match[1] as string));
  // A launch banner is an attachment too, drawn at send time rather than kept here.
  return [...names].flatMap((filename) => {
    const path = fileURLToPath(new URL(`./logos/${filename}`, import.meta.url));
    return existsSync(path) ? [{ filename, content: readFileSync(path) }] : [];
  });
}
