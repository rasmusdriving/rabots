// Engine 0.44.0: a connection belongs to a bot (docs/build/step-link-owner.md). A real engine with
// a main bot Po and the bots Skifte and Kaja, paired with stand-in Pobots "Ted" and "Una" in the
// same process. Ted's and Una's side are plain Links with a public address; the engine polls them.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { UserItem } from "../../shared/protocol.js";
import type { LinkFetch } from "../core/link-http.js";
import type { InboxMessage } from "../core/link-store.js";
import { pickFiles } from "../core/link-files.js";
import { Links } from "../core/links.js";
import { Store } from "../store.js";
import { TOOL_NAMES } from "../tool-names.js";
import { settle, setup } from "./fake.js";

async function until(fn: () => boolean, time = 6_000): Promise<void> {
  const end = Date.now() + time;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(15);
  }
  assert.ok(fn(), "state did not arrive in time");
}

/** Waits while the fake clock moves on, so the engine's pulls from the other side come round. */
async function stepUntil(w: { step: (ms: number) => void }, fn: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !fn(); i++) { w.step(700); await delay(15); }
  assert.ok(fn(), "state did not arrive in time");
}

function world() {
  let now = Date.now();
  const peers = new Map<string, Links>();
  const fetch: LinkFetch = async (target, id, proof, body, _signal, wire = 1) => {
    const peer = peers.get(target);
    const auth = peer?.preflight(id, proof, wire);
    return (auth && await peer!.receive(auth, body)) || { status: 404, body: Buffer.alloc(0) };
  };
  const w = setup(undefined, () => true, undefined, { clock: () => now, links: { fetch, tickMs: 10, askMs: 60_000 } });
  const dirs: string[] = [];
  const stops: (() => void)[] = [];
  /** The other person's Pobots, reachable at its own public address. */
  const other = (name: string) => {
    const base = `https://${name.toLowerCase()}.example.com`;
    const store = new Store(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "pobots-link-owner-"));
    dirs.push(dataDir);
    const got: InboxMessage[] = [];
    const links = new Links({ store: store.links, name: () => name, publicBase: base, now: () => now,
      changed: () => {}, note: () => {}, deliver: (_id, _name, _item, m) => { got.push(m); return true; }, ready: () => true,
      files: { dataDir, botId: () => "other-main" } }, { fetch, tickMs: 10, askMs: 400 });
    peers.set(base, links);
    links.start();
    stops.push(() => { links.stop(); store.close(); });
    return { links, got, dataDir };
  };
  const step = (ms: number) => { now += ms; };
  const close = () => {
    for (const stop of stops) stop();
    w.engine.shutdown();
    w.store.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };
  return { ...w, other, step, close, now: () => now };
}
type World = ReturnType<typeof world>;

/** Pairs the engine with another Pobots. The engine names it `name`; the other side names the engine "Robin". */
async function pairWith(w: World, other: ReturnType<World["other"]>, name: string, owner?: string) {
  const mine = w.engine.links.change({ action: "start", name, ...(owner ? { owner } : {}) });
  const theirs = other.links.change({ action: "start", name: "Robin" });
  w.engine.links.change({ action: "connect", id: mine.id, code: theirs.code! });
  other.links.change({ action: "connect", id: theirs.id, code: mine.code! });
  w.step(3_000);
  await until(() => w.engine.links.list().connections.find(c => c.id === mine.id)?.state === "connected"
    && other.links.list().connections.find(c => c.id === theirs.id)?.state === "connected");
  return { id: mine.id, theirs: theirs.id };
}

const fromConnection = (w: World, threadId: string) => w.store.readThread(threadId, undefined, 200).items
  .filter((i): i is UserItem => i.kind === "user" && i.from.type === "connection");
const notices = (w: World, threadId: string) => w.store.readThread(threadId, undefined, 200).items
  .flatMap(i => i.kind === "notice" ? [i.text] : []);
const sessionOf = (w: World, botId: string) => w.sessions.filter(s => s.settings.botId === botId).at(-1);

