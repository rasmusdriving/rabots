// Sends one message to a bot on the TEST copy of Pobots and prints what it did and answered. It
// refuses any engine that is not the test copy.
//   node scripts/dev/test-ask.mjs <bot name> "<message>" [timeout in ms]
//   ACCESS=full-access sets the bot's access level for this one turn; MODEL=<id> its model (at low effort).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const WebSocket = require("ws");
const { port, token } = JSON.parse(readFileSync(homedir() + "/Library/Application Support/Pobots-test/engine.json", "utf8"));
if (port !== 47700) throw new Error("not the test copy");
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let n = 0;
const waits = new Map();
const events = [];
const req = (method, params = {}) => new Promise((res, rej) => { const id = "r" + ++n; waits.set(id, { res, rej }); ws.send(JSON.stringify({ t: "req", id, method, params })); });
ws.on("message", (d) => {
  const f = JSON.parse(String(d));
  if (f.t === "res") { const w = waits.get(f.id); f.ok ? w.res(f.result) : w.rej(new Error(f.error.message)); }
  else events.push(f);
});
await new Promise((r) => ws.on("open", r));
await req("hello", { protocol: Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL("../../shared/protocol.ts", import.meta.url), "utf8"))[1]), client: "test-ask" });
const snap = await req("snapshot");
const bot = snap.bots.find((b) => b.name === process.argv[2]);
if (!bot) throw new Error("no such bot: " + snap.bots.map((b) => b.name).join(", "));
console.log("bot", bot.name, bot.model, bot.effort, bot.access, bot.state);
if (process.env.ACCESS) await req("bot.update", { botId: bot.id, patch: { access: process.env.ACCESS } });
if (process.env.MODEL) await req("bot.update", { botId: bot.id, patch: { model: process.env.MODEL, effort: "low" } });
const sent = await req("message.send", { botId: bot.id, text: process.argv[3] });
const deadline = Date.now() + Number(process.argv[4] ?? 120000);
let done = false;
let after = [];
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 1000));
  const now = (await req("snapshot")).bots.find((b) => b.id === bot.id);
  after = (await req("thread.read", { threadId: bot.mainThreadId, limit: 40 })).items.filter((i) => i.seq > sent.item.seq);
  done = ["done", "blocked", "waiting", "idle"].includes(now.state) && !now.helpers && after.some((i) => i.kind === "bot" && !i.streaming);
}
for (const i of after) console.log(i.kind, "|", (i.text ?? i.label ?? i.title ?? "").slice(0, 1500), i.detail ? "| " + String(i.detail).slice(0, 300) : "");
console.log(done ? "ended" : "timed out");
if (process.env.ACCESS) await req("bot.update", { botId: bot.id, patch: { access: bot.access } });
if (process.env.MODEL) await req("bot.update", { botId: bot.id, patch: { model: bot.model, effort: bot.effort } });
if (process.env.ARTIFACTS) {
  const { artifacts } = await req("artifact.list", { botId: bot.id });
  // Only whether there is a link, never the link itself beyond its host and shape.
  for (const a of artifacts) console.log("artifact |", a.kind, "|", a.title, "|", a.path ?? "", "| url:", a.url ? a.url.replace(/[A-Za-z0-9-]{8,}$/, "<id>") : "none", "| rev", a.rev);
}
ws.close();
