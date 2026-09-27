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
