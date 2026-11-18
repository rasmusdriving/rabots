// What every section of the app check shares: the arguments and sections, the temporary folders and
// the engine's config, the count of checks, the stand-in push service and the browser's side of a
// push, starting and stopping the engine, the side channel, the Codex threads the check made, the
// browser and the page helpers. Loaded once per run; see ../app-check.mjs for how to run the check.
// Moved out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md), with `export`
// added and the two paths that start from this file one folder deeper.
import { spawn } from "node:child_process";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { killOrphanBrowsers, stopWithParent, sweepOld } from "../temp-cleanup.mjs";
import { guardChild } from "../browser.mjs";

// The protocol number is read from the contract, so this check never falls behind the engine.
export const PROTOCOL_VERSION = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8"))[1]);

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
export const keep = process.argv.includes("--keep");
// --only=files: only the first bot and step 15 (pictures and files), for working on that step;
// --only=backup: only the first bot and step 16 (the backup); --only=push: only step 17 (notifications).
export const only = arg("only");
// The sections, each runnable by itself with --only=<name>. "base" is the first bot and steps 2 to
// 14; every other section is the first bot and its own step. scripts/check-all.mjs runs them side
// by side. A new step gets a name here and a file of its own in sections/ (see ../app-check.mjs).
export const SECTIONS = ["base", "files", "backup", "push", "steer", "titles", "chat7", "fullaccess", "anyfile", "todo", "sees", "workers", "maintools", "botreach", "posts", "helpersrail", "calendar", "aside", "taskmanagers", "helpersees", "gptbotsees", "gptchangesees", "activitylog", "cards-after-restart", "activityday", "railresize", "card-questions", "restored-waiting", "firststart", "gpttitles", "selfupdate"];
if (process.argv.includes("--sections")) {
  console.log(SECTIONS.join("\n"));
  process.exit(0);
}
if (only && !SECTIONS.includes(only)) {
  console.error(`No section "${only}". The sections: ${SECTIONS.join(", ")}`);
  process.exit(2);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Leftovers of checks and tests that crashed or were stopped more than a day ago go first (../temp-cleanup.mjs).
sweepOld();
// Browsers left running by earlier runs that were killed outright, and a stop when check-all is killed (fix 0.26.1).
await killOrphanBrowsers(["pobots-app-check-"]);
stopWithParent();
export const work = mkdtempSync(join(tmpdir(), "pobots-app-check-"));
export const dataDir = join(work, "data");
export const botsDir = join(work, "bots");
export const shots = arg("shots") ?? join(work, "shots");
for (const d of [dataDir, botsDir, shots]) mkdirSync(d, { recursive: true });

// The engine config: use the person's Claude env file when there is one (only its path is written).
// POBOTS_CLAUDE_ENV_FILE names another one; an absent file is simply left out.
export const envFile = process.env.POBOTS_CLAUDE_ENV_FILE || join(homedir(), ".claude", "cliproxy.env");
// The backup folder of this check: its own, under OneDrive's Pobot/test-copy, removed at the end.
export const oneDrivePobot = join(homedir(), "Library", "CloudStorage", "OneDrive-Personal", "Pobot");
export const backupDir = join(oneDrivePobot, "test-copy", `app-check-${new Date().toISOString().replace(/[:.]/g, "-")}`);
export const backupReady = existsSync(oneDrivePobot);
if (backupReady) mkdirSync(backupDir, { recursive: true });
export const keysDir = join(work, "keys");
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claude: existsSync(envFile) ? { envFile } : {}, backup: { folder: backupReady ? backupDir : "" } }));

export const results = [];
export let failed = false;
export const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  const line = `${ok ? "ok  " : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`;
  results.push(line);
  console.log(line);
};

