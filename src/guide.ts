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

/**
 * How every command is spelled, which the usage lines cannot say because they only carry the
 * positional arguments. Written once here rather than in each summary.
 */
const CONVENTIONS = [
  "Any field a command accepts can be given as `--field value` or `--field=value`, spelled in kebab: `--min-confidence` is `minConfidence`. The usage line lists only the positional ones; they keep their slots when mixed with flags. `guide <command>` says the rest.",
  "Any command takes `--tsv` and answers with the largest table inside its report instead of JSON, naming the tables it passed over. `--tsv=now.issues` picks one of those by path. Reach for it before parsing JSON out of a terminal by hand.",
  "Every call on every surface is journalled, reads included. `usage` says which commands are actually used and which question has been asked by hand often enough to deserve one; `journal` shows only the calls that changed something.",
];

export type OperationsGuide = {
  service: string;
  route: string;
  /** The index, and only when nothing was named: see `buildOperationsGuide`. */
  conventions?: string[];
  sections?: { section: OperationSection; summary: string; commands: string[] }[];
  symptoms?: { symptom: string; command: string; usage: string }[];
  commands?: OperationCatalogEntry[];
  noSuchCommand?: string;
  whenTheDatabaseIsUnusable: string[];
};

/**
 * Read-only, and the first thing to run. Asked nothing it answers with section names and the
 * symptom index; asked for a section or a command it answers with those entries and drops the
 * index, because a caller reading the whole catalog to answer one question pays for all of it --
 * in bytes, and in the far more expensive currency of the answer being below the fold.
 */
export function buildOperationsGuide(
  catalog: readonly OperationCatalogEntry[],
  options: { section?: OperationSection | string; all?: boolean } = {},
): OperationsGuide {
  // One word is a section when it names one and a command otherwise, because nobody arriving with
  // a question knows which of the two they are holding, and getting it wrong printed an error
  // listing five section names rather than the thing they asked about.
  const named = options.section;
  const selected = options.all
    ? [...catalog]
    : named
      ? catalog.filter((entry) => entry.section === named || entry.name === named)
      : [];
  // Asked about one command, answer about one command. The index was printed above the answer
  // whatever was asked, so `guide news` put its four lines under a hundred lines of catalog the
  // caller already had; read through `head` -- which is how a terminal reads JSON -- the answer was
  // simply absent, and this agent concluded twice in one session that `guide <command>` did not
  // exist. The index is what you get when you do not know what to ask for, which is exactly the
  // case where nothing was named.
  const answeringOne = Boolean(named) && selected.length > 0 && !options.all;
  return {
    service: "signal-forge",
    route: "bun src/cli.ts <command> [arguments]",
    ...(answeringOne ? {} : { conventions: CONVENTIONS }),
    ...(answeringOne
      ? {}
      : {
          sections: OPERATION_SECTIONS.map((section) => ({
            section,
            summary: SECTION_SUMMARIES[section],
            commands: catalog.filter((entry) => entry.section === section).map((entry) => entry.name),
          })),
          symptoms: catalog
            .filter((entry) => entry.startHere)
            .map((entry) => ({ symptom: entry.startHere as string, command: entry.name, usage: entry.usage })),
        }),
    ...(selected.length ? { commands: selected } : {}),
    ...(named && selected.length === 0 ? { noSuchCommand: named } : {}),
    whenTheDatabaseIsUnusable: [
      "The service opens the database on start and migrates it; a failure there stops the process rather than running against a half-migrated schema.",
      "Restore from the newest verified archive in the backup directory, not from the live file: doctor reports which archive was verified and when.",
      "Never open the production database by hand to repair it. Stop the collector first, and rehearse any migration on a copy of this database with `bun run rehearse --only migration`.",
    ],
  };
}

/** The usage line a surface prints, written from the arguments the command actually takes. */
export function usageLine(command: string, args: readonly { name: string; optional?: boolean }[]): string {
  return [
    command,
    ...args.map((arg) => (arg.optional ? `[${cliFieldName(arg.name)}]` : `<${cliFieldName(arg.name)}>`)),
  ].join(" ");
}

/** One shell spelling for each schema field. */
export function cliFieldName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
