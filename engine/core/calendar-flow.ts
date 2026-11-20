// The calendar flow's client (engine 0.25.0, docs/build/step-calendar-flow.md). One POST to the flow's
// address with `{ action, ...fields }`; the flow calls Microsoft Graph on the person's own mailbox and
// answers `{ ok: true, result }`, or 502 with `{ ok: false, graphStatus, message }` when Graph said no.
// Never retried: a create that timed out may be in the calendar already. The address is a secret: it
// is never logged, never in an answer, never in a line in the chat.
//
// Engine 0.42.0: the same contract through a Google Apps Script web app (docs/guides/google-calendar.md).
// Apps Script answers every call with status 200, after one redirect to script.googleusercontent.com, so
// that one redirect is followed (by GET, as browsers do), and `{ ok: false, graphStatus }` is read in a
// 200 too. A Google script also gets the engine's time zone by its IANA name (`timeZone`), since the
// times Pobots sends carry Outlook's zone names; the Power Automate flow is sent exactly what it was.
import type { Engine } from "../engine.js";
import { log } from "../log.js";
import { serviceOf, serviceWords, type ServiceWords } from "./calendar-service.js";

export type FlowAction = "hello" | "list" | "get" | "create" | "move" | "cancel" | "delete" | "respond" | "schedule";

/** What the flow answered: Graph's body, or what went wrong for the bot (`why`) and the chat line (`line`). */
export type FlowAnswer =
  | { ok: true; result: unknown }
  | {
      ok: false;
      why: string;
      line: string;
      /** No answer in time: a change may have happened. */
      maybeDone?: boolean;
      /** Graph said the meeting is not there. */
      gone?: boolean;
      /** The flow or its connection needs the person's hand: a bot is pointed to the calendar guide. */
      setup?: boolean;
    };

/** How long Pobots waits for the flow. Power Automate can take some seconds to start. */
export const CALENDAR_TIMEOUT_MS = 30_000;
/** The most of an answer Pobots reads. */
const ANSWER_MAX = 2_000_000;

const WRITES: FlowAction[] = ["create", "move", "cancel", "delete", "respond"];

export function flowTimeoutMs(eng: Engine): number {
  return eng.opts.timings?.calendarTimeoutMs ?? CALENDAR_TIMEOUT_MS;
}

/** Calls the flow once. `address` comes from the store and goes nowhere else. */
export async function callFlow(eng: Engine, address: string, action: FlowAction, fields: Record<string, unknown> = {}): Promise<FlowAnswer> {
  const write = WRITES.includes(action);
  const ms = flowTimeoutMs(eng);
  const service = serviceOf(address);
  const w = serviceWords(service);
  const signal = AbortSignal.timeout(ms);
  try {
    let res = await fetch(address, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...fields, ...(service === "google" ? { timeZone: eng.tz } : {}) }),
      redirect: "manual",
      signal,
    });
    const next = scriptRedirect(address, res);
    if (next) {
      await res.body?.cancel().catch(() => undefined);
      res = await fetch(next, { method: "GET", redirect: "manual", signal });
    }
    const text = await readCapped(res);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (res.status >= 200 && res.status < 300) {
      if (b.ok === true) return { ok: true, result: b.result };
      // A Google script says Google's no in a 200, in the flow's shape.
      if (b.ok === false && typeof b.graphStatus === "number") {
        log.warn(`Calendar: the ${w.flow} answered ${action}: ${w.cal} ${b.graphStatus}`);
        return graphProblem(b.graphStatus, typeof b.message === "string" ? b.message : "", write, w);
      }
      log.warn(`Calendar: the ${w.flow} answered ${action} in a shape Pobots does not know`);
      return {
        ok: false,
        why: `The calendar ${w.flow} answered in a way Pobots does not know, so it is not clear what happened. The person compares the ${w.flow} with the calendar setup guide.`,
        line: `the ${w.flow} answered in a way Pobots does not know`,
        setup: true,
        ...(write ? { maybeDone: true } : {}),
      };
    }
    log.warn(`Calendar: the ${w.flow} answered ${action} with status ${res.status}${typeof b.graphStatus === "number" ? ` (${w.cal} ${b.graphStatus})` : ""}`);
    if (res.status === 502 && typeof b.graphStatus === "number") return graphProblem(b.graphStatus, typeof b.message === "string" ? b.message : "", write, w);
    if (res.status === 400) {
      return {
        ok: false,
        why: `The calendar ${w.flow} refused it (status 400). It likely has no case for "${action}" yet, so the person needs to update the ${w.flow} in ${w.home}. Nothing was changed.`,
        line: `the ${w.flow} has no case for it yet`,
        setup: true,
      };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        why: `The calendar ${w.flow} failed (status ${res.status}). Ask the person to look at the ${w.flow}'s ${w.history} in ${w.home} before you try again.`,
        line: `the ${w.flow} failed. See its ${w.history}`,
        ...(write ? { maybeDone: true } : {}),
      };
    }
    return {
      ok: false,
      why: `The calendar ${w.flow} said no (status ${res.status}). The ${w.flow} may be off, or the address in Pobots is not its current one. The person checks Pobots settings, Calendar.`,
      line: `the ${w.flow} said no. Check the address in settings`,
      setup: true,
    };
  } catch (err) {
    const late = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (late) {
      const secs = Math.max(1, Math.round(ms / 1000));
      log.warn(`Calendar: the ${w.flow} did not answer ${action} in time`);
      return write
        ? {
            ok: false,
            why: `The calendar ${w.flow} did not answer within ${secs} seconds. It may still have happened, so do not try again before you have looked with calendar_list.`,
            line: "no answer in time. Check the calendar before trying again",
            maybeDone: true,
          }
        : { ok: false, why: `The calendar ${w.flow} did not answer within ${secs} seconds. Try again in a little while.`, line: "no answer in time" };
    }
    log.warn(`Calendar: the ${w.flow} could not be reached for ${action}`);
    return { ok: false, why: `The calendar ${w.flow} could not be reached, so nothing happened. Try again later.`, line: `the ${w.flow} could not be reached` };
  }
}

