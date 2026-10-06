/**
 * The subject this feed is about, and the jobs its reader did not come for.
 *
 * A reader on a coding subscription came to hear about models they write code with. A voice, an
 * image, a video, an embedding or a reranker is a real model and a real arrival, and it is still
 * not the subject: it belongs on the radar, where everything coming is watched, and never on the
 * news channel. That is one question, and until now it was answered in four unrelated places -- a
 * regex over a model's name, a set of Arena boards, a wider set of boards beside it, and a
 * suppression for one price list -- none of which knew the others existed.
 *
 * Eleven v4 Turbo took first place on Artificial Analysis's text-to-speech board on 2026-10-05 and
 * went to both public channels. Nothing was bypassed: the name reading found no modality in
 * `eleven-v4-turbo`, because there is none to find, and the boards never asked the question at all.
 * Over the whole history the text-to-speech board is the third largest source of news cards -- six,
 * against four for the coding board -- and twelve of the twenty-one board debuts ever delivered
 * were about a modality nobody asked for.
 *
 * So the question is asked of three things, and the strongest is asked first. A board or a source
 * dedicated to a modality has declared it, which is a fact rather than a reading: boards are an
 * allowlist for that reason, because a denylist of words has to guess the next one and the next
 * board will be `text-to-3d`. Only then is the model's own name read, and then a page's path.
 */
import { text } from "../text.js";
import { recordFor } from "./record.js";
import type { Event, RecordData } from "./types.js";

/**
 * The jobs a subscription feed's reader did not come for, named in a model's id, a page's path or
 * the id of the source that collected it.
 *
 * Making pictures, video and sound belongs here for the same reason speech does: Recraft V4.1 Flash
 * reached the radar on 2026-09-23 priced per image, and a reader who writes code for a living picks
 * none of it. Two Gemini TTS rows reached the public channel on 2026-09-22 as launches; nobody
 * there is picking a voice. The sighting still belongs on the radar; the news channel is not for it.
 *
 * `banana` is here because a maker's own nickname for a line of models says the modality where the
 * modality word does not: `models/gemini-nano-banana-2.1` reached the news channel on 2026-10-06 as
 * a launch, carrying a token limit and three generic methods and nothing that reads as a picture.
 * This database already knew: the same family sits on Arena's `text-to-image` board as
 * `gemini-3.1-flash-image (nano-banana-2)`. A nickname is a weaker instrument than a word -- it
 * ages, and the next line will be called something else -- so the list that fixes this properly is
 * the boards a subject has been measured on, which is a question this file should be asking.
 */
const MODALITY_VARIANT =
  /(?:^|[\s-])(?:tts|stt|asr|embed|embedding|embeddings|rerank|reranker|moderation|ocr|guard|realtime|live|livetranslate|image|images|video|audio|speech|voice|voices|music|imagen|veo|lyria|banana|diffusion|dall[\s-]?e|recraft)(?:[\s-]|$)/;

/**
 * The words a name is read as: one lowercase string where every separator a name, a path or a
 * source id uses is the same one. `artificial-analysis:text-to-speech` and
 * `/docs/gemini/tts_quickstart.md` both have to answer this with the word they contain.
 */
function words(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase()
    .replaceAll(/[/_.:]+/g, "-");
}

/**
 * Whether this event is about a job this reader did not come for, read off everything that could
 * say so: the source that collected it, and the name, id or path of the thing itself.
 *
 * The source reading is the one the name reading cannot replace. `artificial-analysis:text-to-speech`
 * collects nothing but voices and says so in its own id, while the models it lists -- Eleven v4
 * Turbo among them -- carry no modality word at all. A source dedicated to a modality has declared
 * what it is about, and that is stronger evidence than any reading of a model's name.
 *
 * What the caller does with a yes is the caller's: a catalogue arrival becomes a sighting for the
 * radar, a page becomes part of the trail. The question is the same one in both.
 */
export function isAJobThisReaderDidNotComeFor(event: Event, record: RecordData | null | undefined): boolean {
  return MODALITY_VARIANT.test(words(event.source, text(record?.id) || event.entity_id, text(record?.name)));
}

/**
 * The scoreboards this service announces: the ones whose subject is writing code, and the general
 * boards where taking a place is the state of the art changing hands.
 *
 * An allowlist, and that is the point. Arena runs eleven boards and Artificial Analysis five, a
 * model arriving near the top of any of them used to be a card, and both sites add boards faster
 * than any list of excluded words keeps up with. Three are what these readers act on: the coding
 * board, because what they do with a model is write code with it; the general text board, because
 * first place there is the state of the art changing hands; and Artificial Analysis's quality
 * board, because its Intelligence Index is the number this site is quoted for.
 *
 * Everything else is a sighting for the radar, vision included. `gpt-6.1-sol-max` entering Arena
 * vision at #10 on 2026-10-02 went to both public channels and came back with two votes down and
 * one up: its code debut at #3 two days earlier is the card that was wanted, and the vision row was
 * a fourth message about a model the channel already had the launch, the pricing and an Artificial
 * Analysis placing for. Arena vision had been a sighting since; Artificial Analysis vision, image,
 * speech and video were not, which is the half this closes.
 *
 * Replaces `ANNOUNCED_ARENA_BOARDS`, which said the same thing for one source and left a note that
 * `MAIN_BOARDS` still answered for the other. It no longer does: `MAIN_BOARDS` is the wider set of
 * boards people quote, which is what the morning recap reports moves on and what decides whether an
 * Artificial Analysis measurement counts at all. Quoted and announced are two questions, and they
 * were one function.
 */
