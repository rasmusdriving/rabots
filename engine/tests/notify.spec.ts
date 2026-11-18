// Notifications when the page is not open (engine/notify.ts): the wait, folding, the words, who is
// looking, the switches, sending and its answers, and where the engine calls the notifier. Against a
// fake clock and a stand-in push store; the secrecy tests use the real store with a stand-in for
// fetch and open every message the way a browser would. No network, no model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApprovalCard, Card, Events, NotifyDevice, NotifyKind, NotifySend, NotifyState, NoteCard, PushMessage, QuestionCard, SystemCard } from "../../shared/protocol.js";
import { NOTIFY_PRESENCE_STALE_MS } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { Notifier, pushMessage, shortName, topicOf, words, type NotifyHost, type NotifyTimers, type PushPort } from "../notify.js";
import { b64u, deviceId, fromB64u, PushStore, type PushOutcome, type Subscription, type Urgency } from "../push.js";
import { settle, setup, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";
import { decryptAsBrowser, fakeSubscription } from "./push-browser.js";

const START = Date.parse("2026-11-13T12:00:00.000Z");
const S = 1000;
const MIN = 60 * S;

/** A clock the test moves by hand. Timers fire in order; promises are given time to run after each. */
class FakeClock implements NotifyTimers {
  t = START;
  private q: { at: number; fn: () => void; n: number }[] = [];
  private n = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const h = { at: this.t + ms, fn, n: this.n++ };
    this.q.push(h);
    return h;
  }
  clearTimeout(h: unknown): void {
    this.q = this.q.filter((x) => x !== h);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.n - b.n);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
  get waiting(): number {
    return this.q.length;
  }
}

/** A push store in memory: devices, and every message handed to it, opened. */
class StandInPush implements PushPort {
  devices: NotifyDevice[] = [];
  delivered: { id: string; message: PushMessage; opts: { ttl: number; urgency: Urgency; topic: string } }[] = [];
  /** What the push service answers, per device, one answer per call (the last one repeats). */
  answers = new Map<string, PushOutcome[]>();
  add(id: string, label = `Device ${id}`, service: NotifyDevice["service"] = "Google"): void {
    this.devices.push({ id, label, service, addedAt: new Date(START).toISOString() });
  }
  publicKey(): string {
    return "BStandInPublicKey";
  }
  list(): NotifyDevice[] {
    return this.devices.map((d) => ({ ...d }));
  }
  has(id: string): boolean {
    return this.devices.some((d) => d.id === id);
  }
  keep(sub: Subscription, label: string | undefined, o: { mayAdd: boolean; replaces?: string; at: string }): { id: string; added: boolean } {
    const id = deviceId(sub.endpoint);
    if (this.has(id)) return { id, added: false };
    if (!o.mayAdd) throw new EngineError("not_found", "Pobots does not know this device.");
    this.devices.push({ id, label: label ?? "x", service: "Google", addedAt: o.at });
    return { id, added: true };
  }
  forget(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    return n !== this.devices.length;
  }
  markGone(id: string, at: string): void {
    const d = this.devices.find((x) => x.id === id);
    if (d) d.goneAt = at;
  }
  record(id: string, last: NotifySend): void {
    const d = this.devices.find((x) => x.id === id);
    if (d) d.last = last;
  }
  describe(id: string): string {
    return `Device ${id}`;
  }
  async deliver(id: string, payload: string, opts: { ttl: number; urgency: Urgency; topic: string }): Promise<PushOutcome> {
    this.delivered.push({ id, message: JSON.parse(payload) as PushMessage, opts });
    const list = this.answers.get(id);
    if (list && list.length > 1) return list.shift()!;
    return list?.[0] ?? { kind: "sent", status: 201 };
  }
  sentTo(id: string): PushMessage[] {
    return this.delivered.filter((d) => d.id === id).map((d) => d.message);
  }
}

class StandInHost implements NotifyHost {
  names = new Map<string, string>([["po", "Po"], ["kaja", "Kaja"]]);
  cards: Card[] = [];
  resting = new Set<string>(["po", "kaja"]);
  states: NotifyState[] = [];
  saved: Record<NotifyKind, boolean>[] = [];
  failSave = false;
  botName(botId: string): string | undefined {
    return this.names.get(botId);
  }
  openCards(): Card[] {
    return [...this.cards];
  }
  atRest(botId: string): boolean {
    return this.resting.has(botId);
  }
  changed(state: NotifyState): void {
    this.states.push(state);
  }
  saveKinds(kinds: Record<NotifyKind, boolean>): void {
    if (this.failSave) throw new Error("The settings file could not be written, so nothing was saved.");
    this.saved.push({ ...kinds });
  }
}

let cardNo = 0;
const at = () => new Date(START).toISOString();
function question(botId = "po", title = "Which day suits the review?", text = "Secret context about the review."): QuestionCard {
  return { kind: "question", id: `q${++cardNo}`, botId, threadId: "t", at: at(), title, text, choices: [], allowText: true };
}
function approval(botId = "po", expiresAt?: string): ApprovalCard {
  return { kind: "approval", id: `a${++cardNo}`, botId, threadId: "t", at: at(), title: "Run rm -rf build", tool: "Bash", detail: "rm -rf build", ...(expiresAt ? { expiresAt } : {}) } as unknown as ApprovalCard;
}
function note(botId = "po", title = "Report sent to the customer", text = "Secret note text."): NoteCard {
  return { kind: "note", id: `n${++cardNo}`, botId, threadId: "t", at: at(), title, text };
}
function system(title = "No backup for two days"): SystemCard {
  return { kind: "system", id: `s${++cardNo}`, at: at(), topic: "backup", title, text: "Secret system text." };
}

function world(o: { kinds?: Partial<Record<NotifyKind, boolean>>; prefix?: string; devices?: string[] } = {}) {
  const clock = new FakeClock();
  const push = new StandInPush();
  for (const id of o.devices ?? ["laptop", "phone"]) push.add(id);
  const host = new StandInHost();
  const n = new Notifier({ push, host, kinds: { needs: true, note: true, finished: true, ...o.kinds }, titlePrefix: o.prefix ?? "", timers: clock });
  /** A card goes up, as the engine's emit does it. */
  const up = (card: Card) => {
    host.cards.push(card);
    n.cardAdded(card);
    return card;
  };
  const down = (card: Card) => {
    host.cards = host.cards.filter((c) => c.id !== card.id);
    n.cardRemoved(card.id);
  };
  return { clock, push, host, n, up, down };
}

