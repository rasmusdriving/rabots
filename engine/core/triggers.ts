// Triggers: schedules and webhooks that wake a bot, their runs, the webhook calls, and the schedule clock.
import type { Engine, HookOutcome, HookTarget } from "../engine.js";
import type { TriggerRow } from "../store.js";
import type { Methods, Trigger, TriggerRun, Upcoming } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { cleanPrompt, cleanSchedule, cleanTriggerName, dedupeKey, firstWords, HOOK_ALL_PER_MINUTE, HOOK_DEDUPE_MS, HOOK_PER_TRIGGER_PER_MINUTE, hookPath, isNothingToReport, LATE_LIMIT_MS, MAX_TRIGGERS, newSecret, sameSecret, webhookText } from "../triggers.js";
import { atWords, lastDue, nextAfter, whenWords } from "../schedule.js";
import { randomUUID } from "node:crypto";
import { iso, now } from "./words.js";
import { log } from "../log.js";
import type { BotRuntime, Turn } from "./runtime.js";
import { CHANNEL_PER_MINUTE } from "../channels.js";
import { heldWords } from "./stop.js";

/** The schedule clock looks again at least this often, so a sleeping Mac or a changed clock is noticed soon. */
export const TICK_MS = 30 * 1000;

/** A longer gap between two looks means the computer was asleep. */
export const SLEPT_MS = 2 * 60 * 1000;

/** The "Later today" list looks this far ahead, and holds at most this many runs. */
export const UPCOMING_MS = 24 * 60 * 60 * 1000;

export const UPCOMING_MAX = 20;

/** The activity line of an idle bot names its next run when it is within this time. */
export const NEXT_RUN_WORDS_MS = 7 * 24 * 60 * 60 * 1000;

/** Compared against when a webhook id is unknown, so a wrong id takes as long as a wrong secret. */
export const NO_SECRET = "x".repeat(43);

export function toTrigger(eng: Engine, row: TriggerRow): Trigger {
  const last = eng.store.lastRun(row.id);
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    name: row.name,
    prompt: row.prompt,
    where: row.where,
    enabled: row.enabled,
    ...(row.schedule ? { schedule: row.schedule } : {}),
    ...(row.kind === "schedule" && row.enabled && row.nextAt ? { nextAt: row.nextAt } : {}),
    ...(last ? { lastRun: last } : {}),
    createdBy: row.createdBy,
    // An older trigger made by a bot has no maker noted: it made it itself.
    ...(row.createdBy === "bot" ? { madeByBotId: row.madeByBotId ?? row.botId } : {}),
  };
}

export function triggerOf(eng: Engine, triggerId: string): TriggerRow {
  const row = eng.store.getTrigger(triggerId);
  if (!row || !eng.bots.has(row.botId)) throw new EngineError("not_found", "There is no trigger with that id.");
  return row;
}

export function listTriggers(eng: Engine, botId: string): Trigger[] {
  eng.bot(botId);
  return eng.store.listTriggers(botId).map((row) => toTrigger(eng, row));
}

/** Creates or changes a trigger. `createdBy` is "bot" when a bot made it with its own tool. */
export function saveTrigger(eng: Engine, params: Methods["trigger.save"]["params"], createdBy: Trigger["createdBy"] = "you", madeByBotId?: string): Trigger {
  const rt = eng.bot(params.botId);
  const t = params.trigger;
  const at = eng.clock();
  const name = cleanTriggerName(t.name);
  const prompt = cleanPrompt(t.prompt);
  let existing: TriggerRow | undefined;
  if (t.id !== undefined) {
    existing = eng.store.getTrigger(t.id);
    if (!existing || existing.botId !== rt.folder.id) throw new EngineError("not_found", "There is no trigger with that id.");
    if (existing.kind !== t.kind) throw new EngineError("bad_request", "A trigger cannot change between a schedule and a webhook. Make a new one instead.");
  } else if (eng.store.listTriggers(rt.folder.id).length >= MAX_TRIGGERS) {
    throw new EngineError("bad_request", `A bot can have at most ${MAX_TRIGGERS} triggers. Remove one first.`);
  }
  let schedule: TriggerRow["schedule"];
  if (t.kind === "schedule") {
    if (!t.schedule) throw new EngineError("bad_request", "Say when the schedule runs.");
    schedule = cleanSchedule(t.schedule, at, t.enabled);
  } else if (t.schedule) {
    throw new EngineError("bad_request", "A webhook runs when its address is called, so it has no schedule.");
  }
  const next = schedule && t.enabled ? nextAfter(schedule, at, eng.tz) : undefined;
  const row: TriggerRow = {
    id: existing?.id ?? randomUUID(),
    botId: rt.folder.id,
    kind: t.kind,
    name,
    prompt,
    where: t.where,
    enabled: t.enabled,
    ...(schedule ? { schedule } : {}),
    ...(t.kind === "webhook" ? { secret: existing?.secret ?? newSecret() } : {}),
    ...(next !== undefined ? { nextAt: iso(next) } : {}),
    createdBy: existing?.createdBy ?? createdBy,
    ...((existing ? existing.madeByBotId : madeByBotId) ? { madeByBotId: existing ? existing.madeByBotId : madeByBotId } : {}),
    createdAt: existing?.createdAt ?? now(),
  };
  if (existing) eng.store.updateTrigger(row);
  else eng.store.addTrigger(row);
  log.info(`Bot ${rt.folder.id}: ${existing ? "changed" : "made"} the ${row.kind} ${row.id}`);
  return afterTriggerChange(eng, row);
}

