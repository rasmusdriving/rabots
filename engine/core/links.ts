// Pairing, durable delivery and the engine's small link protocol. No request data is logged.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionChange, ConnectionChangeResult, ConnectionsState, PobotsConnection } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { dropOut, FileProblem, Incoming, readChunk, snapshot, type Picked } from "./link-files.js";
import { readLinkRequest, readLinkResponse, type LinkChunk, type LinkPos, type LinkReject, type LinkRequest, type LinkResponse } from "./link-frames.js";
import { linkFetch, type LinkFetch } from "./link-http.js";
import { due, endsAt, ENDED_KEEP_MS, isLasts, lastsChange, lastsWords } from "./link-lasts.js";
import type { InboxMessage, LinkRow, LinkStore } from "./link-store.js";
import {
  agree, checkAuth, LINK_CLOCK_SKEW, LINK_CODE_MAX, LINK_DAY, LINK_ID, LINK_TEXT_MAX,
  linkBase, linkBodyMax, linkName, makeAuth, makeIdentity, open, pairingCode, payloadDigest, readPairingCode, seal,
  type LinkKeys, type LinkMessage, type LinkWire,
} from "./link-wire.js";

const PULL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const UNREACHED_MS = 45_000;
const ASK_MS = 600_000;
const MAX_LINKS = 24;
const MAX_QUEUE = 50;
/** Between two pieces of a file: under the receiver's 4 a second and 100 a minute. */
const PIECE_MS = 650;
/** After a Pobots answered only on wire 1, wire 2 is tried again this much later (and at once when files wait). */
const PROBE_MS = 600_000;
/** After a first 404 on wire 2: soon again, past the other side's per-second limit. */
const REPROBE_MS = 3_000;
const FILES_WAIT_MS = 60_000;
const HOUR = 3_600_000;
/** What a bot is told when the other side cannot take files. */
export const updateWords = (name: string) => `${name}'s Pobots must update to 0.44.0 or later before it can take files.`;

type Live = {
  row: LinkRow;
  keys?: LinkKeys;
  due: number;
  failures: number;
  inFlight?: AbortController;
  attempts: number[];
  removeTimer?: ReturnType<typeof setTimeout>;
  published?: string;
  /** Where the receiver asked this side's file message to go on. */
  sending?: { id: string; pos: LinkPos };
  /** Poll side: what to tell the other side about the file message it is sending. */
  got?: LinkPos;
  reject?: LinkReject;
  /** When wire 2 is tried again after a wire 1 answer, and how often the other side has been heard. */
  probeAt?: number;
  heard?: number;
  fallbacks?: number;
};
type Waiter = { linkId: string; answer: (answer: string | undefined) => void };
type Delivery = "delivered" | "queued" | "unreached" | "paused" | "limited" | "refused" | "ended";
type Proof = { id: string; exchange: string; digest: Buffer; wire: LinkWire };
type MessageResult = { delivery: Delivery; answer?: string; late?: boolean; reason?: string };
type Answer = { status: number; body: Buffer };
class NotFound extends Error {}

/**
 * Who hears a line. Absent: the main bot (managing a connection). `owner`: the connection's saved
 * owner (sending on it), the main bot when none; `both`: the owner and the main bot (it ended).
 */
export type Audience = { owner?: string; both?: boolean };

/** 0.44.0: which bot a connection belongs to. A saved owner is a bot id; absent means the main bot. */
export interface LinkOwners {
  /** The bot it belongs to now: the saved one, or the main bot when none is saved or that bot is gone. */
  of: (saved: string | undefined) => string;
  /** A new owner, checked: undefined for the main bot (saved as none), else the bot's id. Throws in plain words. */
  check: (owner: string) => string | undefined;
  name: (botId: string) => string;
  /** Its messages wait: the bot is on vacation. */
  held: (saved: string | undefined) => boolean;
  /** A bot's connections changed: its tools may change from its next turn. */
  moved: (botIds: string[]) => void;
}

