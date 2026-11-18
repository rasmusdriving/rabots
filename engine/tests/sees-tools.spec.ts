// What a bot sees, through the bots' tools (docs/sees.md, docs/main-bot.md): the main bot's update_bot
// sees and get_bot sees, and change_what_i_see for a bot that is not the main bot. A stand-in reader,
// no real Claude, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Events, NoteCard, NoticeItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import type { RawSees } from "../claude/sees.js";
import { applySeesMoves } from "../core/sees-tools.js";
import { type SeesChange, seesShortText } from "../core/sees-words.js";
import { buildInventory } from "../claude/sees.js";
import { type Ev, settle, setup } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const notes = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).filter((c): c is NoteCard => c.kind === "note");
/** The quiet lines in a chat (notices without a mark), as the person reads them. */
const lines = (events: Ev[], threadId: string) =>
  events
    .filter((e) => e.event === "item.upsert")
    .map((e) => (e.data as Events["item.upsert"]).item)
    .filter((i): i is NoticeItem => i.kind === "notice" && i.threadId === threadId && i.tone === "info" && !i.mark)
    .map((i) => i.text);
const approvals = (events: Ev[]) => events.filter((e) => e.event === "card.added" && (e.data as Events["card.added"]).card.kind === "approval");

function raw(): RawSees {
  return {
    servers: [
      { name: "claude.ai Notion", status: "connected", source: "claudeai", tools: [{ name: "a" }] },
      { name: "ado", status: "connected", source: "user", scope: "user", tools: [{ name: "x" }] },
      { name: "plugin:1password:1password", status: "connected", source: "plugin", tools: [{ name: "p" }] },
    ],
    usage: {
      mcpTools: [
        { name: "mcp__claude_ai_Notion__search", serverName: "claude_ai_Notion", tokens: 900, isLoaded: false },
        { name: "mcp__ado__wiki", serverName: "ado", tokens: 300, isLoaded: true },
      ],
      mcpInstructions: [],
      skills: {
        skillFrontmatter: [
          { name: "code-review", source: "built-in", tokens: 280 },
          { name: "docs", source: "syncedSkills", tokens: 343 },
          { name: "design:ux-copy", source: "plugin", pluginName: "design", pluginId: "design@synced", tokens: 96 },
        ],
      },
    },
  };
}

async function world() {
  let reads = 0;
  const w = setup(undefined, undefined, undefined, { readSees: async () => (reads++, raw()) });
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot({ name: "Kaja", model: "claude-haiku-5-5" });
  w.engine.sendMessage({ botId: kaja.id, text: "hi" });
  await settle();
  const ks = w.sessions.find((s) => s.settings.botId === kaja.id)!;
  ks.reply("ok");
  await settle();
  w.engine.sendMessage({ botId: po.id, text: "Go" });
  await settle();
  const ps = w.sessions.find((s) => s.settings.botId === po.id)!;
  return { ...w, po, kaja, ps, ks, reads: () => reads };
}

describe("what a bot sees, through the tools: the moves", () => {
  test("names resolve to a service, a plugin or a skill by name or label; unknown names are refused with close ones", () => {
    const inv = buildInventory(raw(), "2026-11-15T10:00:00Z");
    const r = applySeesMoves(undefined, { switch_off: ["Notion", "design"], skills_by_name: ["docs"] }, inv);
    assert.ok(typeof r !== "string");
    assert.deepEqual(r.sees, { services: { rest: "on", except: ["claude.ai Notion"] }, plugins: { rest: "on", except: ["design@synced"] }, skills: { rest: "full", except: ["docs"] } });
    assert.deepEqual(r.lines, ["Notion off (was on)", "the design plugin off (was on)", "the skill docs by name only (was in full)"]);
    const bad = applySeesMoves(undefined, { switch_off: ["Notio"] }, inv);
    assert.equal(typeof bad, "string");
    assert.match(bad as string, /no connected service or plugin called Notio\. Close: Notion/);
    assert.match(applySeesMoves(undefined, { skills_by_name: ["nope"] }, inv) as string, /no skill called nope/);
    assert.match(applySeesMoves(undefined, { start_from: "gaming" }, inv) as string, /Sets: everything, coding/);
    // From a set, then a move; back to everything is no choice at all.
    const coding = applySeesMoves(undefined, { start_from: "coding", switch_on: ["ado"] }, inv);
    assert.ok(typeof coding !== "string");
    assert.equal(coding.sees?.services?.rest, "off");
    assert.ok(coding.sees?.services?.except.includes("ado"));
    assert.deepEqual(coding.lines, ["started from the Coding set", "ado on (was off)"]);
    const all = applySeesMoves(coding.sees, { start_from: "everything" }, inv);
    assert.ok(typeof all !== "string" && all.sees === undefined);
    // A move that changes nothing has no line.
    const same = applySeesMoves(undefined, { switch_on: ["Notion"] }, inv);
    assert.ok(typeof same !== "string" && same.lines.length === 0 && same.sees === undefined);
  });
});

