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
  /**
   * The one number the card is read for, drawn big on the right: a debut's place, how far a price
   * moved, the day a model is switched off. A launch has none; its name is the news.
   */
  hero?: { text: string; caption: string; color?: number };
  /** A week told as one picture: the makers that shipped and what, instead of a title and chips. */
  rows?: { vendor: string; logo: string | null; names: string[] }[];
};

const WIDTH = 1200;
const HEIGHT = 480;

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

/** Inter Display's advance is close to 0.56 em for mixed text; enough to size a pill or pick a font size. */
const textWidth = (text: string, size: number) => text.length * size * 0.56;

function titleSize(title: string, room = WIDTH - 144): number {
  for (const size of [104, 92, 80, 68, 58]) if (textWidth(title, size) <= room) return size;
  return 50;
}

function logoData(logo: string | null): string | null {
  if (!logo) return null;
  const bytes = readFileSync(fileURLToPath(new URL(`./logos/${logo}`, import.meta.url)));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Black and white makers glow in a neutral light rather than vanishing into the background. */
function glowOf(vendor: string, fallback = 0x5865f2): string {
  const brand = hex(vendorColor(vendor) ?? fallback);
  return brand === "#000000" || brand === "#ffffff" ? "#9aa4b8" : brand;
}

function backdrop(width: number, height: number, glow: string): string {
  return `<defs>
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
  <rect width="${width}" height="${height}" fill="url(#fade)"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${width}" height="6" fill="${glow}"/>`;
}

function bannerSvg(banner: Banner): string {
  if (banner.rows) return posterSvg(banner);
  const glow = glowOf(banner.vendor);
  const logo = logoData(banner.logo);
  const hero = banner.hero;
  const heroSize = hero ? Math.min(200, Math.floor(440 / (hero.text.length * 0.6))) : 0;
  const heroWidth = hero ? textWidth(hero.text, heroSize) * 1.08 : 0;
  const size = titleSize(banner.title, WIDTH - 144 - (hero ? heroWidth + 40 : 0));
  let x = 72;
  const chips = banner.chips.slice(0, 3).map((chip) => {
    const width = chip.length * 30 * 0.5 + 56;
    const pill = `<rect x="${x}" y="368" width="${width}" height="60" rx="30" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.16"/><text x="${x + 28}" y="408" font-family="Inter" font-weight="600" font-size="30" fill="#ffffff" fill-opacity="0.92">${xml(chip)}</text>`;
    x += width + 16;
    return pill;
  });
  // With a number on the right the tile shrinks into the corner above it.
  const tile = hero ? 88 : 132;
  const heroText = hero
    ? `<text x="${WIDTH - 72}" y="${HEIGHT - 96}" text-anchor="end" font-family="Inter Display" font-weight="700" font-size="${heroSize}" letter-spacing="-2" fill="${hex(hero.color ?? 0xffffff)}">${xml(hero.text)}</text>
  <text x="${WIDTH - 72}" y="${HEIGHT - 52}" text-anchor="end" font-family="Inter" font-weight="600" font-size="24" letter-spacing="3" fill="#ffffff" fill-opacity="0.55">${xml(hero.caption.toUpperCase())}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${backdrop(WIDTH, HEIGHT, glow)}
  ${logo ? `<image x="${WIDTH - 72 - tile}" y="${hero ? 52 : 64}" width="${tile}" height="${tile}" href="${logo}"/>` : ""}
  ${heroText}
  <text x="72" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <text x="72" y="${200 + size * 0.55}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1.5" fill="#ffffff">${xml(banner.title)}</text>
  ${chips.join("\n  ")}
</svg>`;
}

const POSTER_WIDTH = 1200;
/** Twitter shows a 16:9 picture whole; the week is the one image meant to be posted there. */
const POSTER_HEIGHT = 675;
/** Discord shows the poster at two thirds of its size; five makers is what stays legible there. */
const POSTER_ROWS = 5;
const POSTER_NAMES = 2;

/**
 * The week in one picture: how many models arrived, big, and beside it the makers that shipped them
 * with their tiles. The first draft listed seven makers in three columns of one weight and every
 * model by name; shrunk into Discord it read as a footnote. The rest of the week is in the text.
 */
function posterSvg(banner: Banner): string {
  const rows = (banner.rows ?? []).slice(0, POSTER_ROWS);
  const glow = glowOf(rows[0]?.vendor ?? "", 0x5865f2);
  const [count = "", ...label] = banner.title.split(" ");
  const left = 72;
  const column = 470;
  const tile = 76;
  const step = 104;
  const top = Math.round((POSTER_HEIGHT - rows.length * step) / 2) + 14;
  const room = POSTER_WIDTH - 72 - (column + tile + 28);
  const body = rows
    .map((row, index) => {
      const y = top + index * step;
      const logo = logoData(row.logo);
      // Fewer names before a cut one: "MiMo V2.6 Pro +2" rather than "MiMo V2.6 Pro, MiMo V2.6 Flas…".
      const fit = (count: number) =>
        row.names.slice(0, count).join(", ") + (row.names.length > count ? ` +${row.names.length - count}` : "");
      let names = fit(POSTER_NAMES);
      let size = 38;
      for (const [count, font] of [
        [POSTER_NAMES, 38],
        [POSTER_NAMES, 32],
        [1, 38],
        [1, 32],
      ] as const) {
        names = fit(count);
        size = font;
        if (textWidth(names, font) <= room) break;
      }
      if (textWidth(names, size) > room) names = `${names.slice(0, Math.floor(room / (size * 0.56)) - 1)}…`;
      return `${logo ? `<image x="${column}" y="${y}" width="${tile}" height="${tile}" href="${logo}"/>` : ""}
  <text x="${column + tile + 28}" y="${y + tile / 2 + size * 0.36}" font-family="Inter Display" font-weight="700" font-size="${size}" fill="#ffffff">${xml(names)}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" viewBox="0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}">
  ${backdrop(POSTER_WIDTH, POSTER_HEIGHT, glow)}
  <text x="${left}" y="130" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <text x="${left - 8}" y="400" font-family="Inter Display" font-weight="700" font-size="${count.length > 2 ? 190 : 250}" letter-spacing="-8" fill="#ffffff">${xml(count)}</text>
  <text x="${left}" y="476" font-family="Inter Display" font-weight="700" font-size="54" fill="#ffffff" fill-opacity="0.85">${xml(label.join(" "))}</text>
  ${banner.chips[0] ? `<text x="${left}" y="560" font-family="Inter" font-weight="600" font-size="28" fill="#ffffff" fill-opacity="0.55">${xml(banner.chips[0])}</text>` : ""}
  ${body}
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
    fitTo: { mode: "width", value: banner.rows ? POSTER_WIDTH : WIDTH },
  });
  return image.render().asPng();
}
