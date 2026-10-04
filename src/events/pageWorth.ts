/**
 * A page on a vendor's site: whether its address names a product or a story.
 *
 * The address is the evidence. A page under /news, /customers or /research that names no product of
 * the vendor's is what they chose to say, which the newsroom feed already tells; a path that names a
 * model and a tier is the sighting the site was watched for.
 */
import type { Event } from "./types.js";

/**
 * The model a vendor page is about, read from its address.
 *
 * Gemini 3.8 Live reached the invited room as `/models/model-cards/gemini-3-8-audio` on DeepMind and
 * `/gemini-api/docs/models/gemini-3.8-live` plus its extended-thinking page on the Gemini API docs,
 * inside thirty-four minutes on 2026-09-15. Story correlation keeps them apart because the slugs name
 * the model three ways, and it should: `gemini 3 8 audio` and `gemini 3.8 live` are different
 * products to anything that reads names. What they share is the family and the version, and a
 * reader told a vendor's pages have started naming Gemini 3.8 needs telling once.
 */
const PAGE_MODEL =
  /(?:^|[/_\s-])(gemini|gemma|claude|opus|sonnet|haiku|gpt|grok|llama|qwen|glm|kimi|deepseek|mistral|veo|imagen|lyria)[-_\s]?(\d{1,2})(?:[.-](\d{1,2}))?(?![\d.])/i;

const PAGE_TIER = /(?:^|[-_\s])(flash|pro|ultra|lite|nano|mini)(?=$|[-_\s])/i;

export function pageModel(event: Event): string | null {
  if (event.stream !== "pages" || event.kind !== "new") return null;
  const path = decodeURIComponent(event.entity_id);
  const match = PAGE_MODEL.exec(path);
  if (!match?.[1] || !match[2]) return null;
  // Live and audio are one model written two ways; Flash and Pro at the same version are two, and a
  // Gemini 3.8 Pro page after a told 3.8 Flash page is the news, not a repeat.
  const slug = path.slice(match.index + match[0].length).split("/")[0] ?? "";
  const tier = PAGE_TIER.exec(slug)?.[1]?.toLowerCase();
  return `${match[1].toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}${tier ? ` ${tier}` : ""}`;
}

/**
 * A new page on a vendor's site whose address names no product of theirs.
 *
 * A page appearing before the announcement is a sighting when it is about something to use.
 * "/news/accenture-embedded-evaluation" reached the scouts on 2026-09-18, and the disrupting-
 * malicious-uses series sent eight in one minute on 2026-09-16: customer stories and reports, which
 * the vendor's newsroom feed tells as what they are.
 */
const PAGE_PRODUCT =
  /(?:^|[/_\s-])(?:claude|cowork|opus|sonnet|haiku|fable|mythos|gpt|o\d|chatgpt|codex|sora|gemini|gemma|veo|imagen|lyria|notebooklm|antigravity|jules|grok|aurora|llama|muse|qwen|glm|kimi|deepseek|mistral|models?)(?=$|[/_\s.-]|\d)/i;

/**
 * Only the sections a vendor writes stories in. Documentation is the product itself: the Claude CLI's
 * `sessions connect` and `apply` pages named no product and were new commands.
 */
const EDITORIAL_SECTION =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:news|index|research|institute|business|solutions|customers|stories|blog)\//i;

export function isPageWithoutAProduct(event: Event): boolean {
  if (event.stream !== "pages" || event.kind !== "new") return false;
  const path = decodeURIComponent(event.entity_id);
  return EDITORIAL_SECTION.test(path) && !PAGE_PRODUCT.test(path);
}

/**
 * The pages of one newly published tree that the root of it already announced.
 *
 * A sitemap does not publish a page, it publishes a branch. When Anthropic documented the
 * organization analytics endpoints on 2026-09-30 the read brought back `/docs/en/api/beta/
 * organization/analytics` and twenty-odd addresses under it -- `/apps`, `/apps/chat`,
 * `/apps/chat/projects`, `/apps/chat/projects/list` -- and each one was its own card. Over the
 * fourteen days to 2026-10-04 that was 105 of the 176 cards the `pages` stream delivered, and Jev
 * scored every one of them under 1.62 against a story cutoff of 2, 93 of them as `internal`. The
 * disagreement in `judge-gap` was almost entirely this one shape.
 *
 * So the shallowest address of a tree carries the card and the branch below it does not, which is
 * `herd` applied to a path instead of to a field: one thing the site did, told once. Keyed by
 * source, because two vendors' sitemaps sharing a prefix share nothing.
 *
 * A deeper page that names a product of the vendor's is kept, and that half is what makes this safe
 * to run on every sitemap rather than on the documentation ones. `/models` and
 * `/models/model-cards/gemini-3-8-audio` arrive in the same read, and suppressing the leaf would
 * keep the index page and throw away the release: Gemini 3.8 Live reached the invited room as a path
 * exactly that deep. Measured over the same fourteen days nothing a reader was told about a model
 * was touched -- what survived is `/developers/grok-4-7`, `/gemini-api/docs/models/
 * gemini-3.8-flash-tts` and the Opus 5.5 system-prompt notes.
 */
export function deeperPagesOfOneTree(events: readonly Event[]): Set<number> {
  const published = new Map<string, Set<string>>();
  const candidates: { id: number; source: string; path: string }[] = [];
  for (const event of events) {
    if (event.stream !== "pages" || event.kind !== "new") continue;
    const path = pagePath(event.entity_id);
    // An address with no separator is not a tree: the sitemaps that publish bare slugs -- the
    // probes that ask for `opus-6-5` by name -- have no root to defer to.
    if (!path.includes("/")) continue;
    const tree = published.get(event.source) ?? new Set<string>();
    tree.add(path);
    published.set(event.source, tree);
    candidates.push({ id: event.id, source: event.source, path });
  }
  const deeper = new Set<number>();
  for (const candidate of candidates) {
    if (PAGE_PRODUCT.test(candidate.path)) continue;
    const tree = published.get(candidate.source);
    const parts = candidate.path.split("/");
    // Up to the second segment and no further: the first is empty for a rooted path, and a root
    // that is in the same read is the page this one is a branch of.
    for (let depth = parts.length - 1; depth > 1; depth -= 1)
      if (tree?.has(parts.slice(0, depth).join("/"))) {
        deeper.add(candidate.id);
        break;
      }
  }
  return deeper;
}

/** An address as a tree position: no query, no trailing slash, decoded the way the rules read it. */
function pagePath(entityId: string): string {
  return (decodeURIComponent(entityId).split("?")[0] ?? "").replace(/\/+$/, "");
}
