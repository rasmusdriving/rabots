import { useAheadPage } from "./ahead-context";
import { addDays, shortDate } from "./ahead-words";

function since(iso: string, today: string, timeZone: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day === today ? "today" : day === addDays(today, -1) ? "yesterday" : shortDate(day)} ${time}`;
}

export function AheadSince() {
  const { model, today } = useAheadPage();
  const v = model.view;
  if (!v?.screen?.seenAt) return null;
  const all = [...v.earlier, ...v.rows, ...v.later];
  const added = all.filter((r) => r.changed?.kind === "new").length;
  const moved = all.filter((r) => r.changed?.kind === "moved").length;
  const bits = [added ? `${added} new` : "", moved ? `${moved} moved` : ""].filter(Boolean);
  return (
    <p className="pb-ahead-since small" data-ahead-since="">
      {bits.length > 0 && <span className="pb-ahead-change-dot" aria-hidden="true" />}
      {`${bits.length ? bits.join(", ") : "Nothing new"} since ${since(v.screen.seenAt, today, v.screen.timeZone)}`}
    </p>
  );
}
