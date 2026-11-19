// Start-up: loading the bots, preparing their folders, tidying what a stop left, and sending what waited.
import { away, recoverVacation } from "./vacation.js";
import type { Engine } from "../engine.js";
import { type BotFolder, pickColor, readBotFolders } from "../bots.js";
import { log } from "../log.js";
import { newRuntime } from "./runtime.js";
import { restWaitChanged } from "./restored-waiting.js";
import { restoreTaskManagers, startManagerInbox } from "./task-managers.js";
import { UPLOAD_CLEAN_EVERY_MS } from "../attachments.js";
import { loadHold, saveHold, startNextInLine } from "./stop.js";
import { computeUpcoming, endRunOfItem, idleActivity } from "./triggers.js";
import { ensureRepo, saveAll } from "../history.js";
import { ensureWorkersFile } from "../workers.js";
import { readOldRules } from "../rules.js";
import { now } from "./words.js";
import { helpersStoppedNotice } from "./helpers.js";
import { endChannelOfItem } from "./channels.js";
import { ownAsking, restoreCards, WAITED_NOTICE } from "./restored-cards.js";
import { settleQuestionsAtStart } from "./card-questions.js";

/**
 * Reads the bot folders, makes sure each has a main thread and a history, tidies up after the
 * last stop, and then sends the messages that were still queued, in order.
 */
export function init(eng: Engine): void {
  const { bots, problems } = readBotFolders(eng.opts.config.botsDir, eng.machine.id);
  for (const p of problems) log.warn(p);
  const withThreads = bots.map((folder) => {
    const thread = eng.store.mainThread(folder.id) ?? eng.store.createThread(folder.id);
    return { folder, thread };
  });
  withThreads.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt) || a.folder.id.localeCompare(b.folder.id));

  // Exactly one main bot: the first one that says so, or the oldest bot.
  const mains = withThreads.filter((b) => b.folder.file.role === "main");
  const keep = mains[0] ?? withThreads[0];
  const ids = new Set(withThreads.map((b) => b.folder.id));
  for (const { folder } of withThreads) {
    const role = folder === keep?.folder ? "main" : "bot";
    const may = folder.file.mayMessage.filter((id) => ids.has(id));
    if (folder.file.role !== role || may.length !== folder.file.mayMessage.length || (role === "main" && folder.file.vacationSince)) {
      folder.file.role = role;
      if (role === "main") delete folder.file.vacationSince;
      folder.file.mayMessage = may;
      eng.saveSettings(folder);
    }
  }
  if (keep) withThreads.splice(withThreads.indexOf(keep), 1), withThreads.unshift(keep);

  for (const { folder, thread } of withThreads) {
    // The harness always follows the model (step 3a); bot.json from before says "claude" for every bot.
    const harness = eng.harnessOf(folder.file.model);
    if (folder.file.harness !== harness) {
      folder.file.harness = harness;
      eng.saveSettings(folder);
    }
    eng.bots.set(folder.id, newRuntime(folder, thread.id));
    eng.order.push(folder.id);
    prepareFolder(eng, folder);
    // Every bot has a colour (step 7a): one from before gets one once, distinct while the palette
    // lasts, the oldest bot first, saved in its bot.json (which the bot's history leaves out).
    if (!folder.file.look.color) {
      folder.file.look = { ...folder.file.look, color: pickColor(withThreads.map((b) => b.folder.file.look.color)) };
      eng.saveSettings(folder);
    }
  }
  tidyAfterStop(eng);
  eng.tidyUploads();
  eng.uploadsTimer = setInterval(() => {
    eng.tidyUploads();
    eng.tidyAttachments();
  }, UPLOAD_CLEAN_EVERY_MS);
  eng.uploadsTimer.unref();
  for (const rt of eng.bots.values()) loadHold(eng, rt);
  // Engine 0.26.0: task managers come back, resting.
  for (const rt of eng.bots.values()) {
    restoreTaskManagers(eng, rt);
    recoverVacation(eng, rt);
  }
  settleQuestionsAtStart(eng);
  for (const rt of eng.bots.values()) rt.activity = idleActivity(eng, rt);
  eng.upcomingList = computeUpcoming(eng);
  log.info(`Loaded ${eng.bots.size} bot${eng.bots.size === 1 ? "" : "s"} from ${eng.opts.config.botsDir}`);
  // Codex is looked at without holding the start up. Not ready is no fault until a bot uses a GPT model.
  if (eng.hub.enabled("codex")) void eng.recheckCodex();
  // Step 7b: the regular look at the providers, and titles for old chats, slowly.
  eng.hub.start();
  eng.titles.startBackfill();
  setImmediate(() => {
    sendQueuedAfterStart(eng);
    if (!eng.stopping) {
      for (const rt of eng.bots.values()) for (const tm of rt.managers.values()) {
        if (!tm.busy && (tm.harness !== "claude" || eng.opts.claude.ready)) startManagerInbox(eng, rt, tm);
      }
    }
    // The first look at the schedules: what was due while Pobots was not running runs late or is skipped.
    if (!eng.stopping) eng.checkSchedules();
  });
}