// ------------------------------------------------------------ the push relay (step 17)
// The stand-in push service. The engine sends every push here instead of to the push service, with
// the device's real address in the header X-Push-Address. The relay keeps every request (headers and
// body) and answers 201, or the next status step 17 put in `relay.answers`.
export const relay = { got: [], answers: [] };
export const relayServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    relay.got.push({ at: Date.now(), method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(relay.answers.shift() ?? 201);
    res.end();
  });
});
await new Promise((r) => relayServer.listen(0, "127.0.0.1", r));
export const relayFlag = `--push-relay=http://127.0.0.1:${relayServer.address().port}`;

// The browser's side of a push: opening what the engine locked for a device (RFC 8291 over RFC
// 8188). Copied from engine/tests/push-browser.ts: that file imports "../push.js", which Node's
// type stripping cannot find next to the .ts sources, so it cannot be imported from here.
export const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
export function decryptAes128gcm(body, ikm) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const out = [];
  let pos = 21 + idlen;
  for (let seq = 0; pos < body.length; seq++) {
    const record = body.subarray(pos, Math.min(pos + rs, body.length));
    pos += record.length;
    const iv = Buffer.from(nonce);
    iv.writeUInt32BE((iv.readUInt32BE(8) ^ seq) >>> 0, 8);
    const d = createDecipheriv("aes-128-gcm", cek, iv);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== (pos >= body.length ? 2 : 1)) throw new Error("The padding delimiter is wrong.");
    out.push(plain.subarray(0, end));
  }
  return Buffer.concat(out);
}
export function decryptAsBrowser(body, uaPrivate, authSecret) {
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const uaPublic = ua.getPublicKey();
  const ikm = hmac(hmac(authSecret, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  return decryptAes128gcm(body, ikm);
}

// ------------------------------------------------------------ engine
export let engine;
// What the engine says (stderr), kept so step 13 can read which tier Codex reported (POBOTS_DEBUG=1).
export const engineLog = [];
export async function startEngine() {
  const child = spawn(process.execPath, [join(root, "dist", "engine", "main.mjs"), "--port=0", `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`, relayFlag], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, POBOTS_DEBUG: "1" },
  });
  // Never outlives the check, even one killed outright (fix 0.26.1).
  guardChild(child, `--data-dir=${dataDir}`);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    engineLog.push(d);
    if (process.env.CHECK_VERBOSE) process.stderr.write(d);
  });
  engine = child;
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    try {
      const a = JSON.parse(line).pobotsEngine;
      if (a) return { url: `ws://127.0.0.1:${a.port}/`, token: a.token };
    } catch {}
  }
  throw new Error("The engine stopped before it announced itself.");
}
export const stopEngine = () =>
  new Promise((resolve) => {
    if (!engine || engine.exitCode !== null) return resolve();
    engine.once("exit", resolve);
    engine.kill("SIGTERM");
  });

/** A second, plain connection to the engine, for the few things the test sets up behind the window's back. */
export async function sideChannel(endpoint) {
  const ws = new WebSocket(`${endpoint.url}?token=${endpoint.token}`);
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  let n = 0;
  const waiting = new Map();
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.t === "res" && waiting.has(f.id)) (waiting.get(f.id)(f), waiting.delete(f.id));
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `s${++n}`;
      waiting.set(id, (f) => (f.ok ? resolve(f.result) : reject(new Error(f.error.message))));
      ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  await request("hello", { protocol: PROTOCOL_VERSION, client: "app-check" });
  return { request, close: () => ws.close() };
}

