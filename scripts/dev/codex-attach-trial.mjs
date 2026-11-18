// Trial (groundwork for pictures and files in the chat): does a GPT bot see a picture given to
// `codex app-server` as a "localImage" input item, and can it read attached files by path with the
// sandbox the engine gives the lowest access level ("read-only", approvals "untrusted")?
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/codex-attach-trial.mjs <scenario>
//
// Scenarios:
//   models    which models take pictures (model/list inputModalities)
//   pobotsnote the picture the engine's way: a hidden folder, a name with spaces, Pobots' note
//   picture   one localImage (the word KIWI in black on yellow) and a question, in one turn
//   dataurl   the same picture as an "image" item with a data: URL
//   toobig    a localImage of about 7.7 MB (random pixels), then a plain turn on the same thread
//   broken    a localImage cut off after 200 bytes, then a plain turn on the same thread
//   files     a PDF, a text file and a PNG under attachments/, named by path in the message
//
// LEVEL=write gives each turn the sandbox of "Edits freely" (on-request, workspace-write) instead of "Asks first".
// Real model calls go to gpt-6-luna at low effort unless MODEL says otherwise. Every thread the
// trial makes is deleted at the end, also when it fails.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { noisePng, textPdf, wordPng } from "./attach-fixtures.mjs";

const scenario = process.argv[2] ?? "picture";
const cwd = mkdtempSync(join(tmpdir(), "pobots-codex-attach-"));
const MODEL = process.env.MODEL ?? "gpt-6-luna";
const codexBin = [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((p) => existsSync(p));
const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
let n = 0;
const waits = new Map();
const made = new Set();
const short = (v, max = 300) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…" : s; };
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const req = (method, params) => new Promise((res, rej) => { const id = ++n; waits.set(id, { res, rej, method }); send({ id, method, params }); });
let turnDone;
const approvals = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) {
    const w = waits.get(m.id); waits.delete(m.id);
    if (m.error) w?.rej(new Error(`${w.method}: ${JSON.stringify(m.error)}`)); else w?.res(m.result);
  } else if (m.id !== undefined) {
    approvals.push(m.method);
    console.log("SERVER REQUEST (declined)", m.method, short(m.params?.command ?? m.params?.reason ?? "", 200));
    send({ id: m.id, result: { decision: "decline" } });
  } else {
    const p = m.params ?? {};
    if (m.method === "item/completed" && p.item) {
      const it = p.item;
      if (it.type === "agentMessage") console.log("agent:", short(it.text, 400));
      else if (it.type === "commandExecution") console.log("command:", short(it.command, 200), "exit", it.exitCode, "out:", short(it.aggregatedOutput ?? "", 160));
      else if (it.type === "userMessage") console.log("user item:", short(it.content?.map((c) => (c.type === "text" ? c.text : { ...c, url: c.url ? c.url.slice(0, 30) + "…" : undefined })), 300));
      else if (it.type !== "reasoning") console.log("item:", it.type);
    }
    if (m.method === "error") console.log("error:", short(p, 500));
    if (m.method === "turn/completed") turnDone?.(p);
  }
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(threadId, input, timeoutMs = 180000) {
  const done = new Promise((r) => (turnDone = r));
  const started = Date.now();
  await req("turn/start", { threadId, input, effort: "low", ...(process.env.LEVEL === "write" ? { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true } } : { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: true } }) });
  const end = await Promise.race([done, wait(timeoutMs).then(() => "TIMEOUT")]);
  console.log(`turn end (${Date.now() - started} ms):`, short(end === "TIMEOUT" ? end : { status: end.turn?.status, error: end.turn?.error }, 600));
}
const text = (t) => ({ type: "text", text: t, text_elements: [] });