export function removeTrigger(eng: Engine, triggerId: string): void {
  const row = triggerOf(eng, triggerId);
  eng.store.removeTrigger(row.id);
  eng.opts.emit("trigger.changed", { botId: row.botId, removedId: row.id });
  afterTriggersMoved(eng);
  log.info(`Bot ${row.botId}: removed the ${row.kind} ${row.id}`);
}

/** Fires a trigger now, whatever its schedule, also when it is switched off. */
export function runTrigger(eng: Engine, triggerId: string): TriggerRun {
  const row = triggerOf(eng, triggerId);
  return fire(eng, row, row.kind === "webhook" ? { has: false } : undefined);
}

export function triggerRuns(eng: Engine, params: Methods["trigger.runs"]["params"]): Methods["trigger.runs"]["result"] {
  const row = triggerOf(eng, params.triggerId);
  const res = eng.store.listRuns(row.id, params.before, params.limit ?? 30);
  if (!res) throw new EngineError("not_found", "There is no such run for this trigger.");
  return res;
}

/** A webhook's address. Works like a password: only on request, never in an event, never logged. */
export function triggerAddress(eng: Engine, triggerId: string): Methods["trigger.address"]["result"] {
  const row = triggerOf(eng, triggerId);
  if (row.kind !== "webhook" || !row.secret) throw new EngineError("bad_request", "Only a webhook has an address.");
  return address(eng, hookPath(row.id, row.secret));
}

/** A new secret for a webhook. The old address stops working at once. */
export function newAddress(eng: Engine, triggerId: string): Methods["trigger.newAddress"]["result"] {
  const row = triggerOf(eng, triggerId);
  if (row.kind !== "webhook") throw new EngineError("bad_request", "Only a webhook has an address.");
  row.secret = newSecret();
  eng.store.updateTrigger(row);
  log.info(`Bot ${row.botId}: the webhook ${row.id} has a new address`);
  afterTriggerChange(eng, row);
  return address(eng, hookPath(row.id, row.secret));
}

/** Switches a trigger on or off and nothing else. A schedule gets its next time again when switched on. */
export function enableTrigger(eng: Engine, triggerId: string, enabled: boolean): Trigger {
  const row = triggerOf(eng, triggerId);
  if (row.enabled === enabled) return toTrigger(eng, row);
  if (row.kind === "schedule" && row.schedule) {
    const at = eng.clock();
    if (enabled) {
      cleanSchedule(row.schedule, at, true);
      const next = nextAfter(row.schedule, at, eng.tz);
      if (next === undefined) delete row.nextAt;
      else row.nextAt = iso(next);
    } else delete row.nextAt;
  }
  row.enabled = enabled;
  eng.store.updateTrigger(row);
  log.info(`Bot ${row.botId}: switched the ${row.kind} ${row.id} ${enabled ? "on" : "off"}`);
  return afterTriggerChange(eng, row);
}

export function address(eng: Engine, path: string): { hookPath: string; publicBase?: string } {
  const base = eng.opts.config.publicBase;
  return { hookPath: path, ...(base ? { publicBase: base } : {}) };
}

