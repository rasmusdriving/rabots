// Step workers: workers with a session of their own (docs/build/step-workers.md). The layers of what
// a worker is told and its kinds, shortenAt and its limits, shortening on request against the fake
// session, the cap across all bots, the search inside helpers, WORKERS.md for old and new bots.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BotItem, HelperItem, NoticeItem, UserItem } from "../../shared/protocol.js";
import { gitAvailable } from "../history.js";
import { SHORTEN_MIN_STEPS } from "../shorten.js";
import { MAX_HELPERS_ALL_BOTS, MAX_POBOTS_HELPERS, teamPrompt } from "../team.js";
import { chooseWorker, DEFAULT_WORKERS_MD, parseKind, readKind, SHORTEN_TOOL, workerInstructions, workersText } from "../workers.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { settle, setup, upserts, usage, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const inThread = (events: Ev[], threadId: string) => items(events).filter((i) => i.threadId === threadId);
const helperRows = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Result = Awaited<ReturnType<FakeSession["tool"]>>;

/** One turn of a worker's own session: what it does, what it says, its end. */
function workerTurn(h: FakeSession, body: () => void | Promise<void>, text?: string, tokens?: number): Promise<void> {
  return (async () => {
    h.emit({ type: "session", sessionId: "hs" });
    h.emit({ type: "turn-start", own: true });
    await body();
    if (text) h.emit({ type: "text-full", key: `k-${Math.random()}`, text });
    h.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "hs", ...(tokens ? { usage: usage(tokens) } : {}) });
    await settle();
  })();
}

/** The worker reads a file (a step of work). */
function step(h: FakeSession, n = 1) {
  for (let i = 0; i < n; i++) {
    const id = `r-${Math.random()}`;
    h.emit({ type: "tool-start", toolUseId: id, name: "Read", input: { file_path: "/tmp/x.txt" } });
    h.emit({ type: "tool-end", toolUseId: id, isError: false, text: "ok" });
  }
}

/** The worker calls its tool to ask to be shortened, as the harness would. */
async function askShorten(h: FakeSession, keep: string, next: string): Promise<Result> {
  const id = `s-${Math.random()}`;
  h.emit({ type: "tool-start", toolUseId: id, name: `mcp__pobots__${SHORTEN_TOOL}`, input: { keep, next } });
  const r = await h.tool(SHORTEN_TOOL, { keep, next });
  h.emit({ type: "tool-end", toolUseId: id, isError: r.isError === true, text: r.content[0]!.text });
  return r;
}

/** Claude Code's answer to "/compact": the boundary with its sizes, then an empty result. */
async function summarised(h: FakeSession, pre = 117_498, post = 4_268) {
  h.emit({ type: "session", sessionId: "hs" });
  h.emit({ type: "turn-start", own: true });
  h.emit({ type: "compacted", trigger: "manual", preTokens: pre, postTokens: post });
  h.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "hs" });
  await settle();
}

type World = ReturnType<typeof setup>;

/** A bot on Claude starts one worker with start_helper and (with wait true) waits for it. */
async function startWorker(input: Record<string, unknown>, o: { w?: World; name?: string; id?: string; prepare?: (dir: string) => void } = {}) {
  const w = o.w ?? setup(undefined, () => true, { shortenWaitMs: 200, shortenStuckMs: 200 });
  const bot = w.engine.createBot({ name: o.name ?? "Po", model: "claude-haiku-5-5", access: "edits-freely" });
  o.prepare?.(join(w.dirs.botsDir, bot.id));
  w.engine.sendMessage({ botId: bot.id, text: "Do the work" });
  await settle();
  const s = w.sessions.at(-1)!;
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  const before = w.sessions.length;
  const tu = o.id ?? "tu-w1";
  s.emit({ type: "tool-start", toolUseId: tu, name: "mcp__pobots__start_helper", input });
  let result: Result | undefined;
  const call = s.tool("start_helper", input).then((r) => (result = r));
  await settle();
  const h = w.sessions.length > before ? w.sessions.at(-1)! : undefined;
  return { w, bot, s, h, call, get result() { return result; }, get id() { return w.store.helperItems(bot.id, 1)[0]!.id.slice(0, 8); } };
}

