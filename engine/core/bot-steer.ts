// A bot steering another bot (15 Nov 2026, docs/build/step-bot-reach.md): message_bot's delivery
// "steer" puts a told message into the other bot's running turn, the way the person's steer does,
// for the main bot and bots the person allowed ("May steer other bots"). Every receipt says what the
// other bot was doing and how the message went. After T3 Code's t3_thread_send `mode` (queue, steer;
// apps/server/src/mcp/toolkits/orchestrator/tools.ts, MIT).
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { UserItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { ok } from "../tool-names.js";
import { shownWords } from "./restored-waiting.js";

/** May this bot steer other bots? The main bot always; another bot when the person (or the main bot) switched it on. */
export function maySteerBots(rt: BotRuntime): boolean {
  return rt.folder.file.role === "main" || rt.folder.file.maySteer === true;
}

/** "working, running a command", as list_bots says it. */
export function stateWords(eng: Engine, rt: BotRuntime): string {
  return shownWords(eng, rt);
}

const NOT_ALLOWED = "You may not steer other bots (the person, or the main bot when the person asks, can allow it), so it was queued instead.";

/** The sentence for a question that asked to be steered: it waits for a turn of its own. */
export function askNotSteered(rt: BotRuntime): string {
  return maySteerBots(rt) ? "A question is never steered (its answer is the last message of the turn it starts), so it was queued." : NOT_ALLOWED;
}

/**
 * message_bot with mode tell: queued as before, or with delivery steer (and the right) into the other
 * bot's running turn. The receipt says what the other bot was doing and how the message went.
 */
export async function tellBot(eng: Engine, rt: BotRuntime, target: BotRuntime, text: string, hops: number, delivery: "queue" | "steer"): Promise<ToolResult> {
  const name = target.folder.file.name;
  const was = `${name} was ${stateWords(eng, target)}.`;
  const from: UserItem["from"] = { type: "bot", botId: rt.folder.id, expectsReply: false };
  const allowed = delivery === "steer" && maySteerBots(rt);
  const steered: { done?: Promise<boolean> } = {};
  const item = eng.enqueue(target, text, from, { hops, ...(allowed ? { steer: true, steered } : {}) });
  const refused = delivery === "steer" && !allowed ? ` ${NOT_ALLOWED}` : "";
  if (steered.done) {
    const took = await steered.done;
    if (took) {
      // The message's chain counts in the turn it went into, so a chain of bots still stops at the limit.
      if (target.turn && target.turn.hops < hops) target.turn.hops = hops;
      return ok(`Steered into ${name}'s running turn: it reads it at its next step and is not expected to answer. ${was}`);
    }
    return ok(`${name} could not take it into its running turn just now, so it waits in line and is read when ${name} is free. ${was}`);
  }
  const cur = eng.store.getItem(item.id) as UserItem | undefined;
  if (cur && !cur.queued) return ok(`Delivered to ${name}, who was free and started on it at once. It is not expected to answer.${refused} ${was}`);
  const why = allowed ? ` It could not go into what ${name} is doing now (such as a run of a schedule, or a turn that is ending), so it waits in line.` : "";
  return ok(`Delivered to ${name}. It reads it when it is free and is not expected to answer.${why}${refused} ${was}`);
}
