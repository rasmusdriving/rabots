// ?ahead=busy: a week that looks like a real busy one, for the Week grid (docs/build/step-ahead-redesign.md).
// On each of the next five working days eight to twelve meetings between 08:00 and 17:00: several
// short ones back to back, some at the same time, one crossing the end of the day, all-day ones, some
// before 08:00 and after 17:00, some marked free. Among them the bots' things: items with and without
// a time, "your time" slots, one-off runs, an item from earlier and one far ahead, and a week note.
// Every name is made up.
import type { AheadItem, AheadMeetingRow, AheadRunRow } from "../../shared/protocol";
import { isoDay } from "./mock-data";

type Put = (botId: string | null, p: Pick<AheadItem, "kind" | "title" | "day"> & Partial<AheadItem>) => AheadItem;

export interface BusyWeek {
  meetings: AheadMeetingRow[];
  runs: AheadRunRow[];
  weekNote: string;
}

const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

/** The next five days from Monday to Friday, today first when it is one. */
export function busyDays(): string[] {
  const days: string[] = [];
  for (let n = 0; days.length < 5; n++) {
    const d = plusDays(n);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(isoDay(d));
  }
  return days;
}

// [start, end, title, free?]. "" as the start: all day.
type M = [string, string, string, boolean?];
const MORNING: M[] = [
  ["08:30", "08:55", "Morning check-in", true],
  ["08:55", "09:00", "Handover"],
  ["09:00", "09:15", "Delivery standup"],
  ["09:15", "09:30", "Platform standup"],
];
const WEEK: M[][] = [
  [
    ["", "", "Conference in town"],
    ["07:15", "07:45", "Breakfast with the board"],
    ...MORNING,
    ["09:30", "12:00", "Focus block: planning"],
    ["10:00", "10:30", "Supplier call"],
    ["12:00", "13:00", "Lunch walk", true],
    ["13:15", "13:45", "Review of the sample survey"],
    ["14:00", "14:30", "Support sync", true],
    ["14:00", "15:00", "Design review"],
    ["15:30", "16:00", "One to one"],
    ["16:30", "17:30", "Quarter planning"],
  ],
  [
    ...MORNING,
    ["09:30", "10:00", "Morning meeting"],
    ["10:00", "11:00", "Workshop: the onboarding flow"],
    ["10:30", "11:30", "Budget review"],
    ["10:45", "11:15", "Quick sync"],
    ["13:00", "14:00", "Steering group"],
    ["14:00", "14:30", "Support sync", true],
    ["15:00", "15:45", "Customer demo"],
    ["18:00", "19:00", "Team dinner"],
  ],
  [
    ["", "", "Half the team is away"],
    ...MORNING,
    ["09:30", "10:30", "Planning with the example team"],
    ["11:00", "12:00", "Town hall"],
    ["11:00", "12:00", "Release review"],
    ["11:00", "11:45", "Hiring panel"],
    ["11:15", "12:00", "Vendor demo"],
    ["11:30", "12:00", "Sample walkthrough"],
    ["13:00", "13:15", "Sync one"],
    ["13:15", "13:30", "Sync two"],
    ["13:30", "13:45", "Sync three"],
    ["15:00", "16:30", "Roadmap workshop"],
  ],
  [
    ...MORNING,
    ["10:00", "10:30", "Demo of the sample report", true],
    ["11:00", "12:00", "Weekly meeting"],
    ["12:00", "13:00", "Lunch walk", true],
    ["14:00", "15:00", "Architecture forum"],
    ["15:00", "15:15", "Short check"],
    ["15:15", "15:30", "Short follow-up"],
    ["16:00", "17:00", "Retrospective"],
  ],
  [
    ["", "", "Half the team is away"],
    ["06:30", "07:00", "Early call with the far office"],
    ["08:30", "09:00", "Check-in"],
    ["08:55", "09:00", "Handover"],
    ["09:00", "09:15", "Delivery standup"],
    ["09:15", "09:30", "Platform standup"],
    ["09:30", "10:00", "Morning meeting"],
    ["11:30", "12:00", "Planning poker"],
    ["13:00", "13:30", "Support sync", true],
    ["14:00", "14:30", "Demo for the example customer"],
    ["17:30", "18:00", "Wrap-up"],
    ["19:30", "20:00", "Evening webinar"],
  ],
];

