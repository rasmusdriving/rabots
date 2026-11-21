// What a version of Pobots brings, from its CHANGELOG.md (protocol 36, docs/build/step-changelog.md).
// Shown on the Pobots card in Providers before and after an update, in the update dialog and on
// Pobots's own card on the rail after an update. Shaped like T3 Code's release notes in the update
// popover (apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx): newest first, grouped by
// version when there are several. A short list shows the first few bullets; "Show all" opens the rest
// in place, calmly, below them, so nothing above moves.
import { useId, useState } from "react";
import type { ReleaseNote } from "../../shared/protocol";
import { ChevronIcon } from "./bits";

type Part = { key: string; version: string; date?: string; head: boolean; items: string[]; more: number };

/** The notes cut after `limit` bullets in all: what shows, and the rest. */
function split(notes: ReleaseNote[], limit: number): { shown: Part[]; rest: Part[] } {
  const shown: Part[] = [];
  const rest: Part[] = [];
  let count = 0;
  for (const n of notes) {
    const head = n.items.slice(0, Math.max(0, limit - count));
    const tail = n.items.slice(head.length);
    count += head.length;
    const more = Math.max(0, n.totalItems - n.items.length);
    if (head.length) shown.push({ key: `${n.version}-a`, version: n.version, ...(n.date ? { date: n.date } : {}), head: true, items: head, more: tail.length ? 0 : more });
    if (tail.length) rest.push({ key: `${n.version}-b`, version: n.version, ...(n.date ? { date: n.date } : {}), head: !head.length, items: tail, more });
  }
  return { shown, rest };
}

function Parts({ parts, grouped }: { parts: Part[]; grouped: boolean }) {
  return (
    <>
      {parts.map((p) => (
        <div key={p.key} className="pb-relnotes-group" data-version={p.version}>
          {grouped && p.head && (
            <p className="pb-relnotes-version">
              {p.version}
              {p.date && <span className="pb-relnotes-date">{p.date}</span>}
            </p>
          )}
          <ul className="pb-relnotes-list">
            {p.items.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
            {p.more > 0 && <li className="pb-relnotes-more">{`And ${p.more} more.`}</li>}
          </ul>
        </div>
      ))}
    </>
  );
}

const olderWords = (n: number) => `${n} older ${n === 1 ? "version" : "versions"} not shown.`;

/**
 * The notes. `limit`: bullets shown before "Show all" (all of them when left out). `scroll`: in a box
 * of its own height that scrolls (the dialog).
 */
export function ReleaseNotes({ notes, older = 0, limit, scroll, label }: { notes: ReleaseNote[]; older?: number; limit?: number; scroll?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!notes.length) return null;
  const grouped = notes.length > 1;
  const { shown, rest } = limit === undefined ? { shown: split(notes, Infinity).shown, rest: [] as Part[] } : split(notes, limit);
  const hasMore = rest.length > 0;
  return (
    <div className="pb-relnotes" data-scroll={scroll || undefined} aria-label={label} role="group">
      <div className="pb-relnotes-body" tabIndex={scroll ? 0 : undefined}>
        <Parts parts={shown} grouped={grouped} />
        {hasMore && (
          <div id={id} className="pb-relnotes-motion" data-collapsed={!open || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
            <div className="pb-relnotes-inner">
              <Parts parts={rest} grouped={grouped} />
              {older > 0 && <p className="pb-relnotes-older">{olderWords(older)}</p>}
            </div>
          </div>
        )}
        {!hasMore && older > 0 && <p className="pb-relnotes-older">{olderWords(older)}</p>}
      </div>
      {hasMore && (
        <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush pb-relnotes-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <ChevronIcon /> <span className="pb-swap">
            <span className="pb-swap-line" data-show={!open || undefined} aria-hidden={open || undefined}>Show all</span>
            <span className="pb-swap-line" data-show={open || undefined} aria-hidden={!open || undefined}>Show less</span>
          </span>
        </button>
      )}
    </div>
  );
}

/** "What's new in 0.45.0": a quiet disclosure that opens this version's notes in place. */
export function ThisVersionNotes({ note }: { note: ReleaseNote }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="pb-relnotes-disclosure">
      <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush pb-relnotes-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon /> <span>{`What's new in ${note.version}`}</span>
      </button>
      <div id={id} className="pb-relnotes-motion" data-collapsed={!open || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
        <div className="pb-relnotes-inner">
          <ReleaseNotes notes={[note]} label={`What's new in ${note.version}`} />
        </div>
      </div>
    </div>
  );
}
