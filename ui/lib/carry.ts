// What the person typed and has not saved yet, carried across the window changing between the
// laptop layout and the phone layout (docs/build/notes-phone-review-fixes.md, point 1).
//
// App.tsx renders a different tree for each layout, so when a window crosses 700 px (a narrowed
// window, a turned tablet) every part is made anew and its own state starts over. A part that holds
// unsaved text mirrors it here while it is mounted, under a key of its own (the bot and the file,
// say). The part made anew in the other layout reads it when it starts. When the part goes for any
// other reason (closed, saved, left without saving) what it mirrored is forgotten, so nothing comes
// back by surprise later. On the laptop, without a crossing, this changes nothing anyone sees.
import { useEffect, useRef } from "react";
import { isPhone } from "./phone";

const kept = new Map<string, unknown>();

/** What a part with this key held when the window last crossed between the layouts, if anything. */
export function carried<T>(key: string): T | undefined {
  return kept.get(key) as T | undefined;
}

/** Whether something is kept under a key that passes `test`. */
export function carriedAny(test: (key: string) => boolean): boolean {
  for (const k of kept.keys()) if (test(k)) return true;
  return false;
}

/** Runs `then` when the part goes because the window crossed between the layouts, and `otherwise` when it goes for any other reason. */
export function useOnCross(then: () => void, otherwise?: () => void): void {
  const live = useRef({ then, otherwise });
  live.current = { then, otherwise };
  useEffect(() => {
    const phone = isPhone();
    return () => {
      if (isPhone() !== phone) live.current.then();
      else live.current.otherwise?.();
    };
  }, []);
}

/**
 * Mirrors `value` under `key` while the part is mounted (undefined: nothing to keep). It is kept when
 * the part goes because the window crossed between the layouts, and forgotten when it goes otherwise.
 */
export function useCarry(key: string, value: unknown): void {
  const at = useRef(key);
  at.current = key;
  useEffect(() => {
    if (value === undefined) kept.delete(key);
    else kept.set(key, value);
  }, [key, value]);
  useOnCross(
    () => undefined,
    () => kept.delete(at.current),
  );
}
