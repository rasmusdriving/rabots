// A GPT bot changes what it sees itself (docs/build/step-gpt-change-sees.md): its new Codex thread has
// change_what_i_see and its words name it; a call switches a Codex server on and off, the choice changes,
// a quiet line is written, and its next turn resumes the same thread with the new config. A thread
// started before the tool existed is resumed as it is, with the ask_human words. CodexSession on the fake Codex.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BotSees, Events, NoticeItem, SeesInventory } from "../../shared/protocol.js";
import { SEES_ON_WORDS, SEES_SETS, serviceOn } from "../claude/sees.js";
import { listCodexMcp } from "../codex/sees.js";
import { toolFingerprint } from "../codex/session.js";
import { applyGptSeesMoves } from "../core/gpt-sees-moves.js";
import { codexWorld, fakeCodex, waitFor } from "./codex-fake.js";
import { tempDir } from "./helpers.js";

const CODING = SEES_SETS.find((s) => s.id === "coding")!.sees!;
const SERVERS = [
  { name: "cua-driver", enabled: true },
  { name: "workbot", enabled: true },
  { name: "clickup", enabled: false },
];

type World = ReturnType<typeof codexWorld>;
const bot = (w: World, id: string) => w.engine.snapshot().bots.find((b) => b.id === id)!;
const cfg = (p: Record<string, unknown> | undefined) => (p?.config ?? {}) as Record<string, unknown>;
const toolNames = (p: Record<string, unknown> | undefined) => ((p?.dynamicTools ?? []) as { name: string }[]).map((t) => t.name);
const lines = (w: World, threadId: string) =>
  w.events
    .filter((e) => e.event === "item.upsert")
    .map((e) => (e.data as Events["item.upsert"]).item)
    .filter((i): i is NoticeItem => i.kind === "notice" && i.threadId === threadId && i.tone === "info" && !i.mark)
    .map((i) => i.text);
const done = (w: World) => {
  w.engine.shutdown();
  w.store.close();
};

async function world(sees: BotSees | undefined = CODING) {
  const codex = fakeCodex({ FAKE_CODEX_MCP: JSON.stringify(SERVERS) });
  const w = codexWorld({ codex, dirs: { dataDir: tempDir(), botsDir: tempDir() }, listCodexMcp: (x) => listCodexMcp(x) });
  await w.engine.recheckCodex();
  // The first bot made is the main bot: Po on Claude first, so Gee is an ordinary bot.
  w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
  const id = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "asks-first" }).id;
  if (sees) await w.engine.updateBot({ botId: id, patch: { sees } });
  return { w, id };
}

async function say(w: World, id: string, text: string, turns: number) {
  w.engine.sendMessage({ botId: id, text });
  await waitFor(() => w.codex.received("turn/start").length === turns && bot(w, id).state === "done", 8000, `turn ${turns}`);
}

