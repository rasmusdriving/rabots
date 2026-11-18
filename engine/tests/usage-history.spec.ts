import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { aggregate } from "../core/usage-history/aggregate.js";
import { priceUsage } from "../core/usage-history/pricing.js";
import { DAY, scanHistory, type Index } from "../core/usage-history/scan.js";
import type { UsageRecord } from "../core/usage-history/types.js";

const close = (got: number, expected: number) => assert.ok(Math.abs(got - expected) < 1e-9, `${got} ≠ ${expected}`);
const iso = (t: number) => new Date(t).toISOString();
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const now = Date.now();
const checkedAt = iso(now);
const blank: Index = { files: {}, incomplete: [] };

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pobots-usage-spec-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claude = join(home, "projects");
  const codex = join(home, "sessions");
  const archive = join(home, "archived_sessions");
  await Promise.all([claude, codex, archive].map((dir) => mkdir(dir)));
  return {
    claude, codex, archive,
    scan: (previous = blank) => scanHistory([{ provider: "claude", dir: claude }, { provider: "codex", dir: codex }, { provider: "codex", dir: archive }], previous, now),
  };
}

function reply(id: string, at = now - 3000, output = 10, model = "claude-opus-5-5") {
  return {
    type: "assistant", timestamp: iso(at), sessionId: "example", requestId: id,
    message: { id, model, content: "The conversation stays private.", usage: {
      input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: output,
      cache_creation: { ephemeral_1h_input_tokens: 5 },
    } },
  };
}

test("Claude usage merges copies and streaming updates, counts cache writes once, and groups calendar days and rolling 24 hours", async (t) => {
  const { claude, scan } = await fixture(t);
  // The older request is still in the calendar range but falls outside the exact rolling 24 hours.
  const p = join(claude, "old.jsonl");
  await writeFile(p, jsonl(reply("request-a"), reply("request-b", now - DAY - 3000), reply("old", now - 50 * DAY)));
  await writeFile(join(claude, "copy.jsonl"), jsonl(reply("request-a", now - 3000, 40), reply("fake", now - 1500, 300, "<synthetic>")));
  const indexed = await scan();
  const ranges = aggregate(indexed, now, "Europe/Stockholm", checkedAt);
  const [c] = ranges["24h"].providers;
  assert.deepEqual(c!.totals.tokenType, { input: 100, cacheRead: 1000, cacheWrite: 20, output: 40 });
  close(c!.totals.usd, (100 * 4 + 1000 * .2 + 15 * 5 + 5 * 8 + 40 * 20) / 1e6);
  assert.equal(c!.totals.sessions, 1);
  assert.equal(c!.trend.reduce((n, d) => n + d.tokens, 0), 1160);
  assert.equal(ranges["7d"].providers[0]!.totals.tokens, 2290);
  assert.equal(ranges["30d"].providers[0]!.totals.tokens, 2290);
  assert.equal(ranges["90d"].providers[0]!.totals.tokens, 3420);
  assert.equal(ranges["90d"].points.length, 90);
  assert.doesNotMatch(JSON.stringify(indexed), /conversation stays private|old\.jsonl|sessionId/);
});

test("the scan preserves a partial tail, reuses unchanged entries, detects a rewritten prefix, and follows an archive move", async (t) => {
  const { claude, archive, codex, scan } = await fixture(t);
  const path = join(claude, "example.jsonl");
  const old = jsonl(reply("a"));
  const next = jsonl(reply("b"));
  await writeFile(path, old + next.slice(0, 17));
  let idx = await scan();
  assert.equal(Object.values(idx.files)[0]!.records.length, 1);
  assert.equal(Object.values(idx.files)[0]!.offset, Buffer.byteLength(old));
  const unchanged = await scan(idx);
  assert.equal(Object.values(unchanged.files)[0], Object.values(idx.files)[0]);
  await appendFile(path, next.slice(17, -1));
  idx = await scan(idx);
  assert.equal(Object.values(idx.files)[0]!.tail?.length, 1);
  assert.equal(aggregate(idx, now, "UTC", checkedAt)["7d"].providers[0]!.totals.tokens, 2260);
  await appendFile(path, "\n");
  idx = await scan(idx);
  assert.equal(Object.values(idx.files)[0]!.records.length, 2);
  await writeFile(path, jsonl(reply("z", now - 1000, 500)) + "{\n".repeat(1000));
  idx = await scan(idx);
  assert.deepEqual(Object.values(idx.files)[0]!.records.map((r) => r.output), [500]);
  const file = join(codex, "rollout.jsonl");
  await writeFile(file, jsonl({ type: "turn_context", payload: { model: "gpt-6-luna" } }, codexLedger("a", now - 1000)));
  idx = await scan(idx);
  await rename(file, join(archive, "rollout.jsonl"));
  idx = await scan(idx);
  const x = aggregate(idx, now, "UTC", checkedAt)["7d"].providers[1]!;
  assert.equal(x.totals.sessions, 1);
  assert.equal(x.totals.tokens, 115);
});