test("a connection belongs to a bot: its chat and folder get the messages, it alone sends, the main bot sees no content", async () => {
  const w = world();
  try {
    const po = w.engine.createBot("Po");
    const skifte = w.engine.createBot({ name: "Skifte", purpose: "Private errands" });
    const kaja = w.engine.createBot({ name: "Kaja", purpose: "Sample reports" });
    const ted = w.other("Ted");
    const una = w.other("Una");

    // An older connection has no saved owner: it is the main bot's.
    const old = await pairWith(w, una, "Una");
    assert.equal(w.store.links.rows().find(r => r.identity.invite.id === old.id)?.owner, undefined);
    assert.equal(w.engine.links.list().connections.find(c => c.id === old.id)?.owner, po.id);
    // A bot that does not exist is refused in plain words, and the main bot is saved as none.
    assert.throws(() => w.engine.links.change({ action: "start", name: "Nobody", owner: "No such bot" }), /no bot called "No such bot"/);

    const tedLink = await pairWith(w, ted, "Ted", skifte.id);
    assert.equal(w.store.links.rows().find(r => r.identity.invite.id === tedLink.id)?.owner, skifte.id);
    assert.ok(notices(w, po.mainThreadId).some(t => t === "Connection Ted: pairing code created, belongs to Skifte"));

    // A message and its file land in Skifte's chat and folder, not Po's.
    const doc = join(ted.dataDir, "packing-list.md");
    writeFileSync(doc, "# Packing list\n\nTent, stove, map.\n");
    const sent = ted.links.message("Robin", "tell", "Here is the packing list for Saturday.", undefined, 2_000, pickFiles(ted.dataDir, ["packing-list.md"]));
    for (let i = 0; i < 400 && !fromConnection(w, skifte.mainThreadId).length; i++) { w.step(700); await delay(15); }
    // The engine has no public address: it collects from Ted, so Ted's side only knows it is queued.
    assert.ok(["delivered", "queued"].includes((await sent).delivery));
    const arrived = fromConnection(w, skifte.mainThreadId);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0]!.attachments?.length, 1);
    const path = arrived[0]!.attachments![0]!.path;
    assert.ok(existsSync(join(w.engine.bot(skifte.id).folder.dir, path)), "the file is in Skifte's folder");
    assert.ok(!existsSync(join(w.engine.bot(po.id).folder.dir, path)), "and not in Po's");
    assert.equal(fromConnection(w, po.mainThreadId).length, 0);
    await settle();
    const skifteSession = sessionOf(w, skifte.id)!;
    assert.match(skifteSession.sent.at(-1)!.text, /the connection "Ted"/);
    assert.doesNotMatch(skifteSession.sent.at(-1)!.text, /main bot in another/);

    // Skifte has message_pobots, Kaja (no connection) has none, Po keeps all three.
    assert.ok(skifteSession.toolNames().includes(TOOL_NAMES.messagePobots));
    assert.ok(!skifteSession.toolNames().includes(TOOL_NAMES.listConnections));
    w.engine.sendMessage({ botId: kaja.id, text: "Hello" });
    w.engine.sendMessage({ botId: po.id, text: "Hello" });
    await settle();
    assert.ok(!sessionOf(w, kaja.id)!.toolNames().includes(TOOL_NAMES.messagePobots));
    const poSession = sessionOf(w, po.id)!;
    assert.ok(poSession.toolNames().includes(TOOL_NAMES.messagePobots));

    // Skifte answers on its own connection; Po may not send on Skifte's, and is told which are its own.
    const reply = await skifteSession.tool(TOOL_NAMES.messagePobots, { to: "Ted", mode: "tell", text: "Thanks, got it." });
    assert.equal(reply.isError, undefined, reply.content[0]!.text);
    await until(() => ted.got.some(m => m.text === "Thanks, got it."));
    const refused = await poSession.tool(TOOL_NAMES.messagePobots, { to: "Ted", mode: "tell", text: "Po trying" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /belongs to another bot, and only that bot sends on it\. Your connections: Una\./);
    assert.match((await skifteSession.tool(TOOL_NAMES.messagePobots, { to: "Una", mode: "tell", text: "Not mine" })).content[0]!.text, /belongs to another bot.+Your connections: Ted\./);

    // Po's list shows the owner and never what was said.
    const listed = (await poSession.tool(TOOL_NAMES.listConnections)).content[0]!.text;
    assert.match(listed, /Ted \([^)]+\): connected\. Belongs to Skifte\./);
    assert.match(listed, /Una \([^)]+\): connected\. Belongs to Po\./);
    assert.doesNotMatch(listed, /packing|Thanks/i);

    // Po moves it to Kaja with a quiet line; Kaja's next session has the tool, Skifte's next has not.
    const moved = await poSession.tool(TOOL_NAMES.setConnection, { action: "owner", id: tedLink.id, owner: "kaja" });
    assert.equal(moved.isError, undefined, moved.content[0]!.text);
    assert.ok(notices(w, po.mainThreadId).includes("Connection Ted: belongs to Kaja now"));
    assert.equal(w.engine.links.list().connections.find(c => c.id === tedLink.id)?.owner, kaja.id);
    sessionOf(w, kaja.id)!.reply("Hi.");
    skifteSession.reply("Done.");
    await settle();
    w.engine.sendMessage({ botId: kaja.id, text: "Again" });
    w.engine.sendMessage({ botId: skifte.id, text: "Again" });
    await settle();
    assert.ok(sessionOf(w, kaja.id)!.toolNames().includes(TOOL_NAMES.messagePobots));
    assert.ok(!sessionOf(w, skifte.id)!.toolNames().includes(TOOL_NAMES.messagePobots));
    sessionOf(w, kaja.id)!.reply("Ok.");
    sessionOf(w, skifte.id)!.reply("Ok.");
    await settle();

    // Retired, its connection goes back to the main bot with a quiet line.
    w.engine.retireBot(kaja.id);
    assert.equal(w.engine.links.list().connections.find(c => c.id === tedLink.id)?.owner, po.id);
    assert.equal(w.store.links.rows().find(r => r.identity.invite.id === tedLink.id)?.owner, undefined);
    assert.ok(notices(w, po.mainThreadId).includes("Connection Ted: belongs to Po again, because Kaja was retired"));
  } finally { w.close(); }
});

