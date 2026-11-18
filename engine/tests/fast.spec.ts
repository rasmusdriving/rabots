// Step 3b: fast mode as a choice. Which models have one (Codex's model list), the bot's setting in
// bot.json, bot.create and bot.update, the word sent to Codex on every thread start, resume and turn,
// start_helper, the main bot's create_bot and update_bot, and the log line when Codex reports another
// tier. Against the fake app-server (fake-codex.mjs) and FakeSession; no model.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Events, HelperItem, NoteCard } from "../../shared/protocol.js";
import { normalizeBotFile } from "../bots.js";
import type { HarnessEvent } from "../claude/session.js";
import { probeCodex } from "../codex/detect.js";
import { codexFastMode, mapAllCodexModels, mapCodexModels, modelHasFast, newestPerCodexFamily } from "../codex/models.js";
import { serviceTier } from "../codex/session.js";
import { FALLBACK_MODELS } from "../claude/models.js";
import { parseParams } from "../schemas.js";
import { codexSession, codexWorld, FAKE_ALL_MODELS, fakeCodex, waitFor } from "./codex-fake.js";
import { changeLines, lastState, settle, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const helperRows = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const cards = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);
const removed = (events: Ev[]) => events.filter((e) => e.event === "card.removed").map((e) => (e.data as Events["card.removed"]).cardId);
const openCards = (events: Ev[]) => cards(events).filter((c) => !removed(events).includes(c.id));
const stateOf = (events: Ev[], id: string) => lastState(events, id)?.state;
const describedAs = (schema: unknown) => String((schema as { description?: string } | undefined)?.description ?? "");
const sessionIdOf = (events: HarnessEvent[]) => (events.find((e) => e.type === "session") as Extract<HarnessEvent, { type: "session" }> | undefined)?.sessionId;

