import type { Database } from "bun:sqlite";
import type { Collection, RecordData } from "../events/types.js";
import { SourceError } from "../failure.js";
import type { Fetch } from "../http-client.js";
import { readLatestSnapshot } from "../storage/snapshots.js";
import { USER_AGENT } from "./http.js";
import type { Vendor } from "./vendors.js";

/**
 * Asking a documentation site for a model that has not been announced.
 *
 * Every other source here waits to be told. These four ask: a vendor writes the page for a model
 * before it says the model exists, and the page answers 200 to anyone who guesses its address
 * while no link anywhere points at it. Measured on 2026-09-24: `platform.claude.com`'s
 * `/docs/en/models/opus-5-5/overview` answers 200 and `opus-9-9` answers 404;
 * `ai.google.dev/gemini-api/docs/models/<slug>` answers 104 KB against an 83 KB not-found; and
 * `platform.openai.com/docs/models/gpt-6-luna` answers 200 and a nonsense slug 404. On 2026-09-27
 * `z.ai/blog/<model>` answered 200 for `glm-5.3` and 404 for `glm-5.4`, which is a maker whose
 * announcement is the address of the model itself.
 *
 * Nothing here defeats a protection: these are plain GETs identified as SignalForge, and a site
 * that answers a challenge instead of a page simply yields no candidate. The guesses are versions
 * of families the vendor already ships, so the request rate is a handful of addresses per poll.
 *
 * Each probe is a `discovery:` source, which makes every hit a radar sighting and never a
 * catalogue: a page is evidence that a name exists, not that the model is out.
 *
 * OpenCode's data pages were asked this way once and are read as a catalogue now, in
 * `opencodeData.ts`.
 */

/**
 * No maker of these four is anywhere near a tenth major, so a bigger number is a spelling, not a
 * version: `model_facts` holds `gpt-56-sol`, which is `gpt-5.6-sol` with the dot taken out by an
 * identity that normalises punctuation away. Read as a version it makes the probe ask OpenAI for
 * `gpt-57`, and every question that follows is nonsense.
 */
const MAX_PLAUSIBLE_MAJOR = 10;

/** At most this many codename-and-version guesses per poll, highest version first. */
const CROSS_LIMIT = 12;

/** How far back a name heard once is still worth asking a documentation site about. */
const HEARD_DAYS = 30;

/** At most this many heard names per poll, newest first, so a noisy week cannot become a crawl. */
const HEARD_LIMIT = 6;

/**
 * How long a name that answered is left alone.
 *
 * A heard name is worth asking about once, not every five minutes for a month: `gpt-5.1-mini` would
 * be 8,640 requests to be told the same thing. The version guesses are not rate-limited this way --
 * catching the minute a page appears is the whole point of them -- but a name from somebody else's
 * commit can wait a day between questions.
 */
const COOLOFF_HOURS = 24;

type Version = readonly [number, number];

/** Negative when `left` is the earlier version, positive when it is the later, zero when they are one. */
function compareVersions(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1];
}

/** Every id the catalogue holds, as it spells them. Read once per poll and handed to the three readers. */
function catalogueIds(db: Database): string[] {
  return db
    .query<{ canonical_id: string }, []>("SELECT canonical_id FROM model_facts")
    .all()
    .map((row) => row.canonical_id);
}

/**
 * The versions a vendor could publish next. A maker moves a minor ("5.5" after "5.4"), a major
 * ("6"), or opens the next major at its half step ("6.5"), and nothing else has been seen: the
 * guess list stays at three or four per family so a poll is a handful of requests, not a crawl.
 *
 * The half step inside the current number is for the makers that use one. Anthropic goes 4.5, 5,
 * 5.5 and Haiku sat at 4.5 for months; from 5.1 the three steps above reach 5.2, 6 and 6.5 and skip
 * 5.5 entirely, which is the release everyone is waiting for as this is written.
 */
function nextVersions([major, minor]: readonly [number, number]): (readonly [number, number])[] {
  return [
    [major, minor + 1],
    ...(minor < 5 && minor + 1 !== 5 ? ([[major, 5]] as const) : []),
    [major + 1, 0],
    [major + 1, 5],
  ];
}

