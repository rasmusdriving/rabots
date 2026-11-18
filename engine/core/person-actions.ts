// The person's own actions in a window, recorded for the activity log (engine 0.28.0,
// docs/build/step-activity-log.md). As T3 Code records each message's `creationSource`
// (packages/contracts/src/orchestrationV2.ts), Pobots records where he acted from: the app on the
// Mac, a computer's browser over Tailscale, or his phone.
//
// Only the server calls this, for a request from a window that succeeded, so nothing a bot does is
// ever counted as his. `personActionBefore` reads what will be gone once the request has run (an
// answered card, an ended task manager); `personActionAfter` writes the row. Labels only: never a
// card's text, his typed answer or a message's text.

import { randomUUID } from "node:crypto";
import type { CardDecision } from "../../shared/protocol.js";
import type { PersonActionRow, PersonVia } from "../activity-store.js";
import type { Engine } from "../engine.js";
import { log } from "../log.js";
import { now } from "./words.js";

/** Where a connection comes from: the local token is the Mac; over Tailscale, a phone's browser or any other. */
export function whereFrom(via: string | undefined, userAgent: string | undefined): PersonVia {
  if (via !== "tailscale") return "mac";
  return /iPhone|iPad|iPod|Android|Mobile/i.test(userAgent ?? "") ? "phone" : "computer";
}

const DECISION_WORDS: Record<CardDecision["type"], string> = {
  "allow-once": "allowed once",
  "always-allow": "always allowed",
  deny: "denied",
  choice: "chose an answer",
  text: "answered in words",
  dismiss: "put away",
  later: "put off for later",
};

function str(o: unknown, key: string): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The row a window's request would leave, read before the request runs. Undefined for a request
 * that is not one of his actions. Never throws.
 */
export function personActionBefore(eng: Engine, method: unknown, params: unknown, via: PersonVia): PersonActionRow | undefined {
  try {
    return before(eng, method, params, via);
  } catch {
    return undefined;
  }
}

function before(eng: Engine, method: unknown, params: unknown, via: PersonVia): PersonActionRow | undefined {
  const base = { id: randomUUID(), at: now(), via };
  const botId = str(params, "botId");
  switch (method) {
    case "message.send":
      return botId ? { ...base, kind: "message", botId, ...(str(params, "threadId") ? { threadId: str(params, "threadId") } : {}) } : undefined;
    case "card.resolve": {
      const card = eng.cards.get(str(params, "cardId") ?? "")?.card;
      const type = str((params as { decision?: unknown } | undefined)?.decision, "type") as CardDecision["type"] | undefined;
      if (!card || !type) return undefined;
      const kind = card.kind === "approval" ? (card.meeting ? "calendar approval" : "approval") : card.kind === "system" ? "Pobots card" : card.kind;
      const where = card.kind === "system" ? {} : { botId: card.botId, threadId: card.threadId };
      return { ...base, kind: "card", ...where, what: `${kind}, ${DECISION_WORDS[type] ?? "answered"}` };
    }
    case "todo.answer":
    case "todo.close": {
      const id = str(params, "todoId");
      const todo = id ? eng.store.getTodo(id)?.todo : undefined;
      if (!id || !todo) return undefined;
      const how = method === "todo.answer" ? "answered" : str(params, "how") === "dismissed" ? "dismissed" : "marked done";
      return { ...base, kind: "todo", botId: todo.botId, ref: id, what: `${how}: ${todo.title}` };
    }
    // Engine 0.31.0: his question about a to-do or card. The to-do's title is a label; his question is never kept.
    case "todo.ask": {
      const id = str(params, "todoId");
      const todo = id ? eng.store.getTodo(id)?.todo : undefined;
      if (!id || !todo) return undefined;
      return { ...base, kind: "question", botId: todo.botId, what: `the to-do ${todo.title}` };
    }
    case "card.ask": {
      const card = eng.cards.get(str(params, "cardId") ?? "")?.card;
      if (!card || card.kind !== "question") return undefined;
      return { ...base, kind: "question", botId: card.botId, threadId: card.threadId, what: "a card" };
    }
    case "turn.interrupt":
      return botId ? { ...base, kind: "stop", botId } : undefined;
    case "helper.stop": {
      const item = eng.store.getItem(str(params, "itemId") ?? "");
      if (!botId || item?.kind !== "helper" || item.status !== "running") return undefined;
      return { ...base, kind: "stop-helper", botId, threadId: item.threadId, ref: item.id, what: item.title };
    }
    case "taskManager.send":
    case "taskManager.stop":
    case "taskManager.end": {
      const tm = botId ? eng.bots.get(botId)?.managers.get(str(params, "managerId") ?? "") : undefined;
      if (!botId || !tm) return undefined;
      const kind = method === "taskManager.send" ? "message" : method === "taskManager.stop" ? "stop-helper" : "end-task-manager";
      return { ...base, kind, botId, threadId: tm.ownThread, ref: kind === "message" ? undefined : tm.id, what: `task manager: ${tm.title}` };
    }
    default:
      return undefined;
  }
}

/** Writes the row once the request succeeded. A message gets its item's id and time. Never throws. */
export function personActionAfter(eng: Engine, row: PersonActionRow, result: unknown): void {
  try {
    const item = (result as { item?: { id?: unknown; at?: unknown; threadId?: unknown } } | undefined)?.item;
    if (row.kind === "message" && item && typeof item.id === "string") {
      row.ref = item.id;
      if (typeof item.at === "string") row.at = item.at;
      if (typeof item.threadId === "string") row.threadId = item.threadId;
    }
    if (row.ref === undefined) delete row.ref;
    eng.store.activity.addPersonAction(row);
  } catch (err) {
    log.warn("Could not note the person's action for the activity log", err instanceof Error ? err.message : String(err));
  }
}
