// The bots' browser, checked against the real one (docs/build/step-2g.md, A7). No model.
//
// Runs the engine's own code in this process on temporary folders, with the real `ego-browser`, its
// HTTP server and socket, and talks to it like the app does. A page served here on 127.0.0.1 has
// something that ticks, fields of every kind at fixed places, and reports its own state back to this
// server, so the check reads the page without attaching anything more to the workspace.
//
//   1. A bot-like command makes a workspace and opens the page: the row, the bot's workspace in the state.
//   2. Watching: the first picture at once, pictures that change, their size.
//   3. In control: a click, typed text with Swedish letters, a paste, a wheel, each editing shortcut
//      from Ctrl and from the command key, Enter, Tab, Shift+Tab, Escape, Backspace, Delete, arrows,
//      Home, End, Page Up, Page Down, a textarea, a contenteditable, a select, a checkbox, a link, a
//      dialog, browser.go there and back, browser.selection.
//   4. A slow receiver: what waits for it and the engine's memory while the page ticks fast.
//   5. A bot-like script (clicks, typing, a navigation, a popup, a download, its own page.events())
//      alone and while watched: what differs.
//   6. browser.own opens https://example.com, is watched, and is closed again.
//   Round two (docs/build/step-2g-fixes.md): a drop-down list's choices come as browser.prompt and
//   browser.answer chooses (the page hears input and change), also in a frame of the same origin, and
//   what a frame of another origin does; a page's question (confirm, prompt) as browser.prompt,
//   answered both ways; the address of the pictures after browser.go and after a link, also in a new
//   page of the person's own; the pictures' size at up to 1600 by 1200.
//   Round three (docs/build/step-2g-tabs.md): a workspace with three pages (a still page full of small
//   text that records everything that could touch it, a page of pictures, the ticking page);
//   browser.page.show without control (the browser's front page stays) and with control (it comes to
//   the front, and whether the Mac's front app changed); browser.page.open and browser.page.close in
//   the person's own workspace and refused in a bot's; pictures at two ratios with their real sizes;
//   the sharp picture once the page stands still (PNG, or WebP when large), sizes and times; and the
//   proof that taking pictures at another scale leaves the page alone.
//   7. Everything this check made is closed; the list is printed (ids and ownership only).
//
// Rules (the brief's): only pages served here and https://example.com; only workspaces named
// "pobots test ..."; never workspace 0 or another's; every workspace made here is closed, also when
// a check fails. Skips with one line when ego-browser is not installed.
//
//   node engine/tests/browser-check.mjs
//   BROWSER_CHECK_ONLY=round3 node engine/tests/browser-check.mjs   (only round three's parts)
import { registerHooks } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.POBOTS_LOG ??= "warn";
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

const { findEgoBrowser, realDriver } = await import("../browser.ts");
const { Engine } = await import("../engine.ts");
const { Store } = await import("../store.ts");
const { EngineServer } = await import("../server.ts");
const { PROTOCOL_VERSION } = await import("../../shared/protocol.ts");
const { default: WebSocket } = await import("ws");

