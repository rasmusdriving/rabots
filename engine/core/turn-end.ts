// A turn's end: what follows it (next in line, waiting results, rest), and the fresh sessions with their tidy turns (docs/build/step-2d.md).
import { questionTurnEnds } from "./card-questions.js";
import { sessionWork } from "./aside.js";
import { flushNotes } from "./notes.js";
import type { Engine } from "../engine.js";
import { type BotRuntime, DEFAULT_WINDOW, inBackground, STOP_REFUSAL, TIDY_PROMPT, TIDY_REFUSAL, waitWords } from "./runtime.js";
import { closeBotItem, finishActivity } from "./harness-events.js";
import { withdrawCards } from "./cards.js";
import type { BotState, UserItem } from "../../shared/protocol.js";
import { clip, insideDir, iso, now } from "./words.js";
import { log } from "../log.js";
import { goLate, settleAsk } from "./asks.js";
import { forgetSession, saveTurnChanges } from "./bot-admin.js";
import { finishRun, idleActivity } from "./triggers.js";
import { finishChannelTurn, postFollowUp } from "./channels.js";
import { startTurn } from "./turn-start.js";
import { backInLine } from "./steering.js";
import { liveQueue, startNextInLine } from "./stop.js";
import { fullAt } from "../config.js";
import { TOOL_SERVER, type TurnUsage } from "../claude/session.js";
import { EngineError } from "../errors.js";
import { TIDY_ALLOWED_TOOLS } from "../team.js";
import { join } from "node:path";
import { pumpWakes } from "./start-helper.js";
import { sendTurnEnd, turnEnding } from "./live-turn.js";
import { tellAfterHelper } from "./helpers.js";

/** How long a bot shows "done" after a turn before it goes back to idle. */
export const DONE_MS = 3 * 60 * 1000;

/** How long an idle bot keeps its harness process before it sleeps. */
export const SLEEP_MS = 10 * 60 * 1000;

/** Rule 1 still begins when noticed late, as long as the cache lives at least this much longer. */
export const WARM_LATE_MS = 2 * 60 * 1000;

/** Rule 1 only applies to a cache that lives at least this long (the one hour kind). */
export const LONG_CACHE_MINUTES = 30;

/** The note a bot writes for itself in a tidy turn is clipped at this length. */
export const NOTE_MAX = 4000;

/** Built-in tools a tidy turn may use because they only read. Writes are let through only into the memory folder. */
export const TIDY_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

export const TIDY_WRITE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

