// Engine 0.34.0 (protocol 25): a public install updates itself with one click
// (docs/build/step-self-update.md). Every repository here is a temporary one on this disk: a bare
// "remote" and a clone of it as the install. Nothing reaches GitHub; the build and the hand-over to
// the restart job are stand-ins, git is real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Events } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { loadConfigFile, parseFlags } from "../config.js";
import { ENGINE_VERSION } from "../engine.js";
import { EngineError } from "../errors.js";
import { gitAvailable } from "../history.js";
import { realRunner, type Runner } from "../providers.js";
import { PUBLIC_REPO, repoKey, sourceCandidate, versionIn } from "../self-update.js";
import { teamPrompt } from "../team.js";
import { settle, setup, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const approvals = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card).filter((c): c is ApprovalCard => c.kind === "approval");
const code = (c: string, re?: RegExp) => (err: unknown) => err instanceof EngineError && err.code === c && (!re || re.test(err.message));
const NEXT = (() => {
  const [a, b, c] = ENGINE_VERSION.split(".").map(Number);
  return `${a}.${b}.${c! + 1}`;
})();
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
/** The public repository's owner and name, from its one address in engine/self-update.ts. */
const [OWNER, NAME] = new URL(PUBLIC_REPO).pathname.slice(1).split("/") as [string, string];
const PRIVATE = `git@github.com:${OWNER}/private-copy.git`;
const engineTs = (v: string) => `// stand-in\nexport const ENGINE_VERSION = "${v}";\n`;

/** A bare remote with the running version on main, a clone of it (the install), and a newer commit on the remote. */
function repos(o: { newer?: boolean; packages?: boolean; remoteUrl?: string } = {}) {
  const root = tempDir("pobots-self-");
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const clone = join(root, "clone");
  mkdirSync(work);
  g(root, "init", "--bare", "-q", remote);
  g(work, "init", "-q", "-b", "main");
  mkdirSync(join(work, "engine"));
  writeFileSync(join(work, "engine", "engine.ts"), engineTs(ENGINE_VERSION));
  writeFileSync(join(work, "package.json"), '{ "name": "pobots" }\n');
  writeFileSync(join(work, "README.md"), "Pobots\n");
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "first");
  g(work, "remote", "add", "origin", remote);
  g(work, "push", "-q", "origin", "main");
  g(root, "clone", "-q", remote, clone);
  if (o.remoteUrl) g(clone, "remote", "set-url", "origin", o.remoteUrl);
  if (o.newer !== false) {
    writeFileSync(join(work, "engine", "engine.ts"), engineTs(NEXT));
    if (o.packages) writeFileSync(join(work, "package.json"), '{ "name": "pobots", "dependencies": {} }\n');
    g(work, "commit", "-q", "-am", "newer");
    g(work, "push", "-q", "origin", "main");
  }
  return { root, remote, work, clone, head: () => g(clone, "rev-parse", "HEAD"), remoteHead: () => g(work, "rev-parse", "HEAD") };
}

/** Real git; the build, the install and the hand-over are stand-ins that say what they were asked. */
function runner(o: { build?: boolean; handOver?: boolean } = {}) {
  const calls: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const run: Runner = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    if (command === "git") return realRunner(command, args, opts);
    if (args[0]?.endsWith("build.mjs")) {
      if (o.build === false) return { ok: false, out: "error: the build broke" };
      const out = opts.env.POBOTS_BUILD_OUT!;
      mkdirSync(join(out, "engine"), { recursive: true });
      mkdirSync(join(out, "ui"), { recursive: true });
      writeFileSync(join(out, "engine", "main.mjs"), "// built\n");
      writeFileSync(join(out, "ui", "index.html"), "<!doctype html>\n");
      return { ok: true, out: "Built" };
    }
    if (args[0]?.endsWith("live-update.mjs")) return o.handOver === false ? { ok: false, out: "launchd would not start the update" } : { ok: true, out: "handed over" };
    return { ok: true, out: "" };
  };
  const not = (command: string) => calls.filter((c) => c.command !== command);
  return { run, calls, not, gitCalls: () => calls.filter((c) => c.command === "git").map((c) => c.args.slice(2).join(" ")) };
}

