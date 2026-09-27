/**
 * The jobs a coding subscription's reader did not come for, named in a model's id or a page's path.
 *
 * Shared by the catalogue rule and the pages rule because it is the same question in both: a voice,
 * an image or an embedding model is a sighting for the radar and never a card.
 */

/**
 * The jobs a subscription feed's reader did not come for, named in the model's own id.
 *
 * Making pictures, video and sound belongs here for the same reason speech does: Recraft V4.1 Flash
 * reached the radar on 2026-09-23 priced per image, and a reader who writes code for a living picks
 * none of it. The sighting still belongs on the radar; the news channel is not for it.
 */
export const MODALITY_VARIANT =
  /(?:^|[\s-])(?:tts|stt|asr|embed|embedding|embeddings|rerank|reranker|moderation|ocr|guard|realtime|live|livetranslate|image|images|video|audio|speech|voice|voices|music|imagen|veo|lyria|diffusion|dall[\s-]?e|recraft)(?:[\s-]|$)/;
