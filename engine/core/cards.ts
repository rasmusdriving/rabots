// Cards: approvals and questions from the harness, the bots' own asks, notes, and cards from Pobots itself.
import type { Engine } from "../engine.js";
import { type BotRuntime, callScope, type Helper, inBackground, type InternalDecision, type PendingCard, waitWords } from "./runtime.js";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { TOOL_SERVER } from "../claude/session.js";
import { log } from "../log.js";
import { describeApproval } from "../claude/labels.js";
import { rulesFromSuggestions, sessionUpdate } from "../rules.js";
import type { ApprovalCard, CardDecision, CardMeeting, QuestionCard, SystemCard } from "../../shared/protocol.js";
import { randomUUID } from "node:crypto";
import { clip, now } from "./words.js";
import { EngineError } from "../errors.js";
import { isLinkTool } from "../tool-names.js";
import { tidyGate } from "./turn-end.js";
import { managerChanged } from "./task-managers.js";
import { becomesMessage, takeGrant } from "./restored-cards.js";
import { followUpWords, takePlace } from "./card-questions.js";
import { restWaitChanged } from "./restored-waiting.js";

export async function canUseTool(eng: Engine, rt: BotRuntime, toolName: Parameters<CanUseTool>[0], input: Parameters<CanUseTool>[1], options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
  if (eng.stopping) return { behavior: "deny", message: "The turn was stopped.", interrupt: true };
  // A helper's tool call raises the bot's card, as the bot's own would. It stands in the thread where the helper's row is.
  const helper = options.agentID ? [...rt.helpers.values()].find((h) => h.taskId === options.agentID) : undefined;
  if (rt.interruptRequested && !helper?.manager) return { behavior: "deny", message: "The turn was stopped.", interrupt: true };
  if (helper?.stopAsked) return { behavior: "deny", message: "The helper was stopped.", interrupt: true };
  // A tidy turn never raises a card: what it may do goes on, the rest is refused with a sentence.
  // A task manager's worker does not take part in the bot's tidy turn (engine 0.26.0).
  const tidy = !helper?.manager && rt.busy && !!rt.turn?.tidy;
  const tidyNo = helper?.manager ? undefined : tidyGate(eng, rt, toolName, input);
  if (tidyNo) return { behavior: "deny", message: tidyNo };
  if (tidy) return { behavior: "allow", updatedInput: input };
  const prefix = `mcp__${TOOL_SERVER}__`;
  if (options.agentID && toolName.startsWith(prefix) && isLinkTool(toolName.slice(prefix.length))) {
    return { behavior: "deny", message: "Only the main bot can use connections." };
  }
  // The bot's own tools have their own gates.
  if (toolName.startsWith(`mcp__${TOOL_SERVER}__`)) return { behavior: "allow", updatedInput: input };
  if (toolName === "AskUserQuestion") return askQuestions(eng, rt, input, options.signal, helper);

  // Step 7c: a bot on "Full access", and every helper of it, is never asked. The harness still asks
  // about some calls in its bypass mode (its own safety checks, such as "dangerous removal not ruled
  // out" for a command it cannot read with certainty); the person chose full access, so they go on.
  const access = rt.folder.file.access;
  const reason = typeof options.decisionReason === "string" ? options.decisionReason.split("\n")[0]!.slice(0, 160) : "";
  if (access === "full-access") {
    log.info(`Bot ${rt.folder.id}: allowed a ${toolName} call ${options.agentID ? "of a helper " : ""}that the harness asked about, on full access${reason ? ` (${reason})` : ""}`);
    return { behavior: "allow", updatedInput: input };
  }
  // A helper never asks the person more than its bot would: on "Decides itself" what the harness's
  // own automatic mode did not settle is a no, never a card.
  if (options.agentID && access === "decides-itself") {
    log.info(`Bot ${rt.folder.id}: refused a ${toolName} call of a helper that the harness asked about, on "Decides itself"${reason ? ` (${reason})` : ""}`);
    return { behavior: "deny", message: "Not allowed: your bot decides by itself and does not ask the person for its helpers. Do it another way, or say in your result what you could not do." };
  }

  const words = describeApproval(toolName, input);
  // A request from Codex has no "Always allow" in this step: the saved rules are in Claude's format.
  const noAlways = (options as unknown as { pobotsNoAlways?: boolean }).pobotsNoAlways === true;
  const rules = options.suppressAlwaysAllowRule || noAlways ? [] : rulesFromSuggestions(options.suggestions);
  const card: ApprovalCard = {
    kind: "approval",
    id: randomUUID(),
    botId: rt.folder.id,
    threadId: helper?.base.threadId ?? eng.liveThread(rt),
    at: now(),
    title: words.title,
    detail: words.detail,
    ...(words.caption ? { caption: words.caption } : {}),
    ...(noAlways ? { noAlways: true } : {}),
    ...(helper ? { helper: helper.base.title } : {}),
  };
  const decision = await openCard(eng, rt, card, "Waiting for your approval", options.signal, helper);
  if (!helper?.manager) afterCard(eng, rt, helper ? undefined : toolName, input);
  switch (decision.type) {
    case "allow-once":
      return { behavior: "allow", updatedInput: input };
    case "always-allow": {
      // A helper with a session of its own (start_helper, a task manager's worker) is not the bot's session.
      const update = saveAlwaysRules(eng, rt, rules, { otherSession: !!helper?.pobots });
      return { behavior: "allow", updatedInput: input, ...(update.length ? { updatedPermissions: update } : {}) };
    }
    case "later":
      return { behavior: "deny", message: "The person put this aside for later. Leave it for now and carry on, or say what you still need." };
    case "withdrawn":
      return { behavior: "deny", message: "The request was withdrawn because the turn stopped.", interrupt: true };
    case "expired":
      return { behavior: "deny", message: "Nobody answered in time, so this counts as a no. Do not try it another way." };
    default:
      return { behavior: "deny", message: "The person said no. Do not try to do this another way without asking first." };
  }
}

