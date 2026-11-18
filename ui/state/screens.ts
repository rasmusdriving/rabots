// The screens of the phone layout (docs/build/step-phone.md, decided 3): Bots, a bot (or a channel),
// Needs you, and the full-screen sheets over them: the bot's page, an artifact, the browser and
// Pobots settings. On a phone each one is a history entry, so the back control, the browser's back,
// Android's back gesture and the iOS edge swipe all do the same thing, and a reload keeps the screen.
//
// What a history entry shows is a "view", kept in history.state under VIEW_KEY beside the helper
// threads' stacks (store.ts, historyStateWith) and the layers of builder B's lib/phone-back.ts (a
// picture opened large, the model picker, a dialog). Each keeps its own key and carries the others
// over unchanged.
//
// - Going somewhere new (a bot, Needs you, the page, an artifact, the browser, settings) pushes an
//   entry: the store changes, and sync() sees a view deeper than the entry's or beside it.
// - A back control calls phoneBack(): the browser's back when the entry below is where it leads, so
//   the two never disagree; popstate then shows the entry below.
// - Changing the page's tab replaces the entry: back from any tab goes to the chat.
// On the laptop none of this runs: no entry is pushed or rewritten, the helper threads work as before.
import { useSyncExternalStore } from "react";
import { isPhone, PHONE_QUERY } from "../lib/phone";
import { afterMove, holdForMove, LAYER_STATE_KEY, layersOf, moveLanded, MOVE_LANDS_MS } from "../lib/phone-back";
import { BEFORE_KEY, deeper, depth, depthIn, DEPTH_KEY, parentOf, sameView, viewIn, VIEW_KEY, type PhoneScreen, type PhoneView } from "./phone-view";
import { historyStateWith, store, withAppSettingsMark, type AppState, type HelperStacks, type Panel } from "./store";

/** What shows now, as the store holds it. */
export function viewOf(s: AppState): PhoneView {
  const v: PhoneView = { screen: s.phoneScreen };
  if (s.phoneScreen === "bot") {
    if (s.openChannelId) v.channel = s.openChannelId;
    else if (s.openBotId) {
      v.bot = s.openBotId;
      const tab = s.tabs[s.openBotId] ?? "chat";
      if (tab !== "chat") v.tab = tab;
    }
  }
  const p = s.panel;
  if (p?.kind === "browser") v.panel = { kind: "browser", id: p.spaceId };
  else if (p?.kind === "artifact" && v.bot && p.botId === v.bot) v.panel = { kind: "artifact", bot: p.botId, id: p.artifactId };
  if (s.appSettings) v.settings = true;
  return v;
}

/** The panel a view asks for, as the store holds panels. `full` is kept from what is open now. */
function panelOf(v: PhoneView, now: Panel | null): Panel | null {
  if (!v.panel) return null;
  if (v.panel.kind === "browser") return { kind: "browser", spaceId: v.panel.id, full: now?.full ?? false };
  return { kind: "artifact", botId: v.panel.bot, artifactId: v.panel.id, full: now?.full ?? false };
}

// ------------------------------------------------------------ the entry now and the one below

/** The view of the history entry the window is on, and of the entry below it (null when unknown or none). */
let entry: { view: PhoneView | null; before: PhoneView | null } = { view: null, before: null };
const watchers = new Set<() => void>();
function setEntry(view: PhoneView | null, before: PhoneView | null): void {
  if (sameView(entry.view, view) && (sameView(entry.before, before) || (!entry.before && !before))) return;
  entry = { view, before };
  for (const w of watchers) w();
}

/** Where the back control leads now: the entry below, or the parent of what shows. */
export function backTarget(): PhoneView {
  const now = entry.view ?? viewOf(store.get());
  return entry.before ?? parentOf(now);
}

/** Where the back control leads, for its words. Changes when the window moves through history. */
export function useBackTarget(): PhoneView {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => entry.before ?? parentCache(),
  );
}
// useSyncExternalStore needs the same object while nothing changed.
let parentMemo: { of: PhoneView | null; parent: PhoneView } = { of: null, parent: { screen: "bots" } };
function parentCache(): PhoneView {
  if (parentMemo.of !== entry.view) parentMemo = { of: entry.view, parent: parentOf(entry.view ?? { screen: "bots" }) };
  return parentMemo.parent;
}

