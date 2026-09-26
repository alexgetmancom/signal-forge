/**
 * The longest match a scan will look for across a chunk boundary.
 *
 * A package is read in pieces, and an id written across the join between two of them would be
 * missed by both. The tail of each piece is therefore carried into the next. 200 bytes is many
 * times the longest id any of these patterns can match -- `gemini-3.1-pro-preview` is 22 -- and it
 * is the whole cost of not holding the package in memory.
 */
const CARRIED_BYTES = 200;

/**
 * A gzipped package, handed to a scan in pieces as it arrives.
 *
 * Two collectors download an npm tarball to keep a handful of model ids out of it, and reading one
 * whole meant three copies at once: the downloaded bytes, the unpacked bytes, and the string decoded
 * from them. Claude Code's binary is 103.5 MB compressed and 230.4 MB unpacked (measured 2026-09-26,
 * version 2.1.283), and reading it that way left 990 MB of resident memory behind -- of which 237 MB
 * was still live after a full collection, because a scan of one enormous string keeps that string
 * alive for as long as anything it found is held. Read in pieces, the peak is one chunk and the
 * names found so far, and nothing outlives the call.
 *
 * `latin1` decodes a byte to the character of that code, so it never fails and never merges bytes: a
 * UTF-8 sequence becomes two characters, neither of which any of these patterns can match, and an id
 * spelled in ASCII reads as itself. Which is the whole of what a scan for ASCII ids needs.
 */
export async function scanGzipStream(
  body: ReadableStream<ArrayBufferView | ArrayBuffer>,
  scan: (text: string) => void,
): Promise<void> {
  let carried = "";
  const gunzip = new DecompressionStream("gzip");
  // Written to on one side and read from the other rather than piped through: a decompressor's ends
  // are typed in terms of any buffer, and a stream of one kind of buffer is not a stream of that
  // union. A failure on the way in errors the readable side, so the loop below is where it is
  // raised; catching here is only so that the same failure is not also an unhandled rejection.
  const piped = body.pipeTo(gunzip.writable).catch(() => {});
  for await (const chunk of gunzip.readable) {
    const text = carried + Buffer.from(chunk as Uint8Array).toString("latin1");
    scan(text);
    carried = text.slice(-CARRIED_BYTES);
  }
  await piped;
}
