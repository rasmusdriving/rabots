// Trial (steering, 13 Nov 2026): what the real Claude harness does with a user message pushed into a
// running turn, with each `priority` of the SDK's streaming input ("next", "now"), and when the
// message comes while the model only writes its last answer (no tool call left to fold it in at).
// Drives the harness the way engine/claude/session.ts does (streaming input, forwardSubagentText,
// partial messages) on the cheapest model at low effort, in a temporary folder, and records every
// message. Run it with a clean environment like the service has:
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/claude-steer-trial.mjs <scenario>
//
// Scenarios:
//   next          three short commands one after the other; a steer with priority "next" after the first
//   now           the same with priority "now"
//   text          a turn that only writes text; a steer with priority "next" while it writes
//
// Writes every message (stream events only counted) to trial-<scenario>.jsonl in the run's
// temporary folder, prints one short line per message and the folder at the end. The env file that
// routes Claude is read by the engine's own code and never printed.
import { registerHooks } from "node:module";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if ((specifier.startsWith(".") || specifier.startsWith("/")) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);
      throw err;
    }
  },
});

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { detectClaude } = await import("../../engine/claude/detect.ts");

const scenario = process.argv[2] ?? "next";
const MODEL = "claude-haiku-5-5";
const cwd = mkdtempSync(join(tmpdir(), "pobots-steer-trial-"));
const logFile = join(cwd, `trial-${scenario}.jsonl`);
writeFileSync(logFile, "");
writeFileSync(join(cwd, "notes.txt"), "pelican\n");
const envFile = process.env.POBOTS_CLAUDE_ENV_FILE || join(homedir(), ".claude", "cliproxy.env");
const setup = await detectClaude(existsSync(envFile) ? { envFile } : {});
if (!setup.ready) {
  console.error("Claude is not ready:", setup.problem);
  process.exit(1);
}

const T0 = Date.now();
const sec = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const short = (v, max = 200) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
};

// The harness's input: an async queue of user messages.
const queue = [];
let wakeInput;
let ended = false;
const input = {
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        while (!queue.length && !ended) await new Promise((r) => (wakeInput = r));
        if (!queue.length) return { done: true, value: undefined };
        return { done: false, value: queue.shift() };
      },
    };
  },
};
function send(text, priority) {
  const uuid = crypto.randomUUID();
  console.log(`${sec()}  >> ${priority ?? "-"} ${uuid.slice(0, 8)} ${short(text, 160)}`);
  appendFileSync(logFile, JSON.stringify({ dir: "out", at: Date.now() - T0, text, priority, uuid }) + "\n");
  queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, ...(priority ? { priority } : {}) });
  wakeInput?.();
}

const q = query({
  prompt: input,
  options: {
    cwd,
    pathToClaudeCodeExecutable: setup.executable,
    env: setup.env,
    model: MODEL,
    effort: "low",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project"],
    forwardSubagentText: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are Trial Bot, a bot in a test. Keep every answer to one short sentence." },
    includePartialMessages: true,
    persistSession: false,
  },
});

// State for deciding when things are quiet.
let inTurn = false;
let live = [];
let lastAt = Date.now();
let results = 0;
let streamEvents = 0;