let exitCode = 0;
try {
  await req("initialize", { clientInfo: { name: "pobots-trial", title: "Pobots trial", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  if (scenario === "models") {
    const r = await req("model/list", {});
    for (const m of r.data ?? []) console.log(m.id, "| hidden", m.hidden, "| input", JSON.stringify(m.inputModalities));
  } else {
    const t = await req("thread/start", { cwd, model: MODEL, approvalPolicy: "untrusted", sandbox: "read-only", serviceName: "pobots-trial", developerInstructions: "You are a test bot in a temporary folder. Keep answers to one short line. Never use connectors or MCP tools." });
    made.add(t.thread.id);
    const id = t.thread.id;
    const pic = join(cwd, "kiwi.png");
    writeFileSync(pic, wordPng("KIWI"));
    if (scenario === "pobotsnote") {
      // The engine's way (engine builder, 13 Nov 2026): the picture in a hidden folder, a name with spaces, Pobots' note after the question.
      // REL overrides where the picture is put, to tell the folder from the name.
      const rel = process.env.REL ?? ".attachments/2026-11/att_trialtrialtrialtrial/Screenshot 2026-11-13 09.00.png";
      mkdirSync(join(cwd, rel, ".."), { recursive: true });
      writeFileSync(join(cwd, rel), wordPng("KIWI"));
      if (process.env.NONOTE === "1") await turn(id, [text("What word is written in this picture, and what colour is its background? Answer in a few words."), { type: "localImage", path: join(cwd, rel) }]);
      else await turn(id, [text(`What word is written in this picture, and what colour is its background? Answer in a few words.\n\nNote from Pobots. Attached (saved in your folder):\n- Screenshot 2026-11-13 09.00.png: ${rel} (a picture, shown to you with this message)`), { type: "localImage", path: join(cwd, rel) }]);
    } else if (scenario === "picture") {
      await turn(id, [text("What word is written in this picture, and what colour is its background? Answer in a few words."), { type: "localImage", path: pic }]);
    } else if (scenario === "dataurl") {
      await turn(id, [text("What word is written in this picture? One word."), { type: "image", url: `data:image/png;base64,${wordPng("KIWI").toString("base64")}` }]);
    } else if (scenario === "mention") {
      // Does a "mention" input item with a file's path put the file before the model?
      writeFileSync(join(cwd, "notes.txt"), "Notes from the meeting.\nThe code word is harbour.\n");
      await turn(id, [text("What is the code word in notes.txt? Do not run any command. One word, or say unknown."), { type: "mention", name: "notes.txt", path: join(cwd, "notes.txt") }]);
    } else if (scenario === "toobig") {
      const big = join(cwd, "noise.png");
      writeFileSync(big, noisePng(1600, 1600));
      await turn(id, [text("Describe this picture in five words."), { type: "localImage", path: big }]);
      await turn(id, [text("Answer with the single word ready.")]);
    } else if (scenario === "broken") {
      const cut = join(cwd, "cut.png");
      writeFileSync(cut, wordPng("KIWI").subarray(0, 200));
      await turn(id, [text("What word is in this picture?"), { type: "localImage", path: cut }]);
      await turn(id, [text("Answer with the single word ready.")]);
    } else if (scenario === "files" || scenario === "fileshint" || scenario === "filescat") {
      mkdirSync(join(cwd, "attachments", "m1"), { recursive: true });
      writeFileSync(join(cwd, "attachments", "m1", "report.pdf"), textPdf(["Quarterly report", "The code word is lantern."]));
      writeFileSync(join(cwd, "attachments", "m1", "notes.txt"), "Notes from the meeting.\nThe code word is harbour.\n");
      writeFileSync(join(cwd, "attachments", "m1", "screenshot.png"), wordPng("MANGO", { bg: [255, 255, 255] }));
      if (scenario === "filescat") copyFileSync(new URL("./pdf-text.js", import.meta.url), join(cwd, "pdf-text.js"));
      await turn(id, [text(
        "Read the files I attached and tell me the code word in each text file and the word in the picture.\n\n" +
          "Attached files (saved in your folder):\n- attachments/m1/report.pdf (PDF, 1 KB)\n- attachments/m1/notes.txt (text, 1 KB)\n- attachments/m1/screenshot.png (picture, 3 KB)" +
          (scenario === "filescat" ? "\n\nRead text files with plain cat, one file per command, without any other command. For the PDF run: osascript -l JavaScript pdf-text.js attachments/m1/report.pdf. Open the picture with your tool for viewing images." : scenario === "fileshint" ? "\n\nYou may read these files: reading is allowed in your folder even when you may not change anything. Open pictures with your tool for viewing images." : ""),
      )], 240000);
      console.log("approvals asked for:", approvals.length ? approvals.join(", ") : "none");
    } else {
      console.log("No scenario", scenario);
    }
  }
} catch (err) {
  console.log("FAILED:", err.message);
  exitCode = 1;
} finally {
  for (const id of made) console.log("delete", id.slice(0, 8), await req("thread/delete", { threadId: id }).then(() => "deleted", (e) => e.message.slice(0, 160)));
  child.kill();
  if (exitCode && stderr.trim()) console.log("stderr tail:", stderr.trim().split("\n").slice(-4).join(" / ").slice(0, 600));
  console.log("folder:", cwd);
  process.exit(exitCode);
}