export interface LinksHost {
  store: LinkStore;
  name: () => string;
  publicBase?: string;
  now: () => number;
  changed: (state: ConnectionsState) => void;
  note: (sentence: string, to?: Audience) => void;
  /** For the bot's next turn. */
  news?: (sentence: string, to?: Audience) => void;
  deliver: (id: string, name: string, itemId: string, message: InboxMessage, owner: string | undefined) => boolean;
  ready: () => boolean;
  /** Where files are copied and received; the bot whose upload a received file becomes. Without it this Pobots neither sends nor takes files. */
  files?: { dataDir: string; botId: (linkId: string) => string | undefined };
  owners?: LinkOwners;
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
  private delivered = new Map<string, (status: Delivery, reason?: string) => void>();
  private waiting = new Map<string, Waiter>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private started = false;
  private cleanup = 0;
  private readonly base: string | null;
  private readonly loopback: boolean;
  private readonly fetch: LinkFetch;
  private readonly incoming?: Incoming;

  private readonly host: LinksHost;
  private readonly options: LinksOptions;

  constructor(host: LinksHost, options: LinksOptions = {}) {
    this.host = host;
    this.options = options;
    this.loopback = !!options.loopbackPeer || !!options.loopbackBase;
    const base = options.loopbackBase || host.publicBase;
    this.base = base ? linkBase(base.replace(/\/$/, ""), this.loopback) : null;
    this.fetch = options.fetch ?? linkFetch(options.loopbackPeer);
    if (host.files) this.incoming = new Incoming(host.files.dataDir, host.files.botId);
    for (const row of host.store.rows()) {
      const id = row.identity.invite.id;
      const keys = row.peer ? agree(row.identity, row.peer) : undefined;
      this.rows.set(id, { row, keys, due: 0, failures: 0, attempts: [] });
    }
    // After the rows: a message still waiting keeps its copies.
    if (host.files) this.tidyOut(host.files.dataDir);
  }

