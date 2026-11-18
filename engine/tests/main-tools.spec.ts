// The main bot can change and set up anything (docs/build/step-main-bot-tools.md, docs/main-bot.md):
// update_bot at once with one quiet line per bot per turn in its chat (no card), more access on a card and nothing else, get_bot,
// bot_files, the trigger additions, Pobots' tasks, and that a bot that is not the main bot reaches none
// of it. Stand-in harness, no model.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Card, Events, NoteCard, NoticeItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { TIDY_REFUSAL } from "../engine.js";
import { gitAvailable } from "../history.js";
import { buildTools, type TeamHost } from "../team.js";
import { type Ev, type FakeSession, settle, setup } from "./fake.js";
import { tempDir } from "./helpers.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const added = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);
const approvals = (events: Ev[]) => added(events).filter((c): c is ApprovalCard => c.kind === "approval");
const notes = (events: Ev[]) => added(events).filter((c): c is NoteCard => c.kind === "note");
/** The quiet lines in a chat: notices, as "Started fresh" is. */
const lines = (events: Ev[], threadId: string) =>
  events
    .filter((e) => e.event === "item.upsert")
    .map((e) => (e.data as Events["item.upsert"]).item)
    .filter((i): i is NoticeItem => i.kind === "notice" && i.threadId === threadId && i.tone === "info" && !i.mark && !/cut short|^Stopped/.test(i.text));
const open = (events: Ev[]): Card[] => {
  const gone = new Set(events.filter((e) => e.event === "card.removed").map((e) => (e.data as Events["card.removed"]).cardId));
  return added(events).filter((c) => !gone.has(c.id));
};

/** A main bot Po in a turn, and another bot Kaja at rest. */
async function world(extra: Parameters<typeof setup>[3] = {}) {
  const w = setup(undefined, undefined, undefined, extra);
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", purpose: "Writes the weekly note", job: "Write the weekly note." });
  w.engine.sendMessage({ botId: kaja.id, text: "hi" });
  await settle();
  const ks = w.sessions.find((s) => s.settings.botId === kaja.id)!;
  ks.reply("ok");
  await settle();
  w.engine.sendMessage({ botId: po.id, text: "Go" });
  await settle();
  const ps = w.sessions.find((s) => s.settings.botId === po.id)!;
  const endTurn = async (s: FakeSession = ps) => {
    s.reply("Done.");
    await settle();
  };
  return { ...w, po, kaja, ps, ks, endTurn };
}