const done = (w: World) => {
  w.engine.shutdown();
  w.store.close();
};

describe("step workers: what a worker is told, and its kinds", () => {
  test("a kind's top block: its lines, a broken block, an unknown line, bad values; no block is all body", () => {
    const k = parseKind("tester", "---\ndescription: Tries a change in a browser\nmodel: claude-sonnet-5-5\neffort: high\nshorten_at: 400_000\nshorten: false\n---\nTest it like a careful person.\n");
    assert.deepEqual(k, { name: "tester", description: "Tries a change in a browser", model: "claude-sonnet-5-5", effort: "high", shortenAt: 400000, shorten: false, body: "Test it like a careful person." });
    assert.deepEqual(parseKind("plain", "Just do it.\n"), { name: "plain", body: "Just do it." });
    assert.match((parseKind("x", "---\nmodel: a\nNo end\n") as { problem: string }).problem, /no closing --- line/);
    assert.match((parseKind("x", "---\nshortenAt: 400000\n---\n") as { problem: string }).problem, /lines there can be description, model, effort, shorten_at, shorten/);
    assert.match((parseKind("x", "---\neffort: huge\n---\n") as { problem: string }).problem, /effort in workers\/x\.md must be one of/);
    assert.match((parseKind("x", "---\nshorten_at: 100000\n---\n") as { problem: string }).problem, /150000 to 1000000/);
    assert.match((parseKind("x", "---\nshorten: maybe\n---\n") as { problem: string }).problem, /true or false/);
    assert.match((parseKind("x", "---\njust words\n---\n") as { problem: string }).problem, /Line 2 of workers\/x\.md is not "name: value"/);
  });

  test("a missing kind is refused with the names of those there are; a name with a path in it is not read", () => {
    const dir = tempDir();
    assert.match((readKind(dir, "tester") as { problem: string }).problem, /You have no kinds yet: a kind is a file workers\/<kind>\.md/);
    mkdirSync(join(dir, "workers"));
    writeFileSync(join(dir, "workers", "builder.md"), "Build.");
    writeFileSync(join(dir, "workers", "Reviewer.md"), "Review.");
    assert.equal((readKind(dir, "reviewer") as { name: string }).name, "Reviewer", "any case");
    assert.equal((readKind(dir, "builder.md") as { body: string }).body, "Build.");
    assert.equal((readKind(dir, "tester") as { problem: string }).problem, "There is no kind called tester. Your kinds: builder, Reviewer.");
    assert.match((readKind(dir, "../AGENTS") as { problem: string }).problem, /There is no kind called/);
  });

  test("the layers in order: Pobots' lines, WORKERS.md (the built-in text when absent or empty), the kind; a worker without the tool is told so", () => {
    const dir = tempDir();
    const kind = { name: "tester", body: "KIND BODY" };
    const plain = workerInstructions({ botName: "Po", browser: false, botDir: dir, kind, shortenTool: true });
    assert.ok(plain.startsWith("You are a helper started by the bot Po in Pobots for one task."));
    assert.ok(plain.indexOf(DEFAULT_WORKERS_MD.trim()) > 0 && plain.indexOf("KIND BODY") > plain.indexOf(DEFAULT_WORKERS_MD.trim()));
    assert.ok(!plain.includes("You have no shorten_conversation tool"));
    writeFileSync(join(dir, "WORKERS.md"), "  \n");
    assert.equal(workersText(dir), DEFAULT_WORKERS_MD.trim(), "empty is the built-in text");
    writeFileSync(join(dir, "WORKERS.md"), "OWN RULES");
    const gpt = workerInstructions({ botName: "Po", browser: false, botDir: dir, shortenTool: false });
    assert.match(gpt, /You have no shorten_conversation tool here/);
    assert.ok(gpt.endsWith("OWN RULES"));
    assert.ok(DEFAULT_WORKERS_MD.split(/\s+/).filter(Boolean).length < 150, "the default is under 150 words");
    assert.match(DEFAULT_WORKERS_MD, /shorten_conversation/);
  });

  test("what wins: the call over the kind over the defaults; a model only from the kind; the tool only on Claude", () => {
    const harnessOf = (m: string) => (m.startsWith("gpt") ? "codex" : "claude") as "claude" | "codex";
    const sizeFor = (h: "claude" | "codex") => (h === "claude" ? 500_000 : 300_000);
    const kind = { name: "k", model: "claude-sonnet-5-5", effort: "high" as const, shortenAt: 400_000, shorten: false, body: "" };
    assert.deepEqual(chooseWorker({}, kind, harnessOf, sizeFor), { model: "claude-sonnet-5-5", effort: "high", shortenAt: 400_000, shorten: false });
    assert.deepEqual(chooseWorker({ model: "claude-haiku-5-5", effort: "low", shortenAt: 200_000, shorten: true }, kind, harnessOf, sizeFor), { model: "claude-haiku-5-5", effort: "low", shortenAt: 200_000, shorten: true });
    assert.deepEqual(chooseWorker({ model: "claude-haiku-5-5" }, undefined, harnessOf, sizeFor), { model: "claude-haiku-5-5", shortenAt: 500_000, shorten: true });
    assert.deepEqual(chooseWorker({ model: "gpt-6-luna", shorten: true }, undefined, harnessOf, sizeFor), { model: "gpt-6-luna", shortenAt: 300_000, shorten: false });
    assert.match((chooseWorker({}, undefined, harnessOf, sizeFor) as { problem: string }).problem, /needs a model, or a kind that names one/);
    assert.match((chooseWorker({}, { name: "k", body: "" }, harnessOf, sizeFor) as { problem: string }).problem, /The kind k names no model/);
  });

  test("through the engine: a kind written in the same turn is used, its lines reach the session, the call wins, a missing kind and a size out of range are refused", async () => {
    const kindText = "---\ndescription: Reads and reports\nmodel: claude-sonnet-5-5\neffort: high\nshorten_at: 400000\n---\nYou are a careful reader.\n";
    const { w, bot, s, h, call } = await startWorker(
      { title: "Read it", task: "Read notes.txt", kind: "reader", shortenAt: 250_000 },
      { prepare: (dir) => (mkdirSync(join(dir, "workers")), writeFileSync(join(dir, "workers", "reader.md"), kindText)) },
    );
    assert.ok(h, "the worker started");
    assert.equal(h!.settings.model, "claude-sonnet-5-5", "the model from the kind");
    assert.equal(h!.settings.effort, "high");
    assert.equal(h!.settings.compactTokens, 250_000, "the call's size wins over the kind's");
    assert.match(h!.settings.systemAppend!, /You are a careful reader\./);
    assert.ok(h!.settings.systemAppend!.includes(DEFAULT_WORKERS_MD.trim()), "the bot's WORKERS.md (a new bot gets the built-in text)");
    assert.deepEqual(h!.settings.tools.map((t) => t.name), [SHORTEN_TOOL]);
    const row = helperRows(w.events)[0]!;
    assert.equal(row.model, "claude-sonnet-5-5");
    assert.equal(row.effort, "high");
    await workerTurn(h!, () => step(h!), "Read it all.");
    await call;
    const missing = await s.tool("start_helper", { title: "x", task: "y", kind: "tester" });
    assert.equal(missing.isError, true);
    assert.equal(missing.content[0]!.text, "There is no kind called tester. Your kinds: reader.");
    const small = await s.tool("start_helper", { title: "x", task: "y", model: "claude-haiku-5-5", shortenAt: 100_000 });
    assert.match(small.content[0]!.text, /150000 to 1000000/);
    const noModel = await s.tool("start_helper", { title: "x", task: "y" });
    assert.match(noModel.content[0]!.text, /needs a model, or a kind that names one/);
    // The tool's description names the kinds there were when the session started, with their descriptions.
    assert.match(s.settings.tools.find((t) => t.name === "start_helper")!.description, /Your kinds now: reader \(Reads and reports\)\.$/);
    assert.ok(bot);
    done(w);
  });

  test("left out: the person's size for the provider (Claude 500,000); shorten false gives no tool", async () => {
    const a = await startWorker({ title: "A", task: "Say a word", model: "claude-haiku-5-5", shorten: false });
    assert.equal(a.h!.settings.compactTokens, 500_000);
    assert.deepEqual(a.h!.settings.tools, []);
    assert.match(a.h!.settings.systemAppend!, /You have no shorten_conversation tool here/);
    done(a.w);
  });

  test("a bot on Claude is told to start a worker for a job with start_helper, and why", () => {
    const p = teamPrompt("bot", "claude");
    assert.match(p, /For a job of its own \(building, testing, reviewing, research of many steps\) start a helper with start_helper/);
    assert.match(p, /can be given a size and can shorten itself between jobs/);
    assert.match(p, /Keep your own helper tool for a short look-up/);
  });
});