/** Collects what the engine writes to its log while `fn` runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), lines };
  } finally {
    process.stderr.write = write;
  }
}

const row = (o: Record<string, unknown>) => ({ id: "gpt-6-luna", displayName: "GPT-6 Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", ...o });

describe("fast mode: which models have one", () => {
  test("a priority tier gives fast with Codex's words; the older field alone gives fast without words; no tier, another tier, or an empty list gives none", () => {
    assert.deepEqual(codexFastMode(row({ serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }], additionalSpeedTiers: ["fast"] })), { fast: true, fastHint: "1.5x speed" });
    assert.deepEqual(codexFastMode(row({ additionalSpeedTiers: ["fast"] })), { fast: true }, "a Codex without serviceTiers");
    assert.equal(codexFastMode(row({})), undefined);
    assert.equal(codexFastMode(row({ serviceTiers: [] })), undefined);
    assert.equal(codexFastMode(row({ serviceTiers: [{ id: "flex", name: "Flex", description: "slower, cheaper" }] })), undefined, "no other tier is offered");
    assert.equal(codexFastMode(row({ serviceTiers: [], additionalSpeedTiers: ["fast"] })), undefined, "serviceTiers, when sent, decides");
    assert.deepEqual(codexFastMode(row({ serviceTiers: [{ id: "priority", name: "Fast", description: "  " }] })), { fast: true }, "no words when they are empty");
  });

  test("the hint is on one line and cut at 60 characters", () => {
    const long = "2x speed,\n  increased usage, and a great deal more words than anyone would put in a short note";
    const m = codexFastMode(row({ serviceTiers: [{ id: "priority", name: "Fast", description: long }] }))!;
    assert.ok(m.fastHint!.length <= 60, `${m.fastHint!.length} characters`);
    assert.ok(!/\n/.test(m.fastHint!));
    assert.ok(m.fastHint!.startsWith("2x speed, increased usage, and"));
  });

  test("the list: looked up before it is cut, so an older model keeps its fast mode; Claude models and unlisted ids have none", () => {
    const rows = [
      row({ id: "gpt-6-luna", serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }] }),
      row({ id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", additionalSpeedTiers: ["fast"] }),
      row({ id: "gpt-6-astra", displayName: "GPT-6 Astra", serviceTiers: [] }),
    ];
    const all = mapAllCodexModels(rows);
    assert.deepEqual(all.map((m) => m.id), ["gpt-6-luna", "gpt-5.6-luna", "gpt-6-astra"]);
    assert.deepEqual(mapCodexModels(rows).map((m) => m.id), ["gpt-6-luna", "gpt-6-astra"], "the offered list is cut");
    const luna = all.find((m) => m.id === "gpt-6-luna")!;
    assert.equal(luna.fast, true);
    assert.equal(luna.fastHint, "1.5x speed");
    assert.equal(all.find((m) => m.id === "gpt-6-astra")!.fast, undefined);
    assert.equal(modelHasFast("gpt-5.6-luna", all), true, "an older model");
    assert.equal(modelHasFast("gpt-6-astra", all), false);
    assert.equal(modelHasFast("gpt-9-nova", all), false, "an id Codex does not list");
    assert.equal(modelHasFast("claude-opus-5-5", [...FALLBACK_MODELS, ...all]), false);
    assert.ok(FALLBACK_MODELS.every((m) => m.fast === undefined && m.fastHint === undefined));
  });

  test("through the engine: Snapshot.models marks the GPT models with a fast mode and the hint; an older model a bot uses keeps its fast mode; an unlisted GPT id has none", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    w.engine.createBot({ name: "Old", model: "gpt-5.6-luna" });
    w.engine.createBot({ name: "Odd", model: "gpt-9-nova" });
    const models = w.engine.snapshot().models;
    const by = (id: string) => models.find((m) => m.id === id);
    assert.deepEqual([by("gpt-6.1-sol")!.fast, by("gpt-6.1-sol")!.fastHint], [true, "2x speed, increased usage"]);
    assert.deepEqual([by("gpt-6-luna")!.fast, by("gpt-6-luna")!.fastHint], [true, "1.5x speed"]);
    assert.equal(by("gpt-6-astra")!.fast, undefined);
    assert.equal(by("gpt-5.6-luna")!.fast, true, "an older model a bot still uses");
    assert.deepEqual(by("gpt-5.6-luna")!.efforts, ["low"], "with its own efforts");
    assert.equal(by("gpt-9-nova")!.fast, undefined);
    assert.ok(models.filter((m) => m.harness === "claude").every((m) => !m.fast));
    w.engine.shutdown();
    w.store.close();
  });

  test("detection through the fake: the probe reads the tiers", async () => {
    const f = fakeCodex();
    const r = await probeCodex(f.setup.executable!, f.setup.env, f.setup.args);
    assert.equal(r.models.find((m) => m.id === "gpt-6-luna")!.fastHint, "1.5x speed");
    assert.equal(r.models.find((m) => m.id === "gpt-6-astra")!.fast, undefined);
    assert.equal(r.allModels.find((m) => m.id === "gpt-5.6-luna")!.fast, true);
    assert.equal(r.models.some((m) => m.id === "gpt-5.6-luna"), false);
  });
});

describe("fast mode: the bot's setting", () => {
  test("bot.json without fast reads as on; with false it stays off; it is written after effort", () => {
    assert.equal(normalizeBotFile({ name: "Gee", model: "gpt-6-luna" }, "gee", "mac").fast, true);
    assert.equal(normalizeBotFile({ name: "Gee", model: "gpt-6-luna", fast: false }, "gee", "mac").fast, false);
    assert.equal(normalizeBotFile({ name: "Gee", model: "gpt-6-luna", fast: "no" }, "gee", "mac").fast, true, "anything but false is on");
  });

  test("a folder from before this step: the bot is fast in the snapshot and runs fast", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    mkdirSync(join(dirs.botsDir, "gee"), { recursive: true });
    writeFileSync(join(dirs.botsDir, "gee", "bot.json"), JSON.stringify({ name: "Gee", role: "main", purpose: "", look: { eyes: "round", gap: "mid" }, harness: "codex", model: "gpt-6-luna", effort: "low", access: "full-access", machine: "test-mac", mayMessage: [] }));
    const w = codexWorld({ dirs });
    await w.engine.recheckCodex();
    const bot = w.engine.snapshot().bots.find((b) => b.id === "gee")!;
    assert.equal(bot.fast, true);
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:heron]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.equal(w.codex.received("thread/start").at(-1)!.serviceTier, "priority");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    w.engine.shutdown();
    w.store.close();
  });

  test("bot.create and bot.update take fast, for any model; it is stored in bot.json and sent in bot.updated", async () => {
    assert.deepEqual(parseParams("bot.create", { name: "x", fast: false }), { name: "x", fast: false });
    assert.deepEqual(parseParams("bot.update", { botId: "x", patch: { fast: true } }), { botId: "x", patch: { fast: true } });
    assert.equal(parseParams("bot.update", { botId: "x", patch: { fast: "yes" } }), undefined);
    const w = codexWorld();
    await w.engine.recheckCodex();
    const gpt = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", fast: false });
    assert.equal(gpt.fast, false);
    const saved = JSON.parse(readFileSync(join(w.dirs.botsDir, gpt.id, "bot.json"), "utf8"));
    assert.equal(saved.fast, false);
    assert.deepEqual(Object.keys(saved).slice(Object.keys(saved).indexOf("effort"), Object.keys(saved).indexOf("effort") + 2), ["effort", "fast"]);
    assert.equal(w.engine.createBot({ name: "Default" }).fast, true, "on unless switched off");
    const claude = w.engine.createBot({ name: "Cee", model: "claude-haiku-5-5" });
    const changed = await w.engine.updateBot({ botId: claude.id, patch: { fast: false } });
    assert.equal(changed.fast, false, "taken for a model without a fast mode too");
    assert.equal(JSON.parse(readFileSync(join(w.dirs.botsDir, claude.id, "bot.json"), "utf8")).fast, false);
    assert.equal(lastState(w.events, claude.id)?.fast, false, "in bot.updated");
    // Kept when the model changes, and in effect again on a model with a fast mode.
    const moved = await w.engine.updateBot({ botId: claude.id, patch: { model: "gpt-6-luna" } });
    assert.equal(moved.fast, false);
    w.engine.shutdown();
    w.store.close();
  });

  test("a Claude bot's session is never told fast; a change of fast on a Claude bot changes nothing in its session", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Cee", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    assert.equal(s.settings.fast, false);
    await w.engine.updateBot({ botId: bot.id, patch: { fast: false } });
    assert.deepEqual(s.changes, []);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("fast mode: the word sent to Codex", () => {
  test("on: priority on thread/start and every turn/start; off: default; never left out, never null", async () => {
    assert.equal(serviceTier(true), "priority");
    assert.equal(serviceTier(false), "default");
    const f = fakeCodex();
    const on = codexSession(f.setup, { fast: true });
    on.session.start();
    await on.turn("Say ok");
    await on.turn("Say ok again");
    const onId = sessionIdOf(on.events)!;
    assert.equal(f.received("thread/start").at(-1)!.serviceTier, "priority");
    assert.deepEqual(f.received("turn/start").filter((t) => t.threadId === onId).map((t) => t.serviceTier), ["priority", "priority"]);
    on.session.close();
    const off = codexSession(f.setup, { fast: false });
    off.session.start();
    await off.turn("Say ok");
    const offId = sessionIdOf(off.events)!;
    assert.equal(f.received("thread/start").at(-1)!.serviceTier, "default");
    assert.deepEqual(f.received("turn/start").filter((t) => t.threadId === offId).map((t) => t.serviceTier), ["default"]);
    off.session.close();
    // Settings without fast (an older caller) mean off, said as a word.
    const none = codexSession(f.setup);
    none.session.start();
    await none.turn("Say ok");
    assert.equal(f.received("thread/start").at(-1)!.serviceTier, "default");
    none.session.close();
    for (const m of [...f.received("thread/start"), ...f.received("turn/start")]) {
      assert.ok(m.serviceTier === "priority" || m.serviceTier === "default", `sent ${JSON.stringify(m.serviceTier)}`);
    }
  });

  test("thread/resume carries the word; setFast changes the next turn in the same thread; a tidy turn carries it too", async () => {
    const f = fakeCodex();
    const dir = tempDir("pobots-codex-bot-");
    mkdirSync(join(dir, "memory"), { recursive: true });
    const a = codexSession(f.setup, { botDir: dir, fast: true });
    a.session.start();
    await a.turn("[[answer:plommon]]");
    const id = sessionIdOf(a.events)!;
    a.session.close();
    const b = codexSession(f.setup, { botDir: dir, resume: id, fast: false, access: "full-access" });
    b.session.start();
    await b.turn("[[recall]]");
    assert.equal(f.received("thread/resume").at(-1)!.serviceTier, "default");
    assert.equal(f.received("turn/start").at(-1)!.serviceTier, "default");
    await b.session.setFast(true);
    await b.turn("Say ok");
    assert.equal(f.received("turn/start").at(-1)!.serviceTier, "priority");
    await b.turn("Write your note", { tidy: true });
    assert.equal(f.received("turn/start").at(-1)!.serviceTier, "priority", "a tidy turn");
    assert.equal(f.received("thread/start").length, 1, "one thread all along");
    b.session.close();
  });

  test("Codex reports another tier than asked: one line in the log per session, with both values; nothing else", async () => {
    const f = fakeCodex({ FAKE_CODEX_TIER: "default" });
    const { lines } = await captureLog(async () => {
      const c = codexSession(f.setup, { fast: true });
      c.session.start();
      await c.turn("Say ok");
      await c.turn("Say ok again");
      c.session.close();
    });
    const said = lines.filter((l) => /reports another tier/.test(l));
    assert.equal(said.length, 1, said.join(""));
    assert.match(said[0]!, /it says "default", Pobots asked for "priority" \(fast mode on\)/);
    // The same tier as asked: no line.
    const g = fakeCodex();
    const quiet = await captureLog(async () => {
      const c = codexSession(g.setup, { fast: false });
      c.session.start();
      await c.turn("Say ok");
      c.session.close();
    });
    assert.ok(!quiet.lines.some((l) => /reports another tier/.test(l)));
  });
});

describe("fast mode: a GPT bot through the engine", () => {
  test("switched off between two turns: the next turn says default, in the same thread, with no new session", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:one]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const thread = w.store.getThread(bot.mainThreadId)!.sessionId;
    const off = await w.engine.updateBot({ botId: bot.id, patch: { fast: false } });
    assert.equal(off.fast, false);
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:two]]" });
    await waitFor(() => w.codex.received("turn/start").length === 2 && stateOf(w.events, bot.id) === "done", 8000, "the second turn");
    assert.deepEqual(w.codex.received("turn/start").map((t) => t.serviceTier), ["priority", "default"]);
    assert.equal(w.codex.received("thread/start").length, 1, "no new thread");
    assert.equal(w.codex.received("thread/resume").length, 0, "no new session");
    assert.equal(w.codexSessions.length, 1);
    assert.equal(w.store.getThread(bot.mainThreadId)!.sessionId, thread);
    // And back on.
    await w.engine.updateBot({ botId: bot.id, patch: { fast: true } });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:three]]" });
    await waitFor(() => w.codex.received("turn/start").length === 3 && stateOf(w.events, bot.id) === "done", 8000, "the third turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    w.engine.shutdown();
    w.store.close();
  });

  test("a change of model within Codex to one without a fast mode: default from then on, the choice kept; back to a model with one: priority", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:one]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const astra = await w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6-astra" } });
    assert.equal(astra.fast, true, "the choice is kept");
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:two]]" });
    await waitFor(() => w.codex.received("turn/start").length === 2 && stateOf(w.events, bot.id) === "done", 8000, "the second turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");
    assert.equal(w.codex.received("turn/start").at(-1)!.model, "gpt-6-astra");
    // The model change starts the harness again on the same thread; that resume says default too.
    assert.equal(w.codex.received("thread/resume").at(-1)!.serviceTier, "default");
    await w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6.1-terra" } });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:three]]" });
    await waitFor(() => w.codex.received("turn/start").length === 3 && stateOf(w.events, bot.id) === "done", 8000, "the third turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    w.engine.shutdown();
    w.store.close();
  });

  test("a model change within Codex while the session lives is passed on with setFast", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    // A turn that is still running keeps the session alive across the change.
    w.engine.sendMessage({ botId: bot.id, text: "[[wait:400]]" });
    await waitFor(() => w.codexSessions.length === 1 && w.codex.received("turn/start").length === 1, 8000, "the turn");
    const session = w.codexSessions[0]!;
    const calls: boolean[] = [];
    const real = session.setFast.bind(session);
    session.setFast = async (fast: boolean) => {
      calls.push(fast);
      return real(fast);
    };
    await w.engine.updateBot({ botId: bot.id, patch: { model: "gpt-6-astra" } });
    assert.deepEqual(calls, [false]);
    await w.engine.updateBot({ botId: bot.id, patch: { fast: false } });
    assert.deepEqual(calls, [false], "no change in effect on a model without a fast mode: nothing to tell");
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    w.engine.shutdown();
    w.store.close();
  });

  test("a tidy turn and the fresh session after it carry the bot's choice", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access", fast: false });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:first]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.deepEqual(w.engine.startFresh(bot.id), { started: true });
    await waitFor(() => w.codex.received("turn/start").length === 2, 8000, "the tidy turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default", "the tidy turn");
    await waitFor(() => stateOf(w.events, bot.id) === "done" || stateOf(w.events, bot.id) === "idle", 8000, "after the tidy turn");
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:second]]" });
    await waitFor(() => w.codex.received("thread/start").length === 2 && w.codex.received("turn/start").length === 3, 8000, "the fresh session");
    assert.equal(w.codex.received("thread/start").at(-1)!.serviceTier, "default");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    w.engine.shutdown();
    w.store.close();
  });

  test("a trigger's fresh run gets its own thread with the bot's choice", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    const t = w.engine.saveTrigger({ botId: bot.id, trigger: { kind: "schedule", name: "Pulse", prompt: "Look around.", where: "fresh", enabled: true, schedule: { type: "every", minutes: 180, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } } });
    w.engine.runTrigger(t.id);
    await waitFor(() => w.codex.received("turn/start").length === 1, 8000, "the run's turn");
    const start = w.codex.received("thread/start").at(-1)!;
    assert.equal(start.ephemeral, true, "a fresh run's own thread");
    assert.equal(start.serviceTier, "priority");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    await waitFor(() => stateOf(w.events, bot.id) === "done" || stateOf(w.events, bot.id) === "idle", 8000, "the end of the run");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("fast mode: start_helper", () => {
  const helperInput = (o: Record<string, unknown> = {}) => ({ title: "Say a word", task: "Answer with one word [[answer:plommon]]", model: "gpt-6-luna", effort: "low", ...o });

  /** A Claude bot calls start_helper once and waits for its answer. */
  async function callHelper(w: ReturnType<typeof codexWorld>, s: FakeSession, input: Record<string, unknown>, id: string) {
    s.emit({ type: "tool-start", toolUseId: id, name: "mcp__pobots__start_helper", input });
    const r = await s.tool("start_helper", input);
    s.emit({ type: "tool-end", toolUseId: id, isError: r.isError === true, text: r.content[0]!.text });
    await settle();
    return r;
  }

  test("left out: fast on a model with a fast mode; true: the same; false: not fast; true on a model without one: refused without a row", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    w.engine.sendMessage({ botId: bot.id, text: "Get second opinions" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });

    let r = await callHelper(w, s, helperInput({ title: "Left out" }), "tu-1");
    assert.match(r.content[0]!.text, /is done/);
    let row = helperRows(w.events).find((h) => h.title === "Left out")!;
    assert.equal(row.fast, true);
    assert.equal(w.codex.received("thread/start").at(-1)!.serviceTier, "priority");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");

    r = await callHelper(w, s, helperInput({ title: "Asked fast", fast: true }), "tu-2");
    row = helperRows(w.events).find((h) => h.title === "Asked fast")!;
    assert.equal(row.fast, true);
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");

    r = await callHelper(w, s, helperInput({ title: "Not fast", fast: false }), "tu-3");
    row = helperRows(w.events).find((h) => h.title === "Not fast")!;
    assert.equal("fast" in row, false, "absent, not false");
    assert.equal(w.codex.received("thread/start").at(-1)!.serviceTier, "default");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");

    const rows = helperRows(w.events).length;
    r = await callHelper(w, s, helperInput({ title: "Astra fast", model: "gpt-6-astra", fast: true }), "tu-4");
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "GPT-6 Astra has no fast mode. Leave fast out.");
    assert.equal(helperRows(w.events).length, rows, "no row");

    r = await callHelper(w, s, helperInput({ title: "Astra plain", model: "gpt-6-astra", fast: false }), "tu-5");
    assert.match(r.content[0]!.text, /is done/, "false on a model without one is fine");
    row = helperRows(w.events).find((h) => h.title === "Astra plain")!;
    assert.equal("fast" in row, false);
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");

    r = await callHelper(w, s, helperInput({ title: "Astra left out", model: "gpt-6-astra" }), "tu-6");
    row = helperRows(w.events).find((h) => h.title === "Astra left out")!;
    assert.equal("fast" in row, false, "a model without a fast mode runs without one");

    r = await callHelper(w, s, helperInput({ title: "Claude fast", model: "claude-sonnet-5-5", fast: true, task: "x" }), "tu-7");
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Sonnet 5.5 has no fast mode. Leave fast out.");
    w.engine.shutdown();
    w.store.close();
  });

  test("a Claude helper started with start_helper and a helper of the harness's own tool never carry fast", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", access: "edits-freely" });
    const claude = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    // A GPT bot starts a Claude helper (FakeSession): no fast on its row or in its session.
    w.engine.sendMessage({ botId: bot.id, text: `[[tool:start_helper]]${JSON.stringify({ title: "Ask Claude", task: "Say a word", model: "claude-haiku-5-5" })}` });
    await waitFor(() => w.sessions.length === 1, 8000, "the Claude helper's session");
    const helper = w.sessions[0]!;
    assert.equal(helper.settings.fast, false);
    helper.reply("wren");
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.equal("fast" in helperRows(w.events).find((h) => h.title === "Ask Claude")!, false);
    // A Claude bot's own helper tool.
    w.engine.sendMessage({ botId: claude.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.helperStart("h1", { description: "Own helper" });
    s.helperEnd("h1", "completed", "done");
    await settle();
    assert.equal("fast" in helperRows(w.events).find((h) => h.title === "Own helper")!, false);
    w.engine.shutdown();
    w.store.close();
  });

  test("the tool's description marks the models that have a fast mode and says what fast does", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: bot.id, text: "hi" });
    await settle();
    const tool = w.sessions.at(-1)!.settings.tools.find((t) => t.name === "start_helper")!;
    assert.match(tool.description, /gpt-6-luna \(GPT-6 Luna, has fast mode\)/);
    assert.match(tool.description, /gpt-6-astra \(GPT-6 Astra\)/);
    assert.match(tool.description, /claude-haiku-5-5 \(Haiku 5\.5\)/);
    assert.equal(describedAs(tool.shape.fast), "Fast mode for a helper on a GPT model: quicker answers, on some models for more usage. Leave out for on.");
    w.engine.shutdown();
    w.store.close();
  });
});

