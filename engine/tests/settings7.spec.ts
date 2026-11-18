// Step 7b (14 Nov 2026): the settings window's settings, the providers and their update, usage from
// a hub and from the providers, chat titles, and the main bot's settings tools. Nothing here reaches
// the network, runs a real program or calls a model: every outside thing has a stand-in.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Events, NoteCard, UserItem } from "../../shared/protocol.js";
import { cleanContext, CONTEXT_DEFAULTS, loadConfigFile } from "../config.js";
import { EngineError } from "../errors.js";
import { latestVersion, newer, updatePlan, type Fetcher, type Runner } from "../providers.js";
import { applyPatch, cleanHubUrl, readSettingsFile, settingsView } from "../settings.js";
import { cleanTitle, TITLE_INPUT_MAX, titleInput } from "../titles.js";
import { claudeWindows, codexWindows, hubAddress, readHub } from "../usage.js";
import { changeLines, noteCards, settle, setup, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const code = (c: string) => (err: unknown) => err instanceof EngineError && err.code === c;
const notes = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).filter((c): c is NoteCard => c.kind === "note");

async function turnOf(engine: ReturnType<typeof setup>["engine"], sessions: FakeSession[], botId: string): Promise<FakeSession> {
  engine.sendMessage({ botId, text: "Go" });
  await settle();
  const s = sessions.filter((x) => x.settings.botId === botId).at(-1);
  assert.ok(s);
  return s;
}