describe("step workers: a helper on a GPT model", () => {
  test("gets the same layers and its size, never the tool, and its instructions say so", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    const dir = join(w.dirs.botsDir, bot.id);
    writeFileSync(join(dir, "WORKERS.md"), "Every worker of Po reads only what it needs.");
    mkdirSync(join(dir, "workers"));
    writeFileSync(join(dir, "workers", "second.md"), "---\nmodel: gpt-6-luna\neffort: low\nshorten: true\n---\nGive a second opinion in one word.\n");
    w.engine.sendMessage({ botId: bot.id, text: "Ask" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const input = { title: "Second opinion", task: "Answer with one word [[answer:plommon]]", kind: "second" };
    s.emit({ type: "tool-start", toolUseId: "tu-g", name: "mcp__pobots__start_helper", input });
    let r: Result | undefined;
    void s.tool("start_helper", input).then((x) => (r = x));
    await waitFor(() => !!r, 8000, "the GPT helper's result");
    assert.match(r!.content[0]!.text, /plommon/);
    const start = w.codex.received("thread/start").at(-1)!;
    assert.deepEqual(start.dynamicTools, [], "no tool on a GPT model");
    const dev = String(start.developerInstructions);
    assert.match(dev, /You have no shorten_conversation tool here/);
    assert.match(dev, /Every worker of Po reads only what it needs\./);
    assert.match(dev, /Give a second opinion in one word\./);
    assert.equal((start.config as Record<string, unknown>).model_auto_compact_token_limit, 300_000, "Codex's own size, the default for Codex");
    assert.equal(helperRows(w.events)[0]!.model, "gpt-6-luna");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("step workers: shortening on request", () => {
  const input = { title: "Two jobs", task: "Do job one, then job two.", model: "claude-haiku-5-5", effort: "low" };

  test("asked and ended: /compact with what to keep, a line with the sizes, the word to carry on with keep and next; the result is the last turn's", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      step(h, 3);
      const r = await askShorten(h, "Job one is done: the answer is 42. File: notes/one.txt.", "Job two: count the words in two.txt.");
      assert.match(r.content[0]!.text, /^Noted\. You are shortened as soon as you end this step/);
    }, "Job one is done.", 117_600);
    assert.equal(t.result, undefined, "the turn that asked is not the result");
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1]!.text, /^\/compact Summarise for a worker that carries on with its task\. Keep: Job one is done: the answer is 42\. File: notes\/one\.txt\. It goes on with: Job two/);
    assert.equal(helperRows(t.w.events)[0]!.last, "Shortening its conversation");
    await summarised(h);
    assert.equal(h.sent.length, 3);
    assert.match(h.sent[2]!.text, /^Note from Pobots: your conversation was shortened, as you asked \(117,498 to 4,268 tokens\)\./);
    assert.match(h.sent[2]!.text, /What you asked to keep:\n\nJob one is done: the answer is 42/);
    assert.match(h.sent[2]!.text, /What you said you do next:\n\nJob two: count the words/);
    assert.match(h.sent[2]!.text, /Your task as you were given it:\n\nDo job one, then job two\./);
    const row = helperRows(t.w.events)[0]!;
    const lines = inThread(t.w.events, row.helperThreadId).filter((i): i is NoticeItem => i.kind === "notice");
    assert.deepEqual(lines.map((l) => [l.text, l.mark]), [["Shortened on request: 117,498 to 4,268 tokens", "compacted"]]);
    assert.equal(row.status, "running", "still working");
    await workerTurn(h, () => step(h), "Two.txt has 7 words. Job one's answer was 42.", 30_000);
    await t.call;
    assert.equal(t.result!.content[0]!.text, 'Your helper ' + t.id + ' "Two jobs" is done. Its result:\n\nTwo.txt has 7 words. Job one\'s answer was 42.');
    assert.equal(helperRows(t.w.events)[0]!.status, "done");
    done(t.w);
  });

  test("asked and went on: the request stays until the turn ends; a turn with no text after the shortening hands back no old text", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      await askShorten(h, "keep this", "then that");
      step(h, 4);
    }, "I went on anyway.");
    assert.match(h.sent.at(-1)!.text, /^\/compact /, "summarised at the end of the turn");
    await summarised(h);
    await workerTurn(h, () => step(h));
    await t.call;
    assert.equal(t.result!.content[0]!.text, 'Your helper ' + t.id + ' "Two jobs" is done. Its result:\n\n(The helper ended without a message.)');
    done(t.w);
  });

  test("asked twice in one turn: one summary with the last request; asked again right after a shortening: told so, not summarised", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      step(h, 2);
      await askShorten(h, "first keep", "first next");
      await askShorten(h, "second keep", "second next");
    }, "Done with one.");
    assert.equal(h.sent.filter((m) => m.text.startsWith("/compact")).length, 1);
    assert.match(h.sent.at(-1)!.text, /Keep: second keep It goes on with: second next/);
    await summarised(h);
    let again: Result | undefined;
    await workerTurn(h, async () => {
      step(h, SHORTEN_MIN_STEPS - 1);
      again = await askShorten(h, "more", "more");
    }, "All done.");
    assert.match(again!.content[0]!.text, /^You were shortened only 2 steps ago: there is nothing new to drop/);
    await t.call;
    assert.match(t.result!.content[0]!.text, /All done\.$/, "that turn was the result");
    assert.equal(h.sent.filter((m) => m.text.startsWith("/compact")).length, 1);
    done(t.w);
  });

  test("no boundary: the summary's turn ends without one, the worker carries on as it is and its thread says why", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      step(h, 3);
      await askShorten(h, "k", "go on with two");
    }, "One done.");
    h.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: ["Not enough messages to compact."], sessionId: "hs" });
    await settle();
    assert.match(h.sent.at(-1)!.text, /^Note from Pobots: your conversation could not be shortened \(Claude Code said: Not enough messages to compact\.\)\. Nothing was lost\. Carry on as you are with what you said you do next:\n\ngo on with two$/);
    const row = helperRows(t.w.events)[0]!;
    assert.match((inThread(t.w.events, row.helperThreadId).find((i) => i.kind === "notice") as NoticeItem).text, /^Could not be shortened \(Claude Code said: Not enough messages to compact\.\), so it carries on as it is$/);
    await workerTurn(h, () => step(h), "Two done.");
    await t.call;
    assert.match(t.result!.content[0]!.text, /Two done\.$/);
    done(t.w);
  });

  test("a worker whose summaries do not work is not summarised again and again", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    const failOnce = async () => {
      h.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: ["Not enough messages to compact."], sessionId: "hs" });
      await settle();
    };
    await workerTurn(h, async () => {
      step(h, 3);
      await askShorten(h, "k", "n");
    }, "One.");
    await failOnce();
    let r: Result | undefined;
    await workerTurn(h, async () => {
      r = await askShorten(h, "k", "n");
      assert.match(r.content[0]!.text, /^Shortening was tried just now and did not work/);
      step(h, 3);
      r = await askShorten(h, "k", "n");
      assert.match(r.content[0]!.text, /^Noted\./, "with work since, it may try once more");
    }, "Two.");
    await failOnce();
    await workerTurn(h, async () => {
      step(h, 5);
      r = await askShorten(h, "k", "n");
    }, "All done.");
    assert.equal(r!.content[0]!.text, "Shortening has not worked for you here. Go on with your work without asking again.");
    await t.call;
    assert.match(t.result!.content[0]!.text, /All done\.$/);
    assert.equal(h.sent.filter((m) => m.text.startsWith("/compact")).length, 2);
    done(t.w);
  });

  test("a summary that takes too long is stopped and the worker carries on; one that does not even stop ends the worker as failed, and the bot's call comes back", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      step(h, 3);
      await askShorten(h, "k", "n");
    }, "One.");
    await wait(260);
    assert.equal(h.interrupts, 1, "the summary was stopped");
    h.emit({ type: "turn-end", ok: false, subtype: "interrupted", errors: [], sessionId: "hs" });
    await settle();
    assert.match(h.sent.at(-1)!.text, /could not be shortened \(it took longer than 1 minute\)/);
    assert.equal(helperRows(t.w.events)[0]!.status, "running");
    await workerTurn(h, async () => {
      step(h, 3);
      await askShorten(h, "k2", "n2");
    }, "Two.");
    await wait(500);
    await t.call;
    assert.equal(t.result!.isError, true);
    assert.equal(t.result!.content[0]!.text, 'Your helper ' + t.id + ' "Two jobs" failed: The helper did not come back after it asked to be shortened.');
    assert.equal(helperRows(t.w.events)[0]!.status, "failed");
    done(t.w);
  });

  test("the person's Stop during a summary stops the worker; a GPT model never gets the tool", async () => {
    const t = await startWorker(input);
    const h = t.h!;
    await workerTurn(h, async () => {
      step(h, 3);
      await askShorten(h, "k", "n");
    }, "One.");
    const row = helperRows(t.w.events)[0]!;
    await t.w.engine.stopHelper({ botId: t.bot.id, itemId: row.id });
    await settle();
    h.emit({ type: "turn-end", ok: false, subtype: "interrupted", errors: [], sessionId: "hs" });
    await settle();
    await t.call;
    assert.match(t.result!.content[0]!.text, /was stopped before it finished/);
    assert.ok(!h.sent.some((m) => m.text.startsWith("Note from Pobots")), "not told to carry on");
    done(t.w);
  });
});

