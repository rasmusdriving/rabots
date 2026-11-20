// Protocol 35 with real engines and Haiku bots: a connection that belongs to a bot other than the
// main bot (docs/build/step-link-owner.md). Sam's Pobots has the main bot Sam and the bot Skifte, who
// owns the connection to Kim's Pobots. Kim's message lands in Skifte's chat, Skifte answers with
// message_pobots, Sam's list_connections shows the owner and no content, and Sam cannot send on it.
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
    await sleep(250);
  }
};
const rules = "Use no connectors or MCP servers, change no files outside your own folder.";
const job = `${rules} Use only the exact Pobots tool named in the test, if one is requested.`;

async function engine(dir, port, pub, peer, name, processes) {
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
  if (!endpoint) throw new Error("A link-owner check engine did not start.");
  const s = await sideChannel(endpoint);
  const snap = await s.request("snapshot");
  const model = snap.models.find(m => m.id === "claude-haiku-5-5") ?? snap.models.find(m => m.harness === "claude" && /haiku/i.test(m.id));
  if (!model) throw new Error("Haiku was not offered by the link-owner check engine.");
  const make = async (botName, purpose) => {
    const { bot } = await s.request("bot.create", { name: botName, ...(purpose ? { purpose } : {}), model: model.id, effort: "low", access: "asks-first", welcome: false, job });
    await s.request("bot.update", { botId: bot.id, patch: { sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
    return bot;
  };
  const history = bot => s.request("thread.read", { threadId: bot.mainThreadId, limit: 80 }).then(x => x.items);
  const con = () => s.request("connection.list").then(x => x.connections[0]);
  const send = (bot, text) => s.request("message.send", { botId: bot.id, text }).then(r => r.item);
  /** The bot's finished replies in the turn its message started. */
  const replies = async (bot, item) => {
    const items = await history(bot);
    const turnId = items.find(i => i.id === item.id)?.turnId;
    return turnId ? items.filter(i => i.turnId === turnId && i.kind === "bot" && !i.streaming).map(i => i.text).join(" ") : "";
  };
  return { s, make, history, con, send, replies };
}

const outside = (items, pattern) => items.find(i => i.kind === "user" && i.from.type === "connection" && pattern.test(i.text));

export default async function section() {
  const processes = [], sockets = [];
  const M = name => `link-owner: ${name}`;
  try {
    let portA = await freePort(), portB = await freePort();
    while (portB === portA || [47600, 47700].includes(portB)) portB = await freePort();
    while (portA === portB || [47600, 47700].includes(portA)) portA = await freePort();
    const a = await engine(join(work, "link-owner", "a"), portA, true, portB, "Sam", processes);
    sockets.push(a.s);
    const b = await engine(join(work, "link-owner", "b"), portB, false, portA, "Kim", processes);
    sockets.push(b.s);
    const sam = await a.make("Sam");
    const skifte = await a.make("Skifte", "Private errands");
    const kim = await b.make("Kim");

    const ca = await a.s.request("connection.set", { action: "start", name: "Kim", owner: skifte.id });
    const cb = await b.s.request("connection.set", { action: "start", name: "Sam" });
    check(M("the connection belongs to the bot chosen at the start"), (await a.con())?.owner === skifte.id);
    check(M("the other side's belongs to its main bot"), (await b.con())?.owner === kim.id);
    check(M("the main bot is told in a quiet line"), !!await until(async () => (await a.history(sam)).some(i => i.kind === "notice" && i.text === "Connection Kim: pairing code created, belongs to Skifte")));
    await b.s.request("connection.set", { action: "connect", id: cb.id, code: ca.code });
    await a.s.request("connection.set", { action: "connect", id: ca.id, code: cb.code });
    const paired = await until(async () => (await a.con())?.state === "connected" && (await b.con())?.state === "connected");
    check(M("the engines connect"), !!paired);
    if (!paired) return;

    // Kim's message lands in Skifte's chat, not Sam's.
    const word = "brambleton";
    await b.send(kim, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Sam, mode tell, and text "The made-up test word is ${word}". Sam is in a separate Pobots. Do not use message_bot. ${rules} End after the receipt.`);
    const arrived = await until(async () => outside(await a.history(skifte), new RegExp(word)), 120_000);
    check(M("a message on Skifte's connection lands in Skifte's chat"), !!arrived);
    check(M("and not in the main bot's chat"), !outside(await a.history(sam), new RegExp(word)));

    // Skifte answers on its own connection.
    const back = "quintavel";
    await a.send(skifte, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Kim, mode tell, and text "Got it, here is ${back}". Kim is in a separate Pobots. ${rules} End after the receipt.`);
    check(M("Skifte answers with message_pobots and it reaches Kim's main bot"), !!await until(async () => outside(await b.history(kim), new RegExp(back)), 120_000));

    // Sam's list shows the owner and never what was said.
    const listed = await a.send(sam, `Call the Pobots tool list_connections (mcp__pobots__list_connections) and repeat its answer word for word. ${rules}`);
    let said = "";
    const listOk = await until(async () => { said = await a.replies(sam, listed); return /Skifte/.test(said); }, 100_000);
    check(M("the main bot's list_connections names the owner"), !!listOk, listOk ? "" : said.slice(-300) || "no answer");
    check(M("and shows no content"), !new RegExp(`${word}|${back}`, "i").test(said));

    // Sam may not send on Skifte's connection.
    const tried = await a.send(sam, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Kim, mode tell, and text "Sam trying". ${rules} Then repeat the tool's answer word for word.`);
    const refused = await until(async () => { said = await a.replies(sam, tried); return /own connection|no connection|cannot|can't|not allowed|refus/i.test(said); }, 100_000);
    check(M("the main bot is refused on another bot's connection"), !!refused, refused ? "" : said.slice(-300) || "no answer");
    await sleep(3_000);
    check(M("nothing from the main bot reached the other side"), !outside(await b.history(kim), /Sam trying/));

    // The owner goes back to the main bot through the protocol, with a quiet line.
    await a.s.request("connection.set", { action: "owner", id: ca.id, owner: sam.id });
    check(M("a new owner is saved and noted"), (await a.con())?.owner === sam.id &&
      !!await until(async () => (await a.history(sam)).some(i => i.kind === "notice" && i.text === "Connection Kim: belongs to Sam now")));
    await a.s.request("connection.set", { action: "remove", id: ca.id });
    check(M("both engines remove the connection"), !!await until(async () => !await a.con() && !await b.con()));
  } finally {
    for (const s of sockets) s.close();
    await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    })));
  }
}
