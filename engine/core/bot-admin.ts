// Bots: making, changing, switching, retiring and stopping a bot; its files, its history of changes, and its saved rules.
import { closeAllSessions } from "./aside.js";
import type { Engine } from "../engine.js";
import type { Bot, BotChange, BotFile as ProtocolBotFile, Harness, Methods, SavedRule } from "../../shared/protocol.js";
import { changedSummary, cleanName, cleanPurpose, now } from "./words.js";
import { EngineError } from "../errors.js";
import { archiveBotFolder, archivedIds, type BotFile, type BotFolder, createBotFolder, DEFAULT_ACCESS, DEFAULT_EFFORT, DEFAULT_MODEL, pickColor, pickLook, uniqueSlug, writeBotFile } from "../bots.js";
import { readdirSync } from "node:fs";
import { startWelcome } from "./first-start.js";
import { log } from "../log.js";
import { type BotRuntime, inBackground, newRuntime, SWITCH_WORDS } from "./runtime.js";
import { endAllTaskManagers } from "./task-managers.js";
import { cleanSees } from "../claude/sees.js";
import { codexArchiveThread } from "../codex/detect.js";
import { type ChangeBy, changeStatus, commitExists, GitError, hasRepo, isFirstChange, listChanges, readChange as historyReadChange, saveAll, savePaths, undoChange as historyUndoChange } from "../history.js";
import { emitChannel, endChannelOfItem } from "./channels.js";
import { endRunOfItem, refreshUpcoming } from "./triggers.js";
import { removeCard } from "./cards.js";
import { settleAsk } from "./asks.js";
import { deleteTextFile, listFiles as filesListFiles, readTextFile, writeTextFile } from "../files.js";
import { ruleLabel } from "../rules.js";
import { saveHold } from "./stop.js";
import { closeBotItem, finishActivity } from "./harness-events.js";
import { cancelSettle } from "./helpers.js";

/**
 * A bot on a model the list lacked (an older GPT model, say) adds it to the list. The window learns
 * its model list only from a snapshot or "status.updated", so the list goes out again when it changed:
 * before the bot itself, so the window knows the model (and its fast mode) when the bot arrives.
 */
export function tellModelsIfChanged(eng: Engine, before: string): void {
  const models = eng.modelList();
  if (JSON.stringify(models) !== before) eng.opts.emit("status.updated", { status: eng.status(), models });
}

export function createBot(eng: Engine, params: Methods["bot.create"]["params"] | string): Bot {
  const modelsBefore = JSON.stringify(eng.modelList());
  const p = typeof params === "string" ? { name: params } : params;
  const clean = cleanName(p.name);
  const purpose = cleanPurpose(p.purpose);
  const mayMessage = checkMayMessage(eng, p.mayMessage ?? [], undefined);
  const job = p.job?.trim() ?? "";
  if (job.length > 20000) throw new EngineError("bad_request", "The job is too long. Keep it under 20,000 characters.");
  const taken = new Set<string>([...eng.bots.keys(), ...archivedIds(eng.opts.config.botsDir)]);
  try {
    for (const entry of readdirSync(eng.opts.config.botsDir)) taken.add(entry.toLowerCase());
  } catch {
    // the folder is created at start-up; if it vanished, createBotFolder reports it
  }
  const id = uniqueSlug(clean, taken);
  const model = p.model?.trim() || DEFAULT_MODEL;
  eng.checkProviderOn(eng.harnessOf(model));
  const file: BotFile = {
    name: clean,
    role: eng.bots.size === 0 ? "main" : "bot",
    purpose,
    look: {
      ...(p.look ? { eyes: p.look.eyes, gap: p.look.gap } : pickLook([...eng.bots.values()].map((b) => b.folder.file.look))),
      color: p.look?.color ?? pickColor([...eng.bots.values()].map((b) => b.folder.file.look.color)),
    },
    harness: eng.harnessOf(model),
    model,
    effort: p.effort ?? DEFAULT_EFFORT,
    fast: p.fast ?? true,
    access: p.access ?? DEFAULT_ACCESS,
    machine: eng.machine.id,
    mayMessage,
  };
  let folder: BotFolder;
  try {
    folder = createBotFolder(eng.opts.config.botsDir, id, file, job || undefined);
  } catch (err) {
    log.error(`Could not create the folder for bot ${id}`, err);
    throw new EngineError("internal", "The bot's folder could not be created.");
  }
  eng.store.setMark(`old-rules:${id}`);
  const thread = eng.store.mainThread(id) ?? eng.store.createThread(id);
  const rt = newRuntime(folder, thread.id);
  eng.bots.set(id, rt);
  eng.order.push(id);
  const bot = eng.toBot(rt);
  tellModelsIfChanged(eng, modelsBefore);
  eng.opts.emit("bot.added", { bot });
  log.info(`Created bot ${id}`);
  // The first-start screen's main bot greets the person by itself (engine 0.33.0).
  if (p.welcome && file.role === "main") startWelcome(eng, rt);
  return bot;
}

