import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endsAt, lastsChange, lastsWords } from "../core/link-lasts.js";
import { linkHarness, pairBoxes, stepping, until } from "./link-harness.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("lifetime words and end times", () => {
  assert.equal(lastsWords("24h"), "24 hours");
  assert.equal(lastsWords(undefined), "never");
  assert.equal(lastsChange("30d", "never"), "ends after 30 days (was never)");
  assert.equal(lastsChange("never", "24h"), "lasts until removed (was 24 hours)");
  const identity = {} as never;
  assert.equal(endsAt({ name: "x", identity, lasts: "24h" }), undefined);
  assert.equal(endsAt({ name: "x", identity, lasts: "24h", confirmed: 1_000 }), 1_000 + DAY);
  assert.equal(endsAt({ name: "x", identity, lasts: "30d", confirmed: 1_000, lastsFrom: 5_000 }), 5_000 + 30 * DAY);
  assert.equal(endsAt({ name: "x", identity, lasts: "never", confirmed: 1_000 }), undefined);
});

test("a new connection lasts until removed unless chosen otherwise", async () => {
  const h = linkHarness();
  try {
    const a = h.box("Sam", "https://sam.example.com");
    const b = h.box("Kim");
    await pairBoxes(h, a, b, { b: "30d" });
    const mine = a.links.list().connections[0]!;
    assert.equal(mine.lasts, "never");
    assert.equal(mine.endsAt, undefined);
    const theirs = b.links.list().connections[0]!;
    assert.equal(theirs.lasts, "30d");
    assert.ok(Math.abs(Date.parse(theirs.endsAt!) - (h.now() + 30 * DAY)) < 10_000);
  } finally {
    h.close();
  }
});

for (const both of [false, true]) test(`when this side's time is up both copies end and the bots are told (${both ? "both public" : "one public"})`, async () => {
  const h = linkHarness();
  try {
    const a = h.box("Sam", "https://sam.example.com");
    const b = h.box("Kim", both ? "https://kim.example.com" : undefined);
    const { ca, cb } = await pairBoxes(h, a, b, { b: "24h" });
    assert.equal(b.links.list().connections[0]?.state, "connected");
    const draft = b.links.change({ action: "start", name: "Later", lasts: "24h" });
    assert.equal(b.links.list().connections.find(c => c.id === draft.id)?.endsAt, undefined);
    b.links.change({ action: "remove", id: draft.id });
    h.step(DAY);
    await stepping(h.step, until(() => b.links.list().connections[0]?.state === "ended" && a.links.list().connections[0]?.state === "ended"), 500);
    assert.ok(b.notes.includes("Connection Sam: ended after 24 hours"));
    assert.ok(b.news.some(n => n.startsWith("Connection Sam: ended after 24 hours.")));
    assert.ok(a.notes.includes("Connection Kim: ended by the other side"));
    assert.ok(a.news.some(n => n.startsWith("Connection Kim: ended by the other side.")));
    assert.equal(a.links.list().connections[0]?.endedBy, "other");
    // Ended: no messages either way, only remove works.
    await assert.rejects(() => a.links.message("Kim", "tell", "Hello"), /has ended/);
    await assert.rejects(() => b.links.message("Sam", "tell", "Hello"), /has ended/);
    assert.throws(() => b.links.change({ action: "pause", id: cb.id }), /has ended/);
    assert.throws(() => b.links.change({ action: "lasts", id: cb.id, lasts: "never" }), /has ended/);
    // An ended row goes by itself after a week.
    h.step(7 * DAY + 1_000);
    await until(() => a.links.list().connections.length === 0 && b.links.list().connections.length === 0);
    void ca;
  } finally {
    h.close();
  }
});

test("the lifetime can be changed, counts from the change and leaves a quiet line", async () => {
  const h = linkHarness();
  try {
    const a = h.box("Sam", "https://sam.example.com");
    const b = h.box("Kim");
    const { ca } = await pairBoxes(h, a, b);
    h.step(10 * DAY);
    a.links.change({ action: "lasts", id: ca.id, lasts: "30d" });
    assert.ok(a.notes.includes("Connection Kim: ends after 30 days (was never)"));
    const row = a.links.list().connections[0]!;
    assert.ok(Math.abs(Date.parse(row.endsAt!) - (h.now() + 30 * DAY)) < 1_000);
    a.links.change({ action: "lasts", id: ca.id, lasts: "never" });
    assert.ok(a.notes.includes("Connection Kim: lasts until removed (was 30 days)"));
    assert.equal(a.links.list().connections[0]?.endsAt, undefined);
    assert.throws(() => a.links.change({ action: "lasts", id: ca.id, lasts: "1y" as never }), /24h, 30d or never/);
  } finally {
    h.close();
  }
});

test("an ended connection survives a restart and a Pobots before 0.44.0 hears a plain removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pobots-link-lasts-"));
  const h = linkHarness();
  try {
    const db = join(dir, "pobots.db");
    const a = h.box("Sam", "https://sam.example.com", { db, dataDir: dir });
    const b = h.box("Kim", undefined, { old: true });
    await pairBoxes(h, a, b, { a: "24h" });
    h.step(DAY);
    await stepping(h.step, until(() => b.links.list().connections.length === 0), 500);
    assert.ok(b.notes.includes("Connection Sam: removed by the other side"));
    assert.equal(a.links.list().connections[0]?.state, "ended");
    a.stop();
    const again = h.box("Sam", "https://sam.example.com", { db, dataDir: dir });
    const row = again.links.list().connections[0]!;
    assert.equal(row.state, "ended");
    assert.equal(row.endedBy, "time");
    again.links.change({ action: "remove", id: row.id });
    assert.equal(again.links.list().connections.length, 0);
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
