// Trial (pictures and files in the chat, engine builder): the whole engine path with real models.
// Starts the engine from its sources on temporary folders, creates one bot at "Asks first" on the
// cheapest model of a kind, uploads a picture and files over HTTP the way the page does, sends them
// in a message over the socket, and prints what the bot answers and whether a card was asked.
//
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/attach-engine-trial.mjs claude
//   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" node scripts/dev/attach-engine-trial.mjs gpt
//
//   claude   claude-haiku-5-5: a picture (KIWI), a PDF it must read by path from the hidden
//            .attachments folder, and a Word file whose text comes in the message
//   gptpic   gpt-6-luna: only the picture and the groundwork trial's plain question
//   gpt      gpt-6-luna: a picture (KIWI) as localImage, a PDF and an Excel file whose text comes in
//            the message. The Codex thread the trial made is deleted at the end.
//
// The env file that routes Claude is named, never printed. Nothing is written outside the temporary folders.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { textPdf, wordPng, xlsxFile } from "./attach-fixtures.mjs";

const kind = process.argv[2] === "gpt" || process.argv[2] === "gptpic" ? "gpt" : "claude";
/** gptpic: only the picture, and the plain question of the groundwork trial. */
const onlyPicture = process.argv[2] === "gptpic";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "pobots-attach-engine-data-"));
const botsDir = mkdtempSync(join(tmpdir(), "pobots-attach-engine-bots-"));
const envFile = process.env.POBOTS_CLAUDE_ENV_FILE || join(homedir(), ".claude", "cliproxy.env");
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ browser: { enabled: false }, ...(existsSync(envFile) ? { claude: { envFile } } : {}) }));

const T0 = Date.now();
const sec = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const short = (v, max = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
};

// The engine from its sources, with the same small hook the tests use.
const runner = join(dataDir, "run-engine.mjs");
writeFileSync(
  runner,
  [
    'import { registerHooks } from "node:module";',
    "registerHooks({ resolve(s, c, n) { try { return n(s, c); } catch (e) { if ((s.startsWith('.') || s.startsWith('/')) && s.endsWith('.js')) return n(s.slice(0, -3) + '.ts', c); throw e; } } });",
    `await import(${JSON.stringify(join(root, "engine", "main.ts"))});`,
  ].join("\n"),
);
const engine = spawn(process.execPath, [runner, `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`], { stdio: ["ignore", "pipe", "pipe"], env: process.env, cwd: root });
let stderrTail = [];
createInterface({ input: engine.stderr }).on("line", (l) => {
  stderrTail.push(l);
  stderrTail = stderrTail.slice(-30);
  if (/attachment|upload|error/i.test(l)) console.log(`${sec()}  engine: ${short(l, 240)}`);
});
const announced = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("the engine did not start")), 60_000);
  createInterface({ input: engine.stdout }).on("line", (l) => {
    try {
      const a = JSON.parse(l).pobotsEngine;
      if (a) {
        clearTimeout(t);
        resolve(a);
      }
    } catch {}
  });
});
const { port, token } = announced;
console.log(`${sec()}  engine up on a temporary port`);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
let n = 0;
const waits = new Map();
const events = [];
ws.on("message", (raw) => {
  const f = JSON.parse(String(raw));
  if (f.t === "res") {
    const w = waits.get(f.id);
    waits.delete(f.id);
    if (f.ok) w?.res(f.result);
    else w?.rej(new Error(`${f.error.code}: ${f.error.message}`));
  } else if (f.t === "evt") events.push(f);
});
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = String(++n);
    waits.set(id, { res, rej });
    ws.send(JSON.stringify({ t: "req", id, method, params }));
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const { PROTOCOL_VERSION } = await import(join(root, "shared", "protocol.ts")).catch(() => ({ PROTOCOL_VERSION: 11 }));
await call("hello", { protocol: PROTOCOL_VERSION ?? 11, client: "attach-engine-trial" });
// A GPT bot needs Codex checked first; the engine does it by itself at start.
if (kind === "gpt") {
  for (let i = 0; i < 60; i++) {
    const snap = await call("snapshot", {});
    if (snap.status.codex?.ready) break;
    await pause(1000);
  }
}
const model = kind === "gpt" ? "gpt-6-luna" : "claude-haiku-5-5";
const { bot } = await call("bot.create", { name: "Trial", model, effort: "low", access: "asks-first", ...(kind === "gpt" ? { fast: process.env.FAST === "1" } : {}) });
console.log(`${sec()}  bot ${bot.id} on ${bot.model}, access ${bot.access}`);

