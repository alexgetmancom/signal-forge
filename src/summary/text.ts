/**
 * A sentence that stops mid-word is worse than no sentence: it sits in italics above the evidence
 * and the reader's first impression of the card is that the service is broken. The output token
 * ceiling cuts them -- 33 of 71 summaries stored on production by 2026-09-14, 46%, ended without
 * closing punctuation, some as short as "Nvidia added a new public Hug".
 *
 * So the sentence is cut back to the last one that finished, and a summary with nothing finished in
 * it is dropped. Dropping is already the normal path: the card renders without a summary whenever
 * the call fails, and the evidence below it never depended on the sentence.
 */
const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)/g;

/**
 * Per-token prices belong to an API listing, not to a sentence: the card prints the same figures
 * underneath as dollars per million tokens, so "prompt to 0.00000066" is the one fact on the card
 * stated in a unit nobody reads, and it is stated twice.
 */
const PER_TOKEN_PRICE = /\b0\.0{4,}\d/;

export function completeSentences(text: string): string | null {
  let end = -1;
  for (const match of text.matchAll(SENTENCE_END)) end = match.index + match[0].length;
  if (end < 0) return null;
  const trimmed = text.slice(0, end).trim();
  return trimmed && !PER_TOKEN_PRICE.test(trimmed) ? trimmed : null;
}

/** Model output is text from an untrusted chain; it goes in a message, so it carries no handles. */
export function sanitize(text: string, limit = 300): string {
  return text
    .replace(/[@&<>`*_~|]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
