// The main bot looks at one bot in full (get_bot) and works on any bot's files (bot_files), through
// the same engine methods as the window's Settings, Files and History tabs (docs/main-bot.md). A file
// change is saved in that bot's history with the main bot's name and can be undone there; the person
// gets one quiet line per bot per turn.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { ToolResult } from "../claude/session.js";
import { type BotFilesArgs, type GetBotArgs, ok, problem } from "../team.js";
import { EngineError } from "../errors.js";
import { accessLabel, clip, localWhen } from "./words.js";
import { jobSection } from "../bots.js";
import { shownWords } from "./restored-waiting.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedTitle, noteChange, quoted } from "./notes.js";
import { inventoryFor, seesWords } from "./sees-tools.js";
import { calendarBotWords } from "./calendar-settings.js";

const errText = (err: unknown, fallback: string) => (err instanceof EngineError ? err.message : fallback);
const MAX_READ = 100_000;
const MAX_DIFF = 40_000;

function settingsWords(eng: Engine, t: BotRuntime): string {
  const f = t.folder.file;
  let job = "";
  try {
    job = jobSection(readFileSync(join(t.folder.dir, "AGENTS.md"), "utf8")) ?? "";
  } catch {
    job = "";
  }
  const may = f.role === "main" ? "every bot" : f.mayMessage.length ? f.mayMessage.map((id) => eng.nameOf(id)).join(", ") : "only the main bot";
  return [
    `${f.name} (id ${t.folder.id}${f.role === "main" ? ", the main bot" : ""}). Now: ${shownWords(eng, t)}.`,
    `Purpose: ${f.purpose || "not written"}.`,
    `Model: ${eng.modelLabel(f.model)} (${f.model}), ${f.effort} effort${eng.hasFast(f.model) ? `, fast ${f.fast ? "on" : "off"}` : ""}.`,
    `Access: ${accessLabel(f.access)} (${f.access}).`,
    `When it is working, a message from the person: ${f.followUp ?? "the Pobots default"}.`,
    `Face: ${f.look.eyes} eyes, ${f.look.gap} gap, ${f.look.color ?? "grey"}.`,
    `May message: ${may}.`,
    `May steer other bots (message_bot delivery steer): ${f.role === "main" ? "yes, as the main bot" : f.maySteer ? "yes" : "no"}.`,
    calendarBotWords(eng, t),
    `Job (the 'Your job' part of AGENTS.md): ${job ? clip(job, 1500) : "not written"}`,
  ].join("\n");
}

/** get_bot: one bot in full. */
export async function getBotFor(eng: Engine, rt: BotRuntime, args: GetBotArgs): Promise<ToolResult> {
  void rt;
  const t = eng.findBot(args.bot);
  if (!t) return problem(`There is no bot called ${args.bot}. Use list_bots to see the others.`);
  const parts = args.parts?.length ? args.parts : ["settings", "sees"];
  const out: string[] = [];
  try {
    for (const part of parts) {
      switch (part) {
        case "settings":
          out.push(settingsWords(eng, t));
          break;
        case "sees": {
          const { inventory, problem: why } = await inventoryFor(eng, t);
          out.push(`What it sees:\n${seesWords(eng, t, inventory, why)}`);
          break;
        }
        case "rules": {
          const rules = eng.listRules(t.folder.id);
          out.push(rules.length ? `Always allowed rules (forget with update_bot forget_rules):\n${rules.map((r) => `- ${r.id}: ${r.label}`).join("\n")}` : "Always allowed rules: none.");
          break;
        }
        case "files": {
          const files = eng.listFiles(t.folder.id);
          out.push(`Files (times in ${eng.tz}):\n${files.map((f) => `- ${f.path} (${f.title}, ${f.size} bytes, changed ${localWhen(eng, f.modifiedAt)})`).join("\n") || "none"}`);
          break;
        }
        case "history":
          out.push(historyWords(eng, t));
          break;
        case "artifacts": {
          const list = eng.listArtifacts(t.folder.id);
          out.push(list.length ? `Artifacts:\n${list.map((a) => `- ${a.title}${a.path ? ` (${a.path})` : ""}${a.available ? "" : ", its file is gone"}`).join("\n")}` : "Artifacts: none.");
          break;
        }
      }
    }
  } catch (err) {
    return problem(errText(err, "The bot could not be read."));
  }
  return ok(out.join("\n\n"));
}

function historyWords(eng: Engine, t: BotRuntime, before?: string): string {
  const h = eng.history({ botId: t.folder.id, limit: 20, ...(before ? { before } : {}) });
  if (!h.changes.length) return "History: no changes yet.";
  return `Recent changes, newest first, times in ${eng.tz} (show_change or undo with bot_files):\n${h.changes
    .map((c) => `- ${c.id.slice(0, 12)}: ${c.summary} (${localWhen(eng, c.at)}, by ${c.by === "you" ? "the person" : c.by === "bot" ? "the bot" : "Pobots or the main bot"}${c.files.length ? `; ${c.files.slice(0, 5).join(", ")}` : ""}${c.canUndo ? "" : "; cannot be undone"})`)
    .join("\n")}${h.hasMore ? "\nThere are older changes." : ""}`;
}

