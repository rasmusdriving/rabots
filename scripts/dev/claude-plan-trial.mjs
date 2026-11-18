// Trial (job 7, 14 Nov 2026): what a Pobots bot on Claude gets for (1) its own to-do list and (2)
// thinking summaries. Drives the harness the way engine/claude/session.ts does (streaming input,
// forwardSubagentText, partial messages, the claude_code preset, the person's settings) on Haiku in a
// temporary folder, and prints: which to-do tools the harness offers (init's tool list), every to-do
// tool call with its input, and every thinking block (how long its text is, whether it is empty).
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/claude-plan-trial.mjs [default|summarized] [effort] [todo]
//
// "summarized" passes thinking { type: "adaptive", display: "summarized" }; "default" passes nothing.
// "todo" sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1 in the harness's environment (the harness offers its
// to-do tools on newer models only with it, seen in Claude Code 2.1.325).
// The env file that routes Claude is read by the engine's own code and never printed.
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
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

const mode = process.argv[2] ?? "default";
const effort = process.argv[3] ?? "high";
const todo = process.argv[4] === "todo";
const MODEL = "claude-haiku-5-5";
const cwd = mkdtempSync(join(tmpdir(), "pobots-plan-trial-"));
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

const TASK =
  "This is a small test. First write a to-do list of three steps with your to-do tool. Then do the steps one by one, keeping the list up to date: " +
  'run "echo one", then "echo two", then "echo three" with your Bash tool, one call each. Think briefly about the order before you start. End with one short sentence.';

const q = query({
  prompt: (async function* () {
    yield { type: "user", message: { role: "user", content: TASK }, parent_tool_use_id: null, uuid: crypto.randomUUID() };
  })(),
  options: {
    cwd,
    pathToClaudeCodeExecutable: setup.executable,
    env: todo ? { ...setup.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : setup.env,
    model: MODEL,
    effort,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project"],
    forwardSubagentText: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are Trial Bot, a bot in a test." },
    includePartialMessages: true,
    persistSession: false,
    ...(mode === "summarized" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  },
});

let thinkingDeltaChars = 0;
let thinkingBlocksStreamed = 0;
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    const todo = (m.tools ?? []).filter((t) => /todo|^Task(Create|Update|List|Get)$/i.test(t));
    console.log(`${sec()}  init model=${m.model} to-do tools: ${todo.join(", ") || "none"}`);
  } else if (m.type === "stream_event" && !m.parent_tool_use_id) {
    const ev = m.event;
    if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") thinkingBlocksStreamed++;
    if (ev.type === "content_block_start" && ev.content_block?.type === "redacted_thinking") console.log(`${sec()}  stream redacted_thinking block`);
    if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") thinkingDeltaChars += (ev.delta.thinking ?? "").length;
  } else if (m.type === "assistant") {
    for (const b of m.message?.content ?? []) {
      if (b.type === "thinking") console.log(`${sec()}  assistant thinking: ${b.thinking ? `${b.thinking.length} chars: ${short(b.thinking, 160)}` : "EMPTY"} signature=${!!b.signature}`);
      else if (b.type === "redacted_thinking") console.log(`${sec()}  assistant redacted_thinking`);
      else if (b.type === "text") console.log(`${sec()}  assistant text: ${short(b.text, 160)}`);
      else if (b.type === "tool_use") console.log(`${sec()}  assistant tool_use ${b.name} ${/todo|task/i.test(b.name) ? short(b.input, 600) : short(b.input, 80)}`);
    }
  } else if (m.type === "result") {
    console.log(`${sec()}  result/${m.subtype} text=${short(m.result ?? "", 120)}`);
    break;
  }
}
console.log(`thinking blocks streamed: ${thinkingBlocksStreamed}, thinking_delta characters: ${thinkingDeltaChars}`);