const exe = findEgoBrowser();
if (!exe) {
  console.log("browser: skipped, ego-browser is not installed on this computer");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const lines = [];
function ok(name, note = "") {
  const l = `ok    browser: ${name}${note ? `  (${note})` : ""}`;
  lines.push(l);
  console.log(l);
}
function bad(name, why) {
  failed++;
  const l = `FAIL  browser: ${name}: ${why}`;
  lines.push(l);
  console.log(l);
}
function known(name, why) {
  const l = `known browser: ${name}: ${why}`;
  lines.push(l);
  console.log(l);
}
const ONLY = process.env.BROWSER_CHECK_ONLY;
async function check(name, fn) {
  if (ONLY === "round3" && !name.startsWith("round three")) return;
  try {
    const note = await fn();
    ok(name, typeof note === "string" ? note : "");
  } catch (err) {
    bad(name, err instanceof Error ? err.message : String(err));
  }
}
function assert(cond, why) {
  if (!cond) throw new Error(why);
}
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

// ------------------------------------------------------------ the page, served here

let report = null;
let reports = 0;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pobots check page</title>
<style>
body{margin:0;font:16px sans-serif;height:3000px}
#tick{position:absolute;left:20px;top:8px;font-size:30px}
#inp{position:absolute;left:20px;top:60px;width:300px;height:28px;font-size:16px}
#ta{position:absolute;left:20px;top:110px;width:300px;height:60px}
#ce{position:absolute;left:20px;top:190px;width:300px;height:30px;border:1px solid #888}
#sel{position:absolute;left:20px;top:240px;width:150px}
#cb{position:absolute;left:20px;top:280px;width:20px;height:20px;margin:0}
#lnk{position:absolute;left:20px;top:320px;font-size:20px}
#list{position:absolute;left:400px;top:60px;width:200px;height:150px;overflow:auto;border:1px solid #888}
#conf{position:absolute;left:20px;top:360px;width:120px;height:30px}
#pop{position:absolute;left:160px;top:360px;width:120px;height:30px}
#dl{position:absolute;left:300px;top:360px;width:120px;height:30px}
#prm{position:absolute;left:440px;top:360px;width:120px;height:30px}
#sel2{position:absolute;left:200px;top:240px;width:150px}
#fr{position:absolute;left:640px;top:60px;width:220px;height:60px;border:0}
#xfr{position:absolute;left:640px;top:140px;width:220px;height:60px;border:0}
</style></head><body>
<div id="tick">0</div>
<input id="inp" autocomplete="off"><textarea id="ta"></textarea><div id="ce" contenteditable="true"></div>
<select id="sel"><option>one</option><option>two</option><option>three</option></select>
<select id="sel2"><option>a</option><optgroup label="More"><option>b</option><option disabled>c</option></optgroup></select>
<iframe id="fr" src="/frame"></iframe><iframe id="xfr" src="__XFRAME__"></iframe>
<input type="checkbox" id="cb"><a id="lnk" href="/second">second page</a>
<div id="list">${Array.from({ length: 60 }, (_, i) => `<div>row ${i}</div>`).join("")}</div>
<button id="conf" onclick="window.__conf = confirm('Sure?'); report()">confirm</button>
<button id="pop" onclick="window.open('/second', '_blank')">popup</button>
<button id="dl" onclick="location.href='/file.txt'">download</button>
<button id="prm" onclick="window.__prm = prompt('Your name?', 'Kim'); report()">prompt</button>
<script>
var n = 0, fast = location.search.indexOf("fast") >= 0, noise = location.search.indexOf("noise") >= 0;
setInterval(function () { document.getElementById("tick").textContent = String(++n); }, fast ? 30 : 100);
if (noise) {
  // A page whose every picture is large: noise all over, new every 30 ms.
  var cv = document.createElement("canvas"); cv.width = innerWidth; cv.height = innerHeight;
  cv.style.cssText = "position:fixed;left:0;top:0;pointer-events:none"; document.body.appendChild(cv);
  var cx = cv.getContext("2d"), img = cx.createImageData(cv.width, cv.height);
  setInterval(function () { var d = img.data; for (var i = 0; i < d.length; i += 4) { d[i] = Math.random() * 255; d[i + 1] = Math.random() * 255; d[i + 2] = Math.random() * 255; d[i + 3] = 255; } cx.putImageData(img, 0, 0); }, 30);
}
var keys = [], clicks = [], wheel = 0, t = null, heard = [];
["input", "change"].forEach(function (k) { ["sel", "sel2"].forEach(function (id) { document.getElementById(id).addEventListener(k, function () { heard.push(id + " " + k); }); }); });
function state() {
  var i = document.getElementById("inp");
  return { url: location.pathname, inp: i.value, selStart: i.selectionStart, selEnd: i.selectionEnd, ta: document.getElementById("ta").value,
    ce: document.getElementById("ce").textContent, sel: document.getElementById("sel").value, cb: document.getElementById("cb").checked,
    list: document.getElementById("list").scrollTop, scrollY: window.scrollY, focus: document.activeElement ? document.activeElement.id : "",
    keys: keys.slice(-80), clicks: clicks.slice(-20), wheel: wheel, conf: window.__conf === undefined ? null : window.__conf,
    sel2: document.getElementById("sel2").value, heard: heard.slice(-20), prm: window.__prm === undefined ? null : window.__prm };
}
function report() { clearTimeout(t); t = setTimeout(function () { fetch("/report", { method: "POST", body: JSON.stringify(state()) }); }, 20); }
document.addEventListener("keydown", function (e) { keys.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }); report(); }, true);
document.addEventListener("click", function (e) { clicks.push({ id: e.target.id, x: e.clientX, y: e.clientY, detail: e.detail }); report(); }, true);
document.addEventListener("wheel", function (e) { wheel += e.deltaY; report(); }, { capture: true, passive: true });
["input", "change", "scroll", "selectionchange", "focusin"].forEach(function (k) { document.addEventListener(k, report, true); });
setInterval(report, 400);
report();
</script></body></html>`;
const SECOND = `<!doctype html><html><head><meta charset="utf-8"><title>Second page</title></head><body><p id="p">second</p>
<script>function report(){ fetch("/report", { method: "POST", body: JSON.stringify({ url: location.pathname }) }); } report(); setInterval(report, 400);</script></body></html>`;

// Round three: a still page of small text that records everything that could touch it when a
// picture is taken (a resize, the pixel ratio, a resolution query, layout, frames), and a page of
// pictures. Both report to this server, so nothing more is attached to the workspace.
let probe = null;
const RECORDER = `<script>
var log = [], L = function (e, d) { log.push({ t: Math.round(performance.now()), e: e, d: d }); };
addEventListener("resize", function () { L("resize", [innerWidth, innerHeight, devicePixelRatio]); });
[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].forEach(function (r) { var m = matchMedia("(resolution: " + r + "dppx)"); m.addEventListener("change", function () { L("resolution", [r, m.matches]); }); });
var roSeen = 0; new ResizeObserver(function () { if (roSeen++) L("layout", [document.documentElement.clientWidth, document.documentElement.clientHeight]); }).observe(document.documentElement);
if (window.visualViewport) visualViewport.addEventListener("resize", function () { L("viewport", [visualViewport.width, visualViewport.scale]); });
document.addEventListener("visibilitychange", function () { L("visibility", document.visibilityState); });
try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (x) { L("shift", x.value); }); }).observe({ type: "layout-shift" }); } catch (e) {}
var dpr = devicePixelRatio, w = innerWidth, frames = 0, gaps = 0, last = performance.now();
(function loop() { requestAnimationFrame(function (t) { frames++; if (t - last > 1500) gaps++; last = t; if (devicePixelRatio !== dpr) { L("dpr", [dpr, devicePixelRatio]); dpr = devicePixelRatio; } if (innerWidth !== w) { L("width", [w, innerWidth]); w = innerWidth; } loop(); }); })();
setInterval(function () { fetch("/probe-report", { method: "POST", body: JSON.stringify({ path: location.pathname, dpr: devicePixelRatio, w: innerWidth, h: innerHeight, frames: frames, log: log }) }); }, 300);
</script>`;
const LOREM = "Pobots shows the browser the bots use beside the chat. Small text must look like text, not like a smudge. ";
const TEXT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Text page</title>${RECORDER}</head>
<body style="font-family:-apple-system,Helvetica,sans-serif;margin:24px;color:#222;background:#fff"><h1 style="font-size:28px">A page with a lot of text</h1>
${[10, 11, 12, 13, 14, 16].map((s) => `<p style="font-size:${s}px;line-height:1.4">${s}px: ${LOREM.repeat(4)}</p>`).join("")}
<table style="font-size:12px;border-collapse:collapse">${Array.from({ length: 14 }, (_, i) => `<tr>${Array.from({ length: 8 }, (_, j) => `<td style="border:1px solid #bbb;padding:2px 6px">Cell ${i + 1}.${j + 1}</td>`).join("")}</tr>`).join("")}</table></body></html>`;
const PICS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Picture page</title></head>
<body style="margin:16px;font-family:-apple-system,Helvetica,sans-serif;background:#f4f4f4"><h2>Pictures</h2><div id="g" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px"></div>
<script>
var g = document.getElementById("g"), seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
for (var k = 0; k < 12; k++) {
  var c = document.createElement("canvas"); c.width = 320; c.height = 220; c.style.width = "100%";
  var x = c.getContext("2d"), gr = x.createLinearGradient(0, 0, 320, 220);
  gr.addColorStop(0, "hsl(" + (k * 30) + ",70%,55%)"); gr.addColorStop(1, "hsl(" + (k * 30 + 90) + ",60%,30%)"); x.fillStyle = gr; x.fillRect(0, 0, 320, 220);
  var d = x.getImageData(0, 0, 320, 220); for (var i = 0; i < d.data.length; i += 4) { var v = (rnd() - 0.5) * 40; d.data[i] += v; d.data[i + 1] += v; d.data[i + 2] += v; } x.putImageData(d, 0, 0);
  for (var j = 0; j < 30; j++) { x.beginPath(); x.arc(rnd() * 320, rnd() * 220, rnd() * 30, 0, 7); x.fillStyle = "rgba(255,255,255," + rnd() * 0.4 + ")"; x.fill(); }
  var cap = document.createElement("div"); cap.style.fontSize = "12px"; cap.textContent = "Picture " + (k + 1) + ", a caption in small text";
  var box = document.createElement("div"); box.appendChild(c); box.appendChild(cap); g.appendChild(box);
}
</script></body></html>`;

let frameReport = null;
const FRAME = (main) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><select id="fs" style="position:absolute;left:10px;top:10px;width:150px"><option>red</option><option>green</option><option>blue</option></select>
<script>document.getElementById("fs").addEventListener("change", function () { fetch("${main}/frame-report", { method: "POST", mode: "no-cors", body: JSON.stringify({ fs: this.value, port: location.port }) }); });</script></body></html>`;
function servePage(req, res) {
  if (req.method === "POST" && req.url === "/frame-report") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        frameReport = JSON.parse(body);
      } catch {
        // ignore
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.url === "/frame") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(FRAME(`http://127.0.0.1:${PAGE_PORT}`));
  }
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        report = JSON.parse(body);
        reports++;
      } catch {
        // ignore
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.method === "POST" && req.url === "/probe-report") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        probe = JSON.parse(body);
      } catch {
        // ignore
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.url === "/text") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(TEXT_PAGE);
  }
  if (req.url === "/pics") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PICS_PAGE);
  }
  if (req.url === "/second") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(SECOND);
  }
  if (req.url === "/file.txt") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=pobots-check.txt" });
    return res.end("hello");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE.replace("__XFRAME__", `http://127.0.0.1:${OTHER_PORT}/frame`));
}
const pageServer = createServer(servePage);
// A second address on 127.0.0.1 (another port: another origin) for a frame the page cannot reach into.
const otherServer = createServer(servePage);
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
await new Promise((r) => otherServer.listen(0, "127.0.0.1", r));
const PAGE_PORT = pageServer.address().port;
const OTHER_PORT = otherServer.address().port;
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

// ------------------------------------------------------------ scripts the check runs itself (as a bot would)

const BOT_SPACE = "pobots test check bot";
const tmp = mkdtempSync(join(tmpdir(), "pobots-browser-check-"));

