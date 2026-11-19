// The team: messages between bots (ask and tell), their waiting answers and late answers.
import { away, vacationRefusal } from "./vacation.js";
import type { Engine } from "../engine.js";
import type { AskOutcome, BotRuntime, PendingAsk } from "./runtime.js";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "../claude/session.js";
import { MAX_HOPS, type MessageBotArgs, ok, problem, TOOL_NAMES } from "../team.js";
import { askNotSteered, tellBot } from "./bot-steer.js";
import type { UserItem } from "../../shared/protocol.js";
import { noteToolDetail } from "./bot-tools.js";

/** May `from` message `to`? The main bot may message everyone, and everyone may message the main bot. */
export function mayMessage(eng: Engine, from: string, to: string): boolean {
  if (from === to) return false;
  const a = eng.bots.get(from);
  const b = eng.bots.get(to);
  if (!a || !b) return false;
  return a.folder.file.role === "main" || b.folder.file.role === "main" || a.folder.file.mayMessage.includes(to);
}

/** True when `start` waits, directly or through others, for an answer from `target`. */
export function waitsFor(eng: Engine, start: string, target: string): boolean {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    for (const ask of eng.asks) if (ask.from === id && !ask.late && !ask.settled && walk(ask.to)) return true;
    return false;
  };
  return walk(start);
}

export function newAsk(eng: Engine, from: string, to: string, hops: number, epoch?: number): PendingAsk {
  const ask: PendingAsk = { id: randomUUID(), from, to, hops, settled: false, late: false, resolve: () => undefined, epoch: epoch ?? eng.bots.get(from)?.epoch ?? 0 };
  eng.asks.add(ask);
  return ask;
}

/** The asker stops waiting; the answer will come to it as a message. */
export function goLate(eng: Engine, ask: PendingAsk): void {
  if (ask.settled || ask.late) return;
  ask.late = true;
  clearTimeout(ask.timer);
  ask.resolve({ late: true });
}

export function settleAsk(eng: Engine, ask: PendingAsk, outcome: { answer: string } | { problem: string }): void {
  if (ask.settled) return;
  ask.settled = true;
  clearTimeout(ask.timer);
  eng.asks.delete(ask);
  if (!ask.late) {
    ask.resolve(outcome);
    return;
  }
  // A task manager's question (engine 0.26.0): the answer goes to it.
  if (ask.onLate) {
    if ("answer" in outcome && !eng.stopping) ask.onLate(outcome.answer);
    return;
  }
  // Delivered later, as a message from the bot that answered.
  const asker = eng.bots.get(ask.from);
  if (!asker || away(asker) || eng.stopping || !("answer" in outcome) || !eng.harnessReady(asker)) return;
  // An answer to a question asked before a Stop that holds waits with the held messages (step 3b, third part).
  const held = !!asker.hold && ask.epoch < asker.epoch;
  eng.enqueue(asker, outcome.answer, { type: "bot", botId: ask.to, expectsReply: false }, { hops: ask.hops, lateAnswer: true, held });
}

export async function messageBot(eng: Engine, rt: BotRuntime, args: MessageBotArgs, signal?: AbortSignal): Promise<ToolResult> {
  const target = eng.findBot(args.to);
  if (!target) return problem(`There is no bot called ${args.to}. Use list_bots to see the others.`);
  const name = target.folder.file.name;
  if (away(target)) return problem(vacationRefusal(target));
  if (target === rt) return problem("You cannot send a message to yourself.");
  if (!eng.mayMessage(rt.folder.id, target.folder.id)) {
    return problem(`You may not message ${name}. You can message the main bot, or ask the person to add ${name} to your list.`);
  }
  const text = args.text.trim();
  if (!text) return problem("The message is empty.");
  const hops = (rt.turn?.hops ?? 0) + 1;
  if (hops > MAX_HOPS) {
    return problem(`This chain of messages between bots has already passed through ${MAX_HOPS} bots, so it stops here. Finish with what you have, or ask the person.`);
  }
  if (args.mode === "ask" && waitsFor(eng, target.folder.id, rt.folder.id)) {
    return problem(`${name} is waiting for your answer, so it cannot answer a question from you now. Finish your own answer first, or use mode tell.`);
  }
  if (!eng.harnessReady(target) || eng.stopping) return problem(`${name} cannot be reached right now.`);

  const from: UserItem["from"] = { type: "bot", botId: rt.folder.id, expectsReply: args.mode === "ask" };
  if (args.mode === "tell") return tellBot(eng, rt, target, text, hops, args.delivery ?? "queue");
  // A question waits for a turn of its own; asked as a steer, the answer says so (15 Nov 2026).
  const asSteer = args.delivery === "steer" ? ` (${askNotSteered(rt)})` : "";

  const ask = newAsk(eng, rt.folder.id, target.folder.id, hops);
  const outcome = await new Promise<AskOutcome>((resolve) => {
    ask.resolve = resolve;
    ask.timer = setTimeout(() => goLate(eng, ask), eng.askTimeoutMs);
    ask.timer.unref?.();
    signal?.addEventListener("abort", () => goLate(eng, ask), { once: true });
    eng.enqueue(target, text, from, { hops, ask });
  });
  if ("late" in outcome) {
    return ok(`${name} has not answered yet${asSteer}. Its answer will come to you later as a message from ${name}. Carry on without it for now.`);
  }
  if ("problem" in outcome) return problem(outcome.problem);
  noteToolDetail(eng, rt, TOOL_NAMES.messageBot, (input) => input.to === args.to && input.text === args.text, `${text}\n\nAnswer from ${name}:\n${outcome.answer}`);
  return ok(`${name} answered${asSteer}:\n\n${outcome.answer}`);
}
