// Bot folders on disk: one folder per bot under the bots dir (see docs/bot-model.md).
//   bot.json, AGENTS.md, CLAUDE.md (@AGENTS.md), WORKERS.md, memory/MEMORY.md, skills/, triggers/, state/
// The folder is the source of truth for a bot's settings. Runtime state is never written here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FollowUp, AccessLevel, BotColor, BotLook, BotSees, Effort, EyeGap, EyeShape, Harness } from "../shared/protocol.js";
import { BOT_COLORS, EYE_GAPS, EYE_SHAPES } from "../shared/protocol.js";
import { ensureRepo, gitAvailable } from "./history.js";
import { cleanSees } from "./claude/sees.js";
import { DEFAULT_WORKERS_MD, WORKERS_FILE } from "./workers.js";

export { gitAvailable };

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_ACCESS: AccessLevel = "asks-first";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ACCESS: AccessLevel[] = ["asks-first", "edits-freely", "decides-itself", "full-access"];

/** What bot.json holds. Files made before step 2a have no purpose or mayMessage; they read as empty. */
export interface BotFile {
  name: string;
  role: "main" | "bot";
  /** One line about what the bot is for. May be empty. */
  purpose: string;
  look: BotLook;
  /** Always the harness of `model`; the engine sets it whenever the model is set (step 3a). */
  harness: Harness;
  model: string;
  effort: Effort;
  /**
   * The bot's choice for fast mode (step 3b), kept for any model; it has an effect only while the
   * model has a fast mode. A file without it reads as true: GPT bots ran fast before this setting.
   */
  fast: boolean;
  access: AccessLevel;
  machine: string;
  /** Ids of the bots this bot may message. The main bot may message every bot whatever this says. */
  mayMessage: string[];
  /** May steer other bots (15 Nov 2026). Absent: no. The main bot always may. */
  maySteer?: boolean;
  /** Has the calendar tools (16 Nov 2026). Absent: on for the main bot, off for the others. */
  calendar?: boolean;
  /** Step 7b: the bot's own choice for a message sent while it works. Absent: the Pobots default. */
  followUp?: FollowUp;
  /** What the bot sees of the person's own Claude Code setup (docs/sees.md). Absent: everything. */
  sees?: BotSees;
}

export interface BotFolder {
  id: string;
  dir: string;
  file: BotFile;
}

// ------------------------------------------------------------ names and looks

/** A lowercase folder name from a bot name: "Kaja Ö" becomes "kaja-o". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "bot";
}

/** A slug that is not in `taken`, adding -2, -3 and so on when needed. */
export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function allLooks(): BotLook[] {
  const looks: BotLook[] = [];
  for (const eyes of EYE_SHAPES) for (const gap of EYE_GAPS) looks.push({ eyes, gap });
  return looks;
}

/** A look no other bot has. When all twelve are taken, one of the least used. */
export function pickLook(used: BotLook[], random: () => number = Math.random): BotLook {
  const counts = new Map<string, number>();
  for (const l of used) counts.set(lookKey(l), (counts.get(lookKey(l)) ?? 0) + 1);
  const looks = allLooks();
  const least = Math.min(...looks.map((l) => counts.get(lookKey(l)) ?? 0));
  const free = looks.filter((l) => (counts.get(lookKey(l)) ?? 0) === least);
  return free[Math.floor(random() * free.length) % free.length]!;
}

/**
 * A colour no other bot has, from the palette in its order; when all are taken, the first of the
 * least used (step 7a). Grey (the old face) comes last, so new bots get a real colour first.
 */
export function pickColor(used: (BotColor | undefined)[]): BotColor {
  const counts = new Map<BotColor, number>();
  for (const c of used) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  const order = [...BOT_COLORS.filter((c) => c !== "grey"), "grey" as const];
  const least = Math.min(...order.map((c) => counts.get(c) ?? 0));
  return order.find((c) => (counts.get(c) ?? 0) === least)!;
}