function runScript(script, ms = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(exe, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(script);
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

/** The last JSON line a script printed. */
function lastJson(out) {
  for (const l of out.split("\n").reverse()) {
    try {
      return JSON.parse(l);
    } catch {
      // not JSON
    }
  }
  return null;
}

/** Closes every workspace this check made ("pobots test ..."), and returns the list (ids, ownership, ours). */
async function closeOurs() {
  const out = await runScript(`
const out = [];
for (const s of await listTaskSpaces()) {
  if (typeof s.name !== "string" || !s.name.startsWith("pobots test")) continue;
  try {
    const t = s.ownership === "agent" ? await taskSpace(s.id) : s.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(s.id) : null;
    if (t) await t.finish({ keep: [] });
  } catch (e) {}
}
console.log(JSON.stringify((await listTaskSpaces()).map((s) => ({ id: s.id, ownership: s.ownership, ours: typeof s.name === "string" && s.name.startsWith("pobots test") }))));
`);
  return lastJson(out) ?? [];
}

// ------------------------------------------------------------ the engine, in this process, with the real browser

const dataDir = join(tmp, "data");
const botsDir = join(tmp, "bots");
mkdirSync(dataDir, { recursive: true });
mkdirSync(botsDir, { recursive: true });
const store = new Store(join(dataDir, "pobots.db"));
// The person's own workspace gets a name under this check's rules.
store.setValue("browser.ownName", `pobots test your page ${Math.random().toString(16).slice(2, 8)}`);
let server;
const engine = new Engine({
  config: { port: 0, dataDir, botsDir, machineName: "Check Mac", claude: {}, serve: false, remote: { allowedLogins: [] }, browser: { enabled: true } },
  store,
  claude: { ready: true, executable: "/nonexistent/claude", version: "0", env: {} },
  emit: (event, data) => server?.broadcast(event, data),
  createSession: () => {
    throw new Error("no harness in this check");
  },
  browser: realDriver({ enabled: true, executable: exe }),
});
engine.init();
const TOKEN = "browser-check-token-0123456789";
server = new EngineServer(TOKEN, {});
server.attach(engine);
const port = await server.listen(0);

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  const events = [];
  const pending = new Map();
  let n = 0;
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.t === "evt") events.push(f);
    else pending.get(f.id)?.(f);
  });
  const raw = (method, params = {}) =>
    new Promise((res) => {
      const id = String(++n);
      pending.set(id, res);
      ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  const req = async (method, params = {}) => {
    const f = await raw(method, params);
    if (!f.ok) throw new Error(`${method}: ${f.error.code}: ${f.error.message}`);
    return f.result;
  };
  const opened = new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  return { ws, events, raw, req, opened };
}

const frames = (c, watchId) => c.events.filter((e) => e.event === "browser.frame" && (!watchId || e.data.watchId === watchId)).map((e) => e.data);

function jpegSize(b64) {
  const b = Buffer.from(b64, "base64");
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** A picture's own size, whatever its type (JPEG, PNG, WebP). */
function pictureSize(f) {
  const b = Buffer.from(f.data, "base64");
  if (f.type === "image/png") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (f.type === "image/webp") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  return jpegSize(f.data);
}
const kbOf = (f) => Math.round((f.data.length * 0.75) / 1024);
/** Which app is in front on this Mac, only to tell whether it changed (never printed). */
function frontApp() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { timeout: 3000 }).toString().trim();
    return execFileSync("lsappinfo", ["info", "-only", "name", asn], { timeout: 3000 }).toString().trim();
  } catch {
    return "";
  }
}