/** Ids of existing bots other than `self`, without repeats. Anything else is refused in plain words. */
export function checkMayMessage(eng: Engine, ids: string[], self: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === self) throw new EngineError("bad_request", "A bot does not need itself on its own list.");
    if (!eng.bots.has(id)) throw new EngineError("bad_request", "That list names a bot that does not exist.");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export async function updateBot(eng: Engine, params: Methods["bot.update"]["params"]): Promise<Bot> {
  const modelsBefore = JSON.stringify(eng.modelList());
  const rt = eng.bot(params.botId);
  const f = rt.folder.file;
  const p = params.patch;
  const before = { ...f, mayMessage: [...f.mayMessage] };
  const name = p.name !== undefined ? cleanName(p.name) : undefined;
  const purpose = p.purpose !== undefined ? cleanPurpose(p.purpose) : undefined;
  const may = p.mayMessage !== undefined ? checkMayMessage(eng, p.mayMessage, rt.folder.id) : undefined;
  // A model of the other harness (step 3a): refused while the bot works, or when that harness is not there.
  const nextModel = p.model !== undefined && p.model.trim() ? p.model.trim() : undefined;
  const nextHarness = nextModel ? eng.harnessOf(nextModel) : f.harness;
  const switching = nextHarness !== f.harness;
  if (switching) eng.checkProviderOn(nextHarness);
  if (switching) {
    if (rt.busy || inBackground(rt)) throw new EngineError("conflict", "Wait until the bot is done, then change its model.");
    if (nextHarness === "codex" && !eng.codex.ready) await eng.recheckCodex();
    const ready = nextHarness === "codex" ? eng.codex.ready : eng.opts.claude.ready;
    if (!ready) {
      const why = nextHarness === "codex" ? eng.codex.problem ?? "Codex is not ready on this computer." : eng.opts.claude.problem ?? "Claude is not ready on this computer.";
      throw new EngineError("harness_unavailable", why);
    }
  }
  if (name !== undefined) f.name = name;
  if (purpose !== undefined) f.purpose = purpose;
  if (may !== undefined) f.mayMessage = may;
  // 15 Nov 2026: may steer other bots. The main bot always may, so it keeps no setting.
  if (p.maySteer !== undefined && f.role !== "main") {
    if (p.maySteer) f.maySteer = true;
    else delete f.maySteer;
  }
  // 16 Nov 2026: the calendar tools. Kept as set, so the main bot can have them off too.
  const calendarBefore = f.calendar ?? f.role === "main";
  if (p.calendar !== undefined) f.calendar = p.calendar;
  const calendarChanged = (f.calendar ?? f.role === "main") !== calendarBefore;
  if (nextModel !== undefined) {
    f.model = nextModel;
    f.harness = nextHarness;
  }
  if (p.effort !== undefined) f.effort = p.effort;
  // Taken for any model; it has an effect only while the model has a fast mode (step 3b).
  if (p.fast !== undefined) f.fast = p.fast;
  if (p.access !== undefined) f.access = p.access;
  if (p.look !== undefined) f.look = { eyes: p.look.eyes, gap: p.look.gap, ...((p.look.color ?? f.look.color) ? { color: p.look.color ?? f.look.color } : {}) };
  // Step 7b: the bot's own choice for a message sent while it works, or back to the Pobots default.
  if (p.followUp !== undefined) {
    if (p.followUp === null) delete f.followUp;
    else f.followUp = p.followUp;
  }
  // What the bot sees (docs/sees.md): cleaned, or (null, or nothing left) back to everything.
  const seesBefore = JSON.stringify(f.sees ?? null);
  if (p.sees !== undefined) {
    const sees = p.sees === null ? undefined : cleanSees(p.sees);
    if (sees) f.sees = sees;
    else delete f.sees;
  }
  const seesChanged = JSON.stringify(f.sees ?? null) !== seesBefore;
  try {
    writeBotFile(rt.folder.dir, f);
  } catch (err) {
    Object.assign(f, before);
    log.error(`Could not save the settings of bot ${rt.folder.id}`, err);
    throw new EngineError("internal", "The bot's settings could not be saved.");
  }

  if (switching) {
    switchHarness(eng, rt, before.harness, nextHarness);
    const bot = eng.toBot(rt);
    tellModelsIfChanged(eng, modelsBefore);
    eng.opts.emit("bot.updated", { bot });
    return bot;
  }
  // Live changes where the harness allows them. A failure means the change waits for a new session.
  const s = rt.session;
  if (s && !s.closed) {
    const changes: Promise<void>[] = [];
    if (f.effort !== before.effort) changes.push(s.setEffort(f.effort));
    if (f.access !== before.access) changes.push(s.setAccess(f.access));
    // Fast mode from the next turn in the same session: when the choice changed, or the model (within Codex) did.
    const fast = eng.runsFast(f);
    if (s.setFast && (fast !== eng.runsFast(before) || (f.model !== before.model && f.harness === "codex"))) changes.push(s.setFast(fast));
    const results = await Promise.allSettled(changes);
    // A new model needs a new harness process on the same session: which tools the harness offers
    // depends on the model (the smallest has no tool to publish an artifact), and a running
    // process keeps the list it started with (seen in step 2f).
    if (f.model !== before.model || results.some((r) => r.status === "rejected")) {
      for (const r of results) if (r.status === "rejected") log.warn(`Bot ${rt.folder.id}: a live settings change failed`, r.reason);
      eng.refreshSession(rt);
    }
  }
  // A session takes the choice when it starts: the same conversation in a new process, from the next
  // message. A Codex thread is resumed with the new thread settings (docs/build/step-gpt-bot-sees.md).
  if (seesChanged) eng.refreshSession(rt);
  // The calendar tools come or go with a new session, from the next turn.
  if (calendarChanged) eng.refreshSession(rt);
  const bot = eng.toBot(rt);
  tellModelsIfChanged(eng, modelsBefore);
  eng.opts.emit("bot.updated", { bot });
  return bot;
}

