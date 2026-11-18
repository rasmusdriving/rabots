// Words and times as the design system's Voice section asks: sentence case, kind with time,
// counted gently.
import type { AccessLevel, BotContext, BotState, Effort, HelperItem, Machine } from "../../shared/protocol";
import { ACCESS_LEVELS } from "../../shared/protocol";

export const STATE_WORD: Record<BotState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for you",
  blocked: "Blocked",
  done: "Done",
};

/**
 * The word in a bot's chat header when it is not the state's own: a turn the person stopped ends as
 * "done" with the activity "Stopped", and the header then says "Stopped", as the roster does. While
 * messages wait behind a Stop the activity is longer ("Stopped, 1 message waiting"); the header keeps
 * the one word.
 */
export const statusWord = (bot: { state: BotState; activity: string }): string | undefined =>
  bot.state === "done" && (bot.activity === "Stopped" || bot.activity.startsWith("Stopped, ")) ? "Stopped" : undefined;

/**
 * A Stop holds messages for this bot: the engine says so in the bot's line at rest ("Stopped, 1 message
 * waiting"). They are read when the person writes again, not by themselves.
 */
export const stopHolds = (bot: { state: BotState; activity: string }): boolean => (bot.state === "done" || bot.state === "idle") && bot.activity.startsWith("Stopped, ");

/** The state word on a helper's row and above its thread. */
export const HELPER_WORD: Record<HelperItem["status"], string> = {
  running: "Working",
  done: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

export const EFFORT_WORD: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const accessWord = (level: AccessLevel): string => ACCESS_LEVELS.find((a) => a.id === level)?.label ?? level;
export const accessHint = (level: AccessLevel): string => ACCESS_LEVELS.find((a) => a.id === level)?.hint ?? "";

export const MACHINE_WORD: Record<Machine["status"], string> = { this: "this one", online: "online", asleep: "asleep" };
/** The engine's machine, seen from a page opened on another device. */
export const MACHINE_CONNECTED = "connected";

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
/** "Two", "Eleven" stays "11". */
export const countWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

const pad = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "09:12" today, "Yesterday 09:12", "3 Nov 09:12" before that. */
export function clockTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** "11 Nov 14:52", with the date also for today. */
export function dayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The window to assume when the engine reports none (docs/build/step-2d.md, A1). */
const FALLBACK_WINDOW = 200_000;

/**
 * How full a bot's working session is, for the Settings tab: "About 38% full · Since 11 Nov 14:52",
 * or "Not started yet" when there is no session to speak of.
 */
export function sessionFacts(context: BotContext | undefined): string {
  if (!context || (context.tokens <= 0 && !context.since)) return "Not started yet";
  const facts: string[] = [];
  if (context.tokens > 0) {
    const window = context.window > 0 ? context.window : FALLBACK_WINDOW;
    const share = Math.min(100, Math.round((context.tokens / window) * 100));
    facts.push(share === 0 ? "Less than 1% full" : `About ${share}% full`);
  } else facts.push("Nothing in it yet");
  if (context.since) facts.push(`Since ${dayTime(context.since)}`);
  return facts.join(" · ");
}

/** "40 s", "2 min", "1 h 5 min". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, 1)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/**
 * How long a finished turn worked, short, as the line that folds its work reads it: "40s",
 * "1m 11s", "7m", "1h 4m". Never less than a second.
 */
export function workedFor(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "Expires in 28 min", "Expires in 2 h", "Expires at 18:00". */
export function expiry(iso: string, now = Date.now()): string {
  const left = new Date(iso).getTime() - now;
  if (Number.isNaN(left)) return "";
  if (left <= 60_000) return "Expires in a moment";
  const m = Math.round(left / 60_000);
  if (m < 60) return `Expires in ${m} min`;
  if (m < 6 * 60) return `Expires in ${Math.round(m / 60)} h`;
  const when = clockTime(iso);
  return /^\d\d:/.test(when) ? `Expires at ${when}` : `Expires ${when}`;
}

/** "Just now", "12 min ago" within the hour, then the clock time as clockTime gives it. */
export function whenWord(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const ago = now.getTime() - d.getTime();
  if (Number.isNaN(ago)) return "";
  if (ago < 60_000) return "Just now";
  if (ago < 3600_000) return `${Math.round(ago / 60_000)} min ago`;
  return clockTime(iso, now);
}

/** "1 message", "3 messages". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "Kaja, Inbox and Onboardings". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What happened to an artifact, as its row says it before the time. */
export const ARTIFACT_WHAT: Record<"made" | "updated" | "published", string> = {
  made: "Made",
  updated: "Updated",
  published: "Published to Claude",
};

// ------------------------------------------------------------ pictures and files (step: files)

/** A file's size in plain words: "812 bytes", "240 KB", "3.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const kb = bytes / 1024;
  if (kb < 1000) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

/** The words of the brief (docs/build/step-files.md, 10). `name` is the file's own name. */
export const ATTACH_WORDS = {
  tooBig: (name: string) => `${name} is too big. A file can be up to 100 MB.`,
  tooMany: "You can attach up to 10 files to one message.",
  kind: (name: string) => `The bot can't read ${name}. Attach pictures, PDFs, Word, Excel or text files.`,
  failed: (name: string) => `${name} didn't upload. Try again.`,
  gone: "This file is no longer on the Mac.",
  /** Step 7c: removed by the daily clean-up after 14 days. */
  notKept: "No longer kept",
  noPictures: "This bot's model can't see pictures.",
};
