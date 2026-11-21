// A public install updates itself with one click (engine 0.34.0, docs/build/step-self-update.md).
//
// Only an install run from a clone of the public repository: Pobots finds its source folder
// (`updates.source` in config.json, else `source.json` beside the installed build, else the folder the
// build runs from when it is the top of a git repository) and counts as public only when one of that
// folder's remotes is the public repository. Everywhere else (the real Pobots of the one who makes it,
// the test copy, a check's engine) nothing here runs and nothing shows.
//
// The shape follows T3 Code: a capability decided at start (`ServerSelfUpdateCapability` in
// packages/contracts/src/environment.ts: here "service", "app" or none), a build staged beside the
// running one, a swap with the old build kept, and the outcome told after the restart
// (`ServerSelfUpdateOutcome` in packages/contracts/src/server.ts; apps/server/src/cloud/selfUpdate.ts).
// The swap itself is the same job that updates a Pobots by hand (scripts/live-update.mjs, `--self`).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { PobotsUpdateRun, PobotsUpdateState, ReleaseNote } from "../shared/protocol.js";
import { noteFor, pickNotes, readChangelog } from "./core/changelog.js";
import { log } from "./log.js";
import { newer, realRunner, type Runner } from "./providers.js";

/** The public repository. Written here and nowhere else; `updates.repo` in config.json overrides it. */
export const PUBLIC_REPO = "https://github.com/rasmusdriving/rabots";
/** Where a newer version is fetched to in the source folder: never a branch of its own, never a tag. */
export const LATEST_REF = "refs/pobots/latest";

const FIRST_CHECK_MS = 60 * 1000;
const CHECK_HOURS_DEFAULT = 4;
/** A forced look ("Check now", the main bot) runs at most this often. */
const MIN_FORCED_MS = 60 * 1000;
const WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 3000;
/** How often the result of the handed-over job is looked for while Pobots still runs. */
const JOB_POLL_MS = 5000;
const GIT_MS = 60 * 1000;
const INSTALL_MS = 15 * 60 * 1000;
const BUILD_MS = 10 * 60 * 1000;

export type UpdatesConfig = { repo?: string; source?: string; checkHours?: number; branch?: string };

/** How a public install restarts itself, decided at start. None: the update is shown, but needs a restart by hand. */
export type RestartMode = { kind: "service"; label: string } | { kind: "app" } | { kind: "none" };

export interface SelfUpdateHost {
  dataDir: string;
  /** Names of the bots that are not calm now. */
  busyBots(): string[];
  /** The state changed: tell every window. */
  changed(): void;
  /**
   * The update a bot started (the main bot's run_pobots_task) has ended, here or after the restart:
   * the bot tells the person in its chat which version runs now.
   */
  tellAsker?(botId: string, line: string, version: string, ok: boolean, notes?: ReleaseNote[]): void;
  /**
   * Pobots was updated and this engine runs the new version: told once, after the restart (protocol
   * 36). `notes`: what is new since `from`, from the folder's own CHANGELOG.md (may be empty).
   */
  updated?(from: string | undefined, to: string, notes: ReleaseNote[]): void;
}

export interface SelfUpdateOptions {
  /** The running build's folder (two up from dist/engine/main.mjs). Left out (as in most tests): nothing here runs. */
  installDir?: string;
  config?: UpdatesConfig;
  /** --shell: started by the desktop window. */
  shell?: boolean;
  current: string;
  /** --data-dir / --bots-dir as the engine got them, for opening the window again. */
  appArgs?: string[];
  env?: Record<string, string | undefined>;
  /** Every command (git, npm, the build, the hand-over). Tests pass a stand-in. */
  run?: Runner;
  /** The program that runs the build and the job (Electron as Node, or Node). */
  execPath?: string;
  /** Whether launchd runs this process under that label. Tests pass a stand-in. */
  isService?: (label: string) => Promise<boolean>;
  timings?: { firstCheckMs?: number; pollMs?: number; waitMs?: number; minForcedMs?: number; jobPollMs?: number };
  clock?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** "github.com/owner/name" for the https, ssh and scp forms of the same address. */
export function repoKey(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  u = u.replace(/^([^/:]+):\d+\//, "$1/");
  u = u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return u;
}

/** The engine's version in a copy of engine/engine.ts. */
export function versionIn(engineTs: string): string | undefined {
  return /export const ENGINE_VERSION = "(\d+\.\d+\.\d+)"/.exec(engineTs)?.[1];
}

/** The folder the build came from, by rules 1 and 2 of the brief; undefined when there is none. */
export function sourceCandidate(installDir: string, config: UpdatesConfig | undefined): string | undefined {
  if (config?.source) return config.source;
  try {
    const repo = (JSON.parse(readFileSync(join(installDir, "source.json"), "utf8")) as { repo?: unknown }).repo;
    if (typeof repo === "string" && repo) return repo;
  } catch {
    // no source.json
  }
  // A build run from its own clone (npm start). An installed copy (~/.local/share/pobots) is no git repository.
  if (existsSync(join(installDir, ".git"))) return installDir;
  return undefined;
}

/** The plain environment for git: never a prompt for a password, never a token. */
function gitEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    PATH: withTools(env.PATH),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    LC_ALL: "C",
  };
}