describe("notifications: the wait and the second look", () => {
  test("a question gives one push after 5 seconds, to every device, with the words and nothing of the card", async () => {
    const { clock, push, up } = world();
    up(question());
    await clock.advance(4.9 * S);
    assert.equal(push.delivered.length, 0, "nothing before 5 seconds");
    await clock.advance(0.1 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["laptop", "phone"]);
    const m = push.delivered[0]!.message;
    assert.deepEqual(m, { v: 1, kind: "needs", title: "Po needs your answer", body: "Open Pobots to answer.", tag: "pobots-po-needs", url: "/?bot=po&open=needs", botId: "po" });
    const raw = JSON.stringify(push.delivered);
    for (const secret of ["Which day", "review", "Secret"]) assert.ok(!raw.includes(secret), `no card text (${secret}) in a push`);
    assert.deepEqual(push.delivered[0]!.opts, { ttl: 12 * 3600, urgency: "high", topic: topicOf("pobots-po-needs") });
    assert.ok(push.delivered[0]!.opts.topic.length <= 32 && /^[\w-]+$/.test(push.delivered[0]!.opts.topic));
    assert.equal(push.list()[0]!.last?.result, "sent");
    assert.equal(push.list()[0]!.last?.kind, "needs");
    await clock.advance(10 * MIN);
    assert.equal(push.delivered.length, 2, "nothing more when nothing more came");
  });

  test("a card answered within the wait gives none", async () => {
    const { clock, push, up, down } = world();
    const c = up(question());
    await clock.advance(3 * S);
    down(c);
    await clock.advance(10 * MIN);
    assert.equal(push.delivered.length, 0);
  });

  test("three cards at once give one push with the count; nothing more after 2 minutes", async () => {
    const { clock, push, up } = world({ devices: ["laptop"] });
    up(question());
    up(question());
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.sentTo("laptop").map((m) => [m.title, m.body]), [["Po needs your answer", "3 things wait for you."]]);
    await clock.advance(5 * MIN);
    assert.equal(push.delivered.length, 1);
  });

  test("cards that come after a push fold into one more push at the end of 2 minutes, with the count, only if still open", async () => {
    const { clock, push, up, down } = world({ devices: ["laptop"] });
    up(question());
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 1);
    await clock.advance(10 * S);
    up(question());
    await clock.advance(20 * S);
    up(question());
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 1, "nothing during the 2 minutes");
    await clock.advance(MIN);
    assert.deepEqual(push.sentTo("laptop").map((m) => m.body), ["Open Pobots to answer.", "3 things wait for you."]);
    // Again: one more comes, and is answered before the window ends: nothing.
    const late = up(question());
    await clock.advance(30 * S);
    down(late);
    await clock.advance(2 * MIN);
    assert.equal(push.delivered.length, 2);
    // A bot calling notify_human in a loop buzzes at most once every 2 minutes.
    const loop = world({ devices: ["laptop"] });
    for (let i = 0; i < 60; i++) {
      loop.up(note());
      await loop.clock.advance(5 * S);
    }
    await loop.clock.advance(2 * MIN);
    assert.ok(loop.push.delivered.length <= 4, `${loop.push.delivered.length} pushes in 7 minutes`);
    assert.match(loop.push.delivered.at(-1)!.message.body, /^\d+ notes wait for you\.$/);
  });

  test("each bot and each kind waits and folds on its own", async () => {
    const { clock, push, up } = world({ devices: ["laptop"] });
    up(question("po"));
    up(note("po"));
    up(question("kaja"));
    await clock.advance(5 * S);
    assert.deepEqual(push.sentTo("laptop").map((m) => m.tag).sort(), ["pobots-kaja-needs", "pobots-po-needs", "pobots-po-note"]);
  });

  test("a note, and a note from Pobots itself", async () => {
    const { clock, push, up } = world({ devices: ["laptop"] });
    up(note());
    up(system());
    await clock.advance(5 * S);
    const byTag = new Map(push.sentTo("laptop").map((m) => [m.tag, m]));
    assert.deepEqual(byTag.get("pobots-po-note"), { v: 1, kind: "note", title: "Po sent you a note", body: "Open Pobots to read it.", tag: "pobots-po-note", url: "/?bot=po&open=needs", botId: "po" });
    assert.deepEqual(byTag.get("pobots-system-note"), { v: 1, kind: "note", title: "Pobots has a note for you", body: "Open Pobots to read it.", tag: "pobots-system-note", url: "/?open=needs" });
    const opts = push.delivered.find((d) => d.message.tag === "pobots-po-note")!.opts;
    assert.equal(opts.ttl, 12 * 3600);
    assert.equal(opts.urgency, "normal");
    assert.ok(!JSON.stringify(push.delivered).includes("Secret"));
    assert.ok(!JSON.stringify(push.delivered).includes("backup"));
  });

  test("an approval's notification is never kept past its expiry", async () => {
    const { clock, push, up } = world({ devices: ["laptop"] });
    up(approval("po", new Date(START + 30 * MIN).toISOString()));
    await clock.advance(5 * S);
    assert.equal(push.delivered[0]!.opts.ttl, 30 * 60 - 5);
    const two = world({ devices: ["laptop"] });
    two.up(approval("po", new Date(START + 30 * MIN).toISOString()));
    two.up(approval("po"));
    await two.clock.advance(5 * S);
    assert.equal(two.push.delivered[0]!.opts.ttl, 12 * 3600, "one that does not expire keeps the 12 hours");
  });

  test("an approval with 10 seconds left: the time to live is those seconds, no minimum; with nothing left, nothing is sent", async () => {
    const { clock, push, up } = world({ devices: ["laptop"] });
    up(approval("po", new Date(START + 15 * S).toISOString()));
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 1);
    assert.equal(push.delivered[0]!.opts.ttl, 10, "never a minimum above what is left");
    const late = world({ devices: ["laptop"] });
    late.up(approval("po", new Date(START + 4 * S).toISOString()));
    await late.clock.advance(MIN);
    assert.equal(late.push.delivered.length, 0, "an approval that ended during the wait sends nothing");
    const part = world({ devices: ["laptop"] });
    part.up(approval("po", new Date(START + 5 * S + 500).toISOString()));
    await part.clock.advance(MIN);
    assert.equal(part.push.delivered.length, 0, "less than a second left is nothing left");
  });

  test("a retired bot's card sends nothing", async () => {
    const { clock, push, host, up } = world();
    up(question());
    host.names.delete("po");
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 0);
  });
});

describe("notifications: finished", () => {
  test("only for a turn the person started, after 15 seconds, and only while the bot is still at rest", async () => {
    const { clock, push, host, n } = world({ devices: ["laptop"] });
    for (const by of ["bot", "trigger", "channel", "app", undefined]) n.cameToRest("po", "finished", by);
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0, "not schedules, webhooks, other bots, Teams or the app's own turns");

    n.cameToRest("po", "finished", "you");
    await clock.advance(14.9 * S);
    assert.equal(push.delivered.length, 0);
    await clock.advance(0.1 * S);
    assert.deepEqual(push.sentTo("laptop"), [{ v: 1, kind: "finished", title: "Po finished", body: "Open Pobots to read the answer.", tag: "pobots-po-finished", url: "/?bot=po&open=chat", botId: "po" }]);
    assert.deepEqual(push.delivered[0]!.opts, { ttl: 3600, urgency: "normal", topic: topicOf("pobots-po-finished") });

    // A queued message started at once: the bot is not at rest when the wait ends.
    n.cameToRest("kaja", "finished", "you");
    host.resting.delete("kaja");
    await clock.advance(MIN);
    assert.equal(push.sentTo("laptop").filter((m) => m.botId === "kaja").length, 0);
  });

  test("a turn that stopped on an error says so in other words", async () => {
    const { clock, push, n } = world({ devices: ["laptop"] });
    n.cameToRest("po", "failed", "you");
    await clock.advance(15 * S);
    assert.deepEqual([push.delivered[0]!.message.title, push.delivered[0]!.message.body], ["Po stopped", "It ran into a problem. Open Pobots to see what happened."]);
  });

  test("off by default in config.json: the switch decides", async () => {
    const { clock, push, n } = world({ kinds: { finished: false }, devices: ["laptop"] });
    n.cameToRest("po", "finished", "you");
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0);
  });
});