export type Site = {
  id: string;
  /** Spelled the way the registry spells it, because a probe is a registered source like any other. */
  vendor: Vendor;
  /** The shapes to follow, as a pattern over a model id: group one is the major, group two the minor. */
  shapes: readonly { family: string; version: RegExp }[];
  /** How the site spells one guess: the slug it would live at. */
  slug: (family: string, version: readonly [number, number]) => string;
  /**
   * How this site spells a model id the catalogues use: `claude-opus-5-5` is `opus-5-5` in
   * Anthropic's documentation. Used both for the control and for a name heard elsewhere.
   */
  spell: (observed: string) => string;
  /** The shape of a name this maker gives a model beside its number, as `gpt-6-astra` is. */
  codename?: RegExp;
  /** The address a sighting is recorded against, which is the one a reader opens. */
  url: (slug: string) => string;
  /**
   * The address asked, when the site answers the same status at a cheaper one. OpenAI serves a
   * Markdown twin of every model page: on 2026-10-02 the page answered 200 in 441 849 bytes and a
   * missing one answered 404 in 330 416, while the twin answered in 3 791 and 9. The status is the
   * whole test, so the twin is what gets asked and `url` is still what gets stored.
   */
  ask?: (slug: string) => string;
};

/** A dotted version, with the trailing `.0` dropped the way makers write it: `6`, `5.5`, `6.5`. */
function dotted([major, minor]: readonly [number, number]): string {
  return minor === 0 ? String(major) : `${major}.${minor}`;
}

/**
 * The four sites answer 404 for a slug they do not have and 200 for one they do, checked against
 * both a live model and a nonsense name on 2026-09-24, and Z.ai again on 2026-09-27. The status is
 * the whole test: no body is parsed, so a redesign of the page cannot turn a miss into a sighting.
 */
export const PROBE_SITES: readonly Site[] = [
  {
    id: "discovery:docs-openai",
    vendor: "OpenAI",
    // OpenAI names a model and versions it: `gpt-5.6-cyber` beside `gpt-6-astra`. Only the numbers
    // can be guessed, so a few codenames are asked for by name as well.
    shapes: [{ family: "gpt", version: /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z]+)?$/ }],
    slug: (family, version) => `${family}-${dotted(version)}`,
    spell: (observed) => observed,
    codename: /^gpt-\d+(?:\.\d+)?-[a-z]{3,12}$/,
    /**
     * `platform.openai.com` has been a redirect since the developer site moved, and it answers 301
     * to a slug it does not have as readily as to one it does, so every question here was two
     * requests and the answer came from the second.
     */
    url: (slug) => `https://developers.openai.com/api/docs/models/${slug}`,
    ask: (slug) => `https://developers.openai.com/api/docs/models/${slug}.md`,
  },
  {
    id: "discovery:docs-anthropic",
    vendor: "Anthropic",
    /**
     * Four lines, not three. `claude-fable-5-1` is in Anthropic's own comparison table and
     * "Introducing Claude Fable 5.1 and Claude Mythos 5.1" is a post this tracker has read, so a
     * probe that knows only Opus, Sonnet and Haiku cannot ask about half of what this maker ships.
     */
    shapes: [
      { family: "opus", version: /^claude-opus-(\d+)[-.](\d+)$/ },
      { family: "sonnet", version: /^claude-sonnet-(\d+)(?:[-.](\d+))?$/ },
      { family: "haiku", version: /^claude-haiku-(\d+)[-.](\d+)$/ },
      { family: "fable", version: /^claude-fable-(\d+)[-.](\d+)$/ },
      { family: "mythos", version: /^claude-mythos-(\d+)[-.](\d+)$/ },
    ],
    slug: (family, [major, minor]) => (minor === 0 ? `${family}-${major}` : `${family}-${major}-${minor}`),
    // The catalogue writes `claude-opus-5-5`; the documentation drops the maker's own name.
    spell: (observed) => observed.replace(/^claude-/, "").replaceAll(".", "-"),
    codename: /^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:[-.]\d+)?$/,
    url: (slug) => `https://platform.claude.com/docs/en/models/${slug}/overview`,
  },
  {
    id: "discovery:docs-google",
    vendor: "Google",
    // Google's slug carries the tier: `gemini-3.8-flash`, `gemini-3.1-pro-preview`.
    shapes: [
      { family: "gemini-#-pro", version: /^gemini-(\d+)\.(\d+)-pro$/ },
      { family: "gemini-#-flash", version: /^gemini-(\d+)\.(\d+)-flash$/ },
      { family: "gemini-#-flash-lite", version: /^gemini-(\d+)\.(\d+)-flash-lite$/ },
    ],
    slug: (family, version) => family.replace("#", dotted(version)),
    spell: (observed) => observed,
    codename: /^gemini-\d+(?:\.\d+)?-[a-z][a-z-]{2,20}$/,
    url: (slug) => `https://ai.google.dev/gemini-api/docs/models/${slug}`,
  },
  {
    id: "discovery:blog-zai",
    vendor: "Z.ai",
    /**
     * Z.ai writes one post per release and nothing links it. The blog has no index at all --
     * `z.ai/blog` answers 404, `z.ai/sitemap.xml` is 26 addresses of billing console, there is no
     * feed and the shared chunk names no post -- so a list is impossible and a name is the only way
     * in. What makes the name enough is that the address is the model: measured 2026-09-27,
     * `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5` and `glm-image` all
     * answer 200 while `glm-6`, `glm-6.5`, `glm-5.4`, `glm-4.8` and `glm-audio` answer 404.
     *
     * The 404s are worth as much as the 200s: `glm-5.3-prime`, `glm-5.3-flashx` and
     * `glm-5.2-thinking` have no post, so the line the maker draws between a release and a tier is
     * published here, and `TIER_WORD` is this tracker guessing at the same line.
     */
    shapes: [{ family: "glm", version: /^glm-(\d+)(?:\.(\d+))?$/i }],
    slug: (family, version) => `${family}-${dotted(version)}`,
    // The address is case-sensitive: `GLM-5.3` answers 404 where `glm-5.3` answers 200, and the
    // catalogues spell the same model both ways.
    spell: (observed) => observed.toLowerCase(),
    /**
     * No `codename`: GLM is named by number, never beside a word, so there is nothing here that
     * version guessing cannot reach. The shape that would match instead is the catalogue's own
     * aliases -- `glm-latest`, `glm-flash-latest`, both 404 -- which is a question asked once a day
     * about a name no maker ever publishes.
     */
    url: (slug) => `https://z.ai/blog/${slug}`,
  },
];