describe("step 7b: the settings", () => {
  test("defaults, a value per provider, reset, and config.json keeps everything else", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ chat: { followUp: "queue" }, context: { minTokens: 120000, codex: { coldHours: 2 } }, notify: { needs: false } }));
    const file = loadConfigFile(dir).settings!;
    const v = settingsView(file);
    assert.equal(v.timing.claude.minTokens, 120000, "the setting for all providers is the default of each");
    assert.equal(v.timingDefaults.codex.minTokens, 120000);
    assert.equal(v.timing.codex.coldHours, 2);
    assert.deepEqual(v.timingSet, { claude: [], codex: ["coldHours"] });
    assert.equal(v.healthCheckSeconds, 300);
    assert.equal(v.titleModel, "claude-haiku-5-5");
    const models = [{ id: "claude-haiku-5-5", harness: "claude" }, { id: "claude-sonnet-5-5", harness: "claude" }, { id: "gpt-6-luna", harness: "codex" }];
    const next = applyPatch(file, { timing: { claude: { minTokens: 150000 }, codex: { coldHours: null } }, titleModel: "claude-sonnet-5-5", healthCheckSeconds: 0 }, models);
    assert.equal(settingsView(next).timing.claude.minTokens, 150000);
    assert.equal(settingsView(next).timing.codex.coldHours, CONTEXT_DEFAULTS.coldHours);
    // Since 18 Nov 2026 a GPT model may name chats too (through Codex); a model not in the list never.
    assert.equal(settingsView(applyPatch(file, { titleModel: "gpt-6-luna" }, models)).titleModel, "gpt-6-luna");
    assert.throws(() => applyPatch(file, { titleModel: "gpt-6.1-luna" }, models), /not in the list/);
    assert.throws(() => applyPatch(file, { healthCheckSeconds: 10 }, models), /0 \(never\) or from 30/);
    assert.throws(() => applyPatch(file, { timing: { claude: { fullFraction: 2 } } }, models), /share above 0/);
    // A bad value in config.json never stops the engine.
    const bad = readSettingsFile({ context: { claude: { minTokens: -5 } }, providers: { healthCheckSeconds: "x" }, titles: { model: "no spaces allowed" } }, undefined);
    assert.deepEqual(bad.perProvider.claude, {});
    assert.equal(bad.healthCheckSeconds, undefined);
    assert.equal(bad.titleModel, undefined);
  });

  test("settings.set saves to config.json, tells every window once, and the fresh-start rules use each provider's values", () => {
    const { engine, store, events, dirs } = setup();
    const bot = engine.createBot("Po");
    const r = engine.settingsSet({ timing: { claude: { minTokens: 140000, fullTokens: 200000 } }, healthCheckSeconds: 600 });
    assert.ok(r.changes.some((c) => /worth a fresh start from from 100,000 tokens to 140,000 tokens/i.test(c) || /140,000/.test(c)), r.changes.join("; "));
    const cfg = JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
    assert.equal(cfg.context.claude.minTokens, 140000);
    assert.equal(cfg.providers.healthCheckSeconds, 600);
    assert.equal(events.filter((e) => e.event === "settings.changed").length, 1);
    // The bot's "how full" is measured against the new limit (200,000 for its Claude model).
    assert.equal(engine.snapshot().bots.find((b) => b.id === bot.id)!.context!.window, 150000, "the share of the 200,000 window (75%) is smaller here");
    engine.settingsSet({ timing: { claude: { fullFraction: 1 } } });
    assert.equal(engine.snapshot().bots.find((b) => b.id === bot.id)!.context!.window, 200000);
    // The same again changes nothing and says nothing.
    const again = engine.settingsSet({ healthCheckSeconds: 600 });
    assert.deepEqual(again.changes, []);
    engine.shutdown();
    store.close();
  });

  test("the size at which the harness summarises by itself: 500,000 for Claude and 300,000 for Codex unless set, per provider, refused out of range, and a session started after a change works under it", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Po");
    assert.equal(engine.snapshot().settings.timing.claude.compactTokens, 500000);
    assert.equal(engine.snapshot().settings.timing.codex.compactTokens, 300000);
    assert.equal(engine.snapshot().settings.timingDefaults.claude.compactTokens, 500000, "the default is the provider's own");
    assert.equal(engine.snapshot().settings.timingDefaults.codex.compactTokens, 300000);
    const first = await turnOf(engine, sessions, bot.id);
    assert.equal(first.settings.compactTokens, 500000, "the session is told the size");
    const r = engine.settingsSet({ timing: { claude: { compactTokens: 600000 } } });
    assert.ok(r.changes.some((c) => /600,000 tokens/.test(c)), r.changes.join("; "));
    assert.equal(JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8")).context.claude.compactTokens, 600000);
    assert.equal(engine.snapshot().settings.timing.codex.compactTokens, 300000, "the other provider keeps its own");
    assert.deepEqual(engine.snapshot().settings.timingSet.claude, ["compactTokens"]);
    assert.throws(() => engine.settingsSet({ timing: { claude: { compactTokens: 50000 } } }), /150,000 to 1,000,000/);
    assert.throws(() => engine.settingsSet({ timing: { codex: { compactTokens: 2_000_000 } } }), /150,000 to 1,000,000/);
    engine.settingsSet({ timing: { claude: { compactTokens: null } } });
    assert.equal(engine.snapshot().settings.timing.claude.compactTokens, 500000, "reset goes back to Claude's own default");
    // A bad value in config.json never stops the engine: the default is used.
    assert.equal(cleanContext({ compactTokens: 5 }, "config.json", () => undefined).compactTokens, 300000);
    engine.shutdown();
    store.close();
  });

  test("a size for all providers in config.json is each provider's default; without it each has its own", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ context: { compactTokens: 400000 } }));
    const set = settingsView(loadConfigFile(dir).settings!);
    assert.equal(set.timing.claude.compactTokens, 400000);
    assert.equal(set.timing.codex.compactTokens, 400000);
    const dir2 = tempDir();
    writeFileSync(join(dir2, "config.json"), JSON.stringify({ context: { minTokens: 120000 } }));
    const plain = settingsView(loadConfigFile(dir2).settings!);
    assert.equal(plain.timing.claude.compactTokens, 500000);
    assert.equal(plain.timing.codex.compactTokens, 300000);
  });

  test("a provider a bot runs on cannot be switched off; one that is off offers no models and takes no new bot", () => {
    const { engine, store } = setup();
    engine.createBot("Po");
    assert.throws(() => engine.settingsSet({ providers: { claude: { enabled: false } } }), (e: unknown) => code("conflict")(e) && /Po runs on it/.test((e as Error).message));
    engine.settingsSet({ providers: { codex: { enabled: false } } });
    assert.equal(engine.snapshot().settings.providers.codex.enabled, false);
    assert.ok(!engine.snapshot().models.some((m) => m.harness === "codex"));
    assert.throws(() => engine.createBot({ name: "Gee", model: "gpt-6-luna" }), /switched off/);
    engine.shutdown();
    store.close();
  });

  test("a bot's own steer or queue wins over the default, is saved in bot.json, and null goes back to the default", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Po");
    const s = await turnOf(engine, sessions, bot.id);
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    let steered = 0;
    (s as unknown as { steer: () => Promise<boolean> }).steer = async () => {
      steered++;
      return true;
    };
    await engine.updateBot({ botId: bot.id, patch: { followUp: "queue" } });
    assert.equal(JSON.parse(readFileSync(join(dirs.botsDir, bot.id, "bot.json"), "utf8")).followUp, "queue");
    assert.equal(engine.snapshot().bots[0]!.followUp, "queue");
    const m = engine.sendMessage({ botId: bot.id, text: "and this" });
    await settle();
    assert.equal((store.getItem(m.id) as UserItem).queued, true, "the bot's own choice queues it");
    assert.equal(steered, 0);
    await engine.updateBot({ botId: bot.id, patch: { followUp: null } });
    assert.equal(JSON.parse(readFileSync(join(dirs.botsDir, bot.id, "bot.json"), "utf8")).followUp, undefined);
    assert.equal(engine.snapshot().bots[0]!.followUp, undefined);
    engine.sendMessage({ botId: bot.id, text: "and that" });
    await settle();
    assert.equal(steered, 1, "back on the default, steer");
    engine.shutdown();
    store.close();
  });
});

