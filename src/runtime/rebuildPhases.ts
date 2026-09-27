/**
 * The boot phases that are rebuilt in a child, named in one place.
 *
 * The parent and the child both need the list, and the child is spawned by path rather than
 * imported, so a name spelled differently at the two ends is a boot that fails on the usage line. It
 * is its own module because the parent may not import the child: the child imports every projection
 * it can rebuild, and that is the memory the arrangement exists to keep out of the parent.
 */
export const REBUILD_PHASES = ["model-facts", "hypotheses"] as const;
export type RebuildPhase = (typeof REBUILD_PHASES)[number];
