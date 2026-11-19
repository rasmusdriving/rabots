// Real engines and main bots; both network shapes use only the two test ports.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { guardChild } from "../../browser.mjs";
import { sleep, check, sideChannel, root, work, envFile } from "../lib.mjs";

const address = n => `http://127.0.0.1:${n}`;
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
});
const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(220);
  }
};

async function box(dir, port, pub, peer, name, processes) {
  const data = join(dir, "data");
  const bots = join(dir, "bots");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ machineName: name, ...(existsSync(envFile) ? { claude: { envFile } } : {}) }));
  const args = [join(root, "dist", "engine", "main.mjs"), `--port=${port}`, `--data-dir=${data}`, `--bots-dir=${bots}`,
    `--connections-test-peer=${address(peer)}`, ...(pub ? [`--connections-test-base=${address(port)}`] : [])];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  guardChild(child, `--data-dir=${data}`);
  child.stderr.resume();
  let endpoint;
  for await (const line of createInterface({ input: child.stdout })) {
    try {
      const e = JSON.parse(line).pobotsEngine;
      if (e) { endpoint = { url: `ws://127.0.0.1:${e.port}/`, token: e.token }; break; }
    } catch {}
  }
  if (!endpoint) throw new Error("A connection check engine did not start.");
  const s = await sideChannel(endpoint);
  const snap = await s.request("snapshot");
  const model = snap.models.find(m => m.id === "claude-haiku-5-5") ?? snap.models.find(m => m.harness === "claude" && /haiku/i.test(m.id));
  if (!model) throw new Error("Haiku was not offered by the connection check engine.");
  const { bot } = await s.request("bot.create", { name, model: model.id, effort: "low", access: "asks-first", welcome: false,
    job: "Use no connectors or MCP servers, change no files outside your own folder. Use only the exact Pobots tool named in the test, if one is requested." });
  await s.request("bot.update", { botId: bot.id, patch: { sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
  const con = () => s.request("connection.list").then(x => x.connections[0]);
  const history = () => s.request("thread.read", { threadId: bot.mainThreadId, limit: 40 }).then(x => x.items);
  return { s, bot, con, history, port };
}

export default async function section() {
  for (const both of [false, true]) {
    const processes = [], sockets = [];
    const mode = both ? "both public" : "one public";
    try {
      let portA = await freePort(), portB = await freePort();
      while (portB === portA || [47600, 47700].includes(portB)) portB = await freePort();
      while (portA === portB || [47600, 47700].includes(portA)) portA = await freePort();
      const a = await box(join(work, mode, "a"), portA, true, portB, "Sam", processes);
      sockets.push(a.s);
      const b = await box(join(work, mode, "b"), portB, both, portA, "Kim", processes);
      sockets.push(b.s);
      const ca = await a.s.request("connection.set", { action: "start", name: "Kim" });
      const cb = await b.s.request("connection.set", { action: "start", name: "Sam" });
      const wrong = await fetch(`${address(a.port)}/hook/link/${ca.id}`, { method: "POST" });
      const unknown = await fetch(`${address(a.port)}/hook/not-an-address/unknown`, { method: "POST" });
      check(`connections (${mode}): guessed link looks like a wrong webhook`, wrong.status === 404 && unknown.status === 404 && await wrong.text() === await unknown.text());
      await b.s.request("connection.set", { action: "connect", id: cb.id, code: ca.code });
      check(`connections (${mode}): one person's entry does not connect`, (await b.con())?.state === "waiting" && (await a.con())?.state === "draft");
      await a.s.request("connection.set", { action: "connect", id: ca.id, code: cb.code });
      const paired = await until(async () => (await a.con())?.state === "connected" && (await b.con())?.state === "connected");
      check(`connections (${mode}): both people enter the code and the engines connect`, !!paired);
      if (!paired) continue;
      const rules = "Use no connectors or MCP servers, change no files outside your own folder.";
      const send = (box, text) => box.s.request("message.send", { botId: box.bot.id, text }).then(r => r.item);
      const response = (box, item, spell) => until(async () => {
        const items = await box.history();
        const turnId = items.find(i => i.id === item.id)?.turnId;
        return turnId && items.some(i => i.turnId === turnId && i.kind === "bot" && !i.streaming && spell.test(i.text));
      }, 100_000);
      const ask = question => send(a, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Kim, mode ask, text exactly as below. Kim is in a separate Pobots. Do not use message_bot. ${rules} Then repeat just the other bot's answer. Do not guess. Text: ${question}`);
      await b.s.request("bot.create", { name: "Test spare", model: b.bot.model, effort: "low", access: "asks-first", welcome: false });
      const memoryWord = both ? "mavortine" : "drelmora";
      const seed = await send(b, `Remember the made-up word ${memoryWord} in this chat. You may share this test word and the count of your other bots with Sam's main bot when it asks through Connections. When it asks for the count, use the Pobots tool list_bots. For this message just reply Ready and use no tools. ${rules}`);
      check(`connections (${mode}): the person gives the receiving main bot a word in normal chat`, !!await response(b, seed, /\bReady\b/i));
      // In the one-public case this also checks the message going out by polling and back by push.
      const memory = await ask(`What test word did your person ask you to remember in this chat? Use no tools. ${rules}`);
      check(`connections (${mode}): the connected ask gets a word from the receiver's normal chat`, !!await response(a, memory, new RegExp(`\\b${memoryWord}\\b`, "i")));
      check(`connections (${mode}): chat labels the incoming text as outside information`,
        (await b.history()).some(i => i.kind === "user" && i.from.type === "connection" && /test word/i.test(i.text)));
      const expected = (await b.s.request("snapshot")).bots.filter(bot => bot.id !== b.bot.id).length;
      const count = await ask(`Call the Pobots tool list_bots (mcp__pobots__list_bots) to count the other bots on your Pobots, excluding yourself. ${rules} Return only the number, in digits.`);
      check(`connections (${mode}): the connected ask gets the count from the receiver's tools`, !!await response(a, count, new RegExp(`^\\s*${expected}\\.?\\s*$`)));
      const receiver = await b.history();
      const connectedTurn = receiver.find(i => i.kind === "user" && i.from.type === "connection" && /excluding yourself/.test(i.text))?.turnId;
      check(`connections (${mode}): the receiver called list_bots during the outside turn`,
        !!connectedTurn && receiver.some(i => i.turnId === connectedTurn && i.kind === "activity" && i.label === "Looked at the other bots"));
      await b.s.request("message.send", { botId: b.bot.id,
        text: "Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Sam, mode tell, text The test postcard is blue. Sam is in a separate Pobots. Do not use message_bot, which only reaches local bots. Use no connectors or MCP servers, change no files outside your own folder. End after the receipt." });
      const told = await until(async () => (await a.history()).some(i => i.kind === "user" && i.from.type === "connection" && i.from.mode === "tell" && /postcard is blue/i.test(i.text)), 65_000);
      const senderHistory = told ? [] : await b.history();
      const localTool = senderHistory.some(i => i.kind === "activity" && /Could not send the message to Sam/.test(i.label));
      check(`connections (${mode}): tell arrives without needing an answer`, !!told, localTool ? "the model chose the local message_bot tool" : "");
      await a.s.request("connection.set", { action: "remove", id: ca.id });
      check(`connections (${mode}): both engines remove the connection`, !!await until(async () => !await a.con() && !await b.con()));
    } finally {
      for (const s of sockets) s.close();
      await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      })));
    }
  }
}
