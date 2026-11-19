// A turn's start: the message that starts it, the bot's session (made, resumed or fresh) and the hand-offs between sessions.
import { EngineError } from "../errors.js";
import { away, requirePresent } from "./vacation.js";
import { leaveLive, takeAside } from "./aside.js";
import type { Engine, HarnessSession } from "../engine.js";
import { type BotRuntime, HarnessUnavailable, purposeOf, SWITCH_WORDS } from "./runtime.js";
import type { Harness, UserItem } from "../../shared/protocol.js";
import { newAsk } from "./asks.js";
import { randomUUID } from "node:crypto";
import { saveRun, triggerKindWord } from "./triggers.js";
import { saveChannelMessage } from "./channels.js";
import { codexInstructions, LATE_CODEX_TOOLS, messageFraming, teamPrompt, TOOL_NAMES } from "../team.js";
import { managerFraming } from "../task-manager-tools.js";
import { calendarPrompt } from "./calendar-settings.js";
import { aboutYouPrompt } from "./first-start.js";
import { answerNote } from "../todos.js";
import { freshRunNote, mainRunNote } from "../triggers.js";
import { channelText } from "../channels.js";
import { ATTACH_WORDS, attachmentLines, contentFor, type Picture } from "../attachments.js";
import { log } from "../log.js";
import { toolsFor } from "./bot-tools.js";
import { CodexSession, toolFingerprint } from "../codex/session.js";
import { forgetSession } from "./bot-admin.js";
import { SEES_ON_WORDS, seesSettings } from "../claude/sees.js";
import { codexSeesParagraph } from "../codex/sees.js";
import { codexSeesFor } from "./helper-sees.js";
import { ClaudeSession, type SessionSettings } from "../claude/session.js";
import { connectionText } from "./link-bot.js";
import { canUseTool } from "./cards.js";
import { noteKey } from "./restored-cards.js";
import { questionTurnStarts } from "./card-questions.js";
import { onHarnessEvent } from "./harness-events.js";
import { codexThreadExists } from "../codex/detect.js";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { clip } from "./words.js";
import type { ChatHit } from "../store.js";
import { finishTurn, tidyGate } from "./turn-end.js";
import { cancelSettle } from "./helpers.js";

/** The first block of the first turn in a fresh session. */
export const FRESH_LINE =
  "Note from Pobots: this is a fresh session in the same chat. You wrote the note below for yourself before it started. Your memory folder holds the rest, and search_chat finds anything said earlier.";

