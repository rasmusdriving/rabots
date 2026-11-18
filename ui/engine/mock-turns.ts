// The mock engine's chat turns: sending a message, a plain turn, a turn step by step, the browser's
// scene and turn (step 2g), and working memory (a fresh start and the tidy before it). Free functions
// of the mock: `mock` is the MockEngine, and each keeps a one-line method there. Moved out of mock.ts
// unchanged on 15 Nov 2026 (docs/build/step-split.md).
import type { FollowUp, ActivityItem, BotItem, BrowserItem, NoticeItem, UserItem } from "../../shared/protocol";
import { ATTACHMENTS_PER_MESSAGE } from "../../shared/protocol";
import { EngineError } from "./types";
import { LOST_ASK, LOST_BOT, runLostReplyTurn } from "./mock-lostreply";
import {
  ANSWER,
  TRIGGER_ANSWER,
  CHANNEL_ANSWER,
  NO_REPLY,
  TIDY_PROMPT,
  FRESH_NOTE,
  WINDOW,
  at,
  today,
  later,
  isoDay,
  type Turn,
  HELPER_ASK,
  STEPS_ASK,
  STEPS_FIRST,
  STEPS,
  STEPS_ANSWER,
  ARTIFACT_ASK,
  PUBLISH_ASK,
  BROWSER_ASK,
  LEAVE_OPEN,
  BROWSER_SCRIPT,
  firstWords,
} from "./mock-data";
import type { MockEngine } from "./mock";

export function send(mock: MockEngine, botId: string, rawText: string, opts: { holdAt?: number } = {}, attachmentIds: string[] = [], mode?: FollowUp): { item: UserItem } {
  const bot = mock.bot(botId);
  const text = rawText.trim();
  if (attachmentIds.length > ATTACHMENTS_PER_MESSAGE) throw new EngineError({ code: "too_many", message: "You can attach up to 10 files to one message." });
  if (!text && attachmentIds.length === 0) throw new EngineError({ code: "bad_request", message: "The message is empty." });
  const attachments = mock.attach.take(botId, attachmentIds);
  const turn = mock.turns.get(botId);
  const busy = !!turn;
  // Steering (protocol 14): into the running answer turn, by the setting or this message's choice.
  const steerInto = busy && (mode ?? mock.chat.followUp) === "steer" && !!turn.id && !turn.stopped ? turn.id : undefined;
  const item = mock.add<UserItem>(bot.mainThreadId, {
    kind: "user",
    from: { type: "you" },
    queued: busy && !steerInto,
    ...(steerInto ? { steered: true, turnId: steerInto } : {}),
    text,
    ...(attachments.length ? { attachments } : {}),
  });
  mock.attach.remember(item);
  mock.upsert(item);
  if (!busy) void mock.runTurn(botId, item, opts);
  return { item };
}

