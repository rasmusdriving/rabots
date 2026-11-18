// The mock engine's settings window (step 7b, docs/build/step-7b.md): the settings with their
// defaults, the providers with an update that can be watched (waiting for bots, updating,
// restarting, the result), the usage meters from the providers or a hub, and chat titles. Nothing
// is installed, read or sent anywhere: this only acts it out for the window.
//
// ?usage= picks the usage reading: one (the default: one account each), several (two Claude
// accounts and two Codex accounts, as from a hub), none (nothing could be read).
// ?update=none starts with Claude Code and Codex up to date; the default has a Codex update.
// ?update=nocodex: Codex is not installed (a public install without it), Claude Code up to date.
// ?pobots= acts out a public install (engine 0.34.0): available (Pobots 0.34.1 is out), current (up
// to date), manual (out, but Pobots cannot restart itself), problem (the last look did not work),
// dirty (the folder has changes of its own, so the update refuses). Without it, no Pobots card.
// Levers on window.pobotsMock: settingsState, providersState, usageState, updateHold, updateNext,
// hubKeysKept, titleChat, usageNext.
import type { ChatTitle, ChatTiming, ChatTimingKey, Events, Methods, ModelInfo, PobotsSettings, PobotsUpdateRun, ProviderId, ProvidersState, ProviderUpdateRun, UsageAccount, UsageProvider, UsageState } from "../../shared/protocol";
import { at } from "./mock-data";
import { EngineError } from "./types";

/** The sample public install's clone (?pobots=). */
const CLONE = "/Users/kaja/pobots";

type SettingsMethod = "settings.set" | "providers.check" | "providers.update" | "usage.read" | "usage.hub.add" | "usage.hub.remove" | "chat.titles";
type Emit = (e: { event: "settings.changed"; data: Events["settings.changed"] } | { event: "providers.changed"; data: Events["providers.changed"] } | { event: "usage.changed"; data: Events["usage.changed"] } | { event: "chat.titled"; data: Events["chat.titled"] }) => void;

export interface MockSettingsHost {
  emit: Emit;
  models: () => ModelInfo[];
  /** Names of the bots on a provider. */
  botsOn: (p: ProviderId) => string[];
  /** Names of the bots that are working now. */
  busyBots: () => string[];
}

const DEFAULT_TIMING: ChatTiming = { enabled: true, minTokens: 100000, fullFraction: 0.75, fullTokens: 300000, warmMarginMinutes: 8, coldHours: 4, compactTokens: 300000 };
const KEYS: ChatTimingKey[] = ["enabled", "minTokens", "fullFraction", "fullTokens", "warmMarginMinutes", "coldHours", "compactTokens"];

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
/** A clock time some days ago; today's is placed like every other seed of today (mock-data's `at`). */
const daysAgo = (d: number, h = 10) => at(d, h, 12);
const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function claudeAccount(id: string, email: string, used: [number, number, number, number?], via: string): UsageAccount {
  return {
    id,
    email,
    plan: "Max",
    via,
    windows: [
      { id: "five_hour", kind: "session", label: "Session", usedPercent: used[0], resetsAt: hoursFromNow(3.4) },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: used[1], resetsAt: hoursFromNow(5 * 24 + 10) },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: used[2], resetsAt: hoursFromNow(5 * 24 + 10) },
      ...(used[3] !== undefined ? [{ id: "monthly_spend", kind: "monthly" as const, label: "Monthly spend", usedPercent: used[3] }] : []),
    ],
  };
}

function codexAccount(id: string, email: string, used: [number, number], via = "This Mac"): UsageAccount {
  return {
    id,
    email,
    plan: "Pro",
    via,
    windows: [
      { id: "primary", kind: "session", label: "Session", usedPercent: used[0], resetsAt: hoursFromNow(4.1) },
      { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: used[1], resetsAt: hoursFromNow(2 * 24 + 6) },
    ],
  };
}

