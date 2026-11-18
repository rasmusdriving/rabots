// Trial (groundwork for pictures and files in the chat): does a Claude bot see a picture sent the
// way the engine sends messages (streaming input, one SDKUserMessage with content blocks), and can
// it read attached files by path at the lowest access level ("Asks first": permission mode
// "default", every approval the harness asks for is logged and denied)?
//
// Drives the real harness like engine/claude/session.ts on the cheapest model at low effort, in a
// temporary folder, without saving a session. Run with a clean environment like the service has:
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/claude-attach-trial.mjs <scenario>
//
// Scenarios:
//   picture   one picture (the word KIWI in black on yellow) and a question, in one message
//   toobig    a PNG of about 7.7 MB (random pixels), then a plain message in the same session
//   wide      a PNG 9000 x 60 pixels (plain red), then a plain message in the same session
//   files     a PDF, a text file and a PNG saved under attachments/, named by path in the message
//   many      three pictures in one message (KIWI, MANGO, a plain green one)
//   huge      a PNG of about 24 MB (random pixels), then a plain message in the same session
//   broken    a PNG cut off after 200 bytes, then a plain message in the same session
//
// Prints one short line per message. The env file that routes Claude is read by the engine's own
// code and never printed.
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { colourPng, noisePng, pngSize, textPdf, wordPng } from "./attach-fixtures.mjs";

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

const scenario = process.argv[2] ?? "picture";
const MODEL = "claude-haiku-5-5";
const cwd = mkdtempSync(join(tmpdir(), "pobots-attach-trial-"));
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
const imageBlock = (buf, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data: buf.toString("base64") } });
function send(content) {
  const shown = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : `[${b.type} ${b.source?.media_type} ${Math.round((b.source?.data?.length ?? 0) * 0.75 / 1024)} KB]`)).join(" + ");
  console.log(`${sec()}  >> ${short(shown, 220)}`);
  queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  wakeInput?.();
}

const asked = [];
const q = query({
  prompt: input,
  options: {
    cwd,
    pathToClaudeCodeExecutable: setup.executable,
    env: setup.env,
    model: MODEL,
    effort: "low",
    permissionMode: "default",
    canUseTool: async (toolName, toolInput) => {
      asked.push(toolName);
      console.log(`${sec()}  APPROVAL ASKED (denied): ${toolName} ${short(toolInput, 160)}`);
      return { behavior: "deny", message: "Denied in the trial." };
    },
    settingSources: ["user", "project"],
    systemPrompt: { type: "preset", preset: "claude_code", append: "You are Trial Bot, a bot in a test. Keep every answer to one short sentence." },
    persistSession: false,
    stderr: (d) => {
      for (const l of String(d).split(/\r?\n/)) if (/error|image|too large|exceed/i.test(l)) console.log(`${sec()}  stderr: ${short(l, 200)}`);
    },
  },
});