export async function startTurn(eng: Engine, rt: BotRuntime, item: UserItem, o: { handed?: boolean } = {}): Promise<void> {
  if (away(rt)) return;
  rt.busy = true;
  rt.current = item;
  rt.interruptRequested = false;
  // What reported back before this turn is told to the model in it (step 3b, third part).
  rt.wake = undefined;
  rt.retriedFresh = false;
  rt.turnError = undefined;
  clearTimeout(rt.doneTimer);
  clearTimeout(rt.sleepTimer);

  const from = item.from;
  let ask = eng.askByItem.get(item.id);
  eng.askByItem.delete(item.id);
  const hops = from.type === "bot" ? Math.max(1, eng.store.hops(item.id)) : 0;
  if (!ask && from.type === "bot" && from.expectsReply) {
    // The asker no longer waits (the engine restarted in between): its answer goes to it as a message.
    // Asked before a Stop that still holds the asker: from before it, so the answer waits with the
    // held messages (step 3b, third part). -1 is older than any count.
    const asker = eng.bots.get(from.botId);
    const before = !!asker?.hold && item.at <= asker.hold.at;
    ask = newAsk(eng, from.botId, rt.folder.id, hops, before ? -1 : undefined);
    ask.late = true;
  }
  const fresh = item.threadId !== rt.threadId;
  const tidy = from.type === "app";
  const run = eng.store.runByItem(item.id);
  const chan = from.type === "channel" ? eng.store.channelMessageByItem(item.id) : undefined;
  rt.turn = {
    id: randomUUID(),
    threadId: item.threadId,
    fresh,
    hops,
    startedBy: from.type,
    ask,
    lastText: "",
    tidy,
    ...(run ? { runId: run.id } : {}),
    ...(run && from.type === "trigger" ? { runLabel: from.label } : {}),
    ...(chan ? { channelRid: chan.rid } : {}),
    ...(ask ? { askFrom: ask.from } : {}),
  };
  if (!tidy) rt.lastPurpose = purposeOf(rt.turn);
  cancelSettle(eng, rt);
  if (tidy) eng.store.addTidyTurn(rt.turn.id, item.threadId);
  // Attached files are looked at now, from the stored item: one that is gone says so in the chat.
  const attached = item.attachments?.length ? (eng.withMissing(item) as UserItem).attachments : undefined;
  const started: UserItem = { ...item, queued: false, turnId: rt.turn.id, ...(attached ? { attachments: attached } : {}) };
  eng.putItem(started);
  rt.current = started;
  if (run) saveRun(eng, { ...run, threadId: item.threadId, turnId: rt.turn.id });
  if (chan && chan.message.status === "delivered") saveChannelMessage(eng, chan.rid, { ...chan.message, turnId: rt.turn.id });

  const before: string[] = [];
  let text = item.text;
  // A tidy turn leaves news for the next real turn, which may be in the fresh session. A steered
  // message the harness already holds (`handed`) gets nothing more: its news waits for the next turn.
  if (!fresh && !tidy && !o.handed) {
    if (rt.jobChanged) {
      before.push("Note from Pobots: your job in AGENTS.md was changed since your last turn. Work from the new version.");
      rt.jobChanged = false;
    }
    const results = eng.store
      .takeUnseen(rt.folder.id)
      .map((id) => eng.store.getItem(id))
      .filter((i): i is UserItem => !!i && i.kind === "user" && i.id !== item.id);
    if (results.length) {
      before.push(
        ["Note from Pobots: these results from your fresh runs were passed on to this chat since your last turn.", ...results.map((r) => r.text)].join("\n\n"),
      );
    }
    before.push(...eng.store.takeNews(item.threadId));
  }
  if (from.type === "bot") {
    const kind = eng.lateAnswers.has(item.id) ? "answer" : from.expectsReply ? "ask" : "tell";
    eng.lateAnswers.delete(item.id);
    // Engine 0.26.0: from a task manager, which writes for its bot.
    before.push(from.taskManager ? managerFraming(from.taskManager, eng.nameOf(from.botId), from.botId === rt.folder.id, kind) : messageFraming(eng.nameOf(from.botId), kind));
  }
  // Engine 0.31.0: his question about a to-do or card before he acts: not an answer.
  const question = from.type === "you" && from.question ? questionTurnStarts(eng, rt, item, rt.turn.id) : undefined;
  if (question) before.push(question);
  // Step 7c: the person's answer to a to-do says so, and whether the to-do is still on his list.
  if (from.type === "you" && from.todo && !from.question) {
    const row = eng.store.getTodo(from.todo.id);
    if (row) before.push(answerNote(row.todo, row.status === "open"));
  }
  // Engine 0.29.0: the person's answer to a card that came back after a restart names the card.
  if (from.type === "you" && from.card && !from.question) {
    const note = eng.store.getValue(noteKey(item.id));
    if (note) before.push(note);
    eng.store.deleteValue(noteKey(item.id));
  }
  if (from.type === "trigger") {
    const kind = triggerKindWord(eng, run);
    if (fresh) text = `${item.text}\n\n${freshRunNote(from.label, kind)}`;
    else before.push(mainRunNote(from.label, kind));
  }
  if (from.type === "channel") {
    const ch = eng.store.getChannel(from.channelId);
    text = channelText({ sender: from.sender, channel: from.label, tag: from.tag, text: item.text, context: from.context ?? [], hasReplyUrl: !!ch?.replyUrl });
  }

  if (from.type === "connection") {
    const question = from.mode === "answer" ? eng.store.links.answerQuestion(from.id, item.id) : undefined;
    text = connectionText(from, item.text, question);
  }

  eng.setState(rt, "thinking", "Thinking");
  const current = rt.current;
  let pictures: Picture[] | undefined;
  const holder = rt.session;
  try {
    if (attached?.length && !o.handed) {
      // What the model gets is built here, at the start of the turn, from the stored item: a queued
      // message, one held after a Stop and one that waited through a restart keep their files.
      const harness = rt.folder.file.harness;
      const seesPictures = eng.seesPictures(rt);
      const built = await contentFor(rt.folder.dir, text, attached, { harness, seesPictures });
      if (rt.current !== current) return;
      text = built.text;
      if (built.pictures.length) pictures = built.pictures;
      if (built.picturesRefused) eng.notice(rt, ATTACH_WORDS.noPictures, "info");
    }
    const { session, handoff } = await ensureSession(eng, rt);
    // Fast mode as it stands right now, before every turn of a GPT bot: a change that came while
    // Codex was not ready, or while its model list was another, must not leave the session behind.
    if (rt.folder.file.harness === "codex") await session.setFast?.(eng.runsFast(rt.folder.file)).catch(() => undefined);
    if (rt.current !== current) return;
    if (rt.interruptRequested) {
      finishTurn(eng, rt, { ok: true, errors: [], subtype: "interrupted" });
      return;
    }
    // A steered message the turn before ended without taking up is with the harness already, which
    // runs it now by itself. Only a session that is not that one (it was replaced) is sent it.
    if (o.handed && session === holder) {
      log.info(`Bot ${rt.folder.id}: the harness reads the steered message in a turn of its own`);
      return;
    }
    if (o.handed && attached?.length) {
      const built = await contentFor(rt.folder.dir, text, attached, { harness: rt.folder.file.harness, seesPictures: eng.seesPictures(rt) });
      if (rt.current !== current) return;
      text = built.text;
      if (built.pictures.length) pictures = built.pictures;
    }
    session.send(text, [...(handoff ?? []), ...before], tidy ? { tidy: true } : pictures ? { pictures } : undefined);
  } catch (err) {
    if (rt.current !== current || away(rt)) return;
    if (err instanceof HarnessUnavailable) {
      // A GPT bot while Codex is not there: blocked, with Codex's own sentence.
      log.warn(`Bot ${rt.folder.id}: ${err.message}`);
      eng.notice(rt, err.message, "error");
      rt.turnError = "unavailable";
      finishTurn(eng, rt, { ok: false, errors: [], subtype: "harness_unavailable" });
      return;
    }
    if (rt.turn?.tidy) log.warn(`Bot ${rt.folder.id}: the tidy turn could not start: ${err instanceof Error ? err.message : String(err)}`);
    else log.error(`Bot ${rt.folder.id}: could not start the harness`, err);
    eng.notice(rt, "The bot could not start. The details are in the engine log.", "error");
    rt.turnError = "start";
    finishTurn(eng, rt, { ok: false, errors: [], subtype: "start_failed" });
  }
}

