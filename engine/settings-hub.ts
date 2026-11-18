// The settings window's engine side (step 7b): the settings, the providers and their update, and
// the usage meters. The engine core (engine.ts) hands it what it needs through SettingsHost, so the
// rules about bots (who is calm, closing their harness processes) stay in one place.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatTiming, ChatTimingKey, Events, EventName, ModelInfo, PobotsSettings, ProviderId, ProvidersState, ProviderState, ProviderUpdateRun, SettingsPatch, UsageProvider, UsageState } from "../shared/protocol.js";
import type { ClaudeSetup } from "./claude/detect.js";
import { CODEX_NOT_INSTALLED, CODEX_NOT_SIGNED_IN, type CodexSetup } from "./codex/detect.js";
import { type ContextSettings } from "./config.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";
import { failureLine, installedVersion, latestVersion, newer, providerDef, PROVIDERS, realRunner, updatePlan, type Fetcher, type Runner } from "./providers.js";
import {
  applyPatch,
  cleanHubUrl,
  contextFor,
  HEALTH_CHECK_DEFAULT,
  HubKeys,
  isOpRef,
  MAX_HUBS,
  newHubId,
  PROVIDER_IDS,
  readSettingsFile,
  settingsParts,
  settingsView,
  TIMING_WORDS,
  type SettingsFile,
} from "./settings.js";
import { readClaudeUsage, readCodexUsage, readHub, type CliproxyHub } from "./usage.js";
import { writeConfigPart } from "./config.js";
import { CONTEXT_DEFAULTS } from "./config.js";

/** How long a usage reading is reused before it is read again by itself. */
const USAGE_FRESH_MS = 2 * 60 * 1000;
/** The newest versions are looked up at most this often, unless asked. */
const LATEST_EVERY_MS = 60 * 60 * 1000;
/** How long the update waits for the bots to be calm. */
const UPDATE_WAIT_MS = 30 * 60 * 1000;
/** How often it looks whether they are. */
const UPDATE_POLL_MS = 3000;
/** One update command may run this long. */
const UPDATE_RUN_MS = 10 * 60 * 1000;
/** The first look at the providers after start. */
const FIRST_CHECK_MS = 20 * 1000;

export interface SettingsHost {
  dataDir: string;
  machineName: string;
  emit<E extends EventName>(event: E, data: Events[E]): void;
  claude(): ClaudeSetup;
  /** Looks for Claude again (after an update). */
  redetectClaude?(): Promise<ClaudeSetup>;
  setClaude(next: ClaudeSetup): void;
  codex(): CodexSetup;
  recheckCodex(): Promise<void>;
  models(): ModelInfo[];
  /** Names of the bots that run on a provider. */
  botsOn(p: ProviderId): string[];
  /** Names of the bots that are not calm now (a turn, helpers, messages in line). */
  busyBots(): string[];
  /** Closes every bot's harness process when it is calm (now or after its turn), so its next turn starts the program anew. */
  restartHarnesses(): void;
  /** The fresh-start timing changed. */
  timingChanged(): void;
  /** A working folder for short-lived probes (the Claude usage probe). */
  probeDir: string;
}