// Key helpers: events as the app sends them.
const down = (key, code, text, mods = 0) => ({ type: "key", down: true, key, code, ...(text ? { text } : {}), mods });
const up = (key, code, mods = 0) => ({ type: "key", down: false, key, code, mods });
const press = (key, code, mods = 0, text) => [down(key, code, text, mods), up(key, code, mods)];
const codeOf = (ch) => (/[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch === " " ? "Space" : /[0-9]/.test(ch) ? `Digit${ch}` : ch === "å" ? "BracketLeft" : ch === "ä" ? "Quote" : ch === "ö" ? "Semicolon" : "Unidentified");
const typed = (s) => [...s].flatMap((ch) => press(ch, codeOf(ch.toLowerCase()), 0, ch));
const click = (x, y, clicks = 1) => [
  { type: "move", x, y },
  { type: "down", x, y, button: "left", clicks },
  { type: "up", x, y, button: "left", clicks },
];

let c;
let bot;
let botSpaceId;
let watchId;
try {
  const before = await closeOurs();
  if (before.some((s) => s.ours)) console.log("browser: closed workspaces left by an earlier check");

  c = client();
  await c.opened;
  await c.req("hello", { protocol: PROTOCOL_VERSION, client: "browser-check" });
  bot = engine.createBot("Check Bot");

  await check("a bot's command makes a workspace: the row arrives with the bot's id, the state lists the workspace as the bot's, busy while it runs", async () => {
    const script = `const task = await taskSpace(${JSON.stringify(BOT_SPACE)});\nawait task.page("p1").goto(${JSON.stringify(PAGE_URL)});\nconsole.log(JSON.stringify({ space: task.spaceId }));`;
    const command = `ego-browser nodejs <<'EOF'\n${script}\nEOF`;
    engine.browser.commandStart({ key: "cmd-1", botId: bot.id, threadId: bot.mainThreadId, turnKey: "turn-1", command, botDir: join(botsDir, bot.id) });
    const out = await runScript(script);
    const made = lastJson(out);
    assert(made && made.space, `the script said: ${out.slice(0, 200)}`);
    botSpaceId = String(made.space);
    const busy = await until(() => c.events.some((e) => e.event === "browser.changed" && e.data.state.spaces.some((s) => s.id === botSpaceId && s.busy && s.owner === "bot" && s.botId === bot.id)), 10_000, "the workspace as the bot's and busy");
    engine.browser.commandEnd("cmd-1");
    const item = await until(() => c.events.map((e) => e.event === "item.upsert" && e.data.item.kind === "browser" && e.data.item.spaceId === botSpaceId && e.data.item).filter(Boolean).at(-1), 10_000, "the row");
    assert(item.botId === bot.id && item.name === BOT_SPACE && item.status === "open", JSON.stringify(item));
    const last = await until(() => c.events.map((e) => e.event === "item.upsert" && e.data.item.kind === "browser" && e.data.item.last).filter((l) => l && l.startsWith("Pobots check page · 127.0.0.1:")).at(-1), 15_000, "the row's line with the page's title and host");
    await until(() => c.events.some((e) => e.event === "browser.changed" && e.data.state.spaces.some((s) => s.id === botSpaceId && !s.busy)), 10_000, "not busy");
    return `workspace ${botSpaceId}, line "${last}", busy seen ${!!busy}`;
  });

  let watch;
  await check("watching: the first picture at once, pictures that change as the page ticks, the page's own size, at most 1600 by 1200", async () => {
    const t0 = Date.now();
    watch = await c.req("browser.watch", { spaceId: botSpaceId });
    watchId = watch.watchId;
    const first = await until(() => frames(c, watchId)[0], 5000, "the first picture");
    const firstMs = Date.now() - t0;
    await sleep(2000);
    const fs = frames(c, watchId);
    const distinct = new Set(fs.map((f) => f.data)).size;
    assert(distinct >= 5, `${distinct} different pictures in 2 s`);
    const size = jpegSize(first.data);
    assert(size && size.w <= 1600 && size.h <= 1200, `picture ${JSON.stringify(size)}`);
    if (first.width <= 1600 && first.height <= 1200) assert(size.w === first.width && size.h === first.height, `a page within the limit is sent at its own size: picture ${size.w}x${size.h}, page ${first.width}x${first.height}`);
    assert(first.width === watch.width && first.height === watch.height && first.width > 0, `page ${first.width}x${first.height}, watch said ${watch.width}x${watch.height}`);
    assert(first.url === PAGE_URL && first.title === "Pobots check page", `${first.url} ${first.title}`);
    const kb = Math.round(fs.reduce((n, f) => n + f.data.length, 0) / fs.length / 1024 * 0.75);
    const kbMax = Math.round(Math.max(...fs.map((f) => f.data.length)) / 1024 * 0.75);
    assert(kbMax < 150, `pictures up to ${kbMax} KB`);
    return `first after ${firstMs} ms; ${fs.length} pictures in about 2 s (${distinct} different), page ${first.width}x${first.height}, picture ${size.w}x${size.h}, about ${kb} KB each, at most ${kbMax} KB`;
  });

  const input = (events) => c.req("browser.input", { watchId, events });
  await check("without control, input and moves are refused", async () => {
    const f = await c.raw("browser.input", { watchId, events: click(30, 70) });
    assert(!f.ok && f.error.code === "conflict", JSON.stringify(f));
    const g = await c.raw("browser.go", { watchId, to: "reload" });
    assert(!g.ok && g.error.code === "conflict", JSON.stringify(g));
    await c.req("browser.control", { watchId, take: true });
    await until(() => c.events.some((e) => e.event === "browser.changed" && e.data.state.spaces.some((s) => s.id === botSpaceId && s.controlled)), 5000, "controlled in the state");
  });

  const settle = async (pred, what) => {
    await until(() => report && pred(report), 5000, what);
    return report;
  };

  await check("a click and typed text with Swedish letters reach an input; a paste is text at once", async () => {
    await input(click(150, 74));
    await settle((r) => r.focus === "inp", "the input to have the focus");
    await input(typed("Hej åäö "));
    await input([{ type: "text", text: "ÅÄÖ klistrat" }]);
    const r = await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat", "the typed text");
    return `"${r.inp}"`;
  });

  const shortcuts = async (mods, label) => {
    await input([...press("a", "KeyA", mods)]);
    await settle((r) => r.selStart === 0 && r.selEnd === r.inp.length && r.inp.length > 0, `${label}A to select all`);
    const sel = await c.req("browser.selection", { watchId });
    assert(sel.text === report.inp, `selection "${sel.text}"`);
    await input([...press("c", "KeyC", mods)]);
    await input([...press("x", "KeyX", mods)]);
    await settle((r) => r.inp === "", `${label}X to cut`);
    const cut = await c.req("browser.selection", { watchId });
    assert(cut.text === "Hej åäö ÅÄÖ klistrat", `after the cut the selection gave "${cut.text}"`);
    await input([...press("z", "KeyZ", mods)]);
    await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat", `${label}Z to undo`);
    await input([...press("z", "KeyZ", mods | 8)]);
    await settle((r) => r.inp === "", `${label}Shift+Z to redo`);
    await input([...press("z", "KeyZ", mods)]);
    await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat", `${label}Z again`);
    await input([...press("y", "KeyY", mods)]);
    await settle((r) => r.inp === "", `${label}Y to redo`);
    await input([...press("z", "KeyZ", mods)]);
    await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat", "undo once more");
    // Ctrl+V: the key reaches the page, the app pastes the laptop's clipboard as text. (Undo leaves the text selected.)
    await input([...press("End", "End"), ...press("v", "KeyV", mods), { type: "text", text: "!" }]);
    await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat!", "the paste");
    const k = report.keys.filter((x) => ["a", "c", "x", "z", "y", "v"].includes(x.key));
    assert(k.length >= 9 && k.every((x) => x.meta), `the page saw the shortcuts with the command key: ${JSON.stringify(k.slice(-3))}`);
  };
  await check("the editing shortcuts from Ctrl: select all, copy, cut, undo, redo (Shift+Z and Y), paste", async () => shortcuts(2, "Ctrl+"));
  await check("the same from the command key", async () => {
    await input([...press("Backspace", "Backspace")]);
    await settle((r) => r.inp === "Hej åäö ÅÄÖ klistrat", "the ! gone");
    await shortcuts(4, "Cmd+");
  });

  await check("Home, End, arrows, Backspace, Delete, Ctrl+arrows, Shift+Home in an input", async () => {
    await input([...press("a", "KeyA", 2), ...press("Backspace", "Backspace")]);
    await input(typed("abc def"));
    await settle((r) => r.inp === "abc def", "abc def");
    await input(press("Home", "Home"));
    await settle((r) => r.selStart === 0 && r.selEnd === 0, "Home");
    await input(press("End", "End"));
    await settle((r) => r.selStart === 7, "End");
    await input(press("ArrowLeft", "ArrowLeft"));
    await settle((r) => r.selStart === 6, "ArrowLeft");
    await input(press("Backspace", "Backspace"));
    await settle((r) => r.inp === "abc df", "Backspace");
    await input(press("Delete", "Delete"));
    await settle((r) => r.inp === "abc d", "Delete");
    await input(press("ArrowLeft", "ArrowLeft", 2));
    await settle((r) => r.selStart === 4, "Ctrl+ArrowLeft to the word start");
    await input(press("Home", "Home", 8));
    await settle((r) => r.selStart === 0 && r.selEnd === 4, "Shift+Home selects");
    await input(press("ArrowRight", "ArrowRight"));
    await input(press("Backspace", "Backspace", 2));
    await settle((r) => r.inp === "d" || r.inp === " d", "Ctrl+Backspace deletes a word");
    return `"${report.inp}"`;
  });

  await check("Enter, Tab and Shift+Tab, Escape reach the page; a textarea and a contenteditable take text", async () => {
    await input(press("Enter", "Enter"));
    await settle((r) => r.keys.some((k) => k.key === "Enter"), "Enter");
    await input(press("Tab", "Tab"));
    await settle((r) => r.focus === "ta", "Tab to the textarea");
    await input([...typed("rad ett"), ...press("Enter", "Enter"), ...typed("två")]);
    await settle((r) => r.ta === "rad ett\ntvå", "two lines in the textarea");
    await input(press("Tab", "Tab", 8));
    await settle((r) => r.focus === "inp", "Shift+Tab back");
    await input(press("Escape", "Escape"));
    await settle((r) => r.keys.some((k) => k.key === "Escape"), "Escape");
    await input(click(100, 205));
    await settle((r) => r.focus === "ce", "the contenteditable");
    await input(typed("redigerbar åäö"));
    await settle((r) => r.ce === "redigerbar åäö", "text in the contenteditable");
  });

  const prompts = (watch) => c.events.filter((e) => e.event === "browser.prompt" && e.data.watchId === watch).map((e) => e.data);
  await check("a select (by keyboard), a checkbox, a double click selects a word", async () => {
    // A press on the list opens its choices in the app (round two); closed without a choice, the list keeps the focus for typing.
    const n0 = prompts(watchId).length;
    await input(click(90, 248));
    await until(() => prompts(watchId).length > n0 && prompts(watchId).at(-1).prompt?.kind === "choices", 3000, "the choices");
    await c.req("browser.answer", { watchId, answer: { kind: "choices" } });
    await input(typed("t"));
    await settle((r) => r.sel === "two" || r.sel === "three", "the select");
    await input(click(30, 290));
    await settle((r) => r.cb === true, "the checkbox");
    await input(click(150, 74));
    await input([...press("a", "KeyA", 2), ...typed("ord två")]);
    await settle((r) => r.inp === "ord två", "words");
    await input(click(30, 74, 1));
    await input([{ type: "down", x: 30, y: 74, button: "left", clicks: 2 }, { type: "up", x: 30, y: 74, button: "left", clicks: 2 }]);
    const sel = await settle((r) => r.selEnd - r.selStart === 3, "a double click to select the word");
    return `select "${report.sel}", word ${sel.selStart}..${sel.selEnd}`;
  });

  // ---------------- round two: drop-down lists
  await check("a drop-down list: a press shows its choices as browser.prompt (not on the Mac's screen), browser.answer chooses, the page hears input and change", async () => {
    const before = report.heard.length;
    const n0 = prompts(watchId).length;
    await input(click(90, 248));
    const got = await until(() => prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "choices"), 3000, "the choices");
    const ch = got.prompt;
    assert(JSON.stringify(ch.options.map((o) => o.label)) === JSON.stringify(["one", "two", "three"]), JSON.stringify(ch));
    assert(Math.abs(ch.x - 20) <= 2 && Math.abs(ch.y - 240) <= 2 && Math.abs(ch.width - 150) <= 2 && ch.height > 10 && ch.height < 40, `box ${JSON.stringify([ch.x, ch.y, ch.width, ch.height])}`);
    const selected = ch.options.findIndex((o) => o.selected);
    await c.req("browser.answer", { watchId, answer: { kind: "choices", index: 2 } });
    const r = await settle((x) => x.sel === "three", "the list's new value");
    const heard = r.heard.slice(before);
    assert(heard.includes("sel input") && heard.includes("sel change"), `the page heard ${JSON.stringify(heard)}`);
    await until(() => prompts(watchId).at(-1).prompt === undefined, 2000, "a browser.prompt with no prompt");
    return `options one, two, three (selected ${selected}); box ${ch.x},${ch.y} ${ch.width}x${ch.height}; the page heard ${heard.join(", ")}`;
  });
  await check("the keyboard: Down on the list with the focus shows the choices; an answer without an index just closes them", async () => {
    const n0 = prompts(watchId).length;
    await input(press("ArrowDown", "ArrowDown"));
    await until(() => prompts(watchId).slice(n0).some((p) => p.prompt?.kind === "choices"), 3000, "the choices by keyboard");
    await c.req("browser.answer", { watchId, answer: { kind: "choices" } });
    await until(() => prompts(watchId).at(-1).prompt === undefined, 2000, "closed");
    await sleep(300);
    assert(report.sel === "three", `the value changed to ${report.sel}`);
    const nothing = await c.raw("browser.answer", { watchId, answer: { kind: "choices", index: 0 } });
    assert(!nothing.ok && nothing.error.code === "conflict", JSON.stringify(nothing));
  });
  await check("group headings and disabled options come with the choices; a disabled option is not chosen", async () => {
    const n0 = prompts(watchId).length;
    await input(click(270, 248));
    const got = await until(() => prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "choices"), 3000, "the choices");
    const o = got.prompt.options;
    assert(JSON.stringify(o) === JSON.stringify([{ label: "a", selected: true, disabled: false }, { label: "b", selected: false, disabled: false, group: "More" }, { label: "c", selected: false, disabled: true, group: "More" }]), JSON.stringify(o));
    await c.req("browser.answer", { watchId, answer: { kind: "choices", index: 2 } });
    await sleep(400);
    assert(report.sel2 === "a", `chose a disabled option: ${report.sel2}`);
  });
  await check("a list in a frame of the same origin: its choices, placed in the page's pixels, and the choice reaches the frame", async () => {
    const n0 = prompts(watchId).length;
    frameReport = null;
    await input(click(720, 80));
    const got = await until(() => prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "choices"), 3000, "the frame's choices");
    const ch = got.prompt;
    assert(Math.abs(ch.x - 650) <= 3 && Math.abs(ch.y - 70) <= 3, `box ${JSON.stringify([ch.x, ch.y, ch.width, ch.height])}`);
    await c.req("browser.answer", { watchId, answer: { kind: "choices", index: 1 } });
    await until(() => frameReport && frameReport.fs === "green", 3000, "the frame's list changed");
    return `box ${ch.x},${ch.y}`;
  });
  await check("a list in a frame of another origin (another port on 127.0.0.1): what happens", async () => {
    const n0 = prompts(watchId).length;
    frameReport = null;
    await input(click(720, 160));
    await sleep(1500);
    const got = prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "choices");
    // Whatever the press opened there is closed again, as a person would.
    await input(press("Escape", "Escape"));
    await sleep(300);
    if (got) return "its choices came too";
    known("a drop-down list in a frame of another origin", "no choices: the page cannot look into that frame, so the press reaches it as before (its open list is drawn outside the page, where the picture cannot show it); Escape closed it");
    return "no choices (known)";
  });

  await check("a wheel scrolls the list, Page Down and Page Up scroll the page", async () => {
    await input([{ type: "move", x: 500, y: 130 }, { type: "wheel", x: 500, y: 130, dx: 0, dy: 300 }]);
    await settle((r) => r.list > 0, "the list to scroll");
    await input(click(700, 600));
    await input(press("PageDown", "PageDown"));
    await settle((r) => r.scrollY > 0, "Page Down");
    await input(press("PageUp", "PageUp"));
    await settle((r) => r.scrollY === 0, "Page Up");
    return `list ${report.list}px`;
  });

  await check("a page's dialog: browser.prompt to the watcher (never in a picture's title), pictures pause, Enter accepts it, pictures come back", async () => {
    const n0 = prompts(watchId).length;
    const f0 = frames(c, watchId).length;
    await input(click(80, 375));
    const got = await until(() => prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "dialog"), 4000, "the question");
    assert(JSON.stringify(got.prompt) === JSON.stringify({ kind: "dialog", type: "confirm", message: "Sure?" }), JSON.stringify(got));
    await sleep(800);
    const n = frames(c, watchId).length;
    await sleep(800);
    const paused = frames(c, watchId).length - n;
    assert(!frames(c, watchId).slice(f0).some((f) => /Sure|asks|says/.test(f.title)), "the question is in a picture's title");
    await input(press("Enter", "Enter"));
    await settle((r) => r.conf === true, "the dialog accepted");
    await until(() => prompts(watchId).at(-1).prompt === undefined, 3000, "the question gone");
    const m = frames(c, watchId).length;
    await until(() => frames(c, watchId).length > m, 5000, "pictures again");
    return `${paused} picture(s) while the dialog was open`;
  });
  await check("a page's dialog answered with browser.answer: a confirm dismissed, a prompt accepted with text", async () => {
    let n0 = prompts(watchId).length;
    await input(click(80, 375));
    await until(() => prompts(watchId).slice(n0).some((p) => p.prompt?.kind === "dialog"), 4000, "the confirm");
    await c.req("browser.answer", { watchId, answer: { kind: "dialog", accept: false } });
    await settle((r) => r.conf === false, "the confirm dismissed");
    await until(() => prompts(watchId).at(-1).prompt === undefined, 3000, "gone");
    n0 = prompts(watchId).length;
    await input(click(500, 375));
    const got = await until(() => prompts(watchId).slice(n0).find((p) => p.prompt?.kind === "dialog"), 4000, "the prompt");
    assert(JSON.stringify(got.prompt) === JSON.stringify({ kind: "dialog", type: "prompt", message: "Your name?", defaultText: "Kim" }), JSON.stringify(got));
    await c.req("browser.answer", { watchId, answer: { kind: "dialog", accept: true, text: "Åsa Ödman" } });
    await settle((r) => r.prm === "Åsa Ödman", "the prompt answered with the text");
    await until(() => prompts(watchId).at(-1).prompt === undefined, 3000, "gone");
    const nothing = await c.raw("browser.answer", { watchId, answer: { kind: "dialog", accept: true } });
    assert(!nothing.ok && nothing.error.code === "conflict", JSON.stringify(nothing));
  });

  /** How long after the page got there the pictures said its address. */
  const addressFollows = async (url, what) => {
    const t0 = Date.now();
    await until(() => frames(c, watchId).at(-1)?.url === url, 2500, `${what}: the pictures' address ${url}`);
    return Date.now() - t0;
  };
  await check("a link, then browser.go back, an address there and back again, reload; the pictures' address follows every move", async () => {
    const ms = [];
    await input(click(60, 330));
    await settle((r) => r.url === "/second", "the link");
    ms.push(await addressFollows(`${PAGE_URL}second`, "after the link"));
    await c.req("browser.go", { watchId, to: "back" });
    await settle((r) => r.url === "/", "back");
    ms.push(await addressFollows(PAGE_URL, "after back"));
    await c.req("browser.go", { watchId, to: "forward" });
    await settle((r) => r.url === "/second", "forward");
    ms.push(await addressFollows(`${PAGE_URL}second`, "after forward"));
    await c.req("browser.go", { watchId, to: { url: PAGE_URL } });
    await settle((r) => r.url === "/", "the page by address");
    ms.push(await addressFollows(PAGE_URL, "after browser.go"));
    const bad = await c.raw("browser.go", { watchId, to: { url: "file:///etc/hosts" } });
    assert(!bad.ok && bad.error.code === "bad_request", JSON.stringify(bad));
    await c.req("browser.go", { watchId, to: "reload" });
    const fs = frames(c, watchId);
    return `last picture ${fs.at(-1).url}; the address followed after ${ms.join(", ")} ms`;
  });

  await check("a slow receiver: at most one picture waits for it, memory stays flat (a page of noise, new every 30 ms; receiver paused 6 s)", async () => {
    await c.req("browser.go", { watchId, to: { url: `${PAGE_URL}?noise` } });
    await sleep(1500);
    const sizes = frames(c, watchId).slice(-5).map((f) => f.data.length);
    const big = Math.round(Math.max(...sizes) * 0.75 / 1024);
    const sock = c.ws._socket;
    sock.pause();
    const samples = [];
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const b = server.pictureBacklog();
      samples.push({ waiting: Math.max(0, ...b.map((x) => x.waiting)), rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed });
    }
    const dropped = Math.max(0, ...server.pictureBacklog().map((x) => x.dropped));
    sock.resume();
    const maxWaiting = Math.max(...samples.map((s) => s.waiting));
    const heap0 = samples.slice(0, 10).reduce((n, s) => n + s.heap, 0) / 10;
    const heap1 = samples.slice(-10).reduce((n, s) => n + s.heap, 0) / 10;
    const rss0 = samples.slice(0, 10).reduce((n, s) => n + s.rss, 0) / 10;
    const rss1 = samples.slice(-10).reduce((n, s) => n + s.rss, 0) / 10;
    assert(maxWaiting < 2_000_000, `backlog up to ${maxWaiting} bytes`);
    assert(heap1 - heap0 < 50 * 1024 * 1024, `heap grew ${Math.round((heap1 - heap0) / 1048576)} MB`);
    await c.req("browser.go", { watchId, to: { url: PAGE_URL } });
    assert(dropped > 0, "no picture was dropped, so the receiver was never slow enough to measure");
    return `pictures up to ${big} KB; backlog in this process at most ${Math.round(maxWaiting / 1024)} KB, ${dropped} older pictures dropped, heap ${Math.round((heap1 - heap0) / 1048576)} MB, rss ${Math.round((rss1 - rss0) / 1048576)} MB over 6 s`;
  });

  if (watchId) await c.req("browser.control", { watchId, take: false });

  // A bot-like script, alone and while watched (A3).
  const botLike = (name) => `
const task = await taskSpace(${JSON.stringify(name)});
const page = task.page("p1");
const r = {};
try {
  await page.goto(${JSON.stringify(PAGE_URL)});
  // Time for the person to start watching before the bot acts.
  await new Promise((x) => setTimeout(x, 6000));
  await page.events();
  await page.click("#inp");
  await page.keyboard.type("hej åäö");
  await page.fill("#ta", "text area");
  r.inp = await page.evaluate(() => document.getElementById("inp").value);
  r.ta = await page.evaluate(() => document.getElementById("ta").value);
  try {
    const dp = page.waitForEvent("download", { timeout: 10000 });
    await page.click("#dl");
    const dl = await dp;
    r.download = dl.suggestedFilename();
    await dl.saveAs(${JSON.stringify(join(tmp, "dl-"))} + Date.now() + ".txt");
  } catch (e) { r.downloadErr = String(e.message).slice(0, 120); }
  try {
    const rc = await page.click("#pop");
    r.receiptPopups = rc && rc.popups ? rc.popups.length : -1;
    if (rc && rc.popups && rc.popups[0]) { const pg = task.page(rc.popups[0].label); await pg.waitForLoadState(); r.receiptUrl = new URL(await pg.url()).pathname; await pg.close(); }
  } catch (e) { r.receiptErr = String(e.message).slice(0, 120); }
  try {
    const pp = page.waitForEvent("popup", { timeout: 8000 });
    await page.click("#pop");
    const popup = await pp;
    await popup.waitForLoadState();
    r.popup = new URL(await popup.url()).pathname;
    await popup.close();
  } catch (e) { r.popupErr = String(e.message).slice(0, 120); }
  await page.goto(${JSON.stringify(PAGE_URL + "second")});
  r.second = await page.title();
  await page.goto(${JSON.stringify(PAGE_URL)});
  r.events = [...new Set((await page.events()).map((e) => e.method))].filter((m) => /^Page\\.(frameNavigated|loadEventFired|domContentEventFired)$/.test(m)).sort();
} catch (e) { r.err = String(e.message).slice(0, 300); }
// Any page left over from a popup that was missed.
try { for (const t of await task.tabs()) if (t.label && t.label !== "p1") await task.page(t.label).close(); } catch (e) {}
console.log(JSON.stringify(r));
`;
  let alone;
  let watched;
  await check("a bot-like script alone (clicks, typing, fill, a download wait, a popup from the click's receipt and from waitForEvent, a navigation, its own page.events())", async () => {
    alone = lastJson(await runScript(botLike(`${BOT_SPACE} alone`), 90_000));
    assert(alone && !alone.err, JSON.stringify(alone));
    assert(alone.inp === "hej åäö" && alone.ta === "text area" && alone.download === "pobots-check.txt" && alone.receiptUrl === "/second" && alone.popup === "/second" && alone.second === "Second page", JSON.stringify(alone));
    return JSON.stringify(alone);
  });
  await check("the same bot-like script while the person watches its workspace: the same, except the one wait found in the notes", async () => {
    const name = `${BOT_SPACE} watched`;
    const run = runScript(botLike(name), 90_000);
    const w2 = client();
    await w2.opened;
    await w2.req("hello", { protocol: PROTOCOL_VERSION, client: "browser-check-watcher" });
    // The bot's command is followed like a real one, so the workspace is the bot's and can be watched.
    engine.browser.commandStart({ key: "cmd-2", botId: bot.id, threadId: bot.mainThreadId, turnKey: "turn-2", command: `ego-browser nodejs <<'EOF'\nawait taskSpace(${JSON.stringify(name)})\nEOF`, botDir: join(botsDir, bot.id) });
    const sid = await until(async () => (await w2.req("browser.state")).spaces.find((s) => s.name === name)?.id, 15_000, "the workspace");
    const wr = await w2.req("browser.watch", { spaceId: sid });
    await until(() => frames(w2, wr.watchId).length > 0, 5000, "a picture of the bot's work");
    watched = lastJson(await run);
    engine.browser.commandEnd("cmd-2");
    const n = frames(w2, wr.watchId).length;
    await w2.req("browser.unwatch", { watchId: wr.watchId });
    w2.ws.close();
    assert(watched && !watched.err, JSON.stringify(watched));
    const same = ["inp", "ta", "download", "receiptPopups", "receiptUrl", "second"].filter((k) => JSON.stringify(alone[k]) !== JSON.stringify(watched[k]));
    assert(same.length === 0, `differs in ${same.join(", ")}: alone ${JSON.stringify(alone)}, watched ${JSON.stringify(watched)}`);
    assert(JSON.stringify(alone.events) === JSON.stringify(watched.events), `the bot's own page.events() differ: ${JSON.stringify(alone.events)} / ${JSON.stringify(watched.events)}`);
    if (watched.popup !== alone.popup) known("while watched, page.waitForEvent(\"popup\") missed the popup", watched.popupErr ?? "no popup");
    return `${n} pictures of the bot's work; waitForEvent("popup") ${watched.popup === "/second" ? "worked" : "missed (known)"}`;
  });

  await check("your own page made new (no address yet): the pictures' address follows browser.go and a link", async () => {
    const { space } = await c.req("browser.own", {});
    const w = await c.req("browser.watch", { spaceId: space.id });
    const first = await until(() => frames(c, w.watchId)[0], 5000, "a picture of the new page");
    await c.req("browser.control", { watchId: w.watchId, take: true });
    await c.req("browser.go", { watchId: w.watchId, to: { url: PAGE_URL } });
    let t0 = Date.now();
    await until(() => frames(c, w.watchId).at(-1)?.url === PAGE_URL, 4000, "the address after browser.go");
    const a = Date.now() - t0;
    await sleep(800);
    await c.req("browser.input", { watchId: w.watchId, events: click(60, 330) });
    t0 = Date.now();
    await until(() => frames(c, w.watchId).at(-1)?.url === `${PAGE_URL}second`, 4000, "the address after a link");
    const b2 = Date.now() - t0;
    await c.req("browser.close", { spaceId: space.id });
    return `new page "${first.url}"; address after browser.go in ${a} ms, after a link in ${b2} ms`;
  });

  await check("browser.own opens https://example.com in the person's own workspace, watched, then closed again", async () => {
    const { space } = await c.req("browser.own", { url: "https://example.com" });
    assert(space.owner === "you" && space.name === "Your page", JSON.stringify(space));
    const w = await c.req("browser.watch", { spaceId: space.id });
    const f = await until(() => frames(c, w.watchId).find((x) => x.url.startsWith("https://example.com")), 15_000, "a picture of example.com");
    await c.req("browser.close", { spaceId: space.id });
    await until(() => c.events.some((e) => e.event === "browser.ended" && e.data.watchId === w.watchId && e.data.reason === "closed"), 5000, "the watch ended");
    const st = await c.req("browser.state");
    assert(!st.spaces.some((s) => s.id === space.id), "still listed");
    return `"${f.title}"`;
  });

  // ---------------------------------------------------------------- round three: pages, and a sharper picture
  const TABS_SPACE = "pobots test check tabs";
  let tabsSpaceId;
  let tabPages = [];
  const c2 = client();
  await c2.opened;
  await c2.req("hello", { protocol: PROTOCOL_VERSION, client: "browser-check-tabs" });
  const spaceIn = (cl, id) => cl.events.filter((e) => e.event === "browser.changed").map((e) => e.data.state.spaces.find((s) => s.id === id)).filter(Boolean).at(-1);
  await check("round three: a bot's workspace with three pages (still text, pictures, the ticking page) is listed with real ids in the browser's order", async () => {
    const script = `const task = await taskSpace(${JSON.stringify(TABS_SPACE)});
await task.page("p1").goto(${JSON.stringify(PAGE_URL + "text")}, { waitUntil: "load" });
const p2 = await task.newPage(); await p2.goto(${JSON.stringify(PAGE_URL + "pics")}, { waitUntil: "load" });
const p3 = await task.newPage(); await p3.goto(${JSON.stringify(PAGE_URL)}, { waitUntil: "load" });
await task.cdp("Target.activateTarget", { targetId: (await task.tabs()).find((t) => t.label === "p1").targetId });
console.log(JSON.stringify({ space: task.spaceId, tabs: (await task.tabs()).map((t) => ({ id: t.targetId, label: t.label, active: t.active })) }));`;
    engine.browser.commandStart({ key: "cmd-tabs", botId: bot.id, threadId: bot.mainThreadId, turnKey: "turn-tabs", command: `ego-browser nodejs <<'EOF'\n${script}\nEOF`, botDir: join(botsDir, bot.id) });
    const made = lastJson(await runScript(script));
    assert(made && made.space && made.tabs.length === 3, JSON.stringify(made));
    engine.browser.commandEnd("cmd-tabs");
    tabsSpaceId = String(made.space);
    const sp = await until(() => { const s = spaceIn(c2, tabsSpaceId); return s && s.pages.length === 3 && !s.pages[0].id.startsWith("recent-") && s; }, 15_000, "three pages with real ids");
    tabPages = sp.pages.map((p) => p.id);
    assert(JSON.stringify(tabPages) === JSON.stringify(made.tabs.map((t) => t.id)), `order ${JSON.stringify(sp.pages.map((p) => p.title))}`);
    assert(sp.pages[0].active && sp.pages.map((p) => p.title).join("|") === "Text page|Picture page|Pobots check page", JSON.stringify(sp.pages));
    return sp.pages.map((p) => `${p.title}${p.active ? " (front)" : ""}`).join(", ");
  });

  // What the text page heard before any picture of it was taken (the bot's script opening pages).
  const probeBase = (await until(() => probe && probe.path === "/text" && probe, 5000, "the text page's first report").catch(() => ({ log: [] }))).log.length;
  let tw;
  const tf = () => frames(c2, tw.watchId);
  const sharpAfter = (n) => tf().slice(n).find((f) => f.type === "image/png" || f.type === "image/webp");
  await check("round three: pictures at ratio 0.5: light JPEG and the sharp picture both at half the page's size", async () => {
    const t0 = Date.now();
    tw = await c2.req("browser.watch", { spaceId: tabsSpaceId, ratio: 0.5 });
    const light = await until(() => tf().find((f) => !f.type), 5000, "a light picture");
    const sharp = await until(() => sharpAfter(0), 5000, "the sharp picture");
    const ls = pictureSize(light);
    const ss = pictureSize(sharp);
    assert(Math.abs(ls.w - Math.round(light.width * 0.5)) <= 1 && Math.abs(ss.w - Math.round(sharp.width * 0.5)) <= 1, `page ${light.width}x${light.height}, light ${JSON.stringify(ls)}, sharp ${JSON.stringify(ss)}`);
    return `page ${light.width}x${light.height}; light JPEG ${ls.w}x${ls.h} ${kbOf(light)} KB; sharp ${sharp.type} ${ss.w}x${ss.h} ${kbOf(sharp)} KB, ${Date.now() - t0} ms after the watch`;
  });

  await check("round three: browser.view to ratio 1.5 on the still text page: a sharp PNG at 1.5 times the page's size, the light ones never above its own size", async () => {
    const n = tf().length;
    const t0 = Date.now();
    await c2.req("browser.view", { watchId: tw.watchId, ratio: 1.5 });
    const sharp = await until(() => tf().slice(n).find((f) => (f.type === "image/png" || f.type === "image/webp") && pictureSize(f).w > f.width), 6000, "a sharp picture at 1.5");
    const ms = Date.now() - t0;
    const ss = pictureSize(sharp);
    const lights = tf().slice(n).filter((f) => !f.type).map((f) => pictureSize(f).w);
    assert(Math.abs(ss.w - Math.round(sharp.width * 1.5)) <= 1 && Math.abs(ss.h - Math.round(sharp.height * 1.5)) <= 1, `sharp ${JSON.stringify(ss)} for page ${sharp.width}x${sharp.height}`);
    assert(lights.every((w) => w <= sharp.width), `light pictures ${lights.join(",")}`);
    assert(sharp.type === "image/png", `a text page is sharpest as PNG: ${sharp.type}`);
    await sleep(1500);
    const later = tf().slice(n).length;
    await sleep(1500);
    assert(tf().slice(n).length === later, "a still page: nothing more after the sharp picture");
    return `sharp ${sharp.type} ${ss.w}x${ss.h}, ${kbOf(sharp)} KB, ${ms} ms after browser.view; light ${lights.length ? lights.join(", ") + " wide" : "none"}`;
  });

  await check("round three: ratio 2 is the largest; taking pictures at 0.5, 1.5 and 2 left the page alone (no resize, pixel ratio, resolution query, layout, visibility)", async () => {
    const n = tf().length;
    await c2.req("browser.view", { watchId: tw.watchId, ratio: 3 });
    const sharp = await until(() => tf().slice(n).find((f) => f.type && pictureSize(f).w >= f.width * 1.9), 6000, "a sharp picture at 2");
    const ss = pictureSize(sharp);
    assert(Math.abs(ss.w - sharp.width * 2) <= 1, `at most 2: ${ss.w} for ${sharp.width}`);
    await sleep(700);
    const p = await until(() => probe && probe.path === "/text" && probe, 3000, "the text page's own report");
    const heard = p.log.slice(probeBase);
    assert(heard.length === 0, `the page heard: ${JSON.stringify(heard.slice(0, 8))}`);
    return `page's devicePixelRatio ${p.dpr}, ${p.w}x${p.h}; nothing heard while pictures were taken at 0.5, 1 (light), 1.5 and 2 (${p.log.length} things heard before, while the bot's script opened the other pages: ${[...new Set(p.log.map((x) => x.e))].join(", ") || "none"}); sharp at 2: ${sharp.type} ${ss.w}x${ss.h}, ${kbOf(sharp)} KB`;
  });

  await check("round three: browser.page.show without control: the picture page is shown; it comes to the front in the browser (any look at a page does), control is not taken", async () => {
    await c2.req("browser.view", { watchId: tw.watchId, ratio: 1 });
    const n = tf().length;
    const t0 = Date.now();
    const r = await c2.req("browser.page.show", { watchId: tw.watchId, pageId: tabPages[1] });
    assert(r.pageId === tabPages[1] && r.width > 0, JSON.stringify(r));
    const first = await until(() => tf().slice(n).find((f) => f.pageId === tabPages[1]), 6000, "a picture of the picture page");
    const firstMs = Date.now() - t0;
    const sharp = await until(() => tf().slice(n).find((f) => f.pageId === tabPages[1] && f.type), 8000, "its sharp picture");
    const sharpMs = Date.now() - t0;
    await sleep(800);
    const sp = spaceIn(c2, tabsSpaceId);
    assert(sp.pages.find((p) => p.active)?.id === tabPages[1] && !sp.controlled, `front now ${sp.pages.find((p) => p.active)?.title}, controlled ${sp.controlled}`);
    return `first picture ${firstMs} ms (light JPEG ${kbOf(first)} KB), sharp ${sharp.type} ${pictureSize(sharp).w}x${pictureSize(sharp).h} ${kbOf(sharp)} KB after ${sharpMs} ms; front in the browser: "${sp.pages.find((p) => p.active).title}"`;
  });

  await check("round three: the bot goes back to its page (a bot-like script reads it three times, 300 ms apart): the watch follows within a moment and never pulls the page behind to the front again", async () => {
    const n = tf().length;
    const t0 = Date.now();
    const ev0 = c2.events.length;
    const out = await runScript(`const task = await taskSpace(${JSON.stringify(TABS_SPACE)}); const p = task.page("p1"); let t = ""; for (let i = 0; i < 3; i++) { t = await p.evaluate(() => document.title); await new Promise((r) => setTimeout(r, 300)); } console.log(JSON.stringify({ t, front: (await task.tabs()).find((x) => x.active).label }));`);
    const story = () => c2.events.slice(ev0).map((e) => e.event === "browser.frame" ? `frame ${tabPages.indexOf(e.data.pageId) + 1}` : e.event === "browser.changed" ? `front ${1 + tabPages.indexOf(e.data.state.spaces.find((x) => x.id === tabsSpaceId)?.pages.find((p) => p.active)?.id)}` : e.event).filter((x, i, a) => x !== a[i - 1]).join(", ");
    await until(() => tf().slice(n).some((f) => f.pageId === tabPages[0]), 6000, "pictures of the bot's page").catch((e) => {
      throw new Error(`${e.message}; the bot's script said ${out.split("\n").pop()}; then: ${story()}`);
    });
    const followMs = Date.now() - t0;
    const m = tf().length;
    await sleep(2500);
    const sp = spaceIn(c2, tabsSpaceId);
    const back = tf().slice(m).filter((f) => f.pageId !== tabPages[0]).length;
    assert(back === 0 && sp.pages.find((p) => p.active)?.id === tabPages[0], `${back} pictures of another page; front "${sp.pages.find((p) => p.active)?.title}"`);
    return `followed after ${followMs} ms (the bot-like script itself took part of that); the bot's page stayed in front for 2.5 s`;
  });

  await check("round three: the picture page shown again (for its sharp picture at 1.5)", async () => {
    await c2.req("browser.page.show", { watchId: tw.watchId, pageId: tabPages[1] });
    await until(() => tf().at(-1)?.pageId === tabPages[1], 6000, "the picture page");
  });

  await check("round three: the picture page at ratio 1.5: the sharp picture is WebP (a PNG would be large), with its size and time", async () => {
    const n = tf().length;
    const t0 = Date.now();
    await c2.req("browser.view", { watchId: tw.watchId, ratio: 1.5 });
    const sharp = await until(() => tf().slice(n).find((f) => f.type && pictureSize(f).w > f.width), 8000, "a sharp picture at 1.5");
    assert(sharp.type === "image/webp", `type ${sharp.type}, ${kbOf(sharp)} KB`);
    return `${sharp.type} ${pictureSize(sharp).w}x${pictureSize(sharp).h}, ${kbOf(sharp)} KB, ${Date.now() - t0} ms`;
  });

  await check("round three: a moving page keeps light pictures: the ticking page at ratio 1.5 sends JPEGs at its own size, about as many as before", async () => {
    const r = await c2.req("browser.page.show", { watchId: tw.watchId, pageId: tabPages[2] });
    await sleep(500);
    const n = tf().length;
    await sleep(2000);
    const fs = tf().slice(n).filter((f) => f.pageId === tabPages[2]);
    assert(fs.length >= 3 && fs.every((f) => !f.type), `${fs.length} pictures, types ${[...new Set(fs.map((f) => f.type ?? "jpeg"))]}`);
    const ws = [...new Set(fs.map((f) => pictureSize(f).w))];
    assert(ws.every((w) => w <= r.width), `widths ${ws}`);
    return `${fs.length} pictures in 2 s, ${ws.join("/")} wide, about ${Math.round(fs.reduce((a, f) => a + kbOf(f), 0) / fs.length)} KB each`;
  });

  await check("round three: browser.page.show with control: the page comes to the front in the browser; the Mac's front app does not change; control is kept", async () => {
    await c2.req("browser.control", { watchId: tw.watchId, take: true });
    const before = frontApp();
    await c2.req("browser.page.show", { watchId: tw.watchId, pageId: tabPages[0] });
    const sp = await until(() => { const s = spaceIn(c2, tabsSpaceId); return s && s.pages.find((p) => p.active)?.id === tabPages[0] && s; }, 5000, "the text page in front");
    await sleep(500);
    const after = frontApp();
    assert(before === after, "the Mac's front app changed");
    assert(sp.controlled, "control kept");
    const n = tf().length;
    await sleep(800);
    assert(tf().slice(n).every((f) => f.pageId === tabPages[0]), "pictures of the text page");
    return `front in the browser: "${sp.pages.find((p) => p.active).title}"; the Mac's front app ${before ? "unchanged" : "not readable"}`;
  });

  await check("round three: browser.page.open and browser.page.close are refused in a bot's workspace, also with control", async () => {
    const o = await c2.raw("browser.page.open", { watchId: tw.watchId, url: PAGE_URL + "second" });
    assert(!o.ok && o.error.code === "conflict", JSON.stringify(o));
    const x = await c2.raw("browser.page.close", { watchId: tw.watchId, pageId: tabPages[1] });
    assert(!x.ok && x.error.code === "conflict", JSON.stringify(x));
    await sleep(600);
    assert(spaceIn(c2, tabsSpaceId).pages.length === 3, "still three pages");
    await c2.req("browser.control", { watchId: tw.watchId, take: false });
  });

  await check("round three: your own page: browser.page.open (needs control) opens a page in front and shows it; browser.page.close closes it; never the last", async () => {
    const { space } = await c2.req("browser.own", { url: PAGE_URL + "second" });
    const ow = await c2.req("browser.watch", { spaceId: space.id });
    const nope = await c2.raw("browser.page.open", { watchId: ow.watchId });
    assert(!nope.ok && nope.error.code === "conflict", `without control: ${JSON.stringify(nope)}`);
    await c2.req("browser.control", { watchId: ow.watchId, take: true });
    const opened = await c2.req("browser.page.open", { watchId: ow.watchId, url: PAGE_URL + "text" });
    const st = await until(() => { const s = spaceIn(c2, space.id); return s && s.pages.length === 2 && s.pages.find((p) => p.active)?.id === opened.pageId && s; }, 8000, "two pages, the new one in front");
    await until(() => frames(c2, ow.watchId).some((f) => f.pageId === opened.pageId && f.url === PAGE_URL + "text"), 8000, "pictures of the new page");
    const last = st.pages.find((p) => p.id !== opened.pageId).id;
    await c2.req("browser.page.close", { watchId: ow.watchId, pageId: opened.pageId });
    await until(() => spaceIn(c2, space.id)?.pages.length === 1, 8000, "one page again");
    await until(() => frames(c2, ow.watchId).at(-1)?.pageId === last, 8000, "the watch goes on with the page left");
    const end = c2.events.some((e) => e.event === "browser.ended" && e.data.watchId === ow.watchId);
    assert(!end, "the watch did not end");
    const lastOne = await c2.raw("browser.page.close", { watchId: ow.watchId, pageId: last });
    assert(!lastOne.ok && lastOne.error.code === "conflict", JSON.stringify(lastOne));
    await c2.req("browser.close", { spaceId: space.id });
    return `opened ${opened.pageId.slice(0, 8)}..., closed it, the last page refused: "${lastOne.error.message}"`;
  });
  c2.ws.close();

  await check("the bot's workspace closes (as the bot would): the row turns closed", async () => {
    await c.req("browser.unwatch", { watchId }).catch(() => undefined);
    await runScript(`const t = await taskSpace(${JSON.stringify(BOT_SPACE)}); await t.finish({ keep: [] });`);
    const item = await until(() => c.events.map((e) => e.event === "item.upsert" && e.data.item.kind === "browser" && e.data.item.spaceId === botSpaceId && e.data.item.status === "closed" && e.data.item).filter(Boolean).at(-1), 20_000, "the row closed");
    return `ended ${item.endedAt}`;
  });
} catch (err) {
  bad("check run", err instanceof Error ? err.message : String(err));
} finally {
  try {
    c?.ws.close();
  } catch {
    // gone
  }
  engine.shutdown();
  await server.close();
  store.close();
  const after = await closeOurs();
  const left = after.filter((s) => s.ours);
  if (left.length) bad("nothing of this check is left in the browser", `${left.length} workspace(s) left: ${left.map((s) => s.id).join(", ")}`);
  else ok("nothing of this check is left in the browser", `the list now: ${after.map((s) => `${s.id} ${s.ownership}`).join(", ")}`);
  pageServer.close();
  otherServer.close();
  pageServer.closeAllConnections?.();
  otherServer.closeAllConnections?.();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`browser: ${lines.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed, ${lines.filter((l) => l.startsWith("known")).length} known`);
process.exit(failed ? 1 : 0);