function stateNow(): Record<string, unknown> {
  try {
    return history.state && typeof history.state === "object" ? (history.state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A new entry for this view: the helper threads as they are now, no picture or dialog layer. */
function entryState(view: PhoneView, before: PhoneView | null): Record<string, unknown> {
  const { pobotsLayers: _layers, ...rest } = { ...stateNow(), ...historyStateWith(store.get().helpers) } as Record<string, unknown>;
  return { ...rest, [VIEW_KEY]: view, [BEFORE_KEY]: before };
}

function push(view: PhoneView, before: PhoneView | null): void {
  try {
    history.pushState(deeper(entryState(view, before), history.state), "");
  } catch {
    // Without history the back control still works; only the browser's own back does not.
  }
  setEntry(view, before);
}

/** `first`: the entry the phone starts on, so it stands at depth 0. */
function replace(view: PhoneView, before: PhoneView | null, first = false): void {
  try {
    const state = entryState(view, before);
    if (first) delete state[DEPTH_KEY];
    history.replaceState(state, "");
  } catch {
    // As above.
  }
  setEntry(view, before);
}

// ------------------------------------------------------------ following the store and history

let applying = false;

/** Shows a view: the screen, the bot or channel, the page's tab, the panel and settings, in one change. */
function apply(v: PhoneView): void {
  applying = true;
  try {
    const s = store.get();
    const bot = v.bot && s.bots.some((b) => b.id === v.bot) ? v.bot : undefined;
    const channel = v.channel && s.channels.some((c) => c.id === v.channel) ? v.channel : undefined;
    const screen = v.screen === "bot" && !bot && !channel ? "bots" : v.screen;
    store.showPhoneView({ screen, bot, channel, tab: bot ? (v.tab ?? "chat") : undefined, settings: !!v.settings });
    store.setPanel(panelOf(v, s.panel));
  } finally {
    applying = false;
  }
}

/** Keeps the history entry in step with what shows. Runs on every change of the store, on a phone only. */
function sync(): void {
  // (While the window steps back over a phone's entries, the entry it lands on is made what shows when it lands.)
  if (applying || leaving || !isPhone()) return;
  const s = store.get();
  if (!s.ready) return;
  const v = viewOf(s);
  const now = entry.view;
  if (!now) return replace(v, null);
  if (sameView(v, now)) return;
  // The bot of this screen is gone (retired): Bots, in place of the entry.
  if (now.bot && !s.bots.some((b) => b.id === now.bot) && v.screen === "bot") {
    store.showPhoneView({ screen: "bots", settings: s.appSettings });
    return;
  }
  // A layer of builder B (a dialog, say) is the newest entry and is being left for somewhere new:
  // that entry becomes the new place, so going back does not land on a layer that is gone.
  if (layersOf(history.state).length) return replace(v, now);
  // Another tab of the page: the same entry.
  if (v.tab && now.tab && sameView({ ...v, tab: undefined }, { ...now, tab: undefined })) return replace(v, entry.before);
  if (depth(v) < depth(now)) {
    // Something closed by itself (an artifact removed, a bot opened from a card): back when that is
    // the entry below, so history and the screen still agree; otherwise this entry shows it.
    if (entry.before && sameView(v, entry.before)) {
      setEntry(v, null);
      try {
        history.back();
      } catch {
        replace(v, null);
      }
      return;
    }
    return replace(v, entry.before);
  }
  push(v, now);
}

/** After a picture, picker or dialog layer has gone from history (its own back), runs `go`. */
function afterLayers(go: () => void): void {
  let tries = 0;
  const look = () => {
    if (!layersOf(history.state).length || tries++ > 30) return go();
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * The phone's back control: one step back, the same as the browser's back. With unsaved text in an
 * editor it asks first. Without an entry below (the first screen after a reload into a bot, say), it
 * shows where back leads in place of this entry.
 */
export function phoneBack(): void {
  store.leave(() =>
    afterLayers(() => {
      const target = backTarget();
      if (entry.before) {
        try {
          history.back();
          return;
        } catch {
          // Fall through: shown here.
        }
      }
      apply(target);
      replace(target, null);
    }),
  );
}

/** Opens a screen on a phone by a change of the store; sync() pushes its entry. */
export function phoneOpen(screen: PhoneScreen): void {
  store.setPhoneScreen(screen);
}

/** Makes several changes of the store count as one step of history (the panel closed and Needs you opened, say). */
export function phoneGo(change: () => void): void {
  applying = true;
  try {
    change();
  } finally {
    applying = false;
  }
  sync();
}

// ------------------------------------------------------------ when the window stops being a phone
// A window that was a phone and is widened (or a tablet turned) goes on as the laptop, with what
// shows as it is. The phone's own entries mean nothing to the laptop, so the window steps back over
// them at once, to the entry the phone started on, and that entry is made what the laptop keeps:
// the helper threads as they show (the open bot's as entries of their own, as the laptop makes
// them) and the settings mark as Pobots settings shows. The laptop's Back then goes somewhere, and
// no helper thread changes behind his back (docs/build/notes-phone-review-fixes.md, points 3 and 4).

/** Set while the window steps back over the phone's entries. */
let leaving = false;
/** Lands the step back without its popstate if that never comes (lib/phone-back.ts, MOVE_LANDS_MS). */
let leavingNet: ReturnType<typeof setTimeout> | undefined;

/** True for a history change the laptop must not act on: the window stepping back over a phone's own entries. */
export function phoneEntriesLeaving(state: unknown): boolean {
  return leaving || (!isPhone() && depthIn(state) > 0);
}

function leavePhone(): void {
  // Already stepping back (the window became a phone and the laptop again before it landed): that
  // move settles on what the window is when it lands.
  if (leaving) return;
  const steps = depthIn(stateNow());
  // (An entry counting more steps than there are entries was carried over somehow: settled in place.)
  if (steps > 0 && steps < history.length) {
    leaving = true;
    // A layer that opens before the move lands adds its entry after it (lib/phone-back.ts).
    holdForMove();
    leavingNet = setTimeout(() => leaving && landed(), MOVE_LANDS_MS);
    try {
      history.go(-steps);
      return;
    } catch {
      clearTimeout(leavingNet);
      leaving = false;
      moveLanded();
    }
  }
  settleOnLaptop();
}

/** The step back over the phone's entries has landed: the entry it is on is made what shows. */
function landed(): void {
  clearTimeout(leavingNet);
  leaving = false;
  // Back where the phone started. A window that became a phone again meanwhile starts here anew,
  // and a layer that opened meanwhile adds its entry over this one now.
  if (!isPhone()) settleOnLaptop();
  else replace(viewOf(store.get()), null, true);
  moveLanded();
}

/** Makes the entry the window is on what the laptop keeps for what shows now. */
function settleOnLaptop(): void {
  const s = store.get();
  const { [VIEW_KEY]: _view, [BEFORE_KEY]: _before, [DEPTH_KEY]: _depth, [LAYER_STATE_KEY]: _layers, ...rest } = stateNow();
  const bot = s.openBotId;
  const stack = bot ? (s.helpers[bot] ?? []) : [];
  const under: HelperStacks = { ...s.helpers };
  if (bot) delete under[bot];
  try {
    history.replaceState(withAppSettingsMark(rest, s.appSettings), "");
    history.replaceState(historyStateWith(under), "");
    let below = under;
    for (let i = 1; i <= stack.length; i++) {
      const next: HelperStacks = { ...under, [bot!]: stack.slice(0, i) };
      history.pushState(historyStateWith(next, below), "");
      below = next;
    }
  } catch {
    // Without history there is nothing to keep.
  }
  setEntry(null, null);
}

function onPop(e: PopStateEvent): void {
  if (leaving) return landed();
  if (!isPhone()) {
    // The laptop's forward button onto a phone's entry: straight back to where the laptop goes on.
    if (depthIn(e.state) > 0) leavePhone();
    return;
  }
  const v = viewIn(e.state);
  if (!v) {
    // An entry from before the phone layout started: it shows what shows, and is kept as that.
    replace(viewOf(store.get()), null);
    return;
  }
  const before = viewIn(e.state, BEFORE_KEY);
  const now = viewOf(store.get());
  if (sameView(v, now)) return setEntry(v, before);
  // Unsaved text in an editor: the entry that was left is put back on top, and going on asks first.
  // It stands one deeper than the entry under it, as it did, so widening steps back over it too.
  if (store.get().unsaved && !layersOf(e.state).length) {
    try {
      history.pushState(deeper(entryState(now, v), e.state), "");
    } catch {
      // Without history it simply goes.
    }
    setEntry(now, v);
    store.leave(() => phoneBack());
    return;
  }
  apply(v);
  setEntry(v, before);
}

let started = false;

/** Starts the screens: called once when the window connects to its engine. */
export function startScreens(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // A reload on a phone with a layer open steps back over the layers first (lib/phone-back.ts): the
  // screens start on the entry that lands on, and that popstate is not theirs.
  afterMove(begin);
}

function begin(): void {
  window.addEventListener("popstate", onPop);
  store.subscribe(sync);
  // A window that becomes a phone (a narrowed window, a turned tablet) goes on with what it showed.
  window.matchMedia?.(PHONE_QUERY).addEventListener("change", (e) => {
    if (!e.matches) return leavePhone();
    store.setPhoneScreen(store.get().ready ? "bot" : "bots");
    // Still stepping back over the phone's entries from before: the entry it lands on is this one's.
    if (leaving) return;
    replace(viewOf(store.get()), null, true);
  });
  if (!isPhone()) {
    // Opened as a laptop on an entry a phone made (it was a phone when it reloaded, say): as above.
    if (depthIn(stateNow()) > 0 || viewIn(stateNow())) leavePhone();
    return;
  }
  const v = viewIn(stateNow());
  if (v) setEntry(v, viewIn(stateNow(), BEFORE_KEY));
  else replace(viewOf(store.get()), null);
}