function engineOn(installDir: string | undefined, r: ReturnType<typeof runner>, o: { repo?: string; shell?: boolean; dataDir?: string; botsDir?: string } = {}) {
  const dirs = { dataDir: o.dataDir ?? tempDir(), botsDir: o.botsDir ?? tempDir() };
  return setup(dirs, undefined, undefined, {
    ...(installDir ? { selfUpdate: { installDir, ...(o.repo ? { config: { repo: o.repo } } : {}), shell: o.shell ?? true, run: r.run, isService: async () => false, timings: { firstCheckMs: 1e9, pollMs: 10, jobPollMs: 10, minForcedMs: 60_000 } } } : {}),
  });
}

const skip = !gitAvailable();

describe("engine 0.34.0: which install updates itself", { skip }, () => {
  test("the public repository in its https, ssh and scp forms; versions; the flags and config.json", () => {
    const want = repoKey(PUBLIC_REPO);
    for (const u of [`https://github.com/${OWNER}/${NAME}.git`, `git@github.com:${OWNER}/${NAME}.git`, `ssh://git@github.com/${OWNER.toUpperCase()}/${NAME}`, `https://github.com/${OWNER}/${NAME}/`]) assert.equal(repoKey(u), want, u);
    for (const u of [PRIVATE, `https://github.com/someone/${NAME}`, `https://example.com/${OWNER}/${NAME}`]) assert.notEqual(repoKey(u), want, u);
    assert.equal(versionIn(engineTs("1.2.3")), "1.2.3");
    assert.equal(versionIn("nothing"), undefined);
    assert.equal(parseFlags(["--shell"]).shell, true);
    assert.equal(parseFlags(["--port=0", "--data-dir=/tmp/x"]).shell, undefined);
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ updates: { repo: "https://example.com/a/b", checkHours: 0, source: "~/x", branch: "bad..name" } }));
    assert.deepEqual(loadConfigFile(dir).updates, { repo: "https://example.com/a/b", checkHours: 0, source: "~/x" });
  });

  test("the source folder: config.json, then source.json, then the build's own clone; an installed copy has none", () => {
    const plain = tempDir();
    assert.equal(sourceCandidate(plain, undefined), undefined, "an installed copy (~/.local/share/pobots): no git, no source.json");
    writeFileSync(join(plain, "source.json"), JSON.stringify({ repo: "/some/clone" }));
    assert.equal(sourceCandidate(plain, undefined), "/some/clone");
    assert.equal(sourceCandidate(plain, { source: "/set/by/hand" }), "/set/by/hand");
    const r = repos({ newer: false });
    assert.equal(sourceCandidate(r.clone, undefined), r.clone);
  });

  test("the real Pobots and the test copy: nothing runs, nothing shows, no git at all for an installed copy", async () => {
    // An installed copy, as ~/.local/share/pobots: no source.json, not a git repository.
    const r1 = runner();
    const w1 = engineOn(tempDir(), r1);
    await w1.engine.hub.selfKnown();
    await w1.engine.providersCheck();
    assert.equal(w1.engine.snapshot().providers.pobots, undefined);
    assert.equal(r1.calls.length, 0, "not one command");
    await assert.rejects(() => w1.engine.providersUpdate({ pobots: true }), code("conflict", /updates another way/));
    w1.engine.shutdown();
    w1.store.close();
    // A clone of the private repository (a check's engine runs from one), and the test copy whose
    // source.json names one: looked at, never fetched, nothing shown.
    const priv = repos({ remoteUrl: PRIVATE });
    const copy = tempDir();
    writeFileSync(join(copy, "source.json"), JSON.stringify({ repo: priv.clone }));
    for (const dir of [priv.clone, copy]) {
      const r = runner();
      const w = engineOn(dir, r);
      await w.engine.hub.selfKnown();
      await w.engine.providersCheck();
      assert.equal(w.engine.snapshot().providers.pobots, undefined);
      assert.ok(!r.gitCalls().some((c) => c.startsWith("fetch")), "never fetched");
      w.engine.shutdown();
      w.store.close();
    }
  });

  test("a clone of the public repository (its default address): found, and nothing more until it looks", async () => {
    const r = repos({ remoteUrl: `git@github.com:${OWNER}/${NAME}.git` });
    const run = runner();
    const w = engineOn(r.clone, run);
    await w.engine.hub.selfKnown();
    const p = w.engine.snapshot().providers.pobots;
    assert.ok(p);
    assert.equal(p.current, ENGINE_VERSION);
    assert.equal(p.available, false);
    assert.equal(p.canRestart, true);
    assert.ok(!run.gitCalls().some((c) => c.startsWith("fetch")), "no look before the first check");
    w.engine.shutdown();
    w.store.close();
  });
});