describe("notifications: the switches", () => {
  test("a kind switched off sends nothing, also when switched off during the wait; saved through the host; the state says it", async () => {
    const { clock, push, host, n, up } = world({ devices: ["laptop"] });
    n.setKinds({ note: false });
    assert.deepEqual(host.saved.at(-1), { needs: true, note: false, finished: true });
    assert.equal(host.states.at(-1)!.kinds.note, false);
    up(note());
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0);
    up(question());
    await clock.advance(2 * S);
    const r = n.setKinds({ needs: false });
    assert.deepEqual(r.notify.kinds, { needs: false, note: false, finished: true });
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0, "switched off during the wait");
    host.failSave = true;
    assert.throws(() => n.setKinds({ needs: true }), (e: unknown) => e instanceof EngineError && e.code === "internal" && /nothing was saved/.test(e.message));
    assert.equal(n.state().kinds.needs, false, "not changed when it could not be saved");
  });
});

describe("notifications: who is looking", () => {
  test("rule 1: the device whose own window is visible and in front is skipped; the others get it", async () => {
    const { clock, push, n, up } = world();
    n.presence("conn-laptop", { deviceId: "laptop", visible: true, focused: true, idleMs: null });
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["phone"]);
  });

  test("a window that is visible but not in front, or hidden, does not stop anything", async () => {
    const { clock, push, n, up } = world();
    n.presence("a", { deviceId: "laptop", visible: true, focused: false, idleMs: 0 });
    n.presence("b", { deviceId: "phone", visible: false, focused: false, idleMs: null });
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["laptop", "phone"]);
  });

  test("rule 2: while any window is in front and was used within 2 minutes, no device gets one", async () => {
    const { clock, push, n, up } = world();
    n.presence("desktop", { visible: true, focused: true, idleMs: 0 });
    up(question());
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 0, "the phone stays quiet while he works at the laptop");
    // Still in front, but not used for 2 minutes: the laptop window has no device, so every device gets it.
    await clock.advance(2 * MIN);
    n.presence("desktop", { visible: true, focused: true, idleMs: 2 * MIN + 5 * S });
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["laptop", "phone"]);
  });

  test("the two quiet minutes count from the last real use, not from a heartbeat: use just after a heartbeat, then heartbeats only", async () => {
    const { clock, push, n, up } = world();
    // The laptop's window, in front and seen all along; he uses it one second after a heartbeat.
    n.presence("laptop-window", { deviceId: "laptop", visible: true, focused: true, idleMs: null });
    await clock.advance(1 * S);
    const used = clock.now();
    n.presence("laptop-window", { deviceId: "laptop", visible: true, focused: true, idleMs: 0 });
    // From now on only heartbeats, every minute, each saying how long ago he last used it.
    for (let i = 0; i < 2; i++) {
      await clock.advance(MIN);
      n.presence("laptop-window", { deviceId: "laptop", visible: true, focused: true, idleMs: clock.now() - used });
    }
    // A card 2 minutes and 5 seconds after his last key or click: the phone gets it, the laptop (in front) not.
    await clock.advance(used + 2 * MIN + 5 * S - clock.now());
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["phone"], "a heartbeat from a window nobody touches does not make the quiet longer");

    // Within the two minutes the phone stays quiet, also when the heartbeat arrives late.
    const b = world();
    b.n.presence("w", { deviceId: "laptop", visible: true, focused: true, idleMs: 0 });
    await b.clock.advance(MIN);
    b.n.presence("w", { deviceId: "laptop", visible: true, focused: true, idleMs: MIN });
    b.up(question());
    await b.clock.advance(5 * S);
    assert.equal(b.push.delivered.length, 0, "used 65 seconds ago: nobody gets one");
    // A window that says its last use was in the future is read as used now, never later.
    const c = world();
    c.n.presence("w", { visible: true, focused: true, idleMs: -10 * MIN });
    await c.clock.advance(2 * MIN + 1 * S);
    c.n.presence("w", { visible: true, focused: true, idleMs: null });
    c.up(question());
    await c.clock.advance(5 * S);
    assert.deepEqual(c.push.delivered.map((d) => d.id), ["laptop", "phone"]);
  });

  test("a window seen and in front but not used for more than two minutes silences only its own device", async () => {
    const { clock, push, n, up } = world();
    n.presence("w", { deviceId: "laptop", visible: true, focused: true, idleMs: 2 * MIN + 1 * S });
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["phone"]);
  });

  test("a window silent for 150 seconds counts as gone; a closed connection at once", async () => {
    const { clock, push, n, up } = world();
    n.presence("x", { deviceId: "laptop", visible: true, focused: true, idleMs: 0 });
    await clock.advance(NOTIFY_PRESENCE_STALE_MS);
    up(question());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.map((d) => d.id), ["laptop", "phone"]);

    const b = world();
    b.n.presence("y", { deviceId: "laptop", visible: true, focused: true, idleMs: null });
    b.n.dropPresence("y");
    b.up(question());
    await b.clock.advance(5 * S);
    assert.deepEqual(b.push.delivered.map((d) => d.id), ["laptop", "phone"]);
  });

  test("looked at when the wait ends, not when the card came; when everyone is skipped the next card starts afresh", async () => {
    const { clock, push, n, up } = world({ devices: ["laptop"] });
    up(question());
    await clock.advance(3 * S);
    n.presence("x", { deviceId: "laptop", visible: true, focused: true, idleMs: 0 });
    await clock.advance(2 * S);
    assert.equal(push.delivered.length, 0);
    n.dropPresence("x");
    up(question());
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 1, "no 2-minute fold after a skip");
    assert.equal(push.delivered[0]!.message.body, "2 things wait for you.");
  });
});