export async function runTurn(mock: MockEngine, botId: string, message: UserItem, opts: { holdAt?: number }): Promise<void> {
  if (message.from.type === "you" && mock.flags.get("lostreply") === "1" && botId === LOST_BOT && LOST_ASK.test(message.text)) return runLostReplyTurn(mock, botId, message);
  if (message.from.type === "you" && STEPS_ASK.test(message.text)) return mock.runStepsTurn(botId, message);
  if (message.from.type === "you" && PUBLISH_ASK.test(message.text)) return mock.runPublishTurn(botId, message);
  if (message.from.type === "you" && ARTIFACT_ASK.test(message.text)) return mock.runArtifactTurn(botId, message);
  if (message.from.type === "you" && HELPER_ASK.test(message.text)) return mock.runHelperTurn(botId, message);
  if (message.from.type === "you" && BROWSER_ASK.test(message.text) && mock.browser.available) return mock.runBrowserTurn(botId, message);
  const bot = mock.bot(botId);
  const threadId = bot.mainThreadId;
  const turnId = `turn${mock.nextId++}`;
  const turn: Turn = { botId, threadId, stopped: false, id: turnId };
  mock.turns.set(botId, turn);

  mock.replace({ ...message, queued: false, turnId });
  const run = mock.runOfItem.get(message.id);
  const trig = run ? mock.triggers.find((t) => t.id === run.triggerId) : undefined;
  if (run && trig) mock.putRun(trig, { ...run, turnId });
  const fromChannel = mock.channelOfItem.get(message.id);
  if (fromChannel) {
    const record = mock.channelMessages.get(fromChannel.channelId)?.find((m) => m.id === fromChannel.messageId);
    if (record) mock.putChannelMessage({ ...record, turnId });
  }
  const channelAnswer = /nothing to answer|no reply/i.test(message.text) ? NO_REPLY : CHANNEL_ANSWER;
  let said = "";
  mock.setState(botId, "thinking", trig ? `Running ${trig.name}` : fromChannel ? "Reading the message from the channel" : "Thinking about your message");
  await later(700);

  if (!turn.stopped) {
    mock.setState(botId, "working", "Reading its notes");
    const tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: "Read state/onboardings.md", status: "running", detail: "state/onboardings.md" });
    mock.upsert(tool);
    await later(900);
    mock.replace({ ...tool, status: "done", durationMs: 900 });
    if (mock.turnHold && !turn.stopped) await new Promise<void>((r) => mock.turnRelease.push(r));
  }

  if (!turn.stopped) {
    mock.setState(botId, "thinking", "Writing an answer");
    let answer = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text: "", streaming: true });
    mock.upsert(answer);
    const words = (trig ? TRIGGER_ANSWER : fromChannel ? channelAnswer : ANSWER).split(/(?<=\s)/);
    const holdAfter = opts.holdAt === undefined ? Infinity : Math.floor(words.length * opts.holdAt);
    for (let n = 0; n < words.length && !turn.stopped; n++) {
      if (n === holdAfter) return; // the streaming scene holds still here, for pictures
      await later(35);
      if (turn.stopped) break;
      const textDelta = words[n]!;
      answer = { ...answer, text: answer.text + textDelta };
      const list = mock.threads.get(threadId)!;
      const i = list.findIndex((x) => x.id === answer.id);
      if (i >= 0) list[i] = answer;
      mock.emit({ event: "item.delta", data: { threadId, itemId: answer.id, textDelta } });
    }
    mock.replace({ ...answer, streaming: false });
    said = answer.text;
  }

  mock.turns.delete(botId);
  if (fromChannel) {
    mock.channelOfItem.delete(message.id);
    await mock.answerChannel(fromChannel, said, turnId, turn.stopped);
  }
  if (run && trig) {
    mock.runOfItem.delete(message.id);
    mock.putRun(trig, { ...run, turnId, status: turn.stopped ? "failed" : "done", note: turn.stopped ? "Stopped by you" : firstWords(TRIGGER_ANSWER) });
  }
  if (!mock.bots.some((b) => b.id === botId)) return;
  // The session grows with every turn; a bot's first turn starts one.
  const grown = mock.bot(botId).context;
  const context = grown ? { ...grown, tokens: grown.tokens + 3_400 } : { tokens: 21_000, window: WINDOW, since: new Date().toISOString(), tidying: false };
  mock.bots = mock.bots.map((b) => (b.id === botId ? { ...b, context } : b));
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.setState(botId, "idle", "Stopped by you");
  } else {
    const time = new Date().toTimeString().slice(0, 5);
    // After a turn the bot writes a line in its log, saved as a change by the bot.
    const path = `memory/log/${isoDay()}.md`;
    const before = mock.folder(botId).get(path)?.text;
    mock.botWrites(botId, path, `${before ?? `# ${isoDay()}\n`}- ${time} Answered a question about the onboardings.\n`);
    mock.settle(botId, "done", `Answered at ${time}`);
    // What the main bot changed in the turn: quiet lines in its main chat once the turn has ended (engine/core/notes.ts).
    for (const text of mock.linesAfterTurn.splice(0)) mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text }));
  }

  mock.afterTurn(botId);
}

/** Where a held "step by step" turn waits, until `stepOn`. */
export async function stepGate(mock: MockEngine, phase: string): Promise<void> {
  mock.stepAt = phase;
  if (mock.stepHold) await new Promise<void>((r) => (mock.stepRelease = r));
  mock.stepRelease = undefined;
}