export interface SettingsHubOptions {
  /** Stand-ins for tests and checks: the update commands, the version read, the latest-version and hub requests, the usage readers. */
  runner?: Runner;
  fetcher?: Fetcher;
  readClaude?: () => Promise<import("../shared/protocol.js").UsageAccount>;
  readCodex?: () => Promise<import("../shared/protocol.js").UsageAccount>;
  timings?: { updatePollMs?: number; updateWaitMs?: number; firstCheckMs?: number };
  clock?: () => number;
  /** Runs `op read <ref>` for a hub key kept in 1Password. Tests pass a stand-in. */
  opRead?: (ref: string) => Promise<string | undefined>;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class SettingsHub {
  private file: SettingsFile;
  private readonly keys: HubKeys;
  private readonly runner: Runner;
  private readonly fetcher: Fetcher;
  private readonly clock: () => number;
  private latest: Partial<Record<ProviderId, { version?: string; at: number }>> = {};
  private providersState: ProvidersState;
  private checking?: Promise<void>;
  private healthTimer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;
  private usage: UsageState = { source: "providers", providers: [], reading: false };
  private usageAt = 0;
  private usageReading?: Promise<void>;
  private update: ProviderUpdateRun | null = null;
  private stopped = false;

  private readonly host: SettingsHost;
  private readonly o: SettingsHubOptions;

  constructor(host: SettingsHost, file: SettingsFile | undefined, context: ContextSettings | undefined, o: SettingsHubOptions = {}) {
    this.host = host;
    this.o = o;
    this.file = file ?? readSettingsFile({}, context ?? { ...CONTEXT_DEFAULTS });
    this.keys = new HubKeys(host.dataDir);
    this.runner = o.runner ?? realRunner;
    this.fetcher = o.fetcher ?? (fetch as unknown as Fetcher);
    this.clock = o.clock ?? Date.now;
    this.providersState = { machine: host.machineName, providers: this.providerStates(), checking: false, update: null };
    this.usage.source = this.file.hubs.length ? "hub" : "providers";
  }

  // ------------------------------------------------------------ settings

  view(): PobotsSettings {
    return settingsView(this.file);
  }

  /** The fresh-start rules for one provider. */
  context(p: ProviderId): ContextSettings {
    return contextFor(this.file, p);
  }

  titleModel(): string {
    return this.view().titleModel;
  }

  enabled(p: ProviderId): boolean {
    return this.file.enabled[p];
  }

  /**
   * Changes settings, saves them and tells every window. Returns what changed in plain words, one
   * line each ("Chats, Claude: worth a fresh start from 100,000 to 150,000 tokens"), for the note a
   * bot's change leaves.
   */
  set(patch: SettingsPatch): { settings: PobotsSettings; changes: string[] } {
    for (const p of PROVIDER_IDS) {
      if (patch.providers?.[p]?.enabled === false && this.file.enabled[p]) {
        const on = this.host.botsOn(p);
        if (on.length) throw new EngineError("conflict", `${providerDef(p).label} cannot be switched off while ${listWords(on)} ${on.length === 1 ? "runs" : "run"} on it. Move ${on.length === 1 ? "that bot" : "them"} to another model first.`);
      }
    }
    const before = this.view();
    const next = applyPatch(this.file, patch, this.host.models());
    this.save(next);
    const after = this.view();
    const changes = describeChanges(before, after, this.host.models());
    if (!changes.length) return { settings: after, changes };
    log.info(`Settings changed: ${changes.length} value(s)`);
    this.host.emit("settings.changed", { settings: after });
    if (JSON.stringify(before.timing) !== JSON.stringify(after.timing)) this.host.timingChanged();
    if (before.healthCheckSeconds !== after.healthCheckSeconds) this.startHealth();
    if (JSON.stringify(before.providers) !== JSON.stringify(after.providers)) {
      this.providersState = { ...this.providersState, providers: this.providerStates() };
      this.host.emit("providers.changed", { providers: this.providers() });
      this.usageAt = 0;
    }
    return { settings: after, changes };
  }

  private save(next: SettingsFile): void {
    const parts = settingsParts(next);
    // Each part on its own, keeping everything else in config.json as it is.
    writeConfigPart(this.host.dataDir, "context", parts.context);
    writeConfigPart(this.host.dataDir, "providers", parts.providers);
    writeConfigPart(this.host.dataDir, "titles", parts.titles);
    writeConfigPart(this.host.dataDir, "usage", parts.usage);
    this.file = next;
  }

  // ------------------------------------------------------------ usage hubs

  addHub(rawUrl: string, rawKey: string): PobotsSettings {
    const url = cleanHubUrl(rawUrl);
    if (!url) throw new EngineError("bad_request", "That is not a hub address. Use the https address of your CLIProxyAPI, such as https://host:8443.");
    const key = rawKey.trim();
    if (!key || key.length > 4096 || (/\s/.test(key) && !isOpRef(key))) throw new EngineError("bad_request", "Paste the hub's management key, or an op:// reference to it in 1Password.");
    if (this.file.hubs.length >= MAX_HUBS) throw new EngineError("too_many", `At most ${MAX_HUBS} usage hubs.`);
    if (this.file.hubs.some((h) => h.url === url)) throw new EngineError("conflict", "That hub is already added. Remove it first to give it a new key.");
    const id = newHubId();
    this.keys.set(id, key);
    const next: SettingsFile = { ...this.file, hubs: [...this.file.hubs, { id, kind: "cliproxy", url, addedAt: iso(this.clock()), keyKind: isOpRef(key) ? "1password" : "saved" }] };
    try {
      this.save(next);
    } catch (err) {
      this.keys.remove(id);
      throw err;
    }
    log.info("A usage hub was added");
    this.host.emit("settings.changed", { settings: this.view() });
    this.usageAt = 0;
    void this.readUsage(true);
    return this.view();
  }

  removeHub(id: string): PobotsSettings {
    if (!this.file.hubs.some((h) => h.id === id)) throw new EngineError("not_found", "There is no such usage hub.");
    this.save({ ...this.file, hubs: this.file.hubs.filter((h) => h.id !== id) });
    this.keys.remove(id);
    log.info("A usage hub was removed");
    this.host.emit("settings.changed", { settings: this.view() });
    this.usageAt = 0;
    void this.readUsage(true);
    return this.view();
  }

  /** A hub's key, read from where it is kept. Never logged. */
  private async hubKey(id: string): Promise<string | undefined> {
    const k = this.keys.get(id);
    if (!k) return undefined;
    if (!isOpRef(k)) return k;
    return (this.o.opRead ?? opRead)(k);
  }

  // ------------------------------------------------------------ usage

  usageState(): UsageState {
    return { ...this.usage, providers: this.usage.providers.map((p) => ({ ...p, accounts: [...p.accounts] })) };
  }

  /** Reads usage now when asked, or when the last reading is older than a couple of minutes. */
  async readUsage(refresh = false): Promise<UsageState> {
    if (!refresh && this.usageAt && this.clock() - this.usageAt < USAGE_FRESH_MS) return this.usageState();
    if (this.usageReading) {
      await this.usageReading;
      return this.usageState();
    }
    this.usage = { ...this.usage, reading: true };
    this.host.emit("usage.changed", { usage: this.usageState() });
    this.usageReading = (async () => {
      try {
        this.usage = this.file.hubs.length ? await this.readFromHubs() : await this.readFromProviders();
      } catch (err) {
        log.warn("Usage could not be read", err);
        this.usage = { source: this.file.hubs.length ? "hub" : "providers", providers: [], reading: false, problem: "Usage could not be read." };
      } finally {
        this.usageAt = this.clock();
        this.usageReading = undefined;
      }
      if (!this.stopped) this.host.emit("usage.changed", { usage: this.usageState() });
    })();
    await this.usageReading;
    return this.usageState();
  }

  private async readFromHubs(): Promise<UsageState> {
    const merged = new Map<string, UsageProvider>();
    const problems: string[] = [];
    for (const h of this.file.hubs) {
      const label = hostOf(h.url);
      let key: string | undefined;
      try {
        key = await this.hubKey(h.id);
      } catch {
        key = undefined;
      }
      if (!key) {
        problems.push(h.keyKind === "1password" ? `The key for ${label} could not be read from 1Password.` : `The key for ${label} is missing. Remove the hub and add it again.`);
        continue;
      }
      try {
        const hub: CliproxyHub = { url: h.url, key, label };
        for (const p of await readHub(hub, this.fetcher)) {
          const m = merged.get(p.id) ?? { id: p.id, label: p.label, accounts: [] };
          m.accounts.push(...p.accounts);
          merged.set(p.id, m);
        }
      } catch (err) {
        problems.push(`${label}: ${err instanceof Error ? err.message : "the hub could not be read."}`);
      }
    }
    const providers = [...merged.values()];
    return {
      source: "hub",
      providers,
      checkedAt: iso(this.clock()),
      reading: false,
      ...(problems.length ? { problem: problems.join(" ") } : providers.length ? {} : { problem: "The hub lists no Claude or Codex accounts." }),
    };
  }

  private async readFromProviders(): Promise<UsageState> {
    const providers: UsageProvider[] = [];
    const c = this.host.claude();
    if (this.file.enabled.claude && c.ready && c.executable) {
      const acc = await (this.o.readClaude ?? (() => readClaudeUsage({ executable: c.executable!, env: c.env, cwd: this.host.probeDir })))();
      providers.push({ id: "claude", label: "Claude", accounts: [acc] });
    }
    const x = this.host.codex();
    if (this.file.enabled.codex && x.ready && x.executable) {
      const acc = await (this.o.readCodex ?? (() => readCodexUsage({ executable: x.executable!, args: x.args ?? [], env: x.env })))();
      providers.push({ id: "codex", label: "Codex", accounts: [acc] });
    }
    return { source: "providers", providers, checkedAt: iso(this.clock()), reading: false, ...(providers.length ? {} : { problem: "Neither Claude Code nor Codex is ready on this Mac." }) };
  }

  // ------------------------------------------------------------ providers

  providers(): ProvidersState {
    return { ...this.providersState, providers: this.providerStates(), update: this.update ? { ...this.update, results: [...this.update.results] } : null };
  }

  private providerStates(): ProviderState[] {
    return PROVIDERS.map((def) => this.providerState(def.id));
  }

  private providerState(id: ProviderId): ProviderState {
    const setup = id === "claude" ? this.host.claude() : this.host.codex();
    const plan = updatePlan(id, setup.executable);
    const latest = this.latest[id]?.version;
    const enabled = this.file.enabled[id];
    const canUpdate = plan.method === "native" || plan.method === "npm" || plan.method === "homebrew";
    const signedIn = id === "codex" ? (setup.ready ? true : setup.problem === CODEX_NOT_SIGNED_IN ? false : undefined) : setup.ready ? true : undefined;
    return {
      id,
      label: providerDef(id).label,
      enabled,
      installed: !!setup.executable && setup.problem !== CODEX_NOT_INSTALLED,
      ready: setup.ready,
      ...(setup.version ? { version: setup.version } : {}),
      ...(latest ? { latest } : {}),
      updateAvailable: enabled && canUpdate && newer(latest, setup.version),
      ...(signedIn !== undefined ? { signedIn } : {}),
      ...(setup.executable ? { executable: setup.executable } : {}),
      installedBy: plan.method,
      ...(setup.problem ? { problem: setup.problem } : {}),
    };
  }

  /** Starts the regular look at the providers (and one soon after start). */
  start(): void {
    this.firstTimer = setTimeout(() => void this.check(false), this.o.timings?.firstCheckMs ?? FIRST_CHECK_MS);
    this.firstTimer.unref?.();
    this.startHealth();
  }

  private startHealth(): void {
    clearInterval(this.healthTimer);
    const secs = this.file.healthCheckSeconds ?? HEALTH_CHECK_DEFAULT;
    if (secs <= 0 || this.stopped) return;
    this.healthTimer = setInterval(() => void this.check(false), secs * 1000);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.firstTimer);
  }