/**
 * "Always allow": the rules are saved to the bot, and the session that asked gets them at once (the
 * update returned). When that session is not the bot's own (a task manager, or a helper with a session
 * of its own), the bot's session is renewed, as when a rule is forgotten (bot-admin.ts removeRule): at
 * once when it rests, else after its turn, so the bot's own next same request is not asked (fix 0.26.1).
 */
export function saveAlwaysRules(eng: Engine, rt: BotRuntime, rules: string[], o: { otherSession: boolean }): ReturnType<typeof sessionUpdate> {
  for (const rule of rules) eng.store.addRule(rt.folder.id, rule);
  if (!rules.length) return [];
  eng.opts.emit("rules.changed", { botId: rt.folder.id });
  if (o.otherSession) eng.refreshSession(rt);
  return sessionUpdate(rules);
}

export async function askQuestions(eng: Engine, rt: BotRuntime, input: Record<string, unknown>, signal: AbortSignal, helper?: Helper): Promise<PermissionResult> {
  const questions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const question = typeof q.question === "string" ? q.question : "";
    const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
    const card: QuestionCard = {
      kind: "question",
      id: randomUUID(),
      botId: rt.folder.id,
      threadId: helper?.base.threadId ?? eng.liveThread(rt),
      at: now(),
      title: question || "The bot has a question",
      ...(typeof q.header === "string" && q.header ? { text: q.header } : {}),
      choices: options.map((o, i) => ({ id: String(i), label: typeof o.label === "string" ? o.label : `Choice ${i + 1}` })),
      allowText: true,
      ...(helper ? { helper: helper.base.title } : {}),
    };
    const decision = await openCard(eng, rt, card, "Waiting for your answer", signal, helper);
    if (decision.type === "choice") {
      answers[question] = card.choices.find((c) => c.id === decision.choiceId)?.label ?? decision.choiceId;
    } else if (decision.type === "text") {
      answers[question] = decision.text;
    } else {
      if (!helper?.manager) afterCard(eng, rt, "AskUserQuestion", input);
      // Engine 0.31.0: he asked about the card first (core/card-questions.ts). The card stays.
      if (decision.type === "ask") return { behavior: "deny", message: followUpWords(decision.text, "AskUserQuestion") };
      if (decision.type === "withdrawn") return { behavior: "deny", message: "The question was withdrawn because the turn stopped.", interrupt: true };
      return { behavior: "deny", message: "The person has not answered yet. Carry on without the answer, or ask again later in plain text." };
    }
  }
  if (!helper?.manager) afterCard(eng, rt, "AskUserQuestion", input);
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