const ANNOUNCED_BOARDS = new Set(["code/overall", "text/overall", "artificial-analysis/quality"]);

/** A board whose subject is this feed's. Anything unnamed is not announced, whatever it did. */
export function isAnnouncedBoard(category: unknown): boolean {
  return typeof category === "string" && ANNOUNCED_BOARDS.has(category);
}

/** A board arrival on a board this service announces, read off the record the board published. */
export function isAnnouncedArrival(event: Event): boolean {
  return isAnnouncedBoard(recordFor(event)?.category);
}

/**
 * The makers whose models this reader will never call, wherever the row was found.
 *
 * Not a ranking and not a judgement of the model: it is who this feed is for. A reader on a $20
 * coding subscription runs frontier and open coding models. Upstage's Solar Mini 4 -- 3B active,
 * Korean-first -- and Cohere's Command A+ -- an enterprise model whose own launch note puts it
 * below Claude Haiku on coding -- both reached the radar in the week to 2026-09-23, and so did
 * Microsoft's image models and NVIDIA's Nemotron checkpoints. A small unknown lab is still
 * watched: that is what the radar is for, and what `breakouts.ts` promotes. These are known
 * quantities aimed somewhere else.
 *
 * It lives beside the modality reading because it is the same question asked about the other half
 * of the subject -- what the model does, and who made it -- and because the two were asked in the
 * wrong order for as long as they lived apart. It was consulted for api catalogues and never for
 * a weights registry, which is how IBM's Granite Timeseries Ensemble R1, a time-series forecaster
 * with twenty-five downloads, reached the radar on 2026-10-05 with IBM already named here.
 */
const UNFOLLOWED_MAKERS = new Set([
  "Cohere",
  "Upstage",
  "NVIDIA",
  "Microsoft",
  "Amazon",
  "Perplexity",
  "Groq",
  "Baidu",
  // Added when the vendor table learned to spell them, on 2026-09-27. Until then they were Unknown
  // and reached this answer by the other branch, so naming them here is what keeps the routing the
  // same: being spellable is attribution, and attribution is not the same claim as being followed.
  // An embedding house, a rerankers house, an inference provider, an edge-model lab and two
  // national programmes -- none of them what a reader on a coding subscription calls.
  "Mixedbread",
  "Quiver AI",
  "Perceptron",
  "Inference.net",
  "Fireworks",
  "Liquid AI",
  "IBM",
  "AI Singapore",
  "Swiss AI",
]);

/**
 * Whether a maker this feed can spell is one it does not follow. An unspellable one is not an
 * answer here: a row that names no maker cannot be judged small, and the caller decides what to do
 * with that -- a reseller treats it as unfollowed, a weights registry as the unknown lab it watches.
 */
export function isAMakerThisReaderDoesNotFollow(maker: string | null | undefined): boolean {
  return Boolean(maker) && UNFOLLOWED_MAKERS.has(maker as string);
}

/**
 * What a card is about, in the terms a reader rejects things in.
 *
 * A vibe-coding channel does not care about image or video models anywhere, which is a cut across
 * every source at once -- and no source says "modality" in a field of its own. Arena spells it in
 * the board (`image-edit/overall`), OpenRouter in the input and output arrays, Vercel only in a
 * price per character of speech, and the rest only in the name. So it is derived from whatever the
 * record happens to carry, and a record that says none of it stays `unknown` rather than being
 * guessed into a bucket somebody would then cut.
 *
 * The fifth list of modality words this repository had, and the reason it lives here now: it knew
 * `flux`, `eleven`, `vision` and `canvas`, which the rule that actually decides routing does not,
 * so the report counting the complaints was reading the subject more carefully than the rule
 * causing them. It is still a separate list, and must stay one: it labels a card for a reader of a
 * report, so it names `code` and `text` as modalities too, and a routing rule that demoted
 * everything matching `code` would demote this feed's entire subject. One file, two lists, and the
 * difference between them written down -- which is what the four lists it joins never had.
 */
export const MODALITY_FACETS: readonly { modality: string; pattern: RegExp }[] = [
  { modality: "image", pattern: /image|imagine|vision|diffusion|flux|canvas|photo/i },
  { modality: "video", pattern: /video|sora|veo|runway|motion/i },
  { modality: "audio", pattern: /voice|speech|tts|audio|whisper|music|eleven/i },
  { modality: "embedding", pattern: /embed|rerank|retrieval/i },
  { modality: "code", pattern: /code|coder|webdev|web-dev|swe/i },
];
