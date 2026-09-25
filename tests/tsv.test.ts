import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";
import { operationCatalog, operations } from "../src/operations.js";
import { openDatabase } from "../src/storage/database.js";
import { asTsv } from "../src/text.js";

const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
const testConfig = () => loadConfig({ CONFIG_PATH: configPath, BACKUP_DIRECTORY: "./tests/fixtures/backups" });

describe("an answer as a table", () => {
  test("rows print as a table, with the columns the rows between them have", () => {
    expect(
      asTsv({
        rows: [
          { source: "arena", n: 17 },
          { source: "pages:claude-docs", n: 21 },
        ],
      }),
    ).toBe("source\tn\narena\t17\npages:claude-docs\t21");
    expect(asTsv({ rows: [{ a: 1 }, { a: 2, b: "x" }] })).toBe("a\tb\n1\t\n2\tx");
    // A tab inside a value would invent a column; a newline would invent a row.
    expect(asTsv({ rows: [{ a: "one\ttwo\nthree" }] })).toBe("a\none two three");
  });

  test("a report's table is found wherever it is, and the ones it beat are named", () => {
    // This is the whole defect: `--tsv` looked only at `value.rows`, so it worked for `sql` and
    // for nothing else, while the guide said every command took it.
    const report = {
      headline: "four things",
      readings: [{ source: "arena" }, { source: "cerebras" }, { source: "pages" }],
      now: { issues: [{ id: "backup:stale" }] },
    };
    const printed = asTsv(report) as string;
    expect(printed.split("\n")[0]).toBe("# readings, not now.issues (1)");
    expect(printed).toContain("arena");
    expect(printed).not.toContain("backup:stale");
  });

  test("a named path picks a table, and a wrong one lists the paths there are", () => {
    const report = { readings: [{ source: "arena" }], now: { issues: [{ id: "backup:stale" }] } };
    expect(asTsv(report, "now.issues")).toBe("id\nbackup:stale");
    expect(asTsv(report, "nope")).toBe("# no table at nope. There is: readings, now.issues");
  });

  test("an answer with no rows in it anywhere keeps its punctuation", () => {
    expect(asTsv({ rows: [] })).toBeNull();
    expect(asTsv({ schema: { version: 53 } })).toBeNull();
    expect(asTsv("plain")).toBeNull();
  });

  test("every command the guide promises a table for can produce one", () => {
    const db = openDatabase(":memory:");
    // The guide says "any command takes --tsv". It said that while it was true of one command out
    // of fifty-seven, and nothing could catch that, because the sentence and the code never met.
    // They meet here: a report whose shape holds rows must print them.
    const shapes: Record<string, unknown> = {
      broken: { readings: [{ source: "arena", readings: ["now"] }] },
      usage: { commands: [{ operation: "sql", calls: 44 }] },
      flaky: { sources: [{ source: "arena", faultRate: 0.28 }] },
      failures: { failures: [{ kind: "degraded", count: 73 }] },
      references: { referencedBy: [{ table: "suppressions", onDelete: "NO ACTION" }] },
      destinations: { destinations: [{ id: "discord-signals", quietFor: "2h" }] },
      timings: { sections: [{ name: "pipeline", p95: 237 }] },
      sql: { rows: [{ n: 1 }] },
    };
    const known = new Set(operationCatalog(operations(db, testConfig())).map((entry) => entry.name));
    for (const [command, answer] of Object.entries(shapes)) {
      expect(known.has(command), `${command} is not a command`).toBeTrue();
      expect(asTsv(answer), `${command} produces no table`).not.toBeNull();
    }
    db.close();
  });
});
