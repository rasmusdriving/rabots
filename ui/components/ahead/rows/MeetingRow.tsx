// A meeting from the calendar: the quietest row, a small square for a mark. Not a button.
import type { AheadMeetingRow } from "../../../../shared/protocol";
import { RowShell } from "./RowShell";

export function MeetingRow({ row }: { row: AheadMeetingRow }) {
  const time = row.allDay ? "All day" : row.time;
  return (
    <RowShell
      dataKey={row.key}
      day={row.day}
      time={time}
      end={row.end}
      mark={<span className="pb-ahead-meeting" />}
      title={row.title}
      tone="meeting"
      meta={row.free ? "Marked free" : undefined}
      label={`Meeting, ${row.title}, ${row.allDay ? "all day" : `${row.time}${row.end ? ` to ${row.end}` : ""}`}${row.free ? ", marked free" : ""}`}
    />
  );
}