describe("engine 0.34.0: looking for a new version", { skip }, () => {
  test("one fetch finds the newer version; a forced look runs at most once a minute; a failed look is one calm line", async () => {
    const r = repos();
    const run = runner();
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    await w.engine.providersCheck();
    let p = w.engine.snapshot().providers.pobots!;
    assert.equal(p.latest, NEXT);
    assert.equal(p.available, true);
    assert.ok(p.checkedAt);
    assert.equal(p.problem, undefined);
    assert.equal(r.head() !== r.remoteHead(), true, "looking changes nothing in the folder");
    await w.engine.providersCheck();
    assert.equal(run.gitCalls().filter((c) => c.startsWith("fetch")).length, 1, "a second Check now within the minute does not fetch again");
    assert.ok(w.events.some((e) => e.event === "providers.changed" && (e.data as Events["providers.changed"]).providers.pobots?.available), "every window hears of it");
    w.engine.shutdown();
    w.store.close();

    // The remote gone: the look fails calmly and says so in one line.
    const gone = repos({ newer: false });
    g(gone.clone, "remote", "set-url", "origin", join(gone.root, "nowhere.git"));
    const run2 = runner();
    const w2 = engineOn(gone.clone, run2, { repo: join(gone.root, "nowhere.git") });
    await w2.engine.hub.selfKnown();
    await w2.engine.providersCheck();
    p = w2.engine.snapshot().providers.pobots!;
    assert.equal(p.available, false);
    assert.match(p.problem ?? "", /could not look for a new version just now/);
    w2.engine.shutdown();
    w2.store.close();
  });
});

