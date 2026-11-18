// Engine 0.29.0: open cards come back after a restart (docs/build/step-cards-after-restart.md).
//
// Following T3 Code's ProviderRuntimeRecoveryService (reconcileProjection): a pending question keeps
// living after the server restarts, but the callback that waited on it died, so an answer goes to
// the thread as a new message from the person (Orchestrator.ts, queued after a running turn). Pobots
// does the same for approvals: nothing runs by itself after a restart. The bot is told it was
// approved and does the step again, and that one repeat goes through without a second card.
import type { Engine } from "../engine.js";
import type { BotRuntime, InternalDecision, PendingCard } from "./runtime.js";
import type { ApprovalCard, QuestionCard, UserItem } from "../../shared/protocol.js";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import { now } from "./words.js";
import { endHold, startNextInLine } from "./stop.js";
import { deliver } from "./task-managers.js";
import { removeCard } from "./cards.js";

/** How long an approval given on a card that came back lets the bot's repeat through. */
export const GRANT_MS = 30 * 60 * 1000;

/** Where the note for an answer's turn waits, keyed by the answer's item id (read in turn-start.ts). */
export const noteKey = (itemId: string) => `card-answer:${itemId}`;

interface Grant {
  botId: string;
  title: string;
  detail: string;
  caption: string;
  decision: "allow-once" | "always-allow";
  until: number;
}

const grants = new WeakMap<Engine, Grant[]>();

type Asking = ApprovalCard | QuestionCard;

/**
 * At shutdown: the bot's open approvals and questions stay in the database for the next start, and
 * the window is not told they left (it would see them go and come back). What waited on them is let
 * go ("withdrawn"), so nothing hangs. Notes stay too, as before.
 */
export function keepCardsAtShutdown(eng: Engine, rt: BotRuntime): boolean {
  let waited = false;
  for (const [id, p] of [...eng.cards]) {
    if (p.rt !== rt) continue;
    clearTimeout(p.timer);
    eng.cards.delete(id);
    if (p.card.kind !== "note") p.resolve({ type: "withdrawn" });
    if (ownAsking(p.card)) waited = true;
  }
  return waited;
}

/** What the chat says when the turn that Pobots cut short was waiting on a card that stays. */
export const WAITED_NOTICE = "Pobots stopped while the bot waited for your answer. Its card stays open, and your answer reaches the bot as a new message.";

/** An approval or question of the bot's own turn (not a helper's or a task manager's). */
export function ownAsking(card: PendingCard["card"]): card is Asking {
  return (card.kind === "approval" || card.kind === "question") && !card.helper && card.taskManager === undefined;
}

/** At start: the kept cards of bots that are still there go back on the rail, same id, same words, same time. */
export function restoreCards(eng: Engine): void {
  let back = 0;
  for (const card of eng.store.listCards()) {
    if (card.kind === "system") {
      eng.cards.set(card.id, { card, resolve: () => undefined });
      continue;
    }
    const rt = eng.bots.get(card.botId);
    if (!rt) {
      eng.store.removeCard(card.id);
      continue;
    }
    if (card.kind === "note") {
      eng.cards.set(card.id, { card, rt, resolve: () => undefined });
      continue;
    }
    restore(eng, rt, card);
    back++;
  }
  if (back) log.info(`${back} open card${back === 1 ? "" : "s"} came back after the restart`);
}

function restore(eng: Engine, rt: BotRuntime, card: Asking): void {
  const pending: PendingCard = { card, rt, restored: true, resolve: (d) => answered(eng, rt, card, d) };
  if (card.kind === "approval" && card.expiresAt) {
    // The time it had left; one already past it goes at once.
    const left = Math.max(0, Date.parse(card.expiresAt) - Date.now());
    pending.timer = setTimeout(() => removeCard(eng, card.id, "expired", { type: "expired" }), Number.isFinite(left) ? left : 0);
    pending.timer.unref?.();
  }
  eng.cards.set(card.id, pending);
}

/** The bot must be reachable before an answer that becomes a message is taken (cards.ts resolveCard). */
export function becomesMessage(pending: PendingCard, type: string): boolean {
  return !!pending.restored && ["allow-once", "always-allow", "choice", "text"].includes(type);
}

/**
 * The person answered a card that came back: the bot gets it as a message, or as news for a no.
 * Engine 0.31.0: also a question card whose call already returned with his follow-up question
 * (`after` "asked", core/card-questions.ts), once the turn that took it has ended.
 */
