// What a phone's history entry shows (docs/build/step-phone.md): a "view", kept in history.state.
// Plain data and small pure functions, so the store can read the entry a reload opens on without
// depending on state/screens.ts, which follows the store.
import type { BotTab } from "./store";

/** The screen a phone shows: the bots, a bot's chat (or a channel's page), or what needs you. */
export type PhoneScreen = "bots" | "bot" | "needs";

export interface PhoneView {
  screen: PhoneScreen;
  /** The bot whose chat (or page) shows, on the "bot" screen. */
  bot?: string;
  /** The channel whose page shows, on the "bot" screen. */
  channel?: string;
  /** The page's tab, when the bot's page is open (never "chat"). */
  tab?: Exclude<BotTab, "chat">;
  /** What the panel shows as a sheet: an artifact of the open bot, or the browser. */
  panel?: { kind: "artifact"; bot: string; id: string } | { kind: "browser"; id: string };
  /** Pobots settings as a sheet over everything. */
  settings?: true;
}


export const VIEW_KEY = "pobotsPhone";
export const BEFORE_KEY = "pobotsPhoneBefore";

/**
 * How many entries a phone's history entry stands above the entry the phone layout started on: 0
 * (or none) there, one more for every entry pushed on a phone (a screen, a helper's thread, a
 * picture, the picker or a dialog). When the window stops being a phone, that many steps back is
 * where the laptop goes on from (state/screens.ts). Never written on the laptop.
 */
export const DEPTH_KEY = "pobotsPhoneDepth";

/** How many entries above the phone's first entry a history state stands. */
export function depthIn(state: unknown): number {
  const raw = state && typeof state === "object" ? (state as Record<string, unknown>)[DEPTH_KEY] : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/** A state for an entry pushed on a phone over the entry whose state is `below`: one step deeper. */
export function deeper(next: Record<string, unknown>, below: unknown): Record<string, unknown> {
  return { ...next, [DEPTH_KEY]: depthIn(below) + 1 };
}

const TABS: BotTab[] = ["job", "files", "artifacts", "triggers", "history", "settings"];

/** The view kept in a history state, or null when the entry has none. */
export function viewIn(state: unknown, key = VIEW_KEY): PhoneView | null {
  const raw = state && typeof state === "object" ? (state as Record<string, unknown>)[key] : undefined;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.screen !== "bots" && r.screen !== "bot" && r.screen !== "needs") return null;
  const v: PhoneView = { screen: r.screen };
  if (typeof r.bot === "string") v.bot = r.bot;
  if (typeof r.channel === "string") v.channel = r.channel;
  if (typeof r.tab === "string" && TABS.includes(r.tab as BotTab)) v.tab = r.tab as PhoneView["tab"];
  const p = r.panel as Record<string, unknown> | undefined;
  if (p && p.kind === "browser" && typeof p.id === "string") v.panel = { kind: "browser", id: p.id };
  else if (p && p.kind === "artifact" && typeof p.id === "string" && typeof p.bot === "string") v.panel = { kind: "artifact", bot: p.bot, id: p.id };
  if (r.settings === true) v.settings = true;
  return v;
}

export const sameView = (a: PhoneView | null | undefined, b: PhoneView | null | undefined): boolean => !!a && !!b && JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const norm = (v: PhoneView) => [v.screen, v.bot ?? "", v.channel ?? "", v.tab ?? "", v.panel ? `${v.panel.kind}:${v.panel.id}` : "", v.settings ? 1 : 0];

/** How many layers deep a view is: the screen, then the page, the panel and settings over it. */
export const depth = (v: PhoneView) => (v.screen === "bots" ? 0 : 1) + (v.tab ? 1 : 0) + (v.panel ? 1 : 0) + (v.settings ? 1 : 0);

/** Where back leads when there is no entry below to go back to: the top layer taken off. */
export function parentOf(v: PhoneView): PhoneView {
  if (v.settings) return { ...v, settings: undefined };
  if (v.panel) return { ...v, panel: undefined };
  if (v.tab) return { ...v, tab: undefined };
  return { screen: "bots" };
}