/**
 * The harness session for the current turn's thread. A bot has one live session at a time: a fresh
 * run puts the main session to sleep (it is resumed for the next turn in the main chat) and gets
 * its own new one, with no earlier conversation. A session whose helpers still work is set aside
 * instead of put to sleep, and a turn in its thread brings it back (core/aside.ts).
 */
export async function ensureSession(eng: Engine, rt: BotRuntime, forceFresh = false): Promise<{ session: HarnessSession; handoff?: string[] }> {
  requirePresent(rt);
  const epoch = rt.epoch;
  const threadId = rt.turn?.threadId ?? rt.threadId;
  const freshRun = rt.turn?.fresh ?? false;
  const harness = rt.folder.file.harness;
  if (rt.session && !rt.session.closed && !forceFresh && rt.sessionThread === threadId && (rt.sessionHarness ?? "claude") === harness) return { session: rt.session };
  if (!forceFresh) {
    const back = takeAside(eng, rt, threadId, harness);
    if (back) return { session: back.session };
  }
  if (rt.session) leaveLive(eng, rt);
  if (harness === "codex") {
    if (!eng.codex.ready) await eng.recheckCodex();
    if (!eng.codex.ready) throw new HarnessUnavailable(eng.codex.problem ?? "Codex is not ready on this computer.");
  }
  // What exists, read before anything else here when the bot's choice needs it (docs/sees.md, rule 6).
  const seesKnown = harness === "claude" && rt.folder.file.sees ? await eng.seesHub.ensureKnown(rt.folder.id, rt.folder.dir, rt.folder.file.sees) : undefined;
  requirePresent(rt);
  let tools = toolsFor(eng, rt);
  let fingerprint = harness === "codex" ? toolFingerprint(tools) : undefined;
  // The list a Codex thread from before the late tools has (team.ts LATE_CODEX_TOOLS), when it differs.
  const earlier = harness === "codex" ? tools.filter((t) => !LATE_CODEX_TOOLS.includes(t.name)) : tools;
  const earlierPrint = earlier.length !== tools.length ? toolFingerprint(earlier) : undefined;
  let earlierList = false;
  const thread = eng.store.getThread(threadId);
  let had = thread?.sessionId ?? null;
  let afterUpdate = false;
  if (had) {
    const meta = eng.store.getSessionMeta(threadId);
    // A saved session of the other harness is never resumed. Sessions from before step 3a are Claude's.
    if ((meta?.harness ?? "claude") !== harness) {
      forgetSession(eng, threadId);
      had = null;
    } else if (harness === "codex" && meta?.tools && meta.tools !== fingerprint && meta.tools === earlierPrint) {
      // A thread from before the late tools: resumed as it is, without them (docs/build/step-gpt-change-sees.md).
      earlierList = true;
    } else if (harness === "codex" && meta?.tools && meta.tools !== fingerprint) {
      // A Codex thread keeps the tool list it was started with (thread/resume takes none). A changed
      // list (a new release, another role) means a fresh thread, calmly, with the usual handoff.
      // In a tidy turn the old session is left alone (the tidy turn does not start): the next real
      // turn comes here again and gets the handoff. Forgetting it now would lose the chat's end.
      afterUpdate = true;
      if (!rt.turn?.tidy) {
        log.info(`Bot ${rt.folder.id}: its tools changed since its Codex thread began; starting a fresh one`);
        forgetSession(eng, threadId);
      }
    }
  }
  const saved = forceFresh || freshRun || afterUpdate ? null : had;
  let resume: string | undefined;
  let handoff: string[] | undefined;
  const ctx = freshRun ? undefined : eng.store.getContext(threadId);
  const change = freshRun ? undefined : eng.store.getHarnessSwitch(threadId);
  let switchHanded = false;
  if (saved && (await sessionExists(eng, saved, rt.folder.dir, harness))) {
    resume = saved;
    if (earlierList) {
      tools = earlier;
      fingerprint = earlierPrint;
    }
  } else if (rt.turn?.tidy) {
    // Nothing to tidy: the session is gone. The next real turn gets the usual handoff.
    throw new Error("the session to tidy could not be found");
  } else if (change && !had) {
    // A change between Claude and ChatGPT: the end of the chat and the bot's last note for itself.
    handoff = switchHandoff(eng, rt, change.from, change.to, ctx?.note);
    switchHanded = true;
  } else if (!freshRun && !had && !forceFresh && ctx?.notePending && ctx.note && !rt.turn?.tidy) {
    // A planned fresh start: the note the bot wrote for itself, then the end of the chat.
    handoff = freshHandoff(eng, rt, ctx.note);
  } else if (!freshRun && (had || forceFresh)) {
    // Only when a session was lost. A chat that never had one (its first turn, perhaps after
    // results from fresh runs were passed on) simply starts.
    if (saved) eng.store.setSessionId(threadId, null);
    const lines = lastMessages(eng, rt, 40, 6000);
    if (lines.length) {
      handoff = [
        [
          afterUpdate
            ? "Note from Pobots: Pobots was updated, so this is a fresh session in the same chat."
            : "Note from Pobots: your earlier session could not be restored, so this is a fresh session in the same chat.",
          "Here is the end of the conversation so far, from Pobots' own history:",
          "",
          ...lines,
          "",
          "The new message follows.",
        ].join("\n"),
      ];
      eng.notice(rt, afterUpdate ? "Started a fresh session after an update." : "Started a fresh session because the earlier one could not be restored. The bot got a short summary of this chat.", "info");
    }
  }
  const f = rt.folder.file;
  // The calendar paragraph for a bot with the switch on (engine 0.25.0).
  const calendar = calendarPrompt(eng, rt);
  // About you, the person's own note (engine 0.33.0), for every bot's own session.
  const team = [teamPrompt(f.role, harness), calendar, aboutYouPrompt(eng)].filter(Boolean).join("\n\n");
  // The bot's choice (docs/sees.md). Claude: the settings, with the names last read when it needs them.
  // Codex: the thread config from the servers Codex lists for the bot's folder, worked out once here so
  // the paragraph can name what is off (docs/build/step-gpt-bot-sees.md). Failing to work it out never
  // stops the bot: it then gets everything, as before.
  const sees = harness === "claude" && f.sees ? seesSettings(f.sees, seesKnown ?? eng.seesHub.known(rt.folder.id), f.role === "main" ? SEES_ON_WORDS.main : SEES_ON_WORDS.bot) : undefined;
  const codex = harness === "codex" && f.sees ? await codexSeesFor(eng, rt, rt.folder.dir, [], "its own session").catch(() => undefined) : undefined;
  // A thread from before change_what_i_see does not have it: that bot asks the person instead.
  const codexHow = f.role === "main" ? SEES_ON_WORDS.main : tools.some((t) => t.name === TOOL_NAMES.changeWhatISee) ? SEES_ON_WORDS.bot : SEES_ON_WORDS.ask;
  const codexParagraph = codex ? codexSeesParagraph(codex.off, codexHow) : "";
  const settings: SessionSettings = {
    botId: rt.folder.id,
    botName: f.name,
    botDir: rt.folder.dir,
    model: f.model,
    effort: f.effort,
    access: f.access,
    // Worked out here once: the bot's choice and the model's fast mode (step 3b). Tidy turns and fresh runs use this session too.
    fast: eng.runsFast(f),
    compactTokens: eng.hub.context(harness).compactTokens,
    ...(sees?.settings ? { sees: sees.settings } : {}),
    executable: harness === "codex" ? eng.codex.executable ?? "codex" : eng.opts.claude.executable ?? "claude",
    env: harness === "codex" ? eng.codex.env : eng.opts.claude.env,
    resume,
    tools,
    // Saved rules are in Claude's format; a card for a request from Codex has no "Always allow".
    rules: harness === "codex" ? [] : eng.store.listRules(rt.folder.id).map((r) => r.rule),
    team: sees?.paragraph ? `${team}\n\n${sees.paragraph}` : team,
    canUseTool: (name, input, o) => canUseTool(eng, rt, name, input, o),
    gate: (name, input) => tidyGate(eng, rt, name, input),
    onEvent: () => undefined,
    ...(harness === "codex"
      ? {
          args: eng.codex.args ?? [],
          systemAppend: codexInstructions(f.name, codexParagraph ? `${team}\n\n${codexParagraph}` : team),
          ...(codex && Object.keys(codex.config).length ? { codexConfig: async () => codex.config } : {}),
          // A fresh run is never resumed, so its thread stays out of Codex's own history.
          ...(freshRun ? { ephemeral: true } : {}),
        }
      : {}),
  };
  requirePresent(rt);
  if (rt.epoch !== epoch) throw new EngineError("conflict", "The turn was stopped before its session started.");
  const make = eng.opts.createSession ?? ((s: SessionSettings, h: Harness) => (h === "codex" ? new CodexSession(s) : new ClaudeSession(s)));
  let session: HarnessSession;
  settings.onEvent = (e) => onHarnessEvent(eng, rt, session, e);
  session = make(settings, harness);
  rt.session = session;
  rt.sessionThread = threadId;
  rt.sessionHarness = harness;
  rt.sessionTools = fingerprint;
  rt.resumedFrom = resume;
  rt.restartAfterTurn = false;
  rt.newMainSession = !freshRun && !resume;
  rt.noteHanded = !!handoff && !!ctx?.notePending && !had && !forceFresh;
  rt.switchHanded = switchHanded;
  session.start();
  log.info(`Bot ${rt.folder.id}: started ${harness === "codex" ? "Codex" : "the harness"}${resume ? " and resumed its session" : freshRun ? " for a fresh run" : " with a new session"}`);
  return { session, handoff };
}

