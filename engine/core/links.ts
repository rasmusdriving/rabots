// Pairing, durable delivery and the engine's small link protocol. No request data is logged.
import { randomBytes, randomUUID } from "node:crypto";
import type { ConnectionChange, ConnectionChangeResult, ConnectionsState, PobotsConnection } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { readLinkRequest, readLinkResponse, type LinkRequest, type LinkResponse } from "./link-frames.js";
import { linkFetch, type LinkFetch } from "./link-http.js";
import type { LinkRow, LinkStore } from "./link-store.js";
import {
  agree, checkAuth, LINK_BODY_MAX, LINK_CLOCK_SKEW, LINK_CODE_MAX, LINK_DAY, LINK_ID, LINK_TEXT_MAX,
  linkBase, linkName, makeAuth, makeIdentity, open, pairingCode, payloadDigest, readPairingCode, seal,
  type LinkKeys, type LinkMessage,
} from "./link-wire.js";

const PULL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const UNREACHED_MS = 45_000;
const ASK_MS = 600_000;
const MAX_LINKS = 24;
const MAX_QUEUE = 50;

type Live = {
  row: LinkRow;
  keys?: LinkKeys;
  due: number;
  failures: number;
  inFlight?: AbortController;
  attempts: number[];
  removeTimer?: ReturnType<typeof setTimeout>;
  published?: string;
};
type Waiter = { linkId: string; answer: (answer: string | undefined) => void };
type Delivery = "delivered" | "queued" | "unreached" | "paused" | "limited";
type Proof = { id: string; exchange: string; digest: Buffer };
type MessageResult = { delivery: Delivery; answer?: string; late?: boolean };

export interface LinksHost {
  store: LinkStore;
  name: () => string;
  publicBase?: string;
  now: () => number;
  changed: (state: ConnectionsState) => void;
  note: (sentence: string) => void;
  deliver: (id: string, name: string, itemId: string, message: LinkMessage) => boolean;
  ready: () => boolean;
}
export interface LinksOptions {
  /** Explicitly enabled only by isolated local checks. Never taken from a pairing code. */
  loopbackBase?: string;
  loopbackPeer?: string;
  fetch?: LinkFetch;
  askMs?: number;
  tickMs?: number;
}

function input<T>(fn: () => T): T {
  try { return fn(); } catch (err) {
    throw new EngineError("bad_request", err instanceof Error ? err.message : "The connection could not be changed.");
  }
}

export class Links {
  private rows = new Map<string, Live>();
  private dummy = randomBytes(32);
  private attempts: number[] = [];
  private delivered = new Map<string, (status: Delivery) => void>();
  private waiting = new Map<string, Waiter>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private started = false;
  private cleanup = 0;
  private readonly base: string | null;
  private readonly loopback: boolean;
  private readonly fetch: LinkFetch;

  private readonly host: LinksHost;
  private readonly options: LinksOptions;

  constructor(host: LinksHost, options: LinksOptions = {}) {
    this.host = host;
    this.options = options;
    this.loopback = !!options.loopbackPeer || !!options.loopbackBase;
    const base = options.loopbackBase || host.publicBase;
    this.base = base ? linkBase(base.replace(/\/$/, ""), this.loopback) : null;
    this.fetch = options.fetch ?? linkFetch(options.loopbackPeer);
    for (const row of host.store.rows()) {
      const id = row.identity.invite.id;
      const keys = row.peer ? agree(row.identity, row.peer) : undefined;
      this.rows.set(id, { row, keys, due: 0, failures: 0, attempts: [] });
    }
  }

