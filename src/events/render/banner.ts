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
  /** A light of its own, for a card with no maker to take one from: a stealth launch. */
  glow?: number;
  /** A week told as one picture: the makers that shipped and what, instead of a title and chips. */
  rows?: { vendor: string; logo: string | null; names: string[] }[];
  /**
   * A person's words as the picture: the post big, their photo in the corner. A promise carries
   * when it is due, and the hours left are counted when the picture is drawn, not when it was queued.
   */
  quote?: { by: string; portrait: string; due?: number; accent?: number };
  /**
   * A change as the line that changed: documentation, a changelog and an interface string are read
   * for one sentence, and until now they went out as a title over our own bookkeeping. The mark
   * says whether the line arrived or moved, and the footing says where it is.
   */
  change?: { mark: "+" | "±"; where: string };
  /**
   * The maker's mark, drawn huge and nearly invisible behind the words, bleeding off the lower right
   * so its tile has no edge inside the frame. Off unless a card asks for it: a watermark that misses
   * is worse than none, so it is a field rather than something every banner gets.
   */
  watermark?: { opacity: number; size: number };
  /**
   * A model nobody has claimed, which is the one card with no maker to take a colour or a tile
   * from. It gets a picture of its own instead of a violet copy of a launch: black, lit from one
   * point off the frame, with the question thrown onto it by that light.
   */
  stealth?: true;
};

const WIDTH = 1200;
const HEIGHT = 480;
/**
 * The maker's colour down the left edge rather than across the top. Discord draws its own stripe at
 * the left of an embed, and the two line up into one unbroken column from the title to the foot of
 * the picture: the card reads as one object instead of text with a picture stuck under it.
 */
const STRIPE = 14;
/** Everything the card says starts clear of the stripe. */
const LEFT = 110;

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
  return lit(hex(vendorColor(vendor) ?? fallback));
}

/**
 * A colour the backdrop cannot show. Near-white and near-black are honest about OpenAI, xAI and
 * Moonshot, who have no colour, and both read as no glow at all on a dark card: beside Anthropic's
 * orange they looked like a card that had failed to draw. Platinum keeps the brand black and white
 * and lights it like brushed metal, which is what half the channel's launches are lit by.
 */