/** The blocks before the first message after a change between Claude and ChatGPT. */
export function switchHandoff(eng: Engine, rt: BotRuntime, from: Harness, to: Harness, note?: string): string[] {
  const lines = lastMessages(eng, rt, 40, 6000);
  const blocks = [
    `Note from Pobots: you were moved from a ${SWITCH_WORDS[from]} model to a ${SWITCH_WORDS[to] === "ChatGPT" ? "GPT" : "Claude"} model (${rt.folder.file.model}), so this is a fresh session in the same chat. Your folder, job and memory are the same; read your memory folder for what you keep there.`,
  ];
  if (note?.trim()) blocks.push(`The note you wrote for yourself at your last fresh start:\n\n${note.trim()}`);
  if (lines.length) blocks.push(["Here is the end of the conversation so far, from Pobots' own history:", "", ...lines].join("\n"));
  const who = rt.current ? speaker(eng, rt.current) : "The person";
  blocks.push(`That is all the background from Pobots. The next part is the new message itself, from ${who === "The person" ? "the person" : who}. Answer it.`);
  return blocks;
}

export async function sessionExists(eng: Engine, sessionId: string, botDir: string, harness: Harness = "claude"): Promise<boolean> {
  try {
    if (eng.opts.sessionExists) return await eng.opts.sessionExists(sessionId, botDir, harness);
    if (harness === "codex") return await codexThreadExists(eng.codex, sessionId);
    const info = await getSessionInfo(sessionId, { dir: botDir });
    return !!info;
  } catch (err) {
    log.warn("Could not check the saved harness session", err);
    return false;
  }
}