/**
 * The bot changed between Claude and ChatGPT. Its session is closed and forgotten (an old Codex
 * thread is archived), and its next turn in the main chat starts fresh on the new harness with the
 * end of the chat and its last note for itself. One notice says so.
 */
export function switchHarness(eng: Engine, rt: BotRuntime, from: Harness, to: Harness): void {
  closeAllSessions(eng, rt);
  forgetSession(eng, rt.threadId);
  eng.store.setHarnessSwitch(rt.threadId, { from, to });
  // The cache's clock belongs to the old session; a GPT bot has none (docs/context.md).
  eng.store.setContext(rt.threadId, { tokens: 0, cache: null, sentAt: null, tidyBlockedAt: null });
  eng.addItem(
    rt,
    { kind: "notice", at: now(), text: `Changed from ${SWITCH_WORDS[from]} to ${SWITCH_WORDS[to]}. The bot starts a fresh session with its memory and the end of this chat.`, tone: "info" },
    rt.threadId,
  );
  log.info(`Bot ${rt.folder.id}: changed from ${from} to ${to}; the next turn starts a fresh session`);
}

/** Drops a thread's saved session; an old Codex thread is archived so Codex's own history stays tidy. */
export function forgetSession(eng: Engine, threadId: string): void {
  const had = eng.store.getThread(threadId)?.sessionId;
  const meta = eng.store.getSessionMeta(threadId);
  if (had && meta?.harness === "codex") archiveCodex(eng, had);
  eng.store.setSessionId(threadId, null);
  eng.store.setSessionMeta(threadId, null);
}