const PLATINUM = "#c8d2e0";
const ACHROMATIC = new Set(["#e6e6e6", "#000000", "#ffffff"]);
function lit(colour: string): string {
  return ACHROMATIC.has(colour) ? PLATINUM : colour;
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
  <rect x="0" y="0" width="${STRIPE}" height="${height}" fill="${glow}"/>`;
}

/**
 * The mark behind the words. It is the same tile the corner carries, scaled past the frame and
 * faded until it is texture rather than a logo: a picture with a second, readable logo in it is a
 * poster for the maker, and this is a publication's card about the maker.
 */
function watermarkLayer(logo: string | null, watermark: Banner["watermark"]): string {
  if (!logo) return "";
  const { opacity, size } = watermark ?? { opacity: 0.05, size: 640 };
  if (opacity <= 0) return "";
  return `<defs>
    <radialGradient id="feather" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <mask id="feathered"><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#feather)"/></mask>
  </defs>
  <g mask="url(#feathered)"><image x="${WIDTH - size * 0.62}" y="${HEIGHT - size * 0.58}" width="${size}" height="${size}" href="${logo}" opacity="${opacity}"/></g>`;
}

/**
 * The last word of a name in the maker's own colour: "Claude Opus 5.5" is read for the 5.5, and a
 * card that says which one this is in one glance is a card somebody screenshots. A maker whose
 * colour is black or white lends none, so the tail takes a cool grey that reads against the title.
 */
const COOL = "#8ea3bd";
function titleText(title: string, size: number, glow: string, vendor: string): string {
  const tail = ACHROMATIC.has(hex(vendorColor(vendor) ?? 0)) ? COOL : glow;
  const cut = title.lastIndexOf(" ");
  const body =
    cut < 1 ? xml(title) : `${xml(title.slice(0, cut + 1))}<tspan fill="${tail}">${xml(title.slice(cut + 1))}</tspan>`;
  return `<text x="${LEFT}" y="${200 + size * 0.55}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1.5" fill="#ffffff">${body}</text>`;
}

function signatureText(signature: string | undefined, taken: boolean): string {
  // A number in the corner has that corner; the picture keeps its subject and loses the signature.
  if (!signature || taken) return "";
  // On the chips' own baseline, at their size: a fourth item in that row rather than a watermark
  // dropped under it. Discord shows a banner about 470px wide, where anything smaller is lost.
  return `<text x="${WIDTH - 72}" y="408" text-anchor="end" font-family="Inter" font-weight="600" font-size="30" letter-spacing="0.5" fill="#ffffff" fill-opacity="0.5">${xml(signature)}</text>`;
}

/** Green for a line that arrived, amber for one that moved: the colours a diff is read in. */
const MARK_COLORS = { "+": "#3ddc84", "±": "#f1c40f" } as const;

/** The line that changed, quoted big, with the maker's tile and where the line lives underneath. */
function changeSvg(banner: Banner, change: NonNullable<Banner["change"]>, signature?: string): string {
  const glow = banner.glow === undefined ? glowOf(banner.vendor) : lit(hex(banner.glow));
  const logo = logoData(banner.logo);
  const tile = 132;
  const mark = MARK_COLORS[change.mark];
  const { size, lines } = wrap(banner.title, WIDTH - 144 - tile - 80);
  const step = size * 1.14;
  const top = 176 + size;
  const rule = size + (lines.length - 1) * step + 18;
  const text = lines
    .map(
      (line, index) =>
        `<text x="${LEFT + 40 + size * 0.8}" y="${top + index * step}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1" fill="#ffffff">${xml(line)}</text>`,
    )
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${backdrop(WIDTH, HEIGHT, glow)}
  ${logo ? `<image x="${WIDTH - 72 - tile}" y="64" width="${tile}" height="${tile}" href="${logo}"/>` : ""}
  <text x="${LEFT}" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <rect x="${LEFT}" y="${top - size - 6}" width="6" height="${rule}" rx="3" fill="${mark}" fill-opacity="0.9"/>
  <text x="${LEFT + 40}" y="${top - size * 0.22}" font-family="Inter Display" font-weight="700" font-size="${size}" fill="${mark}">${change.mark}</text>
  ${text}
  ${change.where ? `<text x="${LEFT}" y="${HEIGHT - 52}" font-family="Inter" font-weight="600" font-size="26" fill="#ffffff" fill-opacity="0.55">${xml(change.where)}</text>` : ""}
  ${signature ? `<text x="${WIDTH - 72}" y="${HEIGHT - 52}" text-anchor="end" font-family="Inter" font-weight="600" font-size="30" letter-spacing="0.5" fill="#ffffff" fill-opacity="0.5">${xml(signature)}</text>` : ""}
</svg>`;
}

const VIOLET = "#8b5cf6";

/**
 * The question as a shape rather than a stroke: thick where a pen would press, thin where it would
 * lift, terminals cut. An even-width, round-capped stroke is an interface icon, and an interface
 * icon thrown up twelve times reads as exactly that.
 */
const QUESTION = `<path d="M18 78 C18 26, 60 -2, 104 -2 C152 -2, 188 26, 188 76 C188 118, 156 136, 134 154
 C120 166, 116 176, 116 196 L72 196 C72 164, 80 148, 100 130 C124 108, 142 98, 142 72
 C142 46, 126 34, 102 34 C76 34, 62 50, 62 78 Z"/>
 <circle cx="94" cy="238" r="25"/>`;

/**
 * The ordinary card with one substitution: where every other banner carries its maker's tile, this
 * one carries a question. A stealth launch has no maker, and that absence is the news, so it is
 * said in the place a reader already looks for who made the thing -- not as a separate scene.
 */