describe("step 7b: the providers", () => {
  test("how each was installed, from the command's real path", () => {
    const home = realpathSync(tempDir());
    const claudeReal = join(home, ".local", "share", "claude", "versions", "2.1.325");
    const codexReal = join(home, ".codex", "packages", "standalone", "releases", "0.165.0", "bin", "codex");
    for (const p of [claudeReal, codexReal]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "#!/bin/sh\n");
    }
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(claudeReal, join(home, ".local", "bin", "claude"));
    symlinkSync(codexReal, join(home, ".local", "bin", "codex"));
    const c = updatePlan("claude", join(home, ".local", "bin", "claude"));
    assert.equal(c.method, "native");
    assert.deepEqual(c.args, ["update"]);
    assert.equal(c.command, join(home, ".local", "bin", "claude"));
    const x = updatePlan("codex", join(home, ".local", "bin", "codex"));
    assert.equal(x.method, "native");
    assert.deepEqual(x.env, { CODEX_HOME: join(home, ".codex") });
    assert.equal(updatePlan("codex", "/somewhere/else/codex").method, "other");
    assert.equal(updatePlan("claude", undefined).method, "none");
    assert.equal(newer("0.169.0", "0.165.0"), true);
    assert.equal(newer("2.1.325", "2.1.325"), false);
    assert.equal(newer("2.10.0", "2.9.9"), true);
  });

  test("the newest version is read from the install channel, and nothing breaks when it cannot be", async () => {
    const answers: Record<string, string> = {
      "https://releases.openai.com/codex/channels/latest": JSON.stringify({ tag_name: "rust-v0.169.0" }),
      "https://downloads.claude.ai/claude-code-releases/latest": "2.1.326\n",
    };
    const f: Fetcher = async (url) => ({ ok: url in answers, status: url in answers ? 200 : 404, text: async () => answers[url] ?? "" });
    assert.equal(await latestVersion({ method: "native", command: "x", args: [], latest: { kind: "codex-release", url: "https://releases.openai.com/codex/channels/latest" } }, f), "0.169.0");
    assert.equal(await latestVersion({ method: "native", command: "x", args: [], latest: { kind: "text", url: "https://downloads.claude.ai/claude-code-releases/latest" } }, f), "2.1.326");
    assert.equal(await latestVersion({ method: "native", command: "x", args: [], latest: { kind: "text", url: "https://nowhere.example.com" } }, f), undefined);
    const thrower: Fetcher = async () => {
      throw new Error("offline");
    };
    assert.equal(await latestVersion({ method: "native", command: "x", args: [], latest: { kind: "text", url: "https://x.example.com" } }, thrower), undefined);
  });

  test("the update waits for busy bots, runs the stand-in command, restarts the harness processes and says the result", async () => {
    const home = realpathSync(tempDir());
    const real = join(home, ".codex", "packages", "standalone", "releases", "0.165.0", "bin", "codex");
    mkdirSync(join(real, ".."), { recursive: true });
    writeFileSync(real, "#!/bin/sh\n");
    let version = "0.165.0";
    const ran: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const runner: Runner = async (command, args, o) => {
      if (args[0] === "--version") return { ok: true, out: `codex-cli ${version}` };
      ran.push({ command, args, env: o.env });
      version = "0.169.0";
      return { ok: true, out: "Updated." };
    };
    const fetcher: Fetcher = async (url) => ({ ok: true, status: 200, text: async () => (url.includes("openai") ? JSON.stringify({ tag_name: "rust-v0.169.0" }) : "9.9.9") });
    const { engine, store, sessions, events } = setup(undefined, () => true, undefined, {
      settingsHub: { runner, fetcher, timings: { updatePollMs: 20, firstCheckMs: 60_000 } },
    });
    // Codex as found: the standalone install, behind the newest.
    (engine as unknown as { codex: unknown }).codex = { ready: true, executable: real, version: "0.165.0", env: { HOME: home }, models: [] };
    await engine.providersCheck();
    const before = engine.snapshot().providers.providers.find((p) => p.id === "codex")!;
    assert.equal(before.updateAvailable, true);
    assert.equal(before.latest, "0.169.0");
    // A bot in a turn holds the update.
    const bot = engine.createBot("Po");
    const s = await turnOf(engine, sessions, bot.id);
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const started = await engine.providersUpdate();
    assert.equal(started.providers.update?.phase, "waiting");
    assert.match(started.providers.update!.line, /Waiting for Po to finish/);
    await assert.rejects(() => engine.providersUpdate(), code("conflict"));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ran.length, 0, "nothing runs while a bot works");
    s.emit({ type: "text-full", key: "t", text: "done" });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await engine.providersUpdated();
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0]!.args, ["update"]);
    assert.equal(ran[0]!.env.CODEX_HOME, join(home, ".codex"));
    const after = engine.snapshot().providers;
    assert.equal(after.update?.phase, "done");
    assert.match(after.update!.line, /Codex updated from 0\.165\.0 to 0\.169\.0/);
    assert.ok(s.closed, "the bot's harness process was closed so its next turn starts the new version");
    assert.ok(events.some((e) => e.event === "providers.changed"));
    engine.shutdown();
    store.close();
  });
});

