/**
 * The catalog every operator surface is a projection of.
 *
 * A section is what somebody is holding when they ask — a delivery that may or may not have
 * reached the channel, a source that stopped, a claim they need evidence for — not where the code
 * that answers it lives. `startHere` is the question a command is the beginning of the answer to,
 * and the symptom index is built from those, because a caller who has to know a section name
 * before they can ask has not been helped.
 */
export const OPERATION_SECTIONS = ["health", "delivery", "evidence", "sources", "host"] as const;
export type OperationSection = (typeof OPERATION_SECTIONS)[number];

const SECTION_SUMMARIES: Record<OperationSection, string> = {
  health: "Is this deployment collecting, delivering and backed up, and what is wrong with it.",
  delivery: "One message to subscribers: whether it arrived, and how to settle it when that is unclear.",
  evidence: "What was observed, what it was correlated into, and what each claim rests on.",
  sources: "The collectors themselves: what they cover, how fresh they are and what they cost.",
  host: "Operations on this deployment's own state. Mutations live here and are journalled.",
};

export type OperationCatalogEntry = {
  name: string;
  usage: string;
  summary: string;
  section: OperationSection;
  mutates: boolean;
  agent: boolean;
  startHere?: string;
  note?: string;
  http?: string;
};

export type OperationsGuide = {
  service: string;
  route: string;
  sections: { section: OperationSection; summary: string; commands: string[] }[];
  symptoms: { symptom: string; command: string; usage: string }[];
  commands?: OperationCatalogEntry[];
  whenTheDatabaseIsUnusable: string[];
};

/**
 * Read-only, and the first thing to run. It answers with section names and the symptom index; the
 * full entries come back only when asked for, because a caller reading the whole catalog to answer
 * one question pays for all of it.
 */
export function buildOperationsGuide(
  catalog: readonly OperationCatalogEntry[],
  options: { section?: OperationSection; all?: boolean } = {},
): OperationsGuide {
  const selected = options.all
    ? [...catalog]
    : options.section
      ? catalog.filter((entry) => entry.section === options.section)
      : [];
  return {
    service: "signal-forge",
    route: "bun src/cli.ts <command> [arguments]",
    sections: OPERATION_SECTIONS.map((section) => ({
      section,
      summary: SECTION_SUMMARIES[section],
      commands: catalog.filter((entry) => entry.section === section).map((entry) => entry.name),
    })),
    symptoms: catalog
      .filter((entry) => entry.startHere)
      .map((entry) => ({ symptom: entry.startHere as string, command: entry.name, usage: entry.usage })),
    ...(selected.length ? { commands: selected } : {}),
    whenTheDatabaseIsUnusable: [
      "The service opens the database on start and migrates it; a failure there stops the process rather than running against a half-migrated schema.",
      "Restore from the newest verified archive in the backup directory, not from the live file: doctor reports which archive was verified and when.",
      "Never open the production database by hand to repair it. Stop the collector first, and rehearse any migration on a copy with scripts/rehearse-migration.ts.",
    ],
  };
}

/** The usage line a surface prints, written from the arguments the command actually takes. */
export function usageLine(command: string, args: readonly { name: string; optional?: boolean }[]): string {
  const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return [command, ...args.map((arg) => (arg.optional ? `[${kebab(arg.name)}]` : `<${kebab(arg.name)}>`))].join(" ");
}