function usageFor(kind: string, hub: boolean): UsageState {
  const via = hub ? "hub-mac.example.net:8443" : "This Mac";
  if (kind === "none") return { source: hub ? "hub" : "providers", providers: [], reading: false, checkedAt: new Date().toISOString(), problem: "Neither Claude Code nor Codex is ready on this Mac." };
  const providers: UsageProvider[] =
    kind === "several" || hub
      ? [
          { id: "claude", label: "Claude", accounts: [claudeAccount("c1", "kaja.lind@example.com", [0, 30, 67], via), claudeAccount("c2", "ops.team@example.com", [0, 68, 73, 41], via)] },
          { id: "codex", label: "Codex", accounts: [codexAccount("x1", "kaja.lind@example.com", [0, 2]), codexAccount("x2", "ops.team@example.com", [12, 88])].map((a) => ({ ...a, via })) },
        ]
      : [
          { id: "claude", label: "Claude", accounts: [claudeAccount("claude-local", "kaja.lind@example.com", [18, 45, 46, 100], via)] },
          { id: "codex", label: "Codex", accounts: [codexAccount("codex-local", "kaja.lind@example.com", [0, 100])].map((a) => ({ ...a, via })) },
        ];
  return { source: hub ? "hub" : "providers", providers, reading: false, checkedAt: new Date().toISOString() };
}

export class MockSettings {
  private settings: PobotsSettings;
  private prov: ProvidersState;
  private usage: UsageState | null = null;
  private usageKind: string;
  private titles = new Map<string, ChatTitle[]>();
  /** How many hub keys the mock keeps, to show that a key never comes back in a state or an event. */
  keysKept = 0;
  private hold: string[] | null = null;
  private next: "ok" | "fail" = "ok";
  private pobotsKind: string | null;

  constructor(
    private readonly host: MockSettingsHost,
    flags: URLSearchParams,
    botIds: string[],
  ) {
    this.usageKind = flags.get("usage") ?? "one";
    this.pobotsKind = flags.get("pobots");
    const noCodex = flags.get("update") === "nocodex";
    const upToDate = flags.get("update") === "none" || noCodex;
    this.settings = {
      // The built-in size for summarising is per provider (15 Nov 2026): Claude 500,000, Codex 300,000.
      timing: { claude: { ...DEFAULT_TIMING, minTokens: 150000, compactTokens: 500000 }, codex: { ...DEFAULT_TIMING } },
      timingDefaults: { claude: { ...DEFAULT_TIMING, compactTokens: 500000 }, codex: { ...DEFAULT_TIMING } },
      timingSet: { claude: ["minTokens"], codex: [] },
      healthCheckSeconds: 300,
      titleModel: "claude-haiku-5-5",
      providers: { claude: { enabled: true }, codex: { enabled: true } },
      hubs: [],
    };
    this.prov = {
      machine: "Kaja's Mac mini",
      checking: false,
      checkedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      update: null,
      providers: [
        { id: "claude", label: "Claude Code", enabled: true, installed: true, ready: true, version: "2.1.325", latest: "2.1.325", updateAvailable: false, signedIn: true, executable: "/Users/kaja/.local/bin/claude", installedBy: "native" },
        noCodex
          ? { id: "codex", label: "Codex", enabled: true, installed: false, ready: false, updateAvailable: false, installedBy: "none", problem: "Codex is not installed on this Mac." }
          : { id: "codex", label: "Codex", enabled: true, installed: true, ready: true, version: "0.165.0", latest: upToDate ? "0.165.0" : "0.169.0", updateAvailable: !upToDate, signedIn: true, executable: "/Users/kaja/.local/bin/codex", installedBy: "native" },
      ],
    };
    const k = this.pobotsKind;
    if (k) {
      const out = k !== "current";
      this.prov.pobots = {
        current: "0.34.0",
        latest: out ? "0.34.1" : "0.34.0",
        available: out,
        checkedAt: this.prov.checkedAt!,
        canRestart: k !== "manual",
        ...(k === "problem" ? { problem: "Pobots could not look for a new version just now. It tries again later." } : {}),
        run: null,
      };
    }
    // Titles for the first two bots: three earlier sessions, a fresh run and a helper.
    for (const [i, id] of botIds.slice(0, 2).entries()) {
      this.titles.set(id, [
        { threadId: `${id}-main`, kind: "main", fromSeq: 120, title: i ? "Weekly onboarding report" : "Customer survey launch for Acme", startedAt: daysAgo(0, 8) },
        { threadId: `${id}-run1`, kind: "run", fromSeq: 0, title: "Morning brief of open tickets", startedAt: daysAgo(1, 7), endedAt: daysAgo(1, 7) },
        { threadId: `${id}-main`, kind: "main", fromSeq: 61, toSeq: 119, title: "Backup key and OneDrive folder", startedAt: daysAgo(2), endedAt: daysAgo(1, 18) },
        { threadId: `${id}-help1`, kind: "helper", fromSeq: 0, title: "Compare two survey exports", startedAt: daysAgo(3), endedAt: daysAgo(3) },
        { threadId: `${id}-main`, kind: "main", fromSeq: 1, toSeq: 60, title: "Setting up the HubSpot ticket flow", startedAt: daysAgo(9), endedAt: daysAgo(3, 16) },
      ]);
    }
  }

