// "Helpers at work" (docs/build/step-helpers-in-rail.md): every helper that works now, across the
// bots, in the right rail just above "Your to-do" and on the phone's Needs you screen. One row per
// helper, oldest first: the bot's face, the helper's title, the bot's name (and the fresh run it
// works for), the provider's mark and how long it has worked. A click opens the helper's thread.
// Three rows, then "N more". Hidden while no helper works.
import { useEffect, useRef, useState } from "react";
import type { Bot, WorkingHelper } from "../../shared/protocol";
import { useNow } from "../lib/hooks";
import { allAtWork, AT_WORK_ROWS, AT_WORK_TICK_MS, AT_WORK_WORDS, openWorking, useMarkedHelpers, workedWord, type AtWork } from "../lib/helpers-at-work";
import { PROVIDERS, helperHarness } from "../lib/providers";
import { TM_WORDS } from "../lib/task-managers";
import { useAppState } from "../state/store";
import { Face } from "./bits";

/** How long a row that ended takes to fold away: dur-calm. */
const LEAVE_MS = 280;

export function HelpersAtWork() {
  const bots = useAppState((s) => s.bots);
  const list = useLeavingRows(allAtWork(bots));
  const marked = useMarkedHelpers();
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const working = list.filter((r) => !r.leaving);
  // A row the waiting line points at is never hidden behind "N more".
  const markedHidden = working.slice(AT_WORK_ROWS).some((r) => marked.has(r.helper.itemId));
  useEffect(() => {
    if (markedHidden) setOpen(true);
  }, [markedHidden]);
  // Once nothing waits behind "N more", the list starts folded again next time.
  const fits = working.length <= AT_WORK_ROWS;
  useEffect(() => {
    if (fits) setOpen(false);
  }, [fits]);
  useEffect(() => {
    if (!marked.size) return;
    section.current?.querySelector<HTMLElement>(".pb-atwork-item[data-marked]")?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  if (list.length === 0) return null;
  // The first rows that work stay; the ones past them wait behind "N more". A row that is leaving keeps its place.
  const cut = open ? Infinity : AT_WORK_ROWS;
  let seen = 0;
  const shown = list.filter((r) => (r.leaving ? seen < cut : seen++ < cut));
  const more = Math.max(0, working.length - AT_WORK_ROWS);
  return (
    <section className="pb-atwork app-atwork" aria-labelledby="atwork-title" ref={section}>
      <h3 className="pb-side-title pb-atwork-title" id="atwork-title">
        {AT_WORK_WORDS.title}
        <span className="pb-atwork-count">{working.length || ""}</span>
      </h3>
      <ul className="pb-atwork-list">
        {shown.map((r) => (
          <li className="pb-atwork-slot" key={r.helper.itemId} data-leaving={r.leaving || undefined}>
            <AtWorkRow bot={r.bot} helper={r.helper} marked={marked.has(r.helper.itemId)} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button className="pb-atwork-more" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? AT_WORK_WORDS.less : AT_WORK_WORDS.more(more)}
        </button>
      )}
    </section>
  );
}

function AtWorkRow({ bot, helper, marked }: { bot: Bot; helper: WorkingHelper; marked: boolean }) {
  const models = useAppState((s) => s.models);
  const harness = helperHarness(helper, models);
  const provider = harness ? PROVIDERS[harness] : undefined;
  const title = helper.title.trim() || "Helper";
  // A task manager's worker says whose task it works for (protocol 21).
  const whose = helper.managerId ? TM_WORDS.forBot(bot.name, helper.taskManager?.trim() || "a task manager") : AT_WORK_WORDS.whose(bot.name, helper.inRun);
  return (
    <button
      className="pb-atwork-item pb-arrive"
      type="button"
      data-helper-id={helper.itemId}
      data-bot-id={bot.id}
      data-marked={marked || undefined}
      aria-label={`${title}, a helper of ${whose}${provider ? `, on ${provider.name}` : ""}. Open its thread`}
      onClick={() => openWorking(bot.id, helper)}
    >
      <Face look={bot.look} size="sm" />
      <span className="pb-atwork-text" aria-hidden="true">
        <span className="pb-atwork-name">{title}</span>
        <span className="pb-atwork-whose">{whose}</span>
      </span>
      <span className="pb-atwork-side" aria-hidden="true">
        {provider && (
          <span className="pb-atwork-mark" data-provider={harness} title={`A helper on ${provider.name}`}>
            <provider.Mark />
          </span>
        )}
        <Worked startedAt={helper.startedAt} />
      </span>
    </button>
  );
}

/** How long it has worked, brought up to date on its own so the row around it is not drawn again. */
function Worked({ startedAt }: { startedAt: string }) {
  const now = useNow(AT_WORK_TICK_MS);
  return <time className="pb-atwork-when">{workedWord(startedAt, now)}</time>;
}

/**
 * Keeps a row that ended for a moment, so it folds away calmly where it stood. The list is in the
 * order the helpers started, so a leaving row goes back by when it started: several that end in
 * the same moment, in any order and in several updates, keep their places (test copy, 16 Nov 2026).
 */
function useLeavingRows(rows: AtWork[]): (AtWork & { leaving: boolean })[] {
  const [leaving, setLeaving] = useState<AtWork[]>([]);
  const previous = useRef<AtWork[]>(rows);
  const shownOrder = useRef<string[]>([]);
  const key = rows.map((r) => r.helper.itemId).join(",");
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.helper.itemId));
    const gone = previous.current.filter((r) => !ids.has(r.helper.itemId));
    previous.current = rows;
    if (gone.length === 0) return;
    setLeaving((l) => [...l, ...gone]);
    setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), LEAVE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const ids = new Set(rows.map((r) => r.helper.itemId));
  const all = rows.map((r) => ({ ...r, leaving: false }));
  for (const row of leaving) if (!ids.has(row.helper.itemId)) (ids.add(row.helper.itemId), all.push({ ...row, leaving: true }));
  // Rows that started in the same moment keep the order they were shown in; a new one comes after them.
  const was = new Map(shownOrder.current.map((id, i) => [id, i]));
  const place = (r: AtWork) => was.get(r.helper.itemId) ?? Infinity;
  all.sort((a, b) => a.helper.startedAt.localeCompare(b.helper.startedAt) || place(a) - place(b) || 0);
  shownOrder.current = all.map((r) => r.helper.itemId);
  return all;
}
