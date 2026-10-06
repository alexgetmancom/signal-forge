/**
 * A page appearing on a watched vendor site: whether it is a sighting or the site being a site.
 *
 * The tell is the name. A page that names a versioned product is the earliest word on it; a help
 * centre article, a developer blog post and a guide are what the vendor said, and are read as the
 * written word is.
 */
import { text } from "../text.js";
import { articleTopic, NAMES_A_MODEL } from "./newsrooms.js";
import { recordFor } from "./record.js";
import { isAJobThisReaderDidNotComeFor } from "./subject.js";
import type { Event, SignalClass } from "./types.js";

/**
 * Watched sites whose new pages are not the tell a product page is.
 *
 * A page appearing on a vendor's product site before any announcement is a sighting. A help-centre
 * article is not: "set up Salesforce in Claude" and "let team members run smart reports" reached
 * the invited room as sightings on 2026-09-15, and a reader who came to hear about models cannot
 * do anything with either. A developer blog is a blog, and its posts are what the vendor said.
 */
const HELP_CENTRES = new Set(["pages:claude-support"]);

/**
 * A new page is a sighting only when it names a versioned product or sits among the model pages.
 * Over 2026-09-17 and 18 the scouts carried "Measuring pace of AI development", "Accenture embedded
 * evaluation", "Life sciences verification program", "Lyria prompt guide" and an industry page
 * titled "Law" beside the real tells, "Gemini 3.8 Live" and "Grok voice transcribe 2". Research,
 * customer stories, partner pages and guides are what the vendor said, which is an article.
 */
const PRODUCT_WITH_VERSION =
  /\b(?:claude|opus|sonnet|haiku|fable|mythos|gpt|gemini|gemma|grok|codex|llama|qwen|deepseek|kimi|glm|mistral|minimax|mimo|imagen|veo|lyria|sora|astra)\b(?:[\s-]+[a-z]+){0,3}[\s-]+v?\d/i;
const MODEL_PAGE_PATH = /\/(?:models?|model-cards)\//i;
function pageNamesAProduct(record: Record<string, unknown> | null | undefined): boolean {
  const path = text(record?.id) ?? "";
  const words = `${text(record?.name) ?? ""} ${path.replaceAll(/[/_-]+/g, " ")}`;
  return MODEL_PAGE_PATH.test(path) || NAMES_A_MODEL.test(words) || PRODUCT_WITH_VERSION.test(words);
}
const PAGE_BLOGS = new Set(["pages:google-devs"]);

/** The sections a maker publishes findings in, about its own models and about everyone else's. */
const REPORT_SECTION = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:research|institute|policy|commitments)\//i;

/** What a page appearing on, or changing on, a watched site is. */
export function pageClass(event: Event): SignalClass {
  if (HELP_CENTRES.has(event.source)) return "evidence";
  if (PAGE_BLOGS.has(event.source)) return event.kind === "new" ? articleTopic(event) : "article";
  if (event.kind !== "new") return "evidence";
  // A page that names a versioned product is a sighting whatever the product does, because the
  // name appearing is the tell. Everything else on a site about making pictures, video or sound
  // is the manual for one, and a manual is not news: Google published the Gemini 3.8 TTS models
  // on 2026-09-23 as eight pages, and the one that survived the collapse reached the news
  // channel, where a reader who came for coding models was told about a voice.
  const path = decodeURIComponent(event.entity_id);
  // A report is about a model, not an early word on one. Anthropic published
  // "/research/glm-5-3-and-the-spread-of-advanced-cyber-capabilities" on 2026-09-29 and it reached
  // the scouts as a sighting of GLM 5.3, which OpenRouter had been serving since that morning and
  // which is not Anthropic's model to sight. The sibling page in the same collection,
  // "/research/your-thoughts-on-ai", was read as what both of them are.
  if (REPORT_SECTION.test(path)) return articleTopic(event);
  // Whether the product it names is already on sale is not in the page, and `classify` asks the
  // catalogue that knows.
  if (pageNamesAProduct(recordFor(event))) return "codename";
  if (isAJobThisReaderDidNotComeFor({ ...event, entity_id: path }, recordFor(event))) return "evidence";
  return articleTopic(event);
}