export function openCard(eng: Engine, rt: BotRuntime, card: ApprovalCard | QuestionCard, activity: string, signal?: AbortSignal, helper?: Helper): Promise<InternalDecision> {
  const startedBy = helper ? helper.purpose.startedBy : rt.turn?.startedBy;
  const outside = startedBy === "connection";
  // An outside message cannot reuse an answer meant for an earlier turn.
  const granted = card.kind === "approval" && !outside ? takeGrant(eng, card) : undefined;
  if (granted) return Promise.resolve(granted);
  // An approval in a turn the person did not start expires, and then counts as a no. A helper's card
  // goes by the turn that started the helper.
  const expires = card.kind === "approval" && startedBy !== undefined && startedBy !== "you";
  if (expires) card.expiresAt = new Date(Date.now() + eng.cardExpiryMs).toISOString();
  // Engine 0.31.0: a question after the person asked about the last one takes its place (core/card-questions.ts).
  const place = card.kind === "question" && !helper ? takePlace(eng, rt, card) : {};
  if (place.decision) return Promise.resolve(place.decision);
  return new Promise((resolve) => {
    const call = callScope.getStore();
    // A task manager's worker asks for its manager: the card names it, and the bot is not held (engine 0.26.0).
    const manager = helper?.manager;
    if (manager) card.taskManager = rt.managers.get(manager)?.title ?? "";
    const pending: PendingCard = { card, rt, resolve, ...(helper ? { helper: helper.toolUseId } : {}), ...(call ? { call } : {}), ...(manager ? { manager } : {}) };
    // Only while this call still waits on the card: one it left stays (core/card-questions.ts).
    const mine = () => eng.cards.get(card.id) === pending;
    if (expires) {
      pending.timer = setTimeout(() => mine() && removeCard(eng, card.id, "expired", { type: "expired" }), eng.cardExpiryMs);
      pending.timer.unref?.();
    }
    eng.cards.set(card.id, pending);
    eng.store.addCard(card);
    eng.opts.emit(place.replaced ? "card.changed" : "card.added", { card });
    if (manager) managerChanged(eng, rt, manager);
    else eng.setState(rt, "waiting", activity);
    if (signal) {
      if (signal.aborted) removeCard(eng, card.id, "withdrawn", { type: "withdrawn" });
      else signal.addEventListener("abort", () => mine() && removeCard(eng, card.id, "withdrawn", { type: "withdrawn" }), { once: true });
    }
  });
}

/** Once no card waits for the person, the bot is back at work on what it was doing. */
export function afterCard(eng: Engine, rt: BotRuntime, toolName?: string, input: Record<string, unknown> = {}): void {
  if (rt.interruptRequested) return;
  const stillWaiting = [...eng.cards.values()].some((p) => p.rt === rt && !p.manager && !p.restored && p.card.kind !== "note");
  if (stillWaiting) return;
  if (!rt.busy) {
    // A helper's card was answered while the bot itself rests: back to waiting for its helpers.
    if (inBackground(rt) && rt.state === "waiting") eng.setState(rt, "working", waitWords(rt));
    return;
  }
  const running = toolName ? eng.toolWords(toolName, input).running : [...rt.tools.values()].at(-1)?.running ?? "Working";
  eng.setState(rt, "working", running);
}