export function isColor(value: unknown): value is BotColor {
  return BOT_COLORS.includes(value as BotColor);
}

export function lookKey(look: BotLook): string {
  return `${look.eyes}/${look.gap}`;
}

export function isLook(value: unknown): value is BotLook {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return EYE_SHAPES.includes(v.eyes as EyeShape) && EYE_GAPS.includes(v.gap as EyeGap);
}

// ------------------------------------------------------------ reading

/**
 * Reads every bot folder under the bots dir. Missing or wrong fields get defaults, so a folder
 * edited by hand still loads. Folders without a bot.json are skipped.
 */
export function readBotFolders(botsDir: string, machine: string): { bots: BotFolder[]; problems: string[] } {
  const bots: BotFolder[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(botsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return { bots, problems: [`Could not read the bots folder ${botsDir}.`] };
  }
  for (const id of names) {
    const dir = join(botsDir, id);
    const path = join(dir, "bot.json");
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      problems.push(`The settings of the bot in ${id} could not be read, so it was left out.`);
      continue;
    }
    bots.push({ id, dir, file: normalizeBotFile(raw, id, machine) });
  }
  return { bots, problems };
}

export function normalizeBotFile(raw: unknown, id: string, machine: string): BotFile {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : id,
    role: r.role === "main" ? "main" : "bot",
    purpose: typeof r.purpose === "string" ? oneLine(r.purpose) : "",
    look: isLook(r.look) ? { eyes: r.look.eyes, gap: r.look.gap, ...(isColor(r.look.color) ? { color: r.look.color } : {}) } : { eyes: "round", gap: "mid" },
    harness: r.harness === "codex" ? "codex" : "claude",
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : DEFAULT_MODEL,
    effort: EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort) : DEFAULT_EFFORT,
    fast: r.fast !== false,
    access: ACCESS.includes(r.access as AccessLevel) ? (r.access as AccessLevel) : DEFAULT_ACCESS,
    machine: typeof r.machine === "string" && r.machine ? r.machine : machine,
    mayMessage: Array.isArray(r.mayMessage)
      ? [...new Set(r.mayMessage.filter((x): x is string => typeof x === "string" && x !== id && /^[a-z0-9][a-z0-9-]*$/.test(x)))]
      : [],
    ...(r.maySteer === true ? { maySteer: true } : {}),
    ...(typeof r.calendar === "boolean" ? { calendar: r.calendar } : {}),
    ...(r.followUp === "steer" || r.followUp === "queue" ? { followUp: r.followUp } : {}),
    ...withSees(cleanSees(r.sees)),
  };
}

const withSees = (sees: BotSees | undefined): { sees?: BotSees } => (sees ? { sees } : {});

/** Text on one line, spaces collapsed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------ writing

export function writeBotFile(dir: string, file: BotFile): void {
  const path = join(dir, "bot.json");
  const tmp = path + ".tmp";
  // Always the whole, current shape, in a fixed order.
  const out: BotFile = {
    name: file.name,
    role: file.role,
    purpose: file.purpose,
    look: file.look,
    harness: file.harness,
    model: file.model,
    effort: file.effort,
    fast: file.fast !== false,
    access: file.access,
    machine: file.machine,
    mayMessage: file.mayMessage,
    ...(file.maySteer ? { maySteer: true } : {}),
    ...(file.calendar !== undefined ? { calendar: file.calendar } : {}),
    ...(file.followUp ? { followUp: file.followUp } : {}),
    ...(file.sees ? { sees: file.sees } : {}),
  };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, path);
}

const JOB_PLACEHOLDER = "Not written yet. Ask the person what they want you to do, then write it down here in a few plain sentences.";

export function starterAgentsMd(name: string, role: "main" | "bot", job?: string): string {
  const lines = [
    `# ${name}`,
    "",
    `You are ${name}, a bot in Pobots. Pobots is the app where the person keeps their bots and talks to them.`,
  ];
  if (role === "main") lines.push("You are the main bot. You help coordinate the other bots.");
  lines.push(
    "",
    "## Your job",
    "",
    job && job.trim() ? job.trim() : JOB_PLACEHOLDER,
    "",
    "## How you work",
    "",
    "- Speak plainly and keep replies short.",
    "- Ask before you do anything that cannot be undone or that other people will see.",
    "- Keep `memory/MEMORY.md` as a short index of what you need to remember. Put the details in other files under `memory/`.",
    "- Keep your own files in this folder.",
    "",
  );
  return lines.join("\n");
}

/**
 * Replaces the text under "## Your job" in an AGENTS.md, keeping the rest. Adds the section when
 * the file has none.
 */