/**
 * A catalogue id as the sites here spell a model: without the maker that a catalogue puts in front
 * of it, and without the variant a serving platform puts after it.
 *
 * `model_facts` holds both spellings of the same model -- `gpt-6-sol` from one catalogue and
 * `openai/gpt-6-sol` from another, 2,173 of 4,854 ids prefixed on 2026-09-27 -- and both the
 * frontier and the check for "already out" read that column. Compared unstripped, a prefixed id
 * matches no shape and no heard name: on 2026-09-27 `gpt-5.2-codex`, released in December and
 * documented ever since, was heard from OpenCode's catalogue, read as unreleased because the only
 * spelling of it was `openai/gpt-5.2-codex`, probed, and published as a new page.
 */
function bareId(canonicalId: string): string {
  return (canonicalId.split("/").pop() ?? "").split(":")[0] ?? "";
}

/**
 * The highest version of each shape this tracker has ever recorded, and the id that carried it.
 *
 * `model_facts` is the one place every catalogue's names end up under one spelling, so it answers
 * "what is out" without asking a vendor. Where several ids tie at the top version the shortest is
 * kept: `claude-opus-5-5` over `claude-opus-5-5-fast`, which is the name a documentation page is
 * written for.
 *
 * The version a probe asks past is read from here, never written down in this file. A constant is a
 * guess that rots: the first version of this probe asked OpenAI for `gpt-5.7` and `gpt-6` while
 * `gpt-6-astra`, `gpt-6-luna` and `gpt-6-sol` had all been out for days, so two of its three
 * questions were about the past. Asking `model_facts` instead means the probe moves the day a model
 * lands, without anybody remembering to edit it.
 */
export function observedFamilies(
  db: Database,
  site: Site,
  catalogue: readonly string[] = catalogueIds(db),
): { family: string; version: Version; observed: string }[] {
  const ids = catalogue.map(bareId);
  const highest = new Map<string, { version: [number, number]; observed: string }>();
  for (const shape of site.shapes)
    for (const id of ids) {
      const match = shape.version.exec(id);
      if (!match) continue;
      const version: [number, number] = [Number(match[1]), Number(match[2] ?? 0)];
      if (version[0] > MAX_PLAUSIBLE_MAJOR) continue;
      const seen = highest.get(shape.family);
      const order = seen ? compareVersions(version, seen.version) : 1;
      if (order > 0 || (order === 0 && seen && id.length < seen.observed.length))
        highest.set(shape.family, { version, observed: id });
    }
  return [...highest].map(([family, found]) => ({ family, version: found.version, observed: found.observed }));
}