/** A change id from a short one: the full id of the change in the history that starts with it. */
function fullChange(eng: Engine, t: BotRuntime, ref: string): string {
  const r = ref.trim();
  if (r.length >= 40) return r;
  const hit = eng.history({ botId: t.folder.id, limit: 200 }).changes.find((c) => c.id.startsWith(r));
  if (!hit) throw new EngineError("not_found", "There is no such change in this bot's history. bot_files history lists them.");
  return hit.id;
}

/** bot_files: any bot's files, as the window's Files and History tabs do. */
export function botFilesFor(eng: Engine, rt: BotRuntime, args: BotFilesArgs): ToolResult {
  const t = eng.findBot(args.bot);
  if (!t) return problem(`There is no bot called ${args.bot}. Use list_bots to see the others.`);
  const me = rt.folder.file.name;
  const name = t.folder.file.name;
  const note = (line: string) => noteChange(eng, rt, `bot:${t.folder.id}`, changedTitle(t), [line]);
  const needPath = () => {
    if (!args.path?.trim()) throw new EngineError("bad_request", "Give the path of the file, relative to the bot's folder.");
    return args.path.trim();
  };
  try {
    switch (args.action) {
      case "list": {
        const files = eng.listFiles(t.folder.id);
        return ok(files.length ? files.map((f) => `- ${f.path} (${f.title}, ${f.size} bytes)`).join("\n") : `${name} has no files yet.`);
      }
      case "read": {
        const r = eng.readFile({ botId: t.folder.id, path: needPath() });
        const cut = r.text.length > MAX_READ;
        return ok(`${r.file.path}, rev ${r.rev}${cut ? `, the first ${MAX_READ} characters of ${r.text.length}` : ""}:\n\n${cut ? r.text.slice(0, MAX_READ) : r.text}`);
      }
      case "write": {
        const path = needPath();
        if (args.text === undefined) return problem("Give the whole new text of the file.");
        let existed = true;
        try {
          eng.readFile({ botId: t.folder.id, path });
        } catch {
          existed = false;
        }
        const summary = path === "AGENTS.md" ? `${me} edited the job file` : `${me} ${existed ? "edited" : "added"} ${path}`;
        const r = eng.writeFile({ botId: t.folder.id, path, text: args.text, ...(args.base_rev ? { baseRev: args.base_rev } : {}) }, "app", summary);
        note(`${existed ? "edited" : "added"} ${r.file.path}`);
        return ok(`Saved ${r.file.path} (rev ${r.rev}) in ${name}'s folder. It is in ${name}'s History and can be undone there.`);
      }
      case "delete": {
        const path = needPath();
        eng.deleteFile({ botId: t.folder.id, path }, "app", `${me} removed ${path}`);
        note(`removed ${path}`);
        return ok(`Removed ${path} from ${name}'s folder. It is in ${name}'s History and can be undone there.`);
      }
      case "history":
        return ok(historyWords(eng, t, args.change ? fullChange(eng, t, args.change) : undefined));
      case "show_change": {
        if (!args.change) return problem("Give the change id from history.");
        const r = eng.readChange({ botId: t.folder.id, changeId: fullChange(eng, t, args.change) });
        const cut = r.diff.length > MAX_DIFF;
        return ok(`${r.change.summary} (${localWhen(eng, r.change.at)})${r.change.canUndo ? "" : ", cannot be undone"}:\n\n${cut ? `${r.diff.slice(0, MAX_DIFF)}\n...` : r.diff}`);
      }
      case "undo": {
        if (!args.change) return problem("Give the change id from history.");
        const r = eng.undoChange({ botId: t.folder.id, changeId: fullChange(eng, t, args.change) });
        note(`undid ${quoted(r.change.summary.replace(/^Undid: /, ""), 80)}`);
        return ok(`${r.change.summary}. It is a new change in ${name}'s History.`);
      }
      case "remove_artifact": {
        const path = needPath();
        const a = eng.listArtifacts(t.folder.id).find((x) => x.path === path || x.id === path || x.title.toLowerCase() === path.toLowerCase());
        if (!a) return problem(`${name} has no artifact at ${path}. get_bot with parts artifacts lists them.`);
        eng.removeArtifact({ botId: t.folder.id, artifactId: a.id });
        note(`took the artifact ${a.title} off its list, the file stays`);
        return ok(`Took ${a.title} off ${name}'s list of artifacts. Its file stays in the folder.`);
      }
    }
  } catch (err) {
    return problem(errText(err, "That could not be done."));
  }
  return problem("Unknown action.");
}
