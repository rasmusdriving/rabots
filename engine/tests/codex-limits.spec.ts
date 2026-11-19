import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { UsageAccount } from "../../shared/protocol.js";
import { usageCreditRows } from "../../shared/usage-credits.js";
import { getSettingsFresh } from "../core/pobots-tools.js";
import { codexCredits, CODEX_RESET_CREDITS, CODEX_USAGE, hubResetCredits } from "../core/usage-codex.js";
import type { Fetcher } from "../providers.js";
import { codexAccountMeters, readHub } from "../usage.js";
import type { CodexSetup } from "../codex/detect.js";
import { setup, tick } from "./fake.js";

const mac = "This Mac";
const hubAddress = "hub.example.net";
const window = { id: "primary", label: "Session", kind: "session", usedPercent: 12.5 } as const;
const expiry = 2_100_000_000;
const expiryIso = new Date(expiry * 1000).toISOString();
const localAccount = { id: "codex-local", via: mac, windows: [window], credits: { balance: 450.5 }, resetCredits: { availableCount: 2, nextExpiresAt: expiryIso } };
const wham = {
  plan_type: "pro",
  rate_limit: { primary_window: { used_percent: 12.5, limit_window_seconds: 18000 } },
  credits: { has_credits: true, unlimited: false, balance: "12.75", expires_at: expiryIso, resets_at: expiry },
};

function hubFetcher(list: ("claude" | "codex")[], resetStatus = 200, usageStatus = 200): Fetcher {
  const response = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return async (url, plan) => {
    if (url.endsWith("auth-files")) return response({ files: list.map((provider) => ({
      provider, id: `${provider}-hub`, auth_index: `index-${provider}`,
    })) });
    const call = JSON.parse(plan!.body!);
    assert.equal(call.method, "GET");
    assert.equal(call.header.Authorization, "Bearer $TOKEN$");
    if (call.url === CODEX_USAGE) return response({ status_code: usageStatus, body: JSON.stringify(wham) });
    if (call.url === CODEX_RESET_CREDITS) return response({
      status_code: resetStatus,
      body: JSON.stringify({ credits: [
        { id: "not-forwarded", reset_type: "codex_rate_limits", status: "available", expires_at: expiryIso },
        { id: "other", reset_type: "codex_rate_limits", status: "redeemed", expires_at: expiryIso },
        { id: "expired", reset_type: "codex_rate_limits", status: "available", expires_at: "2001-01-01T00:00:00Z" },
        { id: "wrong-type", reset_type: "other", status: "available", expires_at: expiryIso },
      ] }),
    });
    return response({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 10 } }) });
  };
}

async function read(t: TestContext, listed: ("claude" | "codex")[], options: { ready?: boolean; enabled?: boolean; fail?: boolean; hubUsageStatus?: number } = {}) {
  const calls: string[] = [];
  const { engine, store, events } = setup(undefined, undefined, undefined, {
    settingsHub: {
      fetcher: hubFetcher(listed, 200, options.hubUsageStatus),
      runner: async () => ({ ok: false, out: "" }),
      readCodex: async () => {
        calls.push("codex");
        if (options.fail) throw new Error("private error detail");
        return localAccount;
      },
      readClaude: async () => {
        calls.push("claude");
        return { id: "claude-local", via: mac, windows: [window] };
      },
    },
  });
  t.after(() => { engine.shutdown(); store.close(); });
  engine.codex = { executable: "/example/codex", ready: options.ready ?? true, env: {}, models: [] };
  if (options.enabled === false) engine.settingsSet({ providers: { codex: { enabled: false } } });
  engine.usageHubAdd({ url: `https://${hubAddress}`, key: "example-test-key" });
  const { usage } = await engine.usageRead({ refresh: true });
  return { engine, usage, calls, events };
}

test("a Claude-only hub keeps both sources, and get_settings reads the same meters", async (t) => {
  const { engine, usage, calls, events } = await read(t, ["claude"]);
  assert.deepEqual(calls, ["codex"]);
  assert.deepEqual(usage.providers.map((p) => [p.id, p.accounts[0]?.via]), [["claude", hubAddress], ["codex", mac]]);
  assert.deepEqual(usage.providers[1]?.accounts, [localAccount]);
  const reads = events.flatMap((e) => e.event === "usage.changed" && "usage" in e.data ? [e.data.usage] : []);
  assert.deepEqual(reads.map((u) => [u.reading, u.providers.length]), [[true, 0], [false, 2]]);
  const words = await getSettingsFresh(engine, {});
  assert.match(words, /Codex, via This Mac: Session: 88% left; Credits left: 450\.5; Reset credits left: 2, next expires/);
  assert.doesNotMatch(words, /example-test-key/);
});

test("opening Limits while Codex detection is pending shares the combined reading without a reload", async (t) => {
  let resolve!: (setup: CodexSetup) => void;
  const detection = new Promise<CodexSetup>((done) => { resolve = done; });
  const { engine, store, events } = setup(undefined, undefined, undefined, {
    checkCodex: () => detection,
    settingsHub: { fetcher: hubFetcher(["claude"]), readCodex: async () => localAccount },
  });
  t.after(() => { engine.shutdown(); store.close(); });
  engine.usageHubAdd({ url: `https://${hubAddress}`, key: "example-test-key" });
  // Let the hub finish before either the page or local detection can finish.
  await tick();
  const first = engine.usageRead({});
  assert.equal(engine.hub.usageState().reading, true);
  resolve({ executable: "/example/codex", ready: true, env: {}, models: [] });
  const { usage } = await first;
  assert.deepEqual(usage.providers.map((p) => p.id), ["claude", "codex"]);
  const reads = events.flatMap((e) => e.event === "usage.changed" && "usage" in e.data ? [e.data.usage] : []);
  assert.deepEqual(reads.map((u) => [u.reading, u.providers.map((p) => p.id)]), [[true, []], [false, ["claude", "codex"]]]);
});

