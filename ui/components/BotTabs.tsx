// A bot's page tabs: Chat, Job, Files, Artifacts, Triggers, History, Settings. On a phone the row is
// wider than the screen and scrolls sideways inside itself (fix 0.26.3): the open tab is always
// brought into view, and the edge fades softly on the side where more tabs are, so Settings at the
// far end can be found. The fade is a mask only, so nothing moves.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Bot } from "../../shared/protocol";
import { afterInner } from "../lib/phone-back";
import { BOT_TABS, store, type BotTab } from "../state/store";

/** Quiet text tabs. Arrow keys move between them; leaving unsaved text asks first. */
export function BotTabs({ bot, tab, panelId }: { bot: Bot; tab: BotTab; panelId: string }) {
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = () => {
    const el = list.current;
    if (!el) return;
    // Only a row that scrolls (a phone) fades; one that does not scroll is never masked.
    const scrolls = /auto|scroll/.test(getComputedStyle(el).overflowX);
    const overflow = scrolls && el.scrollWidth > el.clientWidth + 1;
    const start = overflow && el.scrollLeft > 1;
    const end = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((now) => (now.start === start && now.end === end ? now : { start, end }));
  };
  // The open tab in view: on opening the page at once, after a change only as far as needed. The
  // row's own scroll only; scrollIntoView would move the page too.
  const shown = useRef(false);
  useLayoutEffect(() => {
    const el = list.current;
    const on = el?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (el && on && el.scrollWidth > el.clientWidth + 1) {
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
      const box = el.getBoundingClientRect();
      const at = on.getBoundingClientRect();
      const left = el.scrollLeft + at.left - box.left - pad;
      const right = el.scrollLeft + at.right - box.left + pad - el.clientWidth;
      const to = el.scrollLeft > left ? left : el.scrollLeft < right ? right : el.scrollLeft;
      if (to !== el.scrollLeft) {
        const calm = shown.current && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollTo({ left: Math.max(0, to), behavior: calm ? "smooth" : "auto" });
      }
    }
    shown.current = true;
    measure();
  }, [tab]);
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const go = (next: BotTab) => {
    // (On a phone a file open in Files is closed first, as a step back: lib/phone-back.ts.)
    if (next !== tab) store.leave(() => afterInner(() => store.setTab(bot.id, next)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = BOT_TABS.findIndex((t) => t.id === tab);
    const to =
      e.key === "ArrowRight" ? (at + 1) % BOT_TABS.length : e.key === "ArrowLeft" ? (at - 1 + BOT_TABS.length) % BOT_TABS.length : e.key === "Home" ? 0 : e.key === "End" ? BOT_TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = BOT_TABS[to]!.id;
    go(next);
    // Focus follows once the tab is open (it may wait for "Leave without saving").
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab="${store.get().tabs[bot.id] ?? "chat"}"]`)?.focus({ preventScroll: true }));
  };
  return (
    <div className="pb-tabs app-tabs" role="tablist" aria-label={`${bot.name}'s page`} ref={list} onKeyDown={onKeyDown} onScroll={measure} data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
      {BOT_TABS.map((t) => (
        <button
          key={t.id}
          id={`tab-${bot.id}-${t.id}`}
          className="pb-tab"
          type="button"
          role="tab"
          data-tab={t.id}
          aria-selected={t.id === tab}
          aria-controls={t.id === tab ? panelId : undefined}
          tabIndex={t.id === tab ? 0 : -1}
          onClick={() => go(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