/** History for folders made before there was any, changes made while Pobots was not running, and old rules. */
export function prepareFolder(eng: Engine, folder: BotFolder): void {
  try {
    if (ensureRepo(folder.dir)) {
      const change = saveAll(folder.dir, "app", "Saved changes made while Pobots was not running");
      if (change) log.info(`Bot ${folder.id}: saved changes made while Pobots was not running`);
    }
  } catch (err) {
    log.warn(`Bot ${folder.id}: could not prepare the history`, err);
  }
  // Step workers: a bot from before gets WORKERS.md once, saved as a change of its own.
  if (ensureWorkersFile(folder.dir)) log.info(`Bot ${folder.id}: added WORKERS.md, what every worker of this bot is told`);
  const mark = `old-rules:${folder.id}`;
  if (!eng.store.hasMark(mark)) {
    const old = readOldRules(folder.dir);
    for (const rule of old.rules) eng.store.addRule(folder.id, rule, old.at);
    if (old.rules.length) log.info(`Bot ${folder.id}: read ${old.rules.length} saved rule(s) from before`);
    eng.store.setMark(mark);
  }
}

/** Items left open by a stop or a crash are closed, queued messages wait for their turn again, and cards that waited on a turn are withdrawn. */
export function tidyAfterStop(eng: Engine): void {
  const turnCut = new Set<string>();
  // No helper can still be working after a start: its harness process is gone.
  const stopped = new Map<string, { botId: string; titles: string[] }>();
  for (const item of eng.store.openItems()) {
    // A task manager's row is put right when it comes back (restoreTaskManagers).
    if (item.kind === "helper" && item.taskManager) continue;
    if (item.kind === "helper") {
      eng.store.updateItem({ ...item, status: "stopped", endedAt: now() });
      const entry = stopped.get(item.threadId) ?? { botId: item.botId, titles: [] };
      entry.titles.push(item.title);
      stopped.set(item.threadId, entry);
      continue;
    }
    // A tidy turn cut short adds nothing to the chat: the session stays as it was. A helper's
    // thread gets no notice of its own: the row that opens it says it was stopped.
    const quiet = eng.store.isTidyTurn(item.turnId) || eng.store.getThread(item.threadId)?.kind === "helper";
    if (item.kind === "bot") {
      eng.store.updateItem({ ...item, streaming: false });
      if (!quiet) turnCut.add(item.threadId);
    } else if (item.kind === "activity") {
      eng.store.updateItem({ ...item, status: "failed" });
      if (!quiet) turnCut.add(item.threadId);
    }
  }
  // A turn that waited on its own card: the card comes back (restoreCards below), so the chat says so.
  const waited = new Set(eng.store.listCards().filter(ownAsking).filter((c) => eng.bots.has(c.botId)).map((c) => c.threadId));
  for (const threadId of turnCut) {
    eng.store.addItem(threadId, { kind: "notice", at: now(), text: waited.has(threadId) ? WAITED_NOTICE : "Pobots stopped while the bot was working, so this turn was cut short.", tone: "info" });
  }
  for (const [threadId, { botId, titles }] of stopped) helpersStoppedNotice(eng, botId, threadId, titles, "restart", false);
  for (const rt of eng.bots.values()) {
    rt.queue = eng.store.queuedItemsOfBot(rt.folder.id).map((i) => i.id);
  }
  // A trigger run still waiting in line runs after the start, like a queued message. One that was going is over.
  const waiting = new Set([...eng.bots.values()].flatMap((rt) => rt.queue));
  for (const { run, itemId } of eng.store.openRuns()) {
    if (itemId && waiting.has(itemId)) continue;
    eng.store.updateRun({ ...run, status: "failed", note: "Pobots stopped while this run was going" });
  }
  // The same for messages from channels: one still waiting in line is answered after the start.
  for (const row of eng.store.openChannelMessages()) {
    if (row.itemId && waiting.has(row.itemId)) continue;
    eng.store.updateChannelMessage(row.rid, { ...row.message, status: "reply-failed", note: "Pobots stopped before the answer could be posted" });
  }
  // Every open card comes back: notes, cards from Pobots itself, and (engine 0.29.0) approvals and
  // questions, whose answer now reaches the bot as a message (core/restored-cards.ts). The cards of a
  // bot that is gone are dropped.
  restoreCards(eng);
  // Engine 0.31.1: a bot with such a card reads Waiting for you (core/restored-waiting.ts).
  for (const rt of eng.bots.values()) restWaitChanged(eng, rt);
}

export function sendQueuedAfterStart(eng: Engine): void {
  for (const rt of eng.bots.values()) {
    if (away(rt) || rt.busy || !rt.queue.length || eng.stopping) continue;
    // A GPT bot's message is taken up and ends blocked with Codex's sentence when Codex is not there.
    if (rt.folder.file.harness === "claude" && !eng.opts.claude.ready) {
      // Messages held by a Stop stay held and waiting: they wait for the person, not for Claude.
      const held = rt.hold?.held;
      const drop = held ? rt.queue.filter((id) => !held.has(id)) : rt.queue;
      if (!drop.length) continue;
      for (const id of drop) {
        const item = eng.store.getItem(id);
        if (item && item.kind === "user") eng.putItem({ ...item, queued: false });
        endRunOfItem(eng, id, "failed", "Claude is not ready on this computer, so the run could not start");
        endChannelOfItem(eng, id, "Claude is not ready on this computer, so the bot could not answer");
      }
      rt.queue = rt.queue.filter((id) => !drop.includes(id));
      if (rt.hold) saveHold(eng, rt);
      eng.notice(
        rt,
        rt.queue.length
          ? "Claude is not ready on this computer, so the messages that came after the Stop were not sent. Send them again when it is."
          : "Claude is not ready on this computer, so the waiting messages were not sent. Send them again when it is.",
        "info",
      );
      continue;
    }
    // Messages held by a Stop from before the restart stay waiting (step 3b, third part).
    startNextInLine(eng, rt);
  }
}
