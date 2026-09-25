/**
 * Reading a TypeScript module as text: its imports, its top-level declarations, and which names
 * each one of them actually uses.
 *
 * Not a parser. It knows what biome has already guaranteed about every file in this repository --
 * imports sorted to the top, one declaration per column-zero line, everything inside a declaration
 * indented -- and nothing else. That is enough for split-module.ts to move declarations between
 * files, and the check that it was enough is `chunks` reassembling into the bytes it read.
 *
 * Moved out of split-module.ts by split-module.ts, which is the first thing it was pointed at.
 */
import { relative, resolve } from "node:path";

/** A top-level declaration with the comment written above it. */
export type Chunk = { name: string; text: string; exported: boolean; from: number };

/** Where a name in scope came from: another module, or a declaration in this file. */
export type Origin = { module: string; clause: string };

export const DECLARATION =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Strings and comments hold words that are not identifiers, so they are blanked before the scan --
 * except the `${}` holes in a template, which are code. Blanking those whole was the first bug this
 * script had: `escapeForPattern` is only ever called from inside a template, so the file it moved
 * to was the only place in the tree that did not know it had moved.
 */
export function code(text: string): string {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  let out = "";
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index] as string;
    if (character === '"' || character === "'") {
      index = closes(withoutComments, index, character);
      continue;
    }
    if (character !== "`") {
      out += character;
      continue;
    }
    index += 1;
    while (index < withoutComments.length && withoutComments[index] !== "`") {
      if (withoutComments[index] === "\\") index += 1;
      else if (withoutComments[index] === "$" && withoutComments[index + 1] === "{") {
        let depth = 1;
        const from = index + 2;
        index += 2;
        while (index < withoutComments.length && depth > 0) {
          if (withoutComments[index] === "{") depth += 1;
          if (withoutComments[index] === "}") depth -= 1;
          index += 1;
        }
        out += ` ${code(withoutComments.slice(from, index - 1))} `;
        continue;
      }
      index += 1;
    }
  }
  return out;
}

function closes(text: string, from: number, quote: string): number {
  let index = from + 1;
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
  return index;
}

/** The lines the import statements occupy, which biome has already sorted to the top of the file. */
export function importBlock(lines: string[]): { end: number; preamble: string[]; statements: string[] } {
  const statements: string[] = [];
  let index = 0;
  // A file may open with its own docblock above the imports. It belongs to the file, not to the
  // first declaration under it, and it has to come back out above the imports.
  while (index < lines.length && (COMMENT.test(lines[index] as string) || (lines[index] as string).trim() === ""))
    index += 1;
  const preamble = lines.slice(0, index);
  let end = index;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (!line.startsWith("import ")) break;
    let statement = line;
    while (!statement.trimEnd().endsWith(";") && index + 1 < lines.length) {
      index += 1;
      statement += `\n${lines[index]}`;
    }
    statements.push(statement);
    index += 1;
    end = index;
  }
  return { end, preamble, statements };
}

/** local name -> the `import ... from "..."` it needs, one clause per name so they recombine. */
export function importedNames(statements: string[]): Map<string, Origin> {
  const origins = new Map<string, Origin>();
  for (const statement of statements) {
    const from = /from\s+"([^"]+)"/.exec(statement);
    if (!from) continue;
    const module = from[1] as string;
    const head = statement.slice(0, from.index);
    const typeWhole = /^import\s+type\s/.test(head);
    const namespace = /import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(head);
    if (namespace)
      origins.set(namespace[1] as string, { module, clause: `${typeWhole ? "type " : ""}* as ${namespace[1]}` });
    const braces = /\{([\s\S]*)\}/.exec(head);
    if (braces)
      for (const piece of (braces[1] as string).split(",")) {
        const trimmed = piece.trim();
        if (trimmed === "") continue;
        const parts = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(trimmed);
        if (!parts) continue;
        const local = (parts[3] ?? parts[2]) as string;
        origins.set(local, {
          module,
          clause: `${typeWhole || parts[1] ? "type " : ""}${trimmed.replace(/^type\s+/, "")}`,
        });
      }
    const bare = /^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(head.trim());
    if (bare) origins.set(bare[1] as string, { module, clause: `${typeWhole ? "type " : ""}${bare[1]}` });
  }
  return origins;
}

