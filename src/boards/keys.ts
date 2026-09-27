/**
 * Which boards exist and the order the channel reads them in: what happened, then how the vendors
 * are doing, then how we are doing.
 *
 * On its own so that the publisher and the failure log can each name a board without importing the
 * other. Naming one from the other is a cycle the moment a refused board has to be written down.
 */

export type BoardKey = "activity" | "platforms" | "suppressions" | "status" | "coverage" | "releases";

export const BOARD_ORDER: readonly BoardKey[] = [
  "activity",
  "platforms",
  "suppressions",
  "status",
  "coverage",
  "releases",
];
