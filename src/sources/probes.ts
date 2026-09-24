import type { Collection, RecordData } from "../events/types.js";
import type { Fetch } from "../http-client.js";

/**
 * Asking a documentation site for a model that has not been announced.
 *
 * Every other source here waits to be told. These four ask: a vendor writes the page for a model
 * before it says the model exists, and the page answers 200 to anyone who guesses its address
 * while no link anywhere points at it. Measured on 2026-09-24: `platform.claude.com`'s
 * `/docs/en/models/opus-5-5/overview` answers 200 and `opus-9-9` answers 404;
 * `ai.google.dev/gemini-api/docs/models/<slug>` answers 104 KB against an 83 KB not-found;
 * `platform.openai.com/docs/models/gpt-6-luna` answers 200 and a nonsense slug 404; and
 * `opencode.ai/data/<maker>/<slug>` renders "Completed sessions" only for a model it actually has.
 *
 * Nothing here defeats a protection: these are plain GETs with a browser's user agent, and a site
 * that answers a challenge instead of a page simply yields no candidate. The guesses are versions
 * of families the vendor already ships, so the request rate is a handful of addresses per poll.
 *
 * Each probe is a `discovery:` source, which makes every hit a radar sighting and never a
 * catalogue: a page is evidence that a name exists, not that the model is out.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** A family the vendor ships today, and the version its documentation is written for. */
type Family = { family: string; version: readonly [number, number] };

/**
 * The versions a vendor could publish next. A maker moves a minor ("5.5" after "5.4"), a major
 * ("6"), or opens the next major at its half step ("6.5"), and nothing else has been seen: the
 * guess list stays at three per family so a poll is three requests, not a crawl.
 */
function nextVersions([major, minor]: readonly [number, number]): (readonly [number, number])[] {
  return [
    [major, minor + 1],
    [major + 1, 0],
    [major + 1, 5],
  ];
}

export type Site = {
  id: string;
  vendor: string;
  families: readonly Family[];
  /** How the site spells one guess: the slug it would live at. */
  slug: (family: string, version: readonly [number, number]) => string;
  /**
   * A model the site certainly documents. A probe whose every guess is a 404 looks the same whether
   * nothing has shipped or the addresses moved, and the second is how a source dies quietly. The
   * control has to answer 200 or the poll is a failure, and the board says so.
   */
  control: string;
  /** Slugs that are not a version of anything -- a codename heard somewhere this tracker reads. */
  names?: readonly string[];
  url: (slug: string) => string;
};

/** A dotted version, with the trailing `.0` dropped the way makers write it: `6`, `5.5`, `6.5`. */
function dotted([major, minor]: readonly [number, number]): string {
  return minor === 0 ? String(major) : `${major}.${minor}`;
}

/**
 * The three sites answer 404 for a slug they do not have and 200 for one they do, checked against
 * both a live model and a nonsense name on 2026-09-24. The status is the whole test: no body is
 * parsed, so a redesign of the page cannot turn a miss into a sighting.
 */
export const PROBE_SITES: readonly Site[] = [
  {
    id: "discovery:docs-openai",
    vendor: "OpenAI",
    // OpenAI names a model and versions it: `gpt-5.6-cyber` beside `gpt-6-astra`. Only the numbers
    // can be guessed, so the codenames are asked for by name instead.
    families: [{ family: "gpt", version: [5, 6] }],
    slug: (family, version) => `${family}-${dotted(version)}`,
    control: "gpt-6-astra",
    names: ["gpt-6.1", "gpt-6.5", "gpt-7", "gpt-6-nova", "gpt-6-vega", "gpt-6-orion"],
    url: (slug) => `https://platform.openai.com/docs/models/${slug}`,
  },
  {
    id: "discovery:docs-anthropic",
    vendor: "Anthropic",
    families: [
      { family: "opus", version: [5, 5] },
      { family: "sonnet", version: [5, 0] },
      { family: "haiku", version: [4, 5] },
    ],
    slug: (family, [major, minor]) => (minor === 0 ? `${family}-${major}` : `${family}-${major}-${minor}`),
    control: "opus-5-5",
    url: (slug) => `https://platform.claude.com/docs/en/models/${slug}/overview`,
  },
  {
    id: "discovery:docs-google",
    vendor: "Google",
    // Google's slug carries the tier: `gemini-3.8-flash`, `gemini-3.1-pro-preview`.
    families: [
      { family: "gemini-#-pro", version: [3, 8] },
      { family: "gemini-#-flash", version: [3, 8] },
      { family: "gemini-#-flash-lite", version: [3, 8] },
    ],
    slug: (family, version) => family.replace("#", dotted(version)),
    control: "gemini-3.8-flash",
    url: (slug) => `https://ai.google.dev/gemini-api/docs/models/${slug}`,
  },
];