export function afterTriggerChange(eng: Engine, row: TriggerRow): Trigger {
  const trigger = toTrigger(eng, row);
  eng.opts.emit("trigger.changed", { botId: row.botId, trigger });
  afterTriggersMoved(eng);
  return trigger;
}

/** Next times, the "Later today" list and the idle bots' activity lines follow a change. */
export function afterTriggersMoved(eng: Engine): void {
  refreshUpcoming(eng);
  refreshIdle(eng);
  planTick(eng);
}

/**
 * Starts a run of a trigger. A main run is a message in the bot's main thread; a fresh run is a
 * message in a new thread of its own. Either wakes the bot or waits in line like any message.
 */
export function fire(eng: Engine, row: TriggerRow, data?: { has: boolean; value?: unknown }): TriggerRun {
  const rt = eng.bot(row.botId);
  const base = { id: randomUUID(), triggerId: row.id, botId: row.botId, at: iso(eng.clock()) };
  if (!eng.harnessReady(rt) || eng.stopping) {
    return recordRun(eng, { ...base, status: "failed", note: "Claude is not ready on this computer, so the run could not start" });
  }
  if (row.kind === "schedule" && eng.store.runningRun(row.id)) {
    return recordRun(eng, { ...base, status: "skipped", note: "The last run was still going" });
  }
  const text = row.kind === "webhook" ? webhookText(row.prompt, data ?? { has: false }) : row.prompt;
  const threadId = row.where === "fresh" ? eng.store.createThread(row.botId, "run").id : rt.threadId;
  const itemId = randomUUID();
  const run = recordRun(eng, { ...base, status: "running", threadId }, itemId);
  log.info(`Bot ${row.botId}: the ${row.kind} ${row.id} fired${row.where === "fresh" ? " as a fresh run" : ""}`);
  eng.enqueue(rt, text, { type: "trigger", label: row.name, triggerId: row.id, runId: base.id }, { threadId, itemId });
  return eng.store.getRun(run.id) ?? run;
}

export function recordRun(eng: Engine, run: TriggerRun, itemId?: string): TriggerRun {
  eng.store.addRun(run, itemId);
  emitRun(eng, run);
  return run;
}

export function saveRun(eng: Engine, run: TriggerRun): void {
  eng.store.updateRun(run);
  emitRun(eng, run);
}

export function emitRun(eng: Engine, run: TriggerRun): void {
  eng.opts.emit("trigger.run", { run });
  const row = eng.store.getTrigger(run.triggerId);
  if (row) eng.opts.emit("trigger.changed", { botId: row.botId, trigger: toTrigger(eng, row) });
}

/** Ends the run a user item would have started or did start, if it is still going. */
export function endRunOfItem(eng: Engine, itemId: string, status: "failed", note: string): void {
  const run = eng.store.runByItem(itemId);
  if (run && run.status === "running") saveRun(eng, { ...run, status, note });
}

export function triggerKindWord(eng: Engine, run: TriggerRun | undefined): string {
  const kind = run ? eng.store.getTrigger(run.triggerId)?.kind : undefined;
  return kind ?? "trigger";
}

/** A trigger's turn ended: the run gets its outcome, and a fresh run's result goes to the main chat. */
export function finishRun(eng: Engine, rt: BotRuntime, turn: Turn, interrupted: boolean, failed: boolean): void {
  const run = turn.runId ? eng.store.getRun(turn.runId) : undefined;
  if (!run || run.status !== "running") return;
  const label = turn.runLabel ?? (rt.current?.from.type === "trigger" ? rt.current.from.label : "the trigger");
  const said = turn.lastText.trim();
  let next: TriggerRun;
  if (interrupted) next = { ...run, status: "failed", note: "Stopped before it finished" };
  else if (failed) next = { ...run, status: "failed", note: firstWords(turn.errorText ?? "The run ended in an error") };
  else if (turn.fresh && isNothingToReport(said)) next = { ...run, status: "silent", note: "Nothing to report" };
  else next = { ...run, status: "done", note: said ? firstWords(said) : "Finished without a reply" };
  // Step 7b: a fresh run's own thread gets its title.
  if (turn.fresh && turn.threadId !== rt.threadId) eng.titles.add({ threadId: turn.threadId, botId: rt.folder.id, kind: "run", fromSeq: 0 });
  if (next.status === "done" && turn.fresh && said) {
    // Shown to the person and part of what the bot sees next time, but it does not start a turn.
    const item = eng.addItem(rt, { kind: "user", at: now(), text: `Result of ${label}:\n\n${said}`, from: { type: "trigger", label, triggerId: run.triggerId, runId: run.id, result: true }, queued: false }, rt.threadId);
    eng.store.addUnseen(item.id, rt.folder.id);
  }
  saveRun(eng, next);
}