  /** Looks at the providers: Codex again, Claude's version, and the newest versions (at most hourly unless `force`). */
  check(force = true): Promise<void> {
    if (this.checking) return this.checking;
    this.providersState = { ...this.providersState, checking: true };
    if (force) this.host.emit("providers.changed", { providers: this.providers() });
    this.checking = (async () => {
      try {
        if (this.file.enabled.codex) await this.host.recheckCodex();
        const c = this.host.claude();
        if (this.file.enabled.claude && c.executable) {
          const v = await installedVersion(c.executable, c.env, this.runner);
          if (v && v !== c.version) this.host.setClaude({ ...c, version: v });
        }
        for (const def of PROVIDERS) {
          if (!this.file.enabled[def.id]) continue;
          const seen = this.latest[def.id];
          if (!force && seen && this.clock() - seen.at < LATEST_EVERY_MS) continue;
          const setup = def.id === "claude" ? this.host.claude() : this.host.codex();
          const v = await latestVersion(updatePlan(def.id, setup.executable), this.fetcher);
          this.latest[def.id] = { ...(v ? { version: v } : seen?.version ? { version: seen.version } : {}), at: this.clock() };
        }
      } catch (err) {
        log.warn("Could not look at the providers", err);
      } finally {
        this.providersState = { ...this.providersState, checking: false, checkedAt: iso(this.clock()) };
        this.checking = undefined;
      }
      if (!this.stopped) this.host.emit("providers.changed", { providers: this.providers() });
    })();
    return this.checking;
  }

