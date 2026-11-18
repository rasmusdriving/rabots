// The app check, section "selfupdate": a public install updates itself (docs/build/step-self-update.md,
// engine 0.34.0). Run it alone: node scripts/app-check.mjs --only=selfupdate
// The check's own engine runs from this clone of the private repository: nothing about it shows. A
// second real engine, started as the desktop window starts it (--shell), takes a temporary clone of a
// local bare "remote" as its source: it sees the newer version with one fetch, refuses plainly while
// the folder has changes of its own, and, when the new version cannot be built (the stand-in clone has
// no build script), puts the folder back and says so. Never GitHub, never a restart.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { guardChild } from "../../browser.mjs";
import { sleep, check, sideChannel, run, root, work } from "../lib.mjs";

const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

export default async function section() {
  const current = /export const ENGINE_VERSION = "([^"]+)"/.exec(readFileSync(join(root, "engine", "engine.ts"), "utf8"))[1];
  const [a, b, c] = current.split(".").map(Number);
  const next = `${a}.${b}.${c + 1}`;

  // 1. The check's own engine: a clone of the private repository. Nothing about Pobots's own update.
  const s = await sideChannel(run.endpoint);
  await s.request("providers.check");
  const own = (await s.request("snapshot")).providers;
  check("selfupdate: the check's own engine (a clone of the private repository) shows nothing of it", own.pobots === undefined, JSON.stringify(own.pobots));
  let refused = "";
  try {
    await s.request("providers.update");
  } catch (err) {
    refused = err.message;
  }
  check("selfupdate: and its update button never offers Pobots", !/Pobots/.test(refused) || /Claude Code and Codex are up to date/.test(refused), refused);
  s.close();

  // 2. A bare remote with the running version, a clone of it, and a newer commit on the remote.
  const base = join(work, "selfupdate");
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const clone = join(base, "clone");
  mkdirSync(join(seed, "engine"), { recursive: true });
  g(base, "init", "--bare", "-q", "-b", "main", remote);
  g(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "engine", "engine.ts"), `export const ENGINE_VERSION = "${current}";\n`);
  writeFileSync(join(seed, "README.md"), "Pobots\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "first");
  g(seed, "push", "-q", remote, "main");
  g(base, "clone", "-q", remote, clone);
  writeFileSync(join(seed, "engine", "engine.ts"), `export const ENGINE_VERSION = "${next}";\n`);
  g(seed, "commit", "-q", "-am", "newer");
  g(seed, "push", "-q", remote, "main");
  const old = g(clone, "rev-parse", "HEAD");

  // 3. Its own engine, as the desktop window starts one, with that clone as its source.
  const data = join(base, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ claude: {}, updates: { source: clone, repo: remote } }, null, 2));
  const child = spawn(process.execPath, [join(root, "dist", "engine", "main.mjs"), "--port=0", `--data-dir=${data}`, `--bots-dir=${join(base, "bots")}`, "--shell"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  guardChild(child, `--data-dir=${data}`);
  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (log += d));
  let endpoint;
  for await (const line of createInterface({ input: child.stdout })) {
    try {
      const x = JSON.parse(line).pobotsEngine;
      if (x) {
        endpoint = { url: `ws://127.0.0.1:${x.port}/`, token: x.token };
        break;
      }
    } catch {}
  }
  try {
    check("selfupdate: the public install's engine starts", !!endpoint, endpoint ? "" : log.slice(-400));
    if (!endpoint) return;
    const p = await sideChannel(endpoint);
    const until = async (fn, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await sleep(200);
      }
    };
    const pobots = async () => (await p.request("snapshot")).providers.pobots;
    const found = await until(pobots, 10_000);
    check("selfupdate: it knows it is a public install that can restart itself, before it has looked", found?.current === current && found.available === false && found.canRestart === true, JSON.stringify(found));
    await p.request("providers.check");
    const seen = await pobots();
    check(`selfupdate: one look finds Pobots ${next}`, seen?.latest === next && seen.available === true && !!seen.checkedAt && !seen.problem, JSON.stringify(seen));
    check("selfupdate: looking changed nothing in the folder", g(clone, "rev-parse", "HEAD") === old);

    // Changes of its own: refused in one sentence, nothing changed.
    writeFileSync(join(clone, "README.md"), "Changed here\n");
    let no = "";
    try {
      await p.request("providers.update");
    } catch (err) {
      no = err.message;
    }
    check("selfupdate: a folder with changes of its own is refused plainly", /has changes of its own\. Commit or undo them, then try again\./.test(no) && g(clone, "rev-parse", "HEAD") === old, no);
    g(clone, "checkout", "-q", "--", "README.md");

    // Clean: it moves forward, the build fails (no build script in the stand-in), the folder goes back.
    const started = (await p.request("providers.update")).providers.pobots;
    check("selfupdate: the update starts", !!started?.run && !started.run.endedAt, JSON.stringify(started?.run));
    const ended = await until(async () => {
      const x = await pobots();
      return x?.run?.endedAt ? x : undefined;
    }, 60_000);
    check(`selfupdate: a version that cannot be built: Pobots ${next} could not be built, so nothing changed`, ended?.run?.phase === "failed" && ended.run.line === `Pobots ${next} could not be built, so nothing changed. See the log.`, JSON.stringify(ended?.run));
    check("selfupdate: and the folder is back on the old version, clean", g(clone, "rev-parse", "HEAD") === old && g(clone, "status", "--porcelain", "--untracked-files=no") === "");
    check("selfupdate: the engine's log names the source and the failed build, and no token", /updates itself from/.test(log) && /The build of Pobots .* did not work/.test(log) && !/token=/.test(log), log.split("\n").filter((l) => /self|Pobots/.test(l)).slice(-5).join(" | "));
    p.close();
  } finally {
    await new Promise((res) => {
      if (child.exitCode !== null) return res();
      child.once("exit", res);
      child.kill("SIGTERM");
    });
  }
}