export function answered(eng: Engine, rt: BotRuntime, card: Asking, d: InternalDecision, after: "restart" | "asked" = "restart"): void {
  // Withdrawn: the bot was retired, or Pobots stops again (the card stays for the next start).
  if (d.type === "withdrawn" || !eng.bots.has(rt.folder.id)) return;
  try {
    if (card.kind === "question" && (d.type === "choice" || d.type === "text")) {
      const answer = d.type === "choice" ? (card.choices.find((c) => c.id === d.choiceId)?.label ?? d.choiceId) : d.text;
      send(eng, rt, card, answer, questionNote(card, after));
      return;
    }
    if (card.kind === "approval" && (d.type === "allow-once" || d.type === "always-allow")) {
      const list = (grants.get(eng) ?? []).filter((g) => g.until > Date.now());
      list.push({ botId: card.botId, title: card.title, detail: card.detail, caption: card.caption ?? "", decision: d.type, until: Date.now() + GRANT_MS });
      grants.set(eng, list);
      send(eng, rt, card, d.type === "always-allow" ? "Approved, and always allow it" : "Approved", approvalNote(card, d.type));
      return;
    }
    eng.store.addNews(rt.folder.id, rt.threadId, noNews(card, d.type, after));
    log.info(`Bot ${rt.folder.id}: a card that came back after a restart was answered with ${d.type}; the bot hears it at its next turn`);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not pass on the answer to a card that came back after a restart`, err);
  }
}

/** Like an answer to a to-do: a message from the person that waits in line and never steers in. */
function send(eng: Engine, rt: BotRuntime, card: Asking, text: string, note: string): void {
  const from: UserItem["from"] = { type: "you", card: { id: card.id, title: card.title } };
  const id = randomUUID();
  // A task manager's card: the task manager gets it while it is there (it came back resting).
  const tm = card.taskManager !== undefined ? [...rt.managers.values()].find((m) => m.ownThread === card.threadId) : undefined;
  if (tm) {
    eng.addItem(rt, { id, kind: "user", at: now(), text, from, queued: false }, tm.ownThread);
    void deliver(eng, rt, tm, `${note}\n\n${text}`, "person", id).catch((err) => log.error(`Bot ${rt.folder.id}: could not pass a card's answer to a task manager`, err));
    log.info(`Bot ${rt.folder.id}: the answer to a card that came back after a restart went to its task manager`);
    return;
  }
  // The note is kept with the message, so it survives waiting in line (and another restart).
  eng.store.setValue(noteKey(id), note);
  const holding = !!rt.hold;
  eng.enqueue(rt, text, from, { behind: holding, itemId: id });
  if (holding) {
    endHold(eng, rt);
    startNextInLine(eng, rt);
  }
  log.info(`Bot ${rt.folder.id}: the answer to a card that came back after a restart went to the bot as a message`);
}

function who(card: Asking): string {
  if (card.helper) return `Your helper "${card.helper}" asked it; Pobots stopped that helper when it restarted.`;
  if (card.taskManager) return `Your task manager "${card.taskManager}" asked it.`;
  return "";
}

function questionNote(card: QuestionCard, after: "restart" | "asked"): string {
  const lines = [
    after === "asked"
      ? "Note from Pobots: this message is the person's answer to a question you asked on a card. They asked you about it first, and the turn that asked it has ended since, so carry on from here."
      : "Note from Pobots: this message is the person's answer to a question you asked on a card before Pobots restarted. The turn that asked it ended with the restart, so carry on from here.",
    `The question: ${card.title}`,
  ];
  if (card.text) lines.push(`Its context: ${card.text}`);
  if (card.choices.length) lines.push(`The choices were: ${card.choices.map((c) => c.label).join("; ")}${card.allowText ? " (a typed answer was welcome too)" : ""}.`);
  const w = who(card);
  if (w) lines.push(w);
  return lines.join("\n");
}

function approvalNote(card: ApprovalCard, type: "allow-once" | "always-allow"): string {
  const lines = [
    `Note from Pobots: this message is the person's answer to an approval card you raised before Pobots restarted. They approved it${type === "always-allow" ? " and chose to always allow it" : ""}.`,
    `What you asked: ${card.title}`,
  ];
  if (card.caption) lines.push(`(${card.caption})`);
  if (card.detail) lines.push(card.detail);
  const w = who(card);
  if (w) lines.push(w);
  lines.push(
    `It has not been done: the restart ended the turn that asked, and nothing runs by itself after a restart. If it is still wanted, do it again now, in exactly the same way: within ${GRANT_MS / 60000} minutes that one repeat goes through without a new card. If anything about it would differ, the person gets a new card.`,
  );
  return lines.join("\n");
}

function noNews(card: Asking, type: InternalDecision["type"], after: "restart" | "asked"): string {
  const what = card.kind === "approval" ? `you asked the person to approve "${card.title}"` : `you asked the person "${card.title}"`;
  const said =
    type === "expired"
      ? "Nobody answered in time, so it counts as a no. Do not try it another way."
      : type === "later"
        ? card.kind === "approval"
          ? "They put it aside for later, which counts as a no for now."
          : "They put it aside for later without an answer."
        : card.kind === "approval"
          ? "They said no. Do not try to do this another way without asking first."
          : "They dismissed it without an answer.";
  return after === "asked" ? `Note from Pobots: ${what} on a card, and they asked you about it. ${said}` : `Note from Pobots: before Pobots restarted, ${what} on a card. ${said}`;
}

/**
 * An approval the person gave on a card that came back after a restart: the bot's repeat of exactly
 * that request, within the time, gets the same answer once, without a second card.
 */
export function takeGrant(eng: Engine, card: ApprovalCard): InternalDecision | undefined {
  const list = (grants.get(eng) ?? []).filter((g) => g.until > Date.now());
  const i = list.findIndex((g) => g.botId === card.botId && g.title === card.title && g.detail === card.detail && g.caption === (card.caption ?? ""));
  if (i < 0) {
    grants.set(eng, list);
    return undefined;
  }
  const [g] = list.splice(i, 1);
  grants.set(eng, list);
  const decision = g!.decision === "always-allow" && card.noAlways ? "allow-once" : g!.decision;
  log.info(`Bot ${card.botId}: a step the person approved on a card before a restart went through once without a new card`);
  return { type: decision };
}