  /** Whether an update runs now. */
  get updating(): boolean {
    return !!this.update && !this.update.endedAt;
  }

  /** The update button: answers at once; the run goes on and tells every window as it goes. */
  startUpdate(): ProvidersState {
    if (this.updating) throw new EngineError("conflict", "An update is already running.");
    const todo = this.providerStates().filter((p) => p.updateAvailable);
    if (!todo.length) throw new EngineError("conflict", "Claude Code and Codex are up to date. Press Check now to look again.");
    this.update = { startedAt: iso(this.clock()), phase: "waiting", line: this.waitLine(), results: [] };
    this.tellUpdate();
    void this.runUpdate(todo.map((p) => p.id));
    return this.providers();
  }

  /** The promise of the running update, for tests. */
  private updateDone?: Promise<void>;
  updateSettled(): Promise<void> {
    return this.updateDone ?? Promise.resolve();
  }

  private waitLine(): string {
    const busy = this.host.busyBots();
    return busy.length ? `Waiting for ${listWords(busy)} to finish.` : "Starting the update.";
  }

  private tellUpdate(): void {
    if (!this.stopped) this.host.emit("providers.changed", { providers: this.providers() });
  }

  private runUpdate(ids: ProviderId[]): Promise<void> {
    this.updateDone = (async () => {
      const run = this.update!;
      const poll = this.o.timings?.updatePollMs ?? UPDATE_POLL_MS;
      const limit = this.o.timings?.updateWaitMs ?? UPDATE_WAIT_MS;
      const began = this.clock();
      // 1. Wait until every bot is calm.
      for (;;) {
        if (this.stopped) return;
        const busy = this.host.busyBots();
        if (!busy.length) break;
        if (this.clock() - began > limit) {
          Object.assign(run, { phase: "failed", endedAt: iso(this.clock()), line: `Nothing was updated: ${listWords(busy)} did not finish within ${Math.round(limit / 60000)} minutes. Try again later.` });
          this.tellUpdate();
          return;
        }
        const line = `Waiting for ${listWords(busy)} to finish.`;
        if (line !== run.line) {
          run.line = line;
          this.tellUpdate();
        }
        await new Promise((r) => setTimeout(r, poll));
      }
      // 2. Update, one after the other.
      run.phase = "updating";
      for (const id of ids) {
        const def = providerDef(id);
        const setup = id === "claude" ? this.host.claude() : this.host.codex();
        const plan = updatePlan(id, setup.executable);
        const from = setup.version;
        run.line = `Updating ${def.label}.`;
        this.tellUpdate();
        if (!plan.command) {
          run.results.push({ provider: id, ...(from ? { from } : {}), outcome: "skipped", problem: `Pobots does not know how ${def.label} was installed here.` });
          continue;
        }
        log.info(`Updating ${def.label} (${plan.method})`);
        const r = await this.runner(plan.command, plan.args, { env: { ...setup.env, ...plan.env }, timeoutMs: UPDATE_RUN_MS });
        const exe = setup.executable!;
        const to = await installedVersion(exe, setup.env, this.runner);
        if (!r.ok) {
          log.warn(`The update of ${def.label} did not work`);
          run.results.push({ provider: id, ...(from ? { from } : {}), ...(to ? { to } : {}), outcome: "failed", problem: failureLine(r.out) });
        } else run.results.push({ provider: id, ...(from ? { from } : {}), ...(to ? { to } : {}), outcome: newer(to, from) ? "updated" : "current" });
        if (to && id === "claude") this.host.setClaude({ ...this.host.claude(), version: to });
      }
      // 3. The bots' harness processes start anew at their next turn; Pobots itself keeps running.
      run.phase = "restarting";
      run.line = "Restarting the bots' Claude Code and Codex.";
      this.tellUpdate();
      if (this.host.redetectClaude && ids.includes("claude")) {
        try {
          this.host.setClaude(await this.host.redetectClaude());
        } catch (err) {
          log.warn("Could not look at Claude again after the update", err);
        }
      }
      if (ids.includes("codex")) await this.host.recheckCodex();
      this.host.restartHarnesses();
      // 4. The result in plain words.
      const failed = run.results.some((x) => x.outcome === "failed");
      Object.assign(run, { phase: failed ? "failed" : "done", endedAt: iso(this.clock()), line: resultLine(run.results) });
      log.info(`Provider update: ${run.line}`);
      this.providersState = { ...this.providersState, providers: this.providerStates() };
      this.tellUpdate();
      await this.check(true);
    })().catch((err) => {
      log.error("The provider update failed", err);
      if (this.update && !this.update.endedAt) Object.assign(this.update, { phase: "failed", endedAt: iso(this.clock()), line: "The update stopped because of an error. See the log." });
      this.tellUpdate();
    });
    return this.updateDone;
  }
}