export function archiveCodex(eng: Engine, threadId: string): void {
  const archive = eng.opts.archiveCodexThread ?? ((id: string) => codexArchiveThread(eng.codex, id));
  void archive(threadId).catch((err) => log.debug("Could not archive a Codex thread", err));
}

/** Stops a bot, withdraws its cards, archives its folder and takes it off the roster. Its chat stays in the database. */
export function retireBot(eng: Engine, botId: string): void {
  const rt = eng.bot(botId);
  if (rt.folder.file.role === "main" && eng.bots.size > 1) {
    throw new EngineError("bad_request", "The main bot can only be retired when it is the last bot.");
  }
  const name = rt.folder.file.name;
  endAllTaskManagers(eng, rt);
  stopBot(eng, rt, `${name} was retired before it answered.`);
  try {
    saveAll(rt.folder.dir, "bot", (files) => changedSummary(name, files), name);
  } catch (err) {
    log.warn(`Bot ${botId}: could not save its last changes before the archive`, err);
  }
  let archived: string;
  try {
    archived = archiveBotFolder(eng.opts.config.botsDir, botId);
  } catch (err) {
    log.error(`Could not move the folder of bot ${botId} to the archive`, err);
    throw new EngineError("internal", "The bot's folder could not be moved to the archive, so it was not retired.");
  }
  eng.store.addItem(rt.threadId, { kind: "notice", at: now(), text: `${name} was retired. Its folder is in the archive.`, tone: "info" });
  // Its Codex thread goes to Codex's archive, so Codex's own history does not keep dead Pobots threads.
  if (eng.store.getSessionMeta(rt.threadId)?.harness === "codex") forgetSession(eng, rt.threadId);
  eng.store.retireThreads(botId);
  if (rt.folder.file.vacationSince) {
    for (const card of eng.store.listCards()) if (card.kind !== "system" && card.botId === botId) eng.store.removeCard(card.id);
  }
  eng.store.removeRulesOf(botId);
  // Its artifacts go with it, and no key opens them any more.
  eng.store.retireArtifacts(botId);
  for (const [key, k] of [...eng.pageKeys]) if (k.botId === botId) eng.pageKeys.delete(key);
  // Step 7c: its to-dos leave the person's list.
  for (const todo of eng.store.openTodos(botId)) {
    eng.store.saveTodo({ todo, status: "retired", closedAt: now() });
    eng.opts.emit("todo.removed", { todoId: todo.id, reason: "retired" });
  }
  // Its triggers stop and go with it. Their runs stay in the database.
  for (const row of eng.store.listTriggers(botId)) {
    eng.store.removeTrigger(row.id);
    eng.opts.emit("trigger.changed", { botId, removedId: row.id });
  }
  eng.bots.delete(botId);
  eng.order = eng.order.filter((id) => id !== botId);
  // A tag that reached it reaches nothing now.
  for (const ch of eng.store.listChannels()) {
    if (!ch.routes.some((r) => r.botId === botId)) continue;
    ch.routes = ch.routes.filter((r) => r.botId !== botId);
    eng.store.updateChannel(ch);
    emitChannel(eng, ch);
  }
  for (const other of eng.bots.values()) {
    if (other.folder.file.mayMessage.includes(botId)) {
      other.folder.file.mayMessage = other.folder.file.mayMessage.filter((id) => id !== botId);
      eng.saveSettings(other.folder);
      eng.opts.emit("bot.updated", { bot: eng.toBot(other) });
    }
  }
  eng.opts.emit("bot.removed", { botId });
  refreshUpcoming(eng);
  log.info(`Retired bot ${botId} to ${archived}`);
}

