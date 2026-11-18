// The settings of the settings window (step 7b): the fresh-start timing per provider, how often the
// providers are looked at, the model that names chats, which providers are on, and the usage hubs.
//
// Kept in config.json beside what was there before, so an older config keeps working:
//   "context":   { ...for all providers..., "claude": { ... }, "codex": { ... } }   (step 2d, now per provider)
//   "providers": { "healthCheckSeconds": 300, "claude": { "enabled": true }, "codex": { "enabled": true } }
//   "titles":    { "model": "claude-haiku-5-5" }
//   "usage":     { "hubs": [{ "id", "kind": "cliproxy", "url", "addedAt", "keyKind" }] }
// A hub's key is never in config.json: it is in <dataDir>/secrets/usage-hubs.json, a file only the
// engine's user may read (0600, in a 0700 folder), and never in a log, an event or the backup.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ChatTiming, ChatTimingKey, PobotsSettings, ProviderId, SettingsPatch, UsageHub } from "../shared/protocol.js";
import { COMPACT_DEFAULTS, COMPACT_MAX, COMPACT_MIN, CONTEXT_DEFAULTS, type ContextSettings } from "./config.js";
import { EngineError } from "./errors.js";
import { log } from "./log.js";

export const PROVIDER_IDS: ProviderId[] = ["claude", "codex"];
export const TIMING_KEYS: ChatTimingKey[] = ["enabled", "minTokens", "fullFraction", "fullTokens", "warmMarginMinutes", "coldHours", "compactTokens"];

/** How often the providers are looked at unless set (T3 Code's default too). */
export const HEALTH_CHECK_DEFAULT = 300;
/** The model that names chats unless set: the cheapest Claude model (decided 14 Nov 2026). */
export const TITLE_MODEL_DEFAULT = "claude-haiku-5-5";
/** At most this many usage hubs. */
export const MAX_HUBS = 5;

/** What config.json holds for the step 7b settings, cleaned. Absent keys are defaults. */
export interface SettingsFile {
  /** The fresh-start rules for all providers (the old `context`), as cleaned by cleanContext. */
  context: ContextSettings;
  /** Values set for one provider only. */
  perProvider: Record<ProviderId, Partial<ChatTiming>>;
  healthCheckSeconds?: number;
  titleModel?: string;
  enabled: Record<ProviderId, boolean>;
  hubs: UsageHub[];
  /**
   * config.json's `context` sets compactTokens for all providers. Without it each provider's built-in
   * size is the default (COMPACT_DEFAULTS: Claude 500,000, Codex 300,000).
   */
  compactSet?: boolean;
}

/** One rule per value: what is allowed, said plainly for a refusal. */
const RULES: Record<ChatTimingKey, { ok: (v: unknown) => boolean; rule: string }> = {
  enabled: { ok: (v) => typeof v === "boolean", rule: "on or off" },
  minTokens: { ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000, rule: "a whole number of tokens from 0 to 10,000,000" },
  fullFraction: { ok: (v) => typeof v === "number" && v > 0 && v <= 1, rule: "a share above 0 and at most 1, such as 0.75" },
  fullTokens: { ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 10_000_000, rule: "a whole number of tokens from 1,000 to 10,000,000" },
  warmMarginMinutes: { ok: (v) => typeof v === "number" && v >= 0 && v <= 120, rule: "a number of minutes from 0 to 120" },
  coldHours: { ok: (v) => typeof v === "number" && v > 0 && v <= 720, rule: "a number of hours above 0, at most 720" },
  compactTokens: { ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= COMPACT_MIN && v <= COMPACT_MAX, rule: "a whole number of tokens from 150,000 to 1,000,000" },
};

/** Whether a timing value is allowed; the plain rule when not. */
export function timingProblem(key: ChatTimingKey, value: unknown): string | undefined {
  return RULES[key].ok(value) ? undefined : `${TIMING_WORDS[key]} must be ${RULES[key].rule}.`;
}

/** The names of the values, for refusals and for the note a bot's change leaves. */
export const TIMING_WORDS: Record<ChatTimingKey, string> = {
  enabled: "Fresh starts",
  minTokens: "Worth a fresh start from",
  fullFraction: "Nearly full at (share of the window)",
  fullTokens: "Nearly full at (tokens)",
  warmMarginMinutes: "Before the cache goes cold",
  coldHours: "After a quiet spell of",
  compactTokens: "Shortened in the middle of work at",
};