describe("engine 0.34.0: the update", { skip }, () => {
  test("refused plainly, changing nothing: changes of its own, commits of its own, no way to restart", async () => {
    const r = repos();
    writeFileSync(join(r.clone, "README.md"), "Changed here\n");
    const run = runner();
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    await w.engine.providersCheck();
    const before = r.head();
    await assert.rejects(() => w.engine.providersUpdate(), code("conflict", /has changes of its own\. Commit or undo them/));
    assert.equal(r.head(), before);
    assert.equal(w.engine.snapshot().providers.pobots!.run, null);
    // Undone, then a commit of its own: it cannot simply move forward.
    g(r.clone, "checkout", "-q", "--", "README.md");
    writeFileSync(join(r.clone, "mine.txt"), "mine\n");
    g(r.clone, "add", "mine.txt");
    g(r.clone, "commit", "-q", "-m", "mine");
    const mine = r.head();
    await assert.rejects(() => w.engine.providersUpdate(), code("conflict", /commits of its own/));
    assert.equal(r.head(), mine);
    assert.equal(run.not("git").length, 0, "no build, no install, no hand-over");
    w.engine.shutdown();
    w.store.close();

    // Started neither by the window nor as the service: shown, but it says how to update by hand.
    const r2 = repos();
    const w2 = engineOn(r2.clone, runner(), { repo: r2.remote, shell: false });
    await w2.engine.hub.selfKnown();
    await w2.engine.providersCheck();
    assert.equal(w2.engine.snapshot().providers.pobots!.canRestart, false);
    await assert.rejects(() => w2.engine.providersUpdate({ pobots: true }), code("conflict", /cannot restart itself here/));
    w2.engine.shutdown();
    w2.store.close();
  });

  test("one click: waits for the bots, moves forward, builds beside the running build, hands over; the job's result is told", async () => {
    const r = repos();
    const old = r.head();
    const run = runner();
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    await w.engine.providersCheck();
    // A bot in a turn holds it.
    const po = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: po.id, text: "Go" });
    await settle();
    const s = w.sessions.find((x) => x.settings.botId === po.id)!;
    const started = await w.engine.providersUpdate();
    assert.equal(started.providers.update, null, "Claude Code and Codex had nothing to update");
    assert.equal(started.providers.pobots!.run!.phase, "waiting");
    assert.match(started.providers.pobots!.run!.line, /Waiting for Po to finish/);
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(r.head(), old, "nothing moves while a bot works");
    await assert.rejects(() => w.engine.providersUpdate(), code("conflict", /already running/));
    s.reply("Done.");
    await w.engine.hub.selfSettled();
    assert.equal(r.head(), r.remoteHead(), "the folder moved forward");
    const phases = w.events.filter((e) => e.event === "providers.changed").map((e) => (e.data as Events["providers.changed"]).providers.pobots?.run?.phase);
    for (const ph of ["waiting", "pulling", "building", "restarting"]) assert.ok(phases.includes(ph as never), ph);
    assert.ok(!phases.includes("installing"), "no install: the packages did not change");
    const build = run.calls.find((c) => c.args[0]?.endsWith("build.mjs"))!;
    assert.equal(build.env.POBOTS_BUILD_OUT, join(w.dirs.dataDir, "updates", "build", "dist"), "built beside the running build");
    const hand = run.calls.find((c) => c.args[0]?.endsWith("live-update.mjs"))!;
    assert.equal(hand.args[0], join(realpathSync(r.clone), "scripts", "live-update.mjs"), "the new version's own job");
    for (const a of ["request", "--self", "--app", `--old-commit=${old}`, `--install-dir=${r.clone}`, `--data-dir=${w.dirs.dataDir}`]) assert.ok(hand.args.includes(a), a);
    let p = w.engine.snapshot().providers.pobots!;
    assert.equal(p.run!.phase, "restarting");
    assert.equal(p.run!.line, "Restarting Pobots to finish the update.");
    // The job wrote its result while this engine still ran (it gave up waiting, say): told at once.
    mkdirSync(join(w.dirs.dataDir, "updates"), { recursive: true });
    writeFileSync(join(w.dirs.dataDir, "updates", "last.json"), JSON.stringify({ kind: "self", at: new Date().toISOString(), requestedAt: new Date().toISOString(), ok: false, installed: false, summary: "Not installed: after 30 minutes Po was still working. Nothing was changed. Ask again when it is quiet." }));
    await new Promise((res) => setTimeout(res, 60));
    p = w.engine.snapshot().providers.pobots!;
    assert.equal(p.run!.phase, "failed");
    assert.equal(p.run!.line, "Pobots was not updated: after 30 minutes Po was still working. Nothing was changed. Ask again when it is quiet.");
    assert.equal(JSON.parse(readFileSync(join(w.dirs.dataDir, "updates", "last.json"), "utf8")).reported, true);
    w.engine.shutdown();
    w.store.close();
  });

  test("a package-lock.json that npm rewrote does not hold the update: it is put back and the packages installed", async () => {
    const r = repos();
    writeFileSync(join(r.work, "package-lock.json"), "{}\n");
    g(r.work, "add", "package-lock.json");
    g(r.work, "commit", "-q", "-m", "lock");
    g(r.work, "push", "-q", "origin", "main");
    g(r.clone, "pull", "-q", "--ff-only");
    writeFileSync(join(r.work, "engine", "engine.ts"), engineTs(NEXT) + "// again\n");
    g(r.work, "commit", "-q", "-am", "newer again");
    g(r.work, "push", "-q", "origin", "main");
    // A clone whose lockfile npm rewrote.
    writeFileSync(join(r.clone, "package-lock.json"), '{ "rewritten": true }\n');
    const run = runner();
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    await w.engine.providersCheck();
    await w.engine.providersUpdate();
    await w.engine.hub.selfSettled();
    assert.equal(w.engine.snapshot().providers.pobots!.run!.phase, "restarting");
    assert.equal(r.head(), r.remoteHead());
    assert.equal(readFileSync(join(r.clone, "package-lock.json"), "utf8"), "{}\n", "the lockfile of the new version");
    assert.equal(run.not("git").filter((c) => !c.args[0]?.endsWith("build.mjs") && !c.args[0]?.endsWith("live-update.mjs")).length, 1, "installed once");
    w.engine.shutdown();
    w.store.close();
  });

  test("packages that changed are installed; a build that fails puts the folder back", async () => {
    const r = repos({ packages: true });
    const old = r.head();
    const run = runner({ build: false });
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    await w.engine.providersCheck();
    await w.engine.providersUpdate();
    await w.engine.hub.selfSettled();
    const p = w.engine.snapshot().providers.pobots!;
    assert.equal(p.run!.phase, "failed");
    assert.equal(p.run!.line, `Pobots ${NEXT} could not be built, so nothing changed. See the log.`);
    assert.equal(r.head(), old, "back on the old commit");
    assert.equal(g(r.clone, "status", "--porcelain", "--untracked-files=no"), "", "and clean");
    const installs = run.not("git").filter((c) => !c.args[0]?.endsWith("build.mjs"));
    assert.equal(installs.length, 2, "installed for the new version, and again for the old one");
    assert.ok(!run.calls.some((c) => c.args[0]?.endsWith("live-update.mjs")), "never handed over");
    w.engine.shutdown();
    w.store.close();
  });

  test("after the restart: the new engine tells the outcome once, from last.json", async () => {
    const r = repos({ newer: false });
    const dataDir = tempDir();
    mkdirSync(join(dataDir, "updates"));
    const last = join(dataDir, "updates", "last.json");
    writeFileSync(last, JSON.stringify({ kind: "self", at: "2026-11-18T10:42:00.000Z", requestedAt: "2026-11-18T10:40:00.000Z", ok: true, installed: true, from: "0.34.0", to: NEXT, version: NEXT, summary: "Installed" }));
    let w = engineOn(r.clone, runner(), { repo: r.remote, dataDir });
    await w.engine.hub.selfKnown();
    assert.equal(w.engine.snapshot().providers.pobots!.run!.line, `Pobots updated to ${NEXT}.`);
    assert.equal(w.engine.snapshot().providers.pobots!.run!.phase, "done");
    w.engine.shutdown();
    w.store.close();
    w = engineOn(r.clone, runner(), { repo: r.remote, dataDir });
    await w.engine.hub.selfKnown();
    assert.equal(w.engine.snapshot().providers.pobots!.run, null, "told once");
    w.engine.shutdown();
    w.store.close();
    // A build that did not start: the old one is back, and it says so.
    writeFileSync(last, JSON.stringify({ kind: "self", at: "2026-11-18T11:00:00.000Z", requestedAt: "2026-11-18T10:58:00.000Z", ok: false, installed: false, rolledBack: true, from: ENGINE_VERSION, version: NEXT, summary: "Not installed" }));
    w = engineOn(r.clone, runner(), { repo: r.remote, dataDir });
    await w.engine.hub.selfKnown();
    assert.equal(w.engine.snapshot().providers.pobots!.run!.line, `Pobots ${NEXT} did not start, so ${ENGINE_VERSION} is back.`);
    w.engine.shutdown();
    w.store.close();
    // Right after the restart the job has not written its result yet: still restarting, then told when it comes.
    const asked = new Date().toISOString();
    mkdirSync(join(dataDir, "updates", "job"), { recursive: true });
    writeFileSync(join(dataDir, "updates", "job", "stage.json"), JSON.stringify({ requestedAt: asked, version: NEXT }));
    w = engineOn(r.clone, runner(), { repo: r.remote, dataDir });
    await w.engine.hub.selfKnown();
    assert.equal(w.engine.snapshot().providers.pobots!.run!.phase, "restarting");
    writeFileSync(last, JSON.stringify({ kind: "self", at: new Date().toISOString(), requestedAt: asked, ok: true, installed: true, from: ENGINE_VERSION, to: NEXT, version: NEXT }));
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(w.engine.snapshot().providers.pobots!.run!.line, `Pobots updated to ${NEXT}.`);
    w.engine.shutdown();
    w.store.close();
    rmSync(join(dataDir, "updates", "job"), { recursive: true, force: true });
    // The real Pobots's own updates (live:update, no "kind") are never told here.
    writeFileSync(last, JSON.stringify({ at: "2026-11-18T12:00:00.000Z", ok: true, installed: true, summary: "Installed 0.34.0" }));
    w = engineOn(r.clone, runner(), { repo: r.remote, dataDir });
    await w.engine.hub.selfKnown();
    assert.equal(w.engine.snapshot().providers.pobots!.run, null);
    w.engine.shutdown();
    w.store.close();
  });
});