/** Ends everything a bot is doing: its turn, its queue, its cards, its asks and its harness. */
export function stopBot(eng: Engine, rt: BotRuntime, why: string, keepWaiting = false): void {
  clearTimeout(rt.doneTimer);
  clearTimeout(rt.sleepTimer);
  clearTimeout(rt.interruptTimer);
  cancelSettle(eng, rt);
  clearTimeout(rt.liveTimer);
  for (const [id, p] of [...eng.cards]) if (p.rt === rt) removeCard(eng, id, "withdrawn", { type: "withdrawn" });
  if (rt.busy) {
    for (const key of [...rt.textItems.keys()]) closeBotItem(eng, rt, key);
    for (const tool of rt.tools.values()) finishActivity(eng, tool, "failed");
    rt.tools.clear();
    if (rt.turn?.ask) settleAsk(eng, rt.turn.ask, { problem: why });
    if (rt.current) endRunOfItem(eng, rt.current.id, "failed", "The bot was stopped before the run finished");
    if (rt.current) endChannelOfItem(eng, rt.current.id, "The bot was stopped before it answered");
    rt.busy = false;
    rt.current = undefined;
    rt.turn = undefined;
  }
  for (const id of rt.queue) {
    const item = eng.store.getItem(id);
    if (keepWaiting && item?.kind === "user" && item.from.type === "you") continue;
    if (item && item.kind === "user") eng.putItem({ ...item, queued: false });
    const ask = eng.askByItem.get(id);
    if (ask) settleAsk(eng, ask, { problem: why });
    eng.askByItem.delete(id);
    endRunOfItem(eng, id, "failed", "The bot was stopped before the run started");
    endChannelOfItem(eng, id, "The bot was stopped before it answered");
  }
  rt.queue = keepWaiting ? rt.queue.filter((id) => {
    const item = eng.store.getItem(id);
    return item?.kind === "user" && item.from.type === "you";
  }) : [];
  if (!rt.queue.length) rt.hold = undefined;
  saveHold(eng, rt);
  for (const ac of rt.lateCalls) ac.abort();
  rt.lateCalls.clear();
  rt.wakes = [];
  // What it asked others is no longer awaited.
  for (const ask of [...eng.asks]) {
    if (ask.from === rt.folder.id) {
      ask.settled = true;
      clearTimeout(ask.timer);
      eng.asks.delete(ask);
    }
  }
  closeAllSessions(eng, rt);
}

export function listFiles(eng: Engine, botId: string): ProtocolBotFile[] {
  const rt = eng.bot(botId);
  try {
    return filesListFiles(rt.folder.dir);
  } catch (err) {
    log.error(`Bot ${botId}: could not list its files`, err);
    throw new EngineError("internal", "The bot's files could not be read.");
  }
}

export function readFile(eng: Engine, params: Methods["bot.file.read"]["params"]): Methods["bot.file.read"]["result"] {
  return readTextFile(eng.bot(params.botId).folder.dir, params.path);
}

export function writeFile(eng: Engine, params: Methods["bot.file.write"]["params"], by: ChangeBy = "you", summary?: string): Methods["bot.file.write"]["result"] {
  const rt = eng.bot(params.botId);
  const res = writeTextFile(rt.folder.dir, params.path, params.text, params.baseRev);
  const words = summary ?? (res.path === "AGENTS.md" ? "Edited the job" : `${res.created ? "Added" : "Edited"} ${res.path}`);
  saveChange(eng, rt, [res.path], by, words);
  if (res.path === "AGENTS.md") jobChanged(eng, rt);
  eng.checkArtifacts(rt.folder.id);
  return { file: res.file, rev: res.rev };
}

export function deleteFile(eng: Engine, params: Methods["bot.file.delete"]["params"], by: ChangeBy = "you", summary?: string): void {
  const rt = eng.bot(params.botId);
  const path = deleteTextFile(rt.folder.dir, params.path);
  saveChange(eng, rt, [path], by, summary ?? `Removed ${path}`);
  eng.checkArtifacts(rt.folder.id);
}

/** Saves the given paths as one change and tells the app. */
export function saveChange(eng: Engine, rt: BotRuntime, paths: string[], by: ChangeBy, summary: string): BotChange | undefined {
  let change: BotChange | undefined;
  try {
    change = savePaths(rt.folder.dir, paths, by, summary);
  } catch (err) {
    log.warn(`Bot ${rt.folder.id}: could not save the change in its history`, err);
  }
  eng.opts.emit("bot.files.changed", { botId: rt.folder.id, paths: change?.files ?? paths, by });
  return change;
}

