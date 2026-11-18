// "Task managers" (docs/build/step-task-managers.md): every bot's task managers that have not been
// ended, in the right rail just above "Helpers at work" and on the phone's Needs you screen. One row
// each, oldest first: the bot's face, the title, the bot's name and what it does now ("2 workers",
// "waits for you", "resting"), and how long it has run. A click opens its thread. Hidden while there
// is none. The rows have the look of Helpers at work, so the two read as one family.
import { useEffect, useRef, useState } from "react";
import type { Bot, TaskManagerInfo } from "../../shared/protocol";
import { useNow } from "../lib/hooks";
import { AT_WORK_TICK_MS, workedWord } from "../lib/helpers-at-work";
import { allManagers, openManager, TM_WORDS, type Managed } from "../lib/task-managers";
import { useAppState } from "../state/store";
import { Face, Mark } from "./bits";

/** How long a row that ended takes to fold away: dur-calm. */
const LEAVE_MS = 280;

export function TaskManagers() {
  const bots = useAppState((s) => s.bots);
  const list = useLeavingRows(allManagers(bots));
  if (list.length === 0) return null;
  const live = list.filter((r) => !r.leaving).length;
  return (
    <section className="pb-atwork pb-tms app-tms" aria-labelledby="tms-title">
      <h3 className="pb-side-title pb-atwork-title" id="tms-title">
        {TM_WORDS.title}
        <span className="pb-atwork-count">{live || ""}</span>
      </h3>
      <ul className="pb-atwork-list">
        {list.map((r) => (
          <li className="pb-atwork-slot" key={r.tm.id} data-leaving={r.leaving || undefined}>
            <ManagerRow bot={r.bot} tm={r.tm} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ManagerRow({ bot, tm }: { bot: Bot; tm: TaskManagerInfo }) {
  const title = tm.title.trim() || "Task manager";
  const whose = TM_WORDS.whose(bot.name, tm);
  return (
    <button
      className="pb-atwork-item pb-tms-item pb-arrive"
      type="button"
      data-manager-id={tm.id}
      data-bot-id={bot.id}
      data-state={tm.state}
      aria-label={`${title}, a task manager of ${whose}. Open its thread`}
      onClick={() => openManager(bot.id, tm)}
    >
      <Face look={bot.look} size="sm" />
      <span className="pb-atwork-text" aria-hidden="true">
        <span className="pb-atwork-name">{title}</span>
        {/* The words change in place; the row keeps its box. */}
        <span className="pb-atwork-whose pb-fade-in" key={whose}>
          {whose}
        </span>
      </span>
      <span className="pb-atwork-side" aria-hidden="true">
        {tm.state === "working" && <Mark state="thinking" />}
        {tm.state === "waiting" && <Mark state="waiting" />}
        <Ran startedAt={tm.startedAt} />
      </span>
    </button>
  );
}

/** How long it has run, brought up to date on its own so the row around it is not drawn again. */
function Ran({ startedAt }: { startedAt: string }) {
  const now = useNow(AT_WORK_TICK_MS);
  return <time className="pb-atwork-when">{workedWord(startedAt, now)}</time>;
}

/** Keeps a row that was ended for a moment, so it folds away calmly where it stood (as Helpers at work). */
function useLeavingRows(rows: Managed[]): (Managed & { leaving: boolean })[] {
  const [leaving, setLeaving] = useState<Managed[]>([]);
  const previous = useRef<Managed[]>(rows);
  const key = rows.map((r) => r.tm.id).join(",");
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.tm.id));
    const gone = previous.current.filter((r) => !ids.has(r.tm.id));
    previous.current = rows;
    if (gone.length === 0) return;
    setLeaving((l) => [...l, ...gone]);
    setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), LEAVE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const ids = new Set(rows.map((r) => r.tm.id));
  const all = rows.map((r) => ({ ...r, leaving: false }));
  for (const row of leaving) if (!ids.has(row.tm.id)) (ids.add(row.tm.id), all.push({ ...row, leaving: true }));
  return all.sort((a, b) => a.tm.startedAt.localeCompare(b.tm.startedAt) || a.tm.id.localeCompare(b.tm.id));
}