function stealthSvg(banner: Banner, signature?: string): string {
  const size = titleSize(banner.title, WIDTH - 200 - 260);
  let x = LEFT;
  const chips = banner.chips
    .slice(0, 3)
    .map((chip) => {
      const width = chip.length * 30 * 0.5 + 56;
      const pill = `<rect x="${x}" y="368" width="${width}" height="60" rx="30" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.14"/><text x="${x + 28}" y="408" font-family="Inter" font-weight="600" font-size="30" fill="#ffffff" fill-opacity="0.88">${xml(chip)}</text>`;
      x += width + 16;
      return pill;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121018"/><stop offset="1" stop-color="#08070c"/></linearGradient>
    <radialGradient id="lamp" cx="0.92" cy="0.05" r="0.95"><stop offset="0" stop-color="${VIOLET}" stop-opacity="0.55"/><stop offset="0.55" stop-color="${VIOLET}" stop-opacity="0.10"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></radialGradient>
    <mask id="asked"><rect width="132" height="132" fill="#ffffff"/><g fill="#000000" transform="translate(25,14) scale(0.4)">${QUESTION}</g></mask>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#fade)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#lamp)"/>
  <g transform="translate(${WIDTH - 204},64)"><rect width="132" height="132" rx="30" fill="${VIOLET}" mask="url(#asked)"/></g>
  <rect width="${STRIPE}" height="${HEIGHT}" fill="${VIOLET}"/>
  <text x="${LEFT}" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <text x="${LEFT}" y="${214 + size * 0.55}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1.5" fill="#ffffff">${xml(banner.title)}</text>
  ${chips}
  ${signature ? `<text x="${WIDTH - 72}" y="408" text-anchor="end" font-family="Inter" font-weight="600" font-size="30" fill="#ffffff" fill-opacity="0.38">${xml(signature)}</text>` : ""}
</svg>`;
}

function bannerSvg(banner: Banner, signature?: string): string {
  if (banner.stealth) return stealthSvg(banner, signature);
  if (banner.rows) return posterSvg(banner);
  if (banner.quote) return quoteSvg(banner, banner.quote);
  if (banner.change) return changeSvg(banner, banner.change, signature);
  const glow = banner.glow === undefined ? glowOf(banner.vendor) : lit(hex(banner.glow));
  const logo = logoData(banner.logo);
  const hero = banner.hero;
  const heroSize = hero ? Math.min(200, Math.floor(440 / (hero.text.length * 0.6))) : 0;
  const heroWidth = hero ? textWidth(hero.text, heroSize) * 1.08 : 0;
  const size = titleSize(banner.title, WIDTH - 144 - (hero ? heroWidth + 40 : 0));
  let x = LEFT;
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
  ${watermarkLayer(logo, banner.watermark)}
  ${logo ? `<image x="${WIDTH - 72 - tile}" y="${hero ? 52 : 64}" width="${tile}" height="${tile}" href="${logo}"/>` : ""}
  ${heroText}
  <text x="${LEFT}" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  ${titleText(banner.title, size, glow, banner.vendor)}
  ${chips.join("\n  ")}
  ${signatureText(signature, Boolean(hero))}
</svg>`;
}

/**
 * Words broken into lines no wider than `room`, at the largest size whose lines fit between the
 * eyebrow and the name under them: three lines at the size of a launch's title ran into the name.
 */
const QUOTE_TOP = 160;
const QUOTE_BOTTOM = 372;

function wrap(text: string, room: number): { size: number; lines: string[] } {
  for (const size of [76, 66, 58, 50, 44]) {
    const lines: string[] = [];
    for (const word of text.split(/\s+/)) {
      const last = lines.at(-1);
      // Inter Display Bold runs nearer half an em, as the poster's rows measure it.
      if (last !== undefined && `${last} ${word}`.length * size * 0.5 <= room)
        lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    const fits = QUOTE_TOP + size + (lines.length - 1) * size * 1.14 <= QUOTE_BOTTOM;
    if (fits || size === 44) return { size, lines: lines.slice(0, 3) };
  }
  return { size: 44, lines: [text] };
}

const two = (value: number) => String(value).padStart(2, "0");

function quoteSvg(banner: Banner, quote: NonNullable<Banner["quote"]>): string {
  const glow = quote.accent ? hex(quote.accent) : glowOf(banner.vendor);
  const photo = logoData(quote.portrait);
  const tile = 150;
  const px = WIDTH - 72 - tile;
  const { size, lines } = wrap(`“${banner.title}”`, WIDTH - 144 - tile - 40);
  const step = size * 1.14;
  const top = QUOTE_TOP + size;
  const text = lines
    .map(
      (line, index) =>
        `<text x="${LEFT}" y="${top + index * step}" font-family="Inter Display" font-weight="700" font-size="${size}" letter-spacing="-1" fill="#ffffff">${xml(line)}</text>`,
    )
    .join("\n  ");
  let hero = "";
  if (quote.due !== undefined) {
    const minutes = Math.round((quote.due * 1000 - Date.now()) / 60_000);
    const left = minutes <= 0 ? "now" : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
    const at = new Date(quote.due * 1000);
    hero = `<text x="${WIDTH - 72}" y="${HEIGHT - 84}" text-anchor="end" font-family="Inter Display" font-weight="700" font-size="84" letter-spacing="-2" fill="#ffffff">${xml(minutes <= 0 ? left : `in ${left}`)}</text>
  <text x="${WIDTH - 72}" y="${HEIGHT - 46}" text-anchor="end" font-family="Inter" font-weight="600" font-size="22" letter-spacing="3" fill="#ffffff" fill-opacity="0.55">RESETS AT ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${backdrop(WIDTH, HEIGHT, glow)}
  <defs><clipPath id="portrait"><circle cx="${px + tile / 2}" cy="${64 + tile / 2}" r="${tile / 2}"/></clipPath></defs>
  ${photo ? `<image x="${px}" y="64" width="${tile}" height="${tile}" href="${photo}" clip-path="url(#portrait)" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <circle cx="${px + tile / 2}" cy="${64 + tile / 2}" r="${tile / 2 + 3}" fill="none" stroke="${glow}" stroke-width="5"/>
  <text x="${LEFT}" y="118" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  ${text}
  <text x="${LEFT}" y="${HEIGHT - 56}" font-family="Inter" font-weight="600" font-size="32" fill="#ffffff" fill-opacity="0.8">— ${xml(quote.by)}</text>
  ${hero}
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
  const size = 36;
  // The list starts where the dates do, so the two columns share a top edge.
  const top = 92;
  const room = POSTER_WIDTH - 72 - (column + tile + 28);
  const body = rows
    .map((row, index) => {
      const y = top + index * step;
      const logo = logoData(row.logo);
      // Fewer names before a cut one, and one size for every row: a row that shrank to fit read as a footnote.
      const fit = (count: number) =>
        row.names.slice(0, count).join(", ") + (row.names.length > count ? ` +${row.names.length - count}` : "");
      // Inter Display Bold runs nearer half an em than the 0.56 that sizes a title with room to spare.
      const width = (text: string) => text.length * size * 0.5;
      let names = width(fit(POSTER_NAMES)) <= room ? fit(POSTER_NAMES) : fit(1);
      if (width(names) > room) names = `${names.slice(0, Math.floor(room / (size * 0.5)) - 1)}…`;
      return `${logo ? `<image x="${column}" y="${y}" width="${tile}" height="${tile}" href="${logo}"/>` : ""}
  <text x="${column + tile + 28}" y="${y + tile / 2 + size * 0.36}" font-family="Inter Display" font-weight="700" font-size="${size}" fill="#ffffff">${xml(names)}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" viewBox="0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}">
  ${backdrop(POSTER_WIDTH, POSTER_HEIGHT, glow)}
  <text x="${left}" y="${top + tile / 2 + 10}" font-family="Inter" font-weight="600" font-size="28" letter-spacing="4" fill="#ffffff" fill-opacity="0.6">${xml(banner.eyebrow.toUpperCase())}</text>
  <text x="${left - 8}" y="400" font-family="Inter Display" font-weight="700" font-size="${count.length > 2 ? 190 : 250}" letter-spacing="-8" fill="#ffffff">${xml(count)}</text>
  <text x="${left}" y="476" font-family="Inter Display" font-weight="700" font-size="54" fill="#ffffff" fill-opacity="0.85">${xml(label.join(" "))}</text>
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

export async function bannerPng(banner: Banner, signature?: string): Promise<Uint8Array> {
  await start();
  const image = new Resvg(bannerSvg(banner, signature), {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: banner.rows ? POSTER_WIDTH : WIDTH },
  });
  return image.render().asPng();
}
