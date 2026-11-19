// How much of the plans is left: from usage hubs and, where no hub lists a provider,
// from Claude Code or Codex on this Mac. Nothing here changes anything: every call
// only reads, and none sends a prompt to a model.
//
// Copied from T3 Code's approach (MIT, github.com/pingdotgg/t3code):
// apps/server/src/provider/claudeUsageLimits.ts (the windows of Claude's usage answer),
// apps/server/src/provider/ClaudeProvider.ts (a Claude probe that sends no prompt and asks for usage),
// apps/server/src/provider/codexUsageLimits.ts (Codex's rate limits), and
// apps/server/src/usage/cliproxyApi.ts (a CLIProxyAPI hub: list its accounts, then ask each
// provider's own usage address through the hub with the account's own token).
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UsageAccount, UsageProvider, UsageWindow } from "../shared/protocol.js";
import { CodexRpc } from "./codex/rpc.js";
import { CODEX_RESET_CREDITS, CODEX_USAGE, codexCredits, codexResetCredits, epochSeconds, hubResetCredits, record } from "./core/usage-codex.js";
import type { Fetcher } from "./providers.js";

type Loose = Record<string, unknown>;

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function isoFromString(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

// ------------------------------------------------------------ Claude

/**
 * The windows in Claude's usage answer (utilization 0 to 100): the five-hour session, the week, a
 * week per model (such as Fable), and the monthly spend when extra usage is on.
 */
export function claudeWindows(rateLimits: unknown): UsageWindow[] {
  const r = rateLimits && typeof rateLimits === "object" ? (rateLimits as Loose) : {};
  const out: UsageWindow[] = [];
  const plain: [string, UsageWindow["kind"], string][] = [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly", "Weekly"],
  ];
  for (const [id, kind, label] of plain) {
    const w = r[id] as Loose | null | undefined;
    const u = num(w?.utilization);
    if (u === undefined) continue;
    const resetsAt = isoFromString(w?.resets_at);
    out.push({ id, kind, label, usedPercent: clamp(u), ...(resetsAt ? { resetsAt } : {}) });
  }
  // Per model, from `model_scoped` (the CLI's answer) or `limits` with kind "weekly_scoped" (the usage address's answer).
  const scoped: { name: string; used: number; resets?: string }[] = [];
  if (Array.isArray(r.model_scoped)) {
    for (const e of r.model_scoped as Loose[]) {
      const u = num(e?.utilization);
      if (typeof e?.display_name === "string" && u !== undefined) scoped.push({ name: e.display_name, used: u, resets: isoFromString(e.resets_at) });
    }
  }
  if (Array.isArray(r.limits)) {
    for (const e of r.limits as Loose[]) {
      const model = ((e?.scope as Loose | undefined)?.model as Loose | undefined)?.display_name;
      const u = num(e?.percent);
      if (e?.kind === "weekly_scoped" && typeof model === "string" && u !== undefined && !scoped.some((s) => s.name === model)) scoped.push({ name: model, used: u, resets: isoFromString(e.resets_at) });
    }
  }
  for (const s of scoped) out.push({ id: `seven_day_${scopeToken(s.name)}`, kind: "weekly", label: `Weekly · ${s.name}`, usedPercent: clamp(s.used), ...(s.resets ? { resetsAt: s.resets } : {}) });
  const extra = r.extra_usage as Loose | null | undefined;
  if (extra?.is_enabled === true) {
    const used = num(extra.used_credits);
    const limit = num(extra.monthly_limit);
    const pct = used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : num(extra.utilization);
    if (pct !== undefined) out.push({ id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: clamp(pct) });
  }
  return out;
}

/**
 * Claude Code's own reading on this Mac: a Claude process that is never given a prompt (so no
 * request reaches a model), asked for its account and its usage, then stopped. As T3 Code does.
 */
export async function readClaudeUsage(o: { executable: string; env: Record<string, string | undefined>; cwd: string; timeoutMs?: number }): Promise<UsageAccount> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 30_000);
  const base: UsageAccount = { id: "claude-local", via: "This Mac", windows: [] };
  try {
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: o.executable,
        env: { ...o.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        cwd: o.cwd,
        abortController: abort,
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true },
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        stderr: () => {},
      },
    });
    const init = await q.initializationResult();
    const account = (init as { account?: Loose }).account;
    const email = typeof account?.email === "string" ? account.email : undefined;
    const plan = typeof account?.subscriptionType === "string" ? planWords(account.subscriptionType) : undefined;
    const usage = (await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true } as never)) as unknown as Loose;
    const who = { ...base, ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
    if (!usage?.rate_limits_available || !usage.rate_limits) {
      return { ...who, problem: "Claude Code on this Mac does not report plan limits (it may sign in through a gateway or a key). Add a usage hub to see them." };
    }
    return { ...who, windows: claudeWindows(usage.rate_limits) };
  } catch {
    return { ...base, problem: abort.signal.aborted ? "Claude Code did not answer in time." : "Claude Code could not be asked for its usage." };
  } finally {
    clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
  }
}