describe("notifications: sending and the answers", () => {
  test("404 and 410 mark the device gone; the others still get it; a gone device gets nothing more", async () => {
    const { clock, push, host, up } = world({ devices: ["laptop", "phone", "tablet"] });
    push.answers.set("phone", [{ kind: "gone", status: 410 }]);
    push.answers.set("tablet", [{ kind: "gone", status: 404 }]);
    up(question());
    await clock.advance(5 * S);
    const state = host.states.at(-1)!;
    assert.deepEqual(state.devices.map((d) => [d.id, d.goneAt !== undefined]), [["laptop", false], ["phone", true], ["tablet", true]]);
    up(note());
    await clock.advance(5 * S);
    assert.deepEqual(push.delivered.slice(3).map((d) => d.id), ["laptop"]);
  });

  test("Google's 403 for a subscription of another key pair counts as gone; other refusals are kept with the reason", async () => {
    const { clock, push, up } = world({ devices: ["a", "b"] });
    push.answers.set("a", [{ kind: "failed", status: 403, reason: "status 403", keyMismatch: true }]);
    push.answers.set("b", [{ kind: "failed", status: 400, reason: "BadJwtToken" }]);
    up(question());
    await clock.advance(5 * S);
    assert.ok(push.list()[0]!.goneAt);
    assert.deepEqual(push.list()[1]!.last, { at: new Date(START + 5 * S).toISOString(), kind: "needs", result: "refused", problem: "BadJwtToken" });
    await clock.advance(MIN);
    assert.equal(push.delivered.filter((d) => d.id === "b").length, 1, "a 400 is not tried again");
  });

  test("429, 5xx, a time-out or no connection: one more try after 30 seconds, then the result is kept", async () => {
    const { clock, push, host, up } = world({ devices: ["a", "b", "c", "d"] });
    push.answers.set("a", [{ kind: "failed", status: 429, reason: "too many messages (429)" }, { kind: "sent", status: 201 }]);
    push.answers.set("b", [{ kind: "failed", status: 503, reason: "a free text the push service sent" }]);
    push.answers.set("c", [{ kind: "error", unreachable: true, reason: "The push service did not answer in time." }]);
    push.answers.set("d", [{ kind: "error", unreachable: true, reason: "The push service could not be reached." }, { kind: "sent", status: 201 }]);
    up(question());
    await clock.advance(5 * S);
    assert.equal(push.delivered.length, 4);
    assert.equal(host.states.length, 0, "nothing recorded while a retry waits");
    await clock.advance(29 * S);
    assert.equal(push.delivered.length, 4);
    await clock.advance(1 * S);
    assert.equal(push.delivered.length, 8, "each tried once more");
    const last = new Map(host.states.at(-1)!.devices.map((d) => [d.id, d.last]));
    assert.equal(last.get("a")!.result, "sent");
    assert.deepEqual([last.get("b")!.result, last.get("b")!.problem], ["refused", "push service unavailable (503)"], "only fixed words, never a text of the answer");
    assert.deepEqual([last.get("c")!.result, last.get("c")!.problem], ["unreachable", "The push service did not answer in time."]);
    assert.equal(last.get("d")!.result, "sent");
    await clock.advance(5 * MIN);
    assert.equal(push.delivered.length, 8, "never more than one more try");
  });

  test("the retry looks again: an answered card, a kind switched off, a window in front, a bot at work again or an approval that ended: no second try", async () => {
    const busy = (w: ReturnType<typeof world>, id = "laptop") => w.push.answers.set(id, [{ kind: "failed", status: 503, reason: "push service unavailable (503)" }, { kind: "sent", status: 201 }]);

    // Answered during the 30 seconds.
    const a = world({ devices: ["laptop"] });
    busy(a);
    const card = a.up(question());
    await a.clock.advance(5 * S);
    a.down(card);
    await a.clock.advance(30 * S);
    assert.equal(a.push.delivered.length, 1, "answered: no second try");
    assert.deepEqual([a.push.list()[0]!.last?.result, a.push.list()[0]!.last?.problem], ["refused", "push service unavailable (503)"], "the first answer is kept");

    // The kind switched off during the 30 seconds.
    const b = world({ devices: ["laptop"] });
    busy(b);
    b.up(question());
    await b.clock.advance(5 * S);
    b.n.setKinds({ needs: false });
    await b.clock.advance(30 * S);
    assert.equal(b.push.delivered.length, 1, "switched off: no second try");

    // He came to the window of that device: no second try to it; another device still gets its own.
    const c = world({ devices: ["laptop", "phone"] });
    busy(c, "laptop");
    busy(c, "phone");
    c.up(question());
    await c.clock.advance(5 * S);
    c.n.presence("w", { deviceId: "laptop", visible: true, focused: true, idleMs: null });
    await c.clock.advance(30 * S);
    assert.deepEqual(c.push.delivered.map((d) => d.id), ["laptop", "phone", "phone"]);
    // ... and at a window he uses, nobody gets a second try.
    const c2 = world({ devices: ["laptop", "phone"] });
    busy(c2, "laptop");
    busy(c2, "phone");
    c2.up(question());
    await c2.clock.advance(5 * S);
    c2.n.presence("w", { visible: true, focused: true, idleMs: 0 });
    await c2.clock.advance(30 * S);
    assert.equal(c2.push.delivered.length, 2);

    // The bot went to work again before a finished one could be tried again.
    const d = world({ devices: ["laptop"] });
    busy(d);
    d.n.cameToRest("po", "finished", "you");
    await d.clock.advance(15 * S);
    d.host.resting.delete("po");
    await d.clock.advance(30 * S);
    assert.equal(d.push.delivered.length, 1, "no longer at rest: no second try");

    // An approval near its end: the second try's time to live is worked out again; once it ended, none.
    const e = world({ devices: ["laptop"] });
    busy(e);
    e.up(approval("po", new Date(START + 50 * S).toISOString()));
    await e.clock.advance(5 * S);
    await e.clock.advance(30 * S);
    assert.deepEqual(e.push.delivered.map((x) => x.opts.ttl), [45, 15], "the retry carries what is left then");
    const f = world({ devices: ["laptop"] });
    busy(f);
    f.up(approval("po", new Date(START + 20 * S).toISOString()));
    await f.clock.advance(5 * S);
    await f.clock.advance(30 * S);
    assert.equal(f.push.delivered.length, 1, "the approval ended during the 30 seconds: no second try");

    // Still due: the second try goes, with the count of what is open then and the same topic.
    const g = world({ devices: ["laptop"] });
    busy(g);
    g.up(question());
    await g.clock.advance(5 * S);
    g.up(question());
    await g.clock.advance(30 * S);
    assert.equal(g.push.delivered.length, 2);
    assert.equal(g.push.delivered[1]!.message.body, "2 things wait for you.");
    assert.equal(g.push.delivered[1]!.opts.topic, g.push.delivered[0]!.opts.topic);
    assert.equal(g.push.list()[0]!.last?.result, "sent");
  });

  test("Send a test: at once, to the one device, whatever the switches and whoever looks; refused for unknown and gone devices", async () => {
    const { push, n, host } = world({ kinds: { needs: false, note: false, finished: false }, prefix: "Test copy: " });
    n.presence("x", { deviceId: "phone", visible: true, focused: true, idleMs: 0 });
    const r = await n.test("phone");
    assert.deepEqual(push.delivered.map((d) => [d.id, d.message]), [["phone", { v: 1, kind: "test", title: "Test copy: Pobots", body: "This is a test. Notifications reach this device.", tag: "pobots-test", url: "/" }]]);
    assert.deepEqual(push.delivered[0]!.opts, { ttl: 300, urgency: "high", topic: topicOf("pobots-test") });
    assert.equal(r.notify.devices.find((d) => d.id === "phone")!.last?.kind, "test");
    assert.equal(host.states.length, 1, "notify.changed once");
    await assert.rejects(n.test("nobody"), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    push.markGone("laptop", at());
    await assert.rejects(n.test("laptop"), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    // A test is not tried again after 30 seconds: it answers when the push service has.
    push.answers.set("phone", [{ kind: "failed", status: 503, reason: "push service unavailable (503)" }]);
    const failed = await n.test("phone");
    assert.equal(failed.notify.devices.find((d) => d.id === "phone")!.last?.result, "refused");
  });

  test("after a stop nothing more is sent", async () => {
    const { clock, push, n, up } = world();
    up(question());
    n.shutdown();
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0);
    assert.equal(clock.waiting, 0);
  });
});

describe("notifications: the words", () => {
  test("a bot's name loses control characters and the invisible ones that turn text around, then is cut at 40; nothing left is A bot", () => {
    // Bidi marks, embeddings, overrides and isolates; zero-width space and word joiner; the byte order mark; other controls.
    const hidden = ["\u200e", "\u200f", "\u061c", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200b", "\u2060", "\ufeff", "\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u00ad"];
    for (const ch of hidden) assert.equal(shortName(`P${ch}o`), "Po", `U+${ch.codePointAt(0)!.toString(16)} is taken out`);
    for (const ch of ["\u200c", "\u200d"]) assert.equal(shortName(`P${ch}o`), `P${ch}o`, `U+${ch.codePointAt(0)!.toString(16)} (a joiner real names need) stays`);
    assert.equal(shortName("\u202eoP"), "oP", "a right-to-left override cannot turn the title around");
    assert.equal(words({ kind: "needs", name: "Po\u202e\u2066 sneaky" }).title, "Po sneaky needs your answer");
    assert.equal(shortName("\u200b\u202e\u2066\u0007 \u200d"), "A bot");
    assert.equal(shortName(""), "A bot");
    assert.equal(words({ kind: "finished", name: "\u200b\u200b" }).title, "A bot finished");
    // Cut after cleaning: 40 visible characters, not 40 with the invisible ones counted.
    assert.equal(shortName(`${"\u200b".repeat(30)}${"C".repeat(45)}`), "C".repeat(40));
    assert.equal(shortName("Kåja Ölund"), "Kåja Ölund", "letters of any language stay");
  });

  test("a bot's name keeps what real names need: joined emoji, the Persian non-joiner, right-to-left letters; it is cut between letters as a person sees them", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
    assert.equal(shortName(`Home ${family}`), `Home ${family}`, "a family emoji joined with U+200D stays whole");
    const persian = "\u0639\u0644\u06cc\u200c\u0631\u0636\u0627";
    assert.equal(shortName(persian), persian, "a Persian name with U+200C is unchanged");
    const hebrew = "\u05e9\u05e8\u05d4 \u05db\u05d4\u05df";
    assert.equal(shortName(hebrew), hebrew, "a Hebrew name is unchanged");
    const arabic = "\u0644\u064a\u0644\u0649 \u0623\u062d\u0645\u062f";
    assert.equal(shortName(arabic), arabic, "an Arabic name is unchanged");
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    assert.equal(shortName(`Team ${flag}`), `Team ${flag}`, "a flag made of tag characters stays whole");
    assert.equal(shortName("Po\u202eevil"), "Poevil", "an override loses only itself");
    assert.equal(shortName(`\u2067${hebrew}\u2069 helper`), `${hebrew} helper`, "isolates go, the letters stay");
    // Cut at 40 by what a person sees: 45 joined families become 40 whole ones; a letter with its mark is one.
    const cut = shortName(family.repeat(45));
    assert.equal(cut, family.repeat(40), "cut on a cluster boundary, never inside a joined emoji");
    assert.equal(shortName(`${"e\u0301".repeat(45)}`), "e\u0301".repeat(40), "a letter and its accent count as one");
    assert.equal(shortName(`${"A".repeat(39)}\u{1f600}\u{1f600}`), `${"A".repeat(39)}\u{1f600}`, "never through a surrogate pair");
    assert.equal(shortName("\u200d\u200c \u0301"), "A bot", "only joiners and a mark: nothing to show");
  });

  test("the test copy's prefix on every title; a long name cut at 40; no device: nothing; an id in the address is encoded", async () => {
    assert.deepEqual(words({ kind: "needs", name: "Po", prefix: "Test copy: " }), { title: "Test copy: Po needs your answer", body: "Open Pobots to answer." });
    assert.deepEqual(words({ kind: "note", prefix: "Test copy: " }), { title: "Test copy: Pobots has a note for you", body: "Open Pobots to read it." });
    assert.deepEqual(words({ kind: "note", name: "Po", count: 2 }), { title: "Po sent you a note", body: "2 notes wait for you." });
    assert.equal(shortName("A".repeat(60)).length, 40);
    assert.equal(shortName("Line one\nline two"), "Line one line two");
    assert.equal(words({ kind: "finished", name: "B".repeat(60) }).title, `${"B".repeat(40)} finished`);
    assert.equal(pushMessage({ kind: "finished", botId: "a b&c", name: "X" }).url, "/?bot=a%20b%26c&open=chat");
    const { clock, push, up } = world({ devices: [] });
    up(question());
    await clock.advance(MIN);
    assert.equal(push.delivered.length, 0);
  });
});

// ------------------------------------------------------------ the real store: subscribing and secrecy

describe("notifications: subscribing (notify.subscribe, notify.forget)", () => {
  test("asked adds a device; still-here updates a known one or puts a new address in a gone row's place, and refuses an unknown one and a working row's place; a 21st is refused", () => {
    const host = new StandInHost();
    const store = new PushStore(join(tempDir(), "push"));
    const n = new Notifier({ push: store, host, kinds: { needs: true, note: true, finished: false }, timers: new FakeClock() });
    const a = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-a").sub;
    assert.throws(() => n.subscribe({ subscription: a, label: "Chrome on Windows", asked: false }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    const { deviceId: idA, notify } = n.subscribe({ subscription: a, label: "Chrome on Windows", asked: true });
    assert.equal(idA, deviceId(a.endpoint));
    assert.deepEqual(notify.devices.map((d) => [d.id, d.label, d.service]), [[idA, "Chrome on Windows", "Google"]]);
    assert.equal(notify.publicKey.length > 80, true);
    assert.equal(host.states.length, 1, "notify.changed for a new device");
    n.subscribe({ subscription: a, label: "Chrome on Windows", asked: false });
    assert.equal(host.states.length, 1, "saying it again changes nothing, so nothing is sent");
    const moved = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-a-moved").sub;
    assert.throws(() => n.subscribe({ subscription: moved, label: "Chrome on Windows", asked: false, replaces: idA }), (e: unknown) => e instanceof EngineError && e.code === "conflict", "still here cannot take a working row's place");
    assert.deepEqual(n.state().devices.map((d) => d.id), [idA], "nothing changed");
    store.markGone(idA, at());
    const r = n.subscribe({ subscription: moved, label: "Chrome on Windows", asked: false, replaces: idA });
    assert.equal(r.notify.devices.length, 1);
    assert.equal(r.deviceId, deviceId(moved.endpoint));
    assert.throws(() => n.subscribe({ subscription: { ...a, endpoint: "https://push.example.com/x" }, label: "x", asked: true }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
    for (let i = 0; i < 19; i++) n.subscribe({ subscription: fakeSubscription(`https://fcm.googleapis.com/fcm/send/made-up-${i}`).sub, label: `Device ${i}`, asked: true });
    assert.throws(() => n.subscribe({ subscription: fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-21").sub, label: "x", asked: true }), (e: unknown) => e instanceof EngineError && e.code === "too_many");
    assert.equal(n.forget(r.deviceId).notify.devices.length, 19);
    assert.equal(n.forget("nobody").notify.devices.length, 19, "forgetting what is not there is harmless");
  });
});

describe("notifications: a dead device never reads as on (the reviewer's test a)", () => {
  test("marked gone by a 410, the page saying still here (asked false) is refused and the row stays gone; only a fresh turn-on mends it", async () => {
    const clock = new FakeClock();
    const host = new StandInHost();
    const sentTo: string[] = [];
    let status = 410;
    const fakeFetch = (async (url: string) => {
      sentTo.push(url);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const n = new Notifier({ push: new PushStore(join(tempDir(), "push"), { fetch: fakeFetch }), host, kinds: { needs: true, note: true, finished: false }, timers: clock });
    const old = fakeSubscription("https://web.push.apple.com/made-up-dead").sub;
    const { deviceId: id } = n.subscribe({ subscription: old, label: "Home screen app on iPhone", asked: true });
    host.cards.push(question());
    n.cardAdded(host.cards[0]!);
    await clock.advance(5 * S);
    await n.idle();
    assert.equal(sentTo.length, 1);
    assert.ok(n.state().devices[0]!.goneAt, "the 410 made it gone");
    const changes = host.states.length;

    // The page opens on that phone and says still here with the same subscription.
    assert.throws(() => n.subscribe({ subscription: old, label: "Home screen app on iPhone", asked: false }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    assert.throws(() => n.subscribe({ subscription: old, label: "Home screen app on iPhone", asked: false, replaces: id }), (e: unknown) => e instanceof EngineError && e.code === "conflict", "naming itself in replaces changes nothing");
    assert.ok(n.state().devices[0]!.goneAt, "still gone");
    assert.equal(host.states.length, changes, "nothing was broadcast");
    await assert.rejects(n.test(id), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    status = 201;
    host.cards.push(question());
    n.cardAdded(host.cards[1]!);
    await clock.advance(2 * MIN);
    await n.idle();
    assert.equal(sentTo.length, 1, "nothing was sent to the dead address");

    // His press on "Turn on": the page got a fresh subscription and names the gone row.
    const fresh = fakeSubscription("https://web.push.apple.com/made-up-fresh").sub;
    const r = n.subscribe({ subscription: fresh, label: "Home screen app on iPhone", asked: true, replaces: id });
    assert.deepEqual(r.notify.devices.map((d) => [d.id, d.goneAt]), [[deviceId(fresh.endpoint), undefined]], "the same row, working again with the fresh address");
    host.cards.push(question());
    n.cardAdded(host.cards[2]!);
    await clock.advance(2 * MIN);
    await n.idle();
    assert.deepEqual(sentTo.slice(1), [fresh.endpoint], "sent to the fresh address only");
  });
});

describe("notifications: an address the push service called gone never comes back (the second look's points 1 and 2)", () => {
  test("a press with the same dead address is refused; after a fresh address took its row, the dead one returning by a press or a stale tab's still here is refused; a stale replaces naming a working row changes nothing", async () => {
    const clock = new FakeClock();
    const host = new StandInHost();
    const sentTo: string[] = [];
    let status = 410;
    const fakeFetch = (async (url: string) => {
      sentTo.push(url);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const dir = join(tempDir(), "push");
    const n = new Notifier({ push: new PushStore(dir, { fetch: fakeFetch }), host, kinds: { needs: true, note: true, finished: false }, timers: clock });
    const label = "Chrome on Android";
    const dead = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-dead").sub;
    const { deviceId: idDead } = n.subscribe({ subscription: dead, label, asked: true });
    const ask = async () => {
      const card = question();
      host.cards.push(card);
      n.cardAdded(card);
      await clock.advance(2 * MIN + 5 * S);
      await n.idle();
    };
    await ask();
    assert.ok(n.state().devices[0]!.goneAt, "the 410 made it gone");
    const conflict = (e: unknown) => e instanceof EngineError && e.code === "conflict" && !e.message.includes("made-up");
    const changes = host.states.length;

    // A press whose browser gave the same address again (an unsubscribe that failed, or the same address handed back).
    assert.throws(() => n.subscribe({ subscription: dead, label, asked: true }), conflict, "a press with the dead address");
    assert.throws(() => n.subscribe({ subscription: dead, label, asked: true, replaces: idDead }), conflict, "a press naming its own row");
    assert.ok(n.state().devices[0]!.goneAt, "still gone");
    assert.equal(host.states.length, changes, "nothing was broadcast");

    // A fresh address takes the gone row's place.
    status = 201;
    const fresh = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-fresh").sub;
    const { deviceId: idFresh } = n.subscribe({ subscription: fresh, label, asked: true, replaces: idDead });
    const working = JSON.stringify(n.state().devices);

    // The dead address returns: by a press, by a stale tab saying still here and naming the working row, after a restart.
    assert.throws(() => n.subscribe({ subscription: dead, label, asked: true }), conflict, "a press, after its row was replaced");
    assert.throws(() => n.subscribe({ subscription: dead, label, asked: false, replaces: idFresh }), conflict, "a stale tab naming the working row");
    const restarted = new Notifier({ push: new PushStore(dir, { fetch: fakeFetch }), host, kinds: { needs: true, note: true, finished: false }, timers: clock });
    assert.throws(() => restarted.subscribe({ subscription: dead, label, asked: true }), conflict, "after a restart");
    // A stale tab with another old address (never called gone) naming the working row: refused, nothing changes.
    const older = fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-older").sub;
    assert.throws(() => n.subscribe({ subscription: older, label, asked: false, replaces: idFresh }), conflict, "a stale replaces from the page");
    assert.equal(JSON.stringify(n.state().devices), working, "the working row is untouched");
    sentTo.length = 0;
    await ask();
    assert.deepEqual(sentTo, [fresh.endpoint], "sent to the fresh address only");
  });
});

describe("notifications: nothing a push service answers leaves the engine as free text; a redirect sends nothing elsewhere (the reviewer's test c)", () => {
  test("bodies that echo an address's path, a token and key fragments show nowhere: not in the state, an event, a log line or an error", async () => {
    const clock = new FakeClock();
    const host = new StandInHost();
    const subs = {
      google: fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-echo-google-token"),
      apple: fakeSubscription("https://web.push.apple.com/QmadeUpEchoApplePath"),
      ms: fakeSubscription("https://wns2-am3p.notify.windows.com/w/?token=madeUpEchoMsToken"),
      moz: fakeSubscription("https://updates.push.services.mozilla.com/wpush/v2/madeUpEchoMozPath"),
      redirect: fakeSubscription("https://jmt17.google.com/fcm/send/made-up-echo-redirect"),
    };
    const fragments = (x: { sub: Subscription; auth: Buffer }) => [x.sub.endpoint, new URL(x.sub.endpoint).pathname, new URL(x.sub.endpoint).search, x.sub.keys.p256dh.slice(10, 30), x.sub.keys.auth.slice(2, 14), b64u(x.auth).slice(0, 12)].filter((t) => t.length > 3);
    const hosts: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      hosts.push(u.host);
      if (u.host === "fcm.googleapis.com")
        return new Response(JSON.stringify({ reason: `token ${u.pathname} not valid`, message: subs.google.sub.keys.p256dh.slice(10, 30) }), { status: 403 });
      if (u.host === "web.push.apple.com") return new Response(JSON.stringify({ reason: subs.apple.sub.keys.auth.slice(2, 14) }), { status: 400 });
      if (u.host.endsWith("notify.windows.com")) return new Response(`Token madeUpEchoMsToken for ${u.search} is invalid`, { status: 401 });
      if (u.host.endsWith("mozilla.com")) return new Response(JSON.stringify({ errno: 109, error: `${u.pathname} ${b64u(subs.moz.auth)}` }), { status: 503 });
      if (u.host === "jmt17.google.com") {
        const res = new Response(JSON.stringify({ reason: u.pathname }), { status: 307, headers: { Location: "https://collector.example.com/take" } });
        if (init.redirect === "manual" || init.redirect === "error") return res;
        return fakeFetch("https://collector.example.com/take", init);
      }
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const original = process.stderr.write.bind(process.stderr);
    const level = process.env.POBOTS_LOG;
    let logged = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.env.POBOTS_LOG = "info";
    const errors: string[] = [];
    try {
      const n = new Notifier({ push: new PushStore(join(tempDir(), "push"), { fetch: fakeFetch }), host, kinds: { needs: true, note: true, finished: false }, timers: clock, retryMs: 30 * S });
      const ids = Object.values(subs).map((x, i) => n.subscribe({ subscription: x.sub, label: `Device ${i}`, asked: true }).deviceId);
      host.cards.push(question());
      n.cardAdded(host.cards[0]!);
      await clock.advance(5 * S);
      await clock.advance(30 * S);
      await n.idle();
      for (const id of ids) {
        try {
          await n.test(id);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      const state = n.state();
      const last = new Map(state.devices.map((d) => [d.id, d.last]));
      assert.deepEqual(
        ids.map((id) => last.get(id)?.problem),
        ["status 403", "message not accepted (400)", "sender not accepted (401)", "push service unavailable (503)", "redirected, not followed"],
        "only fixed words, never words of the answer",
      );
      assert.ok(!hosts.includes("collector.example.com"), "nothing went where the redirect pointed");
      const shown = [JSON.stringify(host.states), JSON.stringify(state), logged, errors.join("\n")];
      for (const text of shown) {
        for (const x of Object.values(subs)) for (const secret of fragments(x)) assert.ok(!text.includes(secret), `no "${secret}" shows`);
        assert.ok(!/made-?up-?echo|madeUpEcho|QmadeUp|collector/i.test(text), "no part of an address, token or key shows");
      }
      assert.match(logged, /Notification \(needs\) to Device 0 \(Google\): refused \(403\) status 403/);
    } finally {
      process.stderr.write = original;
      if (level === undefined) delete process.env.POBOTS_LOG;
      else process.env.POBOTS_LOG = level;
    }
  });
});

describe("notifications: nothing about a device's address or keys leaves the engine; nothing of the chat goes into a push", () => {
  test("events, log lines, error messages and NotifyState hold no address or key; every push opens to the right words only", async () => {
    const clock = new FakeClock();
    const bodies: { address: string; body: Buffer }[] = [];
    let answer: (address: string) => number = () => 201;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      bodies.push({ address: url, body: Buffer.from(init.body as Uint8Array) });
      return new Response(answer(url) === 403 ? '{"reason":"see https://web.push.apple.com/secret"}' : null, { status: answer(url) });
    }) as unknown as typeof fetch;
    const original = process.stderr.write.bind(process.stderr);
    const level = process.env.POBOTS_LOG;
    let logged = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.env.POBOTS_LOG = "info";
    const errors: string[] = [];
    let w: ReturnType<typeof setup> | undefined;
    const subs = [
      fakeSubscription("https://fcm.googleapis.com/fcm/send/made-up-secret-google"),
      fakeSubscription("https://web.push.apple.com/made-up-secret-apple"),
      fakeSubscription("https://wns2-am3p.notify.windows.com/w/?token=made-up-secret-ms"),
    ];
    try {
      const dataDir = tempDir();
      w = setup({ dataDir, botsDir: tempDir() }, () => true, undefined, {
        notify: { push: new PushStore(join(dataDir, "push"), { fetch: fakeFetch }), timers: clock },
        notifyConfig: { kinds: { needs: true, note: true, finished: true }, titlePrefix: "" },
      });
      const { engine, sessions, events } = w;
      const bot = engine.createBot("Po");
      const ids = subs.map((s, i) => engine.notifySubscribe({ subscription: s.sub, label: ["Chrome on Windows", "Home screen app on iPhone", "Edge on Windows"][i]!, asked: true }).deviceId);
      for (const bad of [
        () => engine.notifySubscribe({ subscription: { ...subs[0]!.sub, endpoint: "https://fcm.googleapis.com/fcm/send/made-up-secret-unknown" }, label: "x", asked: false }),
        () => engine.notifySubscribe({ subscription: { endpoint: subs[1]!.sub.endpoint, keys: { p256dh: "made-up-secret-key", auth: "made-up-secret-auth" } }, label: "x", asked: true }),
      ]) {
        try {
          bad();
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      engine.sendMessage({ botId: bot.id, text: "Please look at the invoice" });
      await settle();
      const s = sessions.at(-1)!;
      const asked = s.tool("ask_human", { question: "Should I pay invoice 4711 to ACME?", context: "The amount is 9 000 kr." });
      await settle();
      await s.tool("notify_human", { title: "Invoice 4711 paid", text: "Paid 9 000 kr to ACME." });
      answer = (url) => (url.includes("apple") ? 403 : 201);
      await clock.advance(5 * S);
      answer = (url) => (url.includes("windows") ? 410 : 201);
      const card = engine.snapshot().cards.find((c) => c.kind === "question")!;
      engine.resolveCard(card.id, { type: "text", text: "Yes, pay ACME" });
      await asked;
      s.reply("I paid invoice 4711 to ACME.");
      await settle();
      await clock.advance(15 * S);
      await engine.notifyIdle();
      try {
        await engine.notifyTest(ids[2]!);
      } catch (e) {
        errors.push((e as Error).message);
      }
      await engine.notifyTest(ids[0]!);

      // Every message opens, with the browser's own keys, to the words and nothing of the chat.
      const messages = bodies.map((b) => {
        const sub = subs.find((x) => x.sub.endpoint === b.address)!;
        return JSON.parse(decryptAsBrowser(b.body, sub.uaPrivate, sub.auth).toString()) as PushMessage;
      });
      const kinds = messages.map((m) => m.kind).sort();
      assert.deepEqual([...new Set(kinds)], ["finished", "needs", "note", "test"]);
      for (const m of messages) {
        const text = JSON.stringify(m);
        for (const chat of ["invoice", "Invoice", "4711", "ACME", "9 000", "pay", "Please look"]) assert.ok(!text.includes(chat), `no chat text (${chat}) in ${text}`);
      }
      assert.ok(messages.some((m) => m.title === "Po needs your answer"));
      assert.ok(messages.some((m) => m.title === "Po sent you a note"));
      assert.ok(messages.some((m) => m.title === "Po finished"));

      const state = engine.snapshot().notify;
      assert.equal(state.devices.find((d) => d.id === ids[2])!.goneAt !== undefined, true, "410 made the Edge device gone");
      const problems = events
        .filter((e: Ev) => e.event === "notify.changed")
        .flatMap((e: Ev) => (e.data as Events["notify.changed"]).notify.devices.map((d) => d.last?.problem ?? ""));
      assert.ok(problems.some((p) => p === "status 403"), "Apple's refusal was kept as its status only: its reason was not one of the known names");
      const shown = [JSON.stringify(events.filter((e: Ev) => e.event === "notify.changed")), JSON.stringify(state), JSON.stringify(engine.snapshot()), logged, errors.join("\n")];
      assert.ok(errors.length >= 2, "the refusals were seen");
      assert.match(logged, /Notification \(needs\) to Chrome on Windows \(Google\): sent \(201\)/, "the log says what was sent, by label and service");
      assert.match(logged, /Edge on Windows \(Microsoft\): the push service says this device no longer takes notifications \(410\)/);
      assert.ok(events.some((e: Ev) => e.event === "notify.changed" && (e.data as Events["notify.changed"]).notify.devices.length === 3));
      for (const text of shown) {
        for (const sub of subs) {
          for (const secret of [sub.sub.endpoint, sub.sub.keys.p256dh, sub.sub.keys.auth, b64u(sub.auth)]) assert.ok(!text.includes(secret), "no address or key shows");
        }
        assert.ok(!text.includes("made-up-secret"), "no part of an address or a key shows");
      }
      // And the push folder holds them, private.
      const file = readFileSync(join(w.dirs.dataDir, "push", "subscriptions.json"), "utf8");
      assert.ok(file.includes("made-up-secret-google"));
      assert.ok(!file.includes("made-up-secret-ms"), "the gone device's address is dropped");
      assert.ok(fromB64u(state.publicKey).length === 65);
    } finally {
      process.stderr.write = original;
      if (level === undefined) delete process.env.POBOTS_LOG;
      else process.env.POBOTS_LOG = level;
      w?.engine.shutdown();
      w?.store.close();
    }
  });
});

// ------------------------------------------------------------ where the engine calls the notifier

function engineWorld(o: { finished?: boolean; graceMs?: Partial<Record<NotifyKind, number>> } = {}, dirs?: { dataDir: string; botsDir: string }) {
  const clock = new FakeClock();
  const push = new StandInPush();
  push.add("laptop");
  const w = setup(dirs, () => true, { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 }, {
    notify: { push, timers: clock, ...(o.graceMs ? { graceMs: o.graceMs } : {}) },
    notifyConfig: { kinds: { needs: true, note: true, finished: o.finished ?? true }, titlePrefix: "" },
  });
  return { ...w, clock, push };
}

async function talk(w: ReturnType<typeof engineWorld>, botId: string, text = "Go"): Promise<FakeSession> {
  w.engine.sendMessage({ botId, text });
  await settle();
  return w.sessions.at(-1)!;
}

describe("notifications: the engine's own events", () => {
  test("a bot's question and note each send once; an answered card none; the snapshot carries the state", async () => {
    const w = engineWorld();
    const bot = w.engine.createBot("Po");
    assert.deepEqual(Object.keys(w.engine.snapshot().notify).sort(), ["devices", "kinds", "publicKey"]);
    const s = await talk(w, bot.id);
    const p = s.tool("ask_human", { question: "Which day?" });
    await settle();
    await s.tool("notify_human", { title: "Report sent" });
    await w.clock.advance(5 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.title).sort(), ["Po needs your answer", "Po sent you a note"]);
    const card = w.engine.snapshot().cards.find((c) => c.kind === "question")!;
    w.engine.resolveCard(card.id, { type: "text", text: "Monday" });
    await p;
    const p2 = s.tool("ask_human", { question: "And the time?" });
    await settle();
    await w.clock.advance(2 * S);
    w.engine.resolveCard(w.engine.snapshot().cards.find((c) => c.kind === "question")!.id, { type: "text", text: "Ten" });
    await p2;
    await w.clock.advance(10 * MIN);
    assert.equal(w.push.delivered.filter((d) => d.message.kind === "needs").length, 1, "the card answered within the wait sent nothing, and no fold");
    w.engine.shutdown();
    w.store.close();
  });

  test("a permission question of the harness and Pobots' own card are needs and note", async () => {
    const w = engineWorld();
    const bot = w.engine.createBot("Po");
    await w.engine.updateBot({ botId: bot.id, patch: { access: "asks-first" } });
    const s = await talk(w, bot.id);
    const r = s.ask("Bash", { command: "ls" });
    await settle();
    await w.clock.advance(5 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.tag), [`pobots-${bot.id}-needs`]);
    w.engine.resolveCard(w.engine.snapshot().cards[0]!.id, { type: "deny" });
    await r;
    w.engine.shutdown();
    w.store.close();
  });

  test("finished: a turn the person started, once; not a turn of a schedule; not a stop", async () => {
    const w = engineWorld();
    const bot = w.engine.createBot("Po");
    const s = await talk(w, bot.id);
    s.reply("Done.");
    await settle();
    await w.clock.advance(15 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.title), ["Po finished"]);
    await w.clock.advance(5 * MIN);

    const t = w.engine.saveTrigger({ botId: bot.id, trigger: { kind: "schedule", name: "Pulse", prompt: "Look.", where: "main", enabled: false, schedule: { type: "daily", time: "09:00", days: ["mon"] } } });
    w.engine.runTrigger(t.id);
    await settle();
    s.reply("Looked.");
    await settle();
    await w.clock.advance(MIN);
    assert.equal(w.push.delivered.length, 1, "a schedule's turn sends no finished");

    w.engine.sendMessage({ botId: bot.id, text: "Do a long thing" });
    await settle();
    await w.engine.interrupt(bot.id);
    s.emit({ type: "turn-end", ok: true, subtype: "interrupted", errors: [], sessionId: "sess-1" });
    await settle();
    await w.clock.advance(MIN);
    assert.equal(w.push.delivered.length, 1, "a stop sends nothing");

    w.engine.sendMessage({ botId: bot.id, text: "Try again" });
    await settle();
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: ["boom"], sessionId: "sess-1" });
    await settle();
    await w.clock.advance(15 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.title), ["Po finished", "Po stopped"]);
    w.engine.shutdown();
    w.store.close();
  });

  test("finished waits for a helper in the background, and comes once it is done", async () => {
    const w = engineWorld();
    const bot = w.engine.createBot("Po");
    const s = await talk(w, bot.id, "Start a helper");
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    s.helperStart("h1", { description: "Read the word file", background: true });
    s.emit({ type: "text-full", key: "t1", text: "A helper is on it." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    await w.clock.advance(MIN);
    assert.equal(w.push.delivered.length, 0, "not while the helper works");
    s.helperEnd("h1", "completed", "The word is pear.", { background: true });
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    await w.clock.advance(15 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.title), ["Po finished"]);
    w.engine.shutdown();
    w.store.close();
  });

  test("a queued message that starts at once: no finished for the first turn", async () => {
    const w = engineWorld();
    const bot = w.engine.createBot("Po");
    const s = await talk(w, bot.id, "One");
    w.engine.sendMessage({ botId: bot.id, text: "Two" });
    await settle();
    s.reply("First answer.");
    await settle();
    await w.clock.advance(15 * S);
    assert.equal(w.push.delivered.length, 0, "the bot was busy again when the wait ended");
    s.reply("Second answer.");
    await settle();
    await w.clock.advance(15 * S);
    assert.deepEqual(w.push.delivered.map((d) => d.message.title), ["Po finished"]);
    w.engine.shutdown();
    w.store.close();
  });

  test("nothing at start for cards put back from the database", async () => {
    const first = engineWorld();
    const bot = first.engine.createBot("Po");
    const s = await talk(first, bot.id);
    await s.tool("notify_human", { title: "Report sent" });
    first.engine.shutdown();
    first.store.close();
    assert.equal(first.push.delivered.length, 0, "stopped within the wait: lost, by design");
    const second = engineWorld({}, first.dirs);
    assert.equal(second.engine.snapshot().cards.length, 1);
    await second.clock.advance(10 * MIN);
    assert.equal(second.push.delivered.length, 0);
    second.engine.shutdown();
    second.store.close();
  });

  test("setKinds writes the notify part of config.json and keeps the rest; notify.changed carries the switches", async () => {
    const dataDir = tempDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claude: {}, backup: { folder: "/x" }, notify: { titlePrefix: "Test copy: " } }), { mode: 0o600 });
    const w = engineWorld({}, { dataDir, botsDir: tempDir() });
    const r = w.engine.notifySetKinds({ finished: true, needs: false });
    assert.deepEqual(r.notify.kinds, { needs: false, note: true, finished: true });
    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, { claude: {}, backup: { folder: "/x" }, notify: { titlePrefix: "Test copy: ", needs: false, note: true, finished: true } });
    const ev = w.events.filter((e) => e.event === "notify.changed").at(-1)!.data as Events["notify.changed"];
    assert.deepEqual(ev.notify.kinds, { needs: false, note: true, finished: true });
    w.engine.shutdown();
    w.store.close();
  });
});

describe("notifications: config.json", () => {
  test("the notify part: defaults, values, and bad values fall back with a warning", async () => {
    const { loadConfigFile, notifyConfig, resolveConfig } = await import("../config.js");
    const { writeFileSync } = await import("node:fs");
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ notify: { needs: false, finished: "yes", subject: "ftp://x", titlePrefix: "Test copy: " } }));
    const original = process.stderr.write.bind(process.stderr);
    let logged = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let file;
    try {
      file = loadConfigFile(dir);
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(file.notify, { needs: false, titlePrefix: "Test copy: " });
    assert.match(logged, /notify\.finished/);
    assert.match(logged, /notify\.subject/);
    assert.deepEqual(notifyConfig(file.notify), { kinds: { needs: false, note: true, finished: false }, titlePrefix: "Test copy: " });
    assert.deepEqual(notifyConfig(undefined), { kinds: { needs: true, note: true, finished: false }, titlePrefix: "" });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ notify: { subject: "https://mac.example.ts.net:4443/" } }));
    assert.equal(resolveConfig({ dataDir: dir, botsDir: tempDir() }).notify?.subject, "https://mac.example.ts.net:4443/");
  });
});