describe("step workers: not too many at once", () => {
  test(`at most ${MAX_HELPERS_ALL_BOTS} across all bots, refused in words the bot can act on`, async () => {
    assert.ok(MAX_HELPERS_ALL_BOTS > MAX_POBOTS_HELPERS, "the cap across bots is reached only with several bots");
    const w = setup();
    const go = async (botId: string, n: number) => {
      w.engine.sendMessage({ botId, text: "Start them" });
      await settle();
      const s = w.sessions.filter((x) => x.settings.botId === botId && x.settings.tools.some((t) => t.name === "start_helper")).at(-1)!;
      s.emit({ type: "session", sessionId: `sess-${botId}` });
      s.emit({ type: "turn-start", own: true });
      const out: Result[] = [];
      for (let i = 0; i < n; i++) {
        const input = { title: `Job ${botId} ${i}`, task: `Task ${i}`, model: "claude-haiku-5-5", wait: false };
        s.emit({ type: "tool-start", toolUseId: `tu-${botId}-${i}`, name: "mcp__pobots__start_helper", input });
        out.push(await s.tool("start_helper", input));
      }
      return out;
    };
    const a = w.engine.createBot({ name: "Ada", model: "claude-haiku-5-5" });
    const b = w.engine.createBot({ name: "Bea", model: "claude-haiku-5-5" });
    const first = await go(a.id, MAX_POBOTS_HELPERS);
    assert.ok(first.every((r) => /^Started helper \w{8} /.test(r.content[0]!.text)));
    const second = await go(b.id, MAX_HELPERS_ALL_BOTS - MAX_POBOTS_HELPERS + 1);
    const last = second.at(-1)!;
    assert.equal(last.isError, true);
    assert.match(last.content[0]!.text, new RegExp(`^${MAX_HELPERS_ALL_BOTS} helpers are already working across all bots, the most at once on this computer: "Job ada 0" \\(Ada\\),`));
    assert.match(last.content[0]!.text, /"Job bea 0" \(yours\)/);
    assert.match(last.content[0]!.text, /Start this one when one of them is done, or do the work yourself\.$/);
    assert.ok(second.slice(0, -1).every((r) => /^Started helper \w{8} /.test(r.content[0]!.text)));
    done(w);
  });
});