describe("engine 0.34.0: the main bot", { skip }, () => {
  async function po(w: ReturnType<typeof setup>): Promise<FakeSession> {
    const bot = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: bot.id, text: "Go" });
    await settle();
    return w.sessions.find((s) => s.settings.botId === bot.id)!;
  }

  test("elsewhere: get_settings names the version, update_pobots says it updates another way", async () => {
    const w = engineOn(tempDir(), runner());
    const ps = await po(w);
    assert.match(text(await ps.tool("get_settings", {})), new RegExp(`Pobots: version ${ENGINE_VERSION.replaceAll(".", "\\.")}\\. It is updated another way here`));
    const r = await ps.tool("run_pobots_task", { task: "update_pobots" });
    assert.ok(r.isError);
    assert.match(text(r), /updates another way/);
    assert.equal(approvals(w.events).length, 0);
    w.engine.shutdown();
    w.store.close();
  });

  test("on a public install: get_settings says a newer one is there; update_pobots asks on a card, and starts on yes", async () => {
    const r = repos();
    const run = runner();
    const w = engineOn(r.clone, run, { repo: r.remote });
    await w.engine.hub.selfKnown();
    const ps = await po(w);
    assert.match(text(await ps.tool("get_settings", { fresh: true })), new RegExp(`Pobots ${NEXT.replaceAll(".", "\\.")} is available \\(run_pobots_task update_pobots`));
    // No.
    let call = ps.tool("run_pobots_task", { task: "update_pobots" });
    await new Promise((res) => setTimeout(res, 100));
    const card = approvals(w.events).at(-1)!;
    assert.equal(card.title, `Update Pobots to ${NEXT}?`);
    w.engine.resolveCard(card.id, { type: "deny" });
    assert.match(text(await call), /Pobots was not updated/);
    assert.equal(w.engine.snapshot().providers.pobots!.run, null);
    // Yes: it starts, and waits for Po's own turn to end.
    call = ps.tool("run_pobots_task", { task: "update_pobots" });
    await new Promise((res) => setTimeout(res, 100));
    w.engine.resolveCard(approvals(w.events).at(-1)!.id, { type: "allow-once" });
    assert.match(text(await call), /The person allowed it\. The update to .* has started/);
    assert.match(w.engine.snapshot().providers.pobots!.run!.line, /Waiting for Po to finish/);
    ps.reply("Done.");
    await w.engine.hub.selfSettled();
    assert.equal(w.engine.snapshot().providers.pobots!.run!.phase, "restarting");
    assert.equal(r.head(), r.remoteHead());
    w.engine.shutdown();
    w.store.close();
    // After the restart: the job's result comes, and Po is woken in its chat to tell which version runs.
    writeFileSync(join(w.dirs.dataDir, "updates", "last.json"), JSON.stringify({ kind: "self", at: new Date().toISOString(), requestedAt: new Date().toISOString(), ok: true, installed: true, from: ENGINE_VERSION, to: NEXT, version: NEXT }));
    const again = engineOn(r.clone, runner(), { repo: r.remote, dataDir: w.dirs.dataDir, botsDir: w.dirs.botsDir });
    await again.engine.hub.selfKnown();
    await settle();
    const woken = again.sessions.find((s) => s.sent.some((m) => /the update of Pobots that the person allowed has ended\. Pobots updated to/.test(m.text)));
    assert.ok(woken, "Po is woken with how it went");
    assert.match(woken!.sent.at(-1)!.text, /Tell the person in one short sentence that Pobots is updated and which version runs now/);
    assert.ok(!existsSync(join(w.dirs.dataDir, "updates", "self-asked.json")), "told once");
    again.engine.shutdown();
    again.store.close();
  });

  test("the main bot's instructions make updating Pobots its job, and other bots pass it on", () => {
    const main = teamPrompt("main");
    assert.match(main, /When the person asks to update Pobots, or whether a new version is out, look with get_settings fresh/);
    assert.match(main, /run_pobots_task update_pobots, which asks them on a card/);
    assert.match(teamPrompt("bot"), /when the person asks you to update Pobots, tell them to ask the main bot, or pass it on with message_bot/);
  });
});
