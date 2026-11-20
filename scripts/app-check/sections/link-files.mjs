// Protocol 35 with real engines and Haiku main bots: files over a connection (one public side, so
// the files go out by polling) and how long a connection lasts, set and changed through the protocol.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { guardChild } from "../../browser.mjs";
import { textPdf } from "../../dev/attach-fixtures.mjs";
import { sleep, check, sideChannel, root, work, envFile } from "../lib.mjs";

const DAY = 86_400_000;
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
  if (!endpoint) throw new Error("A link-files check engine did not start.");
  const s = await sideChannel(endpoint);
  const snap = await s.request("snapshot");
  const model = snap.models.find(m => m.id === "claude-haiku-5-5") ?? snap.models.find(m => m.harness === "claude" && /haiku/i.test(m.id));
  if (!model) throw new Error("Haiku was not offered by the link-files check engine.");
  const { bot } = await s.request("bot.create", { name, model: model.id, effort: "low", access: "asks-first", welcome: false,
    job: `${rules} Use only the exact Pobots tool named in the test, if one is requested.` });
  await s.request("bot.update", { botId: bot.id, patch: { sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
  const con = () => s.request("connection.list").then(x => x.connections[0]);
  const history = () => s.request("thread.read", { threadId: bot.mainThreadId, limit: 60 }).then(x => x.items);
  return { s, bot, con, history, port, folder: join(bots, bot.id) };
}

export default async function section() {
  const processes = [], sockets = [];
  const M = name => `link-files: ${name}`;
  try {
    let portA = await freePort(), portB = await freePort();
    while (portB === portA || [47600, 47700].includes(portB)) portB = await freePort();
    while (portA === portB || [47600, 47700].includes(portA)) portA = await freePort();
    const a = await box(join(work, "link-files", "a"), portA, true, portB, "Sam", processes);
    sockets.push(a.s);
    const b = await box(join(work, "link-files", "b"), portB, false, portA, "Kim", processes);
    sockets.push(b.s);

    // How long it lasts: chosen at the start, counted once both are connected, changed later.
    const ca = await a.s.request("connection.set", { action: "start", name: "Kim", lasts: "30d" });
    const cb = await b.s.request("connection.set", { action: "start", name: "Sam" });
    check(M("before connecting there is no end time yet"), (await a.con())?.lasts === "30d" && !(await a.con())?.endsAt);
    await b.s.request("connection.set", { action: "connect", id: cb.id, code: ca.code });
    await a.s.request("connection.set", { action: "connect", id: ca.id, code: cb.code });
    const paired = await until(async () => (await a.con())?.state === "connected" && (await b.con())?.state === "connected");
    check(M("the engines connect"), !!paired);
    if (!paired) return;
    const ends = Date.parse((await a.con()).endsAt ?? "");
    check(M("a connection chosen for 30 days ends 30 days after connecting"), Math.abs(ends - (Date.now() + 30 * DAY)) < 120_000);
    check(M("the default is never"), (await b.con())?.lasts === "never" && !(await b.con())?.endsAt);
    await a.s.request("connection.set", { action: "lasts", id: ca.id, lasts: "never" });
    check(M("a change ends the count and leaves a quiet line"), !(await a.con())?.endsAt &&
      !!await until(async () => (await a.history()).some(i => i.kind === "notice" && i.text === "Connection Kim: lasts until removed (was 30 days)")));

    // Files: Sam's bot sends a Markdown file and a PDF; Kim's bot reads a word only the file holds.
    const word = "quillamore";
    writeFileSync(join(a.folder, "notes.md"), `# Notes for Kim\n\nThe made-up test word is ${word}.\n`);
    writeFileSync(join(a.folder, "report.pdf"), textPdf(["Pobots check", "A report for Kim."]));
    writeFileSync(join(a.folder, "api-token.md"), "nothing here");
    const send = (x, text) => x.s.request("message.send", { botId: x.bot.id, text }).then(r => r.item);
    await send(a, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Kim, mode tell, text "Two files for you", and files ["notes.md", "report.pdf"]. Kim is in a separate Pobots. Do not use message_bot. ${rules} End after the receipt.`);
    const arrived = await until(async () => (await b.history()).find(i => i.kind === "user" && i.from.type === "connection" && i.attachments?.length === 2), 120_000);
    check(M("both files arrive with the outside message"), !!arrived, arrived ? "" : "no message with two files");
    if (arrived) {
      check(M("the files keep their names"), arrived.attachments.map(x => x.name).sort().join() === "notes.md,report.pdf");
      const md = arrived.attachments.find(x => x.name === "notes.md");
      check(M("the files are in the main bot's folder under .attachments"), md.path.startsWith(".attachments/") &&
        readFileSync(join(b.folder, ...md.path.split("/")), "utf8").includes(word));
    }
    check(M("the sender's copies are gone once delivered"), !!await until(async () => {
      const out = join(work, "link-files", "a", "data", "link-out");
      return !existsSync(out) || readdirSync(out).every(d => readdirSync(join(out, d)).length === 0);
    }));
    const question = await send(b, `What made-up test word is in the file notes.md that Sam's Pobots sent you? Read the file in your folder. ${rules} Answer with only the word.`);
    const answered = await until(async () => {
      const items = await b.history();
      const turnId = items.find(i => i.id === question.id)?.turnId;
      return turnId && items.some(i => i.turnId === turnId && i.kind === "bot" && !i.streaming && new RegExp(`\\b${word}\\b`, "i").test(i.text));
    }, 100_000);
    check(M("the receiving bot reads a word only the file holds"), !!answered);

    // A secret-looking file is refused at once and nothing goes.
    const before = (await b.history()).filter(i => i.kind === "user" && i.from.type === "connection").length;
    const refused = await send(a, `Call the Pobots tool message_pobots (mcp__pobots__message_pobots) with to Kim, mode tell, text "One more", and files ["api-token.md"]. ${rules} Then repeat the tool's answer word for word.`);
    // The bot is told; a small model may put the refusal in its own words, so any plain refusal counts.
    let last = "";
    const said = await until(async () => {
      const items = await a.history();
      const turnId = items.find(i => i.id === refused.id)?.turnId;
      const replies = turnId ? items.filter(i => i.turnId === turnId && i.kind === "bot" && !i.streaming) : [];
      last = replies.map(i => i.text).join(" ").slice(-300);
      return replies.some(i => /secret|refus|cannot be sent|can't be sent|could not|was not sent|wasn't sent|not allowed|blocked/i.test(i.text));
    }, 100_000);
    check(M("a secret-looking file is refused and the bot is told"), !!said, said ? "" : last || "no answer");
    await sleep(3_000);
    check(M("nothing reached the other side after the refusal"), (await b.history()).filter(i => i.kind === "user" && i.from.type === "connection").length === before);
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
