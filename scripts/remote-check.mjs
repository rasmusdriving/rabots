// End-to-end check of serve mode: the page the engine serves, opened the way a browser on another
// device on the tailnet would open it.
//
// Starts the built engine in serve mode on temporary folders, with one allowed test login. In
// front of it runs a tiny HTTPS proxy that does what `tailscale serve` does: it keeps the Host,
// removes any Tailscale identity headers the caller sent, and adds `Tailscale-User-Login` for the
// "device" (or none). Headless Chromium opens https://pobots-check.test:<proxy>/ (mapped to
// 127.0.0.1, with a throwaway certificate) and uses the page like a person: first run, create a
// bot, send a message, get an answer on the cheapest model, reload and see the chat still there,
// at three window widths. Then the refusals: a login not on the list, no identity at all, the
// engine's own address without a token, and another web page trying to open the socket with the
// person's identity.
//
// It makes one or two small model calls on the cheapest model. Nothing touches the real data.
//
// Run: npm run build && node scripts/remote-check.mjs [--keep] [--shots=DIR]
//   --keep       keep the temporary folders (their path is printed)
//   --shots=DIR  where pictures go (default: a folder in the temporary folder)
//   CHROMIUM=/path/to/chrome-headless-shell overrides the browser
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { launch } from "./browser.mjs";
import { keepOnly, onStop, sweepOld } from "./temp-cleanup.mjs";

// The protocol number is read from the contract, so this check never falls behind the engine.
const PROTOCOL_VERSION = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL("../shared/protocol.ts", import.meta.url), "utf8"))[1]);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const keep = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGIN = "pobots-check@example.com";
const STRANGER = "stranger@example.org";
const HOST = "pobots-check.test";
const OTHER_HOST = "other-site.test";
const WORDS = {
  notAllowed: "This device is not allowed to open Pobots. Open it from a device on your Tailscale network.",
  notOnList: "Your Tailscale account is not allowed to open Pobots on this computer.",
};

// Leftovers of checks and tests that crashed or were stopped more than a day ago go first (temp-cleanup.mjs).
sweepOld();
const work = mkdtempSync(join(tmpdir(), "pobots-remote-check-"));
const dataDir = join(work, "data");
const botsDir = join(work, "bots");
const tls = join(work, "tls");
const shots = arg("shots") ?? join(work, "shots");
for (const d of [dataDir, botsDir, tls, shots]) mkdirSync(d, { recursive: true });

// The engine config: the person's Claude env file when there is one (only its path is written),
// and the one test login that may open Pobots from "another device".
const envFile = process.env.POBOTS_CLAUDE_ENV_FILE || join(homedir(), ".claude", "cliproxy.env");
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claude: existsSync(envFile) ? { envFile } : {}, remote: { allowedLogins: [LOGIN] } }));

const results = [];
let failed = false;
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  const line = `${ok ? "ok  " : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`;
  results.push(line);
  console.log(line);
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createHttpServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ------------------------------------------------------------ engine
const enginePort = await freePort();
const engineLog = join(work, "engine.log");
const engineArgs = [join(root, "dist", "engine", "main.mjs"), "--serve", `--port=${enginePort}`, `--data-dir=${dataDir}`, `--bots-dir=${botsDir}`];
let engine;

async function startEngine() {
  const log = createWriteStream(engineLog, { flags: "a" });
  const child = spawn(process.execPath, engineArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  if (process.env.CHECK_VERBOSE) child.stderr.pipe(process.stderr);
  engine = child;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`The engine stopped with code ${child.exitCode}.`);
    try {
      const lock = JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8"));
      if (lock.pid === child.pid && lock.port === enginePort) return lock;
    } catch {}
    await sleep(100);
  }
  throw new Error("The engine did not start.");
}
const stopEngine = () =>
  new Promise((resolve) => {
    if (!engine || engine.exitCode !== null) return resolve();
    engine.once("exit", resolve);
    engine.kill("SIGTERM");
  });

/** A second engine on the same data folder must refuse to start. */
function secondEngine() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, engineArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, err });
    });
  });
}

/** A plain local connection with the token, for setting things up behind the page's back. */
async function sideChannel(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${enginePort}/ws?token=${token}`);
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
  await request("hello", { protocol: PROTOCOL_VERSION, client: "remote-check" });
  return { request, close: () => ws.close() };
}

// ------------------------------------------------------------ the stand-in for `tailscale serve`
const made = spawnSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem"), "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST},DNS:${OTHER_HOST}`],
  { stdio: "ignore" },
);
if (made.status !== 0) {
  console.error("Could not make a throwaway certificate with openssl.");
  process.exit(2);
}

/** Who the proxy says the caller is: a login, or null for no identity header at all. */
let identity = LOGIN;
const IDENTITY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
const forwardHeaders = (incoming) => {
  const headers = { ...incoming };
  for (const h of IDENTITY_HEADERS) delete headers[h];
  if (identity) headers["tailscale-user-login"] = identity;
  return headers;
};
// Another website, reached in the same browser on the same tailnet device. Its page has no
// content security policy, so only the engine's origin rule stands between it and the socket.
const otherPage = `<!doctype html><title>Another site</title><p>Another site</p>`;