/** "Po", "Po and Kaja", "Po, Kaja and Inbox". */
export function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function resultLine(results: ProviderUpdateRun["results"]): string {
  const parts = results.map((r) => {
    const name = providerDef(r.provider).label;
    if (r.outcome === "updated") return `${name} updated${r.from ? ` from ${r.from}` : ""}${r.to ? ` to ${r.to}` : ""}.`;
    if (r.outcome === "current") return `${name} was already up to date${r.to ? ` (${r.to})` : ""}.`;
    if (r.outcome === "skipped") return `${name} was not updated. ${r.problem ?? ""}`.trim();
    return `${name} could not be updated. ${r.problem ?? ""}`.trim();
  });
  return parts.join(" ") || "Nothing to update.";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Reads an op:// reference with 1Password's command line. Never logs or returns anything but the value. */
function opRead(ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // The service's own path is bare: look where the command line tools usually are too.
    const PATH = [process.env.PATH, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    execFile("op", ["read", "--no-newline", ref], { timeout: 20_000, maxBuffer: 64 * 1024, env: { ...process.env, PATH } }, (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
  });
}

const num = (n: number) => n.toLocaleString("en-US");

function timingValue(k: ChatTimingKey, v: ChatTiming[ChatTimingKey]): string {
  if (k === "enabled") return v ? "on" : "off";
  if (k === "fullFraction") return `${Math.round(Number(v) * 100)}%`;
  if (k === "minTokens" || k === "fullTokens" || k === "compactTokens") return `${num(Number(v))} tokens`;
  if (k === "warmMarginMinutes") return `${v} minutes`;
  return `${v} hours`;
}

/** What changed between two views of the settings, one plain part each, as it stands in the middle of a line. */
export function describeChanges(a: PobotsSettings, b: PobotsSettings, models: ModelInfo[]): string[] {
  const out: string[] = [];
  for (const p of PROVIDER_IDS) {
    for (const k of Object.keys(a.timing[p]) as ChatTimingKey[]) {
      if (a.timing[p][k] !== b.timing[p][k]) out.push(`${providerDef(p).label} chats, ${TIMING_WORDS[k].toLowerCase()} ${timingValue(k, b.timing[p][k])} (was ${timingValue(k, a.timing[p][k])})`);
    }
  }
  if (a.healthCheckSeconds !== b.healthCheckSeconds) {
    const w = (s: number) => (s === 0 ? "never" : `every ${s} seconds`);
    out.push(`providers looked at ${w(b.healthCheckSeconds)} (was ${w(a.healthCheckSeconds)})`);
  }
  if (a.titleModel !== b.titleModel) {
    const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
    out.push(`chat titles made by ${label(b.titleModel)} (was ${label(a.titleModel)})`);
  }
  for (const p of PROVIDER_IDS) {
    if (a.providers[p].enabled !== b.providers[p].enabled) out.push(`${providerDef(p).label} switched ${b.providers[p].enabled ? "on" : "off"}`);
  }
  return out;
}