/**
 * Where a hook address leads: a webhook or a channel that is on, or nowhere. The secret is compared
 * in constant time (against a stand-in when the id is unknown); nothing about why not is told.
 */
export function hookTarget(eng: Engine, id: string, secret: string): HookTarget | undefined {
  const okId = /^[0-9a-f-]{36}$/i.test(id);
  const trigger = okId ? eng.store.getTrigger(id) : undefined;
  const channel = okId && !trigger ? eng.store.getChannel(id) : undefined;
  const expected = trigger?.kind === "webhook" && trigger.secret ? trigger.secret : channel ? channel.secret : NO_SECRET;
  const same = sameSecret(secret, expected);
  if (!same || eng.stopping) return undefined;
  if (trigger) return trigger.kind === "webhook" && trigger.enabled && eng.bots.has(trigger.botId) ? "trigger" : undefined;
  if (channel) return channel.enabled ? "channel" : undefined;
  return undefined;
}

/** Kept for the step 2b callers: is this the address of a webhook that is on? */
export function hookAllowed(eng: Engine, triggerId: string, secret: string): boolean {
  return eng.hookTarget(triggerId, secret) === "trigger";
}

/**
 * Counts a wrong call to /hook/. At most 60 a minute for all hooks together; after that, wrong calls
 * get 429 for the rest of that minute. Returns the seconds to wait, or 0 when within the limit.
 */
export function wrongHookCall(eng: Engine): number {
  return eng.wrongHooks.take(Date.now());
}

/** Counts a call against the limits: per webhook or channel (30 a minute), and 120 a minute for all hooks together. */
export function hookWithinLimits(eng: Engine, id: string, kind: HookTarget = "trigger"): boolean {
  const at = Date.now();
  const per = kind === "channel" ? CHANNEL_PER_MINUTE : HOOK_PER_TRIGGER_PER_MINUTE;
  if (!eng.hookLimits.fits("*", HOOK_ALL_PER_MINUTE, at) || !eng.hookLimits.fits(id, per, at)) return false;
  eng.hookLimits.take("*", HOOK_ALL_PER_MINUTE, at);
  eng.hookLimits.take(id, per, at);
  return true;
}

/** A webhook call that passed the checks. Never waits for the bot. */
export function hookCall(eng: Engine, triggerId: string, data: { has: boolean; value?: unknown }, dedupe?: string): HookOutcome {
  const row = eng.store.getTrigger(triggerId);
  if (!row || row.kind !== "webhook" || !row.enabled || !eng.bots.has(row.botId)) return { status: 404 };
  const at = Date.now();
  const key = dedupe !== undefined && dedupe !== "" ? dedupeKey(dedupe) : undefined;
  if (key && eng.store.hookSeen(row.id, key, at, HOOK_DEDUPE_MS)) return { status: 200, duplicate: true };
  const run = fire(eng, row, data);
  if (run.status === "failed") return { status: 503 };
  if (key) eng.store.addHookCall(row.id, key, at);
  return { status: 202, runId: run.id };
}

/**
 * Fires what is due. A schedule that was due while Pobots was not running (or the computer slept)
 * runs once, late, when that was at most an hour ago, and is otherwise recorded as skipped. Never a
 * backlog. Called on a short timer that is planned again from the clock each time.
 */