/** The service's own PATH is bare: add where command line tools usually are. */
function withTools(path: string | undefined): string {
  const extra = ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"];
  return [...(path ? path.split(delimiter) : []), ...extra].filter((p, i, all) => p && all.indexOf(p) === i).join(delimiter);
}

/** npm: on the PATH, in the usual places, or where nvm or Volta put it. */
export function findNpm(env: Record<string, string | undefined>): string | undefined {
  const dirs = withTools(env.PATH).split(delimiter);
  const home = homedir();
  dirs.push(join(home, ".volta", "bin"));
  try {
    const nvm = join(home, ".nvm", "versions", "node");
    const versions = readdirSync(nvm).sort((a, b) => (newer(a.replace(/^v/, ""), b.replace(/^v/, "")) ? -1 : 1));
    for (const v of versions) dirs.push(join(nvm, v, "bin"));
  } catch {
    // no nvm
  }
  for (const d of dirs) if (d && existsSync(join(d, "npm"))) return join(d, "npm");
  return undefined;
}

/** The line of a command's output that says what went wrong (an error line, else the last), without any login in an address. */
const firstLine = (out: string) => {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\/\/[^/@\s]+@/g, "//"));
  return (lines.find((l) => /error|fatal|cannot|could not|not found|ERR!/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 200);
};

export class SelfUpdate {
  private readonly host: SelfUpdateHost;
  private readonly o: SelfUpdateOptions;
  private readonly runner: Runner;
  private readonly clock: () => number;
  private readonly env: Record<string, string | undefined>;
  /** The source folder, once it is known to be a clone of the public repository. */
  private source?: string;
  /** The name of its remote that is the public repository. */
  private remote?: string;
  private mode: RestartMode = { kind: "none" };
  private state?: PobotsUpdateState;
  private checking?: Promise<void>;
  private lastForced = 0;
  private timer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;
  private jobTimer?: NodeJS.Timeout;
  private stopped = false;
  /** The source folder's own CHANGELOG.md, read once at start (protocol 36). */
  private localChangelog?: string;
  private detected?: Promise<void>;
  private done?: Promise<void>;

  constructor(host: SelfUpdateHost, o: SelfUpdateOptions) {
    this.host = host;
    this.o = o;
    this.runner = o.run ?? realRunner;
    this.clock = o.clock ?? Date.now;
    this.env = o.env ?? process.env;
  }

  /** Present only on a public install. */
  view(): PobotsUpdateState | undefined {
    return this.state ? { ...this.state, ...(this.state.run ? { run: { ...this.state.run } } : {}) } : undefined;
  }

  /** True when Pobots has an update it can run now. */
  get wanted(): boolean {
    return !!this.state?.available && this.state.canRestart;
  }

  get running(): boolean {
    return !!this.state?.run && !this.state.run.endedAt;
  }

  /** Finds out whether this is a public install, and how it restarts. Runs once; resolves when known. */
  detect(): Promise<void> {
    this.detected ??= this.findOut().catch((err) => log.warn("Could not tell whether this Pobots updates itself", err));
    return this.detected;
  }

