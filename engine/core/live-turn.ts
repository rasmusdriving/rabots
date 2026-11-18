// Engine 0.31.2 (docs/build/step-lost-reply.md): the bot says which turn runs now in its main chat
// (Bot.turnId), so the window gives each turn its own answer block, also a turn that began by itself.
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";

/** The last turn id the window was sent for each bot. */
const sent = new WeakMap<BotRuntime, string | undefined>();
/** Turns whose end has begun: the rest they set is sent without their id. */
const ending = new WeakSet<object>();

/** The turn running now in the bot's main chat; none between turns, in a fresh run's thread or in a tidy turn. */
export function liveTurnId(rt: BotRuntime): string | undefined {
  return rt.busy && rt.turn && rt.turn.threadId === rt.threadId && !rt.turn.tidy && !ending.has(rt.turn) ? rt.turn.id : undefined;
}

/** A turn's end begins (core/turn-end.ts): from now on the bot is sent without the turn's id. */
export function turnEnding(rt: BotRuntime): void {
  if (rt.turn) ending.add(rt.turn);
}

/** What toBot sends, noted so the end of the turn can be sent when nothing else changes. */
export function noteTurnSent(rt: BotRuntime, id: string | undefined): void {
  sent.set(rt, id);
}

/** After a turn ended: when its rest changed nothing the window sees, the bot is sent once more, without the turn's id. */
export function sendTurnEnd(eng: Engine, rt: BotRuntime): void {
  if (sent.get(rt) === undefined || liveTurnId(rt) !== undefined || eng.stopping || eng.bots.get(rt.folder.id) !== rt) return;
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}