describe("what a bot sees, through the tools: the person's line in a few words", () => {
  const svc = (name: string, to: "on" | "off" = "off"): SeesChange => ({ kind: "service", to, name, label: name, words: `${name} ${to} (was ${to === "on" ? "off" : "on"})` });
  const skill = (name: string): SeesChange => ({ kind: "skill", to: "name", name, words: `the skill ${name} by name only (was in full)` });
  test("one to three switches read as before, each from what to what", () => {
    assert.equal(seesShortText([svc("Notion"), svc("HubSpot"), skill("docs")]), "Notion off (was on), HubSpot off (was on), the skill docs by name only (was in full)");
    assert.equal(seesShortText([{ kind: "set", words: "started from the Coding set" }]), "started from the Coding set");
  });
  test("more are counted by kind and direction, with three named (the trim of 15 Nov 2026 was four lines cut at 400 characters)", () => {
    const services = ["Notion", "Claude Docs", "Stripe", "HubSpot", "Claude Data", "Zendesk", "codex", "data databricks", "data snowflake", "design gmail", "design google calendar", "ado"].map((n) => svc(n));
    const plugins: SeesChange[] = ["1password", "codex-cu", "design", "data", "hubspot-session", "office"].map((n) => ({ kind: "plugin", to: "off", name: n, label: `the ${n} plugin`, words: `the ${n} plugin off (was on)` }));
    const skills = Array.from({ length: 40 }, (_, i) => skill(`skill-${i + 1}`));
    const text = seesShortText([{ kind: "set", words: "started from the Coding set" }, ...services, ...plugins, svc("Microsoft 365", "on"), ...skills]);
    assert.equal(text, "started from the Coding set; Microsoft 365 on; 12 services and 6 plugins off (Notion, Claude Docs, Stripe and 15 more); 40 skills by name only (skill-1, skill-2, skill-3 and 37 more)");
    assert.ok(text.length < 200);
    assert.equal(seesShortText([svc("A"), svc("B"), skill("c"), skill("d")]), "A and B off; the skills c and d by name only");
  });
});