function line(m) {
  const t = m.type;
  if (t === "stream_event") {
    streamEvents++;
    return;
  }
  appendFileSync(logFile, JSON.stringify({ dir: "in", at: Date.now() - T0, ...m }) + "\n");
  lastAt = Date.now();
  const p = m.parent_tool_use_id ? ` [helper ${m.parent_tool_use_id.slice(-6)}]` : "";
  if (t === "system") {
    const s = m.subtype;
    if (s === "init") {
      inTurn = true;
      return console.log(`${sec()}  system/init`);
    }
    if (s === "task_started") return console.log(`${sec()}  system/task_started task=${m.task_id} type=${m.task_type} tool_use=${m.tool_use_id ?? "-"} bg=${m.is_backgrounded} parent_task=${m.parent_task_id ?? "-"} depth=${m.spawn_depth ?? "-"} run=${m.run_id ?? "-"} desc=${short(m.description, 60)}`);
    if (s === "task_updated") return console.log(`${sec()}  system/task_updated task=${m.task_id} run=${m.run_id ?? "-"} patch=${short(m.patch, 160)}`);
    if (s === "task_notification") return console.log(`${sec()}  system/task_notification task=${m.task_id} run=${m.run_id ?? "-"} tool_use=${m.tool_use_id ?? "-"} status=${m.status} summary=${short(m.summary, 220)}`);
    if (s === "task_progress") return console.log(`${sec()}  system/task_progress task=${m.task_id} last_tool=${m.last_tool_name ?? "-"}`);
    if (s === "background_tasks_changed") {
      live = (m.tasks ?? []).map((x) => x.task_id);
      return console.log(`${sec()}  system/background_tasks_changed ${short((m.tasks ?? []).map((x) => `${x.task_id}:${x.task_type}${x.parent_task_id ? `<${x.parent_task_id}` : ""}${x.ambient ? ":ambient" : ""}`), 300)}`);
    }
    return console.log(`${sec()}  system/${s} ${short({ ...m, type: undefined, subtype: undefined, uuid: undefined, session_id: undefined }, 200)}`);
  }
  if (t === "assistant") {
    for (const b of m.message?.content ?? []) {
      if (b.type === "text") console.log(`${sec()}  assistant${p} text: ${short(b.text, 160)}`);
      else if (b.type === "tool_use") console.log(`${sec()}  assistant${p} tool_use ${b.name} id=${b.id} ${short(b.input, 260)}`);
    }
    return;
  }
  if (t === "user") {
    const c = m.message?.content;
    if (typeof c === "string") return console.log(`${sec()}  user${p} text: ${short(c, 200)}`);
    for (const b of c ?? []) {
      if (b.type === "tool_result") console.log(`${sec()}  user${p} tool_result for=${b.tool_use_id} err=${b.is_error === true} ${short(typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join(" "), 220)}`);
      else if (b.type === "text") console.log(`${sec()}  user${p} text: ${short(b.text, 200)}`);
    }
    return;
  }
  if (t === "result") {
    inTurn = false;
    results++;
    return console.log(`${sec()}  result/${m.subtype} reason=${m.terminal_reason ?? "-"} own=${JSON.stringify((m.user_message_uuids ?? [m.user_message_uuid ?? ""]).map((u) => u.slice(0, 8)))} text=${short(m.result ?? "", 120)}`);
  }
  console.log(`${sec()}  ${t}${m.subtype ? "/" + m.subtype : ""}${m.state ? " " + m.state : ""}${m.command_uuid ? " " + m.command_uuid.slice(0, 8) : ""}`);
}

const consuming = (async () => {
  try {
    for await (const m of q) line(m);
  } catch (err) {
    console.log(`${sec()}  the harness ended with an error: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until no turn runs, nothing lives in the background and nothing came for `quietMs`, or `maxMs`. */
async function quiet(quietMs, maxMs) {
  const start = Date.now();
  for (;;) {
    await pause(500);
    if (!inTurn && !live.length && Date.now() - lastAt >= quietMs && results > 0) return true;
    if (Date.now() - start > maxMs) return false;
  }
}

let sawTool = 0;
const seen = (async () => {})();
const TASK =
  'Run these three shell commands with your Bash tool, one call each, one after the other, never together: "sleep 5; echo one", "sleep 5; echo two", "sleep 5; echo three". ' +
  "After the third, reply with one short sentence.";
const STEER = 'Change of plan: also write the word kiwi into a file named steer.txt in this folder before you reply. Say "kiwi" in your reply.';

if (scenario === "next" || scenario === "now") {
  send(TASK);
  // Steer once the first command runs.
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await pause(250);
    if (existsSync(logFile) && (await import("node:fs")).readFileSync(logFile, "utf8").includes('"tool_use"')) break;
  }
  await pause(1500);
  send(STEER, scenario);
  console.log(`${sec()}  -- quiet: ${await quiet(8_000, 180_000)}`);
} else if (scenario === "text") {
  send("Write a calm paragraph of about 250 words about lighthouses. Use no tools.");
  await pause(4000);
  send(STEER, "next");
  console.log(`${sec()}  -- quiet: ${await quiet(10_000, 180_000)}`);
} else {
  console.error(`No scenario ${scenario}`);
}
console.log(`steer.txt: ${existsSync(join(cwd, "steer.txt"))}`);
ended = true;
wakeInput?.();
q.close();
await consuming.catch(() => undefined);
console.log(`${sec()}  stream events: ${streamEvents}. Folder: ${cwd}`);
process.exit(0);
