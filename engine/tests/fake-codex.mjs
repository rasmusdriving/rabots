// A stand-in for `codex app-server`, for the engine tests (step 3a). Run as: node fake-codex.mjs app-server
// It speaks the same JSON-RPC over stdin and stdout (one JSON object per line, no "jsonrpc" field) and
// plays turns shaped like what codex-cli 0.165.0 sent in the probes (docs/build/notes-engine-3a.md).
// Which turn it plays is chosen by a tag in the message text:
//   (none)             a streamed answer "ok"
//   [[answer:WORD]]    a streamed answer WORD          [[full:WORD]]  the same, not streamed
//   [[command]]        reasoning, a command that prints "hi", then "ran"     [[command-fail]] exit code 1
//   [[file]]           one new file and one changed file (written into the folder), then "changed"
//   [[artifact]]       writes artifacts/page/index.html, calls show_artifact, then "shown"
//   [[tool:NAME]]      calls the bot's own tool NAME with the JSON after the tag ([[tool:x]]{"a":1}), then answers with its result
//   [[approve]]        asks before a command; accept runs it, decline refuses ("declined"), cancel interrupts
//   [[approve-file:PATH]]  asks before writing PATH (relative to the folder)
//   [[question]]       asks the person a question (item/tool/requestUserInput) and answers with the choice
//   [[permissions]]    asks for network access
//   [[elicit]]         a connector asks for something (mcpServer/elicitation/request)
//   [[slow]]           a command that runs until turn/interrupt
//   [[fail]]           the ChatGPT usage limit, then a failed turn
//   [[compact]]        a context compaction, then "compacted"
//   [[mcp]]  [[web]]  [[collab]]   a connector call, a web search, Codex's own agents
//   [[recall]]         answers with what it last answered in this thread (proves a resumed thread)
//   [[wait:MS]]        waits that long before answering "waited" (with ", steered: TEXT" for each message steered into it)
// turn/steer (steering, 13 Nov 2026) takes a message into the running turn, as codex-cli 0.165.0 does:
// it answers { turnId }, and refuses with "no active turn to steer" when no turn runs or the id is not its.
// Environment: FAKE_CODEX_STATE (a JSON file for threads across processes), FAKE_CODEX_LOG (every
// message in and out, as JSON lines), FAKE_CODEX_ACCOUNT=none (not signed in), FAKE_CODEX_INIT=fail,
// FAKE_CODEX_MCP=<JSON array> (what `mcp list --json` answers; a thread/start whose config names a
// server not in it, or one marked "plugin": true (listed, but a plugin brings it), is refused, as Codex does), FAKE_CODEX_TIER=<tier> (every thread reports that tier, whatever it was sent; "null" reports null: step 3b).
// The service tier (step 3b), as codex-cli 0.165.0 does it: thread/start and thread/resume answer with
// the thread's tier (left out it is "priority", as the person's own setting says; null is "default";
// "fast" is "priority"), and a turn/start with a serviceTier is followed by thread/settings/updated.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const log = (dir, m) => logPath && appendFileSync(logPath, JSON.stringify({ dir, pid: process.pid, ...m }) + "\n");
// Several fake processes share the state (a bot's, and a short one that archives), so each thread has
// a file of its own, written through a temporary file and a rename.
const stateDir = statePath ? `${statePath}.d` : undefined;
function readThread(id) {
  if (!stateDir) return undefined;
  const file = join(stateDir, `${id}.json`);
  for (let i = 0; i < 20; i++) {
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // being replaced right now
    }
  }
  return undefined;
}
function writeThread(id, patch) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  const next = { ...(readThread(id) ?? {}), ...patch };
  const tmp = join(stateDir, `${id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, join(stateDir, `${id}.json`));
}
const live = new Map(); // threadId -> { cwd, tools, ephemeral, last }

/** The tier a thread gets for what it was sent, as real Codex answered in the trial (step 3b). */
function tierFor(sent) {
  if (process.env.FAKE_CODEX_TIER) return process.env.FAKE_CODEX_TIER === "null" ? null : process.env.FAKE_CODEX_TIER;
  if (sent === undefined || sent === "fast") return "priority";
  if (sent === null) return "default";
  return sent;
}
let nextReq = 1;
const waits = new Map();
let current; // { threadId, turnId, interrupted, resolveInterrupt }

const write = (m) => {
  log("out", m);
  process.stdout.write(JSON.stringify(m) + "\n");
};
const note = (method, params) => write({ method, params });
const ask = (method, params) => new Promise((resolve) => {
  const id = `s${nextReq++}`;
  waits.set(id, resolve);
  write({ id, method, params });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function thread(id) {
  if (live.has(id)) return live.get(id);
  const s = readThread(id);
  if (!s || s.deleted) return undefined;
  const t = { cwd: s.cwd, tools: s.tools, ephemeral: false, last: s.last ?? "" };
  live.set(id, t);
  return t;
}
function persist(id) {
  const t = live.get(id);
  if (!t || t.ephemeral) return;
  writeThread(id, { cwd: t.cwd, tools: t.tools, last: t.last });
}

const fastTier = (description) => ({ serviceTiers: [{ id: "priority", name: "Fast", description }], additionalSpeedTiers: ["fast"], defaultServiceTier: null });
const MODELS = [
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "high", isDefault: true, ...fastTier("2x speed, increased usage") },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", ...fastTier("1.5x speed") },
  { id: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", hidden: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "ultra", ...fastTier("1.5x speed") },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna", hidden: false, supportedReasoningEfforts: ["low", "medium", "high"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "low", ...fastTier("1.5x speed") },
  // An older Codex's way of saying it: only the older field.
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", additionalSpeedTiers: ["fast"] },
  // No fast mode at all.
  { id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, supportedReasoningEfforts: ["low", "medium"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "medium", serviceTiers: [], additionalSpeedTiers: [] },
  // Hidden: never offered, but a bot may still be on it, and it has a fast mode (step 3b).
  { id: "gpt-secret-x", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", ...fastTier("1.5x speed") },
];

async function answer(threadId, turnId, text, stream = true) {
  const id = `msg_${randomUUID()}`;
  note("item/started", { threadId, turnId, item: { type: "agentMessage", id, text: "", phase: "final_answer" } });
  if (stream) for (const part of text.match(/[\s\S]{1,4}/g) ?? []) note("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: part });
  note("item/completed", { threadId, turnId, item: { type: "agentMessage", id, text, phase: "final_answer" } });
  const t = thread(threadId);
  if (t) {
    t.last = text;
    persist(threadId);
  }
}

function usage(threadId, turnId, n) {
  note("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: 30000 * n, inputTokens: 29000 * n, cachedInputTokens: 20000 * n, cacheWriteInputTokens: 0, outputTokens: 1000 * n, reasoningOutputTokens: 0 }, last: { totalTokens: 30000, inputTokens: 29000, cachedInputTokens: 20000, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 }, modelContextWindow: 475000 } });
}

function command(threadId, turnId, id, cmd, status = "completed", exitCode = 0, output = "hi\n") {
  note("item/started", { threadId, turnId, item: { type: "commandExecution", id, command: `/bin/zsh -lc '${cmd}'`, cwd: thread(threadId)?.cwd ?? "/", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null } });
  note("item/completed", { threadId, turnId, item: { type: "commandExecution", id, command: `/bin/zsh -lc '${cmd}'`, cwd: thread(threadId)?.cwd ?? "/", status, commandActions: [], aggregatedOutput: output, exitCode } });
}

function writeInto(threadId, rel, text) {
  const cwd = thread(threadId)?.cwd;
  if (!cwd) return;
  const full = join(cwd, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

async function callTool(threadId, turnId, tool, args) {
  const callId = `exec-${randomUUID()}`;
  note("item/started", { threadId, turnId, item: { type: "dynamicToolCall", id: callId, namespace: null, tool, arguments: args, status: "inProgress", contentItems: null, success: null } });
  const reply = await ask("item/tool/call", { threadId, turnId, callId, namespace: null, tool, arguments: args });
  note("item/completed", { threadId, turnId, item: { type: "dynamicToolCall", id: callId, namespace: null, tool, arguments: args, status: reply.success ? "completed" : "failed", contentItems: reply.contentItems, success: reply.success } });
  return reply;
}

async function playTurn(threadId, turnId, text) {
  const tag = /\[\[([a-z-]+)(?::([^\]]*))?\]\]/.exec(text);
  const kind = tag?.[1] ?? "plain";
  const arg = tag?.[2] ?? "";
  note("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  let status = "completed";
  let error = null;
  switch (kind) {
    case "plain":
      await answer(threadId, turnId, "ok");
      break;
    case "answer":
      await answer(threadId, turnId, arg || "ok");
      break;
    case "full":
      await answer(threadId, turnId, arg || "ok", false);
      break;
    case "recall":
      await answer(threadId, turnId, `I said: ${thread(threadId)?.last ?? ""}`);
      break;
    case "wait":
      await sleep(Number(arg) || 100);
      await answer(threadId, turnId, ["waited", ...(current?.steers ?? []).map((t) => `steered: ${t}`)].join(", "));
      break;
    case "command":
    case "command-fail": {
      const rid = `rs_${randomUUID()}`;
      note("item/started", { threadId, turnId, item: { type: "reasoning", id: rid, summary: [], content: [] } });
      note("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: rid, delta: "Thinking", summaryIndex: 0 });
      note("item/completed", { threadId, turnId, item: { type: "reasoning", id: rid, summary: ["Thinking"], content: [] } });
      command(threadId, turnId, `exec-${randomUUID()}`, "echo hi", "completed", kind === "command" ? 0 : 1, kind === "command" ? "hi\n" : "boom\n");
      await answer(threadId, turnId, "ran");
      break;
    }
    case "file": {
      const id = `patch-${randomUUID()}`;
      const changes = [
        { path: join(thread(threadId)?.cwd ?? "/", "notes.txt"), kind: { type: "add" }, diff: "+hello" },
        { path: join(thread(threadId)?.cwd ?? "/", "AGENTS.md"), kind: { type: "update", move_path: null }, diff: "+more" },
      ];
      note("item/started", { threadId, turnId, item: { type: "fileChange", id, changes, status: "inProgress" } });
      writeInto(threadId, "notes.txt", "hello\n");
      note("item/completed", { threadId, turnId, item: { type: "fileChange", id, changes, status: "completed" } });
      await answer(threadId, turnId, "changed");
      break;
    }
    case "artifact": {
      const id = `patch-${randomUUID()}`;
      const path = join(thread(threadId)?.cwd ?? "/", "artifacts/page/index.html");
      note("item/started", { threadId, turnId, item: { type: "fileChange", id, changes: [{ path, kind: { type: "add" }, diff: "" }], status: "inProgress" } });
      writeInto(threadId, "artifacts/page/index.html", "<!doctype html><title>Fake page</title><p>plommon</p>\n");
      note("item/completed", { threadId, turnId, item: { type: "fileChange", id, changes: [{ path, kind: { type: "add" }, diff: "" }], status: "completed" } });
      const r = await callTool(threadId, turnId, "show_artifact", { path: "artifacts/page/index.html" });
      await answer(threadId, turnId, r.success ? "shown" : "not shown");
      break;
    }
    case "tool": {
      const json = text.slice(text.indexOf("]]") + 2).trim();
      let args = {};
      try {
        args = json ? JSON.parse(json.split("\n")[0]) : {};
      } catch {
        args = {};
      }
      const r = await callTool(threadId, turnId, arg, args);
      await answer(threadId, turnId, `${r.success ? "tool said" : "tool failed"}: ${(r.contentItems ?? []).map((c) => c.text).join(" ")}`);
      break;
    }
    case "approve": {
      const itemId = `exec-${randomUUID()}`;
      const r = await ask("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId, startedAtMs: Date.now(), command: "/bin/zsh -lc 'echo approved > made.txt'", cwd: thread(threadId)?.cwd, commandActions: [], availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } }, "cancel"] });
      if (r.decision === "accept") {
        command(threadId, turnId, itemId, "echo approved > made.txt", "completed", 0, "");
        await answer(threadId, turnId, "accepted");
      } else if (r.decision === "cancel") {
        status = "interrupted";
      } else {
        note("item/completed", { threadId, turnId, item: { type: "commandExecution", id: itemId, command: "/bin/zsh -lc 'echo approved > made.txt'", cwd: thread(threadId)?.cwd, status: "declined", commandActions: [], aggregatedOutput: null, exitCode: null } });
        await answer(threadId, turnId, `declined:${r.decision}`);
      }
      break;
    }
    case "approve-file": {
      const id = `patch-${randomUUID()}`;
      const path = join(thread(threadId)?.cwd ?? "/", arg || "notes.txt");
      const changes = [{ path, kind: { type: "add" }, diff: "+x" }];
      note("item/started", { threadId, turnId, item: { type: "fileChange", id, changes, status: "inProgress" } });
      const r = await ask("item/fileChange/requestApproval", { threadId, turnId, itemId: id, startedAtMs: Date.now(), reason: null });
      if (r.decision === "accept") writeInto(threadId, arg || "notes.txt", "x\n");
      note("item/completed", { threadId, turnId, item: { type: "fileChange", id, changes, status: r.decision === "accept" ? "completed" : "declined" } });
      await answer(threadId, turnId, `file:${r.decision}`);
      break;
    }
    case "question": {
      const r = await ask("item/tool/requestUserInput", { threadId, turnId, itemId: `q-${randomUUID()}`, isBlocking: true, autoResolutionMs: null, questions: [{ id: "color", header: "Colour", question: "Red or blue?", isOther: true, isSecret: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] });
      await answer(threadId, turnId, `chose:${r.answers?.color?.answers?.[0] ?? "nothing"}`);
      break;
    }
    case "permissions": {
      const r = await ask("item/permissions/requestApproval", { threadId, turnId, itemId: `p-${randomUUID()}`, environmentId: null, startedAtMs: Date.now(), cwd: thread(threadId)?.cwd, reason: "To fetch a page", permissions: { network: { enabled: true }, fileSystem: null } });
      await answer(threadId, turnId, `network:${r.permissions?.network?.enabled === true ? "yes" : "no"}`);
      break;
    }
    case "elicit": {
      const r = await ask("mcpServer/elicitation/request", { threadId, turnId, serverName: "someconnector", mode: "form", _meta: null, message: "Pick a workspace", requestedSchema: { type: "object", properties: {} } });
      await answer(threadId, turnId, `elicit:${r.action}`);
      break;
    }
    case "slow": {
      const id = `exec-${randomUUID()}`;
      note("item/started", { threadId, turnId, item: { type: "commandExecution", id, command: "/bin/zsh -lc 'sleep 30'", cwd: thread(threadId)?.cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null } });
      await new Promise((resolve) => (current.resolveInterrupt = resolve));
      status = "interrupted";
      break;
    }
    case "fail":
      note("error", { threadId, turnId, willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null } });
      status = "failed";
      error = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
      break;
    case "compact":
      note("item/started", { threadId, turnId, item: { type: "contextCompaction", id: `c-${randomUUID()}` } });
      note("item/completed", { threadId, turnId, item: { type: "contextCompaction", id: `c-${randomUUID()}` } });
      note("thread/compacted", { threadId, turnId });
      await answer(threadId, turnId, "compacted");
      break;
    case "mcp": {
      const id = `mcp-${randomUUID()}`;
      note("item/started", { threadId, turnId, item: { type: "mcpToolCall", id, server: "docs", tool: "search", status: "inProgress", arguments: { q: "x" }, result: null, error: null } });
      note("item/completed", { threadId, turnId, item: { type: "mcpToolCall", id, server: "docs", tool: "search", status: "completed", arguments: { q: "x" }, result: { content: [{ type: "text", text: "found" }] }, error: null } });
      await answer(threadId, turnId, "searched");
      break;
    }
    case "web": {
      const id = `ws-${randomUUID()}`;
      note("item/started", { threadId, turnId, item: { type: "webSearch", id, query: "", action: null, results: null } });
      note("item/completed", { threadId, turnId, item: { type: "webSearch", id, query: "pelican facts", action: null, results: null } });
      await answer(threadId, turnId, "looked");
      break;
    }
    case "collab": {
      const id = `ca-${randomUUID()}`;
      note("item/started", { threadId, turnId, item: { type: "collabAgentToolCall", id, tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [], prompt: "Check the tests", model: null, reasoningEffort: null, agentsStates: {} } });
      note("item/completed", { threadId, turnId, item: { type: "collabAgentToolCall", id, tool: "spawnAgent", status: "completed", senderThreadId: threadId, receiverThreadIds: ["x"], prompt: "Check the tests", model: null, reasoningEffort: null, agentsStates: {} } });
      await answer(threadId, turnId, "delegated");
      break;
    }
  }
  if (status !== "interrupted") usage(threadId, turnId, 1);
  note("turn/completed", { threadId, turn: { id: turnId, status, error, items: [] } });
  current = undefined;
}

async function onRequest(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      if (process.env.FAKE_CODEX_INIT === "fail") process.exit(2);
      return { userAgent: "pobots/0.165.0 (fake)", codexHome: "/nowhere", platformFamily: "unix", platformOs: "macos" };
    case "account/read":
      return process.env.FAKE_CODEX_ACCOUNT === "none" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true };
    case "model/list":
      return { data: MODELS, nextCursor: null };
    case "thread/start": {
      refuseUnknownServers(p.config);
      const id = randomUUID();
      live.set(id, { cwd: p.cwd, tools: p.dynamicTools ?? [], ephemeral: p.ephemeral === true, last: "" });
      persist(id);
      return { thread: { id, ephemeral: p.ephemeral === true }, model: p.model, reasoningEffort: "xhigh", approvalPolicy: p.approvalPolicy, sandbox: { type: "readOnly" }, serviceTier: tierFor(p.serviceTier) };
    }
    case "thread/resume": {
      const t = thread(p.threadId);
      if (!t) throw { code: -32600, message: `no rollout found for thread id ${p.threadId}` };
      refuseUnknownServers(p.config);
      if (p.cwd) t.cwd = p.cwd;
      return { thread: { id: p.threadId, ephemeral: false }, model: p.model, reasoningEffort: "xhigh", serviceTier: tierFor(p.serviceTier) };
    }
    case "thread/read": {
      if (!thread(p.threadId)) throw { code: -32600, message: `thread not loaded: ${p.threadId}` };
      return { thread: { id: p.threadId } };
    }
    case "thread/archive": {
      if (!readThread(p.threadId)) throw { code: -32600, message: "no such thread" };
      writeThread(p.threadId, { archived: true });
      return {};
    }
    case "thread/delete": {
      if (readThread(p.threadId)) writeThread(p.threadId, { deleted: true });
      live.delete(p.threadId);
      return {};
    }
    case "turn/start": {
      const t = thread(p.threadId);
      if (!t) throw { code: -32600, message: "thread not loaded" };
      const turnId = randomUUID();
      // The tag is read from the last block, the message itself; blocks before it are Pobots' handoff and news.
      const text = (p.input ?? []).filter((i) => i.type === "text").at(-1)?.text ?? "";
      current = { threadId: p.threadId, turnId };
      if (p.serviceTier !== undefined) setImmediate(() => note("thread/settings/updated", { threadId: p.threadId, threadSettings: { model: p.model ?? null, serviceTier: tierFor(p.serviceTier) } }));
      setImmediate(() => void playTurn(p.threadId, turnId, text));
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    case "turn/interrupt": {
      if (current?.turnId === p.turnId) current.resolveInterrupt?.();
      return {};
    }
    case "turn/steer": {
      if (!current || current.threadId !== p.threadId || current.turnId !== p.expectedTurnId) throw { code: -32600, message: "no active turn to steer" };
      const text = (p.input ?? []).filter((i) => i.type === "text").map((i) => i.text).join("\n");
      (current.steers ??= []).push(text);
      note("item/started", { threadId: p.threadId, turnId: current.turnId, item: { type: "userMessage", id: `um-${randomUUID()}`, clientId: null, content: p.input ?? [] } });
      return { turnId: current.turnId };
    }
    default:
      throw { code: -32601, message: `unknown method ${m.method}` };
  }
}

// Codex refuses a thread (started or resumed) whose config switches off a server it does not have, or one a plugin brings.
function refuseUnknownServers(config) {
  const known = JSON.parse(process.env.FAKE_CODEX_MCP || "[]").filter((x) => !x.plugin).map((x) => x.name);
  for (const key of Object.keys(config ?? {})) {
    const m = /^mcp_servers\.([^.]+)\.enabled$/.exec(key);
    if (m && !known.includes(m[1])) throw { code: -32600, message: `failed to load configuration: invalid transport\nin \`mcp_servers.${m[1]}\`\n` };
  }
}

// `mcp list --json` (step helper-sees): the servers in FAKE_CODEX_MCP (a JSON array), else none.
if (process.argv.includes("mcp") && process.argv.includes("list")) {
  process.stdout.write(process.env.FAKE_CODEX_MCP || "[]");
  process.exit(0);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  log("in", m);
  if (m.id !== undefined && m.method === undefined) {
    const w = waits.get(m.id);
    waits.delete(m.id);
    w?.(m.result ?? {});
    return;
  }
  if (m.id === undefined) return; // a notification ("initialized")
  onRequest(m).then(
    (result) => write({ id: m.id, result }),
    (err) => write({ id: m.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } }),
  );
});
process.stdin.on("end", () => process.exit(0));