  start(): void {
    this.started = true;
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped || !this.started || this.rows.size === 0) return;
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 500);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const link of this.rows.values()) {
      link.inFlight?.abort();
      clearTimeout(link.removeTimer);
    }
    for (const finish of this.delivered.values()) finish("unreached");
    for (const waiter of this.waiting.values()) waiter.answer(undefined);
  }

  list(): ConnectionsState {
    return { hasPublicAddress: !!this.base, connections: [...this.rows.values()]
      .filter(l => !l.row.removing).map(l => this.view(l)) };
  }

  private view(link: Live): PobotsConnection {
    const r = link.row;
    const now = this.host.now();
    const expires = r.identity.invite.at + LINK_DAY;
    const state = !r.confirmed && expires <= now ? "expired"
      : r.paused ? "paused"
      : !r.peer ? "draft"
      : !r.confirmed ? (link.failures >= 3 && now - (r.entered ?? now) > UNREACHED_MS ? "unreached" : "waiting")
      : !r.contact || (now - r.contact > UNREACHED_MS) ? "unreached" : "connected";
    return { id: r.identity.invite.id, name: r.name, state, expiresAt: new Date(expires).toISOString(),
      ...(r.contact ? { lastReached: new Date(r.contact).toISOString() } : {}),
      ...(r.lastMessage ? { lastMessage: new Date(r.lastMessage).toISOString() } : {}) };
  }

  private get(id: string): Live {
    const link = this.rows.get(id);
    if (!link || link.row.removing) throw new EngineError("not_found", "That connection was not found.");
    return link;
  }

  private named(to: string): Live {
    const byId = this.rows.get(to);
    if (byId && !byId.row.removing) return byId;
    const matches = [...this.rows.values()].filter(l => !l.row.removing && l.row.name.toLowerCase() === to.trim().toLowerCase());
    if (matches.length !== 1) throw new EngineError("not_found", "That connection was not found. Use list_connections to see its name or id.");
    return matches[0]!;
  }

  private name(value: string, except?: string): string {
    const name = input(() => linkName(value));
    if ([...this.rows].some(([id, l]) => id !== except && !l.row.removing && l.row.name.toLowerCase() === name.toLowerCase())) {
      throw new EngineError("conflict", "A connection already has that name.");
    }
    return name;
  }

  private persist(link: Live): void {
    this.host.store.save(link.row);
  }

  private changed(link: Live, words?: string): void {
    link.published = JSON.stringify(this.view(link));
    this.host.changed(this.list());
    if (words) this.host.note(`Connection ${link.row.name}: ${words}`);
  }

  change(args: ConnectionChange): ConnectionChangeResult {
    if (this.stopped) throw new EngineError("conflict", "Pobots is stopping.");
    if (args.action === "start") {
      if (this.rows.size >= MAX_LINKS) throw new EngineError("conflict", "Remove a connection before starting another.");
      const name = this.name(args.name);
      const ownName = this.host.name().replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, 60) || "Pobots";
      const identity = makeIdentity(ownName, this.base, this.host.now());
      const link = { row: { name, identity }, due: 0, failures: 0, attempts: [] };
      this.persist(link);
      this.rows.set(identity.invite.id, link);
      this.changed(link, "pairing code created");
      this.ensureTimer();
      return { state: this.list(), id: identity.invite.id, code: pairingCode(identity.invite) };
    }
    const link = this.get(args.id);
    const r = link.row;
    switch (args.action) {
      case "code":
        if (r.identity.invite.at + LINK_DAY <= this.host.now() || r.confirmed) {
          throw new EngineError("conflict", "That pairing code can no longer be used. Start a new connection to make one.");
        }
        return { state: this.list(), id: args.id, code: pairingCode(r.identity.invite) };
      case "connect": {
        if (r.peer || r.identity.invite.at + LINK_DAY <= this.host.now()) throw new EngineError("conflict", "This pairing code can no longer be used. Start a new connection to make one.");
        if (args.code.length > LINK_CODE_MAX + 10) throw new EngineError("bad_request", "That pairing code is not complete or has a typo.");
        const now = this.host.now();
        const peer = input(() => readPairingCode(args.code.trim(), now, this.loopback));
        if (peer.base?.startsWith("http:") && peer.base !== this.options.loopbackPeer) throw new EngineError("bad_request", "That pairing code does not have a public address.");
        if (!r.identity.invite.base && !peer.base) throw new EngineError("bad_request", "One Pobots needs a public address. See publicBase in the setup guide.");
        if (this.rows.has(peer.id)) throw new EngineError("bad_request", "Enter their pairing code. You entered your own.");
        const keys = input(() => agree(r.identity, peer));
        const next = { ...r, peer, entered: now };
        if (!this.host.store.paired(next, peer.at + LINK_DAY)) throw new EngineError("conflict", "That pairing code has already been used.");
        link.row = next;
        link.keys = keys;
        this.wake(link);
        this.changed(link, "waiting for the other side");
        break;
      }
      case "pause":
      case "resume":
        if (!r.confirmed) throw new EngineError("conflict", "Wait until both sides have connected.");
        if (!!r.paused === (args.action === "pause")) break;
        r.paused = args.action === "pause";
        this.persist(link);
        this.wake(link);
        this.changed(link, r.paused ? "paused" : "resumed");
        break;
      case "rename":
        r.name = this.name(args.name, args.id);
        this.persist(link);
        this.changed(link, "renamed");
        break;
      case "remove":
        this.remove(link);
        break;
    }
    return { state: this.list(), id: args.id };
  }

  private remove(link: Live): void {
    const r = link.row;
    if (!r.peer || !link.keys) {
      this.forget(link, "removed");
      return;
    }
    r.removing = true;
    this.persist(link);
    this.changed(link, "removed");
    // If the other side only polls, this is one chance to tell it, not a retry queue.
    link.removeTimer = setTimeout(() => this.forget(link), 5_000);
    link.removeTimer.unref();
    this.wake(link);
  }

  private forget(link: Live, words?: string): void {
    const id = link.row.identity.invite.id;
    if (!this.rows.delete(id)) return;
    clearTimeout(link.removeTimer);
    link.inFlight?.abort();
    this.host.store.remove(id);
    if (this.rows.size === 0) { clearInterval(this.timer); this.timer = undefined; }
    for (const [message, waiter] of this.waiting) if (waiter.linkId === id) this.waiting.get(message)?.answer(undefined);
    if (words) this.changed(link, words);
  }

  private active(link: Live): boolean {
    return !this.stopped && this.rows.get(link.row.identity.invite.id) === link;
  }

  private eligible(link: Live, now: number): boolean {
    return !!link.keys && (!!link.row.confirmed || link.row.identity.invite.at + LINK_DAY > now);
  }

  /** Same MAC computation for an unknown id and a wrong proof. No database or key parsing here. */
  preflight(id: string, proof: string): Proof | undefined {
    if (!LINK_ID.test(id) || proof.length !== 138) return;
    const link = this.rows.get(id);
    const now = this.host.now();
    const auth = checkAuth(link?.keys?.receive.auth ?? this.dummy, id, proof, now);
    if (!auth || !link || this.stopped || !this.eligible(link, now)) return;
    this.attempts = this.attempts.filter(at => now - at < 1_000);
    link.attempts = link.attempts.filter(at => now - at < 60_000);
    if (this.attempts.length >= 32 || link.attempts.length >= 100 ||
        link.attempts.filter(at => now - at < 1_000).length >= 4) return;
    this.attempts.push(now);
    link.attempts.push(now);
    return { id, exchange: auth.exchange, digest: auth.digest };
  }

  /** Called after the HTTP layer has bounded the body. All refusals before authentication are opaque. */
  receive(proof: Proof, body: Buffer): { status: number; body: Buffer } | undefined {
    const link = this.rows.get(proof.id);
    const now = this.host.now();
    if (!link?.keys || !this.active(link) || !this.eligible(link, now) || body.length > LINK_BODY_MAX || !payloadDigest(body).equals(proof.digest)) return;
    const req = readLinkRequest(open(link.keys, "request", proof.id, proof.exchange, body), now);
    if (!req || this.host.store.repeat(proof.id, proof.exchange, now)) return;
    const finish = (response: LinkResponse, status = 200) =>
      ({ status, body: seal(link.keys!, "response", proof.id, proof.exchange, response) });
    if (req.remove || link.row.removing) {
      const result = finish({ state: "removed" });
      this.forget(link, link.row.removing ? undefined : "removed by the other side");
      return result;
    }
    this.reached(link, now);
    this.peerPaused(link, req.paused === true);
    if (!link.row.peer?.base) {
      if (req.ack) this.sent(link, req.ack);
      if (req.refused && this.host.store.sent(proof.id, req.refused)) {
        this.delivered.get(req.refused)?.("limited");
        this.waiting.get(req.refused)?.answer(undefined);
        this.host.note(`Connection ${link.row.name}: a message was refused because the other Pobots received too many messages`);
      }
    }
    if (link.row.paused) return finish({ state: "paused" }, 409);
    if (req.message) {
      const receipt = this.accept(link, req.message, now);
      if (receipt === "limited") return finish({ state: "limited" }, 429);
      if (receipt === "unavailable") return finish({ state: "unavailable" }, 503);
    }
    const next = req.ready && !link.row.peer?.base ? this.next(link, now) : undefined;
    return finish({ state: "ok", ...(req.message ? { accepted: req.message.id } : {}), ...(next ? { message: next } : {}) });
  }

  private peerPaused(link: Live, paused: boolean): void {
    if (!!link.row.peerPaused === paused) return;
    link.row.peerPaused = paused;
    this.persist(link);
  }

  private reached(link: Live, now: number): void {
    const r = link.row;
    const changed = !r.confirmed || !r.contact || now - r.contact > UNREACHED_MS;
    const first = !r.confirmed;
    link.failures = 0;
    r.confirmed ??= now;
    // Save contacts at most once a heartbeat on successful polls.
    if (changed || now - (r.contact ?? 0) >= HEARTBEAT_MS) {
      r.contact = now;
      this.persist(link);
      if (changed) this.changed(link, first ? "connected" : undefined);
    }
  }

  private accept(link: Live, message: LinkMessage, now: number): "ok" | "limited" | "unavailable" {
    const id = link.row.identity.invite.id;
    if (this.host.store.seen(id, message.id)) return "ok";
    if (!this.host.ready()) return "unavailable";
    if (this.host.store.rate(id, now - 60_000) >= 6 || this.host.store.rate(id, now - 3_600_000) >= 30) return "limited";
    this.host.store.receive(id, message, randomUUID(), now);
    link.row.lastMessage = now;
    this.persist(link);
    this.changed(link);
    this.deliverInbox();
    return "ok";
  }

  private deliverInbox(): void {
    for (const { linkId, itemId, message } of this.host.store.pending()) {
      const link = this.rows.get(linkId);
      if (!link || link.row.paused || link.row.removing) continue;
      const waiter = message.replyTo && this.waiting.get(message.replyTo);
      if (waiter && waiter.linkId === linkId) waiter.answer(message.text);
      else if (!this.host.deliver(linkId, link.row.name, itemId, message)) continue;
      this.host.store.handed(linkId, message.id);
    }
  }

  private wake(link: Live): void {
    link.due = 0;
    if (this.timer && !link.inFlight) this.pump(link, this.host.now());
  }

  private tick(): void {
    if (this.stopped || !this.host.store.isOpen) { clearInterval(this.timer); this.timer = undefined; return; }
    const now = this.host.now();
    if (now >= this.cleanup) {
      this.cleanup = now + 60_000;
      this.host.store.prune(now, LINK_DAY + LINK_CLOCK_SKEW, LINK_CLOCK_SKEW * 2 + 60_000);
      for (const link of this.rows.values()) this.next(link, now);
    }
    this.deliverInbox();
    for (const link of this.rows.values()) {
      if (!link.row.removing && JSON.stringify(this.view(link)) !== link.published) this.changed(link);
      this.pump(link, now);
    }
  }

  private next(link: Live, now: number): LinkMessage | undefined {
    let first: LinkMessage | undefined;
    const id = link.row.identity.invite.id;
    for (const message of this.host.store.outbox(id)) {
      if (message.at + LINK_DAY <= now) {
        this.host.store.sent(id, message.id);
        this.delivered.get(message.id)?.("unreached");
        this.host.note(`Connection ${link.row.name}: a message was dropped after waiting 24 hours`);
      } else {
        first ??= message;
        break;
      }
    }
    return first;
  }

  private sent(link: Live, messageId: string): void {
    if (!this.host.store.sent(link.row.identity.invite.id, messageId)) return;
    link.row.lastMessage = this.host.now();
    this.persist(link);
    this.changed(link);
    this.delivered.get(messageId)?.("delivered");
  }

  private pump(link: Live, now: number): void {
    if (!this.active(link) || link.inFlight || link.due > now) return;
    if (link.row.removing && !link.removeTimer) {
      // We stopped during a best effort removal; do not try a second time on restart.
      this.forget(link);
      return;
    }
    const peer = link.row.peer;
    if (!peer?.base || !link.keys || !this.eligible(link, now)) return;
    const controller = new AbortController();
    link.inFlight = controller;
    void this.exchange(link, peer.base, peer.id, link.keys, controller.signal).catch(() => {
      if (this.active(link)) {
        link.failures++;
        link.due = this.host.now() + Math.min(HEARTBEAT_MS, PULL_MS * Math.max(1, link.failures));
      }
    }).finally(() => {
      if (link.inFlight === controller) link.inFlight = undefined;
    });
  }

  private async exchange(link: Live, base: string, peerId: string, keys: LinkKeys, signal: AbortSignal): Promise<void> {
    const r = link.row;
    const now = this.host.now();
    const oldAck = r.ack;
    const oldRefused = r.refused;
    const poll = !r.identity.invite.base;
    const message = !r.paused && !r.peerPaused && !r.removing && r.confirmed ? this.next(link, now) : undefined;
    const req: LinkRequest = r.removing ? { remove: true } : {
      ...(r.paused ? { paused: true } : poll && this.host.ready() ? { ready: true } : {}),
      ...(oldAck ? { ack: oldAck } : {}), ...(oldRefused ? { refused: oldRefused } : {}), ...(message ? { message } : {}),
    };
    const id = randomUUID();
    const body = seal(keys, "request", peerId, id, req);
    let res;
    try {
      res = await this.fetch(base, peerId, makeAuth(keys.send.auth, peerId, now, id, payloadDigest(body)), body, signal);
    } finally {
      if (req.remove && this.active(link)) this.forget(link);
    }
    if (!this.active(link)) return;
    const answer = readLinkResponse(open(keys, "response", peerId, id, res.body), this.host.now());
    if (!answer || res.status !== ({ ok: 200, removed: 200, paused: 409, limited: 429, unavailable: 503 }[answer.state])) throw new Error("The other Pobots did not answer");
    if (answer.state === "removed") {
      this.forget(link, "removed by the other side");
      return;
    }
    this.reached(link, this.host.now());
    this.peerPaused(link, answer.state === "paused");
    if (oldAck && oldAck === r.ack) {
      delete r.ack;
      this.persist(link);
    }
    if (oldRefused && oldRefused === r.refused) { delete r.refused; this.persist(link); }
    if (message && answer.accepted === message.id) this.sent(link, message.id);
    else if (message && (answer.state === "paused" || answer.state === "limited")) this.delivered.get(message.id)?.(answer.state);
    if (poll && answer.message && !r.paused && !r.removing) {
      const receipt = this.accept(link, answer.message, this.host.now());
      if (receipt === "ok") r.ack = answer.message.id;
      else if (receipt === "limited") r.refused = answer.message.id;
      if (receipt !== "unavailable") this.persist(link);
    }
    const wait = answer.state === "limited" ? 60_000 : answer.state === "paused" || answer.state === "unavailable" ? HEARTBEAT_MS
      : poll || (!r.paused && this.next(link, this.host.now())) ? PULL_MS : HEARTBEAT_MS;
    link.due = this.host.now() + wait;
  }

  async message(to: string, mode: "ask" | "tell", text: string, signal?: AbortSignal, waitMs?: number): Promise<MessageResult> {
    const link = this.named(to);
    const r = link.row;
    if (!r.confirmed) throw new EngineError("conflict", "Wait until both sides have connected.");
    if (r.paused) throw new EngineError("conflict", "That connection is paused. Resume it before sending.");
    if (r.peerPaused) return { delivery: "paused" };
    if (!text.trim() || text.length > LINK_TEXT_MAX) throw new EngineError("bad_request", "Write a message of 1 to 20,000 characters.");
    if (signal?.aborted || this.stopped) throw new EngineError("conflict", "The message was stopped.");
    const message = { id: randomUUID(), kind: mode, text, at: this.host.now() };
    this.queue(link, message);
    const answer = mode === "ask" ? this.awaitAnswer(link, message.id, signal, waitMs) : undefined;
    const receipt = r.peer?.base ? new Promise<Delivery>(resolve => {
      const finish = (state: Delivery) => {
        clearTimeout(timer);
        this.delivered.delete(message.id);
        resolve(state);
      };
      const timer = setTimeout(() => finish(this.view(link).state === "unreached" ? "unreached" : "queued"), 5_000);
      this.delivered.set(message.id, finish);
    }) : Promise.resolve<Delivery>("queued");
    this.wake(link);
    const delivery = await receipt;
    if (delivery === "paused" || delivery === "limited") {
      this.host.store.sent(r.identity.invite.id, message.id);
      this.waiting.get(message.id)?.answer(undefined);
      return { delivery };
    }
    if (!answer) return { delivery };
    const textAnswer = await answer;
    return textAnswer ? { delivery: "delivered", answer: textAnswer } : { delivery, late: true };
  }

  private awaitAnswer(link: Live, id: string, signal?: AbortSignal, waitMs?: number): Promise<string | undefined> {
    return new Promise(resolve => {
      const abort = () => finish(undefined);
      const finish = (text: string | undefined) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiting.delete(id);
        resolve(text);
      };
      const timer = setTimeout(abort, waitMs ?? this.options.askMs ?? ASK_MS);
      timer.unref();
      this.waiting.set(id, { linkId: link.row.identity.invite.id, answer: finish });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private queue(link: Live, message: LinkMessage): void {
    const id = link.row.identity.invite.id;
    this.next(link, this.host.now());
    if (this.host.store.outbox(id).length >= MAX_QUEUE) throw new EngineError("conflict", "There are already 50 messages waiting for that connection.");
    this.host.store.queue(id, message);
  }

  reply(id: string, messageId: string, text: string): void {
    if (this.stopped) return;
    const link = this.rows.get(id);
    if (!link || link.row.removing || link.row.paused) return;
    try {
      this.queue(link, { id: randomUUID(), kind: "answer", replyTo: messageId, at: this.host.now(),
        text: text.trim().slice(0, LINK_TEXT_MAX) || "The other main bot finished without an answer." });
      this.wake(link);
    } catch {
      this.host.note(`Connection ${link.row.name}: the answer could not be queued`);
    }
  }
}