  view(): PobotsSettings {
    return structuredClone(this.settings);
  }

  providers(): ProvidersState {
    return structuredClone(this.prov);
  }

  usageState(): UsageState | null {
    return this.usage ? structuredClone(this.usage) : null;
  }

  readonly handlers: { [M in SettingsMethod]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "settings.set": (p) => {
      const s = structuredClone(this.settings);
      for (const h of ["claude", "codex"] as ProviderId[]) {
        if (p.patch.providers?.[h]?.enabled === false && s.providers[h].enabled) {
          const on = this.host.botsOn(h);
          if (on.length) throw new EngineError({ code: "conflict", message: `${h === "claude" ? "Claude Code" : "Codex"} cannot be switched off while ${on.join(" and ")} ${on.length === 1 ? "runs" : "run"} on it. Move ${on.length === 1 ? "that bot" : "them"} to another model first.` });
        }
        const t = p.patch.timing?.[h];
        if (t) {
          for (const [k, v] of Object.entries(t) as [ChatTimingKey, number | boolean | null][]) {
            if (!KEYS.includes(k)) throw new EngineError({ code: "bad_request", message: "There is no such chat setting." });
            if (v === null) {
              (s.timing[h] as unknown as Record<string, unknown>)[k] = s.timingDefaults[h][k];
              s.timingSet[h] = s.timingSet[h].filter((x) => x !== k);
              continue;
            }
            if (k === "minTokens" && (typeof v !== "number" || v < 0 || v > 10_000_000 || !Number.isInteger(v))) throw new EngineError({ code: "bad_request", message: "Worth a fresh start from must be a whole number of tokens from 0 to 10,000,000." });
            if (k === "fullTokens" && (typeof v !== "number" || v < 1000 || v > 10_000_000)) throw new EngineError({ code: "bad_request", message: "Nearly full at (tokens) must be a whole number of tokens from 1,000 to 10,000,000." });
            if (k === "fullFraction" && (typeof v !== "number" || v <= 0 || v > 1)) throw new EngineError({ code: "bad_request", message: "Nearly full at (share of the window) must be a share above 0 and at most 1, such as 0.75." });
            if (k === "warmMarginMinutes" && (typeof v !== "number" || v < 0 || v > 120)) throw new EngineError({ code: "bad_request", message: "Before the cache goes cold must be a number of minutes from 0 to 120." });
            if (k === "coldHours" && (typeof v !== "number" || v <= 0 || v > 720)) throw new EngineError({ code: "bad_request", message: "After a quiet spell of must be a number of hours above 0, at most 720." });
            if (k === "compactTokens" && (typeof v !== "number" || !Number.isInteger(v) || v < 150_000 || v > 1_000_000)) throw new EngineError({ code: "bad_request", message: "Shortened in the middle of work at must be a whole number of tokens from 150,000 to 1,000,000." });
            (s.timing[h] as unknown as Record<string, unknown>)[k] = v;
            if (!s.timingSet[h].includes(k)) s.timingSet[h] = [...s.timingSet[h], k];
          }
        }
        if (p.patch.providers?.[h]) s.providers[h] = { enabled: p.patch.providers[h]!.enabled };
      }
      if (p.patch.healthCheckSeconds !== undefined) {
        const v = p.patch.healthCheckSeconds;
        if (!Number.isInteger(v) || v < 0 || v > 86400 || (v > 0 && v < 30)) throw new EngineError({ code: "bad_request", message: "How often Pobots looks at the providers must be 0 (never) or from 30 to 86400 seconds." });
        s.healthCheckSeconds = v;
      }
      if (p.patch.titleModel !== undefined) {
        const m = this.host.models().find((x) => x.id === p.patch.titleModel);
        if (!m) throw new EngineError({ code: "bad_request", message: "That model is not in the list." });
        s.titleModel = m.id;
      }
      const changed = JSON.stringify(s) !== JSON.stringify(this.settings);
      this.settings = s;
      if (changed) {
        this.host.emit({ event: "settings.changed", data: { settings: this.view() } });
        if (p.patch.providers) {
          this.prov.providers = this.prov.providers.map((x) => ({ ...x, enabled: s.providers[x.id].enabled, updateAvailable: s.providers[x.id].enabled && x.latest !== x.version }));
          this.host.emit({ event: "providers.changed", data: { providers: this.providers() } });
        }
      }
      return { settings: this.view() };
    },
    "providers.check": () => {
      this.prov.checking = true;
      void later(700).then(() => {
        this.prov.checking = false;
        this.prov.checkedAt = new Date().toISOString();
        this.host.emit({ event: "providers.changed", data: { providers: this.providers() } });
      });
      return { providers: this.providers() };
    },
    "providers.update": () => {
      const pb = this.prov.pobots;
      if ((this.prov.update && !this.prov.update.endedAt) || (pb?.run && !pb.run.endedAt)) throw new EngineError({ code: "conflict", message: "An update is already running." });
      const todo = this.prov.providers.filter((p) => p.updateAvailable);
      const self = !!pb?.available && pb.canRestart;
      if (!todo.length && !self) throw new EngineError({ code: "conflict", message: pb ? "Pobots, Claude Code and Codex are up to date. Press Check now to look again." : "Claude Code and Codex are up to date. Press Check now to look again." });
      if (self && this.pobotsKind === "dirty") throw new EngineError({ code: "conflict", message: `Pobots was not updated: ${CLONE} has changes of its own. Commit or undo them, then try again.` });
      const busy = this.hold ?? this.host.busyBots();
      let first: Promise<void> | undefined;
      if (todo.length) {
        this.prov.update = { startedAt: new Date().toISOString(), phase: "waiting", line: busy.length ? `Waiting for ${busy.join(" and ")} to finish.` : "Starting the update.", results: [] };
        first = this.runUpdate(todo.map((p) => p.id));
      }
      if (self) {
        pb!.run = { startedAt: new Date().toISOString(), phase: "waiting", line: first ? "Waiting for the other updates to finish." : busy.length ? `Waiting for ${busy.join(" and ")} to finish.` : "Starting the update of Pobots.", from: pb!.current, to: pb!.latest! };
        void (first ?? Promise.resolve()).then(() => this.runPobots());
      }
      return { providers: this.providers() };
    },
    "usage.read": (p) => {
      const hub = this.settings.hubs.length > 0;
      if (this.usage && !p.refresh) return { usage: this.usageState()! };
      this.usage = { ...(this.usage ?? usageFor(this.usageKind, hub)), reading: true };
      void later(600).then(() => {
        this.usage = usageFor(this.usageKind, this.settings.hubs.length > 0);
        this.host.emit({ event: "usage.changed", data: { usage: this.usageState()! } });
      });
      return { usage: this.usageState()! };
    },
    "usage.hub.add": (p) => {
      let url: URL;
      try {
        url = new URL(p.url.trim());
      } catch {
        throw new EngineError({ code: "bad_request", message: "That is not a hub address. Use the https address of your CLIProxyAPI, such as https://host:8443." });
      }
      if (url.protocol !== "https:") throw new EngineError({ code: "bad_request", message: "That is not a hub address. Use the https address of your CLIProxyAPI, such as https://host:8443." });
      const key = p.key.trim();
      if (!key || (/\s/.test(key) && !key.startsWith("op://"))) throw new EngineError({ code: "bad_request", message: "Paste the hub's management key, or an op:// reference to it in 1Password." });
      const clean = `${url.protocol}//${url.host}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`;
      if (this.settings.hubs.some((h) => h.url === clean)) throw new EngineError({ code: "conflict", message: "That hub is already added. Remove it first to give it a new key." });
      this.keysKept++;
      this.settings.hubs.push({ id: `hub_${Math.random().toString(16).slice(2, 12)}`, kind: "cliproxy", url: clean, addedAt: new Date().toISOString(), keyKind: key.startsWith("op://") ? "1password" : "saved" });
      this.host.emit({ event: "settings.changed", data: { settings: this.view() } });
      this.usage = null;
      return { settings: this.view() };
    },
    "usage.hub.remove": (p) => {
      if (!this.settings.hubs.some((h) => h.id === p.id)) throw new EngineError({ code: "not_found", message: "There is no such usage hub." });
      this.settings.hubs = this.settings.hubs.filter((h) => h.id !== p.id);
      this.keysKept = Math.max(0, this.keysKept - 1);
      this.host.emit({ event: "settings.changed", data: { settings: this.view() } });
      this.usage = null;
      return { settings: this.view() };
    },
    "chat.titles": (p) => {
      const all = (this.titles.get(p.botId) ?? []).filter((c) => !p.before || c.startedAt < p.before);
      const n = p.limit ?? 30;
      return { chats: structuredClone(all.slice(0, n)), hasMore: all.length > n };
    },
  };