export function finishTurn(eng: Engine, rt: BotRuntime, outcome: { ok: boolean; errors: string[]; subtype: string }): void {
  if (!rt.busy) return;
  clearTimeout(rt.interruptTimer);
  for (const key of [...rt.textItems.keys()]) closeBotItem(eng, rt, key);
  for (const tool of rt.tools.values()) finishActivity(eng, tool, "failed");
  eng.browser.endCommandsOf(rt.tools.keys());
  rt.tools.clear();
  rt.streamedKeys.clear();
  withdrawCards(eng, rt);

  const interrupted = rt.interruptRequested;
  const failed = !interrupted && (!outcome.ok || !!rt.turnError);
  if (rt.turn?.tidy) {
    finishTidy(eng, rt, interrupted, failed);
    return;
  }
  turnEnding(rt);
  let final: { state: BotState; activity: string };
  if (interrupted) {
    eng.notice(rt, "Stopped.", "info");
    final = { state: "done", activity: "Stopped" };
  } else if (failed) {
    if (!rt.turnError) {
      const sentence =
        outcome.subtype === "error_max_turns"
          ? "The bot stopped because it took too many steps in one go."
          : outcome.subtype === "error_max_budget_usd"
            ? "The bot stopped because it reached its spending limit."
            : `The bot stopped because of an error${outcome.errors[0] ? `: ${clip(outcome.errors[0], 200)}` : "."}`;
      if (outcome.errors.length) log.warn(`Bot ${rt.folder.id}: turn ended with errors`, outcome.errors);
      eng.notice(rt, sentence, "error");
    }
    final = { state: "blocked", activity: "Stopped by an error" };
  } else {
    final = { state: "done", activity: "Finished" };
  }
  // While helpers or its own commands still work in the background the bot is working, not done,
  // and nothing about its session changes.
  const helpersLeft = inBackground(rt);
  const startedBy = rt.turn?.startedBy;
  if (helpersLeft) {
    rt.afterHelpers = final;
    // "Finished" waits for what the helpers bring back (settleAfterHelpers), or for the turn that follows.
    rt.restNotice = interrupted ? undefined : { startedBy: startedBy ?? "you" };
    eng.setState(rt, "working", waitWords(rt));
  } else {
    rt.afterHelpers = undefined;
    rt.restNotice = undefined;
    eng.setState(rt, final.state, final.activity);
    // A stop is never told; a tidy turn left above. Only a turn the person started counts (the notifier checks).
    if (!interrupted) eng.notifier.cameToRest(rt.folder.id, failed ? "failed" : "finished", startedBy);
  }

  // The answer to an ask is the last thing the bot said in this turn.
  const turn = rt.turn;
  const name = rt.folder.file.name;
  if (turn?.ask) {
    if (interrupted) settleAsk(eng, turn.ask, { problem: `${name} was stopped before it answered.` });
    else if (failed && !turn.lastText) settleAsk(eng, turn.ask, { problem: `${name} ran into a problem and could not answer.` });
    else settleAsk(eng, turn.ask, { answer: turn.lastText || `${name} finished without writing an answer.` });
  }
  const origin = rt.current?.from;
  if (origin?.type === "connection" && origin.mode === "ask") {
    eng.links.reply(origin.id, origin.messageId, interrupted ? "The other main bot was stopped before it answered."
      : turn?.lastText || "The other main bot did not write an answer.");
  }
  // Engine 0.31.0: his questions about a card get this turn's last message as their answer.
  questionTurnEnds(eng, rt, turn?.id, turn?.lastText ?? "");
  // A turn the harness began when a helper reported back: a bot that waited for the first answer hears this one too.
  if (turn?.harness && turn.askFrom && turn.lastText && !interrupted) tellAfterHelper(eng, rt, turn.askFrom, turn.lastText, turn.hops);
  // Whatever this bot was still waiting for comes to it later as a message.
  for (const ask of eng.asks) if (ask.from === rt.folder.id && !ask.late) goLate(eng, ask);
  saveTurnChanges(eng, rt);
  // Whether its run is over and whether its session may close look at that session's own work: the
  // helpers of a session set aside keep nothing of this one waiting (core/aside.ts).
  const ownLeft = sessionWork(rt, rt.session);
  if (turn?.runId) {
    // A run is over when its helpers and what follows them have ended. Its result is the last message by then.
    const said = turn.lastText || (rt.pendingRun?.runId === turn.runId ? rt.pendingRun.lastText : "");
    if (ownLeft && !interrupted && !failed) {
      rt.pendingRun = { runId: turn.runId, threadId: turn.threadId, fresh: turn.fresh, ...(turn.runLabel ? { label: turn.runLabel } : {}), lastText: said };
    } else {
      rt.pendingRun = undefined;
      finishRun(eng, rt, { ...turn, lastText: said }, interrupted, failed);
    }
  }
  if (turn?.channelRid) {
    if (turn.harness) {
      if (!interrupted && !failed) postFollowUp(eng, rt, turn);
    } else finishChannelTurn(eng, rt, turn, interrupted, failed);
  }

  rt.busy = false;
  rt.current = undefined;
  rt.turn = undefined;
  rt.interruptRequested = false;
  rt.turnError = undefined;
  sendTurnEnd(eng, rt);
  // What the main bot changed in this turn: one note per bot it changed (core/notes.ts).
  flushNotes(eng, rt);
  // A fresh run's session ends with the run; its thread stays so the app can show it. Never while its helpers work.
  if (rt.restartAfterTurn || turn?.fresh) {
    if (ownLeft) rt.closeWhenCalm = true;
    else eng.closeSession(rt);
  }
  // A turn in the main chat lets a tidy turn that failed be tried again.
  if (turn && !turn.fresh && eng.store.getContext(rt.threadId).tidyBlockedAt) eng.store.setContext(rt.threadId, { tidyBlockedAt: null });
  afterTurn(eng, rt, turn && !turn.fresh && !interrupted && !failed);
}