/** Reads the step 7b settings from config.json's parsed object. A bad value never stops the engine. */
export function readSettingsFile(obj: Record<string, unknown>, context: ContextSettings | undefined, where = "config.json"): SettingsFile {
  const out: SettingsFile = {
    context: context ?? { ...CONTEXT_DEFAULTS },
    perProvider: { claude: {}, codex: {} },
    enabled: { claude: true, codex: true },
    hubs: [],
  };
  const ctx = obj.context && typeof obj.context === "object" && !Array.isArray(obj.context) ? (obj.context as Record<string, unknown>) : {};
  if (RULES.compactTokens.ok(ctx.compactTokens)) out.compactSet = true;
  for (const p of PROVIDER_IDS) {
    const raw = ctx[p];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      log.warn(`"context.${p}" in ${where} must hold an object. Using the setting for all providers.`);
      continue;
    }
    for (const key of TIMING_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (RULES[key].ok(v)) (out.perProvider[p] as Record<string, unknown>)[key] = v;
      else log.warn(`"context.${p}.${key}" in ${where} must be ${RULES[key].rule}. Using the setting for all providers.`);
    }
  }
  const prov = obj.providers && typeof obj.providers === "object" && !Array.isArray(obj.providers) ? (obj.providers as Record<string, unknown>) : undefined;
  if (prov) {
    const h = prov.healthCheckSeconds;
    if (h !== undefined) {
      if (typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 86_400 && (h === 0 || h >= 30)) out.healthCheckSeconds = h;
      else log.warn(`"providers.healthCheckSeconds" in ${where} must be 0 or a whole number of seconds from 30 to 86400. Using ${HEALTH_CHECK_DEFAULT}.`);
    }
    for (const p of PROVIDER_IDS) {
      const e = (prov[p] as Record<string, unknown> | undefined)?.enabled;
      if (typeof e === "boolean") out.enabled[p] = e;
    }
  }
  const titles = obj.titles && typeof obj.titles === "object" && !Array.isArray(obj.titles) ? (obj.titles as Record<string, unknown>) : undefined;
  if (titles && typeof titles.model === "string" && /^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(titles.model)) out.titleModel = titles.model;
  else if (titles?.model !== undefined) log.warn(`"titles.model" in ${where} must be a model id. Using ${TITLE_MODEL_DEFAULT}.`);
  const usage = obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage) ? (obj.usage as Record<string, unknown>) : undefined;
  if (usage && Array.isArray(usage.hubs)) {
    for (const h of usage.hubs.slice(0, MAX_HUBS)) {
      const r = h && typeof h === "object" ? (h as Record<string, unknown>) : {};
      const url = typeof r.url === "string" ? cleanHubUrl(r.url) : undefined;
      if (typeof r.id !== "string" || !/^hub_[a-z0-9]{6,32}$/.test(r.id) || !url) {
        log.warn(`A usage hub in ${where} is not complete. Leaving it out.`);
        continue;
      }
      out.hubs.push({ id: r.id, kind: "cliproxy", url, addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date(0).toISOString(), keyKind: r.keyKind === "1password" ? "1password" : "saved" });
    }
  }
  return out;
}

/** The timing for one provider: Pobots' defaults, then config.json's `context`, then the provider's own values. */
export function timingFor(file: SettingsFile, p: ProviderId): ChatTiming {
  return { ...defaultTiming(file, p), ...file.perProvider[p] };
}

/** What a provider's values go back to on reset. The size for summarising is the provider's own unless config.json sets one for all. */
export function defaultTiming(file: SettingsFile, p: ProviderId): ChatTiming {
  const c = file.context;
  return { enabled: c.enabled, minTokens: c.minTokens, fullFraction: c.fullFraction, fullTokens: c.fullTokens, warmMarginMinutes: c.warmMarginMinutes, coldHours: c.coldHours, compactTokens: file.compactSet ? c.compactTokens : COMPACT_DEFAULTS[p] };
}

/** The ContextSettings the fresh-start rules use for one provider (cacheMinutes stays the test-only global one). */
export function contextFor(file: SettingsFile, p: ProviderId): ContextSettings {
  return { ...file.context, ...timingFor(file, p) };
}

/** The settings as the window sees them. */
export function settingsView(file: SettingsFile): PobotsSettings {
  return {
    timing: { claude: timingFor(file, "claude"), codex: timingFor(file, "codex") },
    timingDefaults: { claude: defaultTiming(file, "claude"), codex: defaultTiming(file, "codex") },
    timingSet: { claude: TIMING_KEYS.filter((k) => file.perProvider.claude[k] !== undefined), codex: TIMING_KEYS.filter((k) => file.perProvider.codex[k] !== undefined) },
    healthCheckSeconds: file.healthCheckSeconds ?? HEALTH_CHECK_DEFAULT,
    titleModel: file.titleModel ?? TITLE_MODEL_DEFAULT,
    providers: { claude: { enabled: file.enabled.claude }, codex: { enabled: file.enabled.codex } },
    hubs: file.hubs.map((h) => ({ ...h })),
  };
}

