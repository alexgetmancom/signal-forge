import { expect, test } from "bun:test";
import { peakGrowthKb, peakKb, peakMb } from "../src/runtime/peak.js";

test("the peak reader answers on this platform, in the unit it says", () => {
  const kilobytes = peakKb();
  // Production is Linux and reads `VmHWM`; a development machine falls back to `getrusage`. A
  // reader that answered 0 here would silently record every section's growth as nothing, which is
  // indistinguishable from a service that allocates nothing.
  expect(kilobytes).toBeGreaterThan(0);
  expect(peakMb()).toBe(Math.round(kilobytes / 1024));
});

test("growth is never negative and is nothing at all without a reading to compare against", () => {
  // The mark is monotone, so a fall is impossible; 0 before means the platform did not answer, and
  // charging the whole peak to whichever section ran next would name an innocent one.
  expect(peakGrowthKb(0)).toBe(0);
  expect(peakGrowthKb(-1)).toBe(0);
  expect(peakGrowthKb(peakKb() + 1_000_000)).toBe(0);
  expect(peakGrowthKb(1)).toBeGreaterThan(0);
});