  /** Copies of files whose message is no longer waiting (a stop at the wrong moment) are thrown away. */
  private tidyOut(dataDir: string): void {
    try {
      const root = join(dataDir, "link-out");
      if (!existsSync(root)) return;
      for (const linkId of readdirSync(root)) {
        const waiting = this.rows.has(linkId) ? new Set(this.host.store.outbox(linkId).map(m => m.id)) : new Set<string>();
        for (const messageId of readdirSync(join(root, linkId))) if (!waiting.has(messageId)) dropOut(dataDir, linkId, messageId);
        if (!this.rows.has(linkId)) dropOut(dataDir, linkId);
      }
    } catch {
      // only tidying
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
    this.incoming?.clear();
  }

  list(): ConnectionsState {
    return { hasPublicAddress: !!this.base, connections: [...this.rows.values()]
      .filter(l => !l.row.removing).map(l => this.view(l)) };
  }

  private view(link: Live): PobotsConnection {
    const r = link.row;
    const now = this.host.now();
    const expires = r.identity.invite.at + LINK_DAY;
    const state = r.ended ? "ended"
      : !r.confirmed && expires <= now ? "expired"
      : r.paused ? "paused"
      : !r.peer ? "draft"
      : !r.confirmed ? (link.failures >= 3 && now - (r.entered ?? now) > UNREACHED_MS ? "unreached" : "waiting")
      : !r.contact || (now - r.contact > UNREACHED_MS) ? "unreached" : "connected";
    const ends = r.ended ? undefined : endsAt(r);
    return { id: r.identity.invite.id, name: r.name, state, expiresAt: new Date(expires).toISOString(),
      ...(r.contact ? { lastReached: new Date(r.contact).toISOString() } : {}),
      ...(r.lastMessage ? { lastMessage: new Date(r.lastMessage).toISOString() } : {}),
      lasts: r.lasts ?? "never", owner: this.ownerOf(r),
      ...(ends !== undefined ? { endsAt: new Date(ends).toISOString() } : {}),
      ...(r.ended ? { endedAt: new Date(r.ended).toISOString(), endedBy: r.endedBy ?? "time" } : {}) };
  }

  private ownerOf(r: LinkRow): string {
    return this.host.owners?.of(r.owner) ?? r.owner ?? "";
  }

  /** The saved owner of a connection, for routing its received files. */
  ownerFor(linkId: string): string | undefined {
    return this.rows.get(linkId)?.row.owner;
  }

  /** The connections a bot may send on (by its id), for its tools. */
  owned(botId: string): PobotsConnection[] {
    return this.list().connections.filter(c => c.owner === botId);
  }

  /** A bot was retired: its connections go back to the main bot, each with a quiet line. */
  release(botId: string, botName: string): void {
    for (const link of this.rows.values()) {
      if (link.row.owner !== botId) continue;
      delete link.row.owner;
      this.persist(link);
      this.stopWaiting(link);
      this.changed(link, `belongs to ${this.ownerName(link.row)} again, because ${botName} was retired`);
    }
  }

  private ownerName(r: LinkRow): string {
    return this.host.owners?.name(this.ownerOf(r)) ?? "the main bot";
  }

  /** Asks sent on it stop waiting; a later answer comes as a message to whoever owns it then. */
  private stopWaiting(link: Live): void {
    const id = link.row.identity.invite.id;
    for (const waiter of [...this.waiting.values()]) if (waiter.linkId === id) waiter.answer(undefined);
  }

  private get(id: string): Live {
    const link = this.rows.get(id);
    if (!link || link.row.removing) throw new EngineError("not_found", "That connection was not found.");
    return link;
  }

  /** By id or name. With `caller`, only that bot's own connections count, and a wrong name lists them. */
  private named(to: string, caller?: string): Live {
    const mine = (l: Live) => !l.row.removing && (caller === undefined || this.ownerOf(l.row) === caller);
    const byId = this.rows.get(to);
    if (byId && mine(byId)) return byId;
    const matches = [...this.rows.values()].filter(l => mine(l) && l.row.name.toLowerCase() === to.trim().toLowerCase());
    if (matches.length === 1) return matches[0]!;
    if (caller === undefined) throw new EngineError("not_found", "That connection was not found. Use list_connections to see its name or id.");
    const own = [...this.rows.values()].filter(mine).map(l => l.row.name);
    const exists = (byId && !byId.row.removing) || [...this.rows.values()].some(l => !l.row.removing && l.row.name.toLowerCase() === to.trim().toLowerCase());
    const yours = own.length ? `Your connections: ${own.join(", ")}.` : "You have no connection of your own to send on.";
    throw new EngineError("not_found", `${exists ? "That connection belongs to another bot, and only that bot sends on it." : "That connection was not found."} ${yours}`);
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

  /** A line about sending on it: to the bot it belongs to. */
  private noteOwner(link: Live, words: string): void {
    this.host.note(`Connection ${link.row.name}: ${words}`, { owner: link.row.owner });
  }

  change(args: ConnectionChange): ConnectionChangeResult {
    if (this.stopped) throw new EngineError("conflict", "Pobots is stopping.");
    if (args.action === "start") {
      if (this.rows.size >= MAX_LINKS) throw new EngineError("conflict", "Remove a connection before starting another.");
      const name = this.name(args.name);
      if (args.lasts !== undefined && !isLasts(args.lasts)) throw new EngineError("bad_request", "Choose 24h, 30d or never.");
      const ownName = this.host.name().replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, 60) || "Pobots";
      const owner = args.owner === undefined ? undefined : this.host.owners?.check(args.owner) ?? args.owner;
      const identity = makeIdentity(ownName, this.base, this.host.now());
      const row: LinkRow = { name, identity, lasts: args.lasts ?? "never", ...(owner ? { owner } : {}) };
      const link = { row, due: 0, failures: 0, attempts: [] };
      this.persist(link);
      this.rows.set(identity.invite.id, link);
      this.changed(link, owner ? `pairing code created, belongs to ${this.ownerName(row)}` : "pairing code created");
      if (owner) this.host.owners?.moved([owner]);
      this.ensureTimer();
      return { state: this.list(), id: identity.invite.id, code: pairingCode(identity.invite) };
    }
    const link = this.get(args.id);
    const r = link.row;
    if (r.ended && args.action !== "remove") throw new EngineError("conflict", "That connection has ended. Remove it, and pair again with new codes to connect again.");
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
      case "lasts": {
        if (!isLasts(args.lasts)) throw new EngineError("bad_request", "Choose 24h, 30d or never.");
        const before = r.lasts ?? "never";
        if (before === args.lasts) break;
        r.lasts = args.lasts;
        if (r.confirmed) r.lastsFrom = this.host.now(); else delete r.lastsFrom;
        this.persist(link);
        this.changed(link, lastsChange(args.lasts, before));
        break;
      }
      case "owner": {
        const next = this.host.owners ? this.host.owners.check(args.owner) : args.owner;
        if (next === r.owner) break;
        const before = this.ownerOf(r);
        const saved = r.owner;
        if (next) r.owner = next; else delete r.owner;
        const after = this.ownerOf(r);
        this.persist(link);
        if (after !== before) this.stopWaiting(link);
        this.changed(link, `belongs to ${this.ownerName(r)} now`);
        this.host.owners?.moved([...new Set([before, after, ...(saved ? [saved] : [])])]);
        break;
      }
      case "remove":
        this.remove(link);
        break;
    }
    return { state: this.list(), id: args.id };
  }

