// Step 7c: to-dos for the person (docs/build/step-7c.md, part 2). A bot puts something on the
// person's list that he must do or decide and that can wait; the modal Pobots draws for it is built
// from fixed kinds of blocks, never from HTML. This file checks and shapes what a bot asks for, and
// holds the words: the tool results, the person's answer as a message, and the bot's list. The
// engine keeps them (store.ts, table todos) and wakes the bot (engine.ts).
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { downloadFileName } from "../shared/downloads.js";
import { fileInFolder } from "./downloads.js";
import type { Artifact, Todo, TodoBlock, TodoButton } from "../shared/protocol.js";
import { TODO_BLOCKS_MAX, TODO_BUTTONS_MAX } from "../shared/protocol.js";
import { sniffHead } from "./attachments.js";

export const TITLE_MAX = 100;
export const WHY_MAX = 200;
const TEXT_MAX = 20_000;
const LABEL_MAX = 80;
const VALUE_MAX = 500;
const URL_MAX = 2000;
const FACTS_MAX = 30;
const CHOICES_MAX = 12;
/** All the words of one to-do together. */
const TOTAL_MAX = 100_000;
/** What the person may type into one field. */
export const ANSWER_MAX = 20_000;

/** A block as a bot gives it to add_todo or update_todo: one flat shape for every kind. */
export interface BlockArg {
  type: string;
  text?: string;
  label?: string;
  url?: string;
  path?: string;
  facts?: { label: string; value: string }[];
  id?: string;
  input?: string;
  choices?: string[];
  placeholder?: string;
  value?: string;
}

export interface TodoArgs {
  title?: string;
  why?: string;
  by_when?: string;
  blocks?: BlockArg[];
  buttons?: { id?: string; label: string; primary?: boolean }[];
  keep_open?: boolean;
}

/** A to-do as the engine keeps it: the open one the app sees, and what became of it. */
export interface TodoRow {
  todo: Todo;
  status: "open" | "answered" | "done" | "dismissed" | "removed" | "retired";
  closedAt?: string;
}

export function newTodoId(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return "todo_" + [...randomBytes(16)].map((b) => abc[b % abc.length]).join("");
}

export function isTodoId(s: unknown): s is string {
  return typeof s === "string" && /^todo_[a-z0-9]{16}$/.test(s);
}

/** Plain one-line text: control characters out, spaces folded, cut at `max`. */
function line(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Text that may hold lines: control characters but line breaks and tabs out. */
function body(v: unknown): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
}

/** An id the bot gave, or one made from the label: lower case letters, digits, "-" and "_". */
function slug(given: unknown, label: string, taken: Set<string>, fallback: string): string {
  const base = (typeof given === "string" && given.trim() ? given : label)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** "2026-11-20" or "2026-11-20T15:00" (also with seconds), or undefined; throws plain words for anything else. */
export function cleanDue(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (!m) throw new Error(`by_when must be a day like 2026-11-20, or a day and a time like 2026-11-20T15:00, not "${line(s, 40)}".`);
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 0 : Number(m[4]), m[5] === undefined ? 0 : Number(m[5])];
  const t = new Date(y, mo - 1, d, h, mi);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || h > 23 || mi > 59) throw new Error(`by_when is not a real day or time: "${s}".`);
  return m[4] === undefined ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/** What the engine gives buildTodo to check a file or a page in the bot's folder. */
export interface TodoContext {
  botDir: string;
  /** The bot's artifact for an HTML file in its folder (made when new, as show_artifact does), or plain words why not. */
  page(path: string): Artifact | string;
}

/** A file in the bot's folder, or plain words the bot can act on. */
export function todoFileInFolder(botDir: string, given: string) {
  const raw = given.trim();
  if (!raw || raw.includes("\0")) return "Give the path of a file in your folder.";
  const f = fileInFolder(botDir, raw);
  const name = line(raw, 120);
  switch (f) {
    case "outside": return `${name} is outside your folder. Copy the file into your folder first.`;
    case "linked-outside": return `${name} is a link to a place outside your folder. Copy the file itself into your folder.`;
    case "not-file": return `${name} is not a file.`;
    case "missing": return `There is no file at ${name} in your folder.`;
    default: return f;
  }
}

