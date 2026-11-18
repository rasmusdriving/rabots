// Helpers at work (protocol 19, docs/build/step-helpers-in-rail.md): every helper that works now,
// across the bots, listed in the right rail; and what the "Waiting for a helper" line in the chat
// does when it is clicked. Following T3 Code's sidebar, which lists every thread that works with a
// duration that counts up (apps/web/src/components/sidebar/SidebarThreadRow.tsx, WorkingDuration).
import { useEffect, useState } from "react";
import type { Bot, WorkingHelper } from "../../shared/protocol";
import { openHelper } from "../state/actions";
import { store } from "../state/store";
import { isPhone } from "./phone";
import { duration } from "./words";
import { openWorker } from "./task-managers";

export const AT_WORK_WORDS = {
  title: "Helpers at work",
  more: (n: number) => `${n} more`,
  less: "Show less",
  /** Under the title: whose helper it is, and the fresh run it works for when there is one. */
  whose: (bot: string, run?: string) => (run ? `${bot}, in ${run}` : bot),
  /** The waiting line, when every helper it waits on works for the same fresh run. */
  inRun: (words: string, run: string) => `${words} in ${run}`,
} as const;

/** How many rows show before "N more". */
export const AT_WORK_ROWS = 3;
/** How often the durations are brought up to date. */
export const AT_WORK_TICK_MS = 30_000;
/** How long a row stays marked after the waiting line pointed at it. */
const MARK_MS = 2400;

export interface AtWork {
  bot: Bot;
  helper: WorkingHelper;
}

/** Every working helper of every bot, oldest first, so a new one comes at the end and nothing moves. */
export function allAtWork(bots: Bot[]): AtWork[] {
  const out: AtWork[] = [];
  for (const bot of bots) for (const helper of bot.workingHelpers ?? []) out.push({ bot, helper });
  return out.sort((a, b) => a.helper.startedAt.localeCompare(b.helper.startedAt));
}

/** "now" under a minute, then "4 min", "1 h 5 min": how long it has worked. */
export function workedWord(startedAt: string, now: number): string {
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  return duration(ms);
}

/** Opens a working helper's thread, the same thread its row in the chat opens, going to its bot first. */
export function openWorking(botId: string, w: WorkingHelper): void {
  // A task manager's worker opens inside its task manager's thread.
  const bot = store.get().bots.find((b) => b.id === botId);
  if (w.managerId && bot && openWorker(bot, w)) return;
  store.leave(() => {
    if (store.get().openBotId !== botId || store.get().openChannelId || isPhone()) store.openBot(botId);
    openHelper({ id: w.itemId, botId, threadId: w.threadId, helperThreadId: w.helperThreadId, title: w.title, status: "running" });
  });
}

/** The fresh run every one of these helpers works for, when they share one. */
export function sharedRun(list: WorkingHelper[]): string | undefined {
  const run = list[0]?.inRun;
  return run && list.every((w) => w.inRun === run) ? run : undefined;
}

// ------------------------------------------------------------ marking rows

/** The helper item ids marked in the rail now, and who listens. */
let marked: ReadonlySet<string> = new Set();
const listeners = new Set<(ids: ReadonlySet<string>) => void>();
let unmarkTimer: ReturnType<typeof setTimeout> | undefined;

function setMarked(ids: ReadonlySet<string>): void {
  marked = ids;
  for (const l of listeners) l(ids);
}

/** The rail's rows that are marked now. */
export function useMarkedHelpers(): ReadonlySet<string> {
  const [ids, setIds] = useState(marked);
  useEffect(() => {
    listeners.add(setIds);
    return () => {
      listeners.delete(setIds);
    };
  }, []);
  return ids;
}

/** Marks rows in the chat for a moment: an attribute the chat's helper rows do not set themselves. */
function markInChat(rows: HTMLElement[]): void {
  for (const el of rows) el.setAttribute("data-marked", "");
  setTimeout(() => {
    for (const el of rows) el.removeAttribute("data-marked");
  }, MARK_MS);
}

/**
 * The "Waiting for 3 helpers" line was clicked: their rows in this chat when they all stand in it,
 * brought into view and marked; otherwise their rows in "Helpers at work" (on the phone, on the
 * Needs you screen). When the rail cannot be seen, the oldest helper's thread opens.
 */
export function showWaitedOn(bot: Bot, list: WorkingHelper[], from: HTMLElement | null): void {
  if (list.length === 0) return;
  if (list.length === 1) return openWorking(bot.id, list[0]!);
  const chat = from?.closest<HTMLElement>(".pb-main-scroll");
  const rows = chat ? list.map((w) => chat.querySelector<HTMLElement>(`.pb-helper[data-helper-id="${CSS.escape(w.itemId)}"]`)) : [];
  if (rows.length && rows.every((r): r is HTMLElement => !!r)) {
    rows[0]!.scrollIntoView({ block: "nearest" });
    return markInChat(rows);
  }
  const phone = isPhone();
  const rail = document.querySelector<HTMLElement>(".app-rail");
  if (!phone && (!rail || rail.getAttribute("aria-hidden") === "true")) return openWorking(bot.id, list[0]!);
  if (phone) store.setPhoneScreen("needs");
  clearTimeout(unmarkTimer);
  setMarked(new Set(list.map((w) => w.itemId)));
  unmarkTimer = setTimeout(() => setMarked(new Set()), MARK_MS);
}
