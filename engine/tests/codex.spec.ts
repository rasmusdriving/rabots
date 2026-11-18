// Step 3a: the Codex session against the fake app-server (fake-codex.mjs). Detection and the model
// list, the event translation for each kind of turn, the access table, a tidy turn, resume. No model.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import type { HarnessEvent } from "../claude/session.js";
import { describeApproval, describeTool } from "../claude/labels.js";
import { CODEX_NOT_SIGNED_IN, detectCodex, probeCodex } from "../codex/detect.js";
import { codexLabel, harnessOfModel, mapCodexModels } from "../codex/models.js";
import { CODEX_ACCESS, codexErrorCode, toolFingerprint, unwrapCommand } from "../codex/session.js";
import { FALLBACK_MODELS } from "../claude/models.js";
import { codexSession, fakeCodex, waitFor } from "./codex-fake.js";
import { tempDir } from "./helpers.js";

const kinds = (events: HarnessEvent[]) => events.map((e) => e.type);
const tools = (events: HarnessEvent[]) => events.filter((e): e is Extract<HarnessEvent, { type: "tool-start" }> => e.type === "tool-start");
const ends = (events: HarnessEvent[]) => events.filter((e): e is Extract<HarnessEvent, { type: "tool-end" }> => e.type === "tool-end");

