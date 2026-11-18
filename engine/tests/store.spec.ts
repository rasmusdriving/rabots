import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { ApprovalCard, BotItem, UserItem } from "../../shared/protocol.js";
import { MIGRATIONS, Store } from "../store.js";
import { tempDir } from "./helpers.js";

const at = () => new Date().toISOString();

function user(text: string, queued = false) {
  return { kind: "user" as const, at: at(), text, from: { type: "you" as const }, queued };
}

describe("store", () => {
  test("migrates once and survives a reopen", () => {
    const path = join(tempDir(), "pobots.db");
    const a = new Store(path);
    assert.equal(a.schemaVersion, 11);
    const t = a.createThread("kaja");
    a.addItem(t.id, user("hello"));
    a.close();
    const b = new Store(path);
    assert.equal(b.schemaVersion, 11);
    assert.equal(b.mainThread("kaja")?.id, t.id);
    assert.equal(b.readThread(t.id).items.length, 1);
    b.close();
  });

  test("a database from step 1 is moved to the new version without losing anything", () => {
    const path = join(tempDir(), "pobots.db");
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec("PRAGMA user_version = 1");
    old.prepare("INSERT INTO threads (id, bot_id, kind, created_at, session_id, next_seq) VALUES ('t1', 'po', 'main', '2026-11-10T00:00:00.000Z', 's1', 2)").run();
    old.prepare("INSERT INTO items (id, thread_id, seq, kind, open, data) VALUES ('i1', 't1', 1, 'user', 0, ?)").run(
      JSON.stringify({ id: "i1", threadId: "t1", seq: 1, kind: "user", at: "2026-11-10T00:00:00.000Z", text: "hello", from: { type: "you" }, queued: false }),
    );
    old.close();
    const s = new Store(path);
    assert.equal(s.schemaVersion, 11);
    assert.equal(s.mainThread("po")?.sessionId, "s1");
    assert.deepEqual(s.readThread("t1").items.map((i) => i.id), ["i1"]);
    s.retireThreads("po");
    assert.equal(s.mainThread("po"), undefined);
    assert.equal(s.readThread("t1").items.length, 1);
    s.close();
  });

  test("a database from step 2b gets channels, and webhooks keep their addresses", () => {
    const path = join(tempDir(), "pobots.db");
    const old = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
    old.exec("PRAGMA user_version = 3");
    old
      .prepare(
        "INSERT INTO triggers (id, bot_id, kind, name, prompt, run_in, enabled, schedule, secret, next_at, created_by, created_at) VALUES ('w1', 'po', 'webhook', 'Hook', 'Go.', 'main', 1, NULL, 'sekret-0123', NULL, 'you', '2026-11-11T00:00:00.000Z')",
      )
      .run();
    old.prepare("INSERT INTO threads (id, bot_id, kind, created_at, session_id, next_seq) VALUES ('t1', 'po', 'main', '2026-11-10T00:00:00.000Z', 's1', 1)").run();
    old.close();
    const s = new Store(path);
    assert.equal(s.schemaVersion, 11);
    assert.equal(s.getTrigger("w1")?.secret, "sekret-0123");
    assert.equal(s.mainThread("po")?.sessionId, "s1");
    assert.deepEqual(s.listChannels(), []);
    s.addChannel({ id: "c1", kind: "teams", name: "Ops - Internal", enabled: true, allowedSenders: ["ada@example.com"], routes: [{ tag: "Po", botId: "po" }], contextCount: 5, secret: "s", mayPost: [], createdAt: at() });
    assert.equal(s.getChannel("c1")?.routes[0]?.tag, "Po");
    const msg = (id: string, status: "refused" | "delivered") => ({ id, channelId: "c1", at: at(), sender: "Ada Example", status });
    s.addChannelMessage({ rid: "r1", message: msg("m1", "refused") });
    s.addChannelMessage({ rid: "r2", message: msg("m2", "delivered"), itemId: "i2", outsideThreadId: "th" });
    s.addChannelMessage({ rid: "r3", message: msg("m3", "delivered") });
    assert.deepEqual(s.listChannelMessages("c1", undefined, 2)?.messages.map((m) => m.id), ["m3", "m2"]);
    assert.deepEqual(s.listChannelMessages("c1", "m2", 5)?.messages.map((m) => m.id), ["m1"]);
    assert.equal(s.listChannelMessages("c1", "nope", 5), undefined);
    assert.equal(s.channelMessageByItem("i2")?.outsideThreadId, "th");
    assert.deepEqual(s.openChannelMessages().map((r) => r.rid), ["r2", "r3"]);
    assert.equal(s.channelMessageSeen("c1", "m1", "2000-01-01T00:00:00.000Z"), true);
    assert.equal(s.channelMessageSeen("c1", "m1", "2999-01-01T00:00:00.000Z"), false);
    assert.equal(s.removeChannel("c1"), true);
    assert.equal(s.lastChannelMessage("c1")?.id, "m3", "what came in is kept after the channel is removed");
    s.close();
  });

  test("assigns increasing seqs per thread and pages backwards", () => {
    const s = new Store(join(tempDir(), "pobots.db"));
    const t1 = s.createThread("a");
    const t2 = s.createThread("b");
    for (let i = 1; i <= 7; i++) s.addItem(t1.id, user(`m${i}`));
    const other = s.addItem(t2.id, user("other"));
    assert.equal(other.seq, 1);

    const last = s.readThread(t1.id, undefined, 3);
    assert.deepEqual(last.items.map((i) => i.seq), [5, 6, 7]);
    assert.equal(last.hasMore, true);
    const page = s.readThread(t1.id, 5, 3);
    assert.deepEqual(page.items.map((i) => i.seq), [2, 3, 4]);
    assert.equal(page.hasMore, true);
    const first = s.readThread(t1.id, 2, 3);
    assert.deepEqual(first.items.map((i) => i.seq), [1]);
    assert.equal(first.hasMore, false);
    s.close();
  });

  test("updates items and tracks the ones still open", () => {
    const s = new Store(join(tempDir(), "pobots.db"));
    const t = s.createThread("a");
    const q = s.addItem(t.id, user("waiting", true)) as UserItem;
    const b = s.addItem(t.id, { kind: "bot", at: at(), botId: "a", text: "", streaming: true }) as BotItem;
    s.addItem(t.id, { kind: "notice", at: at(), text: "x", tone: "info" });
    assert.deepEqual(s.openItems().map((i) => i.id), [q.id, b.id]);
    s.updateItem({ ...b, text: "done", streaming: false });
    s.updateItem({ ...q, queued: false });
    assert.deepEqual(s.openItems(), []);
    assert.equal((s.getItem(b.id) as BotItem).text, "done");
    s.close();
  });

  test("keeps the session id per thread", () => {
    const s = new Store(join(tempDir(), "pobots.db"));
    const t = s.createThread("a");
    assert.equal(s.getThread(t.id)?.sessionId, null);
    s.setSessionId(t.id, "abc");
    assert.equal(s.getThread(t.id)?.sessionId, "abc");
    s.setSessionId(t.id, null);
    assert.equal(s.getThread(t.id)?.sessionId, null);
    s.close();
  });

  test("stores open cards oldest first", () => {
    const s = new Store(join(tempDir(), "pobots.db"));
    const card = (id: string, when: string): ApprovalCard => ({
      kind: "approval",
      id,
      botId: "a",
      threadId: "t",
      at: when,
      title: "Run this command?",
      detail: "ls",
    });
    s.addCard(card("2", "2026-01-02T00:00:00.000Z"));
    s.addCard(card("1", "2026-01-01T00:00:00.000Z"));
    assert.deepEqual(s.listCards().map((c) => c.id), ["1", "2"]);
    assert.equal(s.removeCard("1"), true);
    assert.equal(s.removeCard("1"), false);
    assert.deepEqual(s.listCards().map((c) => c.id), ["2"]);
    s.close();
  });
});
