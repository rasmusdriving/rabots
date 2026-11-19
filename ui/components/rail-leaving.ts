// Keep the same keyed row through its exit. Derive the new display list before React commits,
// so there is no render that removes the row and no new arrival animation.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

type Row<T> = { item: T; key: string; leaving: boolean };

const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
const reduce = () => motion?.matches ?? false;
function subscribe(change: () => void) {
  motion?.addEventListener("change", change);
  return () => motion?.removeEventListener("change", change);
}

export function useRailLeaving<T>(items: T[], keyOf: (item: T) => string) {
  const immediate = useSyncExternalStore(subscribe, reduce);
  const live = (): Row<T>[] => items.map((item) => ({ item, key: keyOf(item), leaving: false }));
  const [state, setState] = useState(() => ({ items, immediate, rows: live() }));
  if (state.items !== items || state.immediate !== immediate) {
    const rows = live();
    if (!immediate) {
      // Insert runs of old rows after their closest surviving predecessor. This keeps adjacent
      // exits in order even when an earlier row starts leaving before they finish.
      let at = 0;
      for (const row of state.rows) {
        const present = rows.findIndex((current) => current.key === row.key);
        if (present >= 0) at = present + 1;
        else rows.splice(at++, 0, row.leaving ? row : { ...row, leaving: true });
      }
    }
    setState({ items, immediate, rows });
  }
  const finish = useCallback((key: string) => {
    setState((current) => ({ ...current, rows: current.rows.filter((row) => row.key !== key || !row.leaving) }));
  }, []);
  return { rows: state.rows, finish };
}

/** CSS owns the timing. A hidden row (or one with transitions disabled) has nothing to wait for. */
export function useRailExit<T extends HTMLElement>(key: string, leaving: boolean, finish: (key: string) => void) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!leaving || !ref.current) return;
    let active = true;
    const transitions = ref.current.getAnimations();
    if (transitions.length === 0) finish(key);
    else void Promise.allSettled(transitions.map((transition) => transition.finished)).then(() => {
      if (active) finish(key);
    });
    return () => { active = false; };
  }, [key, leaving, finish]);
  return ref;
}
