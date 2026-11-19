/**
 * Protocol 31: Ahead, the screen for what is coming (docs/build/step-ahead.md).
 *
 * The types live here so the protocol file grows little; `shared/protocol.ts` re-exports them and
 * merges them into Bot, Snapshot, Methods and Events at its end.
 *
 * Part A (the base) uses most of this. Fields marked "part B" or "part C" are in the protocol now so
 * those parts need no new protocol number; part A stores and returns them but does not show them.
 */

/** What a bot may do on Ahead. "time" is "items" plus asking for the person's time (part B). */
export type AheadLevel = "off" | "items" | "time";
export const AHEAD_LEVELS: readonly AheadLevel[] = ["off", "items", "time"];

/**
 * The kind of an item, in plain words on the screen: "will do", "deadline", "waiting", "note",
 * "your time". "your-time" is for part B; the tool refuses it until then.
 */
export type AheadKind = "will-do" | "deadline" | "waiting" | "note" | "your-time";
export const AHEAD_KINDS: readonly AheadKind[] = ["will-do", "deadline", "waiting", "note", "your-time"];

export type AheadState = "open" | "done" | "dropped";

/** Who changed an item last: its bot, the person in the window, or the main bot. */
export type AheadChanger = "bot" | "you" | "main";

export const AHEAD_TITLE_MAX = 120;
export const AHEAD_LABEL_MAX = 40;
export const AHEAD_WHY_MAX = 200;
/** A guard against a runaway bot, not a cap the screen relies on: open items per bot. */
export const AHEAD_OPEN_MAX = 500;
/** The days shown one by one; further ahead folds into "Later". */
export const AHEAD_DAYS = 14;

/** Where an item leads back to: the chat place it came from, or a to-do. */
export interface AheadLink {
  threadId?: string;
  /** A message in that thread. */
  itemId?: string;
  todoId?: string;
}

export interface AheadItem {
  /** "ahd_" and random letters. */
  id: string;
  /** The bot it belongs to. Absent: the person's own item (part C's Add). */
  botId?: string;
  kind: AheadKind;
  /** At most AHEAD_TITLE_MAX characters. */
  title: string;
  /** YYYY-MM-DD in the engine's time zone. */
  day: string;
  /** HH:MM in the engine's time zone. */
  time?: string;
  /** Free text such as a project, at most AHEAD_LABEL_MAX characters. */
  label?: string;
  /** One line of why, at most AHEAD_WHY_MAX characters. */
  why?: string;
  link?: AheadLink;
  state: AheadState;
  createdAt: string;
  changedAt: string;
  changedBy: AheadChanger;
  /** Part B, kind "your-time": how long the look takes, 5 to 120 minutes. */
  minutes?: number;
  /** Part B, kind "your-time": the last good day, YYYY-MM-DD. */
  latestBy?: string;
  /** Part B, kind "your-time": not before this day, YYYY-MM-DD. */
  earliest?: string;
  /** The day it was on before its last move (part B's "Moved from", part C's marks). */
  movedFrom?: string;
}

export interface AheadSettings {
  /** Off by default: no screen, no tool for any bot, nothing computed. */
  enabled: boolean;
  /** Part B: working hours, HH:MM. */
  workStart: string;
  workEnd: string;
  /** Part B: working days. */
  workDays: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  /** Part B: the most minutes of "your time" items per day. */
  minutesPerDay: number;
  /** Part C: the last Ahead view acknowledged on leaving, ISO 8601 (one per person across devices). */
  lastOpenedAt?: string;
  /** Part B: the main bot's week note at the top of Ahead, replaced never stacked. */
  weekNote?: { text: string; at: string };
}

export const AHEAD_DEFAULTS: AheadSettings = {
  enabled: false,
  workStart: "08:00",
  workEnd: "17:00",
  workDays: ["mon", "tue", "wed", "thu", "fri"],
  minutesPerDay: 120,
};

/** Part C: a mark on a row that changed since the person last looked (by someone other than them). */
export type AheadChange = { kind: "new" } | { kind: "moved"; from: string };

interface AheadRowBase {
  /** Stable across reads: "item:<id>", "meeting:<id>", "todo:<id>", "run:<id>". */
  key: string;
  /** YYYY-MM-DD. */
  day: string;
  /** HH:MM; absent for a whole day. */
  time?: string;
  /** Part C. Set only when the person has looked before (lastOpenedAt). */
  changed?: AheadChange;
}

export interface AheadItemRow extends AheadRowBase {
  source: "item";
  item: AheadItem;
  /** Its bot is on vacation: shown quietly marked. */
  away?: true;
}

export interface AheadMeetingRow extends AheadRowBase {
  source: "meeting";
  title: string;
  /** HH:MM, the end on the same day. */
  end?: string;
  allDay?: true;
  /** Marked free in the calendar (part B: does not block a slot). */
  free?: true;
}

export interface AheadTodoRow extends AheadRowBase {
  source: "todo";
  todoId: string;
  botId: string;
  title: string;
}

export interface AheadRunRow extends AheadRowBase {
  source: "run";
  triggerId: string;
  botId: string;
  title: string;
}

export type AheadRow = AheadItemRow | AheadMeetingRow | AheadTodoRow | AheadRunRow;
export type AheadSource = AheadRow["source"];

export interface AheadView {
  /** YYYY-MM-DD, the engine's today. */
  today: string;
  /** The range shown day by day: [from, to], both YYYY-MM-DD. */
  from: string;
  to: string;
  /** Rows inside the range, by day and time. */
  rows: AheadRow[];
  /** Open items whose day has passed: "From earlier", at the top of today. */
  earlier: AheadRow[];
  /** Rows after the range: "Later", folded. Meetings are not read this far. */
  later: AheadRow[];
  /** Part C: items done or dropped since the start of this week, newest first. */
  done: AheadItemRow[];
  /** The calendar: "on" with meetings read, "none" when not set up, "problem" when the read failed. */
  meetings: "on" | "none" | "problem";
  /** Part C: counts and the engine's read boundary, so a visit only acknowledges what it showed. */
  screen?: { carrying: AheadCarry[]; readAt: string; seenAt?: string; timeZone: string };
}

export interface AheadCarry {
  botId: string;
  onAhead: number;
  due: number;
  waiting: number;
  helpers: number;
  managers: number;
}

/** The person's actions on an item in the window. */
export type AheadAction = "done" | "drop" | "move" | "reopen";

/** Part B: with action move on a "your time" item, Pobots finds the slot: later today, from tomorrow, the next free one, or next working week. */
export type AheadPlace = "today" | "tomorrow" | "next" | "next-week";