let results = 0;
function line(m) {
  const t = m.type;
  if (t === "stream_event") return;
  if (t === "system") return m.subtype === "init" ? console.log(`${sec()}  system/init model=${m.model} permissionMode=${m.permissionMode}`) : undefined;
  if (t === "assistant") {
    if (m.error) console.log(`${sec()}  assistant error=${m.error}`);
    for (const b of m.message?.content ?? []) {
      if (b.type === "text") console.log(`${sec()}  assistant text: ${short(b.text, 400)}`);
      else if (b.type === "tool_use") console.log(`${sec()}  assistant tool_use ${b.name} ${short(b.input, 200)}`);
    }
    return;
  }
  if (t === "user") {
    const c = m.message?.content;
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === "tool_result") {
        const parts = typeof b.content === "string" ? [b.content] : (b.content ?? []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`));
        console.log(`${sec()}  tool_result err=${b.is_error === true} ${short(parts.join(" "), 200)}`);
      }
    }
    return;
  }
  if (t === "result") {
    results++;
    return console.log(`${sec()}  result/${m.subtype} is_error=${m.is_error} cost=$${(m.total_cost_usd ?? 0).toFixed(4)} text=${short(m.result ?? "", 300)}`);
  }
}
const consuming = (async () => {
  try {
    for await (const m of q) line(m);
  } catch (err) {
    console.log(`${sec()}  the harness ended with an error: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextResult(maxMs = 120_000) {
  const want = results + 1;
  const start = Date.now();
  while (results < want && Date.now() - start < maxMs) await pause(300);
  return results >= want;
}

if (scenario === "picture") {
  send([imageBlock(wordPng("KIWI")), { type: "text", text: "What word is written in this picture, and what colour is its background? Answer in a few words." }]);
  await nextResult();
} else if (scenario === "toobig") {
  const big = noisePng(1600, 1600);
  console.log(`${sec()}  big PNG: ${(big.length / 1024 / 1024).toFixed(2)} MB, base64 ${(big.toString("base64").length / 1024 / 1024).toFixed(2)} MB`);
  send([imageBlock(big), { type: "text", text: "Describe this picture in five words." }]);
  await nextResult();
  send("Answer with the single word ready.");
  await nextResult();
} else if (scenario === "huge") {
  const big = noisePng(2900, 2900);
  console.log(`${sec()}  huge PNG: ${(big.length / 1024 / 1024).toFixed(2)} MB`);
  send([imageBlock(big), { type: "text", text: "Describe this picture in five words." }]);
  await nextResult(180_000);
  send("Answer with the single word ready.");
  await nextResult();
} else if (scenario === "broken") {
  // A picture the model cannot take: a PNG whose bytes are cut off. Then a plain message, to see whether the session survives it.
  const cut = wordPng("KIWI").subarray(0, 200);
  send([imageBlock(cut), { type: "text", text: "What word is in this picture?" }]);
  await nextResult();
  send("Answer with the single word ready.");
  await nextResult();
} else if (scenario === "wide") {
  const wide = colourPng(9000, 60, [220, 0, 0]);
  console.log(`${sec()}  wide PNG: ${JSON.stringify(pngSize(wide))}, ${wide.length} bytes`);
  send([imageBlock(wide), { type: "text", text: "What colour is this picture? One word." }]);
  await nextResult();
  send("Answer with the single word ready.");
  await nextResult();
} else if (scenario === "many") {
  send([imageBlock(wordPng("KIWI")), imageBlock(wordPng("MANGO", { bg: [255, 255, 255] })), imageBlock(colourPng(200, 120, [0, 160, 0])), { type: "text", text: "Three pictures. For each, in order, say the word in it or its colour. One short line." }]);
  await nextResult();
} else if (scenario === "files") {
  mkdirSync(join(cwd, "attachments", "m1"), { recursive: true });
  writeFileSync(join(cwd, "attachments", "m1", "report.pdf"), textPdf(["Quarterly report", "The code word is lantern."]));
  writeFileSync(join(cwd, "attachments", "m1", "notes.txt"), "Notes from the meeting.\nThe code word is harbour.\n");
  writeFileSync(join(cwd, "attachments", "m1", "screenshot.png"), wordPng("MANGO", { bg: [255, 255, 255] }));
  send(
    "Read the files I attached and tell me the code word in each text file and the word in the picture.\n\n" +
      "Attached files (saved in your folder):\n- attachments/m1/report.pdf (PDF, 1 KB)\n- attachments/m1/notes.txt (text, 1 KB)\n- attachments/m1/screenshot.png (picture, 3 KB)",
  );
  await nextResult(180_000);
  console.log(`${sec()}  approvals asked for: ${asked.length ? asked.join(", ") : "none"}`);
} else {
  console.error(`No scenario ${scenario}`);
}

ended = true;
wakeInput?.();
try {
  q.close();
} catch {}
await Promise.race([consuming, pause(5000)]);
console.log(`${sec()}  done; folder ${cwd}`);
