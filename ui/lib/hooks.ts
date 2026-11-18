// Small React hooks shared by the views.
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../engine/types";

/** The time now, refreshed every `everyMs`. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** How long "Saved" stays beside a field before it fades. */
export const SAVED_MS = 2400;

export type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

/**
 * Runs saves for one field and says how it went: "Saved" for a moment, or the engine's sentence.
 * Settings save as they change, so each field has its own quiet word.
 */
export function useSaver(): [SaveState, (work: () => Promise<unknown>) => Promise<boolean>] {
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async (work: () => Promise<unknown>) => {
    clearTimeout(timer.current);
    setState({ phase: "saving" });
    try {
      await work();
      setState({ phase: "saved" });
      timer.current = setTimeout(() => setState({ phase: "idle" }), SAVED_MS);
      return true;
    } catch (e) {
      setState({ phase: "error", message: messageOf(e) });
      return false;
    }
  };
  return [state, run];
}
