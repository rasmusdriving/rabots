// What a helper sees (docs/build/step-helper-sees.md): a start_helper helper, a task manager's worker
// and a task manager get the services, plugins and skills of the bot that started them, on Claude and
// on Codex; start_helper's `services` switches more on for one helper. Fake harnesses, no model.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BotSees } from "../../shared/protocol.js";
import { SEES_SETS, seesIsEverything } from "../claude/sees.js";
import { codexSeesConfig, listCodexMcp, parseMcpList, refusedServer } from "../codex/sees.js";
import { withAlsoOn } from "../core/helper-sees.js";
import { codexWorld, fakeCodex, waitFor } from "./codex-fake.js";
import { settle, type FakeSession } from "./fake.js";

const CODING = SEES_SETS.find((s) => s.id === "coding")!.sees!;
/** What `codex mcp list --json` lists on a Mac like the person's (no secrets in the fake). */
const SERVERS = [
  { name: "cua-driver", enabled: true, transport: { type: "stdio", command: "/x/cua-driver", args: ["mcp"], env: { TOKEN: "never-kept" } } },
  { name: "hubspot-session", enabled: true },
  { name: "workbot", enabled: true },
  { name: "openaiDeveloperDocs", enabled: true },
  { name: "clickup", enabled: false },
  { name: "messages", enabled: true, plugin: true },
  { name: "odd.name", enabled: true },
];
/** Like the main bot's choice: services on but a few, plugins off. */
const PO_LIKE: BotSees = { services: { rest: "on", except: ["ado", "hubspot-session"] }, plugins: { rest: "off", except: [] } };

describe("what a helper sees: the rules", () => {
  test("Codex's list keeps only names and switches, never commands or their environment", () => {
    const list = parseMcpList(JSON.stringify(SERVERS));
    assert.deepEqual(list[0], { name: "cua-driver", enabled: true });
    assert.deepEqual(list.find((s) => s.name === "clickup"), { name: "clickup", enabled: false });
    assert.equal(JSON.stringify(list).includes("never-kept"), false);
    assert.deepEqual(parseMcpList("not json"), []);
    assert.deepEqual(parseMcpList(JSON.stringify({ name: "x" })), []);
    assert.deepEqual(parseMcpList(JSON.stringify([{ name: " a " }, { name: "a" }, { nope: 1 }, null])), [{ name: "a", enabled: true }]);
  });

  test("no choice, or one that changes nothing: a GPT helper's thread gets no config at all", () => {
    const list = parseMcpList(JSON.stringify(SERVERS));
    assert.deepEqual(codexSeesConfig(undefined, list), { config: {}, off: [] });
    assert.deepEqual(codexSeesConfig({ services: { rest: "on", except: [] } }, list), { config: {}, off: [] });
  });

  test("the Coding set: every server Codex listed and has on is off, and Codex's plugins and apps; names a key cannot hold are left", () => {
    const r = codexSeesConfig(CODING, parseMcpList(JSON.stringify(SERVERS)));
    assert.deepEqual(r.config, {
      "mcp_servers.cua-driver.enabled": false,
      "mcp_servers.hubspot-session.enabled": false,
      "mcp_servers.workbot.enabled": false,
      "mcp_servers.openaiDeveloperDocs.enabled": false,
      "mcp_servers.messages.enabled": false,
      "features.plugins": false,
      "features.apps": false,
    });
    assert.deepEqual(r.off, ["cua-driver", "hubspot-session", "workbot", "openaiDeveloperDocs", "messages", "plugins", "apps"]);
  });

  test("the rest on: only the services named off; plugins off by the choice; apps stay; switched on for one helper wins", () => {
    const list = parseMcpList(JSON.stringify(SERVERS));
    assert.deepEqual(codexSeesConfig(PO_LIKE, list).config, { "mcp_servers.hubspot-session.enabled": false, "features.plugins": false });
    assert.deepEqual(codexSeesConfig(PO_LIKE, list, ["HubSpot-Session"]).config, { "features.plugins": false });
    assert.deepEqual(codexSeesConfig(CODING, list, ["workbot", "codex_apps"]).off, ["cua-driver", "hubspot-session", "openaiDeveloperDocs", "messages", "plugins"]);
    // A choice that leaves the plugins and services alone (skills only): nothing for Codex.
    assert.deepEqual(codexSeesConfig({ skills: { rest: "name", except: [] } }, list).config, {});
  });

  test("switched on for one helper: on whichever side the rest is, and Pobots' own changes nothing", () => {
    assert.deepEqual(withAlsoOn(PO_LIKE, ["ado"])?.services, { rest: "on", except: ["hubspot-session"] });
    assert.deepEqual(withAlsoOn(CODING, ["claude.ai Notion", "pobots"])?.services, { rest: "off", except: ["plugin:1password:1password", "claude.ai Notion"] });
    assert.equal(withAlsoOn(undefined, ["ado"]), undefined);
    assert.equal(withAlsoOn(PO_LIKE, []), PO_LIKE);
    // The last exception gone and nothing else: the choice changes nothing any more.
    assert.equal(seesIsEverything(withAlsoOn({ services: { rest: "on", except: ["ado"] } }, ["ado"])), true);
  });

  test("the server a refused thread named is read from Codex's message", () => {
    assert.equal(refusedServer(new Error("failed to load configuration: invalid transport\nin `mcp_servers.messages`\n")), "messages");
    assert.equal(refusedServer(new Error("something else")), undefined);
  });

  test("listing Codex's servers runs the program asked with `mcp list --json`, and fails to an empty list", async () => {
    const fake = fakeCodex({ FAKE_CODEX_MCP: JSON.stringify(SERVERS) });
    const list = await listCodexMcp({ executable: fake.setup.executable!, args: fake.setup.args, env: fake.setup.env, cwd: fake.dir });
    assert.deepEqual(list.map((s) => s.name), SERVERS.map((s) => s.name));
    assert.deepEqual(await listCodexMcp({ executable: "/nowhere/codex", cwd: fake.dir }), []);
  });
});

