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
 */
const MODALITY_VARIANT =
  /(?:^|[\s-])(?:tts|stt|asr|embed|embedding|embeddings|rerank|reranker|moderation|ocr|guard|realtime|live|livetranslate|image|images|video|audio|speech|voice|voices|music|imagen|veo|lyria|diffusion|dall[\s-]?e|recraft)(?:[\s-]|$)/;

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
