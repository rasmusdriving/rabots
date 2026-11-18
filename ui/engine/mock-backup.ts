// The mock engine's nightly backup (job 5): the state as the engine keeps it, the check of a pasted
// public key with the engine's own sentences (docs/build/notes-backup-groundwork.md, section 2), a
// run that takes about a second and ends saved, unconfirmed or failed, and the card from Pobots
// itself after a nightly run that failed or stayed unconfirmed, or when nothing was saved for two
// days. Nothing is packed or locked: this only acts it out for the window.
//
// ?backup= picks the starting point (any scene):
//   saved        (the default) a key and a few nights, the last saved
//   none         no key yet: no backups, the roster's quiet mark
//   key          a key, no backups yet
//   unconfirmed  last night's backup stayed unconfirmed, with its card
//   failed       last night's backup failed, with its card
//   stale        a key and nothing saved for three days, with its card
//   running      a backup is under way at start (it ends saved)
//   nofolder     the OneDrive folder is not there
// Levers on window.pobotsMock: backupState, backupNext, backupRunMs, backupNight, backupStale,
// backupCard, backupFolder, backupKeyRequests.
import type { BackupRun, BackupState, Events, Methods, SystemCard } from "../../shared/protocol";
import { EngineError } from "./types";

const FOLDER = "~/Library/CloudStorage/OneDrive-Personal/Pobot";
const NOT_TAKEN = "OneDrive did not take the file. Is OneDrive running and signed in on the Mac?";
const FAILED = "Pobots could not write the file to the OneDrive folder.";
/** The engine's sentence for a folder that is missing or cannot be written (engine/backup.ts, CANNOT_WRITE). */
export const NO_FOLDER = "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.";
const KEEP = 14;

export type BackupOutcome = "saved" | "unconfirmed" | "failed";

/** What the mock engine gives the backup, to put and take its card on the rail. */
export interface BackupHost {
  emit(e: { event: "backup.changed"; data: Events["backup.changed"] }): void;
  /** Puts this card on the rail, in the place of an older one on the same topic. */
  putCard(card: SystemCard): void;
  /** Takes the topic's card away, if there is one. */
  removeCard(topic: SystemCard["topic"]): void;
  /** The id of the topic's card, or null. */
  cardOf(topic: SystemCard["topic"]): string | null;
  newId(): string;
}

/** The next 03:00 after `from`, on the local clock. */
function nextNight(from = new Date(), time = "03:00"): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** A local time `daysAgo` days ago at h:m. */
function nightsAgo(daysAgo: number, h = 3, m = 0): string {
  const d = new Date();
  // Before 03:00 "last night" has not come yet: the newest night is the one before.
  const shift = d.getHours() < h || (d.getHours() === h && d.getMinutes() < m) ? 1 : 0;
  d.setDate(d.getDate() - daysAgo - shift + 1);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const fileName = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `pobots-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}.pobotsbackup`;
};

// ------------------------------------------------------------ the pasted key

/** SHA-256, small and synchronous, for the fingerprint as `ssh-keygen -l` prints it. */
export function sha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]!);
  return out;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** The wire form of an ssh-rsa key: the type, e and n, each with its length. Null when it does not add up. */
function readRsaBlob(blob: Uint8Array): { bits: number } | null {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let at = 0;
  const part = (): Uint8Array | null => {
    if (at + 4 > blob.length) return null;
    const n = view.getUint32(at);
    at += 4;
    if (at + n > blob.length) return null;
    const p = blob.subarray(at, at + n);
    at += n;
    return p;
  };
  const type = part();
  if (!type || new TextDecoder().decode(type) !== "ssh-rsa") return null;
  const e = part();
  const n = part();
  if (!e || !n || at !== blob.length || e.length === 0 || n.length === 0) return null;
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return null;
  const bits = (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]!));
  return { bits };
}

/**
 * Checks a pasted public key as the engine does, with its sentences. Returns the fingerprint and
 * size, or throws "bad_request" with one plain sentence.
 */