/**
 * The names a maker already uses, crossed with the numbers it versions them by.
 *
 * `gpt-6.1-sol` was released on 2026-09-29 and this probe never asked for it. Both halves of the
 * question were in this database two days earlier: `gpt-6-sol` had been heard from a third party's
 * catalogue, and `nextVersions` already knew that 6.1 follows 6. They never met, because version
 * guessing drops the codename -- it asked for `gpt-6.1`, which is a 404 and always will be, since
 * this maker does not ship a model without a word after the number -- and `heardNames` only asks
 * about a name somebody has already written down.
 *
 * Two questions come out of the crossing, and the second is the one a reader feels. A codename at
 * the next number is a release like `gpt-6-sol` to `gpt-6.1-sol`. A codename at a number another
 * line already reached is the rest of a launch: Sol arrives at 6.1 and Luna and Astra follow it
 * there, one by one, over the days after. Both are the same arithmetic over the same two sets, so
 * both are asked.
 *
 * Only the spelled form is read, and only where a codename is a word rather than a number, so
 * Anthropic's `opus-5-5` produces nothing here.
 */
function versionedCodenames(site: Site, catalogue: readonly string[], heard: string[]): string[] {
  if (!site.codename) return [];
  /**
   * Every codename this tracker knows, released or merely heard. Not just the frontier of each
   * family: a maker versions a small model after shipping a big one, and `gpt-6-sol` was neither
   * the newest nor the highest thing OpenAI had out when `gpt-6.1-sol` followed it.
   */
  const known = [...catalogue, ...heard];
  // `released` and `shipped` mean "this tracker knows the name", whether it is out or merely heard.
  const words = new Map<string, { head: string; word: string; top: Version }>();
  const versions = new Map<string, { version: Version; shipped: boolean }>();
  const released = new Set<string>();
  for (const name of known) {
    const bare = bareId(name).toLowerCase();
    if (!site.codename.test(bare)) continue;
    const spelled = site.spell(bare);
    released.add(spelled);
    const parts = /^(.*?)(\d+)(?:\.(\d+))?(-[a-z][a-z-]*)$/.exec(spelled);
    if (!parts) continue;
    const [, head, major, minor, word] = parts;
    const version: [number, number] = [Number(major), Number(minor ?? 0)];
    if (version[0] > MAX_PLAUSIBLE_MAJOR) continue;
    const already = words.get(`${head}${word}`)?.top;
    if (!already || compareVersions(version, already) > 0)
      words.set(`${head}${word}`, { head: head ?? "", word: word ?? "", top: version });
    versions.set(dotted(version), { version, shipped: true });
    for (const next of nextVersions(version))
      if (!versions.has(dotted(next))) versions.set(dotted(next), { version: next, shipped: false });
  }
  const candidates = new Map<string, { version: Version; shipped: boolean; top: number }>();
  for (const { head, word, top } of words.values())
    for (const [, at] of versions) {
      const slug = `${head}${dotted(at.version)}${word}`;
      // A word is worth what the highest model wearing it is worth: `astra` and `sol` are this
      // maker's current line, while `turbo` and `instant` are words it stopped using two numbers
      // ago and would otherwise crowd them out of the cap.
      if (!released.has(slug)) candidates.set(slug, { ...at, top: top[0] * 100 + top[1] });
    }
  /**
   * Half the cap to each of the two questions, because they are asked for different reasons and one
   * would otherwise eat the other.
   *
   * A codename at a number the maker already reached is the rest of a launch -- Sol arrived at 6.1
   * and Luna and Astra follow it there within days -- and there are as many of those as the maker
   * has words, so ranked together they filled every slot and left nothing for `gpt-6.2-sol`, the
   * release this was written for. Each tier is sorted by the newest number first, and by the word
   * the newest model wears where numbers tie, so `astra` and `sol` come before `turbo` and
   * `instant`, which this maker stopped using two numbers ago.
   */
  const byVersion = (
    [, a]: [string, { version: Version; top: number }],
    [, b]: [string, { version: Version; top: number }],
  ): number => compareVersions(b.version, a.version) || b.top - a.top;
  const entries = [...candidates];
  const siblings = entries.filter(([, at]) => at.shipped).sort(byVersion);
  /**
   * The nearest unshipped number first, and never one below where the maker already is: ordered
   * the same way as the shipped ones, every slot went to `gpt-7.5-`, and ordered the other way they
   * all went to `gpt-3.6-`, which is a number this maker left behind years ago. What is wanted is
   * the step past the frontier -- 6.2 before 7, 7 before 7.5.
   */
  const frontier = entries.reduce(
    (top, [, at]) => (at.shipped && compareVersions(at.version, top) > 0 ? at.version : top),
    [0, 0] as Version,
  );
  const successors = entries
    .filter(([, at]) => !at.shipped && compareVersions(at.version, frontier) >= 0)
    .sort(([, a], [, b]) => compareVersions(a.version, b.version) || b.top - a.top);
  const half = Math.ceil(CROSS_LIMIT / 2);
  const taken = [
    ...siblings.slice(0, Math.max(half, CROSS_LIMIT - successors.length)),
    ...successors.slice(0, Math.max(half, CROSS_LIMIT - siblings.length)),
  ];
  return taken.slice(0, CROSS_LIMIT).map(([slug]) => slug);
}