describe("codex: models and detection", () => {
  test("the newest model of each family, efforts cut to ours, the model's own default when it is one of ours", () => {
    const rows = [
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "high" },
      { id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "medium" },
      { id: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", hidden: false, supportedReasoningEfforts: ["low", "medium", "high", "ultra"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "ultra" },
      { id: "gpt-6-sol", displayName: "GPT-6 Sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" },
      { id: "gpt-6-luna", displayName: "GPT-6 Luna", hidden: false, supportedReasoningEfforts: ["low", "medium", "high"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "low" },
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" },
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" },
      { id: "gpt-7-secret", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: "low" },
    ];
    const models = mapCodexModels(rows);
    assert.deepEqual(models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"]);
    assert.ok(models.every((m) => m.harness === "codex"));
    assert.deepEqual(models[0]!.efforts, ["low", "medium", "high", "xhigh", "max"], "no ultra");
    assert.equal(models[0]!.defaultEffort, "high");
    assert.equal(models[1]!.defaultEffort, "medium", "ultra is not ours, so medium");
    assert.equal(models[2]!.defaultEffort, "low");
    assert.equal(models[1]!.label, "GPT-6.1 Terra");
    assert.equal(codexLabel("gpt-6.1-terra"), "GPT-6.1 Terra");
    assert.equal(harnessOfModel("gpt-6-luna", { claude: FALLBACK_MODELS, codex: [] }), "codex", "an id that looks like GPT is Codex's even before the list is known");
    assert.equal(harnessOfModel("claude-opus-5-5", { claude: FALLBACK_MODELS, codex: models }), "claude");
    assert.ok(FALLBACK_MODELS.every((m) => m.harness === "claude"));
  });

  test("probe: signed in with models; not signed in; does not start", async () => {
    const f = fakeCodex();
    const ok = await probeCodex(f.setup.executable!, f.setup.env, f.setup.args);
    assert.equal(ok.ok, true);
    assert.equal(ok.signedIn, true);
    assert.equal(ok.version, "0.165.0");
    assert.deepEqual(ok.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"]);
    const none = fakeCodex({ FAKE_CODEX_ACCOUNT: "none" });
    const out = await probeCodex(none.setup.executable!, none.setup.env, none.setup.args);
    assert.equal(out.ok, true);
    assert.equal(out.signedIn, false);
    assert.deepEqual(out.models, []);
    const broken = fakeCodex({ FAKE_CODEX_INIT: "fail" });
    const bad = await probeCodex(broken.setup.executable!, broken.setup.env, broken.setup.args);
    assert.equal(bad.ok, false);
  });

  test("detect: a path in config.json that is not there says so; the sentences are plain", async () => {
    const r = await detectCodex({ executable: join(tempDir(), "no-codex") });
    assert.equal(r.ready, false);
    assert.match(r.problem!, /could not be found/);
    assert.equal(CODEX_NOT_SIGNED_IN, "Codex is not signed in. Run codex login in a terminal on the Mac.");
  });

  test("small translations: commands without the shell wrapper, errors as codes, tool fingerprints, labels", () => {
    assert.equal(unwrapCommand("/bin/zsh -lc 'echo hi > x.txt'"), "echo hi > x.txt");
    assert.equal(unwrapCommand("/bin/bash -lc 'echo '\\''it'\\'' ok'"), "echo 'it' ok");
    assert.equal(unwrapCommand("ls -la"), "ls -la");
    assert.equal(codexErrorCode({ message: "x", codexErrorInfo: "usageLimitExceeded" }), "codex_usage_limit");
    assert.equal(codexErrorCode({ message: "x", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }), "codex_unavailable");
    assert.equal(codexErrorCode({ message: "You've hit your usage limit." }), "codex_usage_limit");
    const a = [{ name: "a", description: "one", shape: { x: z.string() }, handler: async () => ({ content: [] }) }];
    const b = [{ name: "a", description: "changed words", shape: { x: z.string() }, handler: async () => ({ content: [] }) }];
    const c = [{ name: "a", description: "one", shape: { x: z.number() }, handler: async () => ({ content: [] }) }];
    assert.equal(toolFingerprint(a), toolFingerprint(b), "descriptions do not count");
    assert.notEqual(toolFingerprint(a), toolFingerprint(c), "schemas do");
    assert.equal(describeTool("CodexAgents", {}).running, "Working with its own helpers");
    assert.equal(describeApproval("RequestPermissions", { network: true, reason: "To fetch a page" }).title, "Allow more access?");
    assert.match(describeApproval("RequestPermissions", { network: true, reason: "To fetch a page" }).detail, /Use the network[\s\S]*Why: To fetch a page/);
    assert.equal(describeApproval("Edit", { file_path: "/a/x.md", files: ["/a/x.md", "/a/y.md"] }).title, "Change these files?");
  });
});

describe("codex: one turn of each kind", () => {
  const f = fakeCodex();

  test("a plain answer: session, turn start, streamed text, turn end with usage", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    const end = await c.turn("Say ok");
    const types = kinds(c.events);
    assert.deepEqual(types.slice(0, 3), ["session", "turn-start", "text-start"]);
    assert.ok(types.includes("text-delta"));
    assert.equal(c.texts().join(""), "ok");
    assert.equal(end.ok, true);
    assert.equal(end.subtype, "completed");
    assert.equal(end.own, true);
    const session = c.events.find((e) => e.type === "session") as Extract<HarnessEvent, { type: "session" }>;
    assert.equal(end.sessionId, session.sessionId);
    assert.deepEqual(end.usage?.last, { input: 9000, cacheRead: 20000, cacheWrite: 0, output: 1000 });
    assert.equal(end.usage?.window, 475000);
    assert.equal(end.usage?.requests, 1);
    assert.equal(end.usage?.cache, undefined, "Codex does not say how long its cache lives");
    c.session.close();
  });

  test("an answer that is not streamed arrives whole", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    await c.turn("[[full:pelican]]");
    assert.ok(!kinds(c.events).includes("text-start"));
    const full = c.events.find((e) => e.type === "text-full") as Extract<HarnessEvent, { type: "text-full" }>;
    assert.equal(full.text, "pelican");
    assert.ok(kinds(c.events).includes("text-end"));
    c.session.close();
  });

  test("a command: thinking, Bash without the shell wrapper, the start of its output; a failing command is an error", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    await c.turn("[[command]]");
    assert.ok(kinds(c.events).includes("thinking"));
    const start = tools(c.events)[0]!;
    assert.equal(start.name, "Bash");
    assert.equal(start.input.command, "echo hi");
    const end = ends(c.events)[0]!;
    assert.equal(end.toolUseId, start.toolUseId);
    assert.equal(end.isError, false);
    assert.equal(end.text, "hi\n");
    await c.turn("[[command-fail]]");
    assert.equal(ends(c.events)[1]!.isError, true);
    c.session.close();
  });

  test("a file change: Write for a new file, Edit for a changed one, one call per file", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    await c.turn("[[file]]");
    const starts = tools(c.events);
    assert.deepEqual(starts.map((t) => t.name), ["Write", "Edit"]);
    assert.match(String(starts[0]!.input.file_path), /notes\.txt$/);
    assert.match(String(starts[1]!.input.file_path), /AGENTS\.md$/);
    assert.equal(ends(c.events).length, 2);
    c.session.close();
  });

  test("an own tool: mcp__pobots__<name>, the arguments checked against its shape, its text and success handed back", async () => {
    const calls: Record<string, unknown>[] = [];
    const own = [
      {
        name: "say_hello",
        description: "Says hello",
        shape: { name: z.string() },
        handler: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { content: [{ type: "text" as const, text: `Hello, ${String(args.name)}. The word is plommon.` }] };
        },
      },
    ];
    const c = codexSession(f.setup, { tools: own });
    c.session.start();
    await c.turn('[[tool:say_hello]]{"name":"Kaja"}');
    assert.deepEqual(calls, [{ name: "Kaja" }]);
    const start = tools(c.events)[0]!;
    assert.equal(start.name, "mcp__pobots__say_hello");
    assert.deepEqual(start.input, { name: "Kaja" });
    assert.match(c.texts().join(""), /tool said: Hello, Kaja\. The word is plommon\./);
    await c.turn('[[tool:say_hello]]{"name":5}');
    assert.match(c.texts().join(""), /tool failed: The arguments do not fit the tool/);
    await c.turn("[[tool:no_such_tool]]{}");
    assert.match(c.texts().join(""), /tool failed: There is no tool called no_such_tool/);
    const started = f.received("thread/start").at(-1)!;
    const spec = (started.dynamicTools as Record<string, unknown>[])[0]!;
    assert.equal(spec.name, "say_hello");
    assert.deepEqual((spec.inputSchema as Record<string, unknown>).required, ["name"]);
    c.session.close();
  });

  test("approvals: the card is asked through canUseTool without Always allow; allow accepts, deny declines, a stop cancels", async () => {
    let answer: "allow" | "deny" | "stop" = "allow";
    const c = codexSession(f.setup, {
      canUseTool: async (_name, input) =>
        answer === "allow" ? { behavior: "allow", updatedInput: input } : answer === "deny" ? { behavior: "deny", message: "no" } : { behavior: "deny", message: "stopped", interrupt: true },
    });
    c.session.start();
    await c.turn("[[approve]]");
    assert.equal(c.asked[0]!.name, "Bash");
    assert.equal(c.asked[0]!.input.command, "echo approved > made.txt");
    assert.equal(c.asked[0]!.options.pobotsNoAlways, true);
    assert.match(c.texts().at(-1)!, /accepted/);
    answer = "deny";
    await c.turn("[[approve]]");
    assert.equal(c.texts().at(-1), "declined:decline");
    const declined = ends(c.events).at(-1)!;
    assert.equal(declined.isError, true, "a refused command reads as failed");
    answer = "stop";
    const end = await c.turn("[[approve]]");
    assert.equal(end.subtype, "interrupted");
    c.session.close();
  });

  test("a file change asked first; a question; more access; a connector's request is refused", async () => {
    let pick = "Blue";
    const c = codexSession(f.setup, {
      canUseTool: async (name, input) => {
        if (name === "AskUserQuestion") return { behavior: "allow", updatedInput: { ...input, answers: { "Red or blue?": pick } } };
        if (name === "RequestPermissions") return { behavior: "deny", message: "no" };
        return { behavior: "allow", updatedInput: input };
      },
    });
    c.session.start();
    await c.turn("[[approve-file:notes.txt]]");
    assert.equal(c.asked[0]!.name, "Write");
    assert.match(String(c.asked[0]!.input.file_path), /notes\.txt$/);
    assert.equal(c.texts().at(-1), "file:accept");
    await c.turn("[[question]]");
    const q = c.asked.find((a) => a.name === "AskUserQuestion")!;
    const questions = q.input.questions as { question: string; options: { label: string }[] }[];
    assert.equal(questions[0]!.question, "Red or blue?");
    assert.deepEqual(questions[0]!.options.map((o) => o.label), ["Red", "Blue"]);
    assert.equal(c.texts().at(-1), "chose:Blue");
    pick = "Red";
    await c.turn("[[question]]");
    assert.equal(c.texts().at(-1), "chose:Red");
    await c.turn("[[permissions]]");
    const perm = c.asked.find((a) => a.name === "RequestPermissions")!;
    assert.equal(perm.input.network, true);
    assert.equal(perm.input.reason, "To fetch a page");
    assert.equal(c.texts().at(-1), "network:no");
    await c.turn("[[elicit]]");
    assert.equal(c.texts().at(-1), "elicit:decline");
    c.session.close();
  });

  test("interrupted: turn/interrupt ends the turn as interrupted; the open command is left for the engine to close", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    const before = c.events.filter((e) => e.type === "turn-end").length;
    c.session.send("[[slow]]");
    await waitFor(() => tools(c.events).length === 1, 5000, "the slow command");
    await c.session.interrupt();
    await waitFor(() => c.events.filter((e) => e.type === "turn-end").length > before, 5000, "the interrupted end");
    const end = c.events.filter((e) => e.type === "turn-end").at(-1) as Extract<HarnessEvent, { type: "turn-end" }>;
    assert.equal(end.subtype, "interrupted");
    assert.equal(end.ok, true);
    assert.equal(ends(c.events).length, 0);
    const interrupts = f.received("turn/interrupt");
    assert.ok(interrupts.length >= 1);
    c.session.close();
  });

  test("failed: the used-up ChatGPT limit is one api-error in words the person understands, then a failed turn", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    const end = await c.turn("[[fail]]");
    const errors = c.events.filter((e) => e.type === "api-error") as Extract<HarnessEvent, { type: "api-error" }>[];
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, "codex_usage_limit");
    assert.equal(end.ok, false);
    assert.equal(end.subtype, "failed");
    c.session.close();
  });

  test("compaction is one compacted event; a connector call, a web search and Codex's own agents get their names", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    await c.turn("[[compact]]");
    const compacted = c.events.filter((e) => e.type === "compacted") as Extract<HarnessEvent, { type: "compacted" }>[];
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0]!.trigger, "auto");
    await c.turn("[[mcp]]");
    await c.turn("[[web]]");
    await c.turn("[[collab]]");
    const names = tools(c.events).map((t) => t.name);
    assert.deepEqual(names, ["mcp__docs__search", "WebSearch", "CodexAgents"]);
    assert.equal(tools(c.events)[1]!.input.query, "pelican facts", "a search that got its words late still gets its line");
    assert.equal(ends(c.events)[0]!.text, "found");
    c.session.close();
  });

  test("messages sent while a turn runs wait and start the next turns, in order", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    c.session.send("[[wait:150]]");
    c.session.send("[[answer:second]]");
    c.session.send("[[answer:third]]");
    await waitFor(() => c.events.filter((e) => e.type === "turn-end").length === 3, 8000, "three turns");
    assert.deepEqual(c.texts(), ["waited", "second", "third"]);
    c.session.close();
  });

  test("the process ending is an exit event", async () => {
    const c = codexSession(f.setup);
    c.session.start();
    await c.turn("Say ok");
    c.session.close();
    await waitFor(() => kinds(c.events).includes("exit"), 5000, "exit");
    const exit = c.events.find((e) => e.type === "exit") as Extract<HarnessEvent, { type: "exit" }>;
    assert.equal(exit.beforeInit, false);
    assert.equal(exit.error, undefined, "a close asked for is no error");
  });
});