export function removeCard(eng: Engine, cardId: string, reason: "resolved" | "expired" | "withdrawn", decision: InternalDecision): boolean {
  const pending = eng.cards.get(cardId);
  if (!pending) return false;
  eng.cards.delete(cardId);
  clearTimeout(pending.timer);
  eng.store.removeCard(cardId);
  eng.opts.emit("card.removed", { cardId, reason });
  pending.resolve(decision);
  if (pending.manager && pending.rt) managerChanged(eng, pending.rt, pending.manager);
  // Engine 0.31.1: once the answer has been handed on, a bot that read Waiting for this card reads its own state again.
  if (pending.restored && pending.rt) restWaitChanged(eng, pending.rt);
  return true;
}

/** Withdraws the cards that wait on this bot's turn (with `helpers`, also those of its helpers). Notes stay. */
export function withdrawCards(eng: Engine, rt: BotRuntime, helpers = false): void {
  for (const [id, p] of [...eng.cards]) if (p.rt === rt && !p.manager && !p.restored && p.card.kind !== "note" && (helpers || (!p.helper && !p.call?.detached))) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
}

export function resolveCard(eng: Engine, cardId: string, decision: CardDecision): void {
  const pending = eng.cards.get(cardId);
  if (!pending) throw new EngineError("not_found", "That card is no longer open.");
  const card = pending.card;
  if (card.kind === "approval") {
    if (!["allow-once", "always-allow", "deny", "later"].includes(decision.type)) {
      throw new EngineError("bad_request", "That answer does not fit an approval card.");
    }
    if (decision.type === "always-allow" && card.noAlways) throw new EngineError("bad_request", "This one can only be allowed once.");
  } else if (card.kind === "note" || card.kind === "system") {
    if (decision.type !== "dismiss" && decision.type !== "later") throw new EngineError("bad_request", "A note can only be put away.");
  } else {
    if (decision.type === "choice" && !card.choices.some((c) => c.id === decision.choiceId)) {
      throw new EngineError("bad_request", "That choice is not on the card.");
    }
    if (decision.type === "text" && !decision.text.trim()) throw new EngineError("bad_request", "The answer is empty.");
    if (!["choice", "text", "later", "deny"].includes(decision.type)) {
      throw new EngineError("bad_request", "That answer does not fit a question card.");
    }
  }
  // A card that came back after a restart: its answer becomes a message, so the bot must be reachable first.
  if (pending.rt && becomesMessage(pending, decision.type)) eng.checkReady(pending.rt);
  removeCard(eng, cardId, "resolved", decision);
}

/** Puts up the one card of a topic, replacing one that is there (it is withdrawn, the new one added). */
export function showSystemCard(eng: Engine, topic: SystemCard["topic"], title: string, text: string): void {
  if (!eng.store.isOpen) return;
  clearSystemCard(eng, topic);
  const card: SystemCard = { id: randomUUID(), kind: "system", at: now(), topic, title: clip(title, 120), ...(text.trim() ? { text: clip(text, 1000) } : {}) };
  eng.cards.set(card.id, { card, resolve: () => undefined });
  eng.store.addCard(card);
  eng.opts.emit("card.added", { card });
}

/** Takes the card of a topic down, when one is up. */
export function clearSystemCard(eng: Engine, topic: SystemCard["topic"]): void {
  if (!eng.store.isOpen) return;
  for (const [id, p] of [...eng.cards]) if (p.card.kind === "system" && p.card.topic === topic) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
}

/** An approval card for a bot tool, without "Always allow". */
export async function approval(eng: Engine, rt: BotRuntime, words: { title: string; detail: string; caption: string; meeting?: CardMeeting }, signal?: AbortSignal): Promise<"allow" | InternalDecision["type"]> {
  const card: ApprovalCard = { kind: "approval", id: randomUUID(), botId: rt.folder.id, threadId: eng.liveThread(rt), at: now(), ...words, noAlways: true };
  const decision = await openCard(eng, rt, card, "Waiting for your approval", signal);
  afterCard(eng, rt);
  return decision.type === "allow-once" ? "allow" : decision.type;
}