  private async findOut(): Promise<void> {
    if (!this.o.installDir) return;
    const candidate = sourceCandidate(this.o.installDir, this.o.config);
    if (!candidate || !existsSync(candidate)) return;
    const top = await this.git(candidate, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) return;
    let real: string;
    try {
      real = realpathSync(candidate);
      if (realpathSync(top.out.trim()) !== real) return;
    } catch {
      return;
    }
    const remotes = await this.git(real, ["remote", "-v"]);
    if (!remotes.ok) return;
    const want = repoKey(this.o.config?.repo ?? PUBLIC_REPO);
    const hit = remotes.out
      .split("\n")
      .map((l) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(l.trim()))
      .find((m) => m && repoKey(m[2]!) === want);
    if (!hit) return;
    this.source = real;
    this.remote = hit[1]!;
    this.mode = await this.restartMode();
    this.localChangelog = readChangelog(real);
    const thisVersion = noteFor(this.localChangelog, this.o.current);
    const told = this.lastOutcome();
    this.state = { current: this.o.current, available: false, canRestart: this.mode.kind !== "none", run: told ?? this.pendingJob(), ...(thisVersion ? { thisVersion } : {}) };
    log.info(`This Pobots updates itself from ${this.o.config?.repo ?? PUBLIC_REPO} (${real}; restart: ${this.mode.kind})`);
    this.host.changed();
    if (told) this.tellAsker(told, this.announce(told));
  }

  private async restartMode(): Promise<RestartMode> {
    if (this.o.shell) return { kind: "app" };
    const label = this.env.POBOTS_SERVICE_LABEL || this.env.XPC_SERVICE_NAME;
    if (label && /^[A-Za-z0-9.-]+$/.test(label) && label !== "0") {
      const is = this.o.isService ?? ((l: string) => launchdRunsUs(l, this.runner));
      if (await is(label)) return { kind: "service", label };
    }
    return { kind: "none" };
  }

