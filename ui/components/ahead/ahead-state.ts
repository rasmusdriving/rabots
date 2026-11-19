// Ahead's state in the window (protocol 31): the view as read, what waits behind "2 new · Show",
// the items the person acted on during this visit, and the per-device choices (hide meetings, the
// bot filter). Nothing reorders while the person looks: a new read that differs from what shows
// waits until they press Show; a row they act on keeps its box and shows its new state until they leave.
import { useCallback, useEffect, useRef, useState } from "react";
import { AHEAD_DAYS, type AheadAction, type AheadItem, type AheadPlace, type AheadView, type Methods } from "../../../shared/protocol";
import { engineRequest } from "../../state/actions";
import { store, useAppState } from "../../state/store";
import { applyLocal, differences, keepVisit } from "./ahead-visit";

export interface AheadModel {
  view?: AheadView;
  error?: string;
  /** Rows that arrived or changed since what shows: the held line. */
  held: { added: number; changed: number } | null;
  showHeld(): void;
  add(title: string, day: string): Promise<AheadItem>;
  /** `more`: part B's time for Pick a time, or a place Pobots finds the slot for. */
  act(item: AheadItem, action: AheadAction, day?: string, more?: { time?: string | null; place?: AheadPlace }): Promise<AheadItem>;
}

// On a quick return, wait for the preceding visit's checkpoint before reading again.
let departing: Promise<unknown> | undefined;

export function useAhead(): AheadModel {
  const version = useAppState((s) => s.aheadVersion);
  const days = useAppState((s) => (s.ahead?.workDays.length ?? 5) < 3 ? 35 : AHEAD_DAYS);
  const sources = useAppState((s) => JSON.stringify([
    s.bots.map((b) => [b.id, b.vacationSince, b.workingHelpers?.filter((h) => !h.managerId).length, b.taskManagers?.filter((m) => m.state === "working").length]),
    s.cards.filter((c) => c.kind !== "system").map((c) => c.id),
    s.todos.map((t) => [t.id, t.due, t.title]),
    s.upcoming.map((u) => [u.triggerId, u.at]),
    s.calendar?.connected,
    s.calendar?.checkedAt,
  ]));
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<AheadView>();
  const [error, setError] = useState<string>();
  const [held, setHeld] = useState<AheadModel["held"]>(null);
  const shown = useRef<AheadView | undefined>(undefined);
  const pending = useRef<AheadView | undefined>(undefined);
  const mine = useRef(new Map<string, AheadItem>());
  const acknowledged = useRef<string | undefined>(undefined);
  useEffect(() => {
    const leave = () => {
      const through = shown.current?.screen?.readAt;
      if (!through || through === acknowledged.current || !store.get().ahead?.enabled) return;
      acknowledged.current = through;
      const sent = engineRequest("ahead.seen", { through }).catch(() => { acknowledged.current = undefined; });
      departing = sent;
      void sent.then(() => { if (departing === sent) departing = undefined; });
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);

  const show = useCallback((v: AheadView) => {
    shown.current = v;
    pending.current = undefined;
    setHeld(null);
    setView(v);
  }, []);

  useEffect(() => {
    let live = true;
    const read = () => live ? engineRequest("ahead.view", { days }) : undefined;
    (departing ? departing.then(read) : Promise.resolve(read()))
      .then((next) => {
        if (!live || !next) return;
        setError(undefined);
        const merged = keepVisit(next, shown.current, mine.current);
        const was = shown.current;
        if (!was) return show(merged);
        const d = differences(was, merged, mine.current);
        if (!d.added && !d.changed) {
          const previous = was.screen?.carrying ?? [];
          const current = merged.screen?.carrying ?? [];
          const newBots = current.filter((c) => !previous.some((p) => p.botId === c.botId));
          if (!newBots.length) {
            // Carrying counts can change in their own slots. An empty slot is kept for this visit.
            if (merged.screen) merged.screen.carrying = previous.map((p) => current.find((c) => c.botId === p.botId) ?? { botId: p.botId, onAhead: 0, due: 0, waiting: 0, helpers: 0, managers: 0 });
            return show(merged);
          }
          d.changed = newBots.length;
        }
        // Something arrived or moved while the person looks: it waits behind one line.
        pending.current = next;
        setHeld(d);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [version, days, sources, refresh, show]);

  const showHeld = useCallback(() => {
    if (pending.current) show(keepVisit(pending.current, shown.current, mine.current));
  }, [show]);

  const local = useCallback((item: AheadItem, added = false) => {
    mine.current.set(item.id, item);
    const v = shown.current;
    if (v) {
      const next = applyLocal(v, item, added);
      shown.current = next;
      setView(next);
    }
    setRefresh((n) => n + 1);
    return item;
  }, []);

  const act = useCallback(async (item: AheadItem, action: AheadAction, day?: string, more?: { time?: string | null; place?: AheadPlace }) => {
    const params: Methods["ahead.act"]["params"] = { itemId: item.id, action, ...(day ? { day } : {}), ...more };
    return local((await engineRequest("ahead.act", params)).item);
  }, [local]);

  const add = useCallback(async (title: string, day: string) => local((await engineRequest("ahead.add", { title, day })).item, true), [local]);

  return { view, error, held, showHeld, act, add };
}

// ------------------------------------------------------------ per-device choices

const HIDE_KEY = "pobotsAheadHideMeetings";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** "Hide meetings", remembered on this device. */
export function useHideMeetings(): [boolean, (on: boolean) => void] {
  const [hide, setHide] = useState(() => readFlag(HIDE_KEY));
  const set = useCallback((on: boolean) => {
    setHide(on);
    try {
      if (on) localStorage.setItem(HIDE_KEY, "1");
      else localStorage.removeItem(HIDE_KEY);
    } catch {
      // A convenience only.
    }
  }, []);
  return [hide, set];
}