test("a resting owner holds its messages without blocking others, a gone owner falls back once, and an owner change ends the old owner's waiting ask", async () => {
  const w = world();
  try {
    const po = w.engine.createBot("Po");
    const skifte = w.engine.createBot({ name: "Skifte", purpose: "Private errands" });
    const ted = w.other("Ted");
    const una = w.other("Una");
    const tedLink = await pairWith(w, ted, "Ted", skifte.id);
    const unaLink = await pairWith(w, una, "Una");

    // On vacation: Ted's messages wait, unseen, even past the 50 the inbox reads at once; Una's still arrive.
    w.engine.setVacation({ botId: skifte.id, vacation: true });
    for (let i = 0; i < 55; i++) {
      w.store.links.receive(tedLink.id, { id: randomUUID(), kind: "tell", text: `Waiting ${i + 1}`, at: w.now() }, randomUUID(), w.now());
    }
    w.step(1_300);
    assert.equal((await una.links.message("Robin", "tell", "Hello from Una")).delivery, "queued");
    await stepUntil(w, () => fromConnection(w, po.mainThreadId).some(i => i.text === "Hello from Una"));
    assert.equal(fromConnection(w, skifte.mainThreadId).length, 0);
    assert.equal(fromConnection(w, po.mainThreadId).filter(i => i.text.startsWith("Waiting")).length, 0, "the main bot does not get them either");
    // Back: they arrive in Skifte's chat.
    w.engine.setVacation({ botId: skifte.id, vacation: false });
    await stepUntil(w, () => fromConnection(w, skifte.mainThreadId).length >= 50);
    await stepUntil(w, () => fromConnection(w, skifte.mainThreadId).length === 55);

    // An ask Skifte sent stops waiting when the connection moves to Po; the later answer goes to Po.
    // (Past the hour, so the 55 above no longer count toward Ted's hourly limit.)
    w.step(3_700_000);
    await stepUntil(w, () => w.engine.links.list().connections.every(c => c.state === "connected"));
    await settle();
    let session = sessionOf(w, skifte.id)!;
    while (w.engine.bot(skifte.id).busy) { session.reply("Read."); await settle(); session = sessionOf(w, skifte.id)!; }
    w.engine.sendMessage({ botId: skifte.id, text: "Ask Ted" });
    await settle();
    session = sessionOf(w, skifte.id)!;
    const asking = session.tool(TOOL_NAMES.messagePobots, { to: "Ted", mode: "ask", text: "When do we leave?" });
    await until(() => ted.got.some(m => m.text === "When do we leave?"));
    w.engine.links.change({ action: "owner", id: tedLink.id, owner: po.id });
    const told = await asking;
    assert.match(told.content[0]!.text, /has not answered yet/);
    const question = ted.got.find(m => m.text === "When do we leave?")!;
    ted.links.reply(tedLink.theirs, question.id, "At eight.");
    w.step(1_300);
    await stepUntil(w, () => fromConnection(w, po.mainThreadId).some(i => i.text === "At eight." && i.from.type === "connection" && i.from.mode === "answer"));
    assert.ok(!fromConnection(w, skifte.mainThreadId).some(i => i.text === "At eight."));

    // A bot that is gone without a retire (its folder went): the main bot takes the messages and is told once.
    w.engine.links.change({ action: "owner", id: unaLink.id, owner: skifte.id });
    w.engine.bots.delete(skifte.id);
    w.engine.order = w.engine.order.filter(id => id !== skifte.id);
    for (const text of ["First after", "Second after"]) {
      w.step(1_300);
      assert.equal((await una.links.message("Robin", "tell", text)).delivery, "queued");
    }
    await stepUntil(w, () => fromConnection(w, po.mainThreadId).some(i => i.text === "Second after"));
    assert.equal(notices(w, po.mainThreadId).filter(t => t.startsWith("Connection Una: its bot is gone")).length, 1);
    assert.equal(w.engine.links.list().connections.find(c => c.id === unaLink.id)?.owner, po.id);
  } finally { w.close(); }
});
