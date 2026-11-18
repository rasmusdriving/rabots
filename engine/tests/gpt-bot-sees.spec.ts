// What a GPT bot's own session sees (docs/build/step-gpt-bot-sees.md): its Codex thread switches off
// the servers its choice has off, Codex's plugins and apps, as its helpers do; a change of the choice
// starts its session again on the same thread with the new settings. CodexSession on the fake Codex.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BotSees } from "../../shared/protocol.js";
import { SEES_ON_WORDS, SEES_SETS } from "../claude/sees.js";
import { codexSeesParagraph, listCodexMcp } from "../codex/sees.js";
import { codexWorld, fakeCodex, waitFor } from "./codex-fake.js";
import { tempDir } from "./helpers.js";

const CODING = SEES_SETS.find((s) => s.id === "coding")!.sees!;
const SERVERS = [
  { name: "cua-driver", enabled: true },
  { name: "workbot", enabled: true },
  { name: "clickup", enabled: false },
  // A plugin's server; Codex refuses it named. The name is this file's own: the engine remembers a refused one while it runs (helper-sees.spec.ts has its own).
  { name: "gpt-messages", enabled: true, plugin: true },
];
const PO_LIKE: BotSees = { services: { rest: "on", except: ["workbot"] }, plugins: { rest: "off", except: [] } };

type World = ReturnType<typeof codexWorld>;
const stateOf = (w: World, id: string) => w.engine.snapshot().bots.find((b) => b.id === id)!.state;
const cfg = (p: Record<string, unknown> | undefined) => (p?.config ?? {}) as Record<string, unknown>;
const seesKeys = (c: Record<string, unknown>) => Object.keys(c).filter((k) => k.startsWith("mcp_servers") || k.startsWith("features"));
const done = (w: World) => {
  w.engine.shutdown();
  w.store.close();
};

async function world(o: { sees?: BotSees; main?: boolean; list?: () => Promise<{ name: string; enabled: boolean }[]> } = {}) {
  let lists = 0;
  const codex = fakeCodex({ FAKE_CODEX_MCP: JSON.stringify(SERVERS) });
  const dirs = { dataDir: tempDir(), botsDir: tempDir() };
  if (o.main) {
    mkdirSync(join(dirs.botsDir, "gee"), { recursive: true });
    writeFileSync(join(dirs.botsDir, "gee", "bot.json"), JSON.stringify({ name: "Gee", role: "main", purpose: "", look: { eyes: "round", gap: "mid" }, harness: "codex", model: "gpt-6-luna", effort: "low", access: "full-access", machine: "test-mac", mayMessage: [], ...(o.sees ? { sees: o.sees } : {}) }));
  }
  const w = codexWorld({ codex, dirs, listCodexMcp: async (x) => (lists++, o.list ? o.list() : listCodexMcp(x)) });
  await w.engine.recheckCodex();
  // The first bot made is the main bot: Po on Claude first, so Gee is an ordinary bot.
  if (!o.main) w.engine.createBot({ name: "Po", model: "claude-haiku-5-5" });
  const id = o.main ? "gee" : w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "asks-first" }).id;
  if (o.sees && !o.main) await w.engine.updateBot({ botId: id, patch: { sees: o.sees } });
  return { w, id, lists: () => lists };
}

async function say(w: World, id: string, word: string, n: number) {
  w.engine.sendMessage({ botId: id, text: `Say it [[answer:${word}]]` });
  await waitFor(() => w.codex.received("turn/start").length === n && stateOf(w, id) === "done", 8000, `answer ${n}`);
}