/** Checks a patch and applies it to a copy. Throws "bad_request" with one plain sentence. Never writes. */
export function applyPatch(file: SettingsFile, patch: SettingsPatch, models: { id: string; harness: string }[]): SettingsFile {
  const next: SettingsFile = {
    ...file,
    perProvider: { claude: { ...file.perProvider.claude }, codex: { ...file.perProvider.codex } },
    enabled: { ...file.enabled },
    hubs: [...file.hubs],
  };
  for (const p of PROVIDER_IDS) {
    const t = patch.timing?.[p];
    if (!t) continue;
    for (const [k, v] of Object.entries(t) as [ChatTimingKey, unknown][]) {
      if (!TIMING_KEYS.includes(k)) throw new EngineError("bad_request", `There is no chat setting called ${String(k)}.`);
      if (v === null) {
        delete next.perProvider[p][k];
        continue;
      }
      const problem = timingProblem(k, v);
      if (problem) throw new EngineError("bad_request", problem);
      (next.perProvider[p] as Record<string, unknown>)[k] = v;
    }
  }
  if (patch.healthCheckSeconds !== undefined) {
    const h = patch.healthCheckSeconds;
    if (!Number.isInteger(h) || h < 0 || h > 86_400 || (h > 0 && h < 30)) throw new EngineError("bad_request", "How often Pobots looks at the providers must be 0 (never) or from 30 to 86400 seconds.");
    next.healthCheckSeconds = h;
  }
  if (patch.titleModel !== undefined) {
    const m = models.find((x) => x.id === patch.titleModel);
    if (!m) throw new EngineError("bad_request", "That model is not in the list.");
    if (m.harness !== "claude") throw new EngineError("bad_request", "Chat titles are made by a Claude model for now.");
    next.titleModel = m.id;
  }
  for (const p of PROVIDER_IDS) {
    const e = patch.providers?.[p]?.enabled;
    if (e !== undefined) next.enabled[p] = e;
  }
  return next;
}

/** What config.json's parts become from the settings, for writeConfigParts. Defaults are left out. */
export function settingsParts(file: SettingsFile): { context: Record<string, unknown>; providers: Record<string, unknown>; titles: Record<string, unknown>; usage: Record<string, unknown> } {
  const context: Record<string, unknown> = {};
  for (const p of PROVIDER_IDS) context[p] = Object.keys(file.perProvider[p]).length ? { ...file.perProvider[p] } : undefined;
  return {
    context,
    providers: {
      healthCheckSeconds: file.healthCheckSeconds,
      claude: file.enabled.claude ? undefined : { enabled: false },
      codex: file.enabled.codex ? undefined : { enabled: false },
    },
    titles: { model: file.titleModel },
    usage: { hubs: file.hubs.length ? file.hubs.map((h) => ({ ...h })) : undefined },
  };
}

// ------------------------------------------------------------ usage hubs and their keys

/** A hub's address: https (or http on this machine), no user name or password in it. Undefined when it is not one. */
export function cleanHubUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  // People paste the hub's web panel, which ends in management.html.
  const path = u.pathname.replace(/(\/management\.html)?\/*$/i, "");
  return `${u.protocol}//${u.host}${path}`;
}

export function newHubId(): string {
  return `hub_${randomBytes(8).toString("hex")}`;
}

/** Whether a key is an op:// reference (read with 1Password's command line when used). */
export function isOpRef(key: string): boolean {
  // 1Password's names may hold spaces: "op://My vault/Usage hub/management key".
  return /^op:\/\/[^/\n]+\/[^/\n]+\/[^\n]+$/.test(key.trim());
}

/**
 * The hubs' keys, in <dataDir>/secrets/usage-hubs.json: { "<hub id>": "<key or op:// reference>" }.
 * The folder is 0700 and the file 0600. Nothing here logs a key or puts it in an error.
 */
export class HubKeys {
  private readonly dir: string;
  private readonly path: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "secrets");
    this.path = join(this.dir, "usage-hubs.json");
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      log.warn("The usage hubs' keys could not be read.");
      return {};
    }
  }

  private writeAll(all: Record<string, string>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = join(this.dir, `.usage-hubs.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(all) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } catch {
      rmSync(tmp, { force: true });
      throw new EngineError("internal", "The key could not be saved on the Mac.");
    }
  }

  get(id: string): string | undefined {
    return this.readAll()[id];
  }

  set(id: string, key: string): void {
    this.writeAll({ ...this.readAll(), [id]: key });
  }

  remove(id: string): void {
    const all = this.readAll();
    if (!(id in all)) return;
    delete all[id];
    this.writeAll(all);
  }
}
