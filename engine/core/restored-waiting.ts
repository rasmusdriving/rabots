// Engine 0.31.1: a bot with a restored card reads Waiting for you (docs/build/step-restored-waiting.md).
//
// Following T3 Code's Sidebar.logic.ts (resolveThreadStatusPill): a thread's status comes from what
// is pending first (an approval, a question) and only then from its runtime; a request that survived
// a restart (ProviderRuntimeRecoveryService.ts) is still pending. Pobots differs on one point: while
// the bot works, Working wins.
//
// Only what is shown changes. The bot's own rt.state stays "idle" or "done", so the live update,
// notifications, helpers and the harness events still see a bot at rest.
import type { Engine } from "../engine.js";
import type { BotState } from "../../shared/protocol.js";
import { type BotRuntime, inBackground } from "./runtime.js";
import { heldWords } from "./stop.js";

export interface Shown {
  state: BotState;
  activity: string;
  /** True when the bot reads "waiting" only for a card that waits on no turn. */
  atRest?: true;
}

/** The newest open approval or question of this bot that waits on no call: one that came back after a restart, or one parked by a question on it. */
function restWaitCard(eng: Engine, rt: BotRuntime): "approval" | "question" | undefined {
  let kind: "approval" | "question" | undefined;
  let at = "";
  for (const p of eng.cards.values()) {
    if (p.rt !== rt || !p.restored || p.manager || p.helper) continue;
    const card = p.card;
    if (card.kind !== "approval" && card.kind !== "question") continue;
    if (card.taskManager !== undefined) continue;
    if (kind === undefined || card.at >= at) {
      kind = card.kind;
      at = card.at;
    }
  }
  return kind;
}

/** What the window, the phone and Po see of the bot's state. */
export function shown(eng: Engine, rt: BotRuntime): Shown {
  const own: Shown = { state: rt.state, activity: rt.activity };
  // In a turn the state is thinking, working or waiting; "done" or "idle" means at rest. A turn's end
  // sets its rest while the turn still counts as running (core/turn-end.ts), so this does not look at
  // busy: the bot goes from Working straight to Waiting, with no Finished in between.
  if (rt.state !== "idle" && rt.state !== "done") return own;
  if (inBackground(rt) > 0 || rt.turn?.tidy) return own;
  // Messages held by a Stop keep their own line ("Stopped, 1 message waiting"): the window offers
  // them from it, and the card still stands in Needs you.
  if (heldWords(eng, rt)) return own;
  const kind = restWaitCard(eng, rt);
  if (!kind) return own;
  return { state: "waiting", activity: kind === "approval" ? "Waiting for your approval" : "Waiting for your answer", atRest: true };
}

/** "working, running a command", as Po's tools say it. */
export function shownWords(eng: Engine, rt: BotRuntime): string {
  const s = shown(eng, rt);
  return s.activity ? `${s.state}, ${s.activity.toLowerCase()}` : s.state;
}

const lastSent = new WeakMap<BotRuntime, string>();

function keyOf(s: Shown): string {
  return `${s.state}\u0000${s.activity}\u0000${s.atRest ? 1 : 0}`;
}

/** Called from toBot: what the clients were last sent for this bot. */
export function noteSent(rt: BotRuntime, s: Shown): void {
  lastSent.set(rt, keyOf(s));
}

/**
 * Sends the bot again when what it shows changed without its own state changing: a restored card
 * came, or went. Called after the card's answer has been handed on, so an answer that starts a turn
 * has already sent "thinking" and the window never sees Idle in between.
 */
export function restWaitChanged(eng: Engine, rt: BotRuntime): void {
  if (eng.bots.get(rt.folder.id) !== rt) return;
  const before = lastSent.get(rt);
  const now = shown(eng, rt);
  // Never sent yet (at start-up): only a bot that now reads Waiting needs it.
  if (before === keyOf(now) || (before === undefined && !now.atRest)) return;
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}