  private async runUpdate(ids: ProviderId[]): Promise<void> {
    const run = this.prov.update!;
    const tell = () => this.host.emit({ event: "providers.changed", data: { providers: this.providers() } });
    tell();
    for (;;) {
      const busy = this.hold ?? this.host.busyBots();
      if (!busy.length) break;
      const line = `Waiting for ${busy.join(" and ")} to finish.`;
      if (line !== run.line) {
        run.line = line;
        tell();
      }
      await later(300);
    }
    run.phase = "updating";
    for (const id of ids) {
      const p = this.prov.providers.find((x) => x.id === id)!;
      run.line = `Updating ${p.label}.`;
      tell();
      await later(900);
      if (this.next === "fail") run.results.push({ provider: id, from: p.version, to: p.version, outcome: "failed", problem: "It said: permission denied" });
      else {
        run.results.push({ provider: id, from: p.version, to: p.latest, outcome: "updated" });
        p.version = p.latest;
        p.updateAvailable = false;
      }
    }
    run.phase = "restarting";
    run.line = "Restarting the bots' Claude Code and Codex.";
    tell();
    await later(600);
    const failed = run.results.some((r) => r.outcome === "failed");
    const words = (r: ProviderUpdateRun["results"][number]) => {
      const name = r.provider === "claude" ? "Claude Code" : "Codex";
      return r.outcome === "updated" ? `${name} updated from ${r.from} to ${r.to}.` : `${name} could not be updated. ${r.problem ?? ""}`.trim();
    };
    Object.assign(run, { phase: failed ? "failed" : "done", endedAt: new Date().toISOString(), line: run.results.map(words).join(" ") });
    tell();
  }

