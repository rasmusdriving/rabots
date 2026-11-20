// One row of Ahead: the time (a range for what has an end, "08:30-08:55"), a small mark, the title
// and, at the right, one quiet line of facts. One line high, so rows line up down the day and a row
// that changes keeps its box. A button when tapping it does something.
import { createContext, useContext, type ReactNode } from "react";
import type { AheadChange } from "../../../../shared/protocol";
import { changeWords, shortDate } from "../ahead-words";

/** True inside "Later" and "From earlier": rows there show their date where the time stands. */
export const ShowDate = createContext(false);
export const RowChange = createContext<AheadChange | undefined>(undefined);

export interface RowShellProps {
  day: string;
  time?: string;
  end?: string;
  mark: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** "meeting" draws the title quieter; "closed" a row done or dropped while the person looks. */
  tone?: "meeting" | "closed" | "moved";
  label: string;
  onOpen?: () => void;
  dataKey: string;
}

export function RowShell({ day, time, end, mark, title, meta, tone, label, onOpen, dataKey }: RowShellProps) {
  const dated = useContext(ShowDate);
  const change = useContext(RowChange);
  const word = change ? changeWords(change) : undefined;
  const description = word ? `${label}, ${word}` : label;
  const inner = (
    <>
      <span className="pb-ahead-when">
        {dated ? shortDate(day) : time}
        {dated ? time && <span className="pb-ahead-end" data-word="">{time}</span> : end && <span className="pb-ahead-end" data-word={/^\d/.test(end) ? undefined : ""}>{/^\d/.test(end) ? `-${end}` : end}</span>}
      </span>
      <span className="pb-ahead-mark" aria-hidden="true">
        {mark}
        {/* New or moved since the last visit: beside the mark, so every title starts on the same line. */}
        {word && <span className="pb-ahead-change-dot" />}
      </span>
      <span className="pb-ahead-body">
        <span className="pb-ahead-title">{title}</span>
        {(word || meta) && <span className="pb-ahead-meta">
          {word && !tone && <>{word}{meta && " · "}</>}
          {meta}
          {word && tone && <>{meta && " · "}{word}</>}
        </span>}
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" className="pb-ahead-row" data-tone={tone} data-ahead-row={dataKey} aria-label={description} aria-haspopup="dialog" onClick={onOpen}>
      {inner}
    </button>
  ) : (
    <div className="pb-ahead-row" data-tone={tone} data-ahead-row={dataKey} aria-label={description} role="group">
      {inner}
    </div>
  );
}