  /** Starts the regular look (soon after start, then every few hours). */
  start(): void {
    void this.detect().then(() => {
      if (!this.state || this.stopped) return;
      this.firstTimer = setTimeout(() => void this.check(false), this.o.timings?.firstCheckMs ?? FIRST_CHECK_MS);
      this.firstTimer.unref?.();
      const hours = this.o.config?.checkHours ?? CHECK_HOURS_DEFAULT;
      if (hours > 0) {
        this.timer = setInterval(() => void this.check(false), hours * 3600 * 1000);
        this.timer.unref?.();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    clearInterval(this.jobTimer);
  }

  /** Looks for a newer version: one fetch of the main branch, no tokens. `force` (Check now) at most once a minute. */
  check(force = true): Promise<void> {
    if (!this.state || !this.source) return Promise.resolve();
    if (this.checking) return this.checking;
    if (this.running) return Promise.resolve();
    if (force) {
      if (this.clock() - this.lastForced < (this.o.timings?.minForcedMs ?? MIN_FORCED_MS)) return Promise.resolve();
      this.lastForced = this.clock();
    }
    this.checking = (async () => {
      const src = this.source!;
      const branch = this.o.config?.branch ?? "main";
      let problem: string | undefined;
      let latest = this.state!.latest;
      // What the newer versions bring: kept from the last look when this one could not read them.
      let whatsNew = this.state!.whatsNew;
      let olderNotes = this.state!.olderNotes;
      const f = await this.git(src, ["fetch", "--no-tags", "--quiet", this.remote!, `+refs/heads/${branch}:${LATEST_REF}`]);
      if (!f.ok) {
        log.warn(`Could not look for a new Pobots: git fetch from ${this.remote} did not work (${firstLine(f.out)})`);
        problem = "Pobots could not look for a new version just now. It tries again later.";
      } else {
        const shown = await this.git(src, ["show", `${LATEST_REF}:engine/engine.ts`]);
        const v = shown.ok ? versionIn(shown.out) : undefined;
        if (!v) problem = "The newest version could not be read. It tries again later.";
        else {
          latest = v;
          whatsNew = undefined;
          olderNotes = undefined;
          if (newer(v, this.o.current)) {
            // A new version without a changelog (or with a broken one) is still found: it only has no notes.
            const cl = await this.git(src, ["show", `${LATEST_REF}:CHANGELOG.md`]);
            const picked = pickNotes(cl.ok ? cl.out : undefined, this.o.current, v);
            if (picked.notes.length) whatsNew = picked.notes;
            if (picked.older) olderNotes = picked.older;
          }
        }
      }
      if (this.stopped || !this.state) return;
      const { problem: _old, whatsNew: _notes, olderNotes: _older, ...rest } = this.state;
      const available = newer(latest, this.o.current);
      this.state = {
        ...rest,
        ...(latest ? { latest } : {}),
        available,
        checkedAt: iso(this.clock()),
        ...(problem ? { problem } : {}),
        ...(available && whatsNew ? { whatsNew } : {}),
        ...(available && whatsNew && olderNotes ? { olderNotes } : {}),
      };
      this.host.changed();
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  /** The sentence that refuses the update, or undefined when it may start. Changes nothing. */
  async refusal(): Promise<string | undefined> {
    if (!this.state || !this.source) return "This Pobots updates another way.";
    if (this.running) return "An update of Pobots is already running.";
    if (!this.state.available || !this.state.latest) return "Pobots is up to date.";
    if (!this.state.canRestart) return `Pobots ${this.state.latest} is available, but Pobots cannot restart itself here. Quit it, then run git pull and npm start in ${this.source}.`;
    return this.folderRefusal();
  }

  /** Whether the folder can simply move forward to the newer version: no changes and no commits of its own. */
  private async folderRefusal(): Promise<string | undefined> {
    if (!this.source) return "This Pobots updates another way.";
    const dirty = await this.git(this.source, ["status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok) return `Pobots was not updated: ${this.source} could not be read as a git folder.`;
    // package-lock.json is npm's: `npm install` often rewrites it in a fresh clone. It is put back before the move.
    const own = dirty.out
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && f !== "package-lock.json");
    if (own.length) return `Pobots was not updated: ${this.source} has changes of its own. Commit or undo them, then try again.`;
    const forward = await this.git(this.source, ["merge-base", "--is-ancestor", "HEAD", LATEST_REF]);
    if (!forward.ok) return `Pobots was not updated: ${this.source} has commits of its own that are not in the new version, so it cannot simply move forward.`;
    return undefined;
  }

  /** The promise of the running update, for tests. */
  settled(): Promise<void> {
    return this.done ?? Promise.resolve();
  }

  /**
   * Starts the update; the caller has asked refusal() first. `after`: another update (Claude Code,
   * Codex) that runs first. Answers at once; the run goes on and tells every window as it goes.
   */
  begin(after?: Promise<void>, askedBy?: string): void {
    const st = this.state!;
    const to = st.latest!;
    const run: PobotsUpdateRun = { startedAt: iso(this.clock()), phase: "waiting", line: after ? "Waiting for the other updates to finish." : this.waitLine(), from: this.o.current, to };
    this.state = { ...st, run };
    // Kept on disk: the bot that asked hears how it went, also from the engine after the restart.
    const asked = join(this.host.dataDir, "updates", "self-asked.json");
    if (askedBy) {
      try {
        mkdirSync(dirname(asked), { recursive: true });
        writeFileSync(asked, JSON.stringify({ botId: askedBy, at: run.startedAt }) + "\n");
      } catch (err) {
        log.warn("Could not note which bot asked for the update", err);
      }
    } else rmSync(asked, { force: true });
    this.host.changed();
    this.done = (async () => {
      if (after) await after;
      await this.runIt(run, to);
    })().catch((err) => {
      log.error("The update of Pobots failed", err);
      this.end(run, "failed", "The update of Pobots stopped because of an error. See the log.");
    });
  }

  private waitLine(): string {
    const busy = this.host.busyBots();
    return busy.length ? `Waiting for ${names(busy)} to finish.` : "Starting the update of Pobots.";
  }

  private set(run: PobotsUpdateRun, phase: PobotsUpdateRun["phase"], line: string): void {
    run.phase = phase;
    run.line = line;
    if (this.state) this.state = { ...this.state, run };
    this.host.changed();
  }

  private end(run: PobotsUpdateRun, phase: "done" | "failed", line: string): void {
    run.endedAt = iso(this.clock());
    this.set(run, phase, line);
    log.info(`Pobots update: ${line}`);
    this.tellAsker(run, this.announce(run));
  }

  /**
   * When `run` ended well and this engine is its new version, the host hears it once with what is new
   * since the old version (the card on the rail, protocol 36). Gives the notes, for the bot that asked.
   */
  private announce(run: PobotsUpdateRun): ReleaseNote[] | undefined {
    if (run.phase !== "done" || (run.to && run.to !== this.o.current)) return undefined;
    const from = run.from && newer(this.o.current, run.from) ? run.from : undefined;
    const notes = pickNotes(this.localChangelog, from, this.o.current).notes;
    this.host.updated?.(from, this.o.current, notes);
    return notes;
  }

  /** The bot that started this update (if one did, in the last two hours) is woken to tell the person. Once. */
  private tellAsker(run: PobotsUpdateRun, notes?: ReleaseNote[]): void {
    const path = join(this.host.dataDir, "updates", "self-asked.json");
    let asked: { botId?: string; at?: string };
    try {
      asked = JSON.parse(readFileSync(path, "utf8")) as typeof asked;
    } catch {
      return;
    }
    rmSync(path, { force: true });
    const at = Date.parse(asked.at ?? "");
    if (!asked.botId || !Number.isFinite(at) || this.clock() - at > 2 * 3600 * 1000) return;
    this.host.tellAsker?.(asked.botId, run.line, this.o.current, run.phase === "done", notes?.length ? notes : undefined);
  }

  private async runIt(run: PobotsUpdateRun, to: string): Promise<void> {
    const src = this.source!;
    // 1. Wait until every bot is calm.
    const poll = this.o.timings?.pollMs ?? POLL_MS;
    const limit = this.o.timings?.waitMs ?? WAIT_MS;
    const began = this.clock();
    for (;;) {
      if (this.stopped) return;
      const busy = this.host.busyBots();
      if (!busy.length) break;
      if (this.clock() - began > limit) return this.end(run, "failed", `Pobots was not updated: ${names(busy)} did not finish within ${Math.round(limit / 60000)} minutes. Try again later.`);
      const line = `Waiting for ${names(busy)} to finish.`;
      if (line !== run.line) this.set(run, "waiting", line);
      await new Promise((r) => setTimeout(r, poll));
    }
    // The folder may have changed since the button was pressed.
    const again = await this.folderRefusal();
    if (again) return this.end(run, "failed", again);

    // 2. Move the folder forward.
    const head = await this.git(src, ["rev-parse", "HEAD"]);
    if (!head.ok) return this.end(run, "failed", "Pobots was not updated: its folder could not be read.");
    const old = head.out.trim();
    this.set(run, "pulling", `Fetching Pobots ${to}.`);
    const lock = await this.git(src, ["status", "--porcelain", "--untracked-files=no", "--", "package-lock.json"]);
    const lockChanged = lock.ok && !!lock.out.trim();
    if (lockChanged) await this.git(src, ["checkout", "--quiet", "--", "package-lock.json"]);
    const merged = await this.git(src, ["merge", "--ff-only", "--quiet", LATEST_REF]);
    if (!merged.ok) {
      log.warn(`git merge --ff-only did not work: ${firstLine(merged.out)}`);
      return this.end(run, "failed", "Pobots was not updated: the new version could not be put in its folder. Nothing was changed.");
    }
    const changed = await this.git(src, ["diff", "--name-only", old, "HEAD", "--", "package.json", "package-lock.json"]);
    const packagesChanged = !changed.ok || !!changed.out.trim() || lockChanged;
    const install = packagesChanged ? this.installCommand(src) : undefined;

    const putBack = async (line: string) => {
      const reset = await this.git(src, ["reset", "--keep", "--quiet", old]);
      if (!reset.ok) log.warn(`Could not put ${src} back on ${old}: ${firstLine(reset.out)}`);
      if (install) await this.runner(install.command, install.args, { env: install.env, timeoutMs: INSTALL_MS });
      this.end(run, "failed", reset.ok ? line : `${line} The folder could not be put back on the old version; run git reset --keep ${old.slice(0, 12)} in it.`);
    };

    // 3. Packages, only when they changed.
    if (install) {
      this.set(run, "installing", "Installing what Pobots needs.");
      const r = await this.runner(install.command, install.args, { env: install.env, timeoutMs: INSTALL_MS });
      if (!r.ok) {
        log.warn(`The install for Pobots ${to} did not work: ${firstLine(r.out)}`);
        return putBack(`Pobots ${to} could not install what it needs, so nothing changed.`);
      }
    }

    // 4. Build beside the running build, never over it.
    this.set(run, "building", `Building Pobots ${to}.`);
    const out = join(this.host.dataDir, "updates", "build", "dist");
    rmSync(dirname(out), { recursive: true, force: true });
    const execPath = this.o.execPath ?? process.execPath;
    const built = await this.runner(execPath, [join(src, "scripts", "build.mjs")], { env: { ...this.env, PATH: withTools(this.env.PATH), ELECTRON_RUN_AS_NODE: "1", POBOTS_BUILD_OUT: out }, timeoutMs: BUILD_MS });
    if (!built.ok || !existsSync(join(out, "engine", "main.mjs")) || !existsSync(join(out, "ui", "index.html"))) {
      log.warn(`The build of Pobots ${to} did not work: ${firstLine(built.out)}`);
      return putBack(`Pobots ${to} could not be built, so nothing changed. See the log.`);
    }

    // 5. Hand over to the job that stops Pobots, swaps the build in and starts it again.
    this.set(run, "restarting", "Restarting Pobots to finish the update.");
    const args = [
      join(src, "scripts", "live-update.mjs"),
      "request",
      "--self",
      `--data-dir=${this.host.dataDir}`,
      `--install-dir=${this.o.installDir}`,
      `--dist=${out}`,
      `--old-commit=${old}`,
      `--node=${execPath}`,
      `--note=Pobots ${to}`,
      ...(this.mode.kind === "service" ? [`--label=${this.mode.label}`] : ["--app", ...(this.o.appArgs ?? []).map((a) => `--app-arg=${a}`)]),
      ...(install ? [`--install=${JSON.stringify({ command: install.command, args: install.args, path: install.env.PATH ?? "" })}`] : []),
    ];
    const handed = await this.runner(execPath, args, { env: { ...this.env, PATH: withTools(this.env.PATH), ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 60_000 });
    if (!handed.ok) {
      log.warn(`The update could not be handed over: ${firstLine(handed.out)}`);
      return putBack(`Pobots was not updated: ${firstLine(handed.out) || "the restart could not be started"}`);
    }
    log.info(`Pobots ${to} is built; the restart is handed over`);
    this.watchJob(run);
  }

  /** While Pobots still runs (the job waits, or gave up), or just after the restart, its result is read from last.json. */
  private watchJob(run: PobotsUpdateRun, giveUpMs?: number): void {
    clearInterval(this.jobTimer);
    const began = this.clock();
    this.jobTimer = setInterval(() => {
      if (giveUpMs && this.clock() - began > giveUpMs) {
        clearInterval(this.jobTimer);
        return this.end(run, "failed", "Pobots restarted, but the update did not say how it went. See the log.");
      }
      const r = this.readLast();
      if (!r || r.requestedAt === undefined || Date.parse(r.requestedAt) < Date.parse(run.startedAt)) return;
      clearInterval(this.jobTimer);
      this.markReported();
      // After the restart this engine's own version is not where the update came from: the job knows.
      if (r.from) run.from = r.from;
      const o = outcome(r, run.from);
      this.end(run, o.phase, o.line);
    }, this.o.timings?.jobPollMs ?? JOB_POLL_MS);
    this.jobTimer.unref?.();
  }

  private readLast(): LastUpdate | undefined {
    try {
      const r = JSON.parse(readFileSync(join(this.host.dataDir, "updates", "last.json"), "utf8")) as LastUpdate;
      return r && r.kind === "self" ? r : undefined;
    } catch {
      return undefined;
    }
  }

  private markReported(): void {
    const path = join(this.host.dataDir, "updates", "last.json");
    try {
      const r = JSON.parse(readFileSync(path, "utf8")) as LastUpdate;
      writeFileSync(path, JSON.stringify({ ...r, reported: true }, null, 2) + "\n");
    } catch (err) {
      log.warn("Could not note that the last update was told", err);
    }
  }

  /** The update before this start, told once: "Pobots updated to 0.34.1." */
  private lastOutcome(): PobotsUpdateRun | null {
    const r = this.readLast();
    if (!r || r.reported) return null;
    this.markReported();
    const o = outcome(r, r.from ?? this.o.current);
    return { startedAt: r.requestedAt ?? r.at, endedAt: r.at, phase: o.phase, line: o.line, from: r.from ?? this.o.current, ...(r.to ? { to: r.to } : {}) };
  }

  /**
   * The job that restarted Pobots writes its result only once it has seen this engine come up, so
   * right after the restart there is none yet: a job asked for in the last quarter of an hour without
   * a result shows as still restarting, and its result is told when it comes.
   */
  private pendingJob(): PobotsUpdateRun | null {
    let stage: { requestedAt?: string; version?: string };
    try {
      stage = JSON.parse(readFileSync(join(this.host.dataDir, "updates", "job", "stage.json"), "utf8")) as typeof stage;
    } catch {
      return null;
    }
    const asked = Date.parse(stage.requestedAt ?? "");
    if (!Number.isFinite(asked) || this.clock() - asked > 15 * 60 * 1000) return null;
    const last = this.readLast();
    if (last?.requestedAt && Date.parse(last.requestedAt) >= asked) return null;
    const run: PobotsUpdateRun = { startedAt: stage.requestedAt!, phase: "restarting", line: "Restarting Pobots to finish the update.", from: this.o.current, ...(stage.version ? { to: stage.version } : {}) };
    this.watchJob(run, 3 * 60 * 1000);
    return run;
  }

  /** npm install where it belongs: scripts/install.mjs when node_modules is a link (its own folder), else in the clone. */
  private installCommand(src: string): { command: string; args: string[]; env: Record<string, string | undefined> } {
    const npm = findNpm(this.env);
    const PATH = withTools([npm ? dirname(npm) : "", this.env.PATH ?? ""].filter(Boolean).join(delimiter));
    const link = lstatSync(join(src, "node_modules"), { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      let deps: string | undefined;
      try {
        deps = dirname(realpathSync(join(src, "node_modules")));
      } catch {
        deps = undefined;
      }
      return { command: this.o.execPath ?? process.execPath, args: [join(src, "scripts", "install.mjs")], env: { ...this.env, PATH, ELECTRON_RUN_AS_NODE: "1", ...(deps ? { POBOTS_DEPS_DIR: deps } : {}) } };
    }
    if (npm) return { command: npm, args: ["install", "--no-audit", "--no-fund", "--prefix", src], env: { ...this.env, PATH } };
    // Not found: the person's own shell knows where it is.
    return { command: "/bin/zsh", args: ["-lc", `cd ${shellQuote(src)} && npm install --no-audit --no-fund`], env: { ...this.env, PATH } };
  }

  private git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    return this.runner("git", ["-C", cwd, ...args], { env: gitEnv(this.env), timeoutMs: GIT_MS });
  }
}

/** What scripts/live-update.mjs writes to <data dir>/updates/last.json. */
interface LastUpdate {
  kind?: string;
  at: string;
  requestedAt?: string;
  ok?: boolean;
  installed?: boolean;
  rolledBack?: boolean;
  from?: string;
  to?: string;
  version?: string;
  summary?: string;
  reported?: boolean;
}

function outcome(r: LastUpdate, from: string): { phase: "done" | "failed"; line: string } {
  if (r.ok && r.installed) return { phase: "done", line: `Pobots updated to ${r.to ?? r.version ?? "the new version"}.` };
  if (r.rolledBack) return { phase: "failed", line: `Pobots ${r.version ?? "the new version"} did not start, so ${r.from ?? from} is back.` };
  return { phase: "failed", line: (r.summary ?? "Pobots was not updated.").replace(/^Not installed:\s*/, "Pobots was not updated: ") };
}

/** "Po", "Po and Kaja", "Po, Kaja and Inbox". */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** True when launchd runs this very process under that label (the service). */
async function launchdRunsUs(label: string, run: Runner): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const r = await run("/bin/launchctl", ["print", `gui/${userInfo().uid}/${label}`], { env: process.env, timeoutMs: 5000 });
  const pid = r.ok ? /^\s*pid = (\d+)/m.exec(r.out)?.[1] : undefined;
  return Number(pid) === process.pid;
}