// Before docs/build/step-main-bot-tools.md these changes were cards and the tests read the card; now they
// happen at once and the tests read the person's quiet line in the main bot's chat (it was a note card
// until the tester's walk of 15 Nov 2026), which says the same parts. The turn is ended first, so each
// line comes at once instead of at the end of the turn.
describe("fast mode: the main bot's create_bot and update_bot", () => {
  async function mainSession(w: ReturnType<typeof codexWorld>) {
    const main = w.engine.createBot({ name: "Main", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: main.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.reply("ok");
    await settle();
    return { main, s };
  }
  // The tool has run up to its line by the time this is called (no await comes before it), so the
  // newest line in the main bot's chat is its line. Its parts, one per line, after the subject.
  async function decide(w: ReturnType<typeof codexWorld>, pending: Promise<unknown>) {
    await pending;
    const main = w.engine.snapshot().bots.find((b) => b.name === "Main")!;
    const line = changeLines(w.events, main.mainThreadId).at(-1);
    assert.ok(line, "a line");
    assert.ok(!cards(w.events).some((c) => c.kind === "approval" || c.kind === "note"), "no card");
    return { detail: line.slice(line.indexOf(": ") + 2).split("; ").join("\n") };
  }

  test("create_bot: the model line says fast on or off for a model with a fast mode, nothing for one without; true without one is refused; false there changes nothing", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const { s } = await mainSession(w);
    const base = { purpose: "Sorts mail", job: "Sort the mail." };
    let card = await decide(w, s.tool("create_bot", { ...base, name: "Fast One", model: "gpt-6-luna", effort: "low" }));
    assert.match(card.detail, /\nGPT-6 Luna, low effort, fast on\n/);
    assert.equal(w.engine.snapshot().bots.find((b) => b.name === "Fast One")!.fast, true);
    card = await decide(w, s.tool("create_bot", { ...base, name: "Slow One", model: "gpt-6-luna", effort: "low", fast: false }));
    assert.match(card.detail, /\nGPT-6 Luna, low effort, fast off\n/);
    assert.equal(w.engine.snapshot().bots.find((b) => b.name === "Slow One")!.fast, false);
    card = await decide(w, s.tool("create_bot", { ...base, name: "Astra One", model: "gpt-6-astra", fast: false }));
    assert.match(card.detail, /\nGPT-6 Astra, medium effort\n/, "no word about fast for a model without one");
    card = await decide(w, s.tool("create_bot", { ...base, name: "Claude One", model: "claude-sonnet-5-5" }));
    assert.match(card.detail, /\nSonnet 5\.5, medium effort\n/);
    const before = cards(w.events).length;
    const r = await s.tool("create_bot", { ...base, name: "Opus Fast", model: "claude-opus-5-5", fast: true });
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Opus 5.5 has no fast mode. Leave fast out.");
    assert.equal(cards(w.events).length, before, "no card");
    w.engine.shutdown();
    w.store.close();
  });

  test("update_bot: Fast from on to off; no line when nothing about it changes; a model that gains a fast mode says it; refusals", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const { s } = await mainSession(w);
    const gee = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    const cee = w.engine.createBot({ name: "Cee", model: "claude-haiku-5-5" });

    let card = await decide(w, s.tool("update_bot", { bot: "Gee", fast: false }));
    assert.equal(card.detail, "fast from on to off");
    assert.equal(lastState(w.events, gee.id)?.fast, false);

    card = await decide(w, s.tool("update_bot", { bot: "Gee", fast: true, effort: "medium" }));
    assert.equal(card.detail, "effort from low to medium\nfast from off to on");

    // fast as it is: nothing changes, so nothing is asked.
    let r = await s.tool("update_bot", { bot: "Gee", fast: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /Nothing would change/);

    // A model without a fast mode: true refused, false taken without a word and changing nothing.
    r = await s.tool("update_bot", { bot: "Gee", model: "gpt-6-astra", fast: true });
    assert.equal(r.content[0]!.text, "GPT-6 Astra has no fast mode. Leave fast out.");
    r = await s.tool("update_bot", { bot: "Cee", fast: true });
    assert.equal(r.content[0]!.text, "Haiku 5.5 has no fast mode. Leave fast out.");
    r = await s.tool("update_bot", { bot: "Cee", fast: false });
    assert.match(r.content[0]!.text, /Nothing would change/, "false on a model without one changes nothing");
    card = await decide(w, s.tool("update_bot", { bot: "Gee", model: "gpt-6-astra", fast: false }));
    assert.equal(card.detail, "model from GPT-6 Luna to GPT-6 Astra", "no fast line for a model without one");
    assert.equal(lastState(w.events, gee.id)?.fast, true, "the choice is unchanged");

    // A model that gains a fast mode says whether it will run fast.
    card = await decide(w, s.tool("update_bot", { bot: "Gee", model: "gpt-6.1-terra", fast: false }));
    assert.equal(card.detail, "model from GPT-6 Astra to GPT-6.1 Terra, fast off");
    assert.equal(lastState(w.events, gee.id)?.fast, false);
    card = await decide(w, s.tool("update_bot", { bot: "Cee", model: "gpt-6-luna" }));
    assert.equal(card.detail, "model from Haiku 5.5 to GPT-6 Luna, fast on");
    // Between two models that both have it, only a change of the choice is a line.
    card = await decide(w, s.tool("update_bot", { bot: "Cee", model: "gpt-6.1-sol" }));
    assert.equal(card.detail, "model from GPT-6 Luna to GPT-6.1 Sol");
    void cee;
    w.engine.shutdown();
    w.store.close();
  });

  test("the tools take fast and their descriptions name which models have it", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const { s } = await mainSession(w);
    for (const name of ["create_bot", "update_bot"]) {
      const t = s.settings.tools.find((x) => x.name === name)!;
      assert.ok(t.shape.fast, `${name} takes fast`);
      assert.match(describedAs(t.shape.fast), /Fast mode, for a GPT model that has it/);
      assert.match(t.description, /gpt-6\.1-terra \(GPT-6\.1 Terra, has fast mode\)/);
      assert.match(t.description, /gpt-6-astra \(GPT-6 Astra\)[,.]/);
    }
    w.engine.shutdown();
    w.store.close();
  });
});

