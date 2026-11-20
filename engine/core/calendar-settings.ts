// The calendar connection (engine 0.25.0, docs/build/step-calendar.md): the flow's address, set once by
// the person in the settings window and never shown back; the mailbox the flow acts for; the internal
// domains. Also the per-bot switch, the paragraph a bot with the switch on is told, and the words the
// main bot's get_settings and get_bot use.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { CalendarState, Methods } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { log } from "../log.js";
import { callFlow } from "./calendar-flow.js";
import { guideWords } from "./guides.js";
import { serviceOf, serviceWords } from "./calendar-service.js";
import { now } from "./words.js";

/** The bot's switch: as set, else on for the main bot and off for the others. */
export function calendarOn(rt: BotRuntime): boolean {
  return rt.folder.file.calendar ?? rt.folder.file.role === "main";
}

/** The flow's address, when it is set. Never leaves the engine. */
export function flowAddress(eng: Engine): string | undefined {
  return eng.store.calendar.settings().address;
}

/** True when the bot has the calendar tools now: its switch is on and the flow is set up. */
export function calendarTools(eng: Engine, rt: BotRuntime): boolean {
  return calendarOn(rt) && !!flowAddress(eng);
}

/** The internal domains: the person's, else the connected mailbox's own domain. */
export function internalDomains(eng: Engine): string[] {
  const s = eng.store.calendar.settings();
  if (s.domains?.length) return s.domains;
  const d = s.mailboxAddress?.split("@")[1]?.toLowerCase();
  return d ? [d] : [];
}

export function isInternal(eng: Engine, address: string): boolean {
  const d = address.split("@")[1]?.toLowerCase();
  if (!d) return false;
  return internalDomains(eng).some((x) => d === x || d.endsWith(`.${x}`));
}

export function calendarState(eng: Engine): CalendarState {
  const s = eng.store.calendar.settings();
  return {
    connected: !!s.address,
    service: serviceOf(s.address),
    ...(s.mailboxAddress ? { mailbox: { address: s.mailboxAddress, ...(s.mailboxName ? { name: s.mailboxName } : {}) } } : {}),
    ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
    ...(s.problem && s.address ? { problem: s.problem } : {}),
    internalDomains: internalDomains(eng),
    domainsSet: !!s.domains?.length,
  };
}

function bad(msg: string): EngineError {
  return new EngineError("bad_request", msg);
}

/** The flow's address, checked: https (or http on this computer, for tries), no user or password. */
export function cleanFlowAddress(raw: string): string {
  const s = raw.trim();
  if (s.length > 2000) throw bad("That address is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad("That is not a web address. It must start with https://.");
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) throw bad("The flow's address must start with https://.");
  if (u.username || u.password) throw bad("The flow's address cannot hold a user name or password.");
  return u.toString();
}

/** A domain such as example.com, lower case. */
export function cleanDomains(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (!d) continue;
    if (d.length > 200 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw bad(`${raw.trim()} is not an email domain. Write it like example.com.`);
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > 20) throw bad("At most 20 domains.");
  return out;
}

/** Asks the flow which mailbox it acts for, and keeps what it said. */
export async function checkConnection(eng: Engine): Promise<CalendarState> {
  const s = eng.store.calendar.settings();
  if (!s.address) return calendarState(eng);
  const a = await callFlow(eng, s.address, "hello");
  if (!eng.store.isOpen) return calendarState(eng);
  const cur = eng.store.calendar.settings();
  // The address may have changed while the flow was asked.
  if (cur.address !== s.address) return calendarState(eng);
  const next = { ...cur, checkedAt: now() };
  if (a.ok) {
    const owner = ownerOf(a.result);
    if (owner) {
      next.mailboxAddress = owner.address;
      if (owner.name) next.mailboxName = owner.name;
      else delete next.mailboxName;
      delete next.problem;
      log.info("Calendar: the flow answered the check");
    } else next.problem = "The flow answered, but did not say which mailbox it acts for. Check its hello case.";
  } else next.problem = a.why;
  eng.store.calendar.saveSettings(next);
  const state = calendarState(eng);
  eng.opts.emit("calendar.changed", { calendar: state });
  return state;
}

/** The owner of the calendar from `GET /me/calendar`: { owner: { name, address } }. */
function ownerOf(result: unknown): { name?: string; address: string } | undefined {
  const o = result && typeof result === "object" ? (result as { owner?: { name?: unknown; address?: unknown } }).owner : undefined;
  const address = typeof o?.address === "string" ? o.address.trim().toLowerCase() : "";
  if (!address.includes("@") || address.length > 320) return undefined;
  const name = typeof o?.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : undefined;
  return { address, ...(name ? { name } : {}) };
}

/** The mailbox, asked of the flow when it is not known yet. Undefined when the flow cannot say. */
export async function ensureMailbox(eng: Engine): Promise<string | undefined> {
  const s = eng.store.calendar.settings();
  if (s.mailboxAddress) return s.mailboxAddress;
  await checkConnection(eng);
  return eng.store.calendar.settings().mailboxAddress;
}

/**
 * The main bot's change_settings calendar_internal_domains: the internal domains, at once ([] back to
 * the mailbox's). A line for the person's note, or undefined when nothing changed.
 */