describe("step workers: looking back at helpers' work", () => {
  test("search_chat in helpers finds what a helper was asked and said, with its title, model and thread; the default search does not", async () => {
    const t = await startWorker({ title: "Find the bird", task: "Which bird is on the card? Say it.", model: "claude-haiku-5-5" });
    const h = t.h!;
    await workerTurn(h, () => step(h), "The bird on the card is a kingfisher.");
    await t.call;
    t.s.emit({ type: "tool-end", toolUseId: "tu-w1", isError: false, text: t.result!.content[0]!.text });
    t.s.emit({ type: "text-full", key: "b1", text: "My helper is done." });
    t.s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    const plain = await t.s.tool("search_chat", { query: "kingfisher" });
    assert.match(plain.content[0]!.text, /Nothing in your chat holds that word/, "the default search is unchanged");
    const asChat = await t.s.tool("search_chat", { query: "kingfisher", in: "chat" });
    assert.equal(asChat.content[0]!.text, plain.content[0]!.text);
    const found = await t.s.tool("search_chat", { query: "kingfisher", in: "helpers" });
    const row = helperRows(t.w.events)[0]!;
    assert.match(found.content[0]!.text, new RegExp(`- in the helper "Find the bird" on Haiku 5\\.5, .*thread ${row.helperThreadId}, seq \\d+, the helper said: The bird on the card is a kingfisher\\.`));
    const asked = await t.s.tool("search_chat", { query: "bird card", in: "helpers" });
    assert.match(asked.content[0]!.text, /the helper was asked: Which bird is on the card/);
    const seq = Number(/seq (\d+), the helper said/.exec(found.content[0]!.text)![1]);
    const read = await t.s.tool("read_chat", { thread: row.helperThreadId, around: seq });
    assert.match(read.content[0]!.text, /kingfisher/);
    const none = await t.s.tool("search_chat", { query: "pelican", in: "helpers" });
    assert.match(none.content[0]!.text, /Nothing your helpers were asked or said holds that word/);
    done(t.w);
  });

  test("a retired bot's helpers are not searched by a new bot of the same name", async () => {
    const w = setup();
    w.engine.createBot({ name: "Boss", model: "claude-haiku-5-5" });
    const t = await startWorker({ title: "Find the bird", task: "Say heron.", model: "claude-haiku-5-5" }, { w });
    await workerTurn(t.h!, () => undefined, "heron");
    await t.call;
    t.s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    t.w.engine.retireBot(t.bot.id);
    const again = t.w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
    t.w.engine.sendMessage({ botId: again.id, text: "hello" });
    await settle();
    const r = await t.w.sessions.at(-1)!.tool("search_chat", { query: "heron", in: "helpers" });
    assert.match(r.content[0]!.text, /Nothing your helpers were asked or said/);
    done(t.w);
  });

  test("another bot's helpers are not searched", async () => {
    const t = await startWorker({ title: "Find the bird", task: "Say heron.", model: "claude-haiku-5-5" });
    await workerTurn(t.h!, () => undefined, "heron");
    await t.call;
    const other = t.w.engine.createBot({ name: "Other", model: "claude-haiku-5-5" });
    t.w.engine.sendMessage({ botId: other.id, text: "hello" });
    await settle();
    const os = t.w.sessions.at(-1)!;
    const r = await os.tool("search_chat", { query: "heron", in: "helpers" });
    assert.match(r.content[0]!.text, /Nothing your helpers were asked or said/);
    done(t.w);
  });
});