/**
 * The one redirect followed: a Google script's answer, from script.google.com to https on
 * script.googleusercontent.com. On this computer (tests), a stand-in script's redirect to itself.
 * Any other redirect is read as the answer it is, as before.
 */
export function scriptRedirect(address: string, res: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(res.status)) return undefined;
  const loc = res.headers.get("location");
  if (!loc) return undefined;
  try {
    const from = new URL(address);
    const to = new URL(loc, from);
    if (from.hostname === "script.google.com" && to.protocol === "https:" && to.hostname === "script.googleusercontent.com" && !to.username && !to.password) return to.toString();
    const local = (h: string) => h === "127.0.0.1" || h === "localhost";
    if (serviceOf(address) === "google" && local(from.hostname) && to.protocol === "http:" && to.host === from.host) return to.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

/** Graph's own no (or Google's, in Graph's shape), passed on by the flow or the script. */
function graphProblem(status: number, message: string, write: boolean, w: ServiceWords): FlowAnswer {
  const said = message.trim() ? ` ${w.cal} said: ${message.trim().slice(0, 300)}` : "";
  if (status === 404) return { ok: false, why: `That meeting is not in the calendar (any more). Look again with calendar_list.${said}`, line: "the meeting is not there", gone: true };
  if (status === 401 || status === 403)
    return {
      ok: false,
      why: `${w.cal} did not allow it (status ${status}). The ${w.flow}'s connection may need to be ${w.guide === "google" ? "allowed again in Apps Script" : "signed in again in Power Automate"}.${said}`,
      line: `${w.cal} did not allow it`,
      setup: true,
    };
  if (status === 429) return { ok: false, why: `${w.cal} asked to slow down (status 429). Wait a minute before you try again.${said}`, line: `${w.cal} asked to slow down` };
  // A write that the calendar failed on, or did not answer in time, may still have happened: look before trying again.
  if (status >= 500 && write)
    return { ok: false, why: `${w.cal} failed (status ${status}). It may still have happened, so do not try again before you have looked with calendar_list.${said}`, line: `${w.cal} failed. Check the calendar before trying again`, maybeDone: true };
  if (status >= 500) return { ok: false, why: `${w.cal} failed (status ${status}). Try again later.${said}`, line: `${w.cal} failed` };
  // 400 and 501 from a Google script: something Google Calendar cannot do, said in its message.
  return { ok: false, why: `${w.cal} refused it (status ${status}).${said}`, line: `${w.cal} refused it (status ${status})` };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANSWER_MAX) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
