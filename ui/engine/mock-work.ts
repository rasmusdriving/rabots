// The mock engine's part of job 7's chat (step 7a) and the to-do answers (step 7c): taking a waiting
// message back, a bot's to-do list, the levers for work in a running turn, and an answer from the
// person's to-do list. Free functions of the mock: `mock` is the MockEngine, and each keeps a
// one-line method there. Moved out of mock.ts unchanged on 15 Nov 2026 (docs/build/step-split.md).
import type { ActivityItem, Bot, BotItem, PlanStep, UserItem } from "../../shared/protocol";
import { EngineError } from "./types";
import { at } from "./mock-data";
import type { MockLevers } from "./mock-levers";
import type { MockEngine } from "./mock";

/** "message.unqueue": a waiting message of the person's is taken back and leaves the thread. */
export function unqueue(mock: MockEngine, botId: string, itemId: string): Record<string, never> {
  const bot = mock.bot(botId);
  const list = mock.threads.get(bot.mainThreadId) ?? [];
  const at = list.findIndex((i) => i.id === itemId && i.kind === "user" && i.queued && i.from.type === "you");
  if (at < 0) throw new EngineError({ code: "not_found", message: "That message is no longer waiting." });
  list.splice(at, 1);
  mock.emit({ event: "item.removed", data: { threadId: bot.mainThreadId, itemId } });
  return {};
}

/** Sets a bot's to-do list from [text, status] pairs, or takes it away with null. */
export function putPlan(mock: MockEngine, botId: string, steps: [string, PlanStep["status"]][] | null): void {
  const bot = mock.bot(botId);
  const { plan: _old, ...rest } = bot;
  const next: Bot = steps && steps.length ? { ...rest, plan: { steps: steps.map(([text, status]) => ({ text, status })), updatedAt: new Date().toISOString(), turnId: mock.turns.get(botId)?.id } } : rest;
  mock.bots = mock.bots.map((b) => (b.id === botId ? next : b));
  mock.emit({ event: "bot.updated", data: { bot: next } });
}

export function chat7Levers(mock: MockEngine): Pick<MockLevers, "setPlan" | "addWork" | "finishWork" | "takeQueued" | "endWork"> {
  return {
    setPlan: (botId, steps) => mock.putPlan(botId, steps),
    addWork: (botId, label, tool, o = {}) => {
      const bot = mock.bot(botId);
      const turnId = mock.turns.get(botId)?.id;
      const item = mock.add<ActivityItem>(bot.mainThreadId, { kind: "activity", botId, ...(turnId ? { turnId } : {}), label, status: o.running ? "running" : "done", tool, ...(o.detail ? { detail: o.detail } : {}), ...(o.running ? {} : { durationMs: 1_000 }) });
      mock.upsert(item);
      if (o.running) mock.putBot({ ...mock.bot(botId), state: "working", activity: label });
      return item.id;
    },
    finishWork: (botId, itemId, label) => {
      const list = mock.threads.get(mock.bot(botId).mainThreadId) ?? [];
      const item = list.find((i): i is ActivityItem => i.id === itemId && i.kind === "activity");
      if (item) mock.replace({ ...item, status: "done", durationMs: 1_000, ...(label ? { label } : {}) });
    },
    takeQueued: (botId) => {
      const list = mock.threads.get(mock.bot(botId).mainThreadId) ?? [];
      const next = list.find((i): i is UserItem => i.kind === "user" && i.queued);
      if (!next) return null;
      const turnId = `turn${mock.nextId++}`;
      mock.turns.set(botId, { botId, threadId: next.threadId, stopped: false, id: turnId });
      mock.replace({ ...next, queued: false, turnId });
      return next.id;
    },
    endWork: (botId, text) => {
      const bot = mock.bot(botId);
      const turnId = mock.turns.get(botId)?.id;
      for (const i of [...(mock.threads.get(bot.mainThreadId) ?? [])]) if (i.kind === "activity" && i.status === "running") mock.replace({ ...i, status: "done", durationMs: 1_000 });
      mock.upsert(mock.add<BotItem>(bot.mainThreadId, { kind: "bot", botId, ...(turnId ? { turnId } : {}), streaming: false, text }));
      mock.turns.delete(botId);
      mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
    },
  };
}

// ================================================================ step 7c: to-dos for the person
/**
 * The person's answer to a to-do, as the engine does it: his message in the bot's main chat, marked
 * from the to-do, waiting in line while the bot works (never steered).
 */
export function todoAnswer(mock: MockEngine, botId: string, text: string, from: Extract<UserItem["from"], { type: "you" }>): void {
  const bot = mock.bot(botId);
  const busy = mock.turns.has(botId);
  const item = mock.add<UserItem>(bot.mainThreadId, { kind: "user", from, queued: busy, text });
  mock.upsert(item);
  if (!busy) void mock.runTurn(botId, item, {});
}
