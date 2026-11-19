// "Since you looked" (protocol 31, part C): what is new or moved since the last visit. `useSince`
// gives it short for the row above the days ("2 new, 1 moved", or "Nothing new") and in full for
// Overview ("2 new, 1 moved since today 20:26").
import { useAheadPage } from "./ahead-context";
import { addDays, shortDate } from "./ahead-words";

function since(iso: string, today: string, timeZone: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day === today ? "today" : day === addDays(today, -1) ? "yesterday" : shortDate(day)} ${time}`;
}

export interface Since {
  /** True when something is new or moved. */
  news: boolean;
  short: string;
  full: string;
}

export function useSince(): Since | undefined {
  const { model, today } = useAheadPage();
  const v = model.view;
  if (!v?.screen?.seenAt) return undefined;
  const all = [...v.earlier, ...v.rows, ...v.later];
  const added = all.filter((r) => r.changed?.kind === "new").length;
  const moved = all.filter((r) => r.changed?.kind === "moved").length;
  const bits = [added ? `${added} new` : "", moved ? `${moved} moved` : ""].filter(Boolean);
  const short = bits.length ? bits.join(", ") : "Nothing new";
  return { news: bits.length > 0, short, full: `${short} since ${since(v.screen.seenAt, today, v.screen.timeZone)}` };
}
