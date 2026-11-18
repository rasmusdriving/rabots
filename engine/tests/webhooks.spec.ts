// Webhooks a bot can make (docs/build/step-2g.md, A6). No model. Since docs/build/step-main-bot-tools.md
// the main bot's webhooks and webhook_address happen at once with a note for the person; the address
// still goes to the bot (decision of 12 Nov 2026) and nowhere else.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Events, NoteCard } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { TIDY_REFUSAL } from "../engine.js";
import { MAX_TRIGGERS } from "../triggers.js";
import { changeLines, type Ev, type FakeSession, settle, setup } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const cards = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card as ApprovalCard);
const approvals = (events: Ev[]) => cards(events).filter((c) => c.kind === "approval");
const notes = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).filter((c): c is NoteCard => c.kind === "note");
const secretOf = (hookPath: string) => hookPath.split("/")[3]!;

async function hookWorld() {
  const w = setup();
  w.engine.setLocalBase("http://127.0.0.1:47999");
  const po = w.engine.createBot("Po");
  const inbox = w.engine.createBot("Inbox");
  w.engine.sendMessage({ botId: po.id, text: "Go" });
  w.engine.sendMessage({ botId: inbox.id, text: "Go" });
  await settle();
  const ps = w.sessions.find((s) => s.settings.botId === po.id)!;
  const is = w.sessions.find((s) => s.settings.botId === inbox.id)!;
  return { ...w, po, inbox, ps, is };
}

/** Calls a tool as the harness would: the call's line of work, the tool, then its result. */
async function call(s: FakeSession, name: string, args: Record<string, unknown>, answer?: (card: ApprovalCard) => void, events?: Ev[]): Promise<ToolResult> {
  const id = `tu-${Math.random()}`;
  s.emit({ type: "tool-start", toolUseId: id, name: `mcp__pobots__${name}`, input: args });
  const before = events ? cards(events).length : 0;
  const p = s.tool(name, args);
  if (answer && events) {
    await settle();
    const added = cards(events).slice(before);
    assert.equal(added.length, 1, "one card");
    answer(added[0]!);
  }
  const r = await p;
  s.emit({ type: "tool-end", toolUseId: id, isError: !!r.isError, text: text(r), full: text(r) });
  return r;
}

