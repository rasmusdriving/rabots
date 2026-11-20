// Ahead needs the calendar (engine 0.42.0, docs/build/step-ahead-setup.md). When Ahead goes from off to
// on and the calendar is not set up, or its last check found a problem, the main bot starts the setup
// with the person: switched on in Settings, it gets a turn by itself in its main chat (like the welcome
// turn); switched on by the main bot's own change_settings, the same words come back in the tool's
// answer, so it goes on in the turn it is in. The trigger is the change itself: a restart, an update or a
// calendar that is fine starts nothing. Followed T3 Code's Codex setup, which starts only on the change
// of its flag (apps/web/src/components/settings/CodexSetupSection.tsx).
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { AheadSettings, Methods } from "../../shared/protocol.js";
import { aheadOn, setAheadSettings } from "./ahead-settings.js";
import { calendarState } from "./calendar-settings.js";
import { guideWords } from "./guides.js";
import { log } from "../log.js";
import { wake } from "./start-helper.js";
import { holdNotice } from "./notes.js";

/** True when the calendar is set up and its last check went well. */
export function calendarReady(eng: Engine): boolean {
  const s = calendarState(eng);
  return s.connected && !s.problem;
}

/** What is wrong with the calendar, for the note: not set up, or the last check's problem. */
function calendarWords(eng: Engine): string {
  const s = calendarState(eng);
  if (!s.connected) return "The calendar is not set up in Pobots yet.";
  return `The calendar is set up, but the last check found a problem: ${s.problem}`;
}

/** The words the main bot gets: why Ahead needs the calendar, and how to set it up with the person. */
export function aheadSetupWords(eng: Engine): string {
  return [
    `Ahead needs the person's calendar: its meetings, free time and to-do blocks come from there. ${calendarWords(eng)} Start the setup with them now, in plain words: say in a sentence or two what Ahead needs and why, then help them set it up.`,
    "Assume they use Microsoft 365 (Outlook), unless About you or this chat says they use Google Calendar. Only when you are unsure, ask one short question: Outlook or Google Calendar? Keep the answer in About you with change_settings about_you, keeping the rest of its text as it is.",
    `Microsoft 365: the calendar works through a flow in their own Power Automate. First ask whether they have Power Automate with premium (the flow starts from an HTTP request, which needs premium). Without premium, Ahead's meetings cannot work: say so plainly, and that they can ask their IT for it. With premium, go through the guide with them. You may build the flow in the browser only if they say yes and watch while you do it. Signing in, approving connections and anything in their company's account are theirs to do. ${guideWords("calendar")}`,
    `Google Calendar: it works through a small script in their own Google account. Go through the guide with them; give them the script's text in the chat when they need it. ${guideWords("google")}`,
    "The address the flow or script gives is a secret: they paste it into Pobots settings, Calendar, themselves. Never ask for it in the chat, and if they paste it in the chat, tell them to put it in settings instead and not to share it again. Give them the steps, never the guide's path on this computer.",
  ].join("\n\n");
}

const SWITCHED = "Note from Pobots: the person switched Ahead on in Pobots settings a moment ago.";

/** The main bot, when there is one. */
function mainBot(eng: Engine): BotRuntime | undefined {
  return [...eng.bots.values()].find((b) => b.folder.file.role === "main");
}

/** "ahead.settings.set", the person's change in Settings: saved, then the setup turn when Ahead went from off to on. */
export function setAheadByPerson(eng: Engine, patch: Methods["ahead.settings.set"]["params"]): AheadSettings {
  const wasOn = aheadOn(eng);
  const ahead = setAheadSettings(eng, patch);
  startAheadSetup(eng, wasOn, ahead.enabled);
  return ahead;
}

/**
 * Ahead went from off to on in Settings: when the calendar is not ready, the main bot gets a turn by
 * itself in its main chat. The note is not shown in the chat; one quiet line before it and the bot's
 * answer are.
 */
function startAheadSetup(eng: Engine, wasOn: boolean, isOn: boolean): void {
  if (wasOn || !isOn || calendarReady(eng)) return;
  const rt = mainBot(eng);
  if (!rt) return;
  // Off and on again quickly: one setup turn waiting is enough.
  if (rt.wakes.some((w) => w.text.startsWith(SWITCHED))) return;
  log.info(`Bot ${rt.folder.id}: Ahead was switched on without a calendar, the setup turn starts`);
  // One quiet line says why the turn starts by itself; held while the bot is working, so it stands
  // right before the turn.
  holdNotice(eng, rt, { text: switchedLine(eng), tone: "info", startsTurn: true });
  wake(eng, rt, { text: `${SWITCHED}\n\n${aheadSetupWords(eng)}`, purpose: { startedBy: "you", threadId: rt.threadId, fresh: false, hops: 0 } });
}

/** The quiet line before the setup turn, in the main chat. */
export function switchedLine(eng: Engine): string {
  return calendarState(eng).connected
    ? "You switched on Ahead. Your calendar has a problem, so fixing it starts here."
    : "You switched on Ahead. Your calendar is not set up yet, so the setup starts here.";
}

/** The main bot switched Ahead on with change_settings: the words for its tool answer, "" when the calendar is ready. */
export function aheadSetupToolWords(eng: Engine): string {
  if (calendarReady(eng)) return "";
  return `\n\nAhead is on now, but it needs the calendar.\n\n${aheadSetupWords(eng)}`;
}