/** The kind of picture a file is by its first bytes, when it is one the app may show. */
export function pictureType(full: string): string | undefined {
  try {
    const head = Buffer.alloc(16);
    const fd = openSync(full, "r");
    try {
      readSync(fd, head, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return sniffHead(head);
  } catch {
    return undefined;
  }
}

/**
 * Checks what a bot gave and makes the blocks and buttons of a to-do. Throws an Error with plain
 * words for the bot when something is wrong, so it can fix it and try again.
 */
export function buildParts(args: Pick<TodoArgs, "blocks" | "buttons">, ctx: TodoContext): { blocks: TodoBlock[]; buttons: TodoButton[] } {
  const blocks = buildBlocks(args.blocks, ctx);
  return { blocks, buttons: buildButtons(args.buttons, blocks.some((b) => b.type === "field")) };
}

/** The blocks of a to-do, checked. Throws plain words. */
export function buildBlocks(raw: BlockArg[] | undefined, ctx: TodoContext): TodoBlock[] {
  const given = Array.isArray(raw) ? raw : [];
  if (given.length > TODO_BLOCKS_MAX) throw new Error(`A to-do can have at most ${TODO_BLOCKS_MAX} blocks.`);
  const blocks: TodoBlock[] = [];
  const fieldIds = new Set<string>();
  given.forEach((b, i) => {
    const n = `Block ${i + 1}`;
    const type = String(b?.type ?? "");
    switch (type) {
      case "text": {
        const text = body(b.text);
        if (!text) throw new Error(`${n} (text) needs text.`);
        if (text.length > TEXT_MAX) throw new Error(`${n} (text) is too long: at most ${TEXT_MAX} characters.`);
        blocks.push({ type: "text", text });
        return;
      }
      case "facts": {
        const facts = (Array.isArray(b.facts) ? b.facts : []).map((f) => ({ label: line(f?.label, LABEL_MAX), value: line(f?.value, VALUE_MAX) })).filter((f) => f.label && f.value);
        if (!facts.length) throw new Error(`${n} (facts) needs facts, each with a label and a value.`);
        if (facts.length > FACTS_MAX) throw new Error(`${n} (facts) can have at most ${FACTS_MAX} facts.`);
        blocks.push({ type: "facts", facts });
        return;
      }
      case "link": {
        const url = typeof b.url === "string" ? b.url.trim() : "";
        let ok = false;
        try {
          const u = new URL(url);
          ok = (u.protocol === "https:" || u.protocol === "mailto:") && url.length <= URL_MAX;
        } catch {
          ok = false;
        }
        if (!ok) throw new Error(`${n} (link) needs a url that starts with https:// or mailto:.`);
        blocks.push({ type: "link", label: line(b.label, LABEL_MAX) || line(url, LABEL_MAX), url });
        return;
      }
      case "copy": {
        const text = body(b.text);
        if (!text) throw new Error(`${n} (copy) needs the text to copy.`);
        if (text.length > TEXT_MAX) throw new Error(`${n} (copy) is too long: at most ${TEXT_MAX} characters.`);
        const label = line(b.label, LABEL_MAX);
        blocks.push({ type: "copy", text, ...(label ? { label } : {}) });
        return;
      }
      case "file": {
        const f = todoFileInFolder(ctx.botDir, String(b.path ?? ""));
        if (typeof f === "string") throw new Error(`${n} (file): ${f}`);
        // Protocol 28 keeps the display label in name. The download takes its name from path.
        blocks.push({ type: "file", path: f.rel, name: line(b.label, LABEL_MAX) || downloadFileName(f.rel), picture: !!pictureType(f.full), size: f.size });
        return;
      }
      case "page": {
        const a = ctx.page(String(b.path ?? ""));
        if (typeof a === "string") throw new Error(`${n} (page): ${a}`);
        blocks.push({ type: "page", artifact: a });
        return;
      }
      case "field": {
        const label = line(b.label, LABEL_MAX);
        if (!label) throw new Error(`${n} (field) needs a label.`);
        const input = b.input ?? "short";
        if (input !== "short" && input !== "long" && input !== "choice") throw new Error(`${n} (field): input must be short, long or choice.`);
        const choices = (Array.isArray(b.choices) ? b.choices : []).map((c) => line(c, LABEL_MAX)).filter(Boolean);
        if (input === "choice" && choices.length < 2) throw new Error(`${n} (field) is a choice: give at least two choices.`);
        if (choices.length > CHOICES_MAX) throw new Error(`${n} (field) can have at most ${CHOICES_MAX} choices.`);
        const placeholder = line(b.placeholder, LABEL_MAX);
        const value = input === "long" ? body(b.value).slice(0, ANSWER_MAX) : line(b.value, VALUE_MAX);
        if (input === "choice" && value && !choices.includes(value)) throw new Error(`${n} (field): its value must be one of its choices.`);
        blocks.push({
          type: "field",
          id: slug(b.id, label, fieldIds, `field-${i + 1}`),
          label,
          input,
          ...(input === "choice" ? { choices } : {}),
          ...(placeholder && input !== "choice" ? { placeholder } : {}),
          ...(value ? { value } : {}),
        });
        return;
      }
      default:
        throw new Error(`${n} has an unknown type "${line(type, 30)}". Use text, facts, link, copy, file, page or field.`);
    }
  });
  return blocks;
}

/** The buttons of a to-do, checked; a plain "Send" when there are fields and no button. Throws plain words. */
export function buildButtons(raw: TodoArgs["buttons"], hasFields: boolean): TodoButton[] {
  const rawButtons = Array.isArray(raw) ? raw : [];
  if (rawButtons.length > TODO_BUTTONS_MAX) throw new Error(`A to-do can have at most ${TODO_BUTTONS_MAX} buttons.`);
  const buttonIds = new Set<string>();
  const buttons: TodoButton[] = rawButtons.map((b, i) => {
    const label = line(b?.label, 40);
    if (!label) throw new Error(`Button ${i + 1} needs a label.`);
    return { id: slug(b.id, label, buttonIds, `button-${i + 1}`), label, ...(b.primary ? { primary: true } : {}) };
  });
  if (buttons.filter((b) => b.primary).length > 1) throw new Error("At most one button can be primary.");
  // Fields without a button of the bot's: one plain "Send", so what he types can reach the bot.
  if (!buttons.length && hasFields) buttons.push({ id: "send", label: "Send", primary: true });
  if (buttons.length && !buttons.some((b) => b.primary)) buttons[0] = { ...buttons[0]!, primary: true };
  return buttons;
}

/** A new to-do from add_todo's arguments. Throws plain words. */
export function newTodo(botId: string, args: TodoArgs, ctx: TodoContext, at: string): Todo {
  const title = line(args.title, TITLE_MAX);
  if (!title) throw new Error("A to-do needs a short title.");
  const why = line(args.why, WHY_MAX);
  const due = cleanDue(args.by_when);
  const { blocks, buttons } = buildParts(args, ctx);
  const todo: Todo = { id: newTodoId(), botId, title, ...(why ? { why } : {}), at, updatedAt: at, ...(due ? { due } : {}), blocks, buttons, keepOpen: !!args.keep_open };
  checkSize(todo);
  return todo;
}

/** The same to-do with what update_todo changes. Absent arguments stay as they were; blocks and buttons are replaced whole. */
export function changedTodo(old: Todo, args: TodoArgs, ctx: TodoContext, at: string): Todo {
  const next: Todo = { ...old, updatedAt: at };
  if (args.title !== undefined) {
    const title = line(args.title, TITLE_MAX);
    if (!title) throw new Error("A to-do needs a short title.");
    next.title = title;
  }
  if (args.why !== undefined) {
    const why = line(args.why, WHY_MAX);
    if (why) next.why = why;
    else delete next.why;
  }
  if (args.by_when !== undefined) {
    const due = cleanDue(args.by_when);
    if (due) next.due = due;
    else delete next.due;
  }
  if (args.blocks !== undefined) next.blocks = buildBlocks(args.blocks, ctx);
  if (args.blocks !== undefined || args.buttons !== undefined) {
    const hasFields = next.blocks.some((b) => b.type === "field");
    next.buttons = args.buttons !== undefined ? buildButtons(args.buttons, hasFields) : keepButtons(old.buttons, buildButtons(undefined, hasFields));
  }
  if (args.keep_open !== undefined) next.keepOpen = !!args.keep_open;
  checkSize(next);
  return next;
}

/** New blocks without new buttons: the old buttons stay, or the plain "Send" comes or goes with the fields. */
function keepButtons(old: TodoButton[], plain: TodoButton[]): TodoButton[] {
  const onlySend = old.length === 1 && old[0]!.id === "send" && old[0]!.label === "Send";
  if (old.length && !onlySend) return old;
  return plain;
}

function checkSize(todo: Todo): void {
  // The person's questions (engine 0.31.0) are his, not the bot's: they do not count.
  if (JSON.stringify({ ...todo, questions: undefined }).length > TOTAL_MAX) throw new Error("This to-do is too large. Keep long material in a file in your folder and add it as a file block.");
}

/** What the person did, as his message in the bot's chat: the button, then each field he filled. */
export function answerText(todo: Todo, buttonId: string | undefined, values: Record<string, string>): string {
  const button = todo.buttons.find((b) => b.id === buttonId);
  const lines: string[] = [];
  if (button) lines.push(`Pressed "${button.label}".`);
  for (const b of todo.blocks) {
    if (b.type !== "field") continue;
    const v = (values[b.id] ?? "").trim();
    if (!v) continue;
    lines.push(b.input === "long" || v.includes("\n") ? `${b.label}:\n${v}` : `${b.label}: ${v}`);
  }
  return lines.join("\n") || "Answered without a choice or text.";
}

/** The note the bot gets before the person's answer. */
export function answerNote(todo: Todo, stays: boolean): string {
  return `Note from Pobots: the message below is the person's answer to your to-do "${todo.title}" (${todo.id}), from its window in Pobots. ${
    stays
      ? "The to-do stays on their list, as you asked (keep_open): change it with update_todo, or take it off with remove_todo when it is settled."
      : "It is off their list now."
  }`;
}

/** The news for the bot's next turn when the person closed a to-do himself. */
export function closedNews(todo: Todo, how: "done" | "dismissed"): string {
  return how === "done"
    ? `Note from Pobots: the person marked your to-do "${todo.title}" (${todo.id}) done themselves.`
    : `Note from Pobots: the person dismissed your to-do "${todo.title}" (${todo.id}); it is off their list and needs nothing more from you unless they say so.`;
}

/** Why a to-do is no longer open, for a bot that tries to change it. */
export function notOpenWords(row: TodoRow): string {
  switch (row.status) {
    case "answered":
      return `The to-do "${row.todo.title}" is no longer open: the person answered it.`;
    case "done":
      return `The to-do "${row.todo.title}" is no longer open: the person marked it done.`;
    case "dismissed":
      return `The to-do "${row.todo.title}" is no longer open: the person dismissed it.`;
    default:
      return `The to-do "${row.todo.title}" is no longer open.`;
  }
}

/** One line per open to-do for list_todos. */
export function listWords(todos: Todo[], ago: (iso: string) => string): string {
  if (!todos.length) return "You have no open to-dos on the person's list.";
  return [
    `Your open to-dos on the person's list (${todos.length}):`,
    ...todos.map((t) => {
      const parts = [`made ${ago(t.at)}`];
      if (t.due) parts.push(`by ${t.due.replace("T", " ")}`);
      if (t.keepOpen) parts.push("kept open after an answer");
      if (t.answer) parts.push(`last answered ${ago(t.answer.at)}${t.answer.label ? ` with "${t.answer.label}"` : ""}`);
      return `- ${t.id}: "${t.title}" (${parts.join("; ")})`;
    }),
  ].join("\n");
}