  /** Pobots's own update, acted out: the phases, then the restart and its result. */
  private async runPobots(): Promise<void> {
    const pb = this.prov.pobots!;
    const run = pb.run!;
    const tell = () => this.host.emit({ event: "providers.changed", data: { providers: this.providers() } });
    tell();
    for (;;) {
      const busy = this.hold ?? this.host.busyBots();
      if (!busy.length) break;
      const line = `Waiting for ${busy.join(" and ")} to finish.`;
      if (line !== run.line) {
        run.line = line;
        tell();
      }
      await later(300);
    }
    const step = async (phase: PobotsUpdateRun["phase"], line: string, ms: number) => {
      Object.assign(run, { phase, line });
      tell();
      await later(ms);
    };
    await step("pulling", `Fetching Pobots ${run.to}.`, 500);
    await step("building", `Building Pobots ${run.to}.`, 900);
    if (this.next === "fail") {
      Object.assign(run, { phase: "failed", endedAt: new Date().toISOString(), line: `Pobots ${run.to} could not be built, so nothing changed. See the log.` });
      return tell();
    }
    await step("restarting", "Restarting Pobots to finish the update.", 900);
    pb.current = run.to!;
    pb.available = false;
    Object.assign(run, { phase: "done", endedAt: new Date().toISOString(), line: `Pobots updated to ${run.to}.` });
    tell();
  }

  /** Levers. */
  setHold(names: string[] | null): void {
    this.hold = names;
  }
  setNext(next: "ok" | "fail"): void {
    this.next = next;
  }
  setUsageKind(kind: string): void {
    this.usageKind = kind;
    this.usage = null;
  }
  titleChat(botId: string, chat: ChatTitle): void {
    const list = this.titles.get(botId) ?? [];
    this.titles.set(botId, [chat, ...list.filter((c) => !(c.threadId === chat.threadId && c.fromSeq === chat.fromSeq))]);
    this.host.emit({ event: "chat.titled", data: { botId, chat } });
  }
}