/**
 * A turn that reads in the order it happens: a moment of thinking, a text, two steps with a moment
 * of thinking before each, then the answer. The engine's words: "Thinking" between things, the
 * step's own words while it runs, "Writing a reply" while text arrives.
 */
export async function runStepsTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.replace({ ...message, queued: false, turnId });
  const text = async (words: string, name: string) => {
    mock.setState(botId, "thinking", "Writing a reply");
    let item = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text: "", streaming: true });
    mock.upsert(item);
    const parts = words.split(/(?<=\s)/);
    for (let n = 0; n < parts.length && !turn.stopped; n++) {
      if (n === Math.floor(parts.length / 2)) await mock.stepGate(`halfway through ${name}`);
      await later(30);
      if (turn.stopped) break;
      item = { ...item, text: item.text + parts[n]! };
      const list = mock.threads.get(threadId)!;
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      mock.emit({ event: "item.delta", data: { threadId, itemId: item.id, textDelta: parts[n]! } });
    }
    mock.replace({ ...item, streaming: false });
  };
  const think = async (before: string) => {
    mock.setState(botId, "thinking", "Thinking");
    await later(450);
    await mock.stepGate(`thinking before ${before}`);
  };
  await think("the first text");
  if (!turn.stopped) await text(STEPS_FIRST, "the first text");
  for (const [now, past, detail, kind] of STEPS) {
    if (turn.stopped) break;
    await think(past);
    if (turn.stopped) break;
    mock.setState(botId, "working", now);
    const tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: now, status: "running", detail, tool: kind });
    mock.upsert(tool);
    await later(600);
    await mock.stepGate(`running ${past}`);
    mock.replace({ ...tool, label: past, status: "done", durationMs: 600 });
  }
  if (!turn.stopped) await think("the answer");
  if (!turn.stopped) await text(STEPS_ANSWER, "the answer");
  mock.stepAt = "";
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.settle(botId, "idle", "Stopped by you");
  } else mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  mock.afterTurn(botId);
}

/** A workspace is gone from the browser: every open row for it turns "closed". */
export function closeSpace(mock: MockEngine, spaceId: string): void {
  mock.browser.close(spaceId);
  const endedAt = new Date().toISOString();
  for (const [, items] of mock.threads)
    for (const it of items) if (it.kind === "browser" && it.spaceId === spaceId && it.status === "open") mock.replace({ ...it, status: "closed", endedAt });
}

export function seedBrowser(mock: MockEngine): void {
  const t = "kaja-main";
  const step = (label: string, turnId: string, time: string, ms = 8_000) =>
    mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId, label, status: "done", durationMs: ms, detail: BROWSER_SCRIPT }, time);
  const say = (text: string, turnId: string, time: string) => mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId, text }, time);
  const ask = (text: string, turnId: string, time: string) => mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId, text }, time);
  const row = (spaceId: string, name: string, status: BrowserItem["status"], last: string, turnId: string, time: string, endedAt?: string) =>
    mock.add<BrowserItem>(t, { kind: "browser", botId: "kaja", spaceId, name, status, last, turnId, ...(endedAt ? { endedAt } : {}) }, time);

  // A turn whose workspace Kaja closed when it was done: the row folds away with the work.
  ask("Look up the Aalto report settings in the browser.", "tb-aalto", today(9, 50));
  row("s-aalto", "Aalto report settings", "closed", "Report settings · app.example.com", "tb-aalto", today(9, 50), today(9, 52));
  step("Worked in the browser", "tb-aalto", today(9, 50));
  say("The Aalto report uses the standard template, with the logo from last year.", "tb-aalto", today(9, 52));

  // A turn that left its workspace open for the person: the row stays in sight with the answer.
  mock.browser.addSpace({
    id: "s-kaja",
    name: "Check the survey settings",
    owner: "bot",
    botId: "kaja",
    pages: [mock.browser.page("https://app.example.com/surveys", "Surveys"), mock.browser.page("https://app.example.com/surveys/settings", "Survey settings")],
  });
  ask("Check the survey settings for Nordvik in the browser.", "tb-survey", today(9, 55));
  row("s-kaja", "Check the survey settings", "open", "Surveys · app.example.com", "tb-survey", today(9, 55));
  step("Worked in the browser", "tb-survey", today(9, 55));
  say("The settings page asks for a sign-in. I left it open in the browser beside the chat: sign in there and tell me, and I go on.", "tb-survey", today(9, 56));

  // The person's own page and work of another program.
  mock.browser.addSpace({ id: "s-you", name: "pobots: your page", owner: "you", pages: [mock.browser.page("https://example.com/", "Example Domain")] });
  mock.browser.addSpace({ id: "s-other", name: "Inventory sync", owner: "other", pages: [mock.browser.page("https://example.org/inventory", "Inventory", { width: 1024, height: 700 })] });
  mock.bots = mock.bots.map((b) => (b.id === "kaja" ? { ...b, state: "done", activity: "Answered at 09:56" } : b));
}