describe("codex: access, tidy turns, resume", () => {
  const f = fakeCodex();

  test("the access table: approval policy, reviewer and sandbox are always sent, on the thread and on every turn", async () => {
    assert.deepEqual(CODEX_ACCESS["asks-first"], { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" });
    assert.deepEqual(CODEX_ACCESS["edits-freely"], { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
    assert.deepEqual(CODEX_ACCESS["decides-itself"], { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
    assert.deepEqual(CODEX_ACCESS["full-access"], { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" });
    const dir = tempDir("pobots-codex-bot-");
    const c = codexSession(f.setup, { access: "edits-freely", botDir: dir, effort: "low" });
    c.session.start();
    await c.turn("Say ok");
    const thread = f.received("thread/start").at(-1)!;
    assert.equal(thread.approvalPolicy, "on-request");
    assert.equal(thread.sandbox, "workspace-write");
    assert.equal(thread.approvalsReviewer, "user");
    assert.equal(thread.cwd, dir);
    assert.equal(thread.serviceName, "pobots");
    assert.equal(thread.developerInstructions, "You are Kaja, a test bot.");
    let turn = f.received("turn/start").at(-1)!;
    assert.equal(turn.effort, "low");
    assert.equal(turn.model, "gpt-6-luna");
    assert.equal(turn.approvalPolicy, "on-request");
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [dir], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
    // Changes take effect at the next turn, without a restart.
    await c.session.setAccess("decides-itself");
    await c.session.setEffort("high");
    await c.session.setModel("gpt-6.1-terra");
    await c.turn("Say ok");
    turn = f.received("turn/start").at(-1)!;
    assert.equal(turn.approvalsReviewer, "auto_review");
    assert.equal(turn.effort, "high");
    assert.equal(turn.model, "gpt-6.1-terra");
    await c.session.setAccess("full-access");
    await c.turn("Say ok");
    assert.deepEqual(f.received("turn/start").at(-1)!.sandboxPolicy, { type: "dangerFullAccess" });
    await c.session.setAccess("asks-first");
    await c.turn("Say ok");
    assert.equal(f.received("turn/start").at(-1)!.approvalPolicy, "untrusted");
    assert.deepEqual(f.received("turn/start").at(-1)!.sandboxPolicy, { type: "readOnly", networkAccess: true });
    c.session.close();
  });

  test("a tidy turn: nothing is asked and only the memory folder is writable; should Codex ask all the same, the gate answers without a card; own tools asked through the gate", async () => {
    const dir = tempDir("pobots-codex-bot-");
    mkdirSync(join(dir, "memory"), { recursive: true });
    const gated: string[] = [];
    const gate = (name: string, input: Record<string, unknown>) => {
      gated.push(name);
      if (name === "mcp__pobots__say_hello") return "Not now: tidy.";
      if ((name === "Write" || name === "Edit") && String(input.file_path).includes("/memory/")) return undefined;
      return "Not now: tidy.";
    };
    const own = [{ name: "say_hello", description: "x", shape: {}, handler: async () => ({ content: [{ type: "text" as const, text: "hello" }] }) }];
    const c = codexSession(f.setup, { botDir: dir, access: "full-access", gate, tools: own });
    c.session.start();
    await c.turn("[[approve-file:memory/MEMORY.md]]", { tidy: true });
    const turn = f.received("turn/start").at(-1)!;
    assert.equal(turn.approvalPolicy, "never");
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [join(dir, "memory")], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    assert.deepEqual(turn.runtimeWorkspaceRoots, [join(dir, "memory")]);
    assert.equal(c.texts().at(-1), "file:accept");
    assert.ok(existsSync(join(dir, "memory", "MEMORY.md")));
    const askedBefore = c.asked.length;
    await c.turn("[[approve-file:notes.txt]]", { tidy: true });
    assert.equal(c.texts().at(-1), "file:decline");
    await c.turn("[[approve]]", { tidy: true });
    assert.equal(c.texts().at(-1), "declined:decline");
    assert.equal(c.asked.length, askedBefore, "nothing outside the memory folder reached a card");
    await c.turn("[[tool:say_hello]]{}", { tidy: true });
    assert.match(c.texts().at(-1)!, /tool failed: Not now: tidy\./);
    assert.ok(gated.includes("mcp__pobots__say_hello"));
    // The next ordinary turn is back on the bot's own access.
    await c.turn("Say ok");
    assert.equal(f.received("turn/start").at(-1)!.approvalPolicy, "never");
    assert.deepEqual(f.received("turn/start").at(-1)!.runtimeWorkspaceRoots, [dir], "the bot's folder is writable again");
    c.session.close();
  });

  test("resume: a new process takes up the thread and remembers; a thread that is gone ends before it starts", async () => {
    const dir = tempDir("pobots-codex-bot-");
    const a = codexSession(f.setup, { botDir: dir });
    a.session.start();
    await a.turn("[[answer:plommon]]");
    const id = (a.events.find((e) => e.type === "session") as Extract<HarnessEvent, { type: "session" }>).sessionId;
    a.session.close();
    const b = codexSession(f.setup, { botDir: dir, resume: id });
    b.session.start();
    await b.turn("[[recall]]");
    assert.equal(b.texts().at(-1), "I said: plommon");
    assert.equal((b.events.find((e) => e.type === "session") as Extract<HarnessEvent, { type: "session" }>).sessionId, id);
    assert.equal(f.received("thread/resume").at(-1)!.excludeTurns, true);
    b.session.close();
    const gone = codexSession(f.setup, { botDir: dir, resume: "00000000-0000-7000-8000-000000000000" });
    gone.session.start();
    await waitFor(() => kinds(gone.events).includes("exit"), 5000, "the exit of a lost thread");
    const exit = gone.events.find((e) => e.type === "exit") as Extract<HarnessEvent, { type: "exit" }>;
    assert.equal(exit.beforeInit, true);
    assert.match(exit.error ?? "", /no rollout found/);
  });

  test("an ephemeral thread is asked for when the session says so", async () => {
    const c = codexSession(f.setup, { ephemeral: true });
    c.session.start();
    await c.turn("Say ok");
    assert.equal(f.received("thread/start").at(-1)!.ephemeral, true);
    c.session.close();
  });
});
