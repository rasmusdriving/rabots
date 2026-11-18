// Sets up a channel on a running engine from the command line, without ever printing a secret.
// For wiring a channel to its Power Automate flows: the channel's address and the address for
// answers go through files (mode 600), never through the terminal.
//
//   node scripts/channel-admin.mjs show      --name="Ops - Internal"
//   node scripts/channel-admin.mjs ensure    --name="Ops - Internal" [--sender=a@example.com ...] [--route=Tag:botId ...]
//   node scripts/channel-admin.mjs address   --name="Ops - Internal" --out=FILE     writes the full address to FILE
//   node scripts/channel-admin.mjs set-reply --name="Ops - Internal" --from=FILE    reads the address for answers from FILE
//   node scripts/channel-admin.mjs messages  --name="Ops - Internal"                what came in, newest first
//
// --data-dir=PATH picks the engine (default: the real one, ~/Library/Application Support/Pobots).
// `ensure` only adds: it never removes a writer or a tag that is already there.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(3);
const one = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const many = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const command = process.argv[2];
const name = one("name");
if (!command || !name) fail("Use: node scripts/channel-admin.mjs show|ensure|address|set-reply|messages --name=NAME");

// The protocol number is read from the contract, so this tool never falls behind the engine.
const PROTOCOL_VERSION = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(readFileSync(new URL("../shared/protocol.ts", import.meta.url), "utf8"))[1]);
const dataDir = one("data-dir") ?? join(homedir(), "Library", "Application Support", "Pobots");
let lock;
try {
  lock = JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8"));
} catch {
  fail(`No running engine found in ${dataDir}.`);
}

const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/ws?token=${lock.token}`);
await new Promise((res, rej) => (ws.once("open", res), ws.once("error", () => rej(new Error("The engine did not answer.")))));
let n = 0;
const waiting = new Map();
ws.on("message", (raw) => {
  const f = JSON.parse(String(raw));
  if (f.t !== "res") return;
  const w = waiting.get(f.id);
  waiting.delete(f.id);
  if (f.ok) w.res(f.result);
  else w.rej(new Error(f.error.message));
});
const request = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = `c${++n}`;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ t: "req", id, method, params }));
  });

const quiet = (c) => ({ name: c.name, enabled: c.enabled, writers: c.allowedSenders.length, routes: c.routes.map((r) => `${r.tag} -> ${r.botId}`), contextCount: c.contextCount, hasReplyUrl: c.hasReplyUrl });

try {
  await request("hello", { protocol: PROTOCOL_VERSION, client: "channel-admin" });
  const snapshot = await request("snapshot");
  let channel = snapshot.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());

  if (command === "ensure") {
    if (!channel) channel = (await request("channel.save", { channel: { name } })).channel;
    const senders = [...new Set([...channel.allowedSenders, ...many("sender").map((s) => s.trim().toLowerCase())])];
    const routes = [...channel.routes];
    for (const r of many("route")) {
      const [tag, botId] = r.split(":");
      if (!tag || !botId) fail(`"${r}" is not Tag:botId.`);
      if (!snapshot.bots.some((b) => b.id === botId)) fail(`There is no bot with the id ${botId}.`);
      if (!routes.some((x) => x.tag.toLowerCase() === tag.toLowerCase())) routes.push({ tag, botId });
    }
    channel = (await request("channel.save", { channel: { id: channel.id, allowedSenders: senders, routes } })).channel;
    console.log(JSON.stringify(quiet(channel)));
  } else if (!channel) {
    fail(`There is no channel called ${name}.`);
  } else if (command === "show") {
    console.log(JSON.stringify(quiet(channel)));
  } else if (command === "address") {
    const out = one("out");
    if (!out) fail("Give --out=FILE.");
    const { hookPath, publicBase } = await request("channel.address", { channelId: channel.id });
    writeFileSync(out, `${publicBase ?? `http://127.0.0.1:${lock.port}`}${hookPath}`, { mode: 0o600 });
    chmodSync(out, 0o600);
    console.log(`Wrote the channel's address to ${out}${publicBase ? " (the public one)" : " (local only: no public address is set)"}.`);
  } else if (command === "set-reply") {
    const from = one("from");
    if (!from) fail("Give --from=FILE.");
    const replyUrl = readFileSync(from, "utf8").trim();
    if (!replyUrl) fail("The file is empty.");
    channel = (await request("channel.save", { channel: { id: channel.id, replyUrl } })).channel;
    console.log(`The address for answers is ${channel.hasReplyUrl ? "set" : "not set"}.`);
  } else if (command === "messages") {
    const { messages } = await request("channel.messages", { channelId: channel.id, limit: 20 });
    for (const m of messages) console.log(`${m.at}  ${m.status}  ${m.tag ?? "-"} -> ${m.botId ?? "-"}  ${m.note ?? ""}`);
    if (!messages.length) console.log("Nothing has come in yet.");
  } else {
    fail("Use: show | ensure | address | set-reply | messages");
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  ws.close();
}