export function history(eng: Engine, params: Methods["bot.history"]["params"]): Methods["bot.history"]["result"] {
  const rt = eng.bot(params.botId);
  try {
    return listChanges(rt.folder.dir, params.before, params.limit ?? 30);
  } catch (err) {
    if (err instanceof GitError && err.message === "unknown change") throw new EngineError("not_found", "There is no such change in this bot's history.");
    log.error(`Bot ${params.botId}: could not read its history`, err);
    throw new EngineError("internal", "The bot's history could not be read.");
  }
}

export function readChange(eng: Engine, params: Methods["bot.history.read"]["params"]): Methods["bot.history.read"]["result"] {
  const rt = eng.bot(params.botId);
  const res = hasRepo(rt.folder.dir) ? historyReadChange(rt.folder.dir, params.changeId) : undefined;
  if (!res) throw new EngineError("not_found", "There is no such change in this bot's history.");
  return res;
}

export function undoChange(eng: Engine, params: Methods["bot.history.undo"]["params"]): Methods["bot.history.undo"]["result"] {
  const rt = eng.bot(params.botId);
  const dir = rt.folder.dir;
  if (!hasRepo(dir) || !commitExists(dir, params.changeId)) throw new EngineError("not_found", "There is no such change in this bot's history.");
  if (isFirstChange(dir, params.changeId)) throw new EngineError("bad_request", "This change made the bot, so it cannot be undone. Retire the bot instead.");
  const touched = changeStatus(dir, params.changeId);
  if (touched.some((t) => t.path === "bot.json" || t.path === "CLAUDE.md" || (t.path === "AGENTS.md" && t.status === "A"))) {
    throw new EngineError("bad_request", "This change includes files Pobots keeps for the bot, so it cannot be undone here.");
  }
  const original = historyReadChange(dir, params.changeId)!.change;
  const result = historyUndoChange(dir, params.changeId, `Undid: ${original.summary}`);
  if (!result.ok) {
    if (result.reason === "busy") throw new EngineError("conflict", "The bot is changing these files right now. Try again when it has finished.");
    if (result.reason === "empty") throw new EngineError("bad_request", "This change has nothing left to undo.");
    throw new EngineError("conflict", "This change cannot be undone cleanly, because the files changed again after it. Edit them instead.");
  }
  eng.opts.emit("bot.files.changed", { botId: rt.folder.id, paths: result.change.files, by: "app" });
  if (result.change.files.includes("AGENTS.md")) jobChanged(eng, rt);
  eng.checkArtifacts(rt.folder.id);
  return { change: result.change };
}

/** After its job changed, a bot works from the new job from its next turn. */
export function jobChanged(eng: Engine, rt: BotRuntime): void {
  rt.jobChanged = true;
  eng.refreshSession(rt);
}

/** After a turn: everything the bot changed in its folder becomes one change by the bot. */
export function saveTurnChanges(eng: Engine, rt: BotRuntime): void {
  eng.checkArtifacts(rt.folder.id);
  const name = rt.folder.file.name;
  try {
    const change = saveAll(rt.folder.dir, "bot", (files) => changedSummary(name, files), name);
    if (change) eng.opts.emit("bot.files.changed", { botId: rt.folder.id, paths: change.files, by: "bot" });
  } catch (err) {
    log.warn(`Bot ${rt.folder.id}: could not save the turn's changes in its history`, err);
  }
}

export function listRules(eng: Engine, botId: string): SavedRule[] {
  eng.bot(botId);
  return eng.store.listRules(botId).map((r) => ({ id: r.id, botId: r.botId, label: ruleLabel(r.rule), detail: r.rule, at: r.at }));
}

export function removeRule(eng: Engine, ruleId: string): void {
  const row = eng.store.getRule(ruleId);
  if (!row || !eng.store.removeRule(ruleId)) throw new EngineError("not_found", "That rule is already gone.");
  eng.opts.emit("rules.changed", { botId: row.botId });
  const rt = eng.bots.get(row.botId);
  if (rt) eng.refreshSession(rt);
}