const proxy = createHttpsServer({ key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) }, (req, res) => {
  if ((req.headers.host ?? "").startsWith(OTHER_HOST)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(otherPage);
  }
  const up = httpRequest({ host: "127.0.0.1", port: enginePort, method: req.method, path: req.url, headers: forwardHeaders(req.headers) }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
proxy.on("upgrade", (req, socket, head) => {
  const up = connect(enginePort, "127.0.0.1", () => {
    const headers = forwardHeaders(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`])), "", ""];
    up.write(lines.join("\r\n"));
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;
const tailnetPage = `https://${HOST}:${proxyPort}/`;
const localPage = `http://127.0.0.1:${enginePort}/`;

// ------------------------------------------------------------ browser
const profile = join(work, "browser");
let browser;
// Stopped (Ctrl-C, SIGTERM): the browser and the engine stop, and only what tells what happened stays.
onStop(async () => {
  await browser?.close().catch(() => {});
  await stopEngine();
  if (!keep) keepOnly(work, ["shots", "data", "bots", "engine.log"]);
});
const shot = async (name) => writeFileSync(join(shots, `${name}.png`), Buffer.from((await browser.cmd("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const type = async (text) => {
  await browser.js(`document.querySelector("textarea").focus()`);
  await browser.cmd("Input.insertText", { text });
  await browser.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await browser.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
};
const clickButton = (label) =>
  browser.js(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const lastAnswer = `(() => { const all = [...document.querySelectorAll(".pb-msg-body")]; return all.length ? all[all.length - 1].textContent : ""; })()`;
const headStatus = `document.querySelector(".pb-main-head .pb-status")?.textContent ?? ""`;
const pageSays = (words) => `document.body.innerText.includes(${JSON.stringify(words)})`;
const violations = () => browser.js(`JSON.stringify(window.__csp ?? [])`);
const open = async (url) => {
  await browser.cmd("Page.navigate", { url });
  await browser.until(`document.readyState === "complete"`, 15_000, 100);
};

// ------------------------------------------------------------ the check
try {
  const lock = await startEngine();
  check("the engine runs in serve mode and notes itself in engine.json", lock.serve === true && typeof lock.token === "string");

  const second = await secondEngine();
  check("a second engine on the same data folder refuses to start", second.code !== 0 && /already running/.test(second.err), `exit ${second.code}`);

  browser = await launch({ profile, args: ["--ignore-certificate-errors", `--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${OTHER_HOST} 127.0.0.1`] });
  await browser.cmd("Page.enable");
  await browser.cmd("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));`,
  });

  // 1. From "the laptop": over HTTPS with the allowed identity.
  identity = LOGIN;
  await open(`${tailnetPage}?theme=dark`);
  check("the page loads over HTTPS and asks for the first bot", !!(await browser.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create bot")`, 20_000)));
  check("the page knows it is in a browser, not the desktop shell", (await browser.js(`document.documentElement.dataset.shell`)) === "browser");
  const who = await browser.js(`fetch("/api/whoami").then((r) => r.text())`);
  check("whoami says the device is let in over Tailscale, without echoing the login", /"via":"tailscale"/.test(who) && !who.includes("example.com"));
  await shot("1-first-run");

  await browser.js(`document.querySelector("input").focus()`);
  await browser.cmd("Input.insertText", { text: "Kaja" });
  await clickButton("Create bot");
  check("the bot is created and its chat opens", !!(await browser.until(`document.querySelector("textarea")?.placeholder === "Message Kaja"`, 15_000)));
  const gap = await browser.js(`({ drag: getComputedStyle(document.querySelector(".app-drag")).display, top: getComputedStyle(document.querySelector(".app-side-top")).paddingTop })`);
  check("no room is kept for macOS window buttons in a browser", gap?.drag === "none" && gap?.top !== "24px", JSON.stringify(gap));

  const side = await sideChannel(lock.token);
  const snap = await side.request("snapshot");
  const cheap = snap.models.find((m) => /haiku/.test(m.id)) ?? snap.models[snap.models.length - 1];
  await side.request("bot.update", { botId: "kaja", patch: { model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort } });
  check("the page follows a change made over the local socket", !!(await browser.until(`document.querySelector(".pb-composer")?.textContent.includes(${JSON.stringify(cheap.label)})`, 10_000)), cheap.label);
  side.close();

  await type("Say hello in five words or fewer.");
  check("your message shows as a bubble", !!(await browser.until(`document.querySelector(".pb-msg-you")?.textContent.includes("five words")`, 10_000)));
  const answered = await browser.until(`(${headStatus}) === "Done" && (${lastAnswer}).length > 0`, 120_000);
  check("the bot answers over the tailnet page", !!answered, JSON.stringify(await browser.js(lastAnswer)).slice(0, 80));
  const answer = await browser.js(lastAnswer);
  await shot("2-answered");

  await browser.cmd("Page.reload", { ignoreCache: true });
  check(
    "after a reload the chat is still there",
    !!(await browser.until(`document.querySelector(".pb-msg-you")?.textContent.includes("five words") && (${lastAnswer}) === ${JSON.stringify(answer)}`, 15_000)),
  );
  check("no content security policy blocked anything over HTTPS", (await violations()) === "[]", await violations());

  const manifest = await browser.cmd("Page.getAppManifest");
  const parsed = manifest.result?.data ? JSON.parse(manifest.result.data) : {};
  check("the web manifest loads without errors", parsed.name === "Pobots" && parsed.display === "standalone" && (manifest.result?.errors ?? []).length === 0, JSON.stringify(manifest.result?.errors ?? []));
  const install = await browser.cmd("Page.getInstallabilityErrors");
  const installErrors = install.result?.installabilityErrors?.map((e) => e.errorId) ?? ["no answer"];
  check("the page can be installed as its own window", installErrors.length === 0, installErrors.join(", "));
  check("the icon is there", (await browser.js(`fetch("/icon-512.png").then((r) => r.ok && r.headers.get("content-type") === "image/png")`)) === true);

  // 2. Three window widths: nothing spills out sideways and the chat keeps room.
  for (const width of [1280, 1024, 800]) {
    await browser.cmd("Emulation.setDeviceMetricsOverride", { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const fit = await browser.js(`(() => {
      const main = document.querySelector(".pb-main").getBoundingClientRect();
      const rail = document.querySelector(".pb-rail").getBoundingClientRect();
      const composer = document.querySelector(".pb-composer").getBoundingClientRect();
      return { spill: document.documentElement.scrollWidth - innerWidth, main: Math.round(main.width), railRight: Math.round(rail.right), composer: Math.round(composer.width) };
    })()`);
    check(`at ${width} px wide the window fits`, fit && fit.spill <= 0 && fit.main >= 400 && fit.railRight <= width && fit.composer >= 360, JSON.stringify(fit));
    await shot(`3-width-${width}`);
  }
  await browser.cmd("Emulation.clearDeviceMetricsOverride");

  // 3. Another web page in the same browser tries to open the socket with the person's identity.
  await open(`https://${OTHER_HOST}:${proxyPort}/`);
  const foreign = await browser.js(`new Promise((resolve) => {
    const ws = new WebSocket("wss://${HOST}:${proxyPort}/ws");
    ws.onopen = () => resolve("opened");
    ws.onclose = () => resolve("refused");
    setTimeout(() => resolve("no answer"), 8000);
  })`);
  check("another web page cannot open the socket with the person's identity", foreign === "refused", foreign);

  // 4. A login that is not on the list.
  identity = STRANGER;
  await open(`${tailnetPage}?theme=dark`);
  check("a login not on the list sees why it cannot connect", !!(await browser.until(pageSays(WORDS.notOnList), 15_000)));
  await shot("4-not-on-list");

  // 5. The engine's own address, plain HTTP on this machine, without a token.
  await open(`${localPage}?theme=dark`);
  check("on the engine's own address without a token the page says it is not allowed", !!(await browser.until(pageSays(WORDS.notAllowed), 15_000)));
  check("no content security policy blocked anything over http://127.0.0.1", (await violations()) === "[]", await violations());
  await shot("5-local-not-allowed");

  // 6. No identity at all (for example a tagged device, or a request that did not come through Tailscale).
  identity = null;
  await open(`${tailnetPage}?theme=dark`);
  check("without the identity header the page says it is not allowed", !!(await browser.until(pageSays(WORDS.notAllowed), 15_000)));
  check("the bot's chat is not shown", !(await browser.js(`!!document.querySelector(".pb-msg-you")`)));
  await shot("6-not-allowed");

  // 7. When the device is let in, the open page connects by itself, without a reload.
  identity = LOGIN;
  check("the page connects by itself once the device is let in", !!(await browser.until(`document.querySelector(".pb-msg-you")?.textContent.includes("five words")`, 20_000)));

  // 8. Nothing secret in the engine's log.
  const logText = readFileSync(engineLog, "utf8");
  check("the engine's log holds no login and no token", !logText.includes(LOGIN) && !logText.includes(STRANGER) && !logText.includes(lock.token) && /Refused a connection/.test(logText));

  await stopEngine();
  check("a clean stop removes engine.json", !existsSync(join(dataDir, "engine.json")));
} catch (err) {
  check("the check ran to the end", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser?.close();
  await stopEngine();
  proxy.closeAllConnections?.();
  proxy.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(tls, { recursive: true, force: true });
  console.log(failed ? "\nSome checks failed." : `\nAll ${results.length} checks passed.`);
  if (keep || failed || arg("shots")) console.log(`Pictures: ${shots}`);
  if (keep || failed) console.log(`Kept: ${work}\n  data dir: ${dataDir}\n  bots dir: ${botsDir}\n  engine log: ${engineLog}`);
  // Passed: the temp folder goes, pictures and all (--shots=DIR keeps them elsewhere, --keep keeps everything).
  if (!keep && !failed) rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
