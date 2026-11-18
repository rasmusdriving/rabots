// The quiet lines a bot's changes inside Pobots leave in its chat (docs/main-bot.md). What the main bot
// changes happens at once, and the person is told what changed, from what to what. Not on a card: after
// a session the cards piled up under "Needs you" above the one card that needed him (the tester's walk,
// 15 Nov 2026), so a change is a quiet line in the chat, like "Started fresh", with no push.
//
// One line per turn for each bot (or channel, or Pobots) changed, not one per call: the lines are
// gathered on the bot's runtime while it works and written when its turn ends, in the bot's main chat
// (also when the turn ran as a fresh run or for a trigger). A change made outside a turn is written at
// once. The same goes for a bot that changes what it sees itself, and for change_settings.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { clip, now } from "./words.js";
import { type SeesChange, seesShortText } from "./sees-words.js";

/** At most this many characters in one line; the parts that do not fit are cut. */
const LINE_MAX = 400;

/**
 * One part of a line: words as they stand, or changes to what a bot sees, which are said in a few
 * words when there are many (core/sees-words.ts). The sees changes of one turn with the same prefix
 * ("what it sees") are gathered into one part, so a bot trimmed over several calls still reads short.
 */
export type NotePart = string | { sees: SeesChange[]; prefix: string; suffix?: string };

function partText(p: NotePart): string {
  if (typeof p === "string") return p;
  const body = seesShortText(p.sees) || "tidied";
  return `${p.prefix ? `${p.prefix}: ` : ""}${body}${p.suffix ?? ""}`;
}

/**
 * Adds parts to the line about `key` ("bot:<id>", "channel:<id>", "pobots", "address:<id>").
 * `subject` starts the line ("Mira Test", "New bot Reports", "Channel Ops"); it is kept from the first
 * call in the turn, or replaced when `strong` (making or retiring a bot says so even after smaller
 * changes to it). Each part is written as it stands in the middle of a sentence ("purpose from ...").
 * An empty subject makes a line of the parts alone, its first letter made capital.
 */
export function noteChange(eng: Engine, rt: BotRuntime, key: string, subject: string, parts: NotePart[], strong = false): void {
  const clean = parts.map((l) => (typeof l === "string" ? l.trim().replace(/\.$/, "") : l)).filter((l) => (typeof l === "string" ? l : l.sees.length || l.prefix));
  if (!clean.length) return;
  const notes = (rt.notes ??= new Map<string, { title: string; lines: NotePart[] }>());
  const had = notes.get(key);
  if (had) {
    for (const part of clean) {
      const same = typeof part !== "string" && had.lines.find((l): l is Exclude<NotePart, string> => typeof l !== "string" && l.prefix === part.prefix);
      if (same && typeof part !== "string") {
        same.sees.push(...part.sees);
        if (part.suffix) same.suffix = part.suffix;
      } else had.lines.push(typeof part === "string" ? part : { ...part, sees: [...part.sees] });
    }
    if (strong) had.title = subject;
  } else notes.set(key, { title: subject, lines: clean.map((p) => (typeof p === "string" ? p : { ...p, sees: [...p.sees] })) });
  if (!rt.busy) flushNotes(eng, rt);
}

/** The subject of a line about changes to one bot: its name (before a rename in the same turn). */
export function changedTitle(target: BotRuntime): string {
  return target.folder.file.name;
}

/** "about 120 words": a long text (a job, a prompt) is said in a few words, never printed. */
export function wordCount(text: string): string {
  const n = text.trim().split(/\s+/).filter(Boolean).length;
  return n === 1 ? "1 word" : `about ${n.toLocaleString("en-US")} words`;
}

/** A short text in quotes, cut to a few words when long: "Writes the weekly report". */
export function quoted(text: string, max = 80): string {
  return `"${clip(text.trim().replace(/\s+/g, " ") || "not written", max)}"`;
}

/** The line as the person reads it: "Mira Test: purpose from "A" to "B"; effort from low to high". */
export function lineText(subject: string, parts: NotePart[]): string {
  const body = parts.map(partText).join("; ");
  const text = subject ? `${subject}: ${body}` : body.charAt(0).toUpperCase() + body.slice(1);
  return clip(text, LINE_MAX);
}

/** Writes the gathered lines, one each, in the bot's main chat. Called when a turn ends, and at shutdown. */
export function flushNotes(eng: Engine, rt: BotRuntime): void {
  const held = rt.heldNotices?.splice(0) ?? [];
  if (eng.store.isOpen) for (const n of held) eng.addItem(rt, { kind: "notice", at: now(), ...n }, rt.threadId);
  if (!rt.notes?.size) return;
  const notes = [...rt.notes.values()];
  rt.notes.clear();
  for (const n of notes) writeLine(eng, rt, lineText(n.title, n.lines));
}

/** A whole line that waits for the turn's end, as the notes do: "Posted in Ops - Internal" with the post in `detail` (engine 0.23.0), or a calendar action (0.25.0). */
export interface HeldNotice {
  text: string;
  tone: "info" | "error";
  mark?: "posted" | "calendar";
  detail?: string;
}

/** Holds a line until the bot's turn ends, or writes it at once when the bot is not working. */
export function holdNotice(eng: Engine, rt: BotRuntime, n: HeldNotice): void {
  (rt.heldNotices ??= []).push(n);
  if (!rt.busy) flushNotes(eng, rt);
}

/** One quiet line in a bot's main chat: a notice, as "Started fresh" is. Never a card, never a push. */
function writeLine(eng: Engine, rt: BotRuntime, text: string): void {
  if (!eng.store.isOpen) return;
  eng.addItem(rt, { kind: "notice", at: now(), text, tone: "info" }, rt.threadId);
}