export function setInternalDomains(eng: Engine, list: string[]): string | undefined {
  const cur = eng.store.calendar.settings();
  const was = internalDomains(eng);
  const d = cleanDomains(list);
  const next = { ...cur };
  if (d.length) next.domains = d;
  else delete next.domains;
  if ((cur.domains ?? []).join(",") === (next.domains ?? []).join(",")) return undefined;
  eng.store.calendar.saveSettings(next);
  eng.opts.emit("calendar.changed", { calendar: calendarState(eng) });
  const now = internalDomains(eng);
  const words = (x: string[]) => (x.length ? x.join(", ") : "none");
  return `calendar, inside the company: ${words(now)}${d.length ? "" : " (the mailbox's)"} (was ${words(was)})`;
}

/** "calendar.set": the address ("" removes it) and the domains ([] back to the mailbox's). */
export async function setCalendar(eng: Engine, params: Methods["calendar.set"]["params"]): Promise<Methods["calendar.set"]["result"]> {
  const cur = eng.store.calendar.settings();
  const next = { ...cur };
  let addressChanged = false;
  if (params.address !== undefined) {
    const raw = params.address.trim();
    if (!raw) {
      if (cur.address) addressChanged = true;
      delete next.address;
      delete next.mailboxAddress;
      delete next.mailboxName;
      delete next.checkedAt;
      delete next.problem;
    } else {
      const clean = cleanFlowAddress(raw);
      if (clean !== cur.address) {
        addressChanged = true;
        next.address = clean;
        delete next.mailboxAddress;
        delete next.mailboxName;
        delete next.checkedAt;
        delete next.problem;
      }
    }
  }
  if (params.internalDomains !== undefined) {
    const d = cleanDomains(params.internalDomains);
    if (d.length) next.domains = d;
    else delete next.domains;
  }
  eng.store.calendar.saveSettings(next);
  if (addressChanged) {
    log.info(next.address ? "Calendar: the flow's address was set" : "Calendar: the flow's address was removed");
    // The tools come or go for every bot with the switch on: their sessions start again between turns.
    for (const rt of eng.bots.values()) if (calendarOn(rt)) eng.refreshSession(rt);
  }
  eng.opts.emit("calendar.changed", { calendar: calendarState(eng) });
  if (addressChanged && next.address) return { calendar: await checkConnection(eng) };
  return { calendar: calendarState(eng) };
}

/** What a bot with the switch on is told. Empty for a bot with it off. */
export function calendarPrompt(eng: Engine, rt: BotRuntime): string {
  if (!calendarOn(rt)) return "";
  if (!flowAddress(eng))
    return `Calendar: you may work on the person's Outlook calendar, but the connection is not set up yet, so you have no calendar tools. When the person asks for something in their calendar, tell them they set it up in Pobots settings, under Calendar, with a flow in their own Power Automate (Microsoft 365), or a script in their own Google account (Google Calendar). ${guideWords("calendar")} ${guideWords("google")}`;
  const w = serviceWords(serviceOf(flowAddress(eng)));
  return [
    `Calendar: you can work on the person's own ${w.cal} calendar with calendar_list (what is in it), calendar_free_times (when internal people are free), calendar_create, calendar_move, calendar_cancel and calendar_respond (answer an invitation).`,
    w.guide === "google" ? "Every meeting with others gets a Google Meet link; the tools ask for it." : "Every meeting is a Teams meeting; the tools add the link.",
    "People inside the company are checked to be free before a meeting is made or moved (the tools do it, and refuse a time when someone is busy, with free times to pick from). People outside the company are not checked: use the time agreed with them.",
    "Every meeting with other people, and every answer to an invitation, goes on the person's card first and only happens when they approve. A block in their own calendar with nobody else needs no card.",
    `Times are in ${eng.tz} unless they carry an offset. Never say a meeting is booked, moved or cancelled before the tool says it was.`,
  ].join(" ");
}

/** One line for the main bot's get_settings. */
export function calendarSettingsWords(eng: Engine): string {
  const s = calendarState(eng);
  if (!s.connected) return `Calendar: not set up. The person sets the flow's address in the app (Pobots settings, Calendar); you cannot. Microsoft 365: ${guideWords("calendar")} Google Calendar: ${guideWords("google")}`;
  const box = s.mailbox ? `acts for ${s.mailbox.name ? `${s.mailbox.name} (${s.mailbox.address})` : s.mailbox.address}` : "has not said which mailbox it acts for yet";
  const domains = s.internalDomains.length ? `Internal domains: ${s.internalDomains.join(", ")}${s.domainsSet ? "" : " (from the mailbox)"} (change_settings calendar_internal_domains).` : "No internal domains yet (change_settings calendar_internal_domains sets them).";
  const w = serviceWords(s.service);
  return `Calendar: set up${w.guide === "google" ? " (Google Calendar, through a script)" : ""}, the ${w.flow} ${box}.${s.problem ? ` Last check: ${s.problem} ${guideWords(w.guide)}` : ""} ${domains} Only the person sets or removes the address. A bot uses the calendar tools when its Calendar switch is on (update_bot calendar).`;
}

/** One line for get_bot. */
export function calendarBotWords(eng: Engine, rt: BotRuntime): string {
  const on = calendarOn(rt);
  return `Calendar tools: ${on ? "on" : "off"}${on && !flowAddress(eng) ? ` (the connection is not set up yet, so it has no calendar tools). ${guideWords("calendar")}` : "."}`;
}