describe("what a helper sees: the engine", () => {
  const helperInput = (o: Record<string, unknown> = {}) => ({ title: "Say a word", task: "Answer with one word [[answer:plommon]]", model: "gpt-6-luna", effort: "low", ...o });

  async function callHelper(s: FakeSession, input: Record<string, unknown>, id: string) {
    s.emit({ type: "tool-start", toolUseId: id, name: "mcp__pobots__start_helper", input });
    const r = await s.tool("start_helper", input);
    s.emit({ type: "tool-end", toolUseId: id, isError: r.isError === true, text: r.content[0]!.text });
    await settle();
    return r;
  }

  async function world(sees: BotSees | null, env: Record<string, string> = { FAKE_CODEX_MCP: JSON.stringify(SERVERS) }) {
    let lists = 0;
    const codex = fakeCodex(env);
    const w = codexWorld({ codex, listCodexMcp: async (o) => (lists++, listCodexMcp(o)) });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    if (sees) await w.engine.updateBot({ botId: bot.id, patch: { sees } });
    w.engine.sendMessage({ botId: bot.id, text: "Get help" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    return { w, s, bot, lists: () => lists };
  }

  const config = (w: ReturnType<typeof codexWorld>) => (w.codex.received("thread/start").at(-1)!.config ?? {}) as Record<string, unknown>;

  test("a bot without a choice: its GPT helper's thread is started as before, and Codex is not asked for its list", async () => {
    const { w, s, lists } = await world(null);
    const r = await callHelper(s, helperInput(), "tu-1");
    assert.match(r.content[0]!.text, /is done/);
    assert.equal(Object.keys(config(w)).some((k) => k.startsWith("mcp_servers") || k.startsWith("features")), false);
    assert.equal(lists(), 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("a bot with the Coding set: its GPT helper's thread switches off Codex's servers, plugins and apps; a second helper uses the same list", async () => {
    const { w, s, lists } = await world(CODING);
    const r = await callHelper(s, helperInput(), "tu-1");
    assert.match(r.content[0]!.text, /is done/);
    const c = config(w);
    assert.equal(c["mcp_servers.cua-driver.enabled"], false);
    assert.equal(c["mcp_servers.workbot.enabled"], false);
    assert.equal(c["features.plugins"], false);
    assert.equal(c["features.apps"], false);
    assert.deepEqual(c["tools.update_plan"], { enabled: true }, "the plan tool is still on");
    assert.equal("mcp_servers.clickup.enabled" in c, false, "a server Codex has off is not named");
    assert.equal("mcp_servers.messages.enabled" in c, false, "a plugin's server Codex refused is dropped, the rest kept");
    const starts = w.codex.received("thread/start").length;
    await callHelper(s, helperInput({ title: "Again" }), "tu-2");
    assert.equal(lists(), 1, "the list is kept a few minutes");
    assert.equal(w.codex.received("thread/start").length, starts + 1, "the refused name is remembered: one try");

    // services: one more switched on for this helper only; the bot's choice does not change.
    await callHelper(s, helperInput({ title: "With HubSpot", services: ["hubspot-session"] }), "tu-3");
    assert.equal("mcp_servers.hubspot-session.enabled" in config(w), false);
    assert.equal(config(w)["mcp_servers.workbot.enabled"], false);
    assert.deepEqual(w.engine.snapshot().bots[0]!.sees, CODING);
    w.engine.shutdown();
    w.store.close();
  });

  test("a list that is out of date (Codex refuses the thread): the helper still starts, without that name", async () => {
    // The list names a server the fake Codex does not have, as when one was removed meanwhile.
    const codex = fakeCodex({ FAKE_CODEX_MCP: JSON.stringify([{ name: "workbot", enabled: true }]) });
    const w = codexWorld({ codex, listCodexMcp: async () => [{ name: "gone", enabled: true }] });
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    await w.engine.updateBot({ botId: bot.id, patch: { sees: CODING } });
    w.engine.sendMessage({ botId: bot.id, text: "Get help" });
    await settle();
    const s = w.sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const r = await callHelper(s, helperInput(), "tu-1");
    assert.match(r.content[0]!.text, /is done/);
    const starts = w.codex.received("thread/start");
    assert.equal(starts.length, 2, "once with the name Codex does not have, once without it");
    const second = (starts[1]!.config ?? {}) as Record<string, unknown>;
    assert.equal("mcp_servers.gone.enabled" in second, false);
    assert.equal(second["features.plugins"], false, "the rest of the choice holds");
    w.engine.shutdown();
    w.store.close();
  });

  test("a Claude helper: services switches a service on that the bot has off", async () => {
    const { w, s } = await world({ services: { rest: "on", except: ["ado", "claude.ai Notion"] } });
    const before = w.sessions.length;
    const input = { title: "Look", task: "Say a word", model: "claude-haiku-5-5", wait: false, services: ["ado"] };
    s.emit({ type: "tool-start", toolUseId: "tu-c", name: "mcp__pobots__start_helper", input });
    const r = await s.tool("start_helper", input);
    assert.match(r.content[0]!.text, /Started/);
    await waitFor(() => w.sessions.length > before, 2000, "the helper's session");
    assert.deepEqual(w.sessions.at(-1)!.settings.sees, { deniedMcpServers: [{ serverName: "claude.ai Notion" }] });
    w.engine.shutdown();
    w.store.close();
  });

  test("a task manager on a GPT model and its GPT worker follow the bot's choice too", async () => {
    const { w, s } = await world(PO_LIKE);
    const answer = await s.tool("start_task_manager", { title: "Build it", task: "Build it [[answer:started]]", model: "gpt-6-luna", effort: "low" });
    assert.match(answer.content[0]!.text, /Started task manager/);
    await waitFor(() => w.codex.received("thread/start").length >= 1, 8000, "the task manager's thread");
    assert.equal(config(w)["mcp_servers.hubspot-session.enabled"], false);
    assert.equal(config(w)["features.plugins"], false);
    assert.equal("mcp_servers.workbot.enabled" in config(w), false, "on for the bot, on for it");
    w.engine.shutdown();
    w.store.close();
  });
});
