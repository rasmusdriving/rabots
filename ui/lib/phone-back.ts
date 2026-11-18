// On a phone, a layer over the screen (a picture opened large, the model picker, a dialog) is a
// history entry of its own, so the back control, the browser's back, Android's back gesture and the
// iOS edge swipe close it instead of leaving the bot (docs/build/step-phone.md, decided 3 and 9).
//
// The entry is the current history state with the layer's id added to a list under one key, the
// same way helper threads add theirs (store.ts, historyStateWith): everything else in the state,
// the screen and the helper threads, is carried over unchanged, so going back to the entry below
// shows exactly what was there. On the laptop none of this runs.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { isPhone } from "./phone";
import { deeper } from "../state/phone-view";

/** The key in history.state that holds the open layers, innermost last. */
export const LAYER_STATE_KEY = "pobotsLayers";

let nextLayer = 1;

function stateNow(): Record<string, unknown> {
  try {
    return history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The layers open in a history state. */
export function layersOf(state: unknown): string[] {
  const value = state && typeof state === "object" ? (state as Record<string, unknown>)[LAYER_STATE_KEY] : undefined;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ------------------------------------------------------------ a move over several entries at once
// Twice the window steps over several history entries at once: here, when a reload on a phone
// leaves the layers it was on, and in state/screens.ts, when the window stops being a phone. Such a
// move lands later, with one popstate, and that popstate belongs to the move alone. Until it has
// landed, a layer that opens (a dialog or sheet made anew as the window became a phone again, say)
// waits to add its entry, so it never takes that popstate for its own back, and its entry goes on
// top of the entry the move lands on. The screens start after the reload's move in the same way.

let waiting: (() => void)[] | null = null;

/**
 * How long a move over several entries may take to land before the window goes on without its
 * popstate. In a browser it lands within a frame or two; this is only a net for a move that cannot
 * land (an entry out of reach), so nothing waits for ever.
 */
export const MOVE_LANDS_MS = 3000;

/** A move over several entries has started: what asks for afterMove() waits until it has landed. */
export function holdForMove(): void {
  waiting ??= [];
}

/** The move has landed: what waited runs now, in the order it asked. */
export function moveLanded(): void {
  const queue = waiting;
  waiting = null;
  for (const go of queue ?? []) go();
}

/** Runs `go` now, or once a move under way has landed. Returns a function that takes it back. */
export function afterMove(go: () => void): () => void {
  if (!waiting) {
    go();
    return () => undefined;
  }
  waiting.push(go);
  return () => {
    if (waiting) waiting = waiting.filter((g) => g !== go);
  };
}

// A reload on a phone shows no layer: the entry it was on forgets them, and the window steps back
// over the entries the layers were, to the screen under them. So the next back goes to the screen
// before, not to an entry that shows the same screen again. A reload at laptop width does not: the
// laptop steps back over every phone entry itself, layers and all, when the screens start.
try {
  const layers = typeof window !== "undefined" && isPhone() ? layersOf(history.state).length : 0;
  if (layers) {
    const { [LAYER_STATE_KEY]: _gone, ...rest } = stateNow();
    history.replaceState(rest, "");
    holdForMove();
    const landed = () => {
      clearTimeout(net);
      window.removeEventListener("popstate", landed);
      moveLanded();
    };
    const net = setTimeout(landed, MOVE_LANDS_MS);
    window.addEventListener("popstate", landed);
    history.go(-layers);
  }
} catch {
  // Without history there is nothing to forget.
  moveLanded();
}

/**
 * While the component is mounted on a phone, it is a history entry: back calls `onBack` (which
 * closes it). `close()` closes it from inside (Close, Escape, a tap outside): it goes back through
 * history, so the entry is gone too, and `onBack` runs from there. On the laptop `close()` simply
 * calls `onBack`.
 */
export function useBackLayer(onBack: () => void, guard?: BackGuard): { close(): void; closeWhenTop(): void } {
  const back = useRef(onBack);
  back.current = onBack;
  const guarded = useRef(guard);
  guarded.current = guard;
  const layer = useRef<{ id: string; length: number; done: boolean } | null>(null);

  useEffect(() => {
    if (!isPhone()) return;
    let mine: { id: string; length: number; done: boolean } | null = null;
    let onPop: (() => void) | null = null;
    // Its entry goes on once a move over several entries has landed (above); at once otherwise.
    const cancel = afterMove(() => {
      if (!isPhone()) return;
      const id = `l${nextLayer++}`;
      try {
        history.pushState(deeper({ ...stateNow(), [LAYER_STATE_KEY]: [...layersOf(history.state), id] }, history.state), "");
      } catch {
        return;
      }
      const it = { id, length: history.length, done: false };
      mine = it;
      layer.current = it;
      onPop = () => {
        if (it.done || !isPhone()) return;
        const layers = layersOf(history.state);
        if (layers.includes(id)) {
          // Back on its own entry after a layer over it closed (the question about unsaved text, a
          // picker over a dialog): history.length now counts that entry too, so it is noted anew,
          // and closing this layer still goes back through history.
          if (layers.at(-1) === id) it.length = history.length;
          return;
        }
        // Something in it must be asked about first (unsaved text): its entry is put back on top, as
        // the screens do (state/screens.ts), and the question is asked over it.
        if (guarded.current?.holds()) {
          try {
            history.pushState(deeper({ ...stateNow(), [LAYER_STATE_KEY]: [...layers, id] }, history.state), "");
            it.length = history.length;
            guarded.current.held();
            return;
          } catch {
            // Without history it simply closes.
          }
        }
        it.done = true;
        back.current();
      };
      window.addEventListener("popstate", onPop);
    });
    return () => {
      cancel();
      if (onPop) window.removeEventListener("popstate", onPop);
      layer.current = null;
      if (!mine || mine.done) return;
      const { id } = mine;
      // Closed some other way (its bot was left, a button inside opened something else): its entry
      // goes too when it is still the newest one; when something was pushed over it since, it is only
      // forgotten, so the entry shows what is under it. When the window stopped being a phone, the
      // screens step back over every phone entry at once (state/screens.ts).
      mine.done = true;
      if (!isPhone()) return;
      try {
        const top = layersOf(history.state).at(-1) === id;
        if (top && history.length === mine.length) history.back();
        else if (layersOf(history.state).includes(id)) history.replaceState({ ...stateNow(), [LAYER_STATE_KEY]: layersOf(history.state).filter((l) => l !== id) }, "");
      } catch {
        // As above.
      }
    };
  }, []);

  return {
    close() {
      const mine = layer.current;
      if (mine && !mine.done && layersOf(history.state).at(-1) === mine.id && history.length === mine.length) {
        // Back through history; the popstate above closes it.
        try {
          history.back();
          return;
        } catch {
          // Fall through and close it here.
        }
      }
      // Not the newest entry (or no history): closed here, and the unmount above forgets its entry.
      back.current();
    },
    closeWhenTop() {
      // A layer over this one is on its way out (the question about unsaved text, just answered):
      // its own step back lands within a frame or two, and only then is this layer the newest entry.
      let tries = 0;
      const go = () => {
        const mine = layer.current;
        if (!mine || mine.done) return;
        const layers = layersOf(history.state);
        if (layers.includes(mine.id) && layers.at(-1) !== mine.id && tries++ < 30) return void requestAnimationFrame(go);
        this.close();
      };
      go();
    },
  };
}

/** What a layer asks before the browser's back may close it. */
export interface BackGuard {
  /** True while going back must ask first (unsaved text in it). */
  holds(): boolean;
  /** Back was pressed while it held: the layer's entry is on top again; ask now. */
  held(): void;
}

// ------------------------------------------------------------ a step back inside a screen
// A screen may hold something of its own that back closes first: a file open in the bot's Files.
// While it is there the phone's back control leads to it and says so, the same step the browser's
// back takes (its layer above), so the two never disagree.

let inner: { name: string; back(): void } | null = null;
const innerWatchers = new Set<() => void>();
function setInner(next: typeof inner): void {
  inner = next;
  for (const w of innerWatchers) w();
}

/** While mounted on a phone, the back control says `name` and calls `back`. */
export function useInnerBack(name: string, back: () => void): void {
  const fn = useRef(back);
  fn.current = back;
  useEffect(() => {
    if (!isPhone()) return;
    const mine = { name, back: () => fn.current() };
    setInner(mine);
    return () => {
      if (inner === mine) setInner(null);
    };
  }, [name]);
}

/** The step back inside the screen that shows, when there is one. */
export function useInner(): { name: string; back(): void } | null {
  return useSyncExternalStore(
    (w) => {
      innerWatchers.add(w);
      return () => innerWatchers.delete(w);
    },
    () => inner,
  );
}

/** Takes the step back inside the screen. False when there is none. */
export function innerBack(): boolean {
  if (!inner) return false;
  inner.back();
  return true;
}

/**
 * Takes the step back inside the screen first, when there is one, and runs `go` once it has landed:
 * for going sideways from it (another tab of the bot's page while a file is open), so the file's
 * step is gone from history first and back from the new place leads where its control says. Call it
 * inside store.leave, so unsaved text has been asked about already. Without a step inside, `go`
 * runs at once.
 */
export function afterInner(go: () => void): void {
  const mine = inner;
  if (!mine || !isPhone()) return go();
  const done = () => {
    clearTimeout(net);
    innerWatchers.delete(watch);
  };
  const watch = () => {
    if (inner === mine) return;
    done();
    go();
  };
  // A step back that never lands (no history): the place is opened anyway.
  const net = setTimeout(() => {
    done();
    go();
  }, MOVE_LANDS_MS);
  innerWatchers.add(watch);
  mine.back();
}