describe("what a GPT bot's own session sees", () => {
  test("the paragraph names the Codex servers that are off, and Codex's plugins and apps", () => {
    assert.equal(codexSeesParagraph([], SEES_ON_WORDS.ask), "");
    assert.equal(
      codexSeesParagraph(["cua-driver", "plugins", "apps"], SEES_ON_WORDS.ask),
      "Switched off for you in Pobots by the person (not broken): cua-driver, Codex's plugins, Codex's apps. When you need one, ask the person with ask_human to switch it on for you in your settings in Pobots.",
    );
  });

  test("a GPT bot without a choice: its thread starts as before, nothing in its instructions, Codex is not asked for its list", async () => {
    const { w, id, lists } = await world();
    await say(w, id, "heron", 1);
    const start = w.codex.received("thread/start").at(-1);
    assert.deepEqual(seesKeys(cfg(start)), []);
    assert.equal(String(start!.developerInstructions).includes("Switched off for you"), false);
    assert.equal(lists(), 0);
    done(w);
  });

  test("a GPT bot with the Coding set: only its servers, no plugins, no apps; told what is off and to switch one on itself; it answers", async () => {
    const { w, id } = await world({ sees: CODING });
    await say(w, id, "heron", 1);
    const starts = w.codex.received("thread/start");
    const c = cfg(starts.at(-1));
    assert.equal(c["mcp_servers.cua-driver.enabled"], false);
    assert.equal(c["mcp_servers.workbot.enabled"], false);
    assert.equal(c["features.plugins"], false);
    assert.equal(c["features.apps"], false);
    assert.deepEqual(c["tools.update_plan"], { enabled: true }, "the plan tool is still on");
    assert.equal("mcp_servers.clickup.enabled" in c, false, "a server Codex has off is not named");
    assert.equal("mcp_servers.gpt-messages.enabled" in c, false, "a plugin's server Codex refused is dropped and the rest kept");
    const words = String(starts.at(-1)!.developerInstructions);
    assert.match(words, /Switched off for you in Pobots by the person \(not broken\): cua-driver, workbot, gpt-messages, Codex's plugins, Codex's apps\./);
    assert.ok(words.includes(SEES_ON_WORDS.bot), "a GPT bot switches one on itself with change_what_i_see (engine 0.27.0)");
    assert.equal(words.includes("ask_human to switch"), false);
    done(w);
  });

  test("the main bot on a GPT model is told to switch one on with update_bot", async () => {
    const { w, id } = await world({ sees: PO_LIKE, main: true });
    await say(w, id, "heron", 1);
    const start = w.codex.received("thread/start").at(-1)!;
    assert.deepEqual(seesKeys(cfg(start)), ["mcp_servers.workbot.enabled", "features.plugins"]);
    assert.ok(String(start.developerInstructions).includes("workbot, Codex's plugins. " + SEES_ON_WORDS.main));
    done(w);
  });

  test("a change of the choice: the next message resumes the same thread in a new Codex with the new settings, and back again", async () => {
    const { w, id } = await world();
    await say(w, id, "heron", 1);
    const threads = Object.keys(w.codex.threads());
    assert.equal(threads.length, 1);
    assert.equal(w.codexSessions.length, 1);
    await w.engine.updateBot({ botId: id, patch: { sees: CODING } });
    await say(w, id, "plover", 2);
    assert.equal(w.codexSessions.length, 2, "a new Codex process");
    assert.equal(w.codex.received("thread/start").length, 1, "no new thread");
    const resumed = w.codex.received("thread/resume").at(-1)!;
    assert.equal(resumed.threadId, threads[0], "the same thread");
    assert.equal(cfg(resumed)["mcp_servers.cua-driver.enabled"], false);
    assert.equal(cfg(resumed)["features.plugins"], false);
    assert.match(String(resumed.developerInstructions), /Switched off for you in Pobots/);

    await w.engine.updateBot({ botId: id, patch: { sees: null } });
    await say(w, id, "tern", 3);
    const back = w.codex.received("thread/resume").at(-1)!;
    assert.equal(w.codex.received("thread/resume").length, 2);
    assert.deepEqual(seesKeys(cfg(back)), [], "everything again");
    assert.equal(String(back.developerInstructions).includes("Switched off for you"), false);
    done(w);
  });

  test("a list that is out of date, or no list at all: the bot still answers", async () => {
    const stale = await world({ sees: CODING, list: async () => [{ name: "gone-gpt", enabled: true }] });
    await say(stale.w, stale.id, "heron", 1);
    const starts = stale.w.codex.received("thread/start");
    assert.equal(starts.length, 2, "once with the name Codex does not have, once without it");
    assert.equal("mcp_servers.gone-gpt.enabled" in cfg(starts[1]), false);
    assert.equal(cfg(starts[1])["features.plugins"], false, "the rest of the choice holds");
    done(stale.w);

    const failing = await world({ sees: CODING, list: async () => Promise.reject(new Error("codex busy")) });
    await say(failing.w, failing.id, "heron", 1);
    assert.equal(cfg(failing.w.codex.received("thread/start").at(-1))["features.plugins"], false, "plugins and apps go off without a list");
    done(failing.w);
  });
});