export function checkSchedules(eng: Engine): void {
  if (eng.stopping || !eng.store.isOpen) return;
  const at = eng.clock();
  const firstLook = eng.lastCheck === undefined;
  const slept = !firstLook && at - eng.lastCheck! > SLEPT_MS;
  eng.lastCheck = at;
  for (const row of eng.store.listTriggers()) {
    if (row.kind !== "schedule" || !row.enabled || !row.nextAt || !row.schedule || !eng.bots.has(row.botId)) continue;
    const due = Date.parse(row.nextAt);
    if (!(due <= at)) continue;
    const last = lastDue(row.schedule, due, at, eng.tz);
    if (at - last <= LATE_LIMIT_MS) fire(eng, row);
    else {
      const why = slept ? "The computer was asleep" : "Pobots was not running";
      recordRun(eng, { id: randomUUID(), triggerId: row.id, botId: row.botId, at: iso(at), status: "skipped", note: `${why} ${atWords(last, at, eng.tz)}` });
    }
    const updated = eng.store.getTrigger(row.id) ?? row;
    if (row.schedule.type === "once") {
      updated.enabled = false;
      delete updated.nextAt;
    } else {
      const next = nextAfter(row.schedule, at, eng.tz);
      if (next === undefined) delete updated.nextAt;
      else updated.nextAt = iso(next);
    }
    eng.store.updateTrigger(updated);
    eng.opts.emit("trigger.changed", { botId: row.botId, trigger: toTrigger(eng, updated) });
  }
  afterTriggersMoved(eng);
  // The nightly backup: its own clock beside the schedules (past 03:00 and nothing made since: now, once).
  try {
    eng.backup.tick(at);
  } catch (err) {
    log.error("Could not look at the backup", err);
  }
  try {
    eng.checkContext();
  } catch (err) {
    log.error("Could not look at the bots' sessions", err);
  }
  // Files of artifacts changed outside a turn (by hand, or by a process the bot left running).
  try {
    eng.checkArtifacts();
  } catch (err) {
    log.error("Could not look at the bots' artifacts", err);
  }
}

/** The next look at the schedules: at the next due time, and at least every 30 seconds. */
export function planTick(eng: Engine): void {
  clearTimeout(eng.tickTimer);
  if (eng.stopping || !eng.store.isOpen) return;
  const at = eng.clock();
  let delay = TICK_MS;
  for (const row of eng.store.listTriggers()) {
    if (row.kind === "schedule" && row.enabled && row.nextAt) delay = Math.min(delay, Date.parse(row.nextAt) - at);
  }
  const backupAt = eng.backup.nextLook(at);
  if (backupAt !== undefined) delay = Math.min(delay, backupAt - at);
  eng.tickTimer = setTimeout(() => eng.checkSchedules(), Math.max(250, delay));
  eng.tickTimer.unref();
}

export function upcoming(eng: Engine): Upcoming[] {
  return eng.upcomingList;
}

/** The next run of each schedule that fires within 24 hours, soonest first, at most 20. One per trigger, so a frequent one cannot crowd out the rest. */
export function computeUpcoming(eng: Engine): Upcoming[] {
  const at = eng.clock();
  const end = at + UPCOMING_MS;
  const out: Upcoming[] = [];
  for (const row of eng.store.listTriggers()) {
    if (row.kind !== "schedule" || !row.enabled || !row.nextAt || !row.schedule || !eng.bots.has(row.botId)) continue;
    const t = Date.parse(row.nextAt);
    if (t < end) out.push({ at: iso(t), botId: row.botId, triggerId: row.id, name: row.name });
  }
  out.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
  return out.slice(0, UPCOMING_MAX);
}

export function refreshUpcoming(eng: Engine): void {
  const list = computeUpcoming(eng);
  if (JSON.stringify(list) === JSON.stringify(eng.upcomingList)) return;
  eng.upcomingList = list;
  eng.opts.emit("upcoming.updated", { upcoming: list });
}

/** "Next run today 16:30" for a bot with a schedule coming, or nothing. */
export function idleActivity(eng: Engine, rt: BotRuntime): string {
  const held = heldWords(eng, rt);
  if (held) return held;
  const at = eng.clock();
  let soonest: number | undefined;
  for (const row of eng.store.listTriggers(rt.folder.id)) {
    if (row.kind !== "schedule" || !row.enabled || !row.nextAt) continue;
    const t = Date.parse(row.nextAt);
    if (soonest === undefined || t < soonest) soonest = t;
  }
  if (soonest === undefined || soonest - at > NEXT_RUN_WORDS_MS) return "";
  return `Next run ${whenWords(Math.max(soonest, at), at, eng.tz)}`;
}

export function refreshIdle(eng: Engine): void {
  for (const rt of eng.bots.values()) if (!rt.busy && rt.state === "idle") eng.setState(rt, "idle", idleActivity(eng, rt));
}