/**
 * The end of the chat from Pobots' own history, oldest first, for a session that starts without
 * the earlier conversation: what people, other bots, triggers and channel writers said, and what
 * the bot answered. Leaves out the current message, tidy requests and what was said in tidy turns.
 */
export function lastMessages(eng: Engine, rt: BotRuntime, max: number, budget: number): string[] {
  const { items } = eng.store.readThread(rt.threadId, rt.current?.seq, 200);
  const lines: string[] = [];
  for (const item of [...items].reverse()) {
    if (lines.length >= max) break;
    let line: string | undefined;
    if (item.kind === "user") {
      if (item.from.type === "app") continue;
      const text = clip(item.text, 600);
      line = `${speaker(eng, item)}: ${item.from.type === "connection"
        ? JSON.stringify(text) : [text, ...attachmentLines(item.attachments)].filter(Boolean).join(" ")}`;
    } else if (item.kind === "bot" && item.text.trim()) {
      if (eng.store.isTidyTurn(item.turnId)) continue;
      line = `You: ${clip(item.text, 600)}`;
    }
    if (!line) continue;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return lines;
}

/** Who said a message, in plain words, as the bot sees it. */
export function speaker(eng: Engine, item: ChatHit): string {
  if (item.kind === "bot") return "You";
  const from = item.from;
  switch (from.type) {
    case "bot":
      return `${eng.nameOf(from.botId)} (another bot)`;
    case "trigger":
      return from.result ? `Result of the trigger ${from.label}` : `The trigger ${from.label}`;
    case "connection":
      return `Outside message from ${JSON.stringify(from.name)} in another Pobots`;
    case "channel":
      return `${from.sender} in the channel ${from.label}`;
    case "app":
      return "Pobots";
    default:
      return "The person";
  }
}

/** The blocks before the first message of a planned fresh session. */
export function freshHandoff(eng: Engine, rt: BotRuntime, note: string): string[] {
  const lines = lastMessages(eng, rt, 12, 6000);
  const blocks = [FRESH_LINE, note];
  if (lines.length) blocks.push(["The last messages of the chat, for the thread of the conversation:", "", ...lines].join("\n"));
  // Say plainly where the background ends. Without this a bot has taken the new message for one
  // more line of the list above and left it unanswered (tester, step 2d).
  const who = rt.current ? speaker(eng, rt.current) : "The person";
  blocks.push(`That is all the background from Pobots. The next part is the new message itself, from ${who === "The person" ? "the person" : who}. It is not part of the list above. Answer it.`);
  return blocks;
}