/**
 * A turn that works in the browser: a moment of thinking, then a new workspace with the bot's row
 * (busy while the command runs, its line following the page), a step for the command, and the
 * answer. The workspace is closed at the end, or left open for the person with "leave it open".
 * Held at every moment with `holdSteps`.
 */
export async function runBrowserTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.replace({ ...message, queued: false, turnId });
  const leave = LEAVE_OPEN.test(message.text);
  mock.setState(botId, "thinking", "Thinking");
  await later(400);
  await mock.stepGate("thinking before the browser");
  const spaceId = `s-${botId}-${mock.nextId++}`;
  let item: BrowserItem | undefined;
  let tool: ActivityItem | undefined;
  if (!turn.stopped) {
    mock.browser.addSpace({ id: spaceId, name: "Look up the Nordvik import", owner: "bot", botId, busy: true, pages: [mock.browser.page("https://app.example.com/imports", "Imports")] });
    item = mock.add<BrowserItem>(threadId, { kind: "browser", botId, turnId, spaceId, name: "Look up the Nordvik import", status: "open", last: "Imports · app.example.com" });
    mock.upsert(item);
    mock.setState(botId, "working", "Working in the browser");
    tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: "Working in the browser", status: "running", detail: BROWSER_SCRIPT });
    mock.upsert(tool);
    await later(500);
    await mock.stepGate("working in the browser");
  }
  if (!turn.stopped && item) {
    mock.browser.navigate(spaceId, "https://app.example.com/imports/nordvik", "Nordvik import");
    item = { ...item, last: "Nordvik import · app.example.com" };
    mock.replace(item);
    await later(500);
    await mock.stepGate("on the second page");
  }
  if (tool) mock.replace({ ...tool, label: "Worked in the browser", status: "done", durationMs: 1000 });
  mock.browser.setBusy(spaceId, false);
  if (!turn.stopped && !leave) mock.closeSpace(spaceId);
  if (!turn.stopped) {
    mock.setState(botId, "thinking", "Writing a reply");
    await later(200);
    await mock.stepGate("before the answer");
    const text = leave
      ? "The import page needs you to choose the file. I left it open in the browser beside the chat; tell me when it is done."
      : "The Nordvik import is set for Thursday at 10:00, with 412 people in the file.";
    mock.upsert(mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text, streaming: false }));
  }
  mock.stepAt = "";
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.settle(botId, "idle", "Stopped by you");
  } else mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  mock.afterTurn(botId);
}

/** `bot.startFresh`: begins a tidy turn now, or says there is nothing to tidy. */
export function startFresh(mock: MockEngine, botId: string): { started: boolean } {
  const bot = mock.bot(botId);
  if (bot.context?.tidying) throw new EngineError({ code: "conflict", message: `${bot.name} is already writing down what matters.` });
  if ((bot.helpers ?? 0) > 0) throw new EngineError({ code: "conflict", message: `${bot.name}'s helpers are working. Try again when they are done.` });
  if (mock.turns.has(botId)) throw new EngineError({ code: "conflict", message: `${bot.name} is in the middle of something. Try again when it is done.` });
  if (mock.threads.get(bot.mainThreadId)?.some((i) => i.kind === "user" && i.queued))
    throw new EngineError({ code: "conflict", message: `${bot.name} has messages waiting. Try again when they are answered.` });
  if (!bot.context || bot.context.tokens <= 0) return { started: false };
  void mock.runTidy(botId);
  return { started: true };
}

