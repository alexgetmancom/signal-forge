/**
 * A kind of source: what a family of sources shares, so an entry carries only what differs.
 *
 * Thirty-two entries in the news pack repeated `authority`, `group` and `stream` verbatim, and the
 * only thing most of them said for themselves was a vendor and a collector. Repetition that wide
 * is not a style problem: a new sitemap copied from the one above it inherits whatever that one got
 * wrong, and "polled every ten minutes" had its reason written out seven times in the same words.
 *
 * So a kind is declared once, with the reason its pace is what it is, and its members are a table.
 * The rule this buys, which `tests/sourceKinds.test.ts` enforces: a source that differs from
 * another only by URL and vendor is a member of a kind, and a source that needs its own parsing is
 * a kind of its own. Adding a maker's blog is then one row, and nothing about it can be forgotten.
 */
import type { Collection } from "../events/types.js";
import type { SourceEntry } from "./definition.js";
import type { Vendor } from "./vendors.js";

/** The fields a kind fixes for every member, and the pace a member may still overrule. */
export type SourceKind = Pick<SourceEntry, "authority" | "group" | "stream"> & {
  /** Named in reports and by `sources kinds`; never stored, so it is free to be renamed. */
  kind: string;
  intervalSeconds: number;
};

/** What a member of a kind says for itself: who it belongs to, what it reads, and any exception. */
export type KindMember = Partial<SourceKind> &
  Omit<SourceEntry, "authority" | "group" | "stream" | "intervalSeconds" | "collector" | "vendor" | "kind"> & {
    vendor?: Vendor;
    collector: () => Promise<Collection>;
  };

/**
 * One kind's members as registry entries. A member may overrule the pace -- a small page from a lab
 * that posts nowhere else is worth asking more often than the kind's default -- and may overrule
 * the authority, because the one place other people's posts are read sits in the newsroom group
 * without being a newsroom. Anything else it wants to differ in means it is a different kind.
 */
export function sourcesOfKind(kind: SourceKind, members: readonly KindMember[]): SourceEntry[] {
  return members.map((member) => ({ ...kind, ...member }));
}