describe("step 7b: usage", () => {
  test("Claude's and Codex's answers become windows", () => {
    const w = claudeWindows({
      five_hour: { utilization: 18, resets_at: "2026-11-14T11:40:00Z" },
      seven_day: { utilization: 45, resets_at: "2026-11-18T17:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 46, resets_at: "2026-11-18T17:00:00Z" }],
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 59, utilization: null },
    });
    assert.deepEqual(
      w.map((x) => [x.id, x.label, x.usedPercent]),
      [
        ["five_hour", "Session", 18],
        ["seven_day", "Weekly", 45],
        ["seven_day_fable", "Weekly · Fable", 46],
        ["monthly_spend", "Monthly spend", 59],
      ],
    );
    const c = codexWindows({ primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1763121414 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1763368819 } });
    assert.deepEqual(c.map((x) => [x.id, x.kind, x.usedPercent]), [["primary", "session", 3], ["secondary", "weekly", 100]]);
    assert.deepEqual(codexWindows({ limitId: "gpt-6-luna", primary: { usedPercent: 3 } }), [], "a model's own limit is not the main one");
  });

  test("a CLIProxyAPI hub (a stand-in server): accounts by provider; a wrong key says so without the key", async () => {
    const KEY = "secret-management-key-123";
    const calls: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        calls.push(`${req.method} ${req.url}`);
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401).end("no");
          return;
        }
        if (req.url === "/v0/management/auth-files") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              files: [
                { id: "a1", auth_index: "1", provider: "claude", email: "kaja@example.com" },
                { id: "a2", auth_index: "2", provider: "codex", email: "ops@example.com", id_token: { chatgpt_account_id: "acc" } },
                { id: "a3", auth_index: "3", provider: "gemini" },
                { id: "a4", auth_index: "4", provider: "claude", disabled: true },
              ],
            }),
          );
          return;
        }
        const call = JSON.parse(body) as { auth_index: string; url: string; header: Record<string, string> };
        assert.equal(call.header.Authorization, "Bearer $TOKEN$", "the hub puts the account's own token in");
        if (call.auth_index === "1") res.writeHead(200).end(JSON.stringify({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 30, resets_at: null } }) }));
        else res.writeHead(200).end(JSON.stringify({ status_code: 200, body: JSON.stringify({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 }, secondary_window: { used_percent: 88, limit_window_seconds: 604800 } } }) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const url = cleanHubUrl(`http://127.0.0.1:${port}/management.html`)!;
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.equal(hubAddress(url, "auth-files"), `http://127.0.0.1:${port}/v0/management/auth-files`);
    const providers = await readHub({ url, key: KEY, label: "hub" });
    assert.deepEqual(providers.map((p) => [p.id, p.accounts.length]), [["claude", 1], ["codex", 1]]);
    assert.equal(providers[1]!.accounts[0]!.plan, "Pro");
    assert.equal(providers[1]!.accounts[0]!.windows[1]!.usedPercent, 88);
    await assert.rejects(readHub({ url, key: "wrong", label: "hub" }), (e: Error) => e.message === "The hub refused the key." && !e.message.includes(KEY));
    server.close();
    assert.equal(cleanHubUrl("http://example.com"), undefined, "only https, or http on this machine");
    assert.equal(cleanHubUrl("https://user:pw@example.com"), undefined);
  });

  test("a hub's key is kept only in a file only the engine's user reads, never in config.json, an event or the settings", async () => {
    const { engine, store, events, dirs } = setup(undefined, () => true, undefined, {
      settingsHub: { fetcher: async () => ({ ok: false, status: 401, text: async () => "" }) },
    });
    const KEY = "kkkkkkkkkkkkkkkkkkkkkkkk-very-secret";
    const r = engine.usageHubAdd({ url: "https://hub-mac.example.net:8443/management.html", key: KEY });
    assert.equal(r.settings.hubs[0]!.url, "https://hub-mac.example.net:8443");
    assert.equal(r.settings.hubs[0]!.keyKind, "saved");
    const file = join(dirs.dataDir, "secrets", "usage-hubs.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dirs.dataDir, "secrets")).mode & 0o777, 0o700);
    assert.ok(readFileSync(file, "utf8").includes(KEY));
    assert.ok(!readFileSync(join(dirs.dataDir, "config.json"), "utf8").includes(KEY));
    assert.ok(!JSON.stringify(events).includes(KEY));
    assert.ok(!JSON.stringify(engine.snapshot()).includes(KEY));
    const u = await engine.usageRead({ refresh: true });
    assert.equal(u.usage.source, "hub");
    assert.match(u.usage.problem ?? "", /refused the key/);
    assert.ok(!JSON.stringify(u).includes(KEY));
    assert.throws(() => engine.usageHubAdd({ url: "https://hub-mac.example.net:8443", key: "x" }), code("conflict"));
    engine.usageHubRemove({ id: r.settings.hubs[0]!.id });
    assert.ok(!readFileSync(file, "utf8").includes(KEY));
    assert.equal(engine.snapshot().settings.hubs.length, 0);
    engine.shutdown();
    store.close();
  });

  test("without a hub, usage comes from Claude Code and Codex on this Mac", async () => {
    const { engine, store } = setup(undefined, () => true, undefined, {
      settingsHub: { readClaude: async () => ({ id: "claude-local", via: "This Mac", windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }] }) },
    });
    const u = await engine.usageRead({ refresh: true });
    assert.equal(u.usage.source, "providers");
    assert.deepEqual(u.usage.providers.map((p) => p.id), ["claude"], "Codex is not ready here");
    engine.shutdown();
    store.close();
  });
});