/** What follows any turn: the next message in line, a tidy turn when the session is nearly full, or rest. */
export function afterTurn(eng: Engine, rt: BotRuntime, mainTurnEnded: boolean | undefined): void {
  // A steered message the turn ended before taking up comes first: the harness is running it already.
  if (rt.ahead?.length && !eng.stopping && !rt.busy) {
    const ids = rt.ahead;
    rt.ahead = undefined;
    const items = ids.map((id) => eng.store.getItem(id)).filter((i): i is UserItem => !!i && i.kind === "user");
    if (items.length && rt.session && !rt.session.closed) {
      void startTurn(eng, rt, items[0]!, { handed: true });
      // More than one: the harness takes them up together, so they go with that turn.
      for (const more of items.slice(1)) eng.putItem({ ...more, queued: false, turnId: rt.turn!.id });
      return;
    }
    // The session is gone with them: they wait in line, to be sent anew.
    backInLine(eng, rt, items.map((i) => i.id), "the session ended");
    if (rt.busy) return;
  }
  // A result that waited for the bot is told first, as the harness tells a helper's result.
  if (rt.wakes.length && !eng.stopping) {
    pumpWakes(eng, rt);
    if (rt.busy) return;
  }
  // The next message in line; messages held by a Stop stay waiting (step 3b, third part).
  if (startNextInLine(eng, rt)) return;
  // While anything works in the background nothing rests: the bot reads as done and its session may sleep once it has ended.
  if (inBackground(rt)) return;
  rt.doneTimer = setTimeout(() => {
    if (!rt.busy && (rt.state === "done" || rt.state === "blocked")) eng.setState(rt, "idle", idleActivity(eng, rt));
  }, DONE_MS);
  rt.doneTimer.unref();
  rt.sleepTimer = setTimeout(() => {
    if (!rt.busy && !inBackground(rt)) {
      eng.closeSession(rt);
      // Step 7b: the chat is set aside for now; its open session gets a title (again, once it grew).
      if (eng.bots.has(rt.folder.id)) eng.titles.addOpenMain(rt.folder.id, rt.threadId);
    }
  }, SLEEP_MS);
  rt.sleepTimer.unref();
  // Rule 2: nearly full right after a turn. The cache is warm, so tidy at once.
  if (mainTurnEnded && eng.ctxOf(rt).enabled) {
    const c = eng.store.getContext(rt.threadId);
    const window = c.window ?? DEFAULT_WINDOW;
    if (c.tokens >= fullAt(eng.ctxOf(rt), window) && !c.tidyBlockedAt) beginTidy(eng, rt, "nearly full");
  }
}

/**
 * A tidy turn ended. When it ended well with a note: the note is kept, the session is forgotten and
 * the harness stopped, so the next turn starts fresh, and one line marks the place in the chat.
 * Otherwise the session stays as it was, nothing is added to the chat, and the rules wait.
 */
