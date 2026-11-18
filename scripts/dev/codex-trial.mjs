// Trial: drive `codex app-server` over stdio. Usage: node codex-trial.mjs <scenario> [args]
// Writes every message to codex-trial-<scenario>.jsonl in the run's temporary folder (printed at the
// end; TRIAL_LOG overrides) and prints a short summary.
//
// Scenarios from step 3a's base: models, hello, tool, approve, resume <threadId>, delete <threadId...>.
// Added by the engine worker of step 3a (each deletes the threads it made, also when it fails):
//   ephemeral        an ephemeral thread with an own tool and "Asks first" approvals (one declined)
//   interrupt        a turn stopped with turn/interrupt while a command runs
//   wait <seconds>   an own tool whose answer comes only after that many seconds
//   exists [id]      thread/read for an id that does not exist (and for <id> when given)
//   userinput        asks the model to use request_user_input, to see whether that request comes
// Added for steering (13 Nov 2026):
//   steer            turn/steer while a command runs (taken into the same turn?), then turn/steer after
//                    the turn ended and with a wrong turn id (what the refusals look like)
// Added for job 7 (14 Nov 2026):
//   plan             a turn asked to keep a plan (update_plan) while it runs three commands: prints every
//                    turn/plan/updated and every reasoning summary that arrives (SUMMARY=auto|concise|detailed|none
//                    is sent as turn/start's summary; left out when SUMMARY is not set; CONFIG='{"key":value}' is
//                    sent as thread/start's config overrides)
//   planresume2 <id> a thread made by "KEEP=1 hello", resumed in a fresh app-server with the plan setting
//   planresume       a thread started without the plan setting and resumed with it: is it taken, does the plan come
// Real model calls go to gpt-6-luna at low effort unless MODEL / EFFORT say otherwise.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "hello";
const cwd = process.env.TRIAL_CWD ?? mkdtempSync(join(tmpdir(), "pobots-codex-trial-"));
const logFile = process.env.TRIAL_LOG ?? join(cwd, `codex-trial-${scenario}.jsonl`);
writeFileSync(logFile, "");
const MODEL = process.env.MODEL ?? "gpt-6-luna";
const EFFORT = process.env.EFFORT ?? "low";
const codexBin = process.env.CODEX_BIN ?? [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((p) => existsSync(p));
const child = spawn(codexBin, ["app-server", ...(process.env.EXTRA_ARGS ? JSON.parse(process.env.EXTRA_ARGS) : [])], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(process.env.EXTRA_ENV ? JSON.parse(process.env.EXTRA_ENV) : {}) } });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
child.on("exit", (code, signal) => console.log("app-server exited", code, signal));
let n = 0;
const waits = new Map();
const seen = [];
const made = new Set();
const short = (v, max = 300) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…" : s; };
const send = (o) => { appendFileSync(logFile, JSON.stringify({ dir: "out", at: Date.now(), ...o }) + "\n"); child.stdin.write(JSON.stringify(o) + "\n"); };
const req = (method, params) => new Promise((res, rej) => { const id = ++n; waits.set(id, { res, rej, method }); send({ id, method, params }); });
let onServerRequest = () => undefined;
let onNote = () => undefined;
let turnDone;
const turnEnd = () => new Promise((r) => (turnDone = r));
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  appendFileSync(logFile, JSON.stringify({ dir: "in", at: Date.now(), ...m }) + "\n");
  if (m.id !== undefined && m.method === undefined) {
    const w = waits.get(m.id); waits.delete(m.id);
    if (m.error) w?.rej(new Error(`${w.method}: ${JSON.stringify(m.error)}`)); else w?.res(m.result);
  } else if (m.id !== undefined) {
    console.log("SERVER REQUEST", m.method, short(m.params, 700));
    Promise.resolve(onServerRequest(m)).then((answer) => {
      if (answer === undefined) send({ id: m.id, error: { code: -32601, message: "not handled by the trial" } });
      else send({ id: m.id, result: answer });
    });
  } else {
    if (!/delta|outputDelta|rateLimits|mcpServer\/startupStatus|skills\/changed/i.test(m.method)) seen.push(m);
    onNote(m);
    if (m.method === "turn/completed") turnDone?.(m.params);
  }
});
const summary = () => { for (const m of seen.splice(0)) { const p = m.params ?? {}; console.log("·", m.method, p.item ? `${p.item.type} ${short({ ...p.item, id: undefined }, 260)}` : short(p, 260)); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a thread with the approval policy, sandbox and effort always set (his own settings would leak in otherwise). */
async function startThread(extra = {}) {
  const t = await req("thread/start", { cwd, model: MODEL, approvalPolicy: "untrusted", sandbox: "read-only", serviceName: "pobots-trial", developerInstructions: "You are a test bot in a temporary folder. Keep answers to one short line. Never use connectors or MCP tools.", ...extra });
  if (!t.thread?.ephemeral) made.add(t.thread.id);
  console.log("thread ->", short({ id: t.thread?.id, ephemeral: t.thread?.ephemeral, model: t.model, effort: t.reasoningEffort, approvalPolicy: t.approvalPolicy, reviewer: t.approvalsReviewer, sandbox: t.sandbox }, 700));
  return t;
}
async function turn(threadId, text, extra = {}, timeoutMs = 180000) {
  const done = turnEnd();
  const r = await req("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], effort: EFFORT, ...extra });
  console.log("turn ->", short(r, 300));
  const end = await Promise.race([done, wait(timeoutMs).then(() => "TIMEOUT")]);
  summary();
  console.log("turn end ->", short(end, 800));
  return { start: r, end };
}

let exitCode = 0;
try {
  const init = await req("initialize", { clientInfo: { name: "pobots-trial", title: "Pobots trial", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  console.log("initialize ->", short(init, 400));

  if (scenario === "models") {
    const r = await req("model/list", {});
    for (const m of r.data ?? r.models ?? []) console.log(m.id, "|", m.displayName, "| hidden", m.hidden, "| default", m.isDefault, "| efforts", (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e.effort ?? JSON.stringify(e)).join(","), "| defEffort", m.defaultReasoningEffort, "| tiers", JSON.stringify(m.serviceTiers ?? null), "| speedTiers", JSON.stringify(m.additionalSpeedTiers ?? null), "| defTier", m.defaultServiceTier);
    console.log("next", r.nextCursor);
    const a = await req("account/read", {}).catch((e) => ({ error: e.message }));
    console.log("account keys", Object.keys(a), "type", a.account?.type, "plan", a.account?.planType);
  }

  if (scenario === "tier") {
    // What the service tier does: which tier a new thread reports for each value we can send, and
    // (with TURNS=1) one one-word turn on "priority" and one on "default", timed.
    const values = { priority: "priority", default: "default", fast: "fast", null: null, omitted: undefined };
    for (const [name, value] of Object.entries(values)) {
      const extra = { ephemeral: true, approvalPolicy: "never", sandbox: "read-only", ...(value === undefined ? {} : { serviceTier: value }) };
      const t = await req("thread/start", { cwd, model: MODEL, serviceName: "pobots-trial", developerInstructions: "You are a test bot. Answer in one word.", ...extra }).catch((e) => ({ error: e.message.slice(0, 300) }));
      console.log(`thread/start serviceTier ${name} ->`, t.error ?? short({ serviceTier: t.serviceTier, model: t.model }, 300));
      if (process.env.TURNS === "1" && !t.error && (name === "priority" || name === "default")) {
        const started = Date.now();
        const r = await turn(t.thread.id, "Answer with the single word ready.", { serviceTier: value });
        console.log(`turn on ${name}: ${Date.now() - started} ms, status ${r.end?.turn?.status}`);
      }
    }
  }

  if (scenario === "hello" || scenario === "tool" || scenario === "approve") {
    const dynamicTools = scenario === "tool" ? [{ name: "say_hello", description: "Says hello to a name. Use it when asked.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] : undefined;
    const t = await startThread({ ...(scenario === "approve" ? {} : { approvalPolicy: "never", sandbox: "workspace-write" }), ...(dynamicTools ? { dynamicTools } : {}) });
    onServerRequest = (m) => {
      if (m.method === "item/tool/call") return { contentItems: [{ type: "inputText", text: `Hello, ${m.params?.arguments?.name}. The secret word is plommon.` }], success: true };
      if (m.method === "item/commandExecution/requestApproval") return { decision: "accept" };
      if (m.method === "item/fileChange/requestApproval") return { decision: "decline" };
      return undefined;
    };
    const text = scenario === "hello" ? "Answer with the single word ready."
      : scenario === "tool" ? "Call the say_hello tool with the name Kaja and tell me the secret word it gives."
      : "Run the shell command `echo trial-ok > made.txt` and then tell me in one line whether it worked.";
    await turn(t.thread.id, text);
    console.log("THREAD", t.thread.id);
  }

  if (scenario === "ephemeral") {
    const dynamicTools = [{ name: "say_hello", description: "Says hello to a name. Use it when asked.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
    const t = await startThread({ ephemeral: true, dynamicTools });
    const ids = [];
    onNote = (m) => { if (m.method === "item/started" && m.params.item.type === "dynamicToolCall") ids.push(["item", m.params.item.id]); };
    onServerRequest = (m) => {
      if (m.method === "item/tool/call") { ids.push(["call", m.params.callId]); return { contentItems: [{ type: "inputText", text: `Hello, ${m.params?.arguments?.name}. The secret word is plommon.` }], success: true }; }
      if (m.method === "item/commandExecution/requestApproval") return { decision: "decline" };
      if (m.method === "item/fileChange/requestApproval") return { decision: "decline" };
      return undefined;
    };
    await turn(t.thread.id, "First call the say_hello tool with the name Kaja. Then run the shell command `echo hi > x.txt` in your folder. Then tell me the secret word and whether the command ran.");
    console.log("ids (item vs call):", JSON.stringify(ids));
    const read = await req("thread/read", { threadId: t.thread.id }).then((r) => ({ ok: true, ephemeral: r.thread?.ephemeral }), (e) => ({ error: e.message.slice(0, 200) }));
    console.log("thread/read of the ephemeral thread ->", short(read, 300));
    const list = await req("thread/list", { limit: 5 }).then((r) => (r.data ?? []).some((x) => x.id === t.thread.id), (e) => e.message.slice(0, 160));
    console.log("listed in thread/list:", list);
    const del = await req("thread/delete", { threadId: t.thread.id }).then(() => "deleted", (e) => e.message.slice(0, 200));
    console.log("thread/delete of the ephemeral thread ->", del);
  }

  if (scenario === "interrupt") {
    const t = await startThread({ approvalPolicy: "never", sandbox: "workspace-write" });
    let turnId;
    onNote = (m) => {
      if (m.method === "turn/started") turnId = m.params.turn?.id;
      if (m.method === "item/started" && m.params.item.type === "commandExecution" && turnId) {
        console.log("interrupting turn", turnId);
        req("turn/interrupt", { threadId: t.thread.id, turnId }).then((r) => console.log("turn/interrupt ->", short(r)), (e) => console.log("turn/interrupt failed", e.message));
      }
    };
    await turn(t.thread.id, "Run the shell command `sleep 30` in your folder, then answer done.");
  }

  if (scenario === "wait") {
    const seconds = Number(process.argv[3] ?? 90);
    const dynamicTools = [{ name: "slow_answer", description: "Returns the secret word, slowly. Call it when asked and wait for it.", inputSchema: { type: "object", properties: {}, required: [] } }];
    const t = await startThread({ approvalPolicy: "never", sandbox: "read-only", dynamicTools });
    onServerRequest = async (m) => {
      if (m.method !== "item/tool/call") return undefined;
      const started = Date.now();
      await wait(seconds * 1000);
      console.log(`answering the tool call after ${Math.round((Date.now() - started) / 1000)} s`);
      return { contentItems: [{ type: "inputText", text: "The secret word is plommon." }], success: true };
    };
    await turn(t.thread.id, "Call the slow_answer tool once, wait for it, and answer with the secret word it gives.", {}, (seconds + 240) * 1000);
  }

  if (scenario === "approvewait") {
    const seconds = Number(process.argv[3] ?? 90);
    const t = await startThread({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    onServerRequest = async (m) => {
      if (m.method === "item/commandExecution/requestApproval") {
        await wait(seconds * 1000);
        const decision = process.env.DECISION ?? "accept";
        console.log(`answering ${decision} after ${seconds} s`);
        return { decision };
      }
      if (m.method === "item/fileChange/requestApproval") return { decision: "decline" };
      return undefined;
    };
    await turn(t.thread.id, "Run exactly this shell command in your folder: `echo trial-ok > made.txt`. Do not edit files any other way. Then say in one line whether it worked.", {}, (seconds + 240) * 1000);
  }

  if (scenario === "exists") {
    for (const id of ["019a0000-0000-7000-8000-000000000000", ...process.argv.slice(3)]) {
      console.log(id.slice(0, 8), await req("thread/read", { threadId: id }).then((r) => `exists (${r.thread?.id?.slice(0, 8)})`, (e) => e.message.slice(0, 200)));
    }
  }

  if (scenario === "userinput") {
    const t = await startThread({ approvalPolicy: "untrusted", sandbox: "read-only" });
    onServerRequest = (m) => {
      if (m.method === "item/tool/requestUserInput") {
        const q = m.params.questions?.[0];
        return { answers: q ? { [q.id]: { answers: [q.options?.[0]?.label ?? "blue"] } } : {} };
      }
      if (/requestApproval/.test(m.method)) return { decision: "decline" };
      return undefined;
    };
    await turn(t.thread.id, "Use your tool for asking the user a question (request_user_input) to ask me whether I prefer red or blue, then answer with my choice. If you have no such tool, say no tool.");
  }

  if (scenario === "steer") {
    const t = await startThread({ approvalPolicy: "never", sandbox: "workspace-write" });
    let turnId;
    let steered = false;
    onNote = (m) => {
      if (m.method === "turn/started") turnId = m.params.turn?.id;
      if (m.method === "item/started" && m.params.item.type === "commandExecution" && turnId && !steered) {
        steered = true;
        const input = [{ type: "text", text: 'Change of plan: also write the word kiwi into a file named steer.txt in your folder before you answer. Say "kiwi" in your answer.', text_elements: [] }];
        req("turn/steer", { threadId: t.thread.id, expectedTurnId: turnId, input }).then((r) => console.log("turn/steer ->", short(r)), (e) => console.log("turn/steer failed", e.message));
      }
    };
    const r = await turn(t.thread.id, "Run the shell command `sleep 6; echo one` in your folder, then the shell command `sleep 3; echo two`, then answer with one short line.");
    console.log("steer.txt:", existsSync(join(cwd, "steer.txt")));
    const input = [{ type: "text", text: "Late word.", text_elements: [] }];
    console.log("steer after the end ->", await req("turn/steer", { threadId: t.thread.id, expectedTurnId: r.end?.turn?.id ?? turnId, input }).then((x) => short(x), (e) => e.message.slice(0, 300)));
    console.log("steer with a wrong id ->", await req("turn/steer", { threadId: t.thread.id, expectedTurnId: "nope", input }).then((x) => short(x), (e) => e.message.slice(0, 300)));
  }

  if (scenario === "plan") {
    // CONFIG='{"tools.update_plan":true}' passes thread/start's config overrides.
    const t = await startThread({ approvalPolicy: "never", sandbox: "workspace-write", ...(process.env.CONFIG ? { config: JSON.parse(process.env.CONFIG) } : {}) });
    const summaries = new Map();
    onNote = (m) => {
      if (m.method === "turn/plan/updated") console.log("PLAN", short({ explanation: m.params.explanation, plan: m.params.plan }, 900));
      if (m.method === "item/reasoning/summaryTextDelta") summaries.set(m.params.itemId, (summaries.get(m.params.itemId) ?? "") + (m.params.delta ?? ""));
      if (m.method === "item/completed" && m.params.item?.type === "reasoning") console.log("REASONING item", short({ summary: m.params.item.summary, content: m.params.item.content }, 500));
      if (m.method === "item/started" && m.params.item?.type === "todoList") console.log("TODO item", short(m.params.item, 500));
    };
    await turn(t.thread.id, 'This is a small test. First make a plan of three steps with your plan tool. Then run "echo one", "echo two" and "echo three" in your folder, one command each, keeping the plan up to date. Think briefly about the order first. End with one short line.', process.env.SUMMARY ? { summary: process.env.SUMMARY } : {});
    for (const [id, text] of summaries) console.log("SUMMARY TEXT", id.slice(0, 8), short(text, 400));
  }

  if (scenario === "planresume") {
    // Job 7: a thread started without the plan setting, then resumed with it (as the engine resumes a
    // bot's thread): does thread/resume take the config, and does the plan come?
    const t = await startThread({ approvalPolicy: "never", sandbox: "workspace-write" });
    await turn(t.thread.id, "Answer with the single word ready.");
    const r = await req("thread/resume", { threadId: t.thread.id, excludeTurns: true, model: MODEL, approvalPolicy: "never", sandbox: "workspace-write", config: { "tools.update_plan": { enabled: true } } }).then((x) => x, (e) => ({ error: e.message.slice(0, 300) }));
    console.log("resume with config ->", r.error ?? "ok");
    onNote = (m) => {
      if (m.method === "turn/plan/updated") console.log("PLAN", short(m.params.plan, 400));
    };
    if (!r.error) await turn(t.thread.id, 'Make a plan of two steps with your plan tool, then run "echo one" and "echo two", keeping the plan up to date. End with one short line.');
  }

  if (scenario === "planresume2") {
    // Job 7: a thread made earlier (KEEP=1 hello) resumed in a fresh app-server with the plan setting.
    const r = await req("thread/resume", { threadId: process.argv[3], excludeTurns: true, model: MODEL, approvalPolicy: "never", sandbox: "workspace-write", config: { "tools.update_plan": { enabled: true } } });
    made.add(process.argv[3]);
    onNote = (m) => {
      if (m.method === "turn/plan/updated") console.log("PLAN", short(m.params.plan, 400));
    };
    await turn(r.thread.id, 'This is a small test. First make a plan of three steps with your plan tool. Then run "echo one", "echo two" and "echo three", one command each, keeping the plan up to date. End with one short line.');
  }

  if (scenario === "resume") {
    onServerRequest = (m) => (m.method === "item/tool/call" ? { contentItems: [{ type: "inputText", text: "Hello again. The new word is hallon." }], success: true } : undefined);
    const t = await req("thread/resume", { threadId: process.argv[3], excludeTurns: true });
    console.log("resumed ->", short({ id: t.thread?.id, model: t.model, keys: Object.keys(t) }, 400));
    await turn(t.thread.id, process.env.TEXT ?? "What single word did you answer with before? One word.");
  }

  if (scenario === "delete") {
    for (const id of process.argv.slice(3)) console.log(id.slice(0, 8), await req("thread/delete", { threadId: id }).then(() => "deleted", (e) => e.message.slice(0, 160)));
  }
} catch (err) {
  console.log("FAILED:", err.message);
  exitCode = 1;
} finally {
  // KEEP=1 keeps the threads for a following scenario (resume, exists); delete them with "delete <id>" afterwards.
  if (process.env.KEEP === "1") made.clear();
  for (const id of made) console.log("delete", id.slice(0, 8), await req("thread/delete", { threadId: id }).then(() => "deleted", (e) => e.message.slice(0, 160)));
  child.kill();
  if (stderr.trim()) console.log("stderr tail:", stderr.trim().split("\n").slice(-4).join(" / ").slice(0, 600));
  console.log("log:", logFile);
  process.exit(exitCode);
}
