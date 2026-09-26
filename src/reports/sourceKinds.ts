import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config.js";
import { buildSourceRegistry } from "../sources/registry.js";

/**
 * What the two hundred registered sources are made of, and how much of that nobody has named.
 *
 * A source is added by copying the entry above it, and at this size that is the only thing keeping
 * the registry readable or making it unreadable. A kind, from src/sources/kinds.ts, says once what a
 * family shares and why its pace is what it is; the members are then a table, and adding a maker's
 * blog is one row that cannot forget a field.
 *
 * The other half of this report is the debt: sources that belong to an obvious family -- same
 * authority, same group, same stream -- which no kind names. They are not broken, and most are
 * already generated from a list. But nothing says why that list is polled the way it is, and the
 * next entry added to it inherits whatever the one above it got wrong. `tests/sourceKinds.test.ts`
 * holds `unnamed` as a ratchet, so this number can only go down.
 */
export type SourceKindReport = {
  kinds: { kind: string; sources: number; authority: string; group: string; stream: string; paces: number[] }[];
  /** Families of three or more sharing authority, group and stream that no kind names. */
  unnamedFamilies: { authority: string; group: string; stream: string; sources: number; examples: string[] }[];
  total: number;
  named: number;
  unnamed: number;
};

export function sourceKinds(db: Database, config: AppConfig): SourceKindReport {
  const registry = buildSourceRegistry(db, config);
  const kinds = new Map<string, SourceKindReport["kinds"][number]>();
  const families = new Map<string, SourceKindReport["unnamedFamilies"][number]>();
  for (const definition of registry) {
    if (definition.kind) {
      const held = kinds.get(definition.kind) ?? {
        kind: definition.kind,
        sources: 0,
        authority: definition.authority,
        group: definition.group,
        stream: definition.stream,
        paces: [],
      };
      held.sources += 1;
      if (!held.paces.includes(definition.intervalSeconds)) held.paces.push(definition.intervalSeconds);
      kinds.set(definition.kind, held);
      continue;
    }
    const key = `${definition.authority}|${definition.group}|${definition.stream}`;
    const family = families.get(key) ?? {
      authority: definition.authority,
      group: definition.group,
      stream: definition.stream,
      sources: 0,
      examples: [],
    };
    family.sources += 1;
    if (family.examples.length < 4) family.examples.push(definition.id);
    families.set(key, family);
  }
  const named = registry.filter((definition) => definition.kind).length;
  return {
    kinds: [...kinds.values()].sort((one, other) => other.sources - one.sources),
    unnamedFamilies: [...families.values()]
      .filter((family) => family.sources >= 3)
      .sort((one, other) => other.sources - one.sources),
    total: registry.length,
    named,
    unnamed: registry.length - named,
  };
}