  private remove(link: Live): void {
    const r = link.row;
    if (!r.peer || !link.keys || r.ended) {
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
    this.incoming?.drop(id);
    if (this.host.files) dropOut(this.host.files.dataDir, id);
    if (this.rows.size === 0) { clearInterval(this.timer); this.timer = undefined; }
    for (const [message, waiter] of this.waiting) if (waiter.linkId === id) this.waiting.get(message)?.answer(undefined);
    if (words) this.changed(link, words);
    if (link.row.owner) this.host.owners?.moved([link.row.owner]);
  }

  private active(link: Live): boolean {
    return !this.stopped && this.rows.get(link.row.identity.invite.id) === link;
  }

  private eligible(link: Live, now: number): boolean {
    return !!link.keys && (!!link.row.confirmed || link.row.identity.invite.at + LINK_DAY > now);
  }

  /** Same MAC computation for an unknown id and a wrong proof. No database or key parsing here. */
  preflight(id: string, proof: string, wire: LinkWire = 1): Proof | undefined {
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
    return { id, exchange: auth.exchange, digest: auth.digest, wire };
  }

  /** Called after the HTTP layer has bounded the body. All refusals before authentication are opaque. */
  async receive(proof: Proof, body: Buffer): Promise<Answer | undefined> {
    const link = this.rows.get(proof.id);
    const now = this.host.now();
    const wire = proof.wire;
    if (!link?.keys || !this.active(link) || !this.eligible(link, now) || body.length > linkBodyMax(wire) || !payloadDigest(body).equals(proof.digest)) return;
    const keys = link.keys;
    const req = readLinkRequest(open(keys, "request", proof.id, proof.exchange, body, wire), now, wire);
    if (!req || this.host.store.repeat(proof.id, proof.exchange, now)) return;
    const finish = (response: LinkResponse, status = 200): Answer =>
      ({ status, body: seal(keys, "response", proof.id, proof.exchange, response, wire) });
    const r = link.row;
    this.heard(link, wire);
    if (r.ended) {
      // An ended copy answers like a removed one; a Pobots on wire 2 also learns that the time is up.
      if (!r.endTold) { r.endTold = true; this.persist(link); }
      return finish({ state: "removed", ...(wire === 2 ? { ended: true } : {}) });
    }
    if (req.remove || r.removing) {
      const result = finish({ state: "removed" });
      if (req.ended && !r.removing) this.end(link, "other");
      else this.forget(link, r.removing ? undefined : "removed by the other side");
      return result;
    }
    this.reached(link, now);
    this.peerPaused(link, req.paused === true);
    if (!r.peer?.base) {
      if (req.ack) this.sent(link, req.ack);
      if (req.refused && this.host.store.sent(proof.id, req.refused)) {
        this.delivered.get(req.refused)?.("limited");
        this.waiting.get(req.refused)?.answer(undefined);
        this.host.note(`Connection ${r.name}: a message was refused because the other Pobots received too many messages`, { owner: r.owner });
      }
      if (req.got) this.onGot(link, req.got);
      if (req.reject) this.refused(link, req.reject.message, req.reject.reason, true);
    }
    if (r.paused) return finish({ state: "paused" }, 409);
    let taken: Pick<LinkResponse, "accepted" | "got" | "reject"> = {};
    if (req.message) {
      const receipt = await this.accept(link, req.message, now, req.chunk);
      if (receipt === "limited") return finish({ state: "limited" }, 429);
      if (receipt === "unavailable") return finish({ state: "unavailable" }, 503);
      taken = receipt === "ok" ? { accepted: req.message.id } : receipt;
      if (!this.active(link)) return finish({ state: "removed" });
    }
    const next = req.ready && !r.peer?.base ? this.outgoing(link, this.host.now(), wire) : undefined;
    return finish({ state: "ok", ...taken, ...next });
  }

  private heard(link: Live, wire: LinkWire): void {
    link.heard = (link.heard ?? 0) + 1;
    if (link.row.peerWire === wire) return;
    link.row.peerWire = wire;
    this.persist(link);
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

  private async accept(link: Live, message: LinkMessage, now: number, chunk?: LinkChunk):
      Promise<"ok" | "limited" | "unavailable" | { got: LinkPos } | { reject: LinkReject }> {
    const id = link.row.identity.invite.id;
    if (this.host.store.seen(id, message.id)) return "ok";
    if (!this.host.ready()) return "unavailable";
    const limited = () => this.host.store.rate(id, now - 60_000) >= 6 || this.host.store.rate(id, now - HOUR) >= 30;
    let stored: InboxMessage = message;
    if (message.files) {
      // A message with files counts as one message; its files also count against the bytes an hour.
      const reject = (reason: string) => ({ reject: { message: message.id, reason } });
      const incoming = this.incoming;
      if (!incoming) return reject("This Pobots does not take files.");
      if (!incoming.has(id, message.id)) {
        if (limited()) return "limited";
        const why = Incoming.head(message.files, this.host.store.fileBytes(id, now - HOUR, message.id));
        if (why) return reject(why);
        this.host.store.countFiles(id, message.id, message.files.reduce((n, f) => n + f.size, 0), now);
        const pos = incoming.begin(id, message);
        if (!chunk) return { got: pos };
      }
      const taken = await incoming.take(id, chunk, new Date(now).toISOString());
      if ("busy" in taken) return "unavailable";
      if ("reject" in taken) return reject(taken.reject);
      if ("got" in taken) return { got: taken.got };
      // Uploads left behind here are cleaned with every unsent upload after a day.
      if (!this.active(link) || this.host.store.seen(id, message.id)) return "ok";
      stored = { ...message, uploads: taken.done };
    } else if (limited()) return "limited";
    this.host.store.receive(id, stored, randomUUID(), now);
    link.row.lastMessage = now;
    this.persist(link);
    this.changed(link);
    this.deliverInbox();
    return "ok";
  }

  /** Paused connections and those whose bot is on vacation keep their messages; they never hold up the others. */
  private held(link: Live): boolean {
    return !!link.row.paused || !!link.row.removing || !!this.host.owners?.held(link.row.owner);
  }

  private deliverInbox(): void {
    const skip = [...this.rows].filter(([, l]) => this.held(l)).map(([id]) => id);
    for (const { linkId, itemId, message } of this.host.store.pending(skip)) {
      const link = this.rows.get(linkId);
      if (!link || this.held(link)) continue;
      const waiter = message.replyTo && !message.uploads && this.waiting.get(message.replyTo);
      if (waiter && waiter.linkId === linkId) waiter.answer(message.text);
      else if (!this.host.deliver(linkId, link.row.name, itemId, message, link.row.owner)) continue;
      this.host.store.handed(linkId, message.id);
    }
  }

  /** A bot came back from vacation: its messages go to it now. */
  flush(): void {
    if (!this.stopped && this.host.store.isOpen) this.deliverInbox();
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
    for (const link of [...this.rows.values()]) {
      if (due(link.row, now)) this.end(link, "time");
      else if (link.row.ended && now - link.row.ended >= ENDED_KEEP_MS) {
        // An ended connection goes by itself after a week.
        this.forget(link);
        this.host.changed(this.list());
        continue;
      }
      if (!link.row.removing && JSON.stringify(this.view(link)) !== link.published) this.changed(link);
      this.pump(link, now);
    }
  }

  /** This side's time is up ("time"), or the other side said its time is up ("other"). */
  private end(link: Live, by: "time" | "other"): void {
    const r = link.row;
    const id = r.identity.invite.id;
    r.ended = this.host.now();
    r.endedBy = by;
    r.endTold = by === "other";
    this.persist(link);
    for (const message of this.host.store.outbox(id)) {
      this.host.store.sent(id, message.id);
      this.delivered.get(message.id)?.("ended");
    }
    for (const waiter of this.waiting.values()) if (waiter.linkId === id) waiter.answer(undefined);
    this.incoming?.drop(id);
    if (this.host.files) dropOut(this.host.files.dataDir, id);
    link.sending = undefined;
    link.failures = 0;
    const words = by === "time" ? `ended after ${lastsWords(r.lasts)}` : "ended by the other side";
    this.changed(link, words);
    this.host.news?.(`Connection ${r.name}: ${words}. It no longer sends or takes messages. To connect again, the two people pair again with new codes.`, { owner: r.owner, both: true });
    if (by === "time") this.wake(link);
  }

  private next(link: Live, now: number): LinkMessage | undefined {
    let first: LinkMessage | undefined;
    const id = link.row.identity.invite.id;
    for (const message of this.host.store.outbox(id)) {
      if (message.at + LINK_DAY <= now) {
        this.host.store.sent(id, message.id);
        if (message.files && this.host.files) dropOut(this.host.files.dataDir, id, message.id);
        this.delivered.get(message.id)?.("unreached");
        this.noteOwner(link, "a message was dropped after waiting 24 hours");
      } else {
        first ??= message;
        break;
      }
    }
    return first;
  }

  /** The message this side sends next, with the piece of a file the receiver asked for. */
  private outgoing(link: Live, now: number, wire: LinkWire): { message: LinkMessage; chunk?: LinkChunk } | undefined {
    const message = this.next(link, now);
    if (!message) return;
    if (!message.files) return { message };
    // A message with files waits for wire 2; nothing behind it overtakes it.
    if (wire !== 2 || !this.host.files) return;
    const s = link.sending;
    if (!s || s.id !== message.id) return { message };
    const chunk = readChunk(this.host.files.dataDir, link.row.identity.invite.id, message, s.pos);
    if (chunk) return { message, chunk };
    this.refused(link, message.id, "The copy of the files on this Pobots is gone. Send them again.", false);
    return this.outgoing(link, now, wire);
  }

  private onGot(link: Live, pos: LinkPos): void {
    if (this.host.store.outbox(link.row.identity.invite.id)[0]?.id === pos.message) link.sending = { id: pos.message, pos };
  }

  private sent(link: Live, messageId: string): void {
    const id = link.row.identity.invite.id;
    if (!this.host.store.sent(id, messageId)) return;
    if (link.sending?.id === messageId) link.sending = undefined;
    if (this.host.files) dropOut(this.host.files.dataDir, id, messageId);
    link.row.lastMessage = this.host.now();
    this.persist(link);
    this.changed(link);
    this.delivered.get(messageId)?.("delivered");
  }

  /** A message with files that will not go: the bot is told in its tool's answer, or at its next turn. */
  private refused(link: Live, messageId: string, reason: string, fromPeer: boolean): void {
    const id = link.row.identity.invite.id;
    if (!this.host.store.sent(id, messageId)) return;
    if (this.host.files) dropOut(this.host.files.dataDir, id, messageId);
    if (link.sending?.id === messageId) link.sending = undefined;
    this.waiting.get(messageId)?.answer(undefined);
    const told = fromPeer ? `The other Pobots said (JSON string): ${JSON.stringify(reason)}` : reason;
    const finish = this.delivered.get(messageId);
    if (finish) { finish("refused", told); return; }
    this.noteOwner(link, `a message with files was not taken. ${fromPeer ? `The other Pobots said: ${reason}` : reason}`);
    this.host.news?.(`Connection ${link.row.name}: a message with files was not taken. ${told}`, { owner: link.row.owner });
  }

  private pump(link: Live, now: number): void {
    if (!this.active(link) || link.inFlight || link.due > now) return;
    if (link.row.removing && !link.removeTimer) {
      // We stopped during a best effort removal; do not try a second time on restart.
      this.forget(link);
      return;
    }
    const peer = link.row.peer;
    if (link.row.ended && (link.row.endTold || !peer?.base)) return;
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

  /** Wire 2 first. A Pobots before 0.44.0 answers 404 there, and the same exchange goes again on wire 1. */
  private async exchange(link: Live, base: string, peerId: string, keys: LinkKeys, signal: AbortSignal): Promise<void> {
    const r = link.row;
    const now = this.host.now();
    const head = this.host.store.outbox(r.identity.invite.id)[0];
    const wire: LinkWire = r.peerWire === 1 && (link.probeAt ?? 0) > now && !head?.files ? 1 : 2;
    try {
      try {
        await this.exchangeOn(link, base, peerId, keys, signal, wire);
        if (wire === 2) link.fallbacks = 0;
      } catch (err) {
        if (!(err instanceof NotFound) || wire !== 2 || !this.active(link)) throw err;
        await this.exchangeOn(link, base, peerId, keys, signal, 1);
        link.fallbacks = (link.fallbacks ?? 0) + 1;
        // One 404 is no proof of an older Pobots: a side that has not pressed Connect yet, or that is
        // over its per-second limit, answers wire 2 the same. Only a second one in a row waits long.
        link.probeAt = this.host.now() + (link.fallbacks >= 2 ? PROBE_MS : REPROBE_MS);
        if (head?.files && link.fallbacks >= 3) {
          link.fallbacks = 0;
          this.refused(link, head.id, updateWords(r.name), false);
        }
      }
    } finally {
      if (r.removing && this.active(link)) this.forget(link);
    }
  }

  private async exchangeOn(link: Live, base: string, peerId: string, keys: LinkKeys, signal: AbortSignal, wire: LinkWire): Promise<void> {
    const r = link.row;
    const now = this.host.now();
    const oldAck = r.ack;
    const oldRefused = r.refused;
    const oldGot = wire === 2 ? link.got : undefined;
    const oldReject = wire === 2 ? link.reject : undefined;
    const poll = !r.identity.invite.base;
    const out = !r.paused && !r.peerPaused && !r.removing && !r.ended && r.confirmed ? this.outgoing(link, now, wire) : undefined;
    const message = out?.message;
    const req: LinkRequest = r.removing ? { remove: true } : r.ended ? { remove: true, ...(wire === 2 ? { ended: true } : {}) } : {
      ...(r.paused ? { paused: true } : poll && this.host.ready() ? { ready: true } : {}),
      ...(oldAck ? { ack: oldAck } : {}), ...(oldRefused ? { refused: oldRefused } : {}),
      ...(oldGot ? { got: oldGot } : {}), ...(oldReject ? { reject: oldReject } : {}), ...(out ?? {}),
    };
    const id = randomUUID();
    const body = seal(keys, "request", peerId, id, req, wire);
    const long = !!message?.files || !!oldGot;
    const res = await this.fetch(base, peerId, makeAuth(keys.send.auth, peerId, now, id, payloadDigest(body)), body, signal, wire, long);
    if (!this.active(link)) return;
    if (res.status === 404) throw new NotFound("The other Pobots did not answer");
    const answer = readLinkResponse(open(keys, "response", peerId, id, res.body, wire), this.host.now(), wire);
    if (!answer || res.status !== ({ ok: 200, removed: 200, paused: 409, limited: 429, unavailable: 503 }[answer.state])) throw new Error("The other Pobots did not answer");
    this.heard(link, wire);
    if (r.ended) {
      r.endTold = true;
      this.persist(link);
      return;
    }
    if (answer.state === "removed") {
      if (answer.ended && !r.removing) this.end(link, "other");
      else this.forget(link, "removed by the other side");
      return;
    }
    this.reached(link, this.host.now());
    this.peerPaused(link, answer.state === "paused");
    if (oldAck && oldAck === r.ack) {
      delete r.ack;
      this.persist(link);
    }
    if (oldRefused && oldRefused === r.refused) { delete r.refused; this.persist(link); }
    if (oldGot && oldGot === link.got) link.got = undefined;
    if (oldReject && oldReject === link.reject) link.reject = undefined;
    if (message && answer.accepted === message.id) this.sent(link, message.id);
    else if (message && answer.reject?.message === message.id) this.refused(link, message.id, answer.reject.reason, true);
    else if (message?.files && answer.got?.message === message.id) link.sending = { id: message.id, pos: answer.got };
    else if (message && (answer.state === "paused" || answer.state === "limited")) this.delivered.get(message.id)?.(answer.state);
    let moving = !!message?.files && answer.state === "ok";
    if (poll && answer.message && !r.paused && !r.removing && !r.ended) {
      const receipt = await this.accept(link, answer.message, this.host.now(), answer.chunk);
      if (!this.active(link)) return;
      if (receipt === "ok") r.ack = answer.message.id;
      else if (receipt === "limited") r.refused = answer.message.id;
      else if (typeof receipt === "object" && "got" in receipt) { link.got = receipt.got; moving = true; }
      else if (typeof receipt === "object") link.reject = receipt.reject;
      if (receipt === "ok" || receipt === "limited") this.persist(link);
    }
    const wait = answer.state === "limited" ? 60_000 : answer.state === "paused" || answer.state === "unavailable" ? HEARTBEAT_MS
      : moving || link.reject ? PIECE_MS
      : poll || (!r.paused && this.next(link, this.host.now())) ? PULL_MS : HEARTBEAT_MS;
    link.due = this.host.now() + wait;
  }

  /** Makes sure the other side's wire is fresh before files go: a try on wire 2, or its next calls.
   *  A side that only receives waits for a few of them: after a passing 404 the other side's next
   *  call or two can still come on wire 1 before it tries wire 2 again. */
  private async wireKnown(link: Live): Promise<void> {
    if (link.row.peerWire === 2) return;
    const before = link.heard ?? 0;
    const calls = link.row.peer?.base ? 1 : 3;
    link.probeAt = 0;
    const end = Date.now() + 8_000;
    const fresh = () => link.row.peerWire as LinkWire | undefined === 2;
    while (Date.now() < end && !fresh() && (link.heard ?? 0) - before < calls && this.active(link)) {
      if (!link.inFlight) this.wake(link);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /** `caller`: the bot sending; it may only send on its own connections. */
  async message(to: string, mode: "ask" | "tell", text: string, signal?: AbortSignal, waitMs?: number, files?: Picked[], caller?: string): Promise<MessageResult> {
    const link = this.named(to, caller);
    const r = link.row;
    const linkId = r.identity.invite.id;
    if (r.ended) throw new EngineError("conflict", "That connection has ended. To connect again, the two people pair again with new codes.");
    if (!r.confirmed) throw new EngineError("conflict", "Wait until both sides have connected.");
    if (r.paused) throw new EngineError("conflict", "That connection is paused. Resume it before sending.");
    if (r.peerPaused) return { delivery: "paused" };
    if (!text.trim() || text.length > LINK_TEXT_MAX) throw new EngineError("bad_request", "Write a message of 1 to 20,000 characters.");
    if (signal?.aborted || this.stopped) throw new EngineError("conflict", "The message was stopped.");
    const id = randomUUID();
    let sending: LinkMessage["files"];
    if (files?.length) {
      const dataDir = this.host.files?.dataDir;
      if (!dataDir) throw new EngineError("conflict", "This Pobots cannot send files.");
      await this.wireKnown(link);
      if (r.peerWire !== 2) throw new EngineError("conflict", `${updateWords(r.name)} Nothing was sent. Send the text without files, or ask ${r.name} to update.`);
      if (signal?.aborted || !this.active(link)) throw new EngineError("conflict", "The message was stopped.");
      try {
        sending = snapshot(dataDir, linkId, id, files);
      } catch (err) {
        throw new EngineError("bad_request", err instanceof FileProblem ? `${err.message} Nothing was sent.` : "The files could not be copied for sending. Nothing was sent.");
      }
    }
    const message: LinkMessage = { id, kind: mode, text, at: this.host.now(), ...(sending ? { files: sending } : {}) };
    try {
      this.queue(link, message);
    } catch (err) {
      if (sending && this.host.files) dropOut(this.host.files.dataDir, linkId, id);
      throw err;
    }
    const answer = mode === "ask" ? this.awaitAnswer(link, id, signal, waitMs) : undefined;
    // A message with files waits longer for its receipt: the pieces take a while.
    const receipt = r.peer?.base || sending ? new Promise<{ state: Delivery; reason?: string }>(resolve => {
      const later = () => finish(this.view(link).state === "unreached" ? "unreached" : "queued");
      const finish = (state: Delivery, reason?: string) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", later);
        this.delivered.delete(id);
        resolve({ state, reason });
      };
      const timer = setTimeout(later, sending ? Math.min(waitMs ?? FILES_WAIT_MS, FILES_WAIT_MS) : 5_000);
      // A stopped turn does not wait for the pieces; they go on, and a refusal comes as a note.
      signal?.addEventListener("abort", later, { once: true });
      this.delivered.set(id, finish);
    }) : Promise.resolve<{ state: Delivery; reason?: string }>({ state: "queued" });
    this.wake(link);
    const { state: delivery, reason } = await receipt;
    if (delivery === "paused" || delivery === "limited" || delivery === "refused" || delivery === "ended") {
      if (this.host.store.sent(linkId, id) && sending && this.host.files) dropOut(this.host.files.dataDir, linkId, id);
      this.waiting.get(id)?.answer(undefined);
      return { delivery, ...(reason ? { reason } : {}) };
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
    if (!link || link.row.removing || link.row.paused || link.row.ended) return;
    try {
      this.queue(link, { id: randomUUID(), kind: "answer", replyTo: messageId, at: this.host.now(),
        text: text.trim().slice(0, LINK_TEXT_MAX) || "The other bot finished without an answer." });
      this.wake(link);
    } catch {
      this.noteOwner(link, "the answer could not be queued");
    }
  }
}
