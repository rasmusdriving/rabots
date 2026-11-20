// The way back on a phone (docs/build/step-phone.md): a chevron and the name of where it leads,
// 44 px to tap, at the start of every screen's head. It does what the browser's back does, so the
// back gesture and this control never disagree (state/screens.ts).
import { forwardRef } from "react";
import type { PhoneView } from "../state/phone-view";
import { useInner } from "../lib/phone-back";
import { phoneBack, useBackTarget } from "../state/screens";
import { AHEAD_PAGE, useAppState, type AppState } from "../state/store";
import { BackIcon } from "./bits";

/** The name of a place in a view, for the way back to it. The top layer names it. */
export function placeName(v: PhoneView, s: Pick<AppState, "bots" | "channels">): string {
  if (v.settings) return "Pobots settings";
  if (v.panel) return v.panel.kind === "browser" ? "Browser" : "Artifact";
  if (v.tab) return "Page";
  if (v.screen === "needs") return "Needs you";
  if (v.screen === "bot" && v.channel === AHEAD_PAGE) return "Ahead";
  if (v.screen === "bot") return (v.channel ? s.channels.find((c) => c.id === v.channel)?.name : s.bots.find((b) => b.id === v.bot)?.name) || "Bots";
  return "Bots";
}

/** `label` names the way back when the place has a word of its own ("Chat" from the bot's page). */
export const PhoneBack = forwardRef<HTMLButtonElement, { label?: string; className?: string; hidden?: boolean }>(function PhoneBack({ label, className, hidden }, ref) {
  const target = useBackTarget();
  const bots = useAppState((s) => s.bots);
  const channels = useAppState((s) => s.channels);
  // Something open inside the screen (a file in Files) is the first step back, and names it.
  const inner = useInner();
  const name = inner?.name ?? label ?? placeName(target, { bots, channels });
  return (
    <button
      ref={ref}
      type="button"
      className={`pb-helper-back app-phone-back${className ? ` ${className}` : ""}`}
      aria-label={`Back to ${name}`}
      data-gone={hidden || undefined}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      onClick={() => !hidden && (inner ? inner.back() : phoneBack())}
    >
      <BackIcon />
      <span className="pb-helper-back-name">{name}</span>
    </button>
  );
});
