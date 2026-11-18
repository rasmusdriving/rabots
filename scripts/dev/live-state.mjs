// Looks at the real Pobots without disturbing it: the engine's version, whether each bot is idle,
// how many cards wait, whether Codex is ready, and whether the browser can be reached. Reads nothing else and changes nothing.
//   node scripts/dev/live-state.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const WebSocket = require("ws");
const proto = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8"))[1]);
const { port, token } = JSON.parse(readFileSync(homedir() + "/Library/Application Support/Pobots/engine.json", "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let n = 0; const waits = new Map();
const req = (method, params = {}) => new Promise((res, rej) => { const id = "r" + ++n; waits.set(id, { res, rej }); ws.send(JSON.stringify({ t: "req", id, method, params })); });
ws.on("message", (d) => { const f = JSON.parse(String(d)); if (f.t === "res") { const w = waits.get(f.id); f.ok ? w.res(f.result) : w.rej(new Error(f.error.message)); } });
await new Promise((r) => ws.on("open", r));
// The running engine may be one release behind or ahead of the source: try the neighbours too.
let hello;
for (const protocol of [proto, proto - 1, proto + 1]) {
  try {
    hello = await req("hello", { protocol, client: "state-check" });
    break;
  } catch (err) {
    if (!/same version/.test(err.message)) throw err;
  }
}
if (!hello) throw new Error("The running engine speaks another version than the source and its neighbours.");
const snap = await req("snapshot");
console.log("engine", hello.engineVersion, "| bots:", snap.bots.map((b) => `${b.name}: ${b.state}`).join(", "), "| open cards:", snap.cards.length);
if (snap.status.codex) console.log("codex ready:", snap.status.codex.ready, snap.status.codex.problem ?? "", "| GPT models:", snap.models.filter((m) => m.harness === "codex").map((m) => m.label).join(", ") || "none");
const b = await req("browser.state");
console.log("browser available:", b.available, b.problem ?? "", "| open:", b.spaces.map((x) => x.owner).join(", ") || "none");
ws.close();