export function replaceJobSection(agentsMd: string, job: string): string {
  const body = job.trim() || JOB_PLACEHOLDER;
  const lines = agentsMd.split("\n");
  const start = lines.findIndex((l) => /^##\s+your job\s*$/i.test(l.trim()));
  if (start < 0) return `${agentsMd.replace(/\s*$/, "")}\n\n## Your job\n\n${body}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const out = [...lines.slice(0, start + 1), "", body, "", ...lines.slice(end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The text under "## Your job", or undefined when there is no such section. */
export function jobSection(agentsMd: string): string | undefined {
  const lines = agentsMd.split("\n");
  const start = lines.findIndex((l) => /^##\s+your job\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]!); i++) body.push(lines[i]!);
  return body.join("\n").trim();
}

const GITIGNORE = [".DS_Store", ".claude/settings.local.json", "*.pobots-tmp", "bot.json.tmp", ".attachments/", ""].join("\n");

/** Creates a bot folder with its starter files, and a git repository with a first commit when git is there. */
export function createBotFolder(botsDir: string, id: string, file: BotFile, job?: string): BotFolder {
  const dir = join(botsDir, id);
  if (existsSync(dir)) throw new Error(`A folder named ${id} already exists.`);
  mkdirSync(dir, { recursive: true });
  for (const sub of ["memory", "skills", "triggers", "state"]) mkdirSync(join(dir, sub), { recursive: true });
  writeBotFile(dir, file);
  writeFileSync(join(dir, "AGENTS.md"), starterAgentsMd(file.name, file.role, job));
  writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(join(dir, "memory", "MEMORY.md"), "# Memory\n\nNothing yet.\n");
  // What every worker of this bot is told (step workers); the person tunes it in the app.
  writeFileSync(join(dir, WORKERS_FILE), DEFAULT_WORKERS_MD);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  for (const sub of ["skills", "triggers", "state"]) writeFileSync(join(dir, sub, ".gitkeep"), "");
  try {
    ensureRepo(dir, "Created the bot");
  } catch {
    // Best effort: a missing git or a failed commit never stops a bot from being created.
  }
  return { id, dir, file };
}

// ------------------------------------------------------------ the archive

export const ARCHIVE_DIR = ".archive";

/** Ids that have a folder in the archive ("<id>-<YYYY-MM-DD>" or "<id>-<YYYY-MM-DD>-<n>"). */
export function archivedIds(botsDir: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(botsDir, ARCHIVE_DIR))) {
      const m = /^(.+)-\d{4}-\d{2}-\d{2}(?:-\d+)?$/.exec(name);
      if (m) ids.add(m[1]!);
    }
  } catch {
    // no archive yet
  }
  return ids;
}

/** Moves a bot's folder to `<botsDir>/.archive/<id>-<date>/`. Returns the new path. */
export function archiveBotFolder(botsDir: string, id: string, date = new Date()): string {
  const archive = join(botsDir, ARCHIVE_DIR);
  mkdirSync(archive, { recursive: true });
  const day = date.toISOString().slice(0, 10);
  let target = join(archive, `${id}-${day}`);
  for (let n = 2; existsSync(target); n++) target = join(archive, `${id}-${day}-${n}`);
  renameSync(join(botsDir, id), target);
  return target;
}