export function checkPublicKey(text: string): { fingerprint: string; bits: number } {
  const bad = (message: string) => new EngineError({ code: "bad_request", message });
  const line = text.trim();
  if (!line) throw bad("Paste the public key. It starts with ssh-rsa.");
  if (/PRIVATE KEY/i.test(line)) throw bad("That is a private key. Paste the public key instead, and keep the private key in 1Password.");
  const parts = line.split(/\s+/);
  if (parts[0] === "ssh-ed25519") throw bad("That is an Ed25519 key. Make an RSA key of 4096 bits instead.");
  if (parts[0] !== "ssh-rsa") throw bad("That does not look like a public key. It should start with ssh-rsa.");
  // A key broken over lines or with spaces in it: the pieces are joined until the key is whole.
  let joined = "";
  for (const piece of parts.slice(1)) {
    joined += piece;
    const blob = fromBase64(joined);
    const rsa = blob && readRsaBlob(blob);
    if (blob && rsa) {
      if (rsa.bits < 3072) throw bad(`This RSA key has ${rsa.bits} bits. Make one of 4096 bits.`);
      return { fingerprint: `SHA256:${toBase64(sha256(blob)).replace(/=+$/, "")}`, bits: rsa.bits };
    }
  }
  throw bad("The key is incomplete. Copy the whole public key again.");
}

// ------------------------------------------------------------ the backup

