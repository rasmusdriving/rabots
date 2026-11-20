// Ahead needs the calendar (protocol 33, docs/build/step-ahead-setup.md): while Ahead is on and the
// calendar is not set up, or its last check found a problem, one calm line above the days says so, with
// the way to the main bot's chat (it sets it up with the person) and to Settings, Calendar. Followed T3
// Code's ProviderStatusBanner (apps/web/src/components/chat/ProviderStatusBanner.tsx): derived from the
// state, one action to the setup.
//
// Nothing jumps: whether the line shows is decided when the page opens. One that would come while the
// person looks waits for their next visit; one that is no longer needed keeps its box and says the
// calendar is set up, until they leave the screen.
import { useLayoutEffect, useRef, useState } from "react";
import type { CalendarState } from "../../../shared/protocol";
import { store, useAppState } from "../../state/store";

/** True when Ahead is on and the calendar is not ready. */
export function calendarNeeded(on: boolean, cal: CalendarState | null): boolean {
  return on && !!cal && (!cal.connected || !!cal.problem);
}

export function AheadCalendarLine() {
  const on = useAppState((s) => !!s.ahead?.enabled);
  const cal = useAppState((s) => s.calendar);
  const mainId = useAppState((s) => s.bots.find((b) => b.role === "main")?.id);
  const needed = calendarNeeded(on, cal);
  const [shown] = useState(needed);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  // The box keeps its first height, so shorter words after the setup move nothing under it.
  useLayoutEffect(() => {
    if (shown && box.current && height === undefined) setHeight(box.current.offsetHeight);
  }, [shown, height]);
  if (!shown) return null;
  const words = !needed
    ? "Your calendar is set up. Meetings and free time show on Ahead from now on."
    : cal?.connected
      ? "Your calendar has a problem, so Ahead shows no meetings or free time. The main bot can help you fix it."
      : "Your calendar is not set up, so Ahead shows no meetings or free time. The main bot can set it up with you.";
  return (
    <div ref={box} className="pb-ahead-setup" data-ahead-setup={!needed ? "ready" : cal?.connected ? "problem" : "not-set"} role="status" style={height ? { minHeight: height } : undefined}>
      <span className="pb-hint">{words}</span>
      <span className="pb-ahead-setup-actions" hidden={!needed || undefined}>
        {mainId && (
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" data-ahead-setup-action="bot" onClick={() => store.openBot(mainId)}>
            Ask the main bot
          </button>
        )}
        <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" data-ahead-setup-action="settings" onClick={() => store.openAppSettings("calendar")}>
          Calendar settings
        </button>
      </span>
    </div>
  );
}
