// Files over a connection (wire 2). The sender checks and copies the bot's files; the receiver keeps
// the pieces as an upload, checks them again by itself and hands them on like the person's
// attachments. Nothing here opens or runs a file. Followed T3 Code's apps/server/src/attachmentStore.ts
// and attachmentPaths.ts (one root, paths checked to stay in it) and PeerForwarding.ts (long work in
// bounded pieces).
import { createHash, type Hash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Attachment } from "../../shared/protocol.js";
import { ATTACH_DIR, beginUpload, PART_FILE, prepareUpload, removeUpload, sniff, sizeWords, uploadDir, type Family } from "../attachments.js";
import type { LinkChunk, LinkPos } from "./link-frames.js";
import { LINK_CHUNK, LINK_FILES_MAX, LINK_FILES_TOTAL, LINK_FILE_MAX, type LinkFile, type LinkMessage } from "./link-wire.js";

/** The kinds a connection carries, by name, and what the contents must be. */
export const LINK_KINDS: Record<string, Family> = {
  ".md": "text", ".markdown": "text", ".txt": "text", ".csv": "text", ".pdf": "pdf", ".docx": "docx",
  ".xlsx": "xlsx", ".pptx": "pptx", ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg",
};
/** Files a receiver takes on one connection in an hour. */
export const LINK_FILES_HOUR = 60 * 1024 * 1024;
const KINDS_WORDS = ".md, .markdown, .txt, .csv, .pdf, .docx, .xlsx, .pptx, .png, .jpg and .jpeg";
const SECRET_NAME = /(^|[^a-z])(secrets?|credentials?|tokens?|passwords?|passwd|id_rsa|id_ed25519|id_ecdsa|private[ ._-]?key|api[ ._-]?keys?)([^a-z]|$)/i;
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?(?!op:\/\/)[^\s"',;]{6,}/i,
];

export class FileProblem extends Error {}

/** A file the bot chose, checked: where it is and what it is called. */
export interface Picked { name: string; real: string; size: number }

/** True when a file's name says it may hold a secret. */
export function secretName(name: string): boolean {
  return SECRET_NAME.test(basename(name, extname(name))) || /^\.env/i.test(name);
}

/** True when text contents look like a private key, an API key or a password. op:// references are fine. */
export function secretText(text: string): boolean {
  return SECRET_TEXT.some(re => re.test(text));
}

/** The family a name allows, or undefined for a kind that does not travel. */
export function kindOf(name: string): Family | undefined {
  return LINK_KINDS[extname(name).toLowerCase()];
}

/** Checks the bot's paths. Throws FileProblem with a sentence for the bot; nothing is read past the checks. */
export function pickFiles(botDir: string, paths: string[]): Picked[] {
  if (paths.length > LINK_FILES_MAX) throw new FileProblem(`Send at most ${LINK_FILES_MAX} files in one message.`);
  let root = resolve(botDir);
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  const picked: Picked[] = [];
  let total = 0;
  for (const given of paths) {
    const raw = given.trim();
    if (!raw || raw.includes("\0")) throw new FileProblem("Give the path of a file in your folder.");
    const full = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
    const inside = (base: string) => full.startsWith(base + sep);
    if (!inside(root) && inside(realRoot)) root = realRoot;
    if (!inside(root)) throw new FileProblem(`${raw} is outside your folder. Only files in your own folder can be sent.`);
    const rel = relative(root, full).split(sep).join("/");
    const parts = rel.split("/");
    if (parts.slice(0, -1).some((p, i) => p.startsWith(".") && !(i === 0 && p === ATTACH_DIR)) || parts.at(-1)!.startsWith(".")) {
      throw new FileProblem(`${rel} is in a hidden folder or is a hidden file. Only ordinary files (and received attachments) can be sent.`);
    }
    const name = parts.at(-1)!;
    if (secretName(name)) throw new FileProblem(`${rel} looks like it may hold a secret, so it cannot be sent.`);
    if (!kindOf(name)) throw new FileProblem(`${rel} is not a kind that can be sent. Send ${KINDS_WORDS} files.`);
    let real: string;
    try {
      real = realpathSync(full);
      if (lstatSync(full).isSymbolicLink() || !statSync(real).isFile()) throw new Error("link");
    } catch {
      throw new FileProblem(`There is no file at ${rel} in your folder, or it is a link. Send the file itself.`);
    }
    if (!real.startsWith(realRoot + sep)) throw new FileProblem(`${rel} leads outside your folder, so it cannot be sent.`);
    const size = statSync(real).size;
    if (size < 1) throw new FileProblem(`${rel} is empty.`);
    if (size > LINK_FILE_MAX) throw new FileProblem(`${rel} is ${sizeWords(size)}. A file can be at most ${sizeWords(LINK_FILE_MAX)}.`);
    total += size;
    if (total > LINK_FILES_TOTAL) throw new FileProblem(`The files are larger than ${sizeWords(LINK_FILES_TOTAL)} together. Send fewer or smaller files.`);
    picked.push({ name, real, size });
  }
  return picked;
}

