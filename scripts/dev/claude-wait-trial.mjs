// Trial (step 3b, waiting): what the real Claude harness sends while work goes on in the background.
// Drives the harness the way engine/claude/session.ts does (streaming input, forwardSubagentText,
// partial messages) on the cheapest model at low effort, in a temporary folder, and records every
// message. Run it with a clean environment like the service has:
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/claude-wait-trial.mjs <scenario>
//
// Scenarios:
//   helper-bg     the bot starts a helper in the background; the helper starts a background command
//                 of about 40 seconds and stops to wait for it
//   sendmessage   the bot starts a helper in the background, hears its word, then gives it a second
//                 task with the harness's SendMessage tool
//   own-bg        the bot starts a background command itself and ends its turn
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

const scenario = process.argv[2] ?? "helper-bg";
const MODEL = "claude-haiku-5-5";
const cwd = mkdtempSync(join(tmpdir(), "pobots-wait-trial-"));
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
function send(text) {
  console.log(`${sec()}  >> ${short(text, 160)}`);
  appendFileSync(logFile, JSON.stringify({ dir: "out", at: Date.now() - T0, text }) + "\n");
  queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: crypto.randomUUID() });
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
    return console.log(`${sec()}  result/${m.subtype} own=${JSON.stringify(m.user_message_uuids ?? m.user_message_uuid ?? null)} text=${short(m.result ?? "", 120)}`);
  }
  console.log(`${sec()}  ${t}${m.subtype ? "/" + m.subtype : ""}${m.state ? " " + m.state : ""}`);
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

const HELPER_TASK =
  "Run this shell command with your Bash tool in the background (run_in_background: true): node -e \"setTimeout(()=>{},40000)\" . " +
  "Then stop and wait until it has finished. Do not poll it, do not sleep, do not run anything else. When it has finished, reply with only the word: done.";

if (scenario === "helper-bg") {
  send(
    `Start exactly one helper with your Agent tool, in the background (run_in_background: true), with the description "Wait for a command" and this task, word for word: ${JSON.stringify(HELPER_TASK)} ` +
      "Right after starting it, say in one short sentence that you started it, and end your turn. When the helper reports back that it is done, reply with only its word.",
  );
  console.log(`${sec()}  -- quiet: ${await quiet(25_000, 300_000)}`);
} else if (scenario === "sendmessage") {
  send(
    'Start exactly one helper with your Agent tool, in the background (run_in_background: true), with the description "Say a word" and the task "Reply with only the word: plover". ' +
      "Right after starting it, say in one short sentence that you started it, and end your turn. When the helper reports back, reply with only its word.",
  );
  console.log(`${sec()}  -- quiet: ${await quiet(12_000, 180_000)}`);
  send(
    'Give that same helper (the one that said plover) a second task with your SendMessage tool: "Reply with only the word: heron". Do not start a new helper. ' +
      "Say in one short sentence that you sent it, and end your turn. When it reports back, reply with only its word.",
  );
  console.log(`${sec()}  -- quiet: ${await quiet(15_000, 180_000)}`);
} else if (scenario === "own-bg") {
  send(
    'Run this shell command with your Bash tool in the background (run_in_background: true): node -e "setTimeout(()=>{},30000)" . ' +
      "Then say in one short sentence that it runs, and end your turn at once. Do not wait for it and do not check on it.",
  );
  console.log(`${sec()}  -- quiet: ${await quiet(15_000, 180_000)}`);
} else {
  console.error(`No scenario ${scenario}`);
}

ended = true;
wakeInput?.();
try {
  q.close();
} catch {}
await Promise.race([consuming, pause(5000)]);
console.log(`${sec()}  stream events: ${streamEvents}; log: ${logFile}`);
process.exit(0);