export function finishTidy(eng: Engine, rt: BotRuntime, interrupted: boolean, failed: boolean): void {
  const turn = rt.turn!;
  const note = clip(turn.lastText, NOTE_MAX);
  // Something came back to work in the background during it (a helper the harness resumed): the
  // session must stay, so the tidy turn counts as not finished and the rules wait (review of step 3b).
  const behind = inBackground(rt) > 0;
  const good = !interrupted && !failed && !!note && !behind;
  saveTurnChanges(eng, rt);
  rt.busy = false;
  rt.current = undefined;
  rt.turn = undefined;
  rt.interruptRequested = false;
  rt.turnError = undefined;
  const back = rt.beforeTidy;
  rt.beforeTidy = undefined;
  if (good) {
    // The old session is dropped; an old Codex thread goes to Codex's archive.
    forgetSession(eng, rt.threadId);
    eng.closeSession(rt);
    eng.store.setContext(rt.threadId, { note, notePending: true, tokens: 0, since: now(), cache: null, sentAt: null, tidyBlockedAt: null });
    const fresh = eng.addItem(rt, { kind: "notice", at: now(), text: "Started fresh", tone: "info", mark: "fresh", detail: note, tidyTurnId: turn.id }, rt.threadId);
    // Step 7b: the session that ended here gets its title.
    eng.titles.addClosedMain(rt.folder.id, rt.threadId, fresh.seq);
    log.info(`Bot ${rt.folder.id}: wrote its note (${note.length} characters); the next turn starts in a fresh session`);
  } else {
    eng.store.setContext(rt.threadId, { tidyBlockedAt: iso(eng.clock()) });
    // A restart that waits is carried out once nothing works in the background (settleAfterHelpers).
    if (rt.restartAfterTurn && !behind) eng.closeSession(rt);
    const why = interrupted ? "it was stopped" : failed ? "it ended in an error" : behind ? "work in the background came back during it" : "it ended without a note";
    log.warn(`Bot ${rt.folder.id}: the tidy turn did not finish (${why}); the session stays as it was`);
  }
  // Back to how the bot looked before, without a done mark: this was not work the person asked for.
  const after = back && (back.state === "done" || back.state === "blocked") ? { state: back.state, activity: back.activity } : { state: "idle" as BotState, activity: idleActivity(eng, rt) };
  if (behind) {
    // Working while that runs; how it reads afterwards is how it read before.
    rt.afterHelpers = after;
    eng.setState(rt, "working", waitWords(rt));
  } else eng.setState(rt, after.state, after.activity);
  eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
  afterTurn(eng, rt, false);
}

/** Keeps what a turn's usage says about the session, and logs one line for the economy. */
export function noteUsage(eng: Engine, rt: BotRuntime, u: TurnUsage): void {
  const threadId = rt.sessionThread ?? rt.turn?.threadId ?? rt.threadId;
  const tokens = u.last.input + u.last.cacheRead + u.last.cacheWrite + u.last.output;
  const old = eng.store.getContext(threadId);
  const window = u.window ?? old.window ?? DEFAULT_WINDOW;
  eng.store.setContext(threadId, {
    tokens,
    window,
    ...(u.cache ? { cache: u.cache } : {}),
    sentAt: iso(eng.clock() - u.lastSentAgoMs),
  });
  const cache = u.cache ?? old.cache;
  const where = threadId === rt.threadId ? (rt.turn?.tidy ? "tidy turn" : "turn") : "fresh run";
  log.info(
    `Bot ${rt.folder.id}: ${where} ended. Session ${tokens} of ${window} tokens, cache read ${u.turn.cacheRead}, cache written ${u.turn.cacheWrite} (5m ${u.turn.write5m}, 1h ${u.turn.write1h}), cache life ${cache ?? "unknown"}, ${u.requests} request${u.requests === 1 ? "" : "s"}`,
  );
  if (threadId === rt.threadId && (old.tokens !== tokens || old.window !== window)) eng.opts.emit("bot.updated", { bot: eng.toBot(rt) });
}

/** Idle in the sense of the rules: no turn, nothing in line, no card of its own waiting (notes do not count). */
export function calm(eng: Engine, rt: BotRuntime): boolean {
  // Messages held by a Stop wait for the person, not for the bot: they do not keep it from being calm.
  if (rt.busy || liveQueue(eng, rt) || inBackground(rt) || rt.wakes.length || rt.lateCalls.size) return false;
  // A card that came back after a restart waits on no turn (engine 0.29.0).
  return ![...eng.cards.values()].some((p) => p.rt === rt && !p.restored && p.card.kind !== "note");
}

/** Begins a tidy turn in the main chat's session. Never twice, never during a turn. */
export function beginTidy(eng: Engine, rt: BotRuntime, why: string): boolean {
  if (!calm(eng, rt) || eng.stopping || !eng.harnessReady(rt) || !eng.bots.has(rt.folder.id)) return false;
  if (!eng.store.getThread(rt.threadId)?.sessionId) return false;
  log.info(`Bot ${rt.folder.id}: begins a tidy turn (${why})`);
  // Only a tidy turn that follows straight on a turn keeps that turn's mark (the person may not have
  // seen its answer yet). After any other, the bot is simply idle: a done mark would read as if the
  // tidy turn were work that finished (tester, step 2d).
  rt.beforeTidy = why === "nearly full" ? { state: rt.state, activity: rt.activity } : undefined;
  const item = eng.addItem(rt, { kind: "user", at: now(), text: TIDY_PROMPT, from: { type: "app", reason: "tidy" }, queued: false }, rt.threadId) as UserItem;
  void startTurn(eng, rt, item);
  return true;
}