/** Why a file's bytes may not go or may not be taken, or undefined. */
export function contentProblem(name: string, buf: Buffer): string | undefined {
  const want = kindOf(name);
  const found = sniff(buf, name);
  if (!want || !found || found.family !== want) return `${name} is not what its name says.`;
  if (want === "text" && secretText(buf.toString("utf8"))) return `${name} looks like it holds a secret (a key, token or password).`;
}

export function outDir(dataDir: string, linkId: string, messageId: string): string {
  return join(dataDir, "link-out", linkId, messageId);
}

/** Copies the picked files as they are now, so later changes do not change what goes. */
export function snapshot(dataDir: string, linkId: string, messageId: string, picked: Picked[]): LinkFile[] {
  const dir = outDir(dataDir, linkId, messageId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    let total = 0;
    return picked.map((p, i) => {
      const copy = join(dir, String(i));
      copyFileSync(p.real, copy);
      const buf = readFileSync(copy);
      total += buf.length;
      if (buf.length < 1 || buf.length > LINK_FILE_MAX || total > LINK_FILES_TOTAL) throw new FileProblem(`${p.name} changed while it was being sent. Try again.`);
      const problem = contentProblem(p.name, buf);
      if (problem) throw new FileProblem(problem);
      return { name: p.name, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    });
  } catch (err) {
    dropOut(dataDir, linkId, messageId);
    throw err;
  }
}

export function dropOut(dataDir: string, linkId: string, messageId?: string): void {
  rmSync(messageId ? outDir(dataDir, linkId, messageId) : join(dataDir, "link-out", linkId), { recursive: true, force: true });
}

/** The piece the receiver asked for, or undefined when the copy is gone. */
export function readChunk(dataDir: string, linkId: string, message: LinkMessage, pos: LinkPos): LinkChunk | undefined {
  const file = message.files?.[pos.file];
  if (!file || pos.at >= file.size) return;
  const length = Math.min(LINK_CHUNK, file.size - pos.at);
  const buf = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(join(outDir(dataDir, linkId, message.id), String(pos.file)), "r");
    if (readSync(fd, buf, 0, length, pos.at) !== length) return;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { ...pos, data: buf.toString("base64") };
}

// ------------------------------------------------------------------ the receiving side

type Partial = {
  message: string;
  files: LinkFile[];
  uploads: string[];
  attachments: Attachment[];
  file: number;
  at: number;
  hash: Hash;
  busy: boolean;
};
export type Taken = { got: LinkPos } | { done: string[]; attachments: Attachment[] } | { reject: string } | { busy: true };

/** One half-received message per connection, kept in memory; its pieces are uploads (cleaned after 24 hours). */
export class Incoming {
  private partials = new Map<string, Partial>();
  private readonly dataDir: string;
  /** The bot a connection's received files belong to (its owner, or the main bot). */
  private readonly botId: (linkId: string) => string | undefined;
  constructor(dataDir: string, botId: (linkId: string) => string | undefined) {
    this.dataDir = dataDir;
    this.botId = botId;
  }

  /** Checks a file message's list before any bytes. A sentence when it does not fit. */
  static head(files: LinkFile[], bytesLastHour: number): string | undefined {
    if (files.length > LINK_FILES_MAX) return `At most ${LINK_FILES_MAX} files can be sent in one message.`;
    for (const f of files) {
      if (!kindOf(f.name)) return `${f.name} is not a kind this Pobots takes. It takes ${KINDS_WORDS} files.`;
      if (secretName(f.name)) return `${f.name} looks like it may hold a secret, so it was not taken.`;
      if (f.size > LINK_FILE_MAX) return `${f.name} is larger than ${sizeWords(LINK_FILE_MAX)}.`;
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > LINK_FILES_TOTAL) return `The files are larger than ${sizeWords(LINK_FILES_TOTAL)} together.`;
    if (bytesLastHour + total > LINK_FILES_HOUR) return `This connection has taken ${sizeWords(LINK_FILES_HOUR)} of files in the last hour. Try again later.`;
  }

  /** True when this message is being received on this connection. */
  has(linkId: string, messageId: string): boolean {
    return this.partials.get(linkId)?.message === messageId;
  }

  /** Starts (or restarts) a message's transfer. The head has been checked. */
  begin(linkId: string, message: LinkMessage): LinkPos {
    this.drop(linkId);
    this.partials.set(linkId, { message: message.id, files: message.files!, uploads: [], attachments: [], file: 0, at: 0,
      hash: createHash("sha256"), busy: false });
    return { message: message.id, file: 0, at: 0 };
  }

  /** Takes one piece. Only the piece asked for is kept; anything else gets the position again. */
  async take(linkId: string, chunk: LinkChunk | undefined, at: string): Promise<Taken> {
    const p = this.partials.get(linkId);
    if (!p || (chunk && chunk.message !== p.message)) return { reject: "The transfer was interrupted. It starts again." };
    if (p.busy) return { busy: true };
    if (!chunk || chunk.file !== p.file || chunk.at !== p.at) return { got: { message: p.message, file: p.file, at: p.at } };
    const file = p.files[p.file]!;
    const data = Buffer.from(chunk.data, "base64");
    if (data.length < 1 || p.at + data.length > file.size || (data.length !== LINK_CHUNK && p.at + data.length !== file.size)) {
      return this.fail(linkId, `${file.name} did not arrive whole.`);
    }
    p.busy = true;
    try {
      if (p.at === 0) {
        const upload = beginUpload(this.dataDir);
        p.uploads.push(upload.id);
      }
      const upload = p.uploads[p.file]!;
      appendFileSync(join(uploadDir(this.dataDir, upload), PART_FILE), data, { mode: 0o600 });
      p.hash.update(data);
      p.at += data.length;
      if (p.at < file.size) return { got: { message: p.message, file: p.file, at: p.at } };
      if (p.hash.digest("hex") !== file.sha256) return this.fail(linkId, `${file.name} did not arrive whole.`);
      const problem = contentProblem(file.name, readFileSync(join(uploadDir(this.dataDir, upload), PART_FILE)));
      if (problem) return this.fail(linkId, problem);
      const botId = this.botId(linkId);
      if (!botId) return this.fail(linkId, "This Pobots has no bot to take the files.");
      try {
        p.attachments.push(await prepareUpload(this.dataDir, upload, botId, file.name, at));
      } catch {
        return this.fail(linkId, `${file.name} could not be read.`);
      }
      p.file++;
      p.at = 0;
      p.hash = createHash("sha256");
      if (p.file < p.files.length) return { got: { message: p.message, file: p.file, at: 0 } };
      this.partials.delete(linkId);
      return { done: p.uploads, attachments: p.attachments };
    } catch {
      return this.fail(linkId, "The files could not be kept on this Pobots.");
    } finally {
      p.busy = false;
    }
  }

  private fail(linkId: string, reason: string): Taken {
    this.drop(linkId);
    return { reject: reason };
  }

  /** Throws a half-received message away. */
  drop(linkId: string): void {
    const p = this.partials.get(linkId);
    if (!p) return;
    this.partials.delete(linkId);
    for (const id of p.uploads) removeUpload(this.dataDir, id);
  }

  clear(): void {
    for (const id of [...this.partials.keys()]) this.drop(id);
  }
}
