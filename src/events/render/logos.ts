import { readFileSync } from "node:fs";
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
};

const SOURCE_LOGOS: [RegExp, string][] = [
  [/^openrouter(?:-usage)?$/, "openrouter"],
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
  return [...names].map((filename) => ({
    filename,
    content: readFileSync(fileURLToPath(new URL(`./logos/${filename}`, import.meta.url))),
  }));
}