function planWords(t: string): string {
  const s = t.toLowerCase();
  if (s.includes("max")) return "Max";
  if (s.includes("pro")) return "Pro";
  if (s.includes("team")) return "Team";
  if (s.includes("enterprise")) return "Enterprise";
  return t;
}

// ------------------------------------------------------------ Codex

interface CodexWindowRaw {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

/** Codex's rate limits as windows: the first (five hours, or a month on Free and Go) and the second (a week). */
export function codexWindows(snapshot: unknown): UsageWindow[] {
  const s = snapshot && typeof snapshot === "object" ? (snapshot as Loose) : {};
  if (typeof s.limitId === "string" && s.limitId && s.limitId !== "codex") return [];
  const monthlyPlan = s.planType === "free" || s.planType === "go";
  const out: UsageWindow[] = [];
  for (const [id, raw, fallback] of [
    ["primary", s.primary, monthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", s.secondary, WEEK_MINS],
  ] as const) {
    const w = raw as CodexWindowRaw | null | undefined;
    const used = num(w?.usedPercent);
    if (used === undefined) continue;
    const mins = num(w?.windowDurationMins) ?? fallback;
    const kind: UsageWindow["kind"] = mins >= MONTH_MINS ? "monthly" : mins >= WEEK_MINS ? "weekly" : "session";
    const resetsAt = epochSeconds(w?.resetsAt);
    out.push({ id, kind, label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly", usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}) });
  }
  const individual = record(s.individualLimit);
  const remaining = num(individual?.remainingPercent);
  if (remaining !== undefined) {
    const resetsAt = epochSeconds(individual?.resetsAt);
    out.push({ id: "individual", kind: "monthly", label: "Monthly credit limit", usedPercent: clamp(100 - remaining), ...(resetsAt ? { resetsAt } : {}) });
  }
  return out;
}

const CODEX_PLANS = new Set(["free", "go", "plus", "pro", "prolite", "team", "business", "enterprise", "edu", "education", "enterprise_cbp"]);
function codexPlan(t: unknown): string | undefined {
  if (typeof t !== "string" || !CODEX_PLANS.has(t)) return undefined;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type AccountMeters = Pick<UsageAccount, "windows" | "plan" | "credits" | "resetCredits">;

/** Account-rate-limit reply from the local Codex app-server. The general entry wins over model limits. */
export function codexAccountMeters(reply: unknown, accountPlan?: unknown): AccountMeters {
  const r = record(reply);
  const main = record(r?.rateLimits);
  const snap = record(record(r?.rateLimitsByLimitId)?.codex) ?? main;
  const plan = codexPlan(snap?.planType ?? accountPlan);
  const credits = codexCredits(snap?.credits);
  const resetCredits = codexResetCredits(r?.rateLimitResetCredits);
  return {
    windows: codexWindows(snap),
    ...(plan ? { plan } : {}),
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/** Codex's own reading on this Mac: a short-lived app-server asked who is signed in and its rate limits. */
export async function readCodexUsage(o: { executable: string; args?: string[]; env: Record<string, string | undefined> }): Promise<UsageAccount> {
  const rpc = new CodexRpc({ executable: o.executable, args: o.args ?? [], env: o.env });
  const base: UsageAccount = { id: "codex-local", via: "This Mac", windows: [] };
  try {
    rpc.start();
    await rpc.initialize(30_000);
    const acc = await rpc.request<Loose>("account/read", {}, 20_000).catch(() => undefined);
    const r = await rpc.request<unknown>("account/rateLimits/read", null, 20_000);
    const meters = codexAccountMeters(r, record(acc?.account)?.planType);
    if (meters.windows.length || meters.credits || meters.resetCredits) return { ...base, ...meters };
    return { ...base, ...meters, problem: "Codex reported no plan limits or credits." };
  } catch {
    return { ...base, problem: "Codex could not be asked for its usage." };
  } finally {
    rpc.stop();
  }
}

// ------------------------------------------------------------ a CLIProxyAPI hub

/** A hub with its key already read. The key is never logged, never put in an error or a result. */
export interface CliproxyHub {
  url: string;
  key: string;
  /** For people: the hub's host. */
  label: string;
}

interface HubAccount {
  id: string;
  auth_index: string;
  provider: string;
  email?: string;
  disabled?: boolean;
  id_token?: { chatgpt_account_id?: string; chatgpt_plan_type?: string; plan_type?: string };
}

const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";

/** The providers a hub can read, by the hub's own name for them. Others are left out. */
const HUB_PROVIDERS: Record<string, { id: string; label: string; url: string; header: (a: HubAccount) => Record<string, string>; read: (body: string, a: HubAccount) => AccountMeters }> = {
  claude: {
    id: "claude",
    label: "Claude",
    url: CLAUDE_USAGE,
    header: () => ({
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      // The usage address can refuse a request without Claude Code's user agent (T3 Code).
      "User-Agent": "claude-code/2.1.273",
    }),
    read: (body) => ({ windows: claudeWindows(JSON.parse(body)), plan: "Claude subscription" }),
  },
  codex: {
    id: "codex",
    label: "Codex",
    url: CODEX_USAGE,
    header: (a) => ({
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "OpenAI-Beta": "codex-1",
      Originator: "Codex Desktop",
      ...(a.id_token?.chatgpt_account_id ? { "Chatgpt-Account-Id": a.id_token.chatgpt_account_id } : {}),
    }),
    read: (body, a) => {
      const u = JSON.parse(body) as Loose;
      const rl = u.rate_limit as Loose | null | undefined;
      const win = (w: unknown) => {
        const x = w as Loose | null | undefined;
        if (!x || num(x.used_percent) === undefined) return null;
        const secs = num(x.limit_window_seconds);
        return { usedPercent: x.used_percent, resetsAt: x.reset_at ?? null, ...(secs !== undefined ? { windowDurationMins: secs / 60 } : {}) };
      };
      const planType = (u.plan_type as string | undefined) ?? a.id_token?.plan_type ?? a.id_token?.chatgpt_plan_type;
      const plan = codexPlan(planType);
      const credits = codexCredits(u.credits);
      const individual = record(u.individual_limit);
      return {
        windows: codexWindows({
          planType, primary: win(rl?.primary_window), secondary: win(rl?.secondary_window),
          individualLimit: { remainingPercent: individual?.remaining_percent, resetsAt: individual?.resets_at },
        }),
        ...(plan ? { plan } : {}),
        ...(credits ? { credits } : {}),
      };
    },
  },
};

/** The management address for one path under the hub's base. */
export function hubAddress(base: string, path: string): string {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/(\/management\.html)?\/?$/i, "/");
  return new URL(`v0/management/${path}`, u).toString();
}

/** Why a hub request failed, in a plain sentence: only the kind of failure or the HTTP status, never what the hub sent. */
function hubFailure(err: unknown, status?: number): string {
  if (status !== undefined) return status === 401 || status === 403 ? "The hub refused the key." : `The hub answered with HTTP ${status}.`;
  if (err instanceof Error && err.name === "AbortError") return "The hub did not answer within 15 seconds.";
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "The hub's certificate is not trusted.";
  if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) return `The hub could not be reached (${code}).`;
  return "The hub could not be reached.";
}

async function hubCall(hub: CliproxyHub, path: string, fetcher: Fetcher, body?: unknown): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let status: number | undefined;
  try {
    const res = await fetcher(hubAddress(hub.url, path), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${hub.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
    });
    if (!res.ok) {
      status = res.status;
      throw new Error("status");
    }
    return JSON.parse(await res.text()) as unknown;
  } catch (err) {
    throw new Error(hubFailure(err, status));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every account of a hub, grouped by provider, with its windows. Throws one plain sentence when
 * the hub cannot be read at all; an account that cannot be read carries its own `problem`.
 */
export async function readHub(hub: CliproxyHub, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<UsageProvider[]> {
  const listed = (await hubCall(hub, "auth-files", fetcher)) as { files?: unknown };
  if (!listed || !Array.isArray(listed.files)) throw new Error("The hub did not list its accounts.");
  const accounts = (listed.files as Loose[]).filter((f): f is Loose & HubAccount => typeof f?.id === "string" && typeof f.auth_index === "string" && typeof f.provider === "string" && f.disabled !== true);
  const byProvider = new Map<string, UsageProvider>();
  const read = async (a: HubAccount): Promise<{ id: string; label: string; account: UsageAccount } | undefined> => {
    if (!Object.hasOwn(HUB_PROVIDERS, a.provider)) return;
    const def = HUB_PROVIDERS[a.provider]!;
    const account: UsageAccount = { id: a.id, ...(a.email ? { email: a.email } : {}), via: hub.label, windows: [] };
    const header = def.header(a);
    const call = async (url: string): Promise<string> => {
      const r = (await hubCall(hub, "api-call", fetcher, { auth_index: a.auth_index, method: "GET", url, header })) as Loose;
      const code = num(r?.status_code);
      if (code === undefined || typeof r.body !== "string") throw new Error("The hub's answer was not understood.");
      if (code < 200 || code >= 300) throw new Error(`The provider refused the hub's request (HTTP ${code}).`);
      return r.body;
    };
    try {
      Object.assign(account, def.read(await call(def.url), a));
      if (def.id === "codex") {
        // Some hubs cannot read reset credits. Still keep the plan windows and balance.
        const resetCredits = await call(CODEX_RESET_CREDITS).then((body) => hubResetCredits(JSON.parse(body))).catch(() => undefined);
        if (resetCredits) account.resetCredits = resetCredits;
      }
    } catch (err) {
      account.problem = err instanceof Error && /^The /.test(err.message) ? err.message : "The hub could not read this account's usage.";
    }
    return { id: def.id, label: def.label, account };
  };
  // Four at a time, as T3 Code does. Keep the listed order even when replies arrive out of order.
  for (let i = 0; i < accounts.length; i += 4) {
    for (const entry of await Promise.all(accounts.slice(i, i + 4).map(read))) {
      if (!entry) continue;
      const p = byProvider.get(entry.id) ?? { id: entry.id, label: entry.label, accounts: [] };
      p.accounts.push(entry.account);
      byProvider.set(entry.id, p);
    }
  }
  return ["claude", "codex"].map((id) => byProvider.get(id)).filter((p): p is UsageProvider => !!p);
}