test("a Codex hub account suppresses the local duplicate, including a failed hub account", async (t) => {
  const { usage, calls } = await read(t, ["claude", "codex"], { hubUsageStatus: 502 });
  assert.deepEqual(calls, []);
  assert.deepEqual(usage.providers[1]?.accounts.map((a) => [a.id, a.via]), [["codex-hub", hubAddress]]);
  assert.match(usage.providers[1]?.accounts[0]?.problem ?? "", /HTTP 502/);
});

test("a hub with Codex only falls back to local Claude", async (t) => {
  const { usage, calls } = await read(t, ["codex"]);
  assert.deepEqual(calls, ["claude"]);
  assert.deepEqual(usage.providers.map((p) => [p.id, p.accounts[0]?.via]), [["codex", hubAddress], ["claude", mac]]);
});

for (const [reason, options] of [["not ready", { ready: false }], ["switched off", { enabled: false }]] as const) {
  test(`missing Codex is not read when ${reason}`, async (t) => {
    const { usage, calls } = await read(t, ["claude"], options);
    assert.deepEqual(calls, []);
    assert.deepEqual(usage.providers.map((p) => p.id), ["claude"]);
  });
}

test("a rejected local read gets a Codex problem without hiding the hub limits", async (t) => {
  const { usage, calls } = await read(t, ["claude"], { fail: true });
  assert.deepEqual(calls, ["codex"]);
  assert.equal(usage.problem, undefined);
  assert.equal(usage.providers[0]?.accounts[0]?.windows.length, 1);
  assert.equal(usage.providers[1]?.accounts[0]?.via, mac);
  assert.equal(usage.providers[1]?.accounts[0]?.problem, "Codex could not be asked for its usage.");
  assert.doesNotMatch(JSON.stringify(usage), /private error detail/);
});

test("local app-server reply separates balance, reset credits and monthly allowance", () => {
  const rateLimits = {
    limitId: "codex", planType: "pro",
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: expiry },
    credits: { hasCredits: true, unlimited: false, balance: "450.50" },
    individualLimit: { remainingPercent: 68, resetsAt: expiry },
  };
  const result = codexAccountMeters({
    rateLimits: { ...rateLimits, credits: null },
    rateLimitsByLimitId: { codex: rateLimits, exampleModel: { credits: { balance: "999" } } },
    rateLimitResetCredits: { availableCount: 3, credits: [
      { id: "not-forwarded", status: "available", expiresAt: expiry + 3600 },
      { id: "nearest", status: "available", expiresAt: expiry },
      { id: "used", status: "redeemed", expiresAt: expiry - 3600 },
      { id: "stale", status: "available", expiresAt: 1 },
    ] },
  });
  assert.deepEqual(result, {
    plan: "Pro",
    windows: [
      { ...window, resetsAt: expiryIso },
      { id: "individual", kind: "monthly", label: "Monthly credit limit", usedPercent: 32, resetsAt: expiryIso },
    ],
    credits: { balance: 450.5, unlimited: false, hasCredits: true },
    resetCredits: { availableCount: 3, nextExpiresAt: expiryIso },
  });
  assert.deepEqual(codexAccountMeters({ rateLimits: { credits: null }, rateLimitResetCredits: { availableCount: 0, credits: [] } }),
    { windows: [], resetCredits: { availableCount: 0 } });
});

test("WHAM balance and optional reset-credit list stay independent, even on a failed credit read", async () => {
  const hub = { url: `https://${hubAddress}`, key: "example-test-key", label: hubAddress };
  const first = (await readHub(hub, hubFetcher(["codex"])))[0]!.accounts[0]!;
  assert.deepEqual(first.credits, { balance: 12.75, hasCredits: true, unlimited: false, expiresAt: expiryIso, resetsAt: expiryIso });
  assert.deepEqual(first.resetCredits, { availableCount: 1, nextExpiresAt: expiryIso });
  assert.deepEqual(first.windows, [window]);
  const failed = (await readHub(hub, hubFetcher(["codex"], 404)))[0]!.accounts[0]!;
  assert.deepEqual(failed.credits, first.credits);
  assert.deepEqual(failed.windows, first.windows);
  assert.equal(failed.resetCredits, undefined);
  assert.equal(failed.problem, undefined);
});

test("zero, unlimited and absent balance remain distinct; arbitrary strings are never returned", () => {
  const account = (credits: UsageAccount["credits"]) => ({ ...localAccount, credits, resetCredits: undefined });
  assert.equal(usageCreditRows(account(codexCredits({ balance: "0", hasCredits: false, unlimited: false })))[0]?.value, "0");
  assert.equal(usageCreditRows(account(codexCredits({ balance: null, unlimited: true })))[0]?.value, "Unlimited");
  assert.equal(usageCreditRows(account(codexCredits({ has_credits: true, balance: "private text" })))[0]?.value, "Balance not reported");
  assert.deepEqual(usageCreditRows(account(codexCredits(null))), []);
  assert.deepEqual(codexAccountMeters({ rateLimits: { planType: "unrecognized provider text" } }), { windows: [] });
  assert.equal(hubResetCredits({ credits: [{ status: "available", reset_type: "codex_rate_limits" }] }), undefined);
  assert.deepEqual(hubResetCredits({ credits: [] }), { availableCount: 0 });
});