test("Codex reads a compressed rollout, dedupes it against its plain copy, and reuses the archive on the next scan", async (t) => {
  const { codex, archive, scan } = await fixture(t);
  const source = jsonl(
    { type: "session_meta", payload: { id: "same-session" } },
    { type: "turn_context", payload: { model: "gpt-6-luna" } },
    codexLedger("first", now - 5000),
  );
  const zipped = join(archive, "rollout.jsonl.zst");
  await writeFile(zipped, zstdCompressSync(source));
  await writeFile(join(codex, "rollout.jsonl"), source);
  const first = await scan();
  assert.equal(Object.values(first.files).filter((f) => f.records.length === 1).length, 2);
  const x = aggregate(first, now, "UTC", checkedAt)["24h"].providers[1]!;
  assert.equal(x.totals.sessions, 1);
  assert.equal(x.totals.tokens, 115);
  const second = await scan(first);
  assert.deepEqual(second, first);
});

function codexLedger(id: string, timestamp: number) {
  return { type: "token_usage_record", timestamp: iso(timestamp), payload: {
    response_id: id, usage: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 5, output_tokens: 15, reasoning_output_tokens: 10 },
  } };
}

test("Codex accepts ledgers and reconciles older context counters without counting cached or reasoning tokens twice", async (t) => {
  const { codex, archive, scan } = await fixture(t);
  const at = now - 15_000;
  const event = (last: number, total: number, offset: number) => ({
    type: "event_msg", timestamp: iso(at + offset),
    payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: last, output_tokens: last / 10 },
      total_token_usage: { input_tokens: total, output_tokens: total / 10 },
    } },
  });
  const rows = jsonl(
    { type: "session_meta", payload: { id: "codex-example" } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } },
    { type: "turn_context", payload: { model: "gpt-6-luna" } },
    codexLedger("request", at),
    event(100, 100, 1000), // Totals for the ledger request, already counted.
    { type: "turn_context", payload: { model: "gpt-6-astra", service_tier: "ultrafast" } },
    event(200, 300, 3000),
    event(200, 300, 3100), // A re-emitted snapshot.
    event(50, 50, 8000), // New process after resume; totals restarted.
  );
  await writeFile(join(codex, "rollout.jsonl"), rows);
  await writeFile(join(archive, "rollout.jsonl"), rows);
  const x = aggregate(await scan(), now, "UTC", checkedAt)["30d"].providers[1]!;
  assert.deepEqual(x.totals.tokenType, { input: 315, cacheRead: 30, cacheWrite: 5, output: 40 });
  assert.equal(x.totals.tokens, 390);
  assert.equal(x.totals.sessions, 1);
  assert.equal(x.models.length, 2);
  assert.ok(x.totals.speedCost.fast > 0 && x.totals.speedCost.ultrafast > 0);
});

test("pricing handles long-context, fast, ultrafast and unpriced usage", () => {
  const r: UsageRecord = { at: now, model: "gpt-6-astra", speed: "ultrafast", input: 300_000,
    cacheRead: 100_000, cacheWrite: 0, cacheWriteHour: 0, output: 10_000, key: "", session: "example" };
  const estimated = priceUsage(r);
  assert.equal(estimated.tokens, 410_000);
  close(estimated.usd, 41.7);
  close(estimated.premium, 41.7 - 6.95);
  close(estimated.cacheSavings, 10.8);
  const unpriced = priceUsage({ ...r, model: "unknown-example" });
  assert.equal(unpriced.usd, 0);
  assert.equal(unpriced.unpricedTokens, 410_000);
  const other = priceUsage({ ...r, model: "unknown-example", reported: 2 });
  assert.equal(other.costType.other, 2);
});
