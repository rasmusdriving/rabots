// Everything the engine says goes to stderr. Stdout carries only the announcement line.
// Never pass secrets or environment values to these functions.

const debugOn = process.env.POBOTS_DEBUG === "1";
/** POBOTS_LOG=warn hides info lines (used by the tests, which may switch it back for a moment). */
const quiet = () => process.env.POBOTS_LOG === "warn";

function write(level: string, message: string, extra?: unknown): void {
  const time = new Date().toISOString();
  let line = `${time} ${level} ${message}`;
  if (extra !== undefined) {
    const text = extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra);
    line += ` ${text}`;
  }
  process.stderr.write(line + "\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, extra?: unknown) => {
    if (!quiet()) write("info", message, extra);
  },
  warn: (message: string, extra?: unknown) => write("warn", message, extra),
  error: (message: string, extra?: unknown) => write("error", message, extra),
  debug: (message: string, extra?: unknown) => {
    if (debugOn) write("debug", message, extra);
  },
  debugOn,
};