/** Seeds the items through `put` and returns what the view adds beside them. `bots`: the scene's bot ids. */
export function seedBusy(put: Put, bots: string[]): BusyWeek {
  const days = busyDays();
  const [main, second, third] = [bots[0], bots[1] ?? bots[0], bots[2] ?? bots[0]];
  const meetings: AheadMeetingRow[] = [];
  days.forEach((day, d) => {
    WEEK[d]!.forEach(([time, end, title, free], n) => {
      meetings.push({ source: "meeting", key: `meeting:b${d}-${n}`, day, ...(time ? { time, end } : { allDay: true as const }), title, ...(free ? { free: true as const } : {}) });
    });
  });
  const runs: AheadRunRow[] = [];
  const run = (d: number, time: string, botId: string | undefined, title: string) => {
    if (botId) runs.push({ source: "run", key: `run:b${d}-${time}`, day: days[d]!, time, triggerId: `trg_busy_${d}`, botId, title });
  };
  const D = (n: number) => days[n]!;

  // Today.
  run(0, "08:30", main, "Morning summary");
  if (second) put(second, { kind: "will-do", title: "Send the sample summary", day: D(0), time: "11:00", label: "Sample project", why: "Promised in the chat this morning." });
  if (second) put(second, { kind: "your-time", title: "Look at the draft plan", day: D(0), time: "15:00", minutes: 25, why: "So it can go out by Friday." });
  if (third) put(third, { kind: "deadline", title: "Quarter report due", day: D(0), label: "Reports" });
  put(null, { kind: "note", title: "Call the dentist", day: D(0) });
  // The second day: more with no time than the strip has lines.
  run(1, "09:30", second, "Check the inbox of the example team");
  if (second) put(second, { kind: "your-time", title: "Check the numbers in the sample report", day: D(1), time: "11:35", minutes: 25 });
  if (third) put(third, { kind: "your-time", title: "Read the offer before it goes out", day: D(1), time: "16:00", minutes: 45 });
  if (second) put(second, { kind: "waiting", title: "Answer from the example team", day: D(1) });
  if (third) put(third, { kind: "deadline", title: "Offer to the example customer", day: D(1), label: "Reports" });
  if (third) put(third, { kind: "will-do", title: "Update the price list", day: D(1) });
  put(null, { kind: "note", title: "Book the venue", day: D(1) });
  if (main) put(main, { kind: "waiting", title: "Signature from the legal team", day: D(1) });
  // The third day.
  run(2, "08:30", main, "Morning summary");
  if (third) put(third, { kind: "will-do", title: "Publish the weekly digest", day: D(2), time: "14:00" });
  if (second) put(second, { kind: "deadline", title: "Survey dates to the example customer", day: D(2), label: "Sample project" });
  // The fourth.
  if (second) put(second, { kind: "your-time", title: "Go through the open questions", day: D(3), time: "13:15", minutes: 30 });
  if (third) put(third, { kind: "deadline", title: "Invoices for the month", day: D(3) });
  run(3, "15:40", third, "Prepare the handover notes");
  // The fifth.
  if (main) put(main, { kind: "your-time", title: "Plan next week", day: D(4), time: "10:15", minutes: 60 });
  if (second) put(second, { kind: "will-do", title: "Send the week's report", day: D(4), time: "16:00" });
  // From earlier, and far ahead.
  if (second) put(second, { kind: "will-do", title: "Call back about the report", day: isoDay(plusDays(-2)) });
  if (third) put(third, { kind: "deadline", title: "Year plan due", day: isoDay(plusDays(40)) });
  return { meetings, runs, weekNote: "A full week. Reviews are placed around your meetings, and the afternoon of the fourth day is kept light." };
}
