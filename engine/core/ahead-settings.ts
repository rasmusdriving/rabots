// Ahead's settings and the per-bot permission (engine 0.39.0, docs/build/step-ahead.md).
//
// The settings are one engine value (JSON) over AHEAD_DEFAULTS. Off by default: no screen, no tool
// for any bot, nothing computed. Switching it on or off, or a bot's level, gives or takes the tool,
// so the sessions concerned start again between turns (as the calendar switch does).
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { AHEAD_DEFAULTS, AHEAD_LEVELS, type AheadLevel, type AheadSettings, type Methods } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { away } from "./vacation.js";

const KEY = "ahead.settings";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function aheadSettings(eng: Engine): AheadSettings {
  const raw = eng.store.getValue(KEY);
  if (!raw) return { ...AHEAD_DEFAULTS };
  try {
    const v = JSON.parse(raw) as Partial<AheadSettings>;
    return { ...AHEAD_DEFAULTS, ...v };
  } catch {
    return { ...AHEAD_DEFAULTS };
  }
}

export function aheadOn(eng: Engine): boolean {
  return aheadSettings(eng).enabled;
}

/** The bot's level: the main bot always has everything; the others as set, off by default. */
export function aheadLevel(rt: BotRuntime): AheadLevel {
  if (rt.folder.file.role === "main") return "time";
  const v = rt.folder.file.ahead;
  return v && AHEAD_LEVELS.includes(v) ? v : "off";
}

/** True when the bot gets `ahead_item` now: Ahead is on, its level is not off, it is not on vacation. */
export function aheadTool(eng: Engine, rt: BotRuntime): boolean {
  return aheadOn(eng) && aheadLevel(rt) !== "off" && !away(rt);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function bad(msg: string): EngineError {
  return new EngineError("bad_request", msg);
}

/** Checks and saves a change; refreshes the sessions when the tool comes or goes. */
export function setAheadSettings(eng: Engine, patch: Methods["ahead.settings.set"]["params"]): AheadSettings {
  const cur = aheadSettings(eng);
  const next: AheadSettings = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.workStart !== undefined) {
    if (!HHMM.test(patch.workStart)) throw bad("The start of the working day is a time such as 08:00.");
    next.workStart = patch.workStart;
  }
  if (patch.workEnd !== undefined) {
    if (!HHMM.test(patch.workEnd)) throw bad("The end of the working day is a time such as 17:00.");
    next.workEnd = patch.workEnd;
  }
  if (next.workEnd <= next.workStart) throw bad("The working day ends after it starts.");
  if (patch.workDays !== undefined) {
    const days = DAYS.filter((d) => patch.workDays!.includes(d));
    if (!days.length) throw bad("Choose at least one working day.");
    next.workDays = days;
  }
  if (patch.minutesPerDay !== undefined) {
    const n = Math.round(Number(patch.minutesPerDay));
    if (!Number.isFinite(n) || n < 15 || n > 480) throw bad("Minutes per day is between 15 and 480.");
    next.minutesPerDay = n;
  }
  save(eng, next);
  if (next.enabled !== cur.enabled) {
    for (const rt of eng.bots.values()) if (aheadLevel(rt) !== "off") eng.refreshSession(rt);
  }
  eng.opts.emit("ahead.changed", { ahead: next });
  return next;
}

/** The person left Ahead (part C's "Since you looked"). */
export function aheadSeen(eng: Engine, through?: string): AheadSettings {
  const cur = aheadSettings(eng);
  if (!cur.enabled) return cur;
  const now = eng.clock();
  const requested = through === undefined ? now : Date.parse(through);
  if (!Number.isFinite(requested)) throw bad("The time you last looked is not valid.");
  const lastOpenedAt = new Date(Math.min(now, requested)).toISOString();
  // A phone leaving an older view must not undo what a laptop already acknowledged.
  if (cur.lastOpenedAt && lastOpenedAt <= cur.lastOpenedAt) return cur;
  const next = { ...cur, lastOpenedAt };
  save(eng, next);
  eng.opts.emit("ahead.changed", { ahead: next });
  return next;
}

function save(eng: Engine, s: AheadSettings): void {
  eng.store.setValue(KEY, JSON.stringify(s));
}

const LEVEL_WORDS: Record<AheadLevel, string> = {
  off: "off",
  items: "may put items on Ahead",
  time: "may put items on Ahead and ask for the person's time",
};

/** One line for the main bot's get_settings. */
export function aheadSettingsWords(eng: Engine): string {
  const s = aheadSettings(eng);
  if (!s.enabled) return "Ahead (the screen for what is coming): off (change_settings ahead). Off means no screen and no ahead_item tool for any bot.";
  return `Ahead (the screen for what is coming): on (change_settings ahead). A bot uses ahead_item when its Ahead permission is not off (update_bot ahead: off, items, time). Working hours ${s.workStart} to ${s.workEnd}, ${s.workDays.join(" ")}, your-time at most ${s.minutesPerDay} minutes a day (change_settings ahead_time).`;
}

/** One line for get_bot. */
export function aheadBotWords(eng: Engine, rt: BotRuntime): string {
  if (rt.folder.file.role === "main") return "";
  const level = aheadLevel(rt);
  return `Ahead: ${LEVEL_WORDS[level]}${level !== "off" && !aheadOn(eng) ? " (Ahead is off in Pobots, so it has no ahead_item tool)" : ""}.`;
}

export function aheadLevelWords(level: AheadLevel): string {
  return LEVEL_WORDS[level];
}