export class MockBackup {
  private s: BackupState;
  private runMs = 1000;
  private next: { outcome: BackupOutcome; problem?: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A run found the folder gone (as the engine does); the next run looks again and finds it back. */
  private folderByRun = false;
  /** How many times "backup.setKey" was asked, and with what texts: a check that a private key never reaches the engine. */
  readonly keyTexts: string[] = [];

  constructor(private readonly host: BackupHost, seed: string | null) {
    this.s = { folder: { path: FOLDER, ok: true }, time: "03:00", keep: KEEP, running: false, history: [] };
    this.seed(seed ?? "saved");
  }

  state(): BackupState {
    return structuredClone(this.s);
  }

  private changed(): void {
    this.host.emit({ event: "backup.changed", data: { backup: this.state() } });
  }

  private seed(seed: string): void {
    if (seed === "none") return;
    const key = { fingerprint: "SHA256:Qm9zc2EgYmFja3VwIGtleSBmb3IgdGhlIG1vY2sgaGVyZQ", bits: 4096, savedAt: nightsAgo(5, 21, 14) };
    this.s.key = key;
    this.s.nextAt = nextNight();
    if (seed === "key") return;
    const run = (daysAgo: number, status: BackupOutcome, bytes: number, extra: Partial<BackupRun> = {}): BackupRun => {
      const at = nightsAgo(daysAgo);
      return { at, status, by: "night", ...(status !== "failed" ? { file: fileName(at), bytes } : {}), ...extra };
    };
    const older = [run(2, "saved", 3_140_000), run(3, "saved", 3_080_000), run(4, "saved", 3_010_000, { leftOut: ["inbox/downloads/export.zip"] })];
    if (seed === "stale") {
      this.s.history = [run(3, "saved", 3_080_000), run(4, "saved", 3_010_000)];
      this.s.lastGood = this.s.history[0];
      this.host.putCard(this.card("stale"));
      return;
    }
    if (seed === "unconfirmed") {
      this.s.history = [run(1, "unconfirmed", 3_210_000, { problem: NOT_TAKEN }), ...older];
      this.s.lastGood = this.s.history[0];
      this.host.putCard(this.card("unconfirmed"));
      return;
    }
    if (seed === "failed") {
      this.s.history = [run(1, "failed", 0, { problem: FAILED }), ...older];
      this.s.lastGood = older[0];
      this.host.putCard(this.card("failed", FAILED));
      return;
    }
    this.s.history = [run(1, "saved", 3_210_000), ...older];
    this.s.lastGood = this.s.history[0];
    if (seed === "nofolder") this.s.folder = { path: FOLDER, ok: false, problem: NO_FOLDER };
    if (seed === "running") {
      this.s.running = true;
      this.timer = setTimeout(() => this.finish(new Date().toISOString(), "you"), this.runMs);
    }
  }

  private card(kind: "failed" | "unconfirmed" | "stale", problem?: string): SystemCard {
    const base = { id: this.host.newId(), kind: "system" as const, topic: "backup" as const, at: new Date().toISOString() };
    if (kind === "failed") return { ...base, title: "Last night's backup failed", text: problem ?? FAILED };
    if (kind === "unconfirmed") return { ...base, title: "Last night's backup did not reach OneDrive", text: NOT_TAKEN };
    const last = this.s.lastGood ? ` The last one that reached OneDrive was made ${new Date(this.s.lastGood.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.` : "";
    return { ...base, title: "No backup for two days", text: `Pobots has not saved a backup to OneDrive for two days.${last}` };
  }

  readonly handlers: { [M in "backup.setKey" | "backup.run"]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "backup.setKey": (p) => {
      this.keyTexts.push(p.publicKey);
      const { fingerprint, bits } = checkPublicKey(p.publicKey);
      this.s.key = { fingerprint, bits, savedAt: new Date().toISOString() };
      this.s.nextAt = nextNight();
      this.changed();
      return { backup: this.state() };
    },
    "backup.run": () => {
      this.start("you");
      return { backup: this.state() };
    },
  };

  /** Starts a run, by hand or by the nightly clock. */
  start(by: BackupRun["by"]): void {
    if (this.s.running) throw new EngineError({ code: "conflict", message: "A backup is already being made." });
    if (!this.s.key) throw new EngineError({ code: "conflict", message: "Add a key first. Without it no backup can be made." });
    this.s.running = true;
    if (this.folderByRun) {
      this.folderByRun = false;
      this.s.folder = { path: FOLDER, ok: true };
    }
    this.changed();
    const at = new Date().toISOString();
    this.timer = setTimeout(() => this.finish(at, by), this.runMs);
  }

  private finish(at: string, by: BackupRun["by"]): void {
    const { outcome, problem } = this.next.shift() ?? { outcome: (this.s.folder.ok ? "saved" : "failed") as BackupOutcome };
    const bytes = 3_200_000 + Math.round(Math.random() * 80_000);
    const run: BackupRun =
      outcome === "failed"
        ? { at, status: "failed", by, problem: problem ?? (this.s.folder.ok ? FAILED : NO_FOLDER) }
        : { at, status: outcome, by, file: fileName(at), bytes, ...(outcome === "unconfirmed" ? { problem: problem ?? NOT_TAKEN } : {}) };
    // A later run looks again at earlier unconfirmed files: OneDrive has them by now.
    if (outcome === "saved") this.s.history = this.s.history.map((r) => (r.status === "unconfirmed" ? { ...r, status: "saved", problem: undefined } : r));
    this.s.history = [run, ...this.s.history].slice(0, KEEP);
    if (outcome !== "failed") this.s.lastGood = run;
    // A run that failed on the folder: the folder's state says so too, as the engine's does.
    if (outcome === "failed" && run.problem === NO_FOLDER && this.s.folder.ok) {
      this.s.folder = { path: FOLDER, ok: false, problem: NO_FOLDER };
      this.folderByRun = true;
    }
    this.s.running = false;
    this.s.nextAt = nextNight();
    this.changed();
    if (outcome === "saved") this.host.removeCard("backup");
    else if (by === "night") this.host.putCard(this.card(outcome, run.problem));
  }

  // ------------------------------------------------------------ levers

  /** The next run ends this way (they queue up). */
  setNext(outcome: BackupOutcome, problem?: string): void {
    this.next.push({ outcome, problem });
  }

  setRunMs(ms: number): void {
    this.runMs = ms;
  }

  /** The engine's clock starts the nightly run now. */
  night(): void {
    this.start("night");
  }

  /** Nothing was saved for two days: the card says so. */
  stale(): void {
    this.host.putCard(this.card("stale"));
  }

  setFolder(ok: boolean, problem?: string): void {
    this.s.folder = ok ? { path: FOLDER, ok: true } : { path: FOLDER, ok: false, problem: problem ?? NO_FOLDER };
    this.changed();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