describe("a GPT bot changes what it sees itself", () => {
  test("its new thread has change_what_i_see and its words name it", async () => {
    const { w, id } = await world();
    await say(w, id, "Say it [[answer:heron]]", 1);
    const start = w.codex.received("thread/start").at(-1)!;
    assert.ok(toolNames(start).includes("change_what_i_see"));
    const words = String(start.developerInstructions);
    assert.ok(words.includes(SEES_ON_WORDS.bot), words);
    assert.equal(words.includes("ask_human to switch"), false);
    done(w);
  });

  test("a call switches a Codex server on, with a quiet line and a turn of its own, the next turn resumes the same thread with it on; then off again", async () => {
    const { w, id } = await world();
    await say(w, id, "Say it [[answer:heron]]", 1);
    const threadId = Object.keys(w.codex.threads())[0]!;
    assert.equal(cfg(w.codex.received("thread/start").at(-1))["mcp_servers.cua-driver.enabled"], false);

    // On: the choice changes at once, the line comes when the turn ends, and Pobots gives it a turn of its own.
    await say(w, id, `Switch it on [[tool:change_what_i_see]]${JSON.stringify({ switch_on: ["cua-driver"] })}`, 3);
    assert.ok(serviceOn(bot(w, id).sees, "cua-driver"), "the choice has it on");
    const main = bot(w, id).mainThreadId;
    assert.deepEqual(lines(w, main), ["Gee changed what it sees: cua-driver on (was off)"]);
    assert.equal(w.codex.received("thread/start").length, 1, "no new thread");
    const resumed = w.codex.received("thread/resume").at(-1)!;
    assert.equal(resumed.threadId, threadId, "the same thread");
    assert.equal("mcp_servers.cua-driver.enabled" in cfg(resumed), false, "cua-driver is on in the resumed thread");
    assert.equal(cfg(resumed)["mcp_servers.workbot.enabled"], false, "the rest of the choice holds");
    const woke = w.codex.received("turn/start").at(-1)!;
    assert.match(JSON.stringify(woke.input), /cua-driver is switched on for you now/);

    // Off: no turn of its own; the next message resumes the same thread with it off.
    await say(w, id, `Switch it off [[tool:change_what_i_see]]${JSON.stringify({ switch_off: ["cua-driver"] })}`, 4);
    assert.equal(serviceOn(bot(w, id).sees, "cua-driver"), false);
    assert.deepEqual(lines(w, main).at(-1), "Gee changed what it sees: cua-driver off (was on)");
    await say(w, id, "Say it [[answer:plover]]", 5);
    const again = w.codex.received("thread/resume").at(-1)!;
    assert.equal(again.threadId, threadId);
    assert.equal(cfg(again)["mcp_servers.cua-driver.enabled"], false);
    assert.equal(w.codex.received("thread/start").length, 1, "still the one thread");
    done(w);
  });

  test("a thread from before the tool is resumed as it is, not started fresh, with the ask_human words; any other change still starts fresh", async () => {
    const { w, id } = await world();
    await say(w, id, "Say it [[answer:heron]]", 1);
    const main = bot(w, id).mainThreadId;
    const threadId = Object.keys(w.codex.threads())[0]!;
    const before = w.codexSessions[0]!.settings.tools.filter((t) => t.name !== "change_what_i_see");
    const old = toolFingerprint(before);
    w.store.setSessionMeta(main, { harness: "codex", tools: old });
    // A change of the choice starts the session again on the next message.
    await w.engine.updateBot({ botId: id, patch: { sees: { ...CODING, plugins: { rest: "on", except: [] } } } });
    await say(w, id, "Say it [[answer:plover]]", 2);
    assert.equal(w.codex.received("thread/start").length, 1, "no fresh thread");
    const resumed = w.codex.received("thread/resume").at(-1)!;
    assert.equal(resumed.threadId, threadId);
    assert.ok(String(resumed.developerInstructions).includes(SEES_ON_WORDS.ask), "that thread has no tool, so it asks the person");
    const s = w.codexSessions.at(-1)!;
    assert.equal(s.settings.tools.some((t) => t.name === "change_what_i_see"), false);
    assert.equal(w.store.getSessionMeta(main)?.tools, old, "the thread keeps its fingerprint");
    assert.equal(lines(w, main).some((l) => /fresh session/.test(l)), false);

    // Any other change of the list: a fresh thread, with the tool.
    w.store.setSessionMeta(main, { harness: "codex", tools: "0000000000000000" });
    await w.engine.updateBot({ botId: id, patch: { sees: CODING } });
    await say(w, id, "Say it [[answer:tern]]", 3);
    assert.equal(w.codex.received("thread/start").length, 2, "a fresh thread");
    const fresh = w.codex.received("thread/start").at(-1)!;
    assert.ok(toolNames(fresh).includes("change_what_i_see"));
    assert.ok(String(fresh.developerInstructions).includes(SEES_ON_WORDS.bot));
    assert.equal(w.store.getSessionMeta(main)?.tools, toolFingerprint(w.codexSessions.at(-1)!.settings.tools));
    done(w);
  });
});

