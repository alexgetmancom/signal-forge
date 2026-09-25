import { describe, expect, test } from "bun:test";
import {
  chunks,
  code,
  declaredWithin,
  importBlock,
  importedNames,
  importLines,
  mentions,
  respecify,
} from "../scripts/moduleParts.js";

const FILE = `/**
 * What the module is about.
 */
import { join } from "node:path";
import {
  alpha,
  beta,
} from "./other.js";

/** What PLACES is about. */
const PLACES = ["a"];

/** What run is about. */
export function run(input: string): string {
  const alpha = join(input, "x");
  return \`\${beta(alpha)}\`;
}
`;

describe("reading a module as text", () => {
  test("separates the opening docblock, the imports and the body", () => {
    const lines = FILE.split("\n");
    const block = importBlock(lines);
    expect(block.preamble.join("\n")).toContain("What the module is about");
    expect(block.statements).toHaveLength(2);
    expect(block.statements[1]).toContain("beta");
    expect(lines.slice(block.end).join("\n")).toContain("const PLACES");
  });

  test("cuts declarations that reassemble into the file they came from", () => {
    const lines = FILE.split("\n");
    const block = importBlock(lines);
    const body = lines.slice(block.end);
    const cut = chunks(body);
    expect(cut.map((chunk) => chunk.name)).toEqual(["PLACES", "run"]);
    expect(cut.map((chunk) => chunk.exported)).toEqual([false, true]);
    const header = body.slice(0, cut[0]?.from);
    const back = [...block.preamble, ...block.statements, ...header, ...cut.map((chunk) => chunk.text)].join("\n");
    expect(back.replace(/\n+/g, "\n").trim()).toEqual(FILE.replace(/\n+/g, "\n").trim());
  });

  test("a docblock stacked above another belongs to the module, not to the declaration", () => {
    const cut = chunks(["/** The module. */", "/** The constant. */", "const ONE = 1;"]);
    expect(cut[0]?.text).toEqual("/** The constant. */\nconst ONE = 1;");
  });

  test("names one import clause per name, carrying whether it is a type", () => {
    const origins = importedNames([
      'import type { Database } from "bun:sqlite";',
      'import { alpha, type Beta, gamma as delta } from "./other.js";',
    ]);
    expect(origins.get("Database")).toEqual({ module: "bun:sqlite", clause: "type Database" });
    expect(origins.get("Beta")).toEqual({ module: "./other.js", clause: "type Beta" });
    expect(origins.get("delta")?.clause).toEqual("gamma as delta");
    expect(origins.has("gamma")).toBeFalse();
  });

  test("rebuilds an import block, collapsing an all-type one into a single `import type`", () => {
    expect(
      importLines(
        new Map([
          ["Beta", { module: "./other.js", clause: "type Beta" }],
          ["Alpha", { module: "./other.js", clause: "type Alpha" }],
          ["join", { module: "node:path", clause: "join" }],
        ]),
      ),
    ).toEqual(['import type { Alpha, Beta } from "./other.js";', 'import { join } from "node:path";']);
  });

  test("keeps the code inside a template hole and drops the text around it", () => {
    const hole = ["const x = `prose about beta ", "$", "{gamma(delta)} more prose`;"].join("");
    const scanned = code(hole);
    expect(scanned).toContain("gamma");
    expect(scanned).toContain("delta");
    expect(scanned).not.toContain("prose");
    expect(scanned).not.toContain("beta");
  });

  test("a local declaration, a parameter and an object key are not imports", () => {
    const inner = declaredWithin("function run(input: string) {\n  const alpha = 1;\n  return { beta: alpha };\n}");
    expect([...inner].sort()).toEqual(["alpha", "beta", "input", "run"]);
  });

  test("mentions skips property names, which are not free identifiers", () => {
    const used = mentions("const x = shape.paths.length + paths;");
    expect(used.has("shape")).toBeTrue();
    expect(used.has("paths")).toBeTrue();
    expect(used.has("length")).toBeFalse();
  });

  test("re-points a relative specifier read in one directory and written in another", () => {
    expect(respecify("./events/types.js", "/repo/src", "/repo/src/events")).toEqual("./types.js");
    expect(respecify("./config.js", "/repo/src", "/repo/src/events")).toEqual("../config.js");
    expect(respecify("bun:sqlite", "/repo/src", "/repo/src/events")).toEqual("bun:sqlite");
  });
});
