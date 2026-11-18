// Step 3a through the engine: a bot on a GPT model (CodexSession on the fake app-server), changing a
// bot between Claude and ChatGPT, and start_helper on both kinds. Claude sessions are FakeSession.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, ArtifactItem, BotItem, Card, Events, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { codexWorld, fakeCodex, waitFor } from "./codex-fake.js";
import { lastState, settle, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const inThread = (events: Ev[], threadId: string) => items(events).filter((i) => i.threadId === threadId);
const botTexts = (events: Ev[], threadId: string) =>
  inThread(events, threadId)
    .filter((i): i is BotItem => i.kind === "bot")
    .map((i) => i.text);
const notices = (events: Ev[], threadId: string) =>
  inThread(events, threadId)
    .filter((i): i is NoticeItem => i.kind === "notice")
    .map((i) => i.text);
const helperRows = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const cards = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);
const removed = (events: Ev[]) => events.filter((e) => e.event === "card.removed").map((e) => (e.data as Events["card.removed"]).cardId);
const openCards = (events: Ev[]) => cards(events).filter((c) => !removed(events).includes(c.id));
const stateOf = (events: Ev[], id: string) => lastState(events, id)?.state;

/** A Claude bot's own turn on FakeSession. */
function claudeTurn(s: FakeSession, body: () => void, text = "done") {
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  body();
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

const asLooseSandbox = (v: unknown): { type?: string; writableRoots?: string[] } => (v && typeof v === "object" ? (v as { type?: string; writableRoots?: string[] }) : {});

describe("a bot on a GPT model", () => {
  test("Codex not checked yet: no GPT models, not ready; after the check: ready, the list Claude first then GPT, status.updated", async () => {
    const w = codexWorld();
    const before = w.engine.snapshot();
    // The first check runs at start without holding it up; wait for it.
    await w.engine.recheckCodex();
    const after = w.engine.snapshot();
    assert.equal(after.status.codex.ready, true);
    assert.equal(after.status.codex.version, "0.165.0");
    const harnesses = after.models.map((m) => m.harness);
    assert.ok(harnesses.indexOf("codex") > harnesses.lastIndexOf("claude"), "Claude first, then GPT");
    assert.deepEqual(after.models.filter((m) => m.harness === "codex").map((m) => m.id), ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"]);
    assert.ok(w.events.some((e) => e.event === "status.updated" && (e.data as Events["status.updated"]).status.codex.ready));
    assert.ok(before.status.codex.ready === false || before.models.some((m) => m.harness === "codex"));
    w.engine.shutdown();
    w.store.close();
  });

  test("not ready: no GPT models except those bots use; a GPT bot's message ends blocked with Codex's sentence", async () => {
    const w = codexWorld({ ready: false });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    assert.equal(bot.harness, "codex");
    const snap = w.engine.snapshot();
    assert.equal(snap.status.codex.ready, false);
    assert.equal(snap.status.codex.problem, "Codex is not signed in. Run codex login in a terminal on the Mac.");
    assert.deepEqual(snap.models.filter((m) => m.harness === "codex").map((m) => m.id), ["gpt-6-luna"], "only the one a bot uses");
    w.engine.sendMessage({ botId: bot.id, text: "hello" });
    await waitFor(() => stateOf(w.events, bot.id) === "blocked", 5000, "blocked");
    assert.deepEqual(notices(w.events, bot.mainThreadId), ["Codex is not signed in. Run codex login in a terminal on the Mac."]);
    assert.equal(w.codexSessions.length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("end to end: an answer, a card without Always allow, an artifact row, a remembered thread after a restart", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const codex = fakeCodex();
    let w = codexWorld({ dirs, codex });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "asks-first" });
    w.engine.sendMessage({ botId: bot.id, text: "Say a word [[answer:pelican]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.deepEqual(botTexts(w.events, bot.mainThreadId), ["pelican"]);
    const start = codex.received("thread/start").at(-1)!;
    assert.match(String(start.developerInstructions), /You are Gee, a persistent bot that lives in Pobots/);
    assert.doesNotMatch(String(start.developerInstructions), /Publish to Claude with the Artifact tool/, "a GPT bot is not told about a tool it lacks");
    assert.ok((start.dynamicTools as { name: string }[]).some((t) => t.name === "start_helper"));
    assert.ok(w.store.getSessionMeta(bot.mainThreadId)?.tools, "the tool list's fingerprint is kept with the thread");
    assert.equal(w.store.getSessionMeta(bot.mainThreadId)?.harness, "codex");

    // A card before a command, without Always allow; Allow goes on.
    w.engine.sendMessage({ botId: bot.id, text: "[[approve]]" });
    await waitFor(() => openCards(w.events).length === 1, 8000, "the card");
    const card = openCards(w.events)[0] as ApprovalCard;
    assert.equal(card.title, "Run this command?");
    assert.equal(card.detail, "echo approved > made.txt");
    assert.equal(card.noAlways, true);
    assert.equal(stateOf(w.events, bot.id), "waiting");
    w.engine.resolveCard(card.id, { type: "allow-once" });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).includes("accepted"), 8000, "accepted");
    const act = inThread(w.events, bot.mainThreadId).filter((i) => i.kind === "activity");
    assert.ok(act.some((a) => a.kind === "activity" && a.label === "Ran a command" && a.status === "done"));

    // An artifact the bot makes as a file and shows with its tool.
    w.engine.sendMessage({ botId: bot.id, text: "[[artifact]]" });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).includes("shown"), 8000, "shown");
    const art = inThread(w.events, bot.mainThreadId).find((i): i is ArtifactItem => i.kind === "artifact")!;
    assert.ok(art, "an artifact row");
    assert.equal(art.artifact.path, "artifacts/page/index.html");
    assert.equal(art.what, "made");
    assert.ok(inThread(w.events, bot.mainThreadId).some((i) => i.kind === "activity" && i.label === "Wrote index.html"));
    await waitFor(() => stateOf(w.events, bot.id) === "done", 5000, "done");

    // After a restart the thread is taken up and remembers.
    w.engine.shutdown();
    w.store.close();
    w = codexWorld({ dirs, codex });
    await w.engine.recheckCodex();
    w.engine.sendMessage({ botId: bot.id, text: "[[recall]]" });
    // The answer streams in, so wait for the whole of it (under load the first delta, "I sa", was read).
    await waitFor(() => botTexts(w.events, bot.mainThreadId).at(-1) === "I said: shown", 8000, "the recall, whole");
    assert.equal(botTexts(w.events, bot.mainThreadId).at(-1), "I said: shown");
    assert.equal(codex.received("thread/resume").length, 1);
    w.engine.shutdown();
    w.store.close();
  });

  test("a fresh start: a tidy turn on Codex, the old thread archived, a new thread with the note", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:first]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const oldThread = w.store.getThread(bot.mainThreadId)!.sessionId!;
    assert.deepEqual(w.engine.startFresh(bot.id), { started: true });
    await waitFor(() => inThread(w.events, bot.mainThreadId).some((i) => i.kind === "notice" && i.mark === "fresh"), 8000, "the fresh line");
    const tidyTurn = w.codex.received("turn/start").at(-1)!;
    assert.equal(tidyTurn.approvalPolicy, "never", "a tidy turn asks nothing: its sandbox lets only the memory folder be written");
    assert.equal(asLooseSandbox(tidyTurn.sandboxPolicy).type, "workspaceWrite");
    assert.match(String(asLooseSandbox(tidyTurn.sandboxPolicy).writableRoots), /memory$/, "only the memory folder is writable");
    await waitFor(() => w.codex.threads()[oldThread]?.archived === true, 5000, "the old thread archived");
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:second]]" });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).includes("second"), 8000, "second");
    assert.equal(w.codex.received("thread/start").length, 2, "a new thread");
    const input = (w.codex.received("turn/start").at(-1)!.input as { text: string }[]).map((i) => i.text).join("\n");
    assert.match(input, /this is a fresh session in the same chat/);
    assert.match(input, /\nok\n|^ok$|\nok$/m, "the note the bot wrote (the fake answered ok)");
    w.engine.shutdown();
    w.store.close();
  });

  test("a changed tool list: no resume, a fresh thread, calmly said, the old one archived", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:first]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const old = w.store.getThread(bot.mainThreadId)!.sessionId!;
    // As if a new release had added a tool since the thread began.
    w.store.setSessionMeta(bot.mainThreadId, { harness: "codex", tools: "0000000000000000" });
    w.engine.shutdown();
    w.store.close();
    const w2 = codexWorld({ dirs: w.dirs, codex: w.codex });
    await w2.engine.recheckCodex();
    w2.engine.sendMessage({ botId: bot.id, text: "[[answer:second]]" });
    await waitFor(() => botTexts(w2.events, bot.mainThreadId).includes("second"), 8000, "second");
    assert.equal(w.codex.received("thread/resume").length, 0);
    assert.equal(w.codex.received("thread/start").length, 2);
    assert.deepEqual(notices(w2.events, bot.mainThreadId), ["Started a fresh session after an update."]);
    await waitFor(() => w.codex.threads()[old]?.archived === true, 5000, "archived");
    w2.engine.shutdown();
    w2.store.close();
  });

  test("a slow own tool (a question for the person) is answered early; the card outlives the turn; the answer comes in a turn of its own", async () => {
    const w = codexWorld({ timings: { codexToolSoftMs: 150 } });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    w.engine.sendMessage({ botId: bot.id, text: '[[tool:ask_human]]{"question":"Which colour?"}' });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).length === 1, 8000, "the early answer");
    assert.match(botTexts(w.events, bot.mainThreadId)[0]!, /tool said: This is still going/);
    await waitFor(() => stateOf(w.events, bot.id) === "done", 5000, "done");
    const q = openCards(w.events) as Card[];
    assert.equal(q.length, 1, "the question stays open after the turn");
    w.engine.resolveCard(q[0]!.id, { type: "text", text: "green" });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).length === 2, 8000, "the turn with the answer");
    const told = (w.codex.received("turn/start").at(-1)!.input as { text: string }[]).map((i) => i.text).join("\n");
    assert.match(told, /your earlier call to ask_human has finished/);
    assert.match(told, /The person answered: green/);
    assert.equal(inThread(w.events, bot.mainThreadId).filter((i) => i.kind === "user").length, 1, "no message in the chat for it");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("changing a bot between Claude and ChatGPT", () => {
  test("refused while it works; refused when Codex is not there; otherwise a fresh session on the other side with the end of the chat, and back", async () => {
    const w = codexWorld({ ready: false });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    assert.equal(bot.harness, "claude");
    w.engine.sendMessage({ botId: bot.id, text: "Remember the word pelican." });
    await settle();
    const s = w.sessions.at(-1)!;
    await assert.rejects(w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6-luna" } }), (e: EngineError) => e.code === "conflict" && e.message === "Wait until the bot is done, then change its model.");
    s.reply("I will remember pelican.");
    await settle();
    await assert.rejects(w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6-luna" } }), (e: EngineError) => e.code === "harness_unavailable" && /not signed in/.test(e.message));
    w.setReady(true);
    const changed = await w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6-luna", effort: "low" } });
    assert.equal(changed.harness, "codex");
    assert.equal(changed.model, "gpt-6-luna");
    assert.ok(s.closed, "the old session is closed");
    assert.equal(w.store.getThread(bot.mainThreadId)!.sessionId, null, "and forgotten");
    assert.ok(notices(w.events, bot.mainThreadId).includes("Changed from Claude to ChatGPT. The bot starts a fresh session with its memory and the end of this chat."));
    w.engine.sendMessage({ botId: bot.id, text: "Which word? [[answer:pelican]]" });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).includes("pelican"), 8000, "the GPT answer");
    const input = (w.codex.received("turn/start").at(-1)!.input as { text: string }[]).map((i) => i.text).join("\n");
    assert.match(input, /you were moved from a Claude model to a GPT model/);
    assert.match(input, /Remember the word pelican\./, "the end of the chat");
    assert.equal(w.store.getHarnessSwitch(bot.mainThreadId), undefined, "handed over once");
    const codexThread = w.store.getThread(bot.mainThreadId)!.sessionId!;
    await waitFor(() => stateOf(w.events, bot.id) === "done", 5000, "done");

    // And back to Claude: the Codex thread goes to Codex's archive.
    await w.engine.updateBot({ botId: bot.id, patch: { model: "claude-haiku-5-5" } });
    assert.ok(notices(w.events, bot.mainThreadId).includes("Changed from ChatGPT to Claude. The bot starts a fresh session with its memory and the end of this chat."));
    await waitFor(() => w.codex.threads()[codexThread]?.archived === true, 5000, "archived");
    w.engine.sendMessage({ botId: bot.id, text: "And now?" });
    await settle();
    const back = w.sessions.at(-1)!;
    assert.notEqual(back, s);
    assert.equal(back.settings.resume, undefined, "never resumes a session of the other kind");
    assert.match(back.sent[0]!.before.join("\n"), /you were moved from a ChatGPT model to a Claude model/);
    w.engine.shutdown();
    w.store.close();
  });

  test("a model change within the same kind is no switch; the main bot's update_bot accepts GPT ids and its words name both kinds", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const main = w.engine.createBot({ name: "Main", model: "claude-haiku-5-5" });
    const other = w.engine.createBot({ name: "Other", model: "gpt-6-luna" });
    await w.engine.updateBot({ botId: other.id, patch: { model: "gpt-6.1-terra" } });
    assert.ok(!notices(w.events, other.mainThreadId).some((t) => t.startsWith("Changed from")));
    w.engine.sendMessage({ botId: main.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    const update = s.settings.tools.find((t) => t.name === "update_bot")!;
    assert.match(update.description, /GPT model/);
    assert.match(update.description, /gpt-6\.1-terra \(GPT-6\.1 Terra, has fast mode\)/);
    assert.match(s.settings.tools.find((t) => t.name === "create_bot")!.description, /Claude model or a GPT model/);
    // At once since docs/build/step-main-bot-tools.md (it was a card): the answer says what changed.
    const r = await s.tool("update_bot", { bot: other.id, model: "claude-sonnet-5-5" });
    assert.equal(openCards(w.events).length, 0, "no card");
    assert.match(r.content[0]!.text, /model from GPT-6\.1 Terra to Sonnet 5\.5|model from gpt-6\.1-terra to Sonnet 5\.5/);
    assert.equal(r.isError, undefined);
    assert.equal(lastState(w.events, other.id)?.harness, "claude");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("start_helper: a helper on any model", () => {
  const helperInput = (o: Record<string, unknown> = {}) => ({ title: "Say a word", task: "Answer with one word [[answer:plommon]]", model: "gpt-6-luna", effort: "low", ...o });

  test("a Claude bot starts a GPT helper and waits: one row with its model, its own thread, the result as the call's answer", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.sendMessage({ botId: bot.id, text: "Get a second opinion" });
    await settle();
    const s = w.sessions.at(-1)!;
    let result: Awaited<ReturnType<FakeSession["tool"]>> | undefined;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const input = helperInput();
    s.emit({ type: "tool-start", toolUseId: "tu-h1", name: "mcp__pobots__start_helper", input });
    void s.tool("start_helper", input).then((r) => (result = r));
    await waitFor(() => !!result, 8000, "the helper's result");
    assert.match(result!.content[0]!.text, /Your helper \w{8} "Say a word" is done\. Its result:\n\nplommon/);
    const row = helperRows(w.events)[0]!;
    assert.equal(row.threadId, bot.mainThreadId);
    assert.equal(row.title, "Say a word");
    assert.equal(row.model, "gpt-6-luna");
    assert.equal(row.effort, "low");
    assert.equal(row.background, false);
    assert.equal(row.status, "done");
    assert.equal(row.last, "plommon");
    const thread = w.engine.readThread({ threadId: row.helperThreadId }).items;
    assert.equal((thread[0] as UserItem).text, input.task);
    assert.equal((thread.at(-1) as BotItem).text, "plommon");
    assert.ok(!inThread(w.events, bot.mainThreadId).some((i) => i.kind === "activity"), "the row, not an activity line");
    const start = w.codex.received("thread/start").at(-1)!;
    assert.equal(start.ephemeral, true, "a helper's thread stays out of Codex's history");
    assert.deepEqual(start.dynamicTools, [], "none of the bot's tools");
    assert.equal(start.approvalPolicy, "on-request", "the bot's access level");
    assert.match(String(start.developerInstructions), /You are a helper started by the bot Po in Pobots for one task/);
    s.emit({ type: "tool-end", toolUseId: "tu-h1", isError: false, text: result!.content[0]!.text });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(stateOf(w.events, bot.id), "done");
    w.engine.shutdown();
    w.store.close();
  });

  test("wait false: the call returns at once, the bot works while the helper does, and is told the result in a turn of its own", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: "Start it" });
    await settle();
    const s = w.sessions.at(-1)!;
    const input = helperInput({ wait: false, task: "Wait then answer [[wait:300]]" });
    let r: Awaited<ReturnType<FakeSession["tool"]>> | undefined;
    claudeTurn(s, () => {
      s.emit({ type: "tool-start", toolUseId: "tu-h2", name: "mcp__pobots__start_helper", input });
    }, "I started a helper.");
    r = await s.tool("start_helper", input);
    assert.match(r.content[0]!.text, /^Started helper \w{8} "Say a word"\. You get the result in a new message when it is done\./);
    s.emit({ type: "tool-end", toolUseId: "tu-h2", isError: false, text: r.content[0]!.text });
    await settle();
    assert.equal(stateOf(w.events, bot.id), "working");
    assert.equal(lastState(w.events, bot.id)?.activity, "Waiting for a helper");
    assert.equal(helperRows(w.events)[0]!.background, true);
    await waitFor(() => s.sent.length === 2, 8000, "the wake turn");
    assert.match(s.sent[1]!.text, /^Your helper \w{8} "Say a word" is done\. Its result:\n\nwaited$/);
    assert.equal(helperRows(w.events)[0]!.status, "done");
    s.reply("The helper said waited.");
    await settle();
    assert.equal(stateOf(w.events, bot.id), "done");
    assert.deepEqual(inThread(w.events, bot.mainThreadId).filter((i) => i.kind === "user").map((i) => (i as UserItem).text), ["Start it"]);
    w.engine.shutdown();
    w.store.close();
  });

  test("a GPT bot starts a Claude helper: a card the helper raises is the bot's; the result comes back to the GPT bot", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    const args = JSON.stringify({ title: "Check a file", task: "Look at notes.txt", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: `[[tool:start_helper]]${args}` });
    await waitFor(() => w.sessions.length === 1, 8000, "the Claude helper's session");
    const helper = w.sessions[0]!;
    assert.equal(helper.settings.model, "claude-haiku-5-5");
    assert.deepEqual(helper.settings.disallowedTools, ["Agent", "Task"]);
    assert.equal(helper.settings.persist, false);
    assert.deepEqual(helper.settings.tools.map((t) => t.name), ["shorten_conversation"], "none of the bot's tools, only its own tool to ask to be shortened");
    assert.equal(helper.sent[0]!.text, "Look at notes.txt");
    const row = helperRows(w.events)[0]!;
    assert.equal(row.model, "claude-haiku-5-5");
    assert.equal(row.effort, "medium", "the model's own default");
    // A card the helper raises is the bot's, in the thread where the helper's row stands (as for a harness helper).
    const pending = helper.ask("Bash", { command: "cat notes.txt" });
    await waitFor(() => openCards(w.events).length === 1, 3000, "the helper's card");
    const raised = openCards(w.events)[0]!;
    assert.ok(raised.kind !== "system");
    assert.equal(raised.threadId, row.threadId);
    assert.equal(raised.botId, bot.id);
    w.engine.resolveCard(openCards(w.events)[0]!.id, { type: "allow-once" });
    assert.equal((await pending)?.behavior, "allow");
    helper.emit({ type: "session", sessionId: "h-1" });
    helper.emit({ type: "turn-start", own: true });
    helper.emit({ type: "tool-start", toolUseId: "ht1", name: "Read", input: { file_path: "/x/notes.txt" } });
    helper.emit({ type: "tool-end", toolUseId: "ht1", isError: false, text: "pelican" });
    helper.emit({ type: "text-start", key: "m1" });
    helper.emit({ type: "text-delta", key: "m1", text: "The word is " });
    helper.emit({ type: "text-delta", key: "m1", text: "pelican." });
    helper.emit({ type: "text-end", key: "m1" });
    helper.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], own: true });
    await waitFor(() => botTexts(w.events, bot.mainThreadId).length > 0, 8000, "the GPT bot's answer");
    assert.match(botTexts(w.events, bot.mainThreadId)[0]!, /tool said: Your helper \w{8} "Check a file" is done\. Its result:\n\nThe word is pelican\./);
    const done = helperRows(w.events)[0]!;
    assert.equal(done.status, "done");
    assert.equal(done.steps, 1);
    assert.ok(helper.closed, "the helper's session ends with it");
    w.engine.shutdown();
    w.store.close();
  });

  test("Stop on one helper; Stop on the bot; the limit of six; a folder outside refused without full access", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.sendMessage({ botId: bot.id, text: "Start helpers" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const start = async (n: number, extra: Record<string, unknown> = {}) => {
      const input = helperInput({ title: `Helper ${n}`, task: `Slow work [[slow]] ${n}`, wait: false, ...extra });
      s.emit({ type: "tool-start", toolUseId: `tu-${n}`, name: "mcp__pobots__start_helper", input });
      const r = await s.tool("start_helper", input);
      s.emit({ type: "tool-end", toolUseId: `tu-${n}`, isError: r.isError === true, text: r.content[0]!.text });
      return r;
    };
    for (let n = 1; n <= 6; n++) assert.equal((await start(n)).isError, undefined);
    const seventh = await start(7);
    assert.equal(seventh.isError, true);
    assert.match(seventh.content[0]!.text, /You already have 6 helpers working, which is the most at once/);
    assert.equal(helperRows(w.events).length, 6, "the seventh made no row");
    // Stop on one helper.
    const first = helperRows(w.events).find((h) => h.title === "Helper 1")!;
    await w.engine.stopHelper({ botId: bot.id, itemId: first.id });
    await waitFor(() => helperRows(w.events).find((h) => h.id === first.id)!.status === "stopped", 3000, "stopped");
    // A folder outside its own.
    const outside = tempDir("pobots-outside-");
    const refused = await start(8, { folder: outside });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0]!.text, "A folder outside your own is only allowed for a bot with full access.");
    const inside = join(w.dirs.botsDir, bot.id, "memory");
    mkdirSync(inside, { recursive: true });
    assert.ok(existsSync(inside));
    const okInside = await start(9, { folder: inside });
    assert.equal(okInside.isError, undefined, "a folder inside its own is fine");
    // Stop on the bot stops the rest, and nobody is woken for them.
    await w.engine.interrupt(bot.id);
    await waitFor(() => helperRows(w.events).every((h) => h.status !== "running"), 3000, "all stopped");
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.sent.length, 1, "no turn of its own for helpers stopped with the bot");
    assert.equal(w.codexSessions.filter((c) => !c.closed).length, 0, "no helper session left");
    w.engine.shutdown();
    w.store.close();
  });

  test("full access may name a folder outside; a helper of the harness's own tool gets its model and effort on the row", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const outside = tempDir("pobots-outside-");
    const input = helperInput({ folder: outside });
    s.emit({ type: "tool-start", toolUseId: "tu-o", name: "mcp__pobots__start_helper", input });
    const r = await s.tool("start_helper", input);
    assert.equal(r.isError, undefined);
    assert.equal(w.codex.received("thread/start").at(-1)!.cwd, outside);
    s.helperStart("tu-agent", { description: "Read the notes", prompt: "Read notes" });
    s.emit({ type: "tool-start", toolUseId: "tu-agent2", name: "Agent", input: { description: "Plan it", prompt: "Plan", model: "opus", effort: "high" } });
    const rows = helperRows(w.events);
    assert.equal(rows.find((h) => h.title === "Read the notes")!.model, undefined, "no model named: none on the row");
    const opus = rows.find((h) => h.title === "Plan it")!;
    assert.equal(opus.model, "claude-opus-5-5");
    assert.equal(opus.effort, "high");
    w.engine.shutdown();
    w.store.close();
  });

  test("a refused start_helper: a model that does not exist, an effort the model lacks", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: "go" });
    await settle();
    const s = w.sessions.at(-1)!;
    const a = await s.tool("start_helper", helperInput({ model: "gpt-99" }));
    assert.match(a.content[0]!.text, /There is no model called gpt-99\. Pick one of: .*gpt-6-luna/);
    const b = await s.tool("start_helper", helperInput({ effort: "max" }));
    assert.equal(b.content[0]!.text, "GPT-6 Luna does not offer max effort. It offers low, medium, high.");
    assert.equal(helperRows(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });
});