// ------------------------------------------------------------ Codex threads
// A bot on a GPT model keeps its thread in the person's own Codex. The check deletes what it made.
export const codexThreads = new Set();
export function collectCodexThreads() {
  const file = join(dataDir, "pobots.db");
  if (!existsSync(file)) return;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    for (const r of db.prepare("SELECT session_id, session_meta FROM threads WHERE session_id IS NOT NULL").all()) {
      if (String(r.session_meta ?? "").includes('"codex"')) codexThreads.add(String(r.session_id));
    }
    db.close();
  } catch (err) {
    console.log(`(could not read the engine's database for Codex threads: ${err.message})`);
  }
}
/** The Codex threads the check's bots have right now, sorted: unchanged when a turn stayed in its session. */
export function collectCodexThreadIds() {
  collectCodexThreads();
  return [...codexThreads].sort();
}
export async function deleteCodexThreads() {
  collectCodexThreads();
  if (!codexThreads.size) return { deleted: 0, failed: [] };
  const exe = [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((p) => existsSync(p));
  if (!exe) return { deleted: 0, failed: [...codexThreads].map((id) => id.slice(0, 8)) };
  const child = spawn(exe, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const waits = new Map();
  let n = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && m.method === undefined) waits.get(m.id)?.(m);
    } catch {}
  });
  const req = (method, params) =>
    new Promise((res) => {
      const id = ++n;
      waits.set(id, res);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      setTimeout(() => res({ error: { message: "no answer" } }), 20_000).unref();
    });
  await req("initialize", { clientInfo: { name: "pobots-app-check", title: "Pobots app check", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  let deleted = 0;
  const failed = [];
  for (const id of codexThreads) {
    const r = await req("thread/delete", { threadId: id });
    if (r.error) failed.push(`${id.slice(0, 8)}: ${r.error.message}`);
    else deleted++;
  }
  child.kill();
  return { deleted, failed };
}

// ------------------------------------------------------------ browser
export const chromium =
  process.env.CHROMIUM ??
  (() => {
    const cache = join(homedir(), "Library", "Caches", "ms-playwright");
    const dir = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : undefined;
    return dir ? join(cache, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell") : undefined;
  })();
if (!chromium || !existsSync(chromium)) {
  console.error("No headless Chromium found. Set CHROMIUM to a chrome-headless-shell binary.");
  process.exit(2);
}
// Port 0: the browser picks a free port and writes it into its profile folder (a port picked here by
// chance could be the browser of another section running beside this one).
export let debugPort;
export const profile = join(work, "browser");
export const browser = spawn(chromium, ["--headless", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1280,820", "about:blank"], { stdio: "ignore" });
// Never outlives the check, even one killed outright (fix 0.26.1).
guardChild(browser, `--user-data-dir=${profile}`);

export let cdp;
export let nextId = 1;
export const pending = new Map();
export async function connectBrowser() {
  for (let i = 0; i < 80; i++) {
    try {
      debugPort ??= Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || undefined;
      if (!debugPort) throw new Error("no port yet");
      const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page");
      if (page) {
        cdp = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => cdp.once("open", r));
        cdp.on("message", (m) => {
          const msg = JSON.parse(String(m));
          if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
        });
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("The browser did not start.");
}
export const cmd = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params }));
  });
export const js = async (expression) => (await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
export const shot = async (name) => writeFileSync(join(shots, `${name}.png`), Buffer.from((await cmd("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
export const until = async (expression, ms = 90_000, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await js(expression);
    if (v) return v;
    await sleep(every);
  }
  return undefined;
};
export const type = async (text) => {
  await js(`document.querySelector("textarea").focus()`);
  await cmd("Input.insertText", { text });
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
};
export const clickButton = (label) => js(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
export const lastAnswer = `(() => { const all = [...document.querySelectorAll(".pb-msg-body")]; return all.length ? all[all.length - 1].textContent : ""; })()`;
export const headStatus = `document.querySelector(".pb-main-head .pb-status")?.textContent ?? ""`;
export const page = `${pathToFileURL(join(root, "dist", "ui", "index.html")).href}?theme=dark`;
export const openWindow = async (endpoint) => {
  await cmd("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.pobots = { platform: "darwin", engine: async () => (${JSON.stringify(endpoint)}) };`,
  });
  await cmd("Page.navigate", { url: page });
};

// What step 1 (in ../app-check.mjs) makes and every section uses: the engine's address, the side
// channel, the first snapshot and the cheapest model. A field, not a constant, because two sections
// restart the engine and write the new address back here for the sections after them.
export const run = { endpoint: undefined, side: undefined, snap: undefined, cheap: undefined, greeting: "" };
