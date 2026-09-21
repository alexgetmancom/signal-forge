import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { vendorColor } from "./logos.js";

/**
 * The picture on a launch card. A launch is the message people screenshot and post elsewhere, and
 * a card of grey text reads as a log line there; the banner says the one thing -- this model is
 * out, from this maker, with this much context at this price -- in a form that survives a
 * screenshot.
 *
 * A stored delivery carries only the banner's words (`banners` beside the embeds); the picture is
 * drawn when the message is sent, as the logos are read then, so a queued body stays text.
 */
export type Banner = {
  filename: string;
  eyebrow: string;
  title: string;
  chips: string[];
  vendor: string;
  logo: string | null;
};

const WIDTH = 1200;
const HEIGHT = 480;

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

/** Inter Display's advance is close to 0.56 em for mixed text; enough to size a pill or pick a font size. */
const textWidth = (text: string, size: number) => text.length * size * 0.56;

function titleSize(title: string): number {
  for (const size of [104, 92, 80, 68, 58]) if (textWidth(title, size) <= WIDTH - 144) return size;
  return 50;
}

function logoData(logo: string | null): string | null {
  if (!logo) return null;
  const bytes = readFileSync(fileURLToPath(new URL(`./logos/${logo}`, import.meta.url)));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function bannerSvg(banner: Banner): string {
  const brand = hex(vendorColor(banner.vendor) ?? 0x5865f2);
  // Black and white makers glow in a neutral light rather than vanishing into the background.
  const glow = brand === "#000000" || brand === "#ffffff" ? "#9aa4b8" : brand;
  const logo = logoData(banner.logo);
  const size = titleSize(banner.title);
  let x = 72;
  const chips = banner.chips.slice(0, 3).map((chip) => {
    const width = chip.length * 30 * 0.5 + 56;
    const pill = `<rect x="${x}" y="368" width="${width}" height="60" rx="30" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.16"/><text x="${x + 28}" y="408" font-family="Inter" font-weight="600" font-size="30" fill="#ffffff" fill-opacity="0.92">${xml(chip)}</text>`;
    x += width + 16;
    return pill;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="0.92" cy="0.05" r="0.95">
      <stop offset="0" stop-color="${glow}" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="${glow}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#15171c"/>
      <stop offset="1" stop-color="#0b0c0f"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#fade)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${WIDTH}" height="6" fill="${glow}"/>
  ${logo ? `<image x="${WIDTH - 72 - 132}" y="64" width="132" height="132" href="${logo}"/>` : ""}
  <text x="72" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <text x="72" y="${200 + size * 0.55}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1.5" fill="#ffffff">${xml(banner.title)}</text>
  ${chips.join("\n  ")}
</svg>`;
}

let ready: Promise<void> | null = null;
let fonts: Uint8Array[] = [];

function start(): Promise<void> {
  if (!ready) {
    const require = createRequire(import.meta.url);
    ready = initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    fonts = ["InterDisplay-Bold.ttf", "Inter-SemiBold.ttf"].map(
      (file) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)))),
    );
  }
  return ready;
}

export async function bannerPng(banner: Banner): Promise<Uint8Array> {
  await start();
  const image = new Resvg(bannerSvg(banner), {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: WIDTH },
  });
  return image.render().asPng();
}