/**
 * A tidy turn as the engine runs it: Pobots' request in the main chat, the bot writing its memory
 * files, its note; then the "fresh" notice and an empty session. A turn that fails or is stopped
 * adds nothing to the chat and keeps the session. Messages that came meanwhile run after it.
 */
export async function runTidy(mock: MockEngine, botId: string): Promise<void> {
  const bot = mock.bot(botId);
  const threadId = bot.mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  const before = bot.context!;
  mock.turns.set(botId, turn);
  mock.upsert(mock.add<UserItem>(threadId, { kind: "user", from: { type: "app", reason: "tidy" }, queued: false, turnId, text: TIDY_PROMPT }));
  mock.putBot({ ...bot, state: "working", activity: "Writing down what matters", context: { ...before, tidying: true } });

  const writes: [string, (old: string | undefined) => string][] = [
    ["memory/MEMORY.md", (old) => `${old ?? "# Memory\n"}- promises.md: open promises and their dates\n`],
    ["memory/promises.md", () => "# Open promises\n\n- Nordvik: the import date by Thursday 10:00\n"],
  ];
  for (const [path, text] of writes) {
    await later(450);
    if (turn.stopped) break;
    const step = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: `Editing ${path}`, status: "running", detail: path });
    mock.upsert(step);
    await later(350);
    if (!mock.bots.some((b) => b.id === botId)) return;
    mock.botWrites(botId, path, text(mock.folder(botId).get(path)?.text));
    mock.replace({ ...step, label: `Edited ${path}`, status: "done", durationMs: 350 });
  }

  let note = "";
  if (!turn.stopped && !mock.tidyFail) {
    let answer = mock.add<BotItem>(threadId, { kind: "bot", botId, turnId, text: "", streaming: true });
    mock.upsert(answer);
    for (const textDelta of FRESH_NOTE.split(/(?<=\n)/)) {
      await later(40);
      if (turn.stopped) break;
      answer = { ...answer, text: answer.text + textDelta };
      const list = mock.threads.get(threadId)!;
      const i = list.findIndex((x) => x.id === answer.id);
      if (i >= 0) list[i] = answer;
      mock.emit({ event: "item.delta", data: { threadId, itemId: answer.id, textDelta } });
    }
    mock.replace({ ...answer, streaming: false });
    note = turn.stopped ? "" : answer.text.trim();
  }

  // A check can hold the turn here, its steps done and its note written, to look at the line.
  if (mock.tidyHold && !turn.stopped) await new Promise<void>((r) => (mock.tidyRelease = r));
  mock.tidyRelease = undefined;
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;

  const time = new Date().toTimeString().slice(0, 5);
  const ok = !turn.stopped && note !== "";
  const end = () => {
    const now = mock.bot(botId);
    const context = ok ? { tokens: 0, window: before.window, since: new Date().toISOString(), tidying: false } : { ...(now.context ?? before), tidying: false };
    mock.putBot({ ...now, state: "idle", activity: ok ? `Started fresh at ${time}` : turn.stopped ? "Stopped by you" : `Quiet since ${time}`, context });
  };
  if (ok) {
    const notice = () => mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Started fresh", mark: "fresh", detail: note.slice(0, 4000), tidyTurnId: turnId }));
    if (mock.tidyEndFirst) {
      end();
      await later(500);
      notice();
    } else {
      notice();
      end();
    }
  } else end();

  // Whatever waited behind the tidy turn runs now, in the fresh session.
  await later(300);
  const next = mock.threads.get(threadId)?.find((i): i is UserItem => i.kind === "user" && i.queued);
  if (next && !mock.turns.has(botId)) void mock.runTurn(botId, next, {});
}
