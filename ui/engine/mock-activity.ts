// A day's activity for the settings window's Activity tab (protocol 22, the window check's section
// "activity"): today and yesterday have rows, older days are quiet, a day not come yet is refused.
// Times are the browser's own day. window.pobotsActivity.waitMs makes a read slow, to see the old
// rows stay, faded, while the next day is read.
import type { ActivityDay, ActivityRow, Methods } from "../../shared/protocol";
import { EngineError } from "./types";

declare global {
  interface Window {
    pobotsActivity?: ActivityLevers;
  }
}

export interface ActivityLevers {
  /** How long a read takes, in ms. */
  waitMs: number;
}

const TODAY: ActivityRow[] = [
  { time: "06:00", end: "06:20", kind: "turn", botId: "kaja", who: "Kaja", words: 'Worked, started by schedule "Morning round", 2 turns: "Weekly note"' },
  { time: "08:02", kind: "you", botId: "po", who: "You", words: 'Message to Po, from a computer, chat "Planning the week"' },
  { time: "08:02", end: "08:09", kind: "turn", botId: "po", who: "Po", words: 'Worked, started by you: "Planning the week"' },
  { time: "08:03", end: "08:30", kind: "helper", botId: "po", who: "Po", words: 'Helper "Check the Nordvik import before Thursday and list what still blocks it" (Haiku 5.5, low), done' },
  { time: "08:05", kind: "you", botId: "po", who: "You", words: "Answered a card of Po: approval, allowed once, from the phone" },
  { time: "09:00", kind: "calendar", botId: "kaja", who: "Kaja", words: 'Made the meeting "Weekly sync" for Wed 18 Nov 09:00, done' },
  { time: "10:00", end: "10:02", kind: "turn", botId: "kaja", who: "Kaja", words: 'Worked, started by channel "Ops - Internal", from Alex Example' },
  { time: "11:40", kind: "you", botId: "kaja", who: "You", words: "Message to Kaja, from the phone" },
  { time: "11:40", end: "11:44", kind: "turn", botId: "kaja", who: "Kaja", words: "Worked, started by you" },
  { time: "13:00", kind: "post", botId: "kaja", who: "Kaja", words: 'Wrote a post in channel "Ops - Internal", posted' },
];
const TODAY_SUMMARY = ["You were active from 08:02 to 11:40: 3 minutes over 2 blocks.", "3 actions, 5 bot turns, 1 helper, 1 calendar action, 1 channel post."];

const YESTERDAY: ActivityRow[] = [
  { time: "09:15", kind: "you", botId: "kaja", who: "You", words: 'Message to Kaja, from a computer, chat "Aalto report template"' },
  { time: "09:15", end: "09:21", kind: "turn", botId: "kaja", who: "Kaja", words: 'Worked, started by you: "Aalto report template"' },
  { time: "16:30", end: "16:31", kind: "turn", botId: "po", who: "Po", words: 'Worked, started by webhook "Ticket in"' },
];
const YESTERDAY_SUMMARY = ["Your one action was at 09:15.", "1 action, 2 bot turns."];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayOf(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export class MockActivity {
  readonly levers: ActivityLevers = { waitMs: 0 };

  wait(): number {
    return this.levers.waitMs;
  }

  day(p: Methods["activity.day"]["params"]): Methods["activity.day"]["result"] {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let day = today;
    if (p.day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day)) throw new EngineError({ code: "bad_request", message: "The day must be a date as YYYY-MM-DD." });
      day = dayOf(p.day);
      if (day > today) throw new EngineError({ code: "bad_request", message: "That day has not come yet." });
    }
    const back = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    const activity: ActivityDay = {
      day: ymd(day),
      today: ymd(today),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      summary: back === 0 ? TODAY_SUMMARY : back === 1 ? YESTERDAY_SUMMARY : [],
      rows: back === 0 ? TODAY : back === 1 ? YESTERDAY : [],
    };
    return { activity };
  }
}
