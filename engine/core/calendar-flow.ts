// The calendar flow's client (engine 0.25.0, docs/build/step-calendar-flow.md). One POST to the flow's
// address with `{ action, ...fields }`; the flow calls Microsoft Graph on the person's own mailbox and
// answers `{ ok: true, result }`, or 502 with `{ ok: false, graphStatus, message }` when Graph said no.
// Never retried: a create that timed out may be in the calendar already. The address is a secret: it
// is never logged, never in an answer, never in a line in the chat.
import type { Engine } from "../engine.js";
import { log } from "../log.js";

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
  try {
    const res = await fetch(address, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...fields }),
      redirect: "manual",
      signal: AbortSignal.timeout(ms),
    });
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
      log.warn(`Calendar: the flow answered ${action} in a shape Pobots does not know`);
      return {
        ok: false,
        why: "The calendar flow answered in a way Pobots does not know, so it is not clear what happened. The person checks the flow against docs/build/step-calendar-flow.md.",
        line: "the flow answered in a way Pobots does not know",
        ...(write ? { maybeDone: true } : {}),
      };
    }
    log.warn(`Calendar: the flow answered ${action} with status ${res.status}${typeof b.graphStatus === "number" ? ` (Outlook ${b.graphStatus})` : ""}`);
    if (res.status === 502 && typeof b.graphStatus === "number") return graphProblem(b.graphStatus, typeof b.message === "string" ? b.message : "", write);
    if (res.status === 400) {
      return {
        ok: false,
        why: `The calendar flow refused it (status 400). It likely has no case for "${action}" yet, so the person needs to update the flow in Power Automate. Nothing was changed.`,
        line: "the flow has no case for it yet",
      };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        why: `The calendar flow failed (status ${res.status}). Ask the person to look at the flow's run history in Power Automate before you try again.`,
        line: "the flow failed. See its run history",
        ...(write ? { maybeDone: true } : {}),
      };
    }
    return {
      ok: false,
      why: `The calendar flow said no (status ${res.status}). The flow may be off, or the address in Pobots is not its current one. The person checks Pobots settings, Calendar.`,
      line: "the flow said no. Check the address in settings",
    };
  } catch (err) {
    const late = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (late) {
      const secs = Math.max(1, Math.round(ms / 1000));
      log.warn(`Calendar: the flow did not answer ${action} in time`);
      return write
        ? {
            ok: false,
            why: `The calendar flow did not answer within ${secs} seconds. It may still have happened, so do not try again before you have looked with calendar_list.`,
            line: "no answer in time. Check the calendar before trying again",
            maybeDone: true,
          }
        : { ok: false, why: `The calendar flow did not answer within ${secs} seconds. Try again in a little while.`, line: "no answer in time" };
    }
    log.warn(`Calendar: the flow could not be reached for ${action}`);
    return { ok: false, why: "The calendar flow could not be reached, so nothing happened. Try again later.", line: "the flow could not be reached" };
  }
}

/** Graph's own no, passed on by the flow. */
function graphProblem(status: number, message: string, write: boolean): FlowAnswer {
  const said = message.trim() ? ` Outlook said: ${message.trim().slice(0, 300)}` : "";
  if (status === 404) return { ok: false, why: `That meeting is not in the calendar (any more). Look again with calendar_list.${said}`, line: "the meeting is not there", gone: true };
  if (status === 401 || status === 403)
    return { ok: false, why: `Outlook did not allow it (status ${status}). The flow's connection may need to be signed in again in Power Automate.${said}`, line: "Outlook did not allow it" };
  if (status === 429) return { ok: false, why: `Outlook asked to slow down (status 429). Wait a minute before you try again.${said}`, line: "Outlook asked to slow down" };
  // A write that Outlook failed on, or did not answer in time, may still have happened: look before trying again.
  if (status >= 500 && write)
    return { ok: false, why: `Outlook failed (status ${status}). It may still have happened, so do not try again before you have looked with calendar_list.${said}`, line: "Outlook failed. Check the calendar before trying again", maybeDone: true };
  if (status >= 500) return { ok: false, why: `Outlook failed (status ${status}). Try again later.${said}`, line: "Outlook failed" };
  return { ok: false, why: `Outlook refused it (status ${status}).${said}`, line: `Outlook refused it (status ${status})` };
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