describe("the main bot's tools: update_bot", () => {
  test("small changes happen at once; one quiet line in the main bot's chat for the turn's changes to one bot, from what to what, and no card", async () => {
    const w = await world();
    const was = w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.look;
    const eyes = was.eyes === "wide" ? "tall" : "wide";
    const gap = was.gap === "far" ? "near" : "far";
    const color = was.color === "teal" ? "rose" : "teal";
    const r1 = await w.ps.tool("update_bot", { bot: "Kaja", purpose: "Writes the Friday note", color, eyes, eye_gap: gap });
    assert.match(text(r1), /^Changed Kaja, and the person has a note about it:/);
    const r2 = await w.ps.tool("update_bot", { bot: "kaja", name: "Kajsa", effort: "high" });
    assert.match(text(r2), /name from Kaja to Kajsa/);
    const bot = w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!;
    assert.deepEqual([bot.id, bot.name, bot.purpose, bot.effort, bot.look.eyes, bot.look.gap, bot.look.color], ["kaja", "Kajsa", "Writes the Friday note", "high", eyes, gap, color], "the id stays");
    // The window hears of it at once.
    assert.ok(w.events.some((e) => e.event === "bot.updated" && (e.data as Events["bot.updated"]).bot.name === "Kajsa"));
    assert.equal(approvals(w.events).length, 0, "no card");
    assert.equal(lines(w.events, w.po.mainThreadId).length, 0, "the line waits for the end of the turn");
    await w.endTurn();
    const n = lines(w.events, w.po.mainThreadId);
    assert.equal(n.length, 1);
    assert.equal(
      n[0]!.text,
      `Kaja: purpose from "Writes the weekly note" to "Writes the Friday note"; colour from ${was.color} to ${color}; eyes from ${was.eyes} to ${eyes}; gap between the eyes from ${was.gap} to ${gap}; name from Kaja to Kajsa; effort from medium to high`,
    );
    assert.equal(n[0]!.turnId, undefined, "after the turn, not folded into it");
    // Nothing under "Needs you": no note card, no card at all.
    assert.equal(added(w.events).length, 0, "no card");
    assert.equal(lines(w.events, w.kaja.mainThreadId).filter((l) => /purpose/.test(l.text)).length, 0, "not in Kaja's chat");
    w.engine.shutdown();
    w.store.close();
  });

  test("a turn cut short by Pobots stopping still tells the person", async () => {
    const w = await world();
    await w.ps.tool("update_bot", { bot: "Kaja", purpose: "Cut short" });
    assert.equal(lines(w.events, w.po.mainThreadId).length, 0);
    w.engine.shutdown();
    assert.ok(lines(w.events, w.po.mainThreadId).some((l) => l.text === 'Kaja: purpose from "Writes the weekly note" to "Cut short"'));
    assert.equal(notes(w.events).length, 0);
    w.store.close();
  });

  test("raising access makes a card and nothing else does; the rest is done first; lowering is at once", async () => {
    const w = await world();
    const pending = w.ps.tool("update_bot", { bot: "Kaja", purpose: "More", access: "full-access" });
    await settle();
    // The purpose is changed already; only the raise waits.
    assert.equal(w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.purpose, "More");
    const cards = approvals(w.events);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.title, "Give Kaja more access?");
    assert.equal(cards[0]!.caption, "More access");
    assert.equal(cards[0]!.noAlways, true);
    assert.match(cards[0]!.detail, /^Kaja: from Asks first to Full access\./);
    assert.equal(w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.access, "asks-first");
    w.engine.resolveCard(cards[0]!.id, { type: "deny" });
    assert.match(text(await pending), /The person said no, so the access was not raised/);
    assert.equal(w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.access, "asks-first");
    // Allowed: raised.
    const again = w.ps.tool("update_bot", { bot: "Kaja", access: "edits-freely" });
    await settle();
    w.engine.resolveCard(approvals(w.events).at(-1)!.id, { type: "allow-once" });
    assert.match(text(await again), /The person allowed it: Kaja is on Edits freely now\./);
    assert.equal(w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.access, "edits-freely");
    // Lowering: no card.
    const before = approvals(w.events).length;
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", access: "asks-first" })), /access from Edits freely to Asks first/);
    assert.equal(approvals(w.events).length, before);
    // Its own access, raised: a card too.
    const self = w.ps.tool("update_bot", { bot: "Po", access: "decides-itself" });
    await settle();
    assert.equal(approvals(w.events).at(-1)!.title, "Give Po more access?");
    w.engine.resolveCard(approvals(w.events).at(-1)!.id, { type: "deny" });
    await self;
    await w.endTurn();
    assert.equal(lines(w.events, w.po.mainThreadId).at(-1)!.text, 'Kaja: purpose from "Writes the weekly note" to "More"; access from Asks first to Edits freely, as you allowed; access from Edits freely to Asks first');
    assert.deepEqual(added(w.events).map((c) => c.kind), ["approval", "approval", "approval"], "only the access cards, no note card");
    w.engine.shutdown();
    w.store.close();
  });

  test("create_bot on asks-first makes no card; above it starts on asks-first and asks", async () => {
    const w = await world();
    assert.match(text(await w.ps.tool("create_bot", { name: "Inbox", purpose: "Mail", job: "Sort mail." })), /^Created Inbox \(id inbox\)/);
    assert.equal(approvals(w.events).length, 0);
    const p = w.ps.tool("create_bot", { name: "Runner", purpose: "Runs", job: "Run.", access: "full-access" });
    await settle();
    assert.equal(w.engine.snapshot().bots.find((b) => b.id === "runner")!.access, "asks-first", "made before the card, on asks-first");
    assert.equal(approvals(w.events).at(-1)!.title, "Give Runner more access?");
    w.engine.resolveCard(approvals(w.events).at(-1)!.id, { type: "deny" });
    assert.match(text(await p), /It starts on Asks first; Full access was asked on a card\. The person said no/);
    await w.endTurn();
    const made = lines(w.events, w.po.mainThreadId).map((l) => l.text);
    assert.deepEqual(made.map((t) => t.split(":")[0]).sort(), ["New bot Inbox", "New bot Runner"]);
    assert.match(made.find((t) => t.startsWith("New bot Inbox"))!, /^New bot Inbox: purpose "Mail"; .+, .+ effort.*; access Asks first; may message only the main bot; job written \(about 2 words\)$/);
    assert.equal(notes(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("forget_rules, start_fresh and the refusals", async () => {
    const w = await world();
    w.store.addRule(w.kaja.id, "Bash(ls:*)");
    w.store.addRule(w.kaja.id, "Read");
    const ids = w.engine.listRules(w.kaja.id).map((r) => r.id);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", forget_rules: ["nope"] })), /no rule with the id nope/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", forget_rules: [ids[0]!] })), /forgot the Always allowed rule/);
    assert.equal(w.engine.listRules(w.kaja.id).length, 1);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", forget_rules: ["all"] })), /forgot/);
    assert.equal(w.engine.listRules(w.kaja.id).length, 0);
    // A fresh start for a bot at rest with a session; refused for itself while it works.
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", start_fresh: true })), /started a fresh session/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", start_fresh: true })), /already writing down what matters|working/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Po", start_fresh: true })), /cannot start yourself fresh while you work/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Nobody", purpose: "x" })), /no bot called Nobody/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja" })), /Nothing would change/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Po", may_message: ["Kaja"] })), /may message every bot already/);
    assert.equal(approvals(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("retire_bot: at once, a note, and the main bot cannot be retired", async () => {
    const w = await world();
    assert.match(text(await w.ps.tool("retire_bot", { bot: "Po" })), /main bot cannot be retired/);
    assert.match(text(await w.ps.tool("retire_bot", { bot: "Kaja" })), /^Retired Kaja\./);
    assert.ok(!w.engine.snapshot().bots.some((b) => b.id === w.kaja.id));
    assert.equal(approvals(w.events).length, 0);
    await w.endTurn();
    assert.equal(lines(w.events, w.po.mainThreadId).at(-1)!.text, 'Retired Kaja: purpose was "Writes the weekly note"; its folder is in the archive and its chat is kept');
    assert.equal(notes(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("the main bot's tools: get_bot and bot_files", () => {
  test("get_bot shows settings, rules, files, history and artifacts; a tidy turn may use it", async () => {
    const w = await world();
    w.store.addRule(w.kaja.id, "Bash(ls:*)");
    const out = text(await w.ps.tool("get_bot", { bot: "Kaja", parts: ["settings", "rules", "files", "history", "artifacts"] }));
    assert.match(out, /^Kaja \(id kaja\)\. Now: /);
    assert.match(out, /Purpose: Writes the weekly note\./);
    assert.match(out, /Access: Asks first \(asks-first\)\./);
    assert.match(out, /Job \(the 'Your job' part of AGENTS\.md\): Write the weekly note\./);
    assert.match(out, /Always allowed rules .*\n- .+: /);
    assert.match(out, /- AGENTS\.md \(/);
    assert.match(out, /Artifacts: none\./);
    if (gitAvailable()) assert.match(out, /Recent changes, newest first/);
    assert.match(text(await w.ps.tool("get_bot", { bot: "Nobody" })), /no bot called Nobody/);
    // Without a reader the inventory cannot be read: said in plain words, the choice still shown.
    assert.match(text(await w.ps.tool("get_bot", { bot: "Kaja", parts: ["sees"] })), /Kaja sees everything\.\nWhat exists could not be read/);
    w.engine.shutdown();
    w.store.close();
  });

  test("bot_files: list, read, write, delete, history, show_change and undo, in that bot's history with the main bot's name; Pobots' own files refused", async () => {
    const w = await world();
    assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "list" })), /- AGENTS\.md/);
    const read = text(await w.ps.tool("bot_files", { bot: "Kaja", action: "read", path: "memory/MEMORY.md" }));
    const rev = read.match(/rev (\S+?):/)![1]!;
    const wrote = await w.ps.tool("bot_files", { bot: "Kaja", action: "write", path: "memory/MEMORY.md", text: "# Memory\n\n- Likes Fridays.\n", base_rev: rev });
    assert.match(text(wrote), /^Saved memory\/MEMORY\.md \(rev .+\) in Kaja's folder\./);
    assert.equal(readFileSync(join(w.dirs.botsDir, w.kaja.id, "memory", "MEMORY.md"), "utf8"), "# Memory\n\n- Likes Fridays.\n");
    assert.ok(w.events.some((e) => e.event === "bot.files.changed" && (e.data as Events["bot.files.changed"]).botId === w.kaja.id));
    // The old rev no longer matches.
    assert.ok((await w.ps.tool("bot_files", { bot: "Kaja", action: "write", path: "memory/MEMORY.md", text: "x", base_rev: rev })).isError);
    assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "write", path: "notes.md", text: "A note.\n" })), /Saved notes\.md/);
    assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "delete", path: "notes.md" })), /Removed notes\.md/);
    assert.ok(!existsSync(join(w.dirs.botsDir, w.kaja.id, "notes.md")));
    // Pobots' own files and the job's removal are refused, as in the window.
    for (const path of ["bot.json", "CLAUDE.md", ".git/config", ".hidden"]) {
      const r = await w.ps.tool("bot_files", { bot: "Kaja", action: "write", path, text: "x" });
      assert.ok(r.isError, `${path} written`);
    }
    assert.ok((await w.ps.tool("bot_files", { bot: "Kaja", action: "delete", path: "AGENTS.md" })).isError);
    assert.ok((await w.ps.tool("bot_files", { bot: "Kaja", action: "read", path: "../po/AGENTS.md" })).isError, "no way out of the folder");
    if (gitAvailable()) {
      const hist = text(await w.ps.tool("bot_files", { bot: "Kaja", action: "history" }));
      assert.match(hist, /: Po removed notes\.md \(/);
      assert.match(hist, /: Po edited memory\/MEMORY\.md \(/);
      const change = w.engine.history({ botId: w.kaja.id }).changes.find((c) => c.summary === "Po edited memory/MEMORY.md")!;
      assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "show_change", change: change.id.slice(0, 12) })), /Likes Fridays/);
      assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "undo", change: change.id })), /^Undid: Po edited memory\/MEMORY\.md\./);
      assert.doesNotMatch(readFileSync(join(w.dirs.botsDir, w.kaja.id, "memory", "MEMORY.md"), "utf8"), /Likes Fridays/);
    }
    assert.equal(approvals(w.events).length, 0);
    await w.endTurn();
    const n = lines(w.events, w.po.mainThreadId);
    assert.equal(n.length, 1, "one line for the turn's file changes to Kaja");
    assert.match(n[0]!.text, /^Kaja: edited memory\/MEMORY\.md; added notes\.md; removed notes\.md/);
    if (gitAvailable()) assert.match(n[0]!.text, /; undid "Po edited memory\/MEMORY\.md"$/);
    assert.equal(notes(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("bot_files removes an artifact from the list, the file stays", async () => {
    const w = await world();
    const dir = join(w.dirs.botsDir, w.kaja.id, "artifacts", "status");
    (await import("node:fs")).mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Status page</title><p>ok</p>");
    const ksTools = w.ks.settings.tools.find((t) => t.name === "show_artifact")!;
    await ksTools.handler({ path: "artifacts/status/index.html" });
    assert.equal(w.engine.listArtifacts(w.kaja.id).length, 1);
    assert.match(text(await w.ps.tool("bot_files", { bot: "Kaja", action: "remove_artifact", path: "artifacts/status/index.html" })), /Took Status page off Kaja's list/);
    assert.equal(w.engine.listArtifacts(w.kaja.id).length, 0);
    assert.ok(existsSync(join(dir, "index.html")));
    w.engine.shutdown();
    w.store.close();
  });
});

describe("the main bot's tools: triggers and Pobots", () => {
  test("run_now, runs, and a webhook's new address at once; the address only in the answer", async () => {
    const w = await world();
    const made = text(await w.ps.tool("set_schedule", { bot: "Kaja", name: "Weekly", prompt: "Write the weekly note.", schedule: { type: "daily", time: "09:00", days: ["fri"] }, enabled: false, run_now: true }));
    assert.match(made, /It is switched off\. It runs now\./);
    const t = w.engine.listTriggers(w.kaja.id)[0]!;
    await settle();
    const runs = text(await w.ps.tool("list_triggers", { bot: "Kaja", runs: t.id }));
    assert.match(runs, /The last runs of Weekly, newest first:\n- (running|done)/);
    // A webhook: made at once, a new address at once. Each address goes back to the main bot in the
    // answer (to set up the sender) and nowhere else (webhooks.spec.ts checks notes, items and the log).
    const hookMade = text(await w.ps.tool("set_webhook", { bot: "Kaja", name: "Form", prompt: "Read the form." }));
    const hook = w.engine.listTriggers(w.kaja.id).find((x) => x.kind === "webhook")!;
    const first = w.engine.triggerAddress(hook.id).hookPath;
    const renewed = text(await w.ps.tool("set_webhook", { bot: "Kaja", id: hook.id, new_address: true }));
    const second = w.engine.triggerAddress(hook.id).hookPath;
    assert.notEqual(first, second);
    assert.match(renewed, /new address now; the old one no longer works/);
    assert.ok(hookMade.includes(first) && renewed.includes(second) && !renewed.includes(first.split("/")[3]!), "each address in its own answer");
    for (const secret of [first, second].map((p) => p.split("/")[3]!)) assert.ok(!JSON.stringify(w.events).includes(secret), "no address in an event");
    assert.equal(w.engine.hookTarget(hook.id, first.split("/")[3]!), undefined, "the old address stopped");
    assert.equal(approvals(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("get_settings shows the backup, devices and usage; run_pobots_task says why a backup cannot run and starts an update with the stand-in", async () => {
    const w = await world();
    const s = text(await w.ps.tool("get_settings", {}));
    assert.match(s, /Add a 1Password reference in Settings/);
    assert.match(s, /Notification devices: none\./);
    assert.match(s, /Usage: /);
    assert.match(text(await w.ps.tool("get_settings", { fresh: true })), /Backup: /);
    assert.match(text(await w.ps.tool("run_pobots_task", { task: "back_up_now" })), /No backup password reference is set|Install restic/);
    assert.match(text(await w.ps.tool("run_pobots_task", { task: "test_notification" })), /No device takes notifications/);
    // No provider has an update in the stand-in: said plainly, nothing runs.
    const up = await w.ps.tool("run_pobots_task", { task: "update_providers" });
    assert.ok(up.isError);
    assert.match(text(up), /up to date/);
    assert.equal(approvals(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("times in the engine's own time zone (the tester's walk: the backup an hour off)", () => {
  test("get_settings, get_bot, bot_files history and list_triggers runs say times as the window does, never bare UTC", async () => {
    // 14:50 UTC is 15:50 in Stockholm; the next backup at 03:00 there is 02:00 UTC.
    const at = Date.parse("2026-11-15T14:50:00Z");
    const w = await world({
      clock: () => at,
      timeZone: "Europe/Stockholm",
      backupConfig: { folder: tempDir("pobots-cloud-"), time: "03:00", executable: process.execPath },
      settingsHub: {
        fetcher: async () => ({ ok: false, status: 404, text: async () => "" }),
        runner: async () => ({ ok: false, out: "" }),
        readClaude: async () => ({ id: "c", via: "This Mac", windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40, resetsAt: "2026-11-15T17:00:00.000Z" }] }),
        readCodex: async () => ({ id: "x", via: "This Mac", windows: [] }),
      },
    });
    w.engine.setBackupPasswordRef("op://Example/Pobots/password");
    const isoTime = /\d{4}-\d\d-\d\dT\d\d:\d\d/;
    const s = text(await w.ps.tool("get_settings", { fresh: true }));
    assert.match(s, /^It is now Sunday 15 Nov 2026 15:50 \(time zone Europe\/Stockholm\)/);
    assert.match(s, /Every night at 03:00/);
    assert.match(s, /Next tomorrow 03:00\./, "the next backup on the window's clock");
    assert.doesNotMatch(s, /02:00/, "never the UTC hour");
    assert.match(s, /Session 40% used, resets today 18:00/);
    // The hub reads on the real clock while the fake one says 15 Nov, so the words depend on today:
    // any of whenWords' forms ("today 16:30", "tomorrow ...", "Tuesday ...", "21 Nov ...", "21 Nov 2027 ...").
    assert.match(s, /Usage \(read (today|tomorrow|yesterday|(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{4})?) \d\d:\d\d\)/, "the hub reads on the real clock, said in words");
    assert.doesNotMatch(s, isoTime, "no bare UTC time");
    // A schedule run now: its run in list_triggers runs.
    await w.ps.tool("set_schedule", { bot: "Kaja", name: "Weekly", prompt: "Write the weekly note.", schedule: { type: "daily", time: "09:00", days: ["fri"] }, run_now: true });
    await settle();
    const t = w.engine.listTriggers(w.kaja.id)[0]!;
    const runs = text(await w.ps.tool("list_triggers", { bot: "Kaja", runs: t.id }));
    assert.match(runs, /^It is now Sunday 15 Nov 2026 15:50 \(time zone Europe\/Stockholm\)/);
    assert.match(runs, /\n- (running|done) today 15:50/);
    assert.doesNotMatch(runs, isoTime);
    const listed = text(await w.ps.tool("list_triggers", { bot: "Kaja" }));
    assert.match(listed, /Next run Friday 09:00\./);
    assert.doesNotMatch(listed, isoTime);
    // get_bot and bot_files: a file's time, a change's time and when the inventory was read.
    await w.ps.tool("bot_files", { bot: "Kaja", action: "write", path: "notes.md", text: "A note.\n" });
    const bot = text(await w.ps.tool("get_bot", { bot: "Kaja", parts: ["files", "history"] }));
    assert.match(bot, /Files \(times in Europe\/Stockholm\):\n/);
    assert.doesNotMatch(bot, isoTime);
    // Files and history are stamped on the real clock: their hour is Stockholm's wall time of it.
    const wall = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    const file = w.engine.listFiles(w.kaja.id).find((f) => f.path === "notes.md")!;
    assert.ok(bot.includes(`- notes.md (notes, 8 bytes, changed `) && new RegExp(`- notes\\.md \\(notes, 8 bytes, changed [^)]*${wall(file.modifiedAt)}\\)`).test(bot), bot);
    if (gitAvailable()) {
      const change = w.engine.history({ botId: w.kaja.id }).changes[0]!;
      assert.match(bot, new RegExp(`: Po added notes\\.md \\([^,]*${wall(change.at)}, by `));
      const hist = text(await w.ps.tool("bot_files", { bot: "Kaja", action: "history" }));
      assert.match(hist, /times in Europe\/Stockholm/);
      assert.match(hist, new RegExp(`\\([^,]*${wall(change.at)}, by `));
      assert.doesNotMatch(hist, isoTime);
      const shown = text(await w.ps.tool("bot_files", { bot: "Kaja", action: "show_change", change: change.id }));
      assert.match(shown, new RegExp(`^Po added notes\\.md \\([^)]*${wall(change.at)}\\)`));
    }
    w.engine.shutdown();
    w.store.close();
  });
});

describe("no tool returns a secret", () => {
  test("hub key, address for answers, channel addresses and webhook addresses it did not ask for: in no answer of the main bot's tools", async () => {
    const w = await world();
    const key = "hub-key-for-the-check-7f3a9c";
    w.engine.usageHubAdd({ url: "https://hub.example.net:8443", key });
    const ch = w.engine.saveChannel({ channel: { name: "Ops", replyUrl: "https://flow.example.com/answers?sig=reply-secret-41b2", routes: [{ tag: "Kaja", botId: w.kaja.id }] } });
    const hook = w.engine.saveTrigger({ botId: w.kaja.id, trigger: { kind: "webhook", name: "Hook", prompt: "Go.", where: "main", enabled: true } });
    const secrets = [key, "reply-secret-41b2", w.engine.channelAddress(ch.id).hookPath.split("/")[3]!, w.engine.triggerAddress(hook.id).hookPath.split("/")[3]!];
    const answers: string[] = [];
    const call = async (name: string, args: Record<string, unknown> = {}) => answers.push(text(await w.ps.tool(name, args)));
    await call("get_settings", { fresh: true });
    await call("list_channels");
    await call("list_triggers", { bot: "Kaja" });
    await call("get_bot", { bot: "Kaja", parts: ["settings", "sees", "rules", "files", "history", "artifacts"] });
    await call("bot_files", { bot: "Kaja", action: "list" });
    await call("update_channel", { channel: "Ops", context_count: 2 });
    await call("update_channel", { channel: "Ops", new_address: true });
    await call("set_channel_route", { channel: "Ops", tag: "Po", bot: "Po" });
    secrets.push(w.engine.channelAddress(ch.id).hookPath.split("/")[3]!);
    // A webhook's address goes to the bot that makes it, gives it a new one or asks for it again
    // (decision of 12 Nov 2026), and then only in that answer, never in an event or a note.
    const given: string[] = [];
    given.push(text(await w.ps.tool("set_webhook", { bot: "Kaja", id: hook.id, new_address: true })));
    given.push(text(await w.ps.tool("set_webhook", { bot: "Kaja", name: "Another", prompt: "Go." })));
    const hookSecrets = w.engine.listTriggers(w.kaja.id).filter((t) => t.kind === "webhook").map((t) => w.engine.triggerAddress(t.id).hookPath.split("/")[3]!);
    await w.endTurn();
    const everything = [...answers, JSON.stringify(w.events)].join("\n");
    for (const secret of secrets) assert.ok(!everything.includes(secret), `a secret came back: ${secret.slice(0, 6)}...`);
    for (const secret of hookSecrets) {
      assert.ok(given.some((g) => g.includes(secret)), "the webhook's address went to the bot that made it");
      assert.ok(!everything.includes(secret), `a webhook address came back elsewhere: ${secret.slice(0, 6)}...`);
    }
    w.engine.shutdown();
    w.store.close();
  });
});

describe("what a bot that is not the main bot can reach", () => {
  test("none of the main bot's tools, and its own triggers only; change_what_i_see on either model", async () => {
    const w = await world();
    const names = w.ks.toolNames();
    for (const t of ["get_bot", "create_bot", "update_bot", "retire_bot", "bot_files", "set_channel_route", "remove_channel_route", "update_channel", "get_settings", "change_settings", "run_pobots_task", "activity_log"]) {
      assert.ok(!names.includes(t), `${t} given to a bot that is not the main bot`);
    }
    assert.ok(names.includes("change_what_i_see"));
    assert.ok(!w.ps.toolNames().includes("change_what_i_see"), "the main bot uses update_bot");
    for (const t of ["set_schedule", "set_webhook", "webhook_address", "list_triggers", "remove_trigger"]) {
      const shape = w.ks.settings.tools.find((x) => x.name === t)!.shape;
      assert.ok(!("bot" in shape) && !("run_now" in shape) && !("new_address" in shape) && !("runs" in shape), `${t} reaches another bot`);
    }
    assert.match(text(await w.ks.tool("set_schedule", { bot: "Po", name: "x", prompt: "y", schedule: { type: "daily", time: "09:00", days: ["mon"] } })), /Only the main bot/);
    assert.match(text(await w.ks.tool("set_webhook", { name: "x", prompt: "y", run_now: true })), /Only the main bot can do that/);
    // A bot on a GPT model has change_what_i_see too (engine 0.27.0); the main bot on neither.
    const host = new Proxy({}, { get: () => () => "" }) as unknown as TeamHost;
    assert.ok(buildTools("bot", host, { harness: "codex", models: [] }).some((t) => t.name === "change_what_i_see"));
    assert.ok(!buildTools("main", host, { harness: "codex", models: [] }).some((t) => t.name === "change_what_i_see"));
    assert.ok(buildTools("bot", host, { harness: "claude", models: [] }).some((t) => t.name === "change_what_i_see"));
    w.engine.shutdown();
    w.store.close();
  });

  test("a tidy turn refuses every changing tool and allows get_bot", async () => {
    const w = await world();
    await w.endTurn();
    assert.deepEqual(w.engine.startFresh(w.po.id), { started: true });
    await settle();
    const ps = w.sessions.filter((s) => s.settings.botId === w.po.id).at(-1)!;
    for (const [name, args] of [
      ["update_bot", { bot: "Kaja", purpose: "x" }],
      ["create_bot", { name: "X", purpose: "", job: "y" }],
      ["bot_files", { bot: "Kaja", action: "write", path: "a.md", text: "x" }],
      ["run_pobots_task", { task: "back_up_now" }],
      ["retire_bot", { bot: "Kaja" }],
      ["webhook_address", { bot: "Kaja", id: "x" }],
    ] as const) {
      assert.equal(text(await ps.tool(name, args)), TIDY_REFUSAL, name);
    }
    assert.match(text(await ps.tool("get_bot", { bot: "Kaja" })), /^Kaja \(id kaja\)/);
    void open;
    w.engine.shutdown();
    w.store.close();
  });
});