/**
 * Names this tracker has heard but no catalogue serves.
 *
 * Version numbers can be guessed; `gpt-6-astra` cannot. Those names arrive somewhere else first --
 * a third party's model list, a client's bundle, a radar sighting -- and the question worth asking
 * is whether the maker's own documentation has a page for one yet, because that page is the
 * confirmation the name is real and the sighting alone is not. A name already in `model_facts` is
 * out and is not asked about; the probe is for what is not out.
 *
 * The first version of this probe guessed codenames instead -- `gpt-6-nova`, `gpt-6-vega` -- which
 * is a lottery ticket bought twice every five minutes. These are names somebody actually wrote down.
 *
 * No rule here asks whether the number looks current, and the second version of this probe was
 * wrong to. A maker ships below its own frontier all the time: a Kimi K2.9 for code beside K3.1, a
 * smaller model after the flagship. `olderThanKnown` in `mentionStage.ts` is the right rule where a
 * mistake costs a reader a card; here a mistake costs one HTTP request, and the miss it would cause
 * is exactly the release that version guessing cannot reach. Measured on the thirty days to
 * 2026-09-24: of 351 delivered cards, that rule read 18 as stale, and 15 of those were fresh when
 * they went out -- `gpt-5.6-sol` was news five days before `gpt-6-sol` existed.
 */
export function heardNames(
  db: Database,
  site: Site,
  now = Date.now(),
  catalogue: readonly string[] = catalogueIds(db),
): string[] {
  if (!site.codename) return [];
  const since = new Date(now - HEARD_DAYS * 24 * 3_600_000).toISOString();
  /**
   * Released under any spelling. A catalogue writes `claude-opus-5-5` and a third party writes
   * `claude-opus-5.5`; both are the same model, and asking the documentation about a model that is
   * out wastes the one question this probe is for.
   */
  const released = new Set(catalogue.map((id) => site.spell(bareId(id).toLowerCase())));
  const heard: string[] = [];
  for (const row of db
    .query<{ entity_id: string }, [string]>(
      `SELECT DISTINCT e.entity_id FROM events e
       WHERE e.kind='new' AND e.detected_at>=? AND e.signal IN ('codename','launch','release')
       ORDER BY e.id DESC LIMIT 2000`,
    )
    .all(since)) {
    const name = bareId(row.entity_id).toLowerCase();
    if (!site.codename.test(name)) continue;
    const slug = site.spell(name);
    if (released.has(slug)) continue;
    if (!heard.includes(slug)) heard.push(slug);
    if (heard.length >= HEARD_LIMIT) break;
  }
  return heard;
}

/**
 * Ask an address what it answers, without reading what it answers with.
 *
 * `HEAD` would be the request for this and cannot be used: on 2026-10-02
 * `platform.claude.com/docs/en/models/opus-99/overview` answered HEAD with 200 for a slug it does
 * not have, which would have turned every guess into a sighting. So the request stays a GET and the
 * body is thrown away unread -- three sites at two guesses each were downloading about a megabyte
 * per poll to read one number off the status line.
 */
