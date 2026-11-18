// The bot's lines of work and thinking summaries between two pieces of its text, as one line (step
// 7a, after T3 Code's work log). While the bot works in it, the line shows the step that runs with
// its icon and a calm shine on its words, in one box of one height. Pressed, it opens the list in
// order; each row opens to its detail. Icons: Lucide (ISC licence), drawn at the house's stroke.
import { useState, type ReactNode } from "react";
import type { ActivityItem, ToolKind } from "../../shared/protocol";
import { currentOf, kindOf, summarize } from "../lib/work";
import { duration } from "../lib/words";

const icon = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const PATHS: Record<ToolKind | "mixed", ReactNode> = {
  command: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  read: (
    <>
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.38 2.63a1 1 0 0 1 3 3l-9.02 9.01a2 2 0 0 1-.85.5l-2.87.85a.5.5 0 0 1-.62-.62l.84-2.88a2 2 0 0 1 .5-.85z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  think: (
    <>
      <path d="M12 5a3 3 0 1 0-6 .13 4 4 0 0 0-2.52 5.77 4 4 0 0 0 .55 6.59A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 6 .13 4 4 0 0 1 2.52 5.77 4 4 0 0 1-.55 6.59A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </>
  ),
  plan: (
    <>
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </>
  ),
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  skill: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  other: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  mixed: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
};

/** The small drawn icon of a kind of work. */
export function KindIcon({ kind }: { kind: ToolKind | "mixed" }) {
  return (
    <span className="pb-work-icon" data-kind={kind} aria-hidden="true">
      <svg {...icon}>{PATHS[kind]}</svg>
    </span>
  );
}

/** Which groups are open, while the app is open. */
const openGroups = new Set<string>();

/**
 * `live`: the bot works in this group now (it is the newest thing of the answer it is in). `thinking`:
 * while nothing of it runs and the bot thinks, the words of that (the engine's line); the newest
 * thinking summary stands in for them when there is one. `work`: it folds away with the turn's work.
 */
export function WorkGroup({ id, items, live, thinking, work }: { id: string; items: ActivityItem[]; live: boolean; thinking?: string; work: boolean }) {
  const [open, setOpen] = useState(() => openGroups.has(id));
  const toggle = () => {
    if (open) openGroups.delete(id);
    else openGroups.add(id);
    setOpen(!open);
  };
  // The newest step that runs (several can run at once).
  const running = [...items].reverse().find((i) => i.status === "running");
  const current = currentOf(items)!;
  const single = items.length === 1;
  const failed = items.filter((i) => i.status === "failed").length;
  let words: string;
  let kind: ToolKind | "mixed";
  if (live && running) {
    words = running.label;
    kind = kindOf(running);
  } else if (live && thinking) {
    const thought = kindOf(current) === "think" ? current.label : undefined;
    words = thought ?? thinking;
    kind = "think";
  } else if (single) {
    words = current.label;
    kind = kindOf(current);
  } else {
    ({ words, kind } = summarize(items));
  }
  const shining = live && (!!running || !!thinking);
  const took = items.reduce((n, i) => n + (i.status !== "running" ? (i.durationMs ?? 0) : 0), 0);
  const listId = `work-${id}`;
  const detail = single ? current.detail : undefined;
  const opens = !single || !!detail;
  const line = (
    <>
      <KindIcon kind={kind} />
      <span className="pb-workline-words pb-fade-in" key={`${kind}:${words}`} data-shine={shining || undefined}>
        {words}
      </span>
      {failed > 0 && <span className="app-activity-failed">{single ? "Failed" : `${failed} failed`}</span>}
      {!shining && took > 0 && <span className="pb-time">{duration(took)}</span>}
    </>
  );
  return (
    <div className="pb-step pb-workgroup pb-arrive" data-work={work || undefined} data-live={live || undefined} data-count={items.length} data-group={id}>
      {opens ? (
        <button type="button" className="pb-activity app-activity-btn pb-workline" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={toggle}>
          {line}
        </button>
      ) : (
        <div className="pb-activity pb-workline">{line}</div>
      )}
      {open &&
        (single ? (
          <pre className={`pb-draft app-activity-detail${kindOf(current) === "think" ? " pb-thought" : ""}`} id={listId}>
            {detail}
          </pre>
        ) : (
          <div className="pb-work-list" id={listId} role="list" aria-label="The steps">
            {items.map((item) => (
              <WorkRow key={item.id} item={item} />
            ))}
          </div>
        ))}
    </div>
  );
}

/** One row of an open group: its icon, its words, "Failed", how long it took; it opens to its detail. */
function WorkRow({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const kind = kindOf(item);
  const body = (
    <>
      <KindIcon kind={kind} />
      <span className="pb-workline-words">{item.label}</span>
      {item.status === "failed" && <span className="app-activity-failed">Failed</span>}
      {item.durationMs !== undefined && item.status !== "running" && <span className="pb-time">{duration(item.durationMs)}</span>}
    </>
  );
  return (
    <div className="pb-work-row" role="listitem" data-kind={kind} data-status={item.status}>
      {item.detail ? (
        <button type="button" className="pb-activity app-activity-btn pb-workline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {body}
        </button>
      ) : (
        <div className="pb-activity pb-workline">{body}</div>
      )}
      {open && item.detail && <pre className={`pb-draft app-activity-detail${kind === "think" ? " pb-thought" : ""}`}>{item.detail}</pre>}
    </div>
  );
}