/**
 * One address, asked the way a browser asks.
 *
 * Google bounces the first request to a silent sign-in and back, and refuses to stop bouncing until
 * the cookie it set comes back: a plain follow-redirects fetch gives up with "redirected too many
 * times" on every slug, real or not. So the redirects are walked by hand with a jar that lives for
 * one poll. Nothing is logged in to; the cookie is the anonymous one the site hands out.
 */
async function probe(url: string, request: Fetch, jar: Map<string, string>): Promise<{ status: number; body: string }> {
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await request(next, {
      headers: { "user-agent": USER_AGENT, accept: "text/html", ...(cookie ? { cookie } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [name, value] = (header.split(";")[0] ?? "").split("=");
      if (name && value) jar.set(name.trim(), value);
    }
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      next = new URL(location, next).toString();
      continue;
    }
    return { status: response.status, body: await response.text() };
  }
  throw new Error(`${url}: redirected past six hops`);
}

/** Every unannounced address a site answers for. Nothing is stored for a 404, which is the usual answer. */
export async function collectDocsProbe(site: Site, request: Fetch = fetch): Promise<Collection> {
  const candidates = new Set<string>();
  for (const { family, version } of site.families)
    for (const next of nextVersions(version)) candidates.add(site.slug(family, next));
  for (const name of site.names ?? []) candidates.add(name);
  candidates.delete(site.control);
  const records: RecordData[] = [];
  const tried: Record<string, number> = {};
  const jar = new Map<string, string>();
  for (const slug of [...candidates].sort()) {
    const url = site.url(slug);
    const answer = await probe(url, request, jar).catch(() => null);
    if (!answer) continue;
    tried[slug] = answer.status;
    if (answer.status !== 200) continue;
    records.push({ id: slug, name: slug, url, maker: site.vendor, source: "documentation" });
  }
  const control = await probe(site.url(site.control), request, jar);
  if (control.status !== 200) throw new Error(`${site.id}: ${site.control} answered HTTP ${control.status}`);
  tried[site.control] = control.status;
  return {
    source: site.id,
    stream: "pages",
    url: site.url("*"),
    raw: tried,
    appendOnly: true,
    records,
  };
}

/**
 * OpenCode's data catalogue, which has pages no link reaches.
 *
 * `/data/meta` listed thirteen models on 2026-09-24 and `muse-spark-1.4-contributor` was not one of
 * them, while its page was live and full of session counts. The sitemap has no `/data` section and
 * the sibling dropdown repeats the thirteen, so the address is the only way in. `/data/unknown` is
 * where a model whose maker is not known yet lands -- the lab page says "No models matched this
 * lab" while `/data/unknown/space-bunny` was live -- which makes it the one place a stealth name
 * can be asked for by name.
 */
const OPENCODE_MAKERS = ["meta", "unknown", "anthropic", "openai", "google"] as const;

/** Names heard elsewhere -- a tweet, a router, a client -- that OpenCode may already have a page for. */
const OPENCODE_GUESSES: readonly { maker: string; slug: string }[] = [
  { maker: "meta", slug: "muse-spark-1-5-contributor" },
  { maker: "meta", slug: "muse-spark-2-contributor" },
  { maker: "unknown", slug: "space-bunny" },
  { maker: "unknown", slug: "sonoma-sky" },
  { maker: "unknown", slug: "stealth-model" },
];

function opencodeUrl(maker: string, slug: string): string {
  return `https://opencode.ai/data/${maker}/${slug}`;
}

/** A real data page counts sessions and shares tokens; the stub for a name it does not know does neither. */
function opencodeIsReal(body: string): boolean {
  return body.includes("Completed sessions") && body.includes("Token Share");
}

export async function collectOpenCodeData(request: Fetch = fetch): Promise<Collection> {
  const records: RecordData[] = [];
  const tried: Record<string, number> = {};
  const jar = new Map<string, string>();
  for (const { maker, slug } of OPENCODE_GUESSES) {
    if (!OPENCODE_MAKERS.includes(maker as (typeof OPENCODE_MAKERS)[number])) continue;
    const url = opencodeUrl(maker, slug);
    const answer = await probe(url, request, jar).catch(() => null);
    if (!answer) continue;
    tried[`${maker}/${slug}`] = answer.status;
    if (answer.status !== 200 || !opencodeIsReal(answer.body)) continue;
    records.push({
      id: `${maker}/${slug}`,
      name: slug,
      url,
      maker: maker === "unknown" ? null : maker,
      source: "opencode-data",
    });
  }
  return {
    source: "discovery:opencode-data",
    stream: "api-models",
    url: "https://opencode.ai/data",
    raw: tried,
    appendOnly: true,
    records,
  };
}
