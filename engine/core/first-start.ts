// A new install's first start (engine 0.33.0, docs/build/step-first-start.md): the main bot's welcome
// turn, and "About you", the short note about the person that every bot gets in its instructions.
//
// About you is kept in the database (engine_values, key "about-you"), so the nightly backup has it and
// a restore brings it back with the rest. It is private: never in a log line, an activity line, a
// notification or a quiet line. Only its length is ever said ("about 60 words").
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { EngineError } from "../errors.js";
import { log } from "../log.js";
import { wordCount } from "./notes.js";
import { wake } from "./start-helper.js";

const KEY = "about-you";

/** At most this many characters: a short note, read by every bot on every session. */
export const ABOUT_YOU_MAX = 4000;

/** The note from Pobots that starts the main bot's first turn. Not shown in the chat; the greeting is. */
export const WELCOME_NOTE = [
  "Note from Pobots: Pobots was just set up, and the person made you their main bot a moment ago. This is your first turn; they have not written anything yet.",
  "Greet them in a sentence or two: say who you are and that you help them run their bots in Pobots.",
  "Then get to know them, a couple of questions at a time, in plain words, not as a form: who they are and what they do; what is important to them; their scopes and responsibilities; how they like to be talked to. Ask one or two now and wait for the answer. Follow their lead; if they would rather start working, let them, and come back to it later.",
  "Over the next few messages, ask about all four before you write anything, unless they want to stop. Then write a short note about them with change_settings about_you (plain facts in a few short lines, at most about 200 words; nothing secret such as passwords or keys). Every bot in Pobots gets that note. Tell them they can read and change it in Settings, General, About you, or ask you to.",
  "Use no other tools in this first turn.",
].join("\n\n");

/** The text as kept; empty when none. */
export function aboutYou(eng: Engine): string {
  return eng.store.getValue(KEY) ?? "";
}

/** The paragraph each bot's session gets after Pobots' team words. Empty when there is no note. */
export function aboutYouPrompt(eng: Engine): string {
  const text = aboutYou(eng);
  if (!text) return "";
  return `About the person you work for, as they or the main bot wrote it (Settings, General, About you):\n${text}`;
}

/**
 * Writes About you. Returns the quiet-line words for the change ("About you written (about 60 words)"),
 * or "" when nothing changed. Every bot's session starts again between turns so its next turn has it.
 */
export function setAboutYou(eng: Engine, raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length > ABOUT_YOU_MAX) throw new EngineError("bad_request", `About you is too long. Keep it under ${ABOUT_YOU_MAX.toLocaleString("en-US")} characters.`);
  const was = aboutYou(eng);
  if (text === was) return "";
  if (text) eng.store.setValue(KEY, text);
  else eng.store.deleteValue(KEY);
  // Only that it changed, never the words.
  log.info(text ? "About you was changed" : "About you was cleared");
  for (const rt of eng.bots.values()) eng.refreshSession(rt);
  eng.opts.emit("aboutYou.changed", { aboutYou: text });
  if (!text) return "About you cleared";
  return `About you ${was ? "changed" : "written"} (${wordCount(text)})`;
}

/** After the first-start screen made the main bot: its first turn starts by itself and greets the person. */
export function startWelcome(eng: Engine, rt: BotRuntime): void {
  if (rt.folder.file.role !== "main") return;
  log.info(`Bot ${rt.folder.id}: the welcome turn starts`);
  wake(eng, rt, { text: WELCOME_NOTE, purpose: { startedBy: "you", threadId: rt.threadId, fresh: false, hops: 0 } });
}