/** Cuts the body into declarations, each carrying the comment block written directly above it. */
export function chunks(body: string[]): Chunk[] {
  const starts: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index] as string;
    if (!DECLARATION.test(line)) continue;
    starts.push(commentAbove(body, index));
  }
  const found: Chunk[] = [];
  for (let position = 0; position < starts.length; position += 1) {
    const from = starts[position] as number;
    const to = position + 1 < starts.length ? (starts[position + 1] as number) : body.length;
    const text = body.slice(from, to).join("\n");
    const declaration = body.slice(from, to).find((line) => DECLARATION.test(line)) as string;
    const parsed = DECLARATION.exec(declaration) as RegExpExecArray;
    found.push({ name: parsed[1] as string, text, exported: declaration.startsWith("export "), from });
  }
  return found;
}

/**
 * The comment block written directly above a declaration, and only that one. Two blocks stacked
 * means the upper one is about the module rather than the declaration -- which is how recap.ts is
 * written -- and carrying it along would move the file's own opening paragraph into a sibling.
 */
function commentAbove(body: string[], declaration: number): number {
  let first = declaration;
  while (first > 0 && COMMENT.test(body[first - 1] as string)) first -= 1;
  if (first === declaration) return first;
  const block = body.slice(first, declaration);
  for (let index = block.length - 1; index > 0; index -= 1)
    if ((block[index] as string).trimStart().startsWith("/*")) return first + index;
  return first;
}

/**
 * Names a chunk uses that cannot be imports: its own local declarations, its parameters, and the
 * keys of the objects it builds. All three shadow or simply are not the top-level name they share.
 * `changeBanner` declaring `const eyebrow` while `eyebrow` is also a function two files over is the
 * mistake this catches, and `function chunks(body: string[])` beside a top-level `body` is the one
 * it caught in this file. Anything followed by a colon is a typed parameter or an object key.
 */
export function declaredWithin(text: string): Set<string> {
  const inner = new Set<string>();
  const stripped = code(text);
  for (const match of stripped.matchAll(
    /(?:^|[\s(;{])(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  ))
    inner.add(match[1] as string);
  for (const match of stripped.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) inner.add(match[1] as string);
  return inner;
}

export function mentions(text: string): Set<string> {
  const stripped = code(text).replace(/\.\s*([A-Za-z_$][\w$]*)/g, " ");
  return new Set(stripped.match(IDENTIFIER) ?? []);
}

/** A relative specifier read from one file and written into a sibling has to be re-pointed. */
export function respecify(module: string, fromDirectory: string, toDirectory: string): string {
  if (!module.startsWith(".")) return module;
  const target = resolve(fromDirectory, module);
  const rewritten = relative(toDirectory, target);
  return rewritten.startsWith(".") ? rewritten : `./${rewritten}`;
}

export function importLines(needed: Map<string, Origin>): string[] {
  const byModule = new Map<string, string[]>();
  for (const origin of [...needed.values()].sort((a, b) => a.clause.localeCompare(b.clause))) {
    const clauses = byModule.get(origin.module) ?? [];
    if (!clauses.includes(origin.clause)) clauses.push(origin.clause);
    byModule.set(origin.module, clauses);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, clauses]) => {
      const star = clauses.find((clause) => clause.includes("* as "));
      if (star) return `import ${star} from "${module}";`;
      const allTypes = clauses.every((clause) => clause.startsWith("type "));
      const named = clauses.map((clause) => (allTypes ? clause.replace(/^type\s+/, "") : clause)).join(", ");
      return `import ${allTypes ? "type " : ""}{ ${named} } from "${module}";`;
    });
}
