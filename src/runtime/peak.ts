/**
 * The kernel's own high-water mark for this process, and the one place that reads it.
 *
 * `VmHWM` is the largest resident size this process has ever held, and it is monotone: the kernel
 * never lowers it, and the allocator never returns the address space that produced it. That is what
 * makes it the right reading for the question "how much did this section add to the floor this
 * service stands on" -- the increment across a section is exactly what that section raised the peak
 * by, with no sampler to miss it. A sampler cannot answer the same question at all: a rebuild that
 * holds 200 MB for eight hundred milliseconds inside a five-minute sample is invisible, and it is
 * still the number the container is killed by an hour later.
 *
 * Four copies of this reader existed -- `read-cost`, `source-cost`, `collectOne` and nothing in the
 * service itself. The lesson of the collection metric that was added twice is that an instrument
 * with two implementations is two instruments, so this is the only one, and the scripts import it.
 */
import { readFileSync } from "node:fs";

/**
 * This process's peak resident size in kilobytes, or 0 where the platform will not say.
 *
 * `/proc/self/status` on Linux, which is production. A development machine has no `/proc`, so
 * `getrusage`'s `maxRSS` stands in -- also a high-water mark, in bytes on darwin where this falls
 * back. Zero rather than a guess when neither answers: a growth measured against a number that does
 * not mean what it says is worse than no measurement, because it is stored beside the honest ones.
 */
export function peakKb(): number {
  try {
    const kilobytes = Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
    if (Number.isFinite(kilobytes) && kilobytes > 0) return kilobytes;
  } catch {
    // Not Linux -- a development machine.
  }
  const maxRss = process.resourceUsage?.().maxRSS ?? 0;
  return maxRss > 0 ? Math.round(maxRss / 1024) : 0;
}

/** The same reading in megabytes, which is the unit every report and script says it in. */
export function peakMb(): number {
  return Math.round(peakKb() / 1024);
}

/**
 * What a section added to the peak, given the reading taken before it ran.
 *
 * Never negative: the mark cannot fall, and a platform that answered 0 once would otherwise record
 * the whole peak as a section's own growth the moment it started answering.
 */
export function peakGrowthKb(before: number): number {
  if (before <= 0) return 0;
  return Math.max(0, peakKb() - before);
}
