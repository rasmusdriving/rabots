// The changelog of a public Pobots (protocol 36, docs/build/step-changelog.md).
//
// CHANGELOG.md at the repository's root is written for a person: "## 0.45.0 (21 Nov 2026)", then
// bullets. The self-update reads it at the fetched ref before an update and from the install's own
// folder after one. This file parses it and picks the versions to show. Shape and limits follow
// T3 Code's desktop release notes (apps/desktop/src/updates/releaseNotes.ts): at most 6 versions,
// 8 bullets each with the true count kept, 220 characters a bullet. A changelog that is missing or
// unreadable gives no notes, never an error.

import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseNote } from "../../shared/protocol.js";
import { newer } from "../providers.js";

export const NOTES_MAX_VERSIONS = 6;
export const NOTES_MAX_ITEMS = 8;
export const NOTES_MAX_CHARS = 220;
/** The text read from CHANGELOG.md is cut to this many bytes before it is parsed. */
export const CHANGELOG_MAX_BYTES = 256 * 1024;

const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\b(?:\s*[(\-–—:]\s*([^)]*?)\s*\)?)?\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;

/** Simple Markdown marks out of a line: links keep their words, code, bold and italic lose their marks. */
export function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string): string {
  if (text.length <= NOTES_MAX_CHARS) return text;
  return `${text.slice(0, NOTES_MAX_CHARS - 3).trimEnd()}...`;
}

/**
 * Every version in the changelog, in the file's order, with all its bullets (not cut yet). Lines
 * that are no heading or bullet are skipped; an indented line under a bullet continues it.
 */
export function parseChangelog(text: string): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  let cur: ReleaseNote | undefined;
  let inBullet = false;
  const body = text.length > CHANGELOG_MAX_BYTES ? text.slice(0, CHANGELOG_MAX_BYTES) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    const h = HEADING.exec(line);
    if (h) {
      const version = h[1]!;
      const date = h[2]?.trim();
      const note: ReleaseNote = { version, ...(date ? { date } : {}), items: [], totalItems: 0 };
      cur = note;
      out.push(note);
      inBullet = false;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      // Another heading of the same or a higher level ends the version.
      cur = undefined;
      inBullet = false;
      continue;
    }
    if (!cur) continue;
    const b = BULLET.exec(line);
    if (b) {
      const words = plain(b[1]!);
      if (words) {
        cur.items.push(words);
        inBullet = true;
      } else inBullet = false;
      continue;
    }
    if (inBullet && /^\s{2,}\S/.test(line)) {
      const more = plain(line);
      if (more) cur.items[cur.items.length - 1] = `${cur.items[cur.items.length - 1]} ${more}`;
      continue;
    }
    if (!line.trim()) continue;
    inBullet = false;
  }
  for (const n of out) n.totalItems = n.items.length;
  return out;
}

/** One version cut to the limits, keeping the true count of bullets. */
export function cutNote(n: ReleaseNote): ReleaseNote {
  return { ...n, items: n.items.slice(0, NOTES_MAX_ITEMS).map(clip), totalItems: n.totalItems };
}

export interface PickedNotes {
  notes: ReleaseNote[];
  /** Versions in the range left out because of the limit of versions. */
  older: number;
}

/**
 * The versions newer than `after` and not newer than `upTo`, newest first, cut to the limits.
 * Versions with no bullets are left out. A missing `after` keeps only `upTo` itself.
 */
export function pickNotes(text: string | undefined, after: string | undefined, upTo: string): PickedNotes {
  if (!text) return { notes: [], older: 0 };
  let all: ReleaseNote[];
  try {
    all = parseChangelog(text);
  } catch {
    return { notes: [], older: 0 };
  }
  const seen = new Set<string>();
  const inRange = all
    .filter((n) => n.items.length > 0)
    .filter((n) => (after ? newer(n.version, after) : n.version === upTo) && !newer(n.version, upTo))
    .filter((n) => (seen.has(n.version) ? false : (seen.add(n.version), true)))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
  return { notes: inRange.slice(0, NOTES_MAX_VERSIONS).map(cutNote), older: Math.max(0, inRange.length - NOTES_MAX_VERSIONS) };
}

/** The entry of one version, cut to the limits; undefined when the changelog has none. */
export function noteFor(text: string | undefined, version: string): ReleaseNote | undefined {
  return pickNotes(text, undefined, version).notes[0];
}

/** True when the changelog has an entry headed with this version (the public export asks). */
export function hasEntry(text: string, version: string): boolean {
  return parseChangelog(text).some((n) => n.version === version);
}

/**
 * The notes as plain lines for a bot: "0.45.0: first. second." per version, at most `maxItems`
 * bullets in all, newest first, with a count of what was left out.
 */
export function notesWords(notes: ReleaseNote[] | undefined, maxItems = 8): string[] {
  if (!notes?.length) return [];
  const lines: string[] = [];
  let left = maxItems;
  let skipped = 0;
  for (const n of notes) {
    const take = n.items.slice(0, Math.max(0, left));
    left -= take.length;
    skipped += n.totalItems - take.length;
    if (take.length) lines.push(`${n.version}: ${take.map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(" ")}`);
  }
  if (skipped > 0) lines.push(`(${skipped} more ${skipped === 1 ? "change" : "changes"} not listed.)`);
  return lines;
}

/** A folder's own CHANGELOG.md, at most CHANGELOG_MAX_BYTES of it; undefined when there is none. */
export function readChangelog(dir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, "CHANGELOG.md"), "r");
    const buf = Buffer.alloc(CHANGELOG_MAX_BYTES);
    const n = readSync(fd, buf, 0, CHANGELOG_MAX_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