// ------------------------------------------------------------ after the code review (six fixes by the orchestrator)

const noticesIn = (events: Ev[], threadId: string) => items(events).filter((i) => i.kind === "notice" && i.threadId === threadId).map((i) => (i as { text: string }).text);
const inputText = (m: Record<string, unknown>) => ((m.input as { text: string }[]) ?? []).map((i) => i.text).join("\n");

describe("fast mode, after the review", () => {
  test("1. a tidy turn on a thread with another tool list leaves the thread alone; the next real turn forgets it with the update handoff and the notice", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const codex = fakeCodex();
    let w = codexWorld({ dirs, codex });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "Remember the word heron [[answer:noted]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const old = w.store.getThread(bot.mainThreadId)!.sessionId!;
    // As after a release that changed a tool's schema.
    w.store.setSessionMeta(bot.mainThreadId, { harness: "codex", tools: "0000000000000000" });
    w.engine.shutdown();
    w.store.close();
    w = codexWorld({ dirs, codex });
    await w.engine.recheckCodex();

    assert.deepEqual(w.engine.startFresh(bot.id), { started: true });
    await waitFor(() => w.events.some((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.id === bot.id && (e.data as Events["bot.updated"]).bot.context?.tidying === false && !["thinking", "working"].includes((e.data as Events["bot.updated"]).bot.state)), 8000, "the tidy turn to end");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.store.getThread(bot.mainThreadId)!.sessionId, old, "the saved thread is still there");
    assert.equal(w.store.getSessionMeta(bot.mainThreadId)?.tools, "0000000000000000");
    assert.notEqual(codex.threads()[old]?.archived, true, "nothing archived");
    assert.equal(codex.received("thread/archive").length, 0);
    assert.equal(codex.received("thread/start").length, 1, "no new thread for the tidy turn");
    assert.ok(!noticesIn(w.events, bot.mainThreadId).includes("Started a fresh session after an update."));

    w.engine.sendMessage({ botId: bot.id, text: "[[answer:fresh]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done" && codex.received("turn/start").length === 2, 8000, "the real turn");
    const turn = codex.received("turn/start").at(-1)!;
    assert.match(inputText(turn), /Note from Pobots: Pobots was updated, so this is a fresh session in the same chat\./);
    assert.match(inputText(turn), /heron/, "the end of the chat came along");
    assert.ok(noticesIn(w.events, bot.mainThreadId).includes("Started a fresh session after an update."));
    assert.equal(codex.received("thread/start").length, 2, "a new thread");
    assert.equal(codex.received("thread/resume").length, 0);
    const now = w.store.getThread(bot.mainThreadId)!.sessionId!;
    assert.notEqual(now, old);
    await waitFor(() => codex.threads()[old]?.archived === true, 5000, "the old thread archived");
    w.engine.shutdown();
    w.store.close();
  });

  test("2. a change of fast while Codex is not ready reaches the live session at the next turn, both ways; a Claude bot is never told", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:one]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");

    w.setReady(false);
    await w.engine.recheckCodex();
    assert.equal(w.engine.snapshot().status.codex.ready, false);
    await w.engine.updateBot({ botId: bot.id, patch: { fast: false } });
    w.setReady(true);
    await w.engine.recheckCodex();
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:two]]" });
    await waitFor(() => w.codex.received("turn/start").length === 2 && stateOf(w.events, bot.id) === "done", 8000, "the second turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");
    assert.equal(w.codexSessions.length, 1, "the same session");
    assert.equal(w.codex.received("thread/start").length, 1, "the same thread");

    // The other way.
    w.setReady(false);
    await w.engine.recheckCodex();
    await w.engine.updateBot({ botId: bot.id, patch: { fast: true } });
    w.setReady(true);
    await w.engine.recheckCodex();
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:three]]" });
    await waitFor(() => w.codex.received("turn/start").length === 3 && stateOf(w.events, bot.id) === "done", 8000, "the third turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    assert.equal(w.codexSessions.length, 1);

    // A Claude bot: never told, turn after turn.
    const cee = w.engine.createBot({ name: "Cee", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: cee.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.reply("ok");
    await settle();
    await w.engine.updateBot({ botId: cee.id, patch: { fast: false } });
    w.engine.sendMessage({ botId: cee.id, text: "again" });
    await settle();
    assert.equal(w.sessions.at(-1), s);
    assert.equal(s.sent.length, 2);
    assert.equal(s.settings.fast, false);
    assert.deepEqual(s.changes.filter((c) => c.startsWith("fast:")), []);
    w.engine.shutdown();
    w.store.close();
  });

  test("2b. while Codex is not ready, a change of fast still reaches the live session at once (the last list Codex gave counts)", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:one]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    const session = w.codexSessions[0]!;
    const calls: boolean[] = [];
    const real = session.setFast.bind(session);
    session.setFast = async (fast: boolean) => {
      calls.push(fast);
      return real(fast);
    };
    w.setReady(false);
    await w.engine.recheckCodex();
    assert.equal(w.engine.snapshot().status.codex.ready, false);
    await w.engine.updateBot({ botId: bot.id, patch: { fast: false } });
    assert.deepEqual(calls, [false], "told at once, not only at the next turn");
    await w.engine.updateBot({ botId: bot.id, patch: { fast: true } });
    assert.deepEqual(calls, [false, true]);
    w.engine.shutdown();
    w.store.close();
  });

  test("2c. before every turn the session is told fast as it stands: Codex's list changed between turns, no bot.update", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "full-access" });
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:one]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    // Codex now lists Luna without a fast mode. Nothing is changed on the bot.
    const original = w.codex.setup;
    const noFast = FAKE_ALL_MODELS.map((m) => (m.id === "gpt-6-luna" ? { id: m.id, harness: m.harness, label: m.label, efforts: m.efforts, defaultEffort: m.defaultEffort } : m));
    w.codex.setup = { ...original, allModels: noFast, models: newestPerCodexFamily(noFast) };
    w.setReady(true);
    await w.engine.recheckCodex();
    assert.equal(w.engine.snapshot().models.find((m) => m.id === "gpt-6-luna")!.fast, undefined);
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:two]]" });
    await waitFor(() => w.codex.received("turn/start").length === 2 && stateOf(w.events, bot.id) === "done", 8000, "the second turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "default");
    // And back: the list has the fast mode again.
    w.codex.setup = original;
    w.setReady(true);
    await w.engine.recheckCodex();
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:three]]" });
    await waitFor(() => w.codex.received("turn/start").length === 3 && stateOf(w.events, bot.id) === "done", 8000, "the third turn");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    assert.equal(w.codexSessions.length, 1, "one session all along");
    assert.equal(w.codex.received("thread/start").length, 1, "one thread all along");
    w.engine.shutdown();
    w.store.close();
  });

  // It was "a card whose model line says fast on or off does that, also when the setting changed while
  // the card waited"; since docs/build/step-main-bot-tools.md there is no card to wait on.
  test("3. a model change that gains a fast mode says fast on or off and does that at once", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const main = w.engine.createBot({ name: "Main", model: "claude-haiku-5-5" });
    w.engine.sendMessage({ botId: main.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    const cee = w.engine.createBot({ name: "Cee", model: "claude-haiku-5-5" });
    await w.engine.updateBot({ botId: cee.id, patch: { fast: false } });
    let r = await s.tool("update_bot", { bot: "Cee", model: "gpt-6-luna" });
    assert.match(r.content[0]!.text, /model from Haiku 5\.5 to GPT-6 Luna, fast off/);
    assert.equal(lastState(w.events, cee.id)?.model, "gpt-6-luna");
    assert.equal(lastState(w.events, cee.id)?.fast, false, "as the answer said");
    const dee = w.engine.createBot({ name: "Dee", model: "claude-haiku-5-5", fast: false });
    r = await s.tool("update_bot", { bot: "Dee", model: "gpt-6-luna", fast: true });
    assert.match(r.content[0]!.text, /model from Haiku 5\.5 to GPT-6 Luna, fast on/);
    assert.equal(lastState(w.events, dee.id)?.fast, true, "as the answer said");
    assert.ok(!openCards(w.events).some((c) => c.kind === "approval"), "no card");
    w.engine.shutdown();
    w.store.close();
  });

  test("4. a bot on a model the list lacked: status.updated with the new list (and its fast mode) goes out before bot.added and bot.updated; none when the list is the same", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const kinds = (from: number) => w.events.slice(from).map((e) => e.event).filter((e) => e === "status.updated" || e === "bot.added" || e === "bot.updated");
    let from = w.events.length;
    w.engine.createBot({ name: "Plain", model: "gpt-6-luna" });
    assert.deepEqual(kinds(from), ["bot.added"], "the list did not change");

    from = w.events.length;
    w.engine.createBot({ name: "Old", model: "gpt-5.6-luna" });
    assert.deepEqual(kinds(from), ["status.updated", "bot.added"]);
    const sent = (w.events.slice(from).find((e) => e.event === "status.updated")!.data as Events["status.updated"]).models!;
    const entry = sent.find((m) => m.id === "gpt-5.6-luna")!;
    assert.equal(entry.fast, true);
    assert.deepEqual(entry.efforts, ["low"]);

    const cee = w.engine.createBot({ name: "Cee", model: "gpt-6.1-terra" });
    from = w.events.length;
    await w.engine.updateBot({ botId: cee.id, patch: { effort: "high" } });
    assert.deepEqual(kinds(from), ["bot.updated"], "the list did not change");
    from = w.events.length;
    await w.engine.updateBot({ botId: cee.id, patch: { model: "gpt-secret-x" } });
    // gpt-secret-x is not in the fake setup's lists, so it comes in as an unknown GPT id without a fast mode.
    assert.deepEqual(kinds(from), ["status.updated", "bot.updated"]);
    const after = (w.events.slice(from).find((e) => e.event === "status.updated")!.data as Events["status.updated"]).models!;
    assert.equal(after.find((m) => m.id === "gpt-secret-x")!.fast, undefined);
    from = w.events.length;
    await w.engine.updateBot({ botId: cee.id, patch: { model: "gpt-6.1-terra" } });
    assert.deepEqual(kinds(from), ["status.updated", "bot.updated"], "the list shrinks again");
    w.engine.shutdown();
    w.store.close();
  });

  test("5. a hidden model is not offered but is known: its fast mode counts, and a bot on it is sent priority", async () => {
    const rows = [
      row({ id: "gpt-6-luna", serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }] }),
      row({ id: "gpt-secret-x", displayName: "Hidden", hidden: true, serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }] }),
    ];
    assert.deepEqual(mapCodexModels(rows).map((m) => m.id), ["gpt-6-luna"], "not offered");
    assert.deepEqual(mapAllCodexModels(rows, { hidden: false }).map((m) => m.id), ["gpt-6-luna"]);
    const all = mapAllCodexModels(rows);
    assert.ok(all.some((m) => m.id === "gpt-secret-x"));
    assert.equal(modelHasFast("gpt-secret-x", all), true);

    // Through the probe and the engine, with the stand-in's own hidden row.
    const codex = fakeCodex();
    const probe = await probeCodex(codex.setup.executable!, codex.setup.env, codex.setup.args);
    assert.equal(probe.models.some((m) => m.id === "gpt-secret-x"), false);
    assert.equal(probe.allModels.find((m) => m.id === "gpt-secret-x")?.fast, true);
    codex.setup.allModels = probe.allModels;
    codex.setup.models = probe.models;
    const w = codexWorld({ codex });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Hid", model: "gpt-secret-x", effort: "low", access: "full-access" });
    assert.equal(bot.harness, "codex");
    assert.equal(w.engine.snapshot().models.find((m) => m.id === "gpt-secret-x")?.fast, true, "listed for the bot that uses it, with its fast mode");
    w.engine.sendMessage({ botId: bot.id, text: "[[answer:hidden]]" });
    await waitFor(() => stateOf(w.events, bot.id) === "done", 8000, "done");
    assert.equal(w.codex.received("thread/start").at(-1)!.serviceTier, "priority");
    assert.equal(w.codex.received("turn/start").at(-1)!.serviceTier, "priority");
    w.engine.shutdown();
    w.store.close();
  });

  test("6. a reported tier of null counts as default: asked priority gives the one line, asked default gives none", async () => {
    const f = fakeCodex({ FAKE_CODEX_TIER: "null" });
    const fast = await captureLog(async () => {
      const c = codexSession(f.setup, { fast: true });
      c.session.start();
      await c.turn("Say ok");
      await c.turn("Say ok again");
      c.session.close();
    });
    const said = fast.lines.filter((l) => /reports another tier/.test(l));
    assert.equal(said.length, 1, said.join(""));
    assert.match(said[0]!, /it says "default", Pobots asked for "priority" \(fast mode on\)/);
    const slow = await captureLog(async () => {
      const c = codexSession(f.setup, { fast: false });
      c.session.start();
      await c.turn("Say ok");
      c.session.close();
    });
    assert.ok(!slow.lines.some((l) => /reports another tier/.test(l)));
  });
});
