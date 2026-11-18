// What a bot sees of the person's own Claude Code setup (docs/sees.md, docs/build/step-sees.md). The
// pure rules in engine/claude/sees.ts, and the engine side with a fake reader: no real Claude, no model.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BotSees } from "../../shared/protocol.js";
import { normalizeBotFile } from "../bots.js";
import { buildInventory, cleanSees, SEES_NAMES_MAX, SEES_ON_WORDS, SEES_SETS, seesSettings, serviceLabel, type RawSees } from "../claude/sees.js";
import { parseParams } from "../schemas.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { settle, setup } from "./fake.js";

/** What a short session on a typical Mac reports, made small. */
function raw(): RawSees {
  return {
    servers: [
      { name: "claude.ai Notion", status: "connected", source: "claudeai", tools: [{ name: "a" }, { name: "b" }] },
      { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
      { name: "ado", status: "connected", source: "user", scope: "user", tools: [{ name: "x" }] },
      { name: "codex", status: "failed", source: "user" },
      { name: "plugin:1password:1password", status: "connected", source: "plugin", tools: [{ name: "p" }] },
      { name: "plugin:data:hex", status: "needs-auth", source: "plugin" },
      { name: "pobots", status: "connected", source: "sdk", tools: [{ name: "list_bots" }] },
      { name: 42, status: "connected" },
    ],
    usage: {
      mcpTools: [
        { name: "mcp__claude_ai_Notion__search", serverName: "claude_ai_Notion", tokens: 900, isLoaded: false },
        { name: "mcp__claude_ai_Notion__fetch", serverName: "claude_ai_Notion", tokens: 800, isLoaded: false },
        { name: "mcp__ado__wiki", serverName: "ado", tokens: 300, isLoaded: true },
        { name: "mcp__plugin_1password__list", serverName: "plugin_1password_1password", tokens: 200, isLoaded: false },
      ],
      mcpInstructions: [{ serverName: "claude.ai Notion", tokens: 400 }],
      skills: {
        skillFrontmatter: [
          { name: "code-review", source: "built-in", tokens: 280 },
          { name: "browser-use", source: "userSettings", tokens: 226 },
          { name: "docs", source: "syncedSkills", tokens: 343 },
          { name: "weekly", source: "projectSettings", tokens: 50 },
          { name: "design:ux-copy", source: "plugin", pluginName: "design", pluginId: "design@synced", tokens: 96 },
          { name: "data:analyze", source: "plugin", pluginName: "data", pluginId: "data@synced", tokens: 81 },
          { name: "1password:envs", source: "plugin", pluginName: "1password", pluginId: "1password@synced", tokens: 83 },
          { name: "", source: "built-in" },
          { name: "docs", source: "syncedSkills", tokens: 1 },
        ],
      },
    },
  };
}

describe("what a bot sees: the rules", () => {
  test("a choice is cleaned: strings, trimmed, no doubles, capped; nothing left is no choice", () => {
    const long = "x".repeat(500);
    const many = Array.from({ length: SEES_NAMES_MAX + 50 }, (_, i) => `s${i}`);
    const c = cleanSees({ services: { rest: "off", except: [" claude.ai Notion ", "claude.ai Notion", 7, "", long, "pobots", "a\u0000b"] }, plugins: { rest: "on", except: many }, skills: { rest: "maybe", except: ["x"] } });
    assert.deepEqual(c?.services, { rest: "off", except: ["claude.ai Notion", "ab"] }, "Pobots' own tools are never named as off");
    assert.equal(c?.plugins?.except.length, SEES_NAMES_MAX);
    assert.equal(c?.skills, undefined, "an unknown rest drops that part");
    assert.equal(cleanSees({}), undefined);
    assert.equal(cleanSees("everything"), undefined);
    assert.equal(cleanSees([1]), undefined);
    assert.deepEqual(cleanSees({ skills: { rest: "full" } }), { skills: { rest: "full", except: [] } });
  });

  test("no choice, or one that changes nothing, gives no settings and no paragraph", () => {
    assert.deepEqual(seesSettings(undefined, undefined), { paragraph: "", partial: false });
    const inv = buildInventory(raw(), "2026-11-15T10:00:00Z");
    assert.deepEqual(seesSettings({ services: { rest: "on", except: [] }, skills: { rest: "full", except: [] } }, inv), { paragraph: "", partial: false });
  });

  test("the inventory: labels, where things come from, states, costs, plugins with their skills and services", () => {
    const inv = buildInventory(raw(), "2026-11-15T10:00:00Z");
    assert.deepEqual(
      inv.services.map((s) => [s.name, s.label, s.from, s.state, s.tools]),
      [
        ["claude.ai Notion", "Notion", "claude.ai", "connected", 2],
        ["ado", "ado", "mac", "connected", 1],
        ["plugin:1password:1password", "1password", "plugin", "connected", 1],
        ["plugin:data:hex", "data hex", "plugin", "needs-sign-in", 0],
        ["claude.ai Gmail", "Gmail", "claude.ai", "needs-sign-in", 0],
        ["codex", "codex", "mac", "failed", 0],
      ],
    );
    const notion = inv.services[0]!;
    assert.ok(notion.tokens > 400 && notion.tokens < 500, "held-back tools cost their names, plus the instructions");
    assert.equal(inv.services[1]!.tokens, 300, "a loaded tool costs in full");
    assert.ok(inv.services[2]!.tokens > 0, "a plugin's server is found under the name its tools carry");
    assert.equal(inv.services.find((s) => s.name === "claude.ai Gmail")!.tokens, 0, "a service that is not connected costs nothing");
    assert.equal(inv.services.find((s) => s.name === "plugin:data:hex")!.plugin, "data@synced");
    assert.deepEqual(inv.plugins.map((p) => [p.id, p.skills, p.services]), [["1password@synced", 1, 1], ["data@synced", 1, 1], ["design@synced", 1, 0]]);
    assert.deepEqual(inv.skills.map((k) => [k.name, k.from]), [["browser-use", "mac"], ["code-review", "built-in"], ["docs", "claude.ai"], ["weekly", "bot"]]);
    assert.equal(inv.sets, SEES_SETS);
    assert.equal(serviceLabel("plugin:data:hex"), "data hex");
    // Odd data from the Mac is skipped, never thrown on.
    const empty = buildInventory({ servers: "nope", usage: null }, "2026-11-15T10:00:00Z");
    assert.deepEqual([empty.services, empty.plugins, empty.skills], [[], [], []]);
  });

  test("the Coding set on that inventory: the rest off or by name only, the exceptions kept, Pobots never refused", () => {
    const inv = buildInventory(raw(), "2026-11-15T10:00:00Z");
    const coding = SEES_SETS.find((s) => s.id === "coding")!.sees!;
    const r = seesSettings(coding, inv);
    assert.equal(r.partial, false);
    assert.deepEqual(r.settings?.deniedMcpServers?.map((d) => d.serverName).sort(), ["ado", "claude.ai Gmail", "claude.ai Notion", "codex", "plugin:data:hex"]);
    assert.deepEqual(r.settings?.enabledPlugins, { "data@synced": false });
    assert.deepEqual(r.settings?.skillOverrides, { weekly: "name-only" });
    assert.ok(!r.settings?.deniedMcpServers?.some((d) => d.serverName === "pobots"));
    // The paragraph names what was connected and the plugin, not what never connected or the plugin's own service.
    // Since the main bot's tools (docs/build/step-main-bot-tools.md): the bot switches one on itself.
    assert.equal(r.paragraph, "Switched off for you in Pobots by the person (not broken): Notion, ado, the data plugin. When you need one, switch it on yourself with change_what_i_see and tell the person you did.");
    assert.match(seesSettings(coding, inv, SEES_ON_WORDS.main).paragraph, /switch it on with update_bot, your own name and sees/);
  });

  test("ten services off: the paragraph stays short", () => {
    const names = ["Notion", "Stripe", "HubSpot", "Claude Data", "Microsoft 365", "Zendesk", "Claude Docs"].map((n) => `claude.ai ${n}`).concat(["hubspot-session", "ado", "codex-cu"]);
    const r = seesSettings({ services: { rest: "on", except: names } }, undefined);
    assert.equal(r.settings?.deniedMcpServers?.length, 10);
    const words = r.paragraph.split(/\s+/).length;
    assert.ok(words < 50, `about 80 tokens at most (${words} words)`);
  });

  test("without an inventory only the exceptions that switch something off are applied", () => {
    const sees: BotSees = { services: { rest: "off", except: ["ado"] }, plugins: { rest: "on", except: ["data@synced"] }, skills: { rest: "name", except: ["docs"] } };
    const r = seesSettings(sees, undefined);
    assert.equal(r.partial, true);
    assert.equal(r.settings?.deniedMcpServers, undefined);
    assert.deepEqual(r.settings?.enabledPlugins, { "data@synced": false });
    assert.equal(r.settings?.skillOverrides, undefined);
  });

  test("names that do not exist on the Mac are kept and change nothing else", () => {
    const inv = buildInventory(raw(), "2026-11-15T10:00:00Z");
    const r = seesSettings({ services: { rest: "off", except: ["claude.ai Gone", "ado"] } }, inv);
    assert.ok(!r.settings!.deniedMcpServers!.some((d) => d.serverName === "ado" || d.serverName === "claude.ai Gone"));
  });

  test("the bot file and bot.update keep the choice cleaned; the request shape is checked", () => {
    const f = normalizeBotFile({ name: "Po", sees: { services: { rest: "off", except: ["ado", "ado"] }, plugins: "x" } }, "po", "mac");
    assert.deepEqual(f.sees, { services: { rest: "off", except: ["ado"] } });
    assert.equal(normalizeBotFile({ name: "Po" }, "po", "mac").sees, undefined);
    assert.ok(parseParams("bot.update", { botId: "po", patch: { sees: null } }));
    assert.equal(parseParams("bot.update", { botId: "po", patch: { sees: { services: { rest: "sometimes", except: [] } } } }), undefined);
    assert.ok(parseParams("sees.inventory", { botId: "po", refresh: true }));
  });
});

describe("what a bot sees: the engine", () => {
  test("a bot without a choice gets nothing from this feature, and no read is made", async () => {
    let reads = 0;
    const w = setup(undefined, undefined, undefined, { readSees: async () => (reads++, raw()) });
    const bot = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: bot.id, text: "hi" });
    await settle();
    const s = w.sessions.at(-1)!;
    assert.equal(s.settings.sees, undefined);
    assert.doesNotMatch(s.settings.team, /Switched off for you/);
    assert.equal(reads, 0);
    assert.equal("sees" in w.engine.snapshot().bots[0]!, false);
    w.engine.shutdown();
    w.store.close();
  });

  test("the choice is saved cleaned, carried on the bot, applied with the names read before the first session; null removes it", async () => {
    let reads = 0;
    const w = setup(undefined, undefined, undefined, { readSees: async () => (reads++, raw()) });
    const bot = w.engine.createBot("Po");
    const coding = SEES_SETS.find((s) => s.id === "coding")!.sees!;
    const after = await w.engine.updateBot({ botId: bot.id, patch: { sees: { ...coding, services: { rest: "off", except: [" plugin:1password:1password ", "pobots"] } } } });
    assert.deepEqual(after.sees?.services, { rest: "off", except: ["plugin:1password:1password"] });
    const file = JSON.parse(readFileSync(join(w.dirs.botsDir, bot.id, "bot.json"), "utf8"));
    assert.deepEqual(file.sees.plugins, { rest: "off", except: ["design@synced", "1password@synced"] });

    w.engine.sendMessage({ botId: bot.id, text: "hi" });
    await settle();
    await waitFor(() => w.sessions.length === 1, 2000, "the session");
    const s = w.sessions[0]!;
    assert.equal(reads, 1, "read once before the first session, since the choice says the rest is off");
    assert.ok(s.settings.sees?.deniedMcpServers?.some((d) => d.serverName === "claude.ai Notion"));
    assert.deepEqual(s.settings.sees?.enabledPlugins, { "data@synced": false });
    assert.match(s.settings.team, /Switched off for you in Pobots by the person \(not broken\): Notion, ado, the data plugin\./);

    // The engine's answer to the window uses the same read while it is fresh.
    const inv = await w.engine.seesInventory({ botId: bot.id });
    assert.equal(reads, 1);
    assert.equal(inv.inventory?.services[0]?.label, "Notion");

    // A change holds from the next message: the idle session is closed and the next one carries it.
    s.reply("ok");
    await settle();
    await w.engine.updateBot({ botId: bot.id, patch: { sees: null } });
    assert.equal(s.closed, true, "the session is started again with the same conversation");
    assert.equal("sees" in JSON.parse(readFileSync(join(w.dirs.botsDir, bot.id, "bot.json"), "utf8")), false);
    w.engine.sendMessage({ botId: bot.id, text: "again" });
    await settle();
    const s2 = w.sessions.at(-1)!;
    assert.notEqual(s2, s);
    assert.equal(s2.settings.resume, "sess-1", "the same conversation");
    assert.equal(s2.settings.sees, undefined);
    assert.doesNotMatch(s2.settings.team, /Switched off for you/);
    w.engine.shutdown();
    w.store.close();
  });

  test("a choice in bot.json that names nothing real is ignored; one with nothing left is no choice", async () => {
    const w = setup();
    const bot = w.engine.createBot("Po");
    const path = join(w.dirs.botsDir, bot.id, "bot.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), sees: { services: { rest: "nope" } } }));
    const w2 = setup(w.dirs);
    assert.equal("sees" in w2.engine.snapshot().bots[0]!, false);
    w.engine.shutdown();
    w.store.close();
    w2.engine.shutdown();
    w2.store.close();
  });

  test("two requests at once share one read; a failed read is a sentence, keeps the last good one, and never stops a bot", async () => {
    let reads = 0;
    let fail = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const w = setup(undefined, undefined, undefined, {
      readSees: async () => {
        reads++;
        await gate;
        if (fail) throw new Error("no Claude here");
        return raw();
      },
    });
    const bot = w.engine.createBot("Po");
    const a = w.engine.seesInventory({ botId: bot.id });
    const b = w.engine.seesInventory({ botId: bot.id, refresh: true });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(reads, 1, "one read for two requests");
    assert.equal(ra.inventory, rb.inventory);
    fail = true;
    const rc = await w.engine.seesInventory({ botId: bot.id, refresh: true });
    assert.equal(reads, 2);
    assert.match(rc.problem ?? "", /could not be read just now/);
    assert.equal(rc.inventory, ra.inventory, "the last good read stays");

    // A bot never read whose read fails before its session: it starts, with only the exceptions.
    const other = w.engine.createBot("Ky");
    await w.engine.updateBot({ botId: other.id, patch: { sees: { services: { rest: "off", except: [] }, plugins: { rest: "on", except: ["data@synced"] } } } });
    w.engine.sendMessage({ botId: other.id, text: "hi" });
    await waitFor(() => w.sessions.some((s) => s.settings.botId === other.id), 2000, "the session started");
    const s = w.sessions.find((x) => x.settings.botId === other.id)!;
    assert.deepEqual(s.settings.sees, { enabledPlugins: { "data@synced": false } });
    w.engine.shutdown();
    w.store.close();
  });

  test("a Claude helper started with start_helper follows its bot's choice", async () => {
    const w = setup(undefined, undefined, { wakeGraceMs: 5, helperStopMs: 200, helperNudgeMs: 10, liveCheckMs: 20 }, { readSees: async () => raw() });
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    await w.engine.updateBot({ botId: bot.id, patch: { sees: { services: { rest: "on", except: ["ado"] } } } });
    w.engine.sendMessage({ botId: bot.id, text: "Get help" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const r = await s.tool("start_helper", { title: "Look", task: "Say a word", model: "claude-haiku-5-5", wait: false });
    assert.match(r.content[0]!.text, /Started/);
    await waitFor(() => w.sessions.length === 2, 2000, "the helper's session");
    assert.deepEqual(w.sessions[1]!.settings.sees, { deniedMcpServers: [{ serverName: "ado" }] });
    w.engine.shutdown();
    w.store.close();
  });

  test("a GPT bot keeps its choice and its session never gets it", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low" });
    const after = await w.engine.updateBot({ botId: bot.id, patch: { sees: { services: { rest: "on", except: ["claude.ai Notion"] } } } });
    assert.deepEqual(after.sees, { services: { rest: "on", except: ["claude.ai Notion"] } });
    w.engine.sendMessage({ botId: bot.id, text: "Say a word [[answer:pelican]]" });
    await waitFor(() => w.codexSessions.length === 1, 8000, "the GPT session");
    assert.equal(w.codexSessions[0]!.settings.sees, undefined);
    assert.doesNotMatch(String(w.codexSessions[0]!.settings.systemAppend), /Switched off for you/);
    w.engine.shutdown();
    w.store.close();
  });
});
