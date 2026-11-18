// Reads a file of `NAME=value` or `export NAME=value` lines. The values are secrets as far as the
// engine is concerned: they go into the harness environment and nowhere else.
import { readFileSync } from "node:fs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses env file text. Blank lines and `#` comments are skipped. Variables are not expanded. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ") || line.startsWith("export\t")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!NAME.test(name)) continue;
    out[name] = parseValue(line.slice(eq + 1).trim());
  }
  return out;
}

function parseValue(rest: string): string {
  if (rest.startsWith('"')) {
    let value = "";
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === "\\" && i + 1 < rest.length) {
        const next = rest[i + 1]!;
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i++;
      } else if (ch === '"') {
        return value;
      } else {
        value += ch;
      }
    }
    return value;
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  // Unquoted: a ` #` starts a comment.
  const hash = rest.search(/\s#/);
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/** Reads and parses an env file. Returns undefined when it cannot be read. Never logs values. */
export function readEnvFile(path: string): Record<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