describe("step workers: WORKERS.md in a bot's folder", () => {
  test("a new bot gets it in its first change; a bot from before gets it once as a change of its own; one the person removed is not put back", { skip: !gitAvailable() }, async () => {
    const w = setup();
    const bot = w.engine.createBot({ name: "Kaja", model: "claude-haiku-5-5" });
    const dir = join(w.dirs.botsDir, bot.id);
    assert.equal(readFileSync(join(dir, "WORKERS.md"), "utf8"), DEFAULT_WORKERS_MD);
    assert.deepEqual(w.engine.history({ botId: bot.id }).changes.map((c) => c.summary), ["Created the bot"]);
    w.engine.deleteFile({ botId: bot.id, path: "WORKERS.md" });
    w.engine.shutdown();
    w.store.close();
    const again = setup(w.dirs);
    assert.equal(existsSync(join(dir, "WORKERS.md")), false, "not put back");
    assert.deepEqual(again.engine.history({ botId: bot.id }).changes.map((c) => c.summary), ["Removed WORKERS.md", "Created the bot"]);
    done(again);
  });

  test("an old bot's unsaved work is saved first, apart from WORKERS.md", { skip: !gitAvailable() }, async () => {
    const w = setup();
    const bot = w.engine.createBot({ name: "Kaja", model: "claude-haiku-5-5" });
    const dir = join(w.dirs.botsDir, bot.id);
    w.engine.deleteFile({ botId: bot.id, path: "WORKERS.md" });
    w.engine.shutdown();
    w.store.close();
    // As if the folder came from before this step: no WORKERS.md in its history at all.
    const { execFileSync } = await import("node:child_process");
    const g = (args: string[]) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
    g(["reset", "-q", "--hard", "HEAD~1"]);
    g(["rm", "-q", "WORKERS.md"]);
    g(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--amend", "-m", "Created the bot"]);
    writeFileSync(join(dir, "notes.txt"), "made while Pobots was not running");
    const again = setup(w.dirs);
    assert.equal(readFileSync(join(dir, "WORKERS.md"), "utf8"), DEFAULT_WORKERS_MD);
    const changes = again.engine.history({ botId: bot.id }).changes;
    assert.deepEqual(changes.map((c) => [c.summary, c.files]), [
      ["Added WORKERS.md, what every worker of this bot is told", ["WORKERS.md"]],
      ["Saved changes made while Pobots was not running", ["notes.txt"]],
      ["Created the bot", changes.at(-1)!.files],
    ]);
    done(again);
  });
});

describe("step workers: a Claude worker when Pobots restarts", () => {
  test("its row reads stopped afterwards, the chat says so, and the bot is told at its next turn", async () => {
    const t = await startWorker({ title: "Long job", task: "Work a long time.", model: "claude-haiku-5-5", wait: false });
    assert.equal(helperRows(t.w.events)[0]!.status, "running");
    t.w.engine.shutdown();
    t.w.store.close();
    const again = setup(t.w.dirs);
    const main = again.engine.readThread({ threadId: t.bot.mainThreadId }).items;
    const row = main.find((i): i is HelperItem => i.kind === "helper")!;
    assert.equal(row.status, "stopped");
    assert.ok(main.some((i) => i.kind === "notice" && /^Pobots restarted, so a helper was stopped$/.test((i as NoticeItem).text)));
    again.engine.sendMessage({ botId: t.bot.id, text: "Where were we?" });
    await settle();
    const sent = again.sessions.at(-1)!.sent[0]!;
    assert.match([...sent.before, sent.text].join("\n"), /a helper you started was stopped before it reported back, because Pobots restarted: "Long job"/);
    done(again);
  });
});

describe("step workers: a helper's own messages in its thread", () => {
  test("the task opens its thread and what it said follows", async () => {
    const t = await startWorker({ title: "Say", task: "Say wren.", model: "claude-haiku-5-5" });
    await workerTurn(t.h!, () => undefined, "wren");
    await t.call;
    const row = helperRows(t.w.events)[0]!;
    const thread = t.w.engine.readThread({ threadId: row.helperThreadId }).items;
    assert.equal((thread[0] as UserItem).text, "Say wren.");
    assert.equal((thread.at(-1) as BotItem).text, "wren");
    done(t.w);
  });
});