/** bot.startFresh: a tidy turn now, whatever the size, when there is a session to tidy. */
export function startFresh(eng: Engine, botId: string): { started: boolean } {
  const rt = eng.bot(botId);
  if (rt.busy && rt.turn?.tidy) throw new EngineError("conflict", "The bot is already writing down what matters.");
  if (rt.busy) throw new EngineError("conflict", "The bot is working. Try again when it is done.");
  if ([...rt.helpers.values()].some((h) => !h.manager)) throw new EngineError("conflict", `${rt.folder.file.name}'s helpers are working. Try again when they are done.`);
  if (inBackground(rt)) throw new EngineError("conflict", `${rt.folder.file.name} is still working in the background. Try again when it is done.`);
  if (liveQueue(eng, rt)) throw new EngineError("conflict", "The bot has messages waiting. Try again when it is done.");
  if (!eng.store.getThread(rt.threadId)?.sessionId) return { started: false };
  eng.checkReady(rt);
  if (!beginTidy(eng, rt, "asked for")) throw new EngineError("conflict", "The bot is waiting for an answer from you. Try again when it is done.");
  return { started: true };
}

/**
 * The clock's look at each bot's session (rules 1 and 3; rule 2 is checked after each turn).
 * Rule 1: a long-lived cache is about to go cold and the session is big enough. Rule 3: the
 * session is big enough and has not been sent to the model for a long time.
 */
export function checkContext(eng: Engine): void {
  if (eng.stopping || !eng.store.isOpen) return;
  const at = eng.clock();
  for (const rt of eng.bots.values()) {
    // Per provider since step 7b.
    const cfg = eng.ctxOf(rt);
    if (!cfg.enabled || !calm(eng, rt)) continue;
    const c = eng.store.getContext(rt.threadId);
    if (c.tokens < cfg.minTokens || !c.sentAt) continue;
    if (!eng.store.getThread(rt.threadId)?.sessionId) continue;
    const age = at - Date.parse(c.sentAt);
    const life = (cfg.cacheMinutes ?? (c.cache === "1h" ? 60 : 5)) * 60_000;
    const blocked = c.tidyBlockedAt ? Date.parse(c.tidyBlockedAt) : undefined;
    const coldMs = cfg.coldHours * 3_600_000;
    // Rule 1 reads the cache's clock; a GPT bot has none to read (docs/context.md).
    if (rt.folder.file.harness !== "codex" && life >= LONG_CACHE_MINUTES * 60_000 && blocked === undefined && age >= life - cfg.warmMarginMinutes * 60_000 && age <= life - WARM_LATE_MS) {
      beginTidy(eng, rt, "before the cache goes cold");
    } else if (age >= coldMs && (blocked === undefined || at - blocked >= coldMs)) {
      beginTidy(eng, rt, "after a long quiet");
    }
  }
}

/**
 * In a tidy turn, only reading and writes in the memory folder go on. Everything else is refused
 * with a sentence and never a card. Outside tidy turns nothing is refused here.
 */
export function tidyGate(eng: Engine, rt: BotRuntime, toolName: string, input: Record<string, unknown>): string | undefined {
  // A turn the harness began by itself while a Stop holds does nothing, should it get as far as a tool.
  if (rt.swallow && !rt.busy) return STOP_REFUSAL;
  if (!rt.busy || !rt.turn?.tidy) return undefined;
  const own = new RegExp(`^mcp__${TOOL_SERVER}__(.+)$`).exec(toolName);
  if (own) return TIDY_ALLOWED_TOOLS.includes(own[1]!) ? undefined : TIDY_REFUSAL;
  if (TIDY_READ_TOOLS.has(toolName)) return undefined;
  const field = TIDY_WRITE_TOOLS[toolName];
  if (field && typeof input[field] === "string" && insideDir(rt.folder.dir, input[field] as string, join(rt.folder.dir, "memory"))) return undefined;
  return TIDY_REFUSAL;
}