describe("a GPT bot's moves, in Codex's names", () => {
  const servers = [...SERVERS, { name: "gpt-messages", enabled: true, fromPlugin: true }];
  const inv: SeesInventory = {
    services: [{ name: "claude.ai Notion", label: "Notion", state: "connected", tokens: 900 }],
    plugins: [
      { id: "design@synced", name: "design", skills: 3, services: 0, tokens: 400 },
      { id: "data@synced", name: "data", skills: 2, services: 0, tokens: 300 },
    ],
    skills: [],
    readAt: 0,
  } as unknown as SeesInventory;
  const ok = (r: ReturnType<typeof applyGptSeesMoves>) => {
    if (typeof r === "string") throw new Error(r);
    return r;
  };

  test("a server by its name or label, Codex's apps and Codex's plugins", () => {
    const a = ok(applyGptSeesMoves(CODING, { switch_on: ["CUA-Driver", "Codex's apps"] }, servers, inv));
    assert.deepEqual(a.lines, ["cua-driver on (was off)", "Codex's apps on (was off)"]);
    assert.deepEqual(a.on, ["cua-driver", "Codex's apps"]);
    assert.ok(serviceOn(a.sees, "cua-driver") && serviceOn(a.sees, "codex_apps"));
    // Codex's plugins on: the rest of plugins, the single Claude plugins keep what they were.
    const p = ok(applyGptSeesMoves(CODING, { switch_on: ["Codex's plugins"] }, servers, inv));
    assert.deepEqual(p.lines, ["Codex's plugins on (was off)"]);
    assert.deepEqual(p.sees?.plugins, { rest: "on", except: ["data@synced"] });
    const back = ok(applyGptSeesMoves(p.sees, { switch_off: ["plugins"] }, servers, inv));
    assert.deepEqual(back.sees?.plugins, { rest: "off", except: ["design@synced"] });
    assert.deepEqual(ok(applyGptSeesMoves(CODING, { switch_off: ["workbot"] }, servers, inv)).lines, [], "already off: nothing changed");
    assert.equal(ok(applyGptSeesMoves(undefined, { switch_off: ["workbot"] }, servers, inv)).sees?.services?.except.includes("workbot"), true);
  });

  test("what does not apply on Codex is said plainly and nothing changes", () => {
    assert.match(applyGptSeesMoves(CODING, { skills_in_full: ["docs"] }, servers, inv) as string, /^Skills are not changed on a GPT model/);
    assert.match(applyGptSeesMoves(CODING, { switch_on: ["design"] }, servers, inv) as string, /single plugin cannot be switched/);
    assert.match(applyGptSeesMoves(CODING, { switch_on: ["Notion"] }, servers, inv) as string, /Notion is not in your Codex setup/);
    assert.match(applyGptSeesMoves(CODING, { switch_on: ["clickup"] }, servers, inv) as string, /switched off in your Codex setup itself/);
    assert.match(applyGptSeesMoves(CODING, { switch_on: ["gpt-messages"] }, servers, inv) as string, /comes with Codex's plugins/);
    const none = applyGptSeesMoves(CODING, { switch_on: ["Nothing"] }, servers, inv) as string;
    assert.match(none, /no Codex service called Nothing/);
    assert.match(none, /cua-driver, workbot, Codex's plugins, Codex's apps\.$/);
    assert.match(applyGptSeesMoves(CODING, { switch_on: ["workbot"] }, [], inv) as string, /could not be read just now/);
    assert.deepEqual(ok(applyGptSeesMoves(CODING, { switch_on: ["Codex's apps"] }, [], inv)).lines, ["Codex's apps on (was off)"], "Codex's apps and plugins need no list");
  });
});