describe("step 7b: chat titles", () => {
  test("what is sent: the start and the end, never more than the cap", () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ kind: "user", id: `u${i}`, threadId: "t", seq: i + 1, at: "2026-11-14T08:00:00Z", text: `message ${i} `.repeat(30), from: { type: "you" }, queued: false }) as UserItem);
    const t = titleInput(long, "main");
    assert.ok(t.length <= TITLE_INPUT_MAX);
    assert.match(t, /^Person: message 0 /);
    assert.match(t, /message 399/);
    assert.match(t, /middle left out/);
    assert.equal(cleanTitle('Title: "Backup key and OneDrive folder."'), "Backup key and OneDrive folder");
    assert.equal(cleanTitle("   "), undefined);
    assert.equal(cleanTitle('{"title":"Node timer run"}'), "Node timer run");
  });

  test("a fresh start titles the session that ended; search_chat finds it by its title and names it on each hit", async () => {
    const asked: string[] = [];
    const { engine, store, sessions } = setup(undefined, () => true, undefined, {
      titleMaker: async (t) => {
        asked.push(t);
        return "Planning the Acme survey launch";
      },
    });
    const bot = engine.createBot("Po");
    const s = await turnOf(engine, sessions, bot.id);
    s.reply("We launch the Acme survey on Monday.");
    await settle();
    // A fresh start now: the tidy turn, its note, and the "fresh" line.
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    s.reply("Note: the Acme survey launches Monday.", "sess-1");
    await settle();
    await engine.titlesSettled();
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /Person: Go/);
    assert.ok(!/Note from Pobots/.test(asked[0]!), "the tidy request is not sent");
    const titles = engine.chatTitles({ botId: bot.id });
    assert.equal(titles.chats.length, 1);
    assert.equal(titles.chats[0]!.title, "Planning the Acme survey launch");
    assert.equal(titles.chats[0]!.kind, "main");
    assert.ok(titles.chats[0]!.toSeq! > titles.chats[0]!.fromSeq);
    // search_chat: by the title, and the hit names its chat.
    const s2 = await turnOf(engine, sessions, bot.id);
    const byTitle = text(await s2.tool("search_chat", { query: "planning launch" }));
    assert.match(byTitle, /Chats whose title holds the words:\n- "Planning the Acme survey launch"/);
    const byWord = text(await s2.tool("search_chat", { query: "Monday" }));
    assert.match(byWord, /in the chat "Planning the Acme survey launch"/);
    engine.shutdown();
    store.close();
  });

  test("the backfill titles old chats slowly, once, and stops at its cap", async () => {
    let n = 0;
    const { engine, store, sessions } = setup(undefined, () => true, undefined, {
      titleMaker: async () => `Title ${++n}`,
      titleTimings: { backfillStartMs: 10, backfillEveryMs: 10 },
    });
    const bot = engine.createBot("Po");
    // A helper thread from before, with nothing titled yet.
    const th = store.createThread(bot.id, "helper");
    store.addItem(th.id, { kind: "user", at: new Date().toISOString(), text: "Compare the two exports", from: { type: "bot", botId: bot.id, expectsReply: true }, queued: false });
    store.addItem(th.id, { kind: "bot", at: new Date().toISOString(), botId: bot.id, text: "They match.", streaming: false });
    void sessions;
    await new Promise((r) => setTimeout(r, 200));
    await engine.titlesSettled();
    const got = engine.chatTitles({ botId: bot.id }).chats;
    assert.deepEqual(got.map((c) => [c.kind, c.title]), [["helper", "Title 1"]]);
    assert.ok(store.hasMark("titles-backfill-done"));
    engine.shutdown();
    store.close();
  });
});

