/**
 * How a stored payload is compressed, and how one is read back whatever it was compressed with.
 *
 * Every body in this database was gzipped because gzip is what `Bun.gzipSync` is. Measured on a
 * copy of production 2026-10-03, over all 3,570 kept snapshot bodies -- 729.7 MB of raw payload --
 * gzip holds them in 97.3 MB and zstd at level 10 in 76.6: 21% smaller, 20.6 MB, for the same
 * compression time and a tenth of the decompression time. Where it comes from is the sources whose
 * answers are large and repetitive, which are the ones that cost anything: `models-dev` 14.3 MB
 * becomes 7.1, `polymarket` 9.2 becomes 6.2, `openrouter` 14.1 becomes 10.9. The sources already
 * near gzip's limit are unchanged, which is the point -- nothing is traded away to get this.
 *
 * Level 10 rather than 19. Nineteen is another 7% and twenty-five times the time: 1,212 ms for one
 * 5 MB catalogue against 34, inside a collection that has a timeout. Ten is 46 ms for the worst
 * body in the database and 688 ms for four hundred of them, against gzip's 457.
 *
 * The format is read off the first bytes of the blob, so an old gzip body stays readable until
 * `compact-storage` repacks it as zstd. That repack verifies the decompressed bytes before writing
 * and leaves the receipt unchanged; new bodies are zstd from their first write.
 */

import { storageFailure } from "../failure.js";

/** zstd's frame magic, and gzip's. Four bytes and two, and neither is a prefix of the other. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const GZIP_MAGIC = [0x1f, 0x8b];

/** The level the measurements above chose. */
const ZSTD_LEVEL = 10;

export function compressPayload(raw: string | Uint8Array): Uint8Array {
  return Bun.zstdCompressSync(typeof raw === "string" ? Buffer.from(raw) : raw, { level: ZSTD_LEVEL });
}

/** Which compressor wrote a blob, or null for something that is neither. */
export function payloadFormat(stored: Uint8Array): "zstd" | "gzip" | null {
  if (ZSTD_MAGIC.every((byte, at) => stored[at] === byte)) return "zstd";
  if (GZIP_MAGIC.every((byte, at) => stored[at] === byte)) return "gzip";
  return null;
}

/**
 * A stored payload back as it arrived.
 *
 * Throws for a blob that is neither, rather than returning something: a body that cannot be read
 * is evidence that has gone, and answering with an empty string would turn that into a card about
 * nothing. `storageFailure`, because what has failed is this database holding something back and
 * not the source that sent it -- the http cache is read inside a collection, so the kind is what
 * decides whether a red source means "they are down" or "we are".
 */
export function decompressPayload(stored: Uint8Array): string {
  const bytes = new Uint8Array(stored);
  const format = payloadFormat(bytes);
  if (format === null) throw storageFailure("a stored payload in neither gzip nor zstd");
  return Buffer.from(format === "zstd" ? Bun.zstdDecompressSync(bytes) : Bun.gunzipSync(bytes)).toString("utf8");
}