describe("what a bot sees, through the tools: the engine", () => {
  test("the main bot sets what another bot sees at once: saved, the session starts again, one quiet line, get_bot shows it", async () => {
    const w = await world();
    const r = await w.ps.tool("update_bot", { bot: "Kaja", sees: { switch_off: ["Notion", "ado"], skills_by_name: ["docs"] } });
    assert.match(text(r), /what it sees: Notion off \(was on\), ado off \(was on\), the skill docs by name only \(was in full\)/);
    const bot = w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!;
    assert.deepEqual(bot.sees, { services: { rest: "on", except: ["claude.ai Notion", "ado"] }, skills: { rest: "full", except: ["docs"] } });
    assert.equal(w.ks.closed, true, "the idle session is started again with the same conversation");
    assert.equal(approvals(w.events).length, 0);
    const seen = text(await w.ps.tool("get_bot", { bot: "Kaja", parts: ["sees"] }));
    assert.match(seen, /- Notion \(claude\.ai Notion\): off, connected, \d+ tokens/);
    assert.match(seen, /- docs: by name only/);
    assert.match(seen, /Saves about \d+ tokens on every step\./);
    assert.match(seen, /Ready-made sets for start_from: everything/);
    w.ps.reply("Done.");
    await settle();
    assert.equal(lines(w.events, w.po.mainThreadId).at(-1), "Kaja: what it sees: Notion off (was on), ado off (was on), the skill docs by name only (was in full)");
    assert.equal(notes(w.events).length, 0, "no note card");
    // Its next session carries it.
    w.engine.sendMessage({ botId: w.kaja.id, text: "again" });
    await settle();
    const s2 = w.sessions.filter((s) => s.settings.botId === w.kaja.id).at(-1)!;
    assert.ok(s2.settings.sees?.deniedMcpServers?.some((d) => d.serverName === "ado"));
    assert.match(s2.settings.team, /switch it on yourself with change_what_i_see/);
    w.engine.shutdown();
    w.store.close();
  });

  test("many switches over several calls in one turn make one short line; the tool's answers name every switch", async () => {
    const w = await world();
    const r1 = await w.ps.tool("update_bot", { bot: "Kaja", sees: { switch_off: ["Notion", "ado"] } });
    assert.match(text(r1), /what it sees: Notion off \(was on\), ado off \(was on\)/);
    const r2 = await w.ps.tool("update_bot", { bot: "Kaja", sees: { skills_by_name: ["docs", "code-review"] } });
    assert.match(text(r2), /what it sees: the skill docs by name only \(was in full\), the skill code-review by name only \(was in full\)/);
    w.ps.reply("Done.");
    await settle();
    assert.equal(lines(w.events, w.po.mainThreadId).at(-1), "Kaja: what it sees: Notion and ado off; the skills docs and code-review by name only");
    w.engine.shutdown();
    w.store.close();
  });

  test("change_what_i_see: off and on at once, each with a quiet line in its own chat, from what to what; on gives a turn of its own to carry on", async () => {
    const w = await world();
    w.engine.sendMessage({ botId: w.kaja.id, text: "Switch Notion off." });
    await settle();
    let ks = w.sessions.filter((s) => s.settings.botId === w.kaja.id).at(-1)!;
    assert.match(text(await ks.tool("change_what_i_see", { switch_off: ["Notion"] })), /^Changed what you see: Notion off \(was on\)\. It holds from your next turn\.$/);
    assert.deepEqual(lines(w.events, w.kaja.mainThreadId), [], "the line waits for the end of its turn");
    assert.deepEqual(w.engine.snapshot().bots.find((b) => b.id === w.kaja.id)!.sees, { services: { rest: "on", except: ["claude.ai Notion"] } });
    ks.reply("ok");
    await settle();
    // Switching off leaves a line too (the tester's walk: it left none), in its own chat, not the main bot's.
    assert.deepEqual(lines(w.events, w.kaja.mainThreadId), ["Kaja changed what it sees: Notion off (was on)"]);
    assert.deepEqual(lines(w.events, w.po.mainThreadId), []);
    // Back on: a line in its own chat, and after this turn a new session with Notion and a turn to carry on.
    w.engine.sendMessage({ botId: w.kaja.id, text: "Use Notion." });
    await settle();
    ks = w.sessions.filter((s) => s.settings.botId === w.kaja.id).at(-1)!;
    assert.ok(ks.settings.sees?.deniedMcpServers?.some((d) => d.serverName === "claude.ai Notion"));
    const on = text(await ks.tool("change_what_i_see", { switch_on: ["Notion"] }));
    assert.match(on, /Notion on \(was off\).*gives you a turn of your own to carry on/);
    assert.equal(approvals(w.events).length, 0, "no card");
    const sessions = w.sessions.length;
    ks.reply("I switched Notion on.");
    await settle();
    assert.deepEqual(lines(w.events, w.kaja.mainThreadId), ["Kaja changed what it sees: Notion off (was on)", "Kaja changed what it sees: Notion on (was off)"]);
    assert.equal(notes(w.events).length, 0, "nothing under Needs you");
    assert.ok(w.sessions.length > sessions, "a new session after the turn");
    const s3 = w.sessions.at(-1)!;
    assert.equal(s3.settings.botId, w.kaja.id);
    assert.equal(s3.settings.sees, undefined, "nothing is off any more");
    assert.match(s3.sent.at(-1)!.text, /Notion is switched on for you now/);
    // Refusals.
    assert.match(text(await s3.tool("change_what_i_see", { switch_on: ["Nothing at all"] })), /no connected service or plugin called Nothing at all/);
    assert.match(text(await w.ps.tool("update_bot", { bot: "Kaja", sees: { switch_off: ["Notio"] } })), /Close: Notion/);
    w.engine.shutdown();
    w.store.close();
  });
});