describe("step 7b: the main bot's settings tools", () => {
  test("only the main bot has them; a change needs no card and leaves a quiet line in its chat that says what changed", async () => {
    const { engine, store, sessions, events } = setup();
    const main = engine.createBot("Po");
    const other = engine.createBot("Bo");
    const ms = await turnOf(engine, sessions, main.id);
    const bs = await turnOf(engine, sessions, other.id);
    assert.ok(!bs.toolNames().includes("change_settings"));
    const read = text(await ms.tool("get_settings"));
    assert.match(read, /follow_up_default\): steer/);
    assert.match(read, /Fresh starts \(chats\), Claude bots: enabled true \(default\), minTokens 100000 \(default\)/);
    const changed = text(await ms.tool("change_settings", { follow_up_default: "queue", bot_follow_up: { bot: "Bo", choice: "steer" }, chats: { provider: "claude", minTokens: 160000 }, title_model: "claude-sonnet-5-5" }));
    assert.match(changed, /person has a note/);
    assert.equal(engine.snapshot().chat.followUp, "queue");
    assert.equal(engine.snapshot().bots.find((b) => b.id === other.id)!.followUp, "steer");
    assert.equal(engine.snapshot().settings.timing.claude.minTokens, 160000);
    assert.equal(engine.snapshot().settings.titleModel, "claude-sonnet-5-5");
    assert.ok(!events.some((e) => e.event === "card.added"), "no card to approve, no note card");
    // A refusal says why and changes nothing.
    const refused = await ms.tool("change_settings", { providers: { claude: false } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /cannot be switched off while Po and Bo run on it/);
    // The line comes when the turn ends, in Po's chat: what changed, from what to what.
    assert.deepEqual(changeLines(events, main.mainThreadId), []);
    ms.reply("Done.");
    await settle();
    assert.deepEqual(changeLines(events, main.mainThreadId), [
      "Pobots settings: Claude Code chats, worth a fresh start from 160,000 tokens (was 100,000 tokens); chat titles made by Sonnet 5.5 (was Haiku 5.5); a message sent while a bot works: queue (was steer); Bo, a message sent while it works: steer (was the Pobots default)",
    ]);
    assert.equal(noteCards(events).length, 0);
    engine.shutdown();
    store.close();
  });
});