/** Collects what the engine writes to stderr while `fn` runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; log: string }> {
  const original = process.stderr.write.bind(process.stderr);
  const prev = process.env.POBOTS_LOG;
  process.env.POBOTS_LOG = "info";
  let log = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    log += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), log };
  } finally {
    process.stderr.write = original;
    process.env.POBOTS_LOG = prev;
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.size < 5_000_000) out.push(p);
  }
  return out;
}

describe("webhooks a bot can make", () => {
  test("a bot makes its own on a card; allowed, it gets the id and the address with plain rules, and the address lands nowhere else", async () => {
    const w = await hookWorld();
    assert.ok(w.is.toolNames().includes("set_webhook") && w.is.toolNames().includes("webhook_address"));
    assert.ok(!("bot" in w.is.settings.tools.find((t) => t.name === "set_webhook")!.shape), "a plain bot cannot name another bot");
    assert.match(w.is.settings.team, /set_schedule and set_webhook make or change them/);
    let card: ApprovalCard | undefined;
    const { result: made, log } = await captureLog(() =>
      call(w.is, "set_webhook", { name: "New ticket", prompt: "Sort the new ticket into the right queue." }, (c) => {
        card = c;
        w.engine.resolveCard(c.id, { type: "allow-once" });
      }, w.events),
    );
    assert.equal(card!.title, "Make a webhook for Inbox?");
    assert.equal(card!.detail, "Bot: Inbox\nName: New ticket\nTold: Sort the new ticket into the right queue.\nRuns: in its main chat, switched on\n\nInbox gets its address, to set up the sender for you.");
    assert.equal(card!.noAlways, true);
    assert.equal(card!.caption, "Webhook");
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    assert.equal(t.kind, "webhook");
    assert.equal(t.createdBy, "bot");
    assert.equal(t.madeByBotId, w.inbox.id);
    const { hookPath } = w.engine.triggerAddress(t.id);
    const secret = hookPath.split("/")[3]!;
    assert.equal(
      text(made),
      [
        `Made the webhook New ticket (id ${t.id}): runs in your main chat, switched on.`,
        "",
        `Address: http://127.0.0.1:47999${hookPath}`,
        "This is its local address: it only works on this computer, because Pobots has no public address set. Tell the person if the sender runs elsewhere.",
        "The address is a secret: anyone who has it can wake the bot. Use it only to set up the sender. Never write it in a chat message, a file, your memory, an artifact or a message to another bot.",
        "Senders POST JSON to it, with Content-Type: application/json.",
      ].join("\n"),
    );
    // Nowhere else: no event, no item (label or detail), no log line, no file of the bot, not in what the chat tools return.
    assert.ok(!JSON.stringify(w.events).includes(secret), "not in an event");
    const thread = w.store.readThread(w.inbox.mainThreadId, undefined, 500).items;
    assert.ok(!JSON.stringify(thread).includes(secret), "not in an item");
    const act = thread.filter((i) => i.kind === "activity").at(-1)!;
    assert.equal(act.kind === "activity" && act.label, "Asked to make the webhook New ticket");
    assert.ok(!log.includes(secret), "not in the log");
    for (const f of filesUnder(join(w.dirs.botsDir, w.inbox.id))) assert.ok(!readFileSync(f).includes(secret), `not in ${f}`);
    assert.ok(!text(await w.is.tool("search_chat", { query: "hook" })).includes(secret));
    assert.ok(!text(await w.is.tool("read_chat", { around: 1, count: 30 })).includes(secret));
    const listed = text(await w.is.tool("list_triggers"));
    assert.match(listed, /- New ticket \(id .+, webhook\)\. When its webhook is called by another system\./);
    assert.ok(!listed.includes(secret) && !listed.includes("/hook/"));
    // The address works: a call wakes the bot.
    assert.equal(w.engine.hookTarget(t.id, secret), "trigger");
    assert.equal(w.engine.hookCall(t.id, { has: true, value: { ticket: 1 } }).status, 202);
    w.engine.shutdown();
  });

  test("denied or put aside: the bot is told plainly and nothing is made", async () => {
    const w = await hookWorld();
    const no = await call(w.is, "set_webhook", { name: "Nope", prompt: "x" }, (c) => w.engine.resolveCard(c.id, { type: "deny" }), w.events);
    assert.equal(text(no), "The person said no, so no webhook was made. Do not try it another way.");
    const later = await call(w.is, "set_webhook", { name: "Later", prompt: "x" }, (c) => w.engine.resolveCard(c.id, { type: "later" }), w.events);
    assert.equal(text(later), "The person put this aside for later, so no webhook was made. Do not ask again right away.");
    assert.equal(w.engine.listTriggers(w.inbox.id).length, 0);
    // Always allow is not offered.
    const p = w.is.tool("set_webhook", { name: "X", prompt: "y" });
    await settle();
    const c = cards(w.events).at(-1)!;
    assert.throws(() => w.engine.resolveCard(c.id, { type: "always-allow" }));
    w.engine.resolveCard(c.id, { type: "deny" });
    await p;
    w.engine.shutdown();
  });

  test("a change: before and after on the card, and no address in the answer; the address stays the same", async () => {
    const w = await hookWorld();
    await call(w.is, "set_webhook", { name: "New ticket", prompt: "Sort it." }, (c) => w.engine.resolveCard(c.id, { type: "allow-once" }), w.events);
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    const before = w.engine.triggerAddress(t.id).hookPath;
    let card: ApprovalCard | undefined;
    const changed = await call(w.is, "set_webhook", { id: t.id, name: "New ticket", prompt: "Sort it and say who.", where: "fresh" }, (c) => {
      card = c;
      w.engine.resolveCard(c.id, { type: "allow-once" });
    }, w.events);
    assert.equal(card!.title, "Change the webhook New ticket?");
    assert.equal(card!.detail, "Bot: Inbox\n\nNow:\nName: New ticket\nTold: Sort it.\nRuns: in its main chat, switched on\n\nAfter the change:\nName: New ticket\nTold: Sort it and say who.\nRuns: as a fresh run, switched on");
    assert.equal(text(changed), `Changed the webhook New ticket (id ${t.id}): runs as a fresh run, switched on. Its address stays the same.`);
    assert.ok(!text(changed).includes("/hook/"));
    assert.equal(w.engine.triggerAddress(t.id).hookPath, before);
    // A schedule is changed with set_schedule, and the other way round.
    const sched = w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "schedule", name: "Daily", prompt: "Go.", where: "main", enabled: true, schedule: { type: "daily", time: "09:00", days: ["mon"] } } });
    assert.equal(text(await w.is.tool("set_webhook", { id: sched.id, name: "X", prompt: "Y" })), "That one is a schedule. Change it with set_schedule.");
    w.engine.shutdown();
  });

  test("webhook_address: at once with a quiet line that names the bot and the webhook, never the address; a schedule has none", async () => {
    // It was on a card each time before the owner's decision of 15 Nov 2026 (no cards inside Pobots).
    const w = await hookWorld();
    await call(w.is, "set_webhook", { name: "New ticket", prompt: "Sort it." }, (c) => w.engine.resolveCard(c.id, { type: "allow-once" }), w.events);
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    const { hookPath } = w.engine.triggerAddress(t.id);
    const before = approvals(w.events).length;
    const got = await call(w.is, "webhook_address", { id: t.id }, undefined, w.events);
    assert.equal(approvals(w.events).length, before, "no card");
    assert.match(text(got), new RegExp(`^Address: http://127\\.0\\.0\\.1:47999${hookPath.replace(/[/]/g, "\\/")}\\n`));
    assert.match(text(got), /Never write it in a chat message, a file, your memory, an artifact or a message to another bot\./);
    const sched = w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "schedule", name: "Daily", prompt: "Go.", where: "main", enabled: true, schedule: { type: "daily", time: "09:00", days: ["mon"] } } });
    assert.equal(text(await w.is.tool("webhook_address", { id: sched.id })), "That one is a schedule, and a schedule has no address.");
    // With a public base, the public address, and it says so.
    (w.engine as unknown as { opts: { config: { publicBase?: string } } }).opts.config.publicBase = "https://mac.example.ts.net:10000";
    const pub = await call(w.is, "webhook_address", { id: t.id }, undefined, w.events);
    assert.match(text(pub), new RegExp(`^Address: https://mac\\.example\\.ts\\.net:10000${hookPath.replace(/[/]/g, "\\/")}\\nThis is its public address: it works from outside this computer\\.`));
    // The person's line comes when the turn ends, in Inbox's own chat: which bot got which webhook's address.
    assert.deepEqual(changeLines(w.events, w.inbox.mainThreadId), [], "gathered until the turn ends");
    w.is.reply("Done.");
    await settle();
    const said = changeLines(w.events, w.inbox.mainThreadId);
    assert.deepEqual(said, ["Inbox got the address of the webhook New ticket again, to set up its sender; Inbox got the address of the webhook New ticket again, to set up its sender"]);
    assert.ok(!said[0]!.includes(secretOf(hookPath)) && !said[0]!.includes("/hook/"), "no address in the line");
    assert.equal(notes(w.events).length, 0, "no note card");
    // A plain bot cannot give a webhook a new address; the address stays.
    assert.ok(!("new_address" in w.is.settings.tools.find((x) => x.name === "set_webhook")!.shape));
    assert.ok(!("bot" in w.is.settings.tools.find((x) => x.name === "webhook_address")!.shape));
    assert.equal(text(await w.is.tool("set_webhook", { id: t.id, new_address: true })), "Only the main bot can do that.");
    assert.equal(w.engine.triggerAddress(t.id).hookPath, hookPath);
    w.engine.shutdown();
  });

  test("the main bot makes one for another bot at once, with a quiet line, and gets its address; a plain bot cannot", async () => {
    // It was on a card before docs/build/step-main-bot-tools.md; now at once with a note.
    const w = await hookWorld();
    assert.ok("bot" in w.ps.settings.tools.find((t) => t.name === "set_webhook")!.shape);
    assert.ok("bot" in w.ps.settings.tools.find((t) => t.name === "webhook_address")!.shape);
    const before = approvals(w.events).length;
    const made = await call(w.ps, "set_webhook", { bot: "Inbox", name: "Form sent", prompt: "Read the form." }, undefined, w.events);
    assert.equal(approvals(w.events).length, before, "no card");
    assert.match(text(made), /^Made the webhook Form sent \(id .+\) for Inbox: runs in the main chat of Inbox, switched on\.\n\nAddress: /);
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    assert.ok(text(made).includes(w.engine.triggerAddress(t.id).hookPath));
    assert.equal(t.madeByBotId, w.po.id);
    assert.equal(t.createdBy, "bot");
    // Another bot's webhook address again, at once.
    const again = await call(w.ps, "webhook_address", { bot: "Inbox", id: t.id }, undefined, w.events);
    assert.match(text(again), /^Address: /);
    w.ps.reply("Done.");
    await settle();
    assert.deepEqual(changeLines(w.events, w.po.mainThreadId), [
      "Inbox: a new webhook Form sent, runs in its main chat, on; Po has its address, to set up the sender",
      "Po got the address of the webhook Form sent of Inbox again, to set up its sender",
    ]);
    assert.equal(notes(w.events).length, 0, "no note card");
    const n = cards(w.events).length;
    const refused = await w.is.tool("set_webhook", { bot: "Po", name: "Mine now", prompt: "x" });
    assert.equal(text(refused), "Only the main bot can work on another bot's schedules and webhooks.");
    assert.equal(text(await w.is.tool("webhook_address", { bot: "Po", id: t.id })), "Only the main bot can work on another bot's schedules and webhooks.");
    assert.equal(cards(w.events).length, n, "no card for a refusal");
    w.engine.shutdown();
  });

  test("a new address: the main bot gets it to change the sender; the quiet line says so; the old one stops", async () => {
    const w = await hookWorld();
    const hook = w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "webhook", name: "Form", prompt: "Go.", where: "main", enabled: true } });
    const first = w.engine.triggerAddress(hook.id).hookPath;
    const renewed = await call(w.ps, "set_webhook", { bot: "Inbox", id: hook.id, new_address: true }, undefined, w.events);
    const second = w.engine.triggerAddress(hook.id).hookPath;
    assert.notEqual(first, second);
    assert.match(text(renewed), /It has a new address now; the old one no longer works\. Change the sender to the new address\.\n\nAddress: /);
    assert.ok(text(renewed).includes(second) && !text(renewed).includes(secretOf(first)));
    assert.equal(w.engine.hookTarget(hook.id, secretOf(first)), undefined, "the old address stopped");
    w.ps.reply("Done.");
    await settle();
    assert.deepEqual(changeLines(w.events, w.po.mainThreadId), ["Inbox: the webhook Form has a new address and the old one no longer works, Po has the new one to change the sender"]);
    assert.equal(approvals(w.events).length, 0);
    w.engine.shutdown();
  });

  test("the address is in no line, no item of either chat, no event and no log line", async () => {
    const w = await hookWorld();
    const secrets: string[] = [];
    const { log } = await captureLog(async () => {
      await call(w.ps, "set_webhook", { bot: "Inbox", name: "Form", prompt: "Read the form." }, undefined, w.events);
      const t = w.engine.listTriggers(w.inbox.id)[0]!;
      secrets.push(secretOf(w.engine.triggerAddress(t.id).hookPath)); // the first address, given to Po
      await call(w.ps, "webhook_address", { bot: "Inbox", id: t.id }, undefined, w.events);
      await call(w.ps, "set_webhook", { bot: "Inbox", id: t.id, new_address: true }, undefined, w.events);
      await call(w.is, "webhook_address", { id: t.id }, undefined, w.events);
      w.ps.reply("Done.");
      w.is.reply("Done.");
      await settle();
    });
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    secrets.push(secretOf(w.engine.triggerAddress(t.id).hookPath)); // the new address
    assert.notEqual(secrets[0], secrets[1]);
    const said = [...changeLines(w.events, w.po.mainThreadId), ...changeLines(w.events, w.inbox.mainThreadId)];
    assert.ok(said.length >= 3, "the lines were written");
    const items = [w.po.mainThreadId, w.inbox.mainThreadId].map((id) => JSON.stringify(w.store.readThread(id, undefined, 500).items)).join("\n");
    const stored = JSON.stringify(w.store.listCards());
    for (const secret of secrets) {
      assert.ok(!JSON.stringify(said).includes(secret), "not in a line");
      assert.ok(!items.includes(secret), "not in an item of the chat");
      assert.ok(!stored.includes(secret), "not in a saved card");
      assert.ok(!JSON.stringify(w.events).includes(secret), "not in an event");
      assert.ok(!log.includes(secret), "not in the log");
    }
    assert.ok(!items.includes("/hook/") && !JSON.stringify(said).includes("/hook/"));
    const labels = w.store.readThread(w.po.mainThreadId, undefined, 500).items.filter((i) => i.kind === "activity").map((i) => i.kind === "activity" && i.label);
    assert.ok(labels.includes("Got the address of a webhook"), `activity lines: ${labels.join(", ")}`);
    w.engine.shutdown();
  });

  test("remove_trigger removes a webhook only on a card; an own schedule still goes without one", async () => {
    const w = await hookWorld();
    await call(w.is, "set_webhook", { name: "New ticket", prompt: "Sort it." }, (c) => w.engine.resolveCard(c.id, { type: "allow-once" }), w.events);
    const t = w.engine.listTriggers(w.inbox.id)[0]!;
    let card: ApprovalCard | undefined;
    const rm = await call(w.is, "remove_trigger", { id: t.id }, (c) => {
      card = c;
      w.engine.resolveCard(c.id, { type: "allow-once" });
    }, w.events);
    assert.equal(card!.title, "Remove the webhook New ticket?");
    assert.equal(card!.detail, "Bot: Inbox\nName: New ticket\nTold: Sort it.\nRuns: in its main chat\n\nIts address stops working.");
    assert.equal(text(rm), "Removed the webhook New ticket.");
    assert.equal(w.engine.listTriggers(w.inbox.id).length, 0);
    const sched = w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "schedule", name: "Daily", prompt: "Go.", where: "main", enabled: true, schedule: { type: "daily", time: "09:00", days: ["mon"] } } });
    const n = cards(w.events).length;
    assert.equal(text(await w.is.tool("remove_trigger", { id: sched.id })), "Removed Daily.");
    assert.equal(cards(w.events).length, n);
    w.engine.shutdown();
  });

  test("the limit of 20 triggers holds, before any card", async () => {
    const w = await hookWorld();
    for (let i = 0; i < MAX_TRIGGERS; i++) w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "webhook", name: `H${i}`, prompt: "Go.", where: "main", enabled: true } });
    const n = cards(w.events).length;
    const r = await w.is.tool("set_webhook", { name: "One more", prompt: "x" });
    assert.ok(r.isError);
    assert.equal(text(r), "A bot can have at most 20 triggers. Remove one first.");
    assert.equal(cards(w.events).length, n);
    w.engine.shutdown();
  });

  test("none of the three is allowed in a tidy turn", async () => {
    const w = await hookWorld();
    w.is.reply("Done.");
    await settle();
    const t = w.engine.saveTrigger({ botId: w.inbox.id, trigger: { kind: "webhook", name: "H", prompt: "Go.", where: "main", enabled: true } });
    assert.deepEqual(w.engine.startFresh(w.inbox.id), { started: true });
    await settle();
    const n = cards(w.events).length;
    for (const [name, args] of [
      ["set_webhook", { name: "X", prompt: "y" }],
      ["webhook_address", { id: t.id }],
      ["remove_trigger", { id: t.id }],
    ] as const) {
      const r = await w.is.tool(name, args);
      assert.equal(text(r), TIDY_REFUSAL, name);
    }
    assert.equal(cards(w.events).length, n);
    assert.equal(w.engine.listTriggers(w.inbox.id).length, 1);
    w.engine.shutdown();
  });
});
