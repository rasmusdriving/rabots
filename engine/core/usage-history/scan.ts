// Follow T3's guarded append cursor. Stream bounded chunks in the usage worker; parse only
// candidate JSONL lines and save only projected usage and hashes, never their source text.
import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import type { HistoryProvider } from "../../../shared/protocol.js";
import { claudeRecords, fields, fingerprint } from "./records.js";
import { codexRecords, codexState, type CodexState } from "./codex-records.js";
import type { Source, UsageRecord } from "./types.js";

const CHUNK = 256 * 1024;
const MAX_LINE = 16 * 1024 * 1024;
const GUARD = 256;
const CLAUDE_MARKERS = [Buffer.from('"assistant"'), Buffer.from('"usage"')];
const CODEX_MARKERS = ['"session_meta"', '"turn_context"', '"thread_settings_applied"', '"token_count"', '"token_usage_record"'].map((v) => Buffer.from(v));
export const DAY = 86_400_000;
export const CACHE_VERSION = 2;

export interface FileEntry {
  provider: HistoryProvider;
  size: number;
  mtime: number;
  ctime: number;
  identity: string;
  offset: number;
  guard: string;
  codex: CodexState;
  records: UsageRecord[];
  tail?: UsageRecord[];
}

export interface Index {
  files: Record<string, FileEntry>;
  incomplete: HistoryProvider[];
}

const errorCode = (e: unknown) => fields(e).code;
const missing = (e: unknown) => errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR";

async function* transcripts(dir: string, issue: () => void): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (!missing(e)) issue();
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* transcripts(path, issue);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) yield path;
  }
}

async function guard(file: FileHandle, offset: number): Promise<string> {
  const hash = createHash("sha256");
  for (const start of new Set([0, Math.max(0, offset - GUARD)])) {
    const bytes = Buffer.alloc(Math.min(GUARD, offset - start));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    if (bytesRead !== bytes.length) throw new Error("History changed during read");
    hash.update(bytes);
  }
  return hash.digest("base64url");
}

function parseUsageLine(line: Buffer, provider: HistoryProvider, file: string, codex: CodexState): UsageRecord[] {
  const candidate = provider === "claude" ? CLAUDE_MARKERS.every((k) => line.includes(k)) : CODEX_MARKERS.some((k) => line.includes(k));
  if (!candidate) return [];
  let raw: unknown;
  try { raw = JSON.parse(line.toString("utf8")); } catch { return []; }
  return provider === "claude" ? claudeRecords(fields(raw), file) : codexRecords(fields(raw), codex);
}

async function readFileUsage(path: string, key: string, provider: HistoryProvider, listed: Stats, old: FileEntry | undefined, cutoff: number): Promise<FileEntry> {
  const identity = fingerprint(listed.dev, listed.ino, listed.birthtimeMs);
  if (old?.identity === identity && old.mtime === listed.mtimeMs && old.ctime === listed.ctimeMs && old.size === listed.size) return old;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || fingerprint(info.dev, info.ino, info.birthtimeMs) !== identity) throw new Error("History changed during read");
    const compressed = path.endsWith(".zst");
    const append = !compressed && old?.identity === identity && info.size > old.size && await guard(file, old.offset) === old.guard;
    const codex = append ? structuredClone(old.codex) : codexState(key);
    const records = append ? old.records.filter((r) => r.at >= cutoff) : [];
    let offset = append ? old.offset : 0;
    let position = offset;
    let pending: Buffer[] = [];
    let length = 0;
    const buffer = Buffer.allocUnsafe(CHUNK);
    const consume = (chunk: Buffer) => {
      const bytesRead = chunk.length;
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? bytesRead : newline;
        const part = chunk.subarray(start, end);
        length += part.length;
        if (newline < 0) {
          if (length <= MAX_LINE) pending.push(Buffer.from(part));
          else pending = [];
          break;
        }
        if (length <= MAX_LINE) {
          const line = pending.length ? Buffer.concat([...pending, part], length) : part;
          for (const event of parseUsageLine(line, provider, key, codex)) if (event.at >= cutoff) records.push(event);
        }
        pending = [];
        length = 0;
        start = newline + 1;
        offset = position + start;
      }
      position += bytesRead;
    };
    if (compressed && info.size > 0) {
      // Compressed transcripts are written by the harness on archive. Stream them once;
      // a changed archive is reread because a compressed byte offset is not a line cursor.
      const input = file.createReadStream({ start: 0, end: info.size - 1, autoClose: false });
      const stream = input.compose(createZstdDecompress());
      for await (const chunk of stream) consume(chunk as Buffer);
    } else if (!compressed) {
      while (position < info.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) throw new Error("History changed during read");
        consume(buffer.subarray(0, bytesRead));
      }
    }

    // A valid last line can lack a newline. Show it now, but keep the cursor and the
    // parser state before it so a future append replaces it rather than counting it twice.
    const tail = pending.length > 0
      ? parseUsageLine(Buffer.concat(pending, length), provider, key, structuredClone(codex)).filter((r) => r.at >= cutoff)
      : [];
    const check = await file.stat();
    if (check.size < info.size || (check.size === info.size && (check.mtimeMs !== info.mtimeMs || check.ctimeMs !== info.ctimeMs))) throw new Error("History changed during read");
    return { provider, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, identity, offset, codex, records, ...(tail.length ? { tail } : {}), guard: compressed ? "" : await guard(file, offset) };
  } finally {
    await file.close();
  }
}

export async function scanHistory(sources: Source[], previous: Index, now: number): Promise<Index> {
  // Slack before the first calendar day also allows for host time zone differences.
  const cutoff = now - 92 * DAY;
  const next: Index = { files: {}, incomplete: [] };
  const seen = new Set<string>();
  for (const source of sources) {
    const issue = () => { if (!next.incomplete.includes(source.provider)) next.incomplete.push(source.provider); };
    let dir: string;
    try { dir = await realpath(source.dir); } catch (e) { if (!missing(e)) issue(); continue; }
    const rootKey = fingerprint(source.provider, dir);
    if (seen.has(rootKey)) continue;
    seen.add(rootKey);
    for await (const path of transcripts(dir, issue)) {
      const key = fingerprint(rootKey, path);
      const old = previous.files[key];
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff || !info.isFile()) continue;
        next.files[key] = await readFileUsage(path, key, source.provider, info, old, cutoff);
      } catch (e) {
        if (missing(e)) continue;
        issue();
        if (old) next.files[key] = old;
      }
    }
  }
  return next;
}
