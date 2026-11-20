// Two (or more) Links in one process, joined by a fake fetch, with a fake clock. For the file and
// lifetime specs. A box can play a Pobots before 0.44.0: it answers 404 on wire 2 and never uses it.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionLasts } from "../../shared/protocol.js";
import type { LinkFetch } from "../core/link-http.js";
import type { InboxMessage } from "../core/link-store.js";
import { Links } from "../core/links.js";
import { Store } from "../store.js";

export async function until(fn: () => boolean, time = 6_000): Promise<void> {
  const end = Date.now() + time;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(15);
  }
  assert.ok(fn(), "state did not arrive in time");
}

/** Moves the fake clock on while a promise is open. */
export async function stepping<T>(step: (ms: number) => void, p: Promise<T>, ms = 1_000): Promise<T> {
  let done = false;
  void p.finally(() => { done = true; });
  while (!done) {
    step(ms);
    await delay(15);
  }
  return p;
}

export function linkHarness() {
  let now = Date.now();
  const peers = new Map<string, Links>();
  const old = new Set<string>();
  /** Wire 2 calls to this address that answer 404 once, as a side does before it pressed Connect. */
  const misses = new Map<string, number>();
  const calls: { target: string; wire: 1 | 2; status: number }[] = [];
  const route = (fromOld: boolean): LinkFetch => async (target, id, proof, body, _signal, wire = 1) => {
    const peer = peers.get(target);
    let status = 404;
    let answer: { status: number; body: Buffer } = { status: 404, body: Buffer.alloc(0) };
    const missed = wire === 2 && (misses.get(target) ?? 0) > 0;
    if (missed) misses.set(target, misses.get(target)! - 1);
    if (peer && !missed && !(wire === 2 && (fromOld || old.has(target)))) {
      const auth = peer.preflight(id, proof, wire);
      const result = auth && await peer.receive(auth, body);
      if (result) { answer = result; status = result.status; }
    }
    calls.push({ target, wire, status });
    return answer;
  };
  const dirs: string[] = [];
  const clean: (() => void)[] = [];
  const box = (name: string, base?: string, o: { old?: boolean; db?: string; dataDir?: string } = {}) => {
    const store = new Store(o.db ?? ":memory:");
    const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "pobots-link-files-"));
    if (!o.dataDir) dirs.push(dataDir);
    const messages: InboxMessage[] = [];
    const notes: string[] = [];
    const news: string[] = [];
    let off = false;
    const links = new Links({ store: store.links, name: () => name, publicBase: base, now: () => now,
      changed: () => {}, note: s => notes.push(s), news: s => news.push(s),
      deliver: (_id, _name, _item, msg) => { messages.push(msg); return true; }, ready: () => true,
      files: { dataDir, botId: () => "main" } },
    { fetch: route(!!o.old), tickMs: 10, askMs: 400 });
    if (base) peers.set(base, links);
    if (base && o.old) old.add(base);
    links.start();
    const stop = () => {
      if (off) return;
      off = true;
      links.stop();
      store.close();
      if (base) peers.delete(base);
    };
    clean.push(stop);
    return { links, store, messages, notes, news, stop, base, dataDir };
  };
  const step = (ms: number) => { now += ms; };
  const close = () => {
    for (const stop of clean) stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };
  const miss = (target: string, n = 1) => { misses.set(target, n); };
  return { box, close, step, calls, miss, now: () => now };
}

export type LinkHarness = ReturnType<typeof linkHarness>;
export type LinkBox = ReturnType<LinkHarness["box"]>;

/** Pairs a with b; a calls b "Kim" and b calls a "Sam". */
export async function pairBoxes(h: LinkHarness, a: LinkBox, b: LinkBox, lasts?: { a?: ConnectionLasts; b?: ConnectionLasts }) {
  const ca = a.links.change({ action: "start", name: "Kim", ...(lasts?.a ? { lasts: lasts.a } : {}) });
  const cb = b.links.change({ action: "start", name: "Sam", ...(lasts?.b ? { lasts: lasts.b } : {}) });
  a.links.change({ action: "connect", id: ca.id, code: cb.code! });
  b.links.change({ action: "connect", id: cb.id, code: ca.code! });
  h.step(3_000);
  await until(() => [a, b].every(x => x.links.list().connections[0]?.state === "connected"));
  return { ca, cb };
}
