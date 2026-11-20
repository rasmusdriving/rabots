// Which calendar the address leads to (engine 0.42.0, docs/build/step-ahead-setup.md): the person's
// Outlook through a Power Automate flow, or their Google Calendar through an Apps Script web app
// (docs/guides/google-calendar.md). Both answer the same contract; only the words differ. Known from the
// address alone: a Google script's address is on script.google.com, under /macros/s/. For Outlook every
// word is as it was before.
import type { CalendarService } from "../../shared/protocol.js";

export function serviceOf(address: string | undefined): CalendarService {
  if (!address) return "outlook";
  try {
    const u = new URL(address);
    if (u.hostname === "script.google.com") return "google";
    // A stand-in script on this computer, for tests: the same path as Google's.
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname.startsWith("/macros/s/")) return "google";
  } catch {
    // Not an address: Outlook's words.
  }
  return "outlook";
}

export interface ServiceWords {
  /** The calendar: "Outlook" or "Google Calendar". */
  cal: string;
  /** What carries the calls: "flow" or "script". */
  flow: string;
  /** Where the person fixes it: "Power Automate" or "Apps Script". */
  home: string;
  /** Where its runs are listed: "run history" or "executions". */
  history: string;
  /** The online meeting: "Teams" or "Google Meet". */
  meet: string;
  /** Which guide a bot is pointed to. */
  guide: "calendar" | "google";
}

export function serviceWords(service: CalendarService): ServiceWords {
  return service === "google"
    ? { cal: "Google Calendar", flow: "script", home: "Apps Script", history: "executions", meet: "Google Meet", guide: "google" }
    : { cal: "Outlook", flow: "flow", home: "Power Automate", history: "run history", meet: "Teams", guide: "calendar" };
}
