// The calendar tools (16 Nov 2026, engine 0.25.0): what a meeting card shows inside its well. The
// meeting as it will be, the old time when it moves, who is in it (inside or outside the company,
// and whether they are free then), the Teams link, a clash in the person's own calendar and the text.
// T3 Code's pending approval (ComposerPendingApprovalActions.tsx) shows the request and two choices;
// this is the same, with the meeting written out so nothing is approved unseen.
import type { CardAttendee, CardMeeting } from "../../shared/protocol";
import { useAppState } from "../state/store";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Wall {
  y: number;
  mo: number;
  d: number;
  wd: number;
  hm: string;
}

function wall(iso: string, tz: string): Wall | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  } catch {
    return wall(iso, "UTC");
  }
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { y: Number(get("year")), mo: Number(get("month")) - 1, d: Number(get("day")), wd: Math.max(0, DAYS.findIndex((x) => get("weekday").startsWith(x))), hm: `${get("hour")}:${get("minute")}` };
}

/** "Wed 18 Nov 10:00 to 11:00" in the meeting's time zone, as the engine words it. */
export function meetingSpan(start: string, end: string, tz: string): string {
  const a = wall(start, tz);
  const b = wall(end, tz);
  if (!a || !b) return `${start} to ${end}`;
  const day = (w: Wall) => `${DAYS[w.wd]} ${w.d} ${MONTHS[w.mo]}`;
  const same = a.y === b.y && a.mo === b.mo && a.d === b.d;
  return `${day(a)} ${a.hm} to ${same ? b.hm : `${day(b)} ${b.hm}`}`;
}

/** The time zone the window itself is in, to say the meeting's zone only when it differs. */
function ownZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function personTag(a: CardAttendee, checks: boolean): string {
  if (!a.internal) return checks ? "External, the agreed time" : "External";
  if (!checks) return "Internal";
  return a.free ? "Internal, free then" : "Internal, could not be checked";
}

/** The meeting in the card's well. Plain words; every line is the engine's own, so nothing differs from what happens. */
export function MeetingDetail({ meeting: m }: { meeting: CardMeeting }) {
  const zone = ownZone() && ownZone() !== m.timeZone ? ` (${m.timeZone})` : "";
  const checks = m.action === "create" || m.action === "move";
  // Protocol 33: Google Meet when the calendar is a Google one; Teams as before otherwise.
  const meet = useAppState((s) => s.calendar?.service) === "google" ? "Google Meet" : "Teams";
  const teams = m.action === "create" ? `${meet} meeting, a link is added` : m.teams ? `${meet} meeting` : `No ${meet} link`;
  return (
    <div className="pb-meet">
      <span className="pb-meet-what">{m.subject}</span>
      <span className="pb-meet-when">
        {m.was ? "To " : ""}
        {meetingSpan(m.start, m.end, m.timeZone)}
        {zone}
      </span>
      {m.was && <span className="pb-meet-was">Now {meetingSpan(m.was.start, m.was.end, m.timeZone)}</span>}
      {m.ownClash && <span className="pb-meet-clash">You have something else then: {m.ownClash}</span>}
      {m.organizer && <span className="pb-meet-line">From {m.organizer}</span>}
      {m.attendees.length > 0 && (
        <ul className="pb-meet-people" aria-label="Who">
          {m.attendees.map((a) => (
            <li className="pb-meet-person" key={a.address}>
              <span>{a.name ?? a.address}</span>
              {a.name && <span className="pb-meet-addr">{a.address}</span>}
              <span className="pb-meet-tag" data-unchecked={checks && a.internal && !a.free ? "" : undefined}>
                {personTag(a, checks)}
                {a.optional ? ", optional" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <span className="pb-meet-line">{teams}</span>
      {m.message && (
        <span className="pb-meet-text">
          <span className="pb-meet-label">{m.action === "create" ? "Text" : "Message"}</span>
          {m.message}
        </span>
      )}
    </div>
  );
}