async function askStatus(url: string, request: Fetch): Promise<number> {
  const response = await request(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/markdown,text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
  return response.status;
}

/** What a previous poll asked and what it was told, carried in the stored snapshot. */
type Asked = Record<string, { status: number; at: string }>;

function previouslyAsked(db: Database, source: string): Asked {
  const stored = readLatestSnapshot(db, source);
  if (!stored) return {};
  try {
    const body: unknown = JSON.parse(stored);
    return body && typeof body === "object" ? (body as Asked) : {};
  } catch {
    return {};
  }
}

/**
 * Every unannounced address a site answers for. Nothing is stored for a 404, which is the usual
 * answer, and the questions move on their own: they are the next versions of what the vendor has
 * out today, read from the catalogue at the moment of asking.
 */
export async function collectDocsProbe(
  db: Database,
  site: Site,
  request: Fetch = fetch,
  now = Date.now(),
): Promise<Collection> {
  const catalogue = catalogueIds(db);
  const families = observedFamilies(db, site, catalogue);
  if (!families.length)
    throw new SourceError("empty", `${site.id}: the catalogue names no model of any shape it follows`);
  /** The furthest the maker has gone in any tier, and the model that got there. */
  const furthest = families.reduce((top, family) => (compareVersions(family.version, top.version) > 0 ? family : top));
  const highest = furthest.version;
  const ask = (slug: string): string => (site.ask ?? site.url)(slug);
  const stamp = new Date(now).toISOString();
  /**
   * A model the site certainly documents, asked before anything else. A probe whose every guess is a
   * 404 looks the same whether nothing has shipped or the addresses moved, and the second is how a
   * source dies quietly. The control has to answer 200 or the poll is a failure, and the board says
   * so. It is asked first because the guesses cannot be believed without it: a site that is down or
   * challenging us would otherwise be asked every one of them, each with a twenty second timeout.
   *
   * It is asked at the same address as the guesses: an address that is not the one being asked proves
   * nothing about the one that is.
   */
  const control = site.spell(furthest.observed);
  const answered = await askStatus(ask(control), request);
  if (answered !== 200) throw controlFailure(site, control, answered);
  const asked = previouslyAsked(db, site.id);
  const candidates = new Set<string>();
  for (const { family, version } of families) {
    for (const next of nextVersions(version)) candidates.add(site.slug(family, next));
    /**
     * A tier does not have to catch up before the maker moves the whole line. Google was at
     * `gemini-3.8-flash` while its pro tier was still `gemini-3.1-pro`, and the next pro is far
     * likelier to be `gemini-4-pro` than `gemini-3.2-pro`. So every tier is also asked the
     * questions the maker's furthest tier earns.
     */
    for (const next of nextVersions(highest)) candidates.add(site.slug(family, next));
  }
  const heard = heardNames(db, site, now, catalogue);
  for (const name of heard) {
    const last = asked[name];
    if (last && Date.parse(last.at) > now - COOLOFF_HOURS * 3_600_000) continue;
    candidates.add(name);
  }
  /**
   * Not rate-limited by `COOLOFF_HOURS`, for the same reason the version guesses are not: these are
   * addresses nobody has written down anywhere, so the only way to learn the minute one starts
   * answering is to keep asking.
   */
  for (const slug of versionedCodenames(site, catalogue, heard)) candidates.add(slug);
  candidates.delete(control);
  const records: RecordData[] = [];
  const tried: Asked = { ...asked };
  for (const slug of [...candidates].sort()) {
    const status = await askStatus(ask(slug), request).catch(() => null);
    // A rate limit or a server error is the site failing to answer, not an answer. Recorded, it would
    // put a heard name out of reach for `COOLOFF_HOURS` on the strength of a moment's trouble.
    if (status === null || status === 429 || status >= 500) continue;
    tried[slug] = { status, at: stamp };
    if (status !== 200) continue;
    records.push({ id: slug, name: slug, url: site.url(slug), maker: site.vendor, source: "documentation" });
  }
  tried[control] = { status: answered, at: stamp };
  // A question asked a month ago is no longer a reason not to ask again.
  const kept = Object.fromEntries(
    Object.entries(tried).filter(([, when]) => Date.parse(when.at) > now - HEARD_DAYS * 24 * 3_600_000),
  );
  return {
    source: site.id,
    stream: "pages",
    url: site.url("*"),
    raw: kept,
    records,
  };
}

/**
 * What a control that did not answer 200 means, said by its type.
 *
 * Which of the three it is decides what anyone does next: the addresses moved and the probe has to
 * be rewritten, the site is limiting and the answer is to wait, or it is failing and nothing here is
 * wrong. The control is a name that matched one of this site's shapes, so it is ours to print.
 */
function controlFailure(site: Site, control: string, status: number): SourceError {
  const kind = status === 404 || status === 410 ? "missing-content" : status === 429 ? "rate-limited" : "http";
  return new SourceError(kind, `${site.id}: ${control} answered HTTP ${status}`, { evidence: { status } });
}