async function upload(name, bytes) {
  const r = await fetch(`http://127.0.0.1:${port}/api/attachments?bot=${encodeURIComponent(bot.id)}&name=${encodeURIComponent(name)}&token=${token}`, { method: "POST", body: bytes });
  const body = await r.json();
  if (!r.ok) throw new Error(`upload of ${name}: ${r.status} ${JSON.stringify(body)}`);
  console.log(`${sec()}  uploaded ${name}: ${body.attachment.kind} ${body.attachment.type} ${body.attachment.size} bytes${body.attachment.width ? ` ${body.attachment.width}x${body.attachment.height}` : ""}`);
  return body.attachment;
}

const scratch = mkdtempSync(join(tmpdir(), "pobots-attach-engine-files-"));
const ids = [];
ids.push((await upload("Screenshot 2026-11-13 09.00.png", wordPng("KIWI"))).id);
if (!onlyPicture) ids.push((await upload("report.pdf", textPdf(["Quarterly report", "The code word is lantern."]))).id);
if (onlyPicture) {
  // nothing more
} else if (kind === "claude") {
  writeFileSync(join(scratch, "w.txt"), "Meeting notes.\nThe code word is heron.\n");
  execFileSync("/usr/bin/textutil", ["-convert", "docx", join(scratch, "w.txt"), "-output", join(scratch, "w.docx")]);
  ids.push((await upload("notes.docx", readFileSync(join(scratch, "w.docx")))).id);
} else {
  ids.push((await upload("budget.xlsx", xlsxFile([["Item", "Cost"], ["Coffee", 12.5], ["The code word is walrus", 1]]))).id);
}
const question = onlyPicture
  ? "What word is written in this picture, and what colour is its background? Answer in a few words."
  : kind === "claude"
    ? "Tell me, in one short line each: the word in the picture, the code word in report.pdf (open it with your Read tool), and the code word in notes.docx."
    : "Tell me, in one short line each: the word in the picture and its background colour, the code word in report.pdf, and the code word in budget.xlsx. Do not run any command.";
const { item } = await call("message.send", { botId: bot.id, text: question, attachments: ids });
console.log(`${sec()}  sent; stored paths: ${item.attachments.map((a) => a.path).join(", ")}`);

const until = Date.now() + 240_000;
let state = "";
while (Date.now() < until) {
  const b = events.filter((e) => e.event === "bot.updated" && e.data.bot.id === bot.id).at(-1)?.data.bot;
  if (b && b.state !== state) {
    state = b.state;
    console.log(`${sec()}  state ${b.state}: ${b.activity}`);
  }
  if (b && (b.state === "done" || b.state === "blocked")) break;
  const card = events.find((e) => e.event === "card.added");
  if (card) {
    console.log(`${sec()}  CARD ASKED: ${short(card.data.card.title)} ${short(card.data.card.detail ?? "", 200)}`);
    await call("card.resolve", { cardId: card.data.card.id, decision: { type: "deny" } }).catch(() => undefined);
    events.splice(events.indexOf(card), 1);
  }
  await pause(500);
}
const seen = new Map();
for (const e of events) if (e.event === "item.upsert") seen.set(e.data.item.id, e.data.item);
for (const i of seen.values()) {
  if (i.kind === "bot") console.log(`${sec()}  bot said: ${short(i.text, 600)}`);
  if (i.kind === "activity") console.log(`${sec()}  activity: ${i.label}${i.detail ? ` (${short(i.detail, 120)})` : ""} ${i.status}`);
  if (i.kind === "notice") console.log(`${sec()}  notice: ${i.text}`);
}
const cards = events.filter((e) => e.event === "card.added").length;
console.log(`${sec()}  cards asked: ${cards}`);

// Preview and full over HTTP.
const pic = item.attachments[0];
for (const which of ["preview", "full"]) {
  const r = await fetch(`http://127.0.0.1:${port}/api/attachments/${pic.id}/${which}?token=${token}`);
  console.log(`${sec()}  GET ${which}: ${r.status} ${r.headers.get("content-type")} ${r.headers.get("content-disposition")}`);
}

ws.close();
engine.kill("SIGTERM");
await new Promise((r) => engine.once("exit", r));

if (kind === "gpt") {
  // Delete the Codex thread the trial made.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "pobots.db"));
  const threadIds = db.prepare("SELECT session_id AS s FROM threads WHERE session_id IS NOT NULL").all().map((r) => r.s);
  db.close();
  const codexBin = [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((p) => existsSync(p));
  const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let k = 0;
  const pend = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      }
    } catch {}
  });
  const req = (method, params) =>
    new Promise((res) => {
      const id = ++k;
      pend.set(id, res);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  await req("initialize", { clientInfo: { name: "pobots-trial", version: "0" } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  for (const id of threadIds) {
    const r = await req("thread/delete", { threadId: id });
    console.log(`delete ${String(id).slice(0, 8)}: ${r.error ? short(r.error.message, 160) : "deleted"}`);
  }
  child.kill();
}
console.log(`folders: ${dataDir} ${botsDir}`);
process.exit(0);
