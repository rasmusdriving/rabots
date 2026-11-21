// Engine 0.45.0 (protocol 36): the changelog of a public Pobots (docs/build/step-changelog.md).
// The parser, the choice of versions between the running one and the new one, the limits, and the
// words for the main bot. A changelog that is missing or broken gives no notes, never an error.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { CHANGELOG_MAX_BYTES, hasEntry, noteFor, notesWords, parseChangelog, pickNotes, plain, readChangelog, NOTES_MAX_CHARS, NOTES_MAX_ITEMS, NOTES_MAX_VERSIONS } from "../core/changelog.js";
import { ENGINE_VERSION } from "../engine.js";
import { tempDir } from "./helpers.js";

const LOG = `# What's new in Pobots

Some words before the first version.

## 0.46.0 (22 Nov 2026)

- Something **new** with [a link](https://example.com).
- A long bullet that
  goes on on the next line.

### Fixed

* A fix in \`code\`.

## 0.45.1

- A small fix.

## 0.45.0 (21 Nov 2026)

- What's new shows before an update.

## 0.44.0 (20 Nov 2026)

- Files over a connection.
`;

describe("engine 0.45.0: the changelog", () => {
  test("parses versions, dates, bullets, continuation lines and Markdown marks", () => {
    const all = parseChangelog(LOG);
    assert.deepEqual(all.map((n) => n.version), ["0.46.0", "0.45.1", "0.45.0", "0.44.0"]);
    assert.equal(all[0]!.date, "22 Nov 2026");
    assert.equal(all[1]!.date, undefined);
    assert.deepEqual(all[0]!.items, ["Something new with a link.", "A long bullet that goes on on the next line.", "A fix in code."]);
    assert.equal(all[0]!.totalItems, 3);
    assert.equal(plain("_quiet_ and *calm* <b>words</b>"), "quiet and calm words");
  });

  test("picks the versions newer than the running one, up to the new one, newest first", () => {
    let p = pickNotes(LOG, "0.44.0", "0.45.1");
    assert.deepEqual(p.notes.map((n) => n.version), ["0.45.1", "0.45.0"]);
    assert.equal(p.older, 0);
    p = pickNotes(LOG, "0.45.0", "0.46.0");
    assert.deepEqual(p.notes.map((n) => n.version), ["0.46.0", "0.45.1"]);
    // An order in the file that is not newest first is put right.
    const mixed = "## 0.1.0\n- one\n\n## 0.3.0\n- three\n\n## 0.2.0\n- two\n";
    assert.deepEqual(pickNotes(mixed, "0.0.9", "0.3.0").notes.map((n) => n.version), ["0.3.0", "0.2.0", "0.1.0"]);
    // Only the one version: after an update with no older version known.
    assert.equal(noteFor(LOG, "0.45.0")!.items[0], "What's new shows before an update.");
    assert.equal(noteFor(LOG, "9.9.9"), undefined);
    assert.ok(hasEntry(LOG, "0.45.1"));
    assert.ok(!hasEntry(LOG, "0.47.0"));
  });

  test("a missing, empty or broken changelog gives no notes", () => {
    assert.deepEqual(pickNotes(undefined, "0.44.0", "0.46.0"), { notes: [], older: 0 });
    assert.deepEqual(pickNotes("", "0.44.0", "0.46.0"), { notes: [], older: 0 });
    assert.deepEqual(pickNotes("\u0000\u0001 not markdown at all {]", "0.44.0", "0.46.0"), { notes: [], older: 0 });
    // A version with no bullets is left out.
    assert.deepEqual(pickNotes("## 0.46.0\n\nJust words.\n", "0.44.0", "0.46.0").notes, []);
    assert.equal(readChangelog(tempDir()), undefined);
  });

  test("keeps to the limits: versions, bullets with the true count, characters, bytes", () => {
    const many = Array.from({ length: 9 }, (_, i) => `## 1.0.${9 - i}\n${Array.from({ length: 12 }, (_, j) => `- Change ${j} ${"x".repeat(j === 0 ? 400 : 5)}`).join("\n")}\n`).join("\n");
    const p = pickNotes(many, "1.0.0", "1.0.9");
    assert.equal(p.notes.length, NOTES_MAX_VERSIONS);
    assert.equal(p.older, 9 - NOTES_MAX_VERSIONS);
    assert.equal(p.notes[0]!.version, "1.0.9");
    assert.equal(p.notes[0]!.items.length, NOTES_MAX_ITEMS);
    assert.equal(p.notes[0]!.totalItems, 12);
    assert.ok(p.notes[0]!.items[0]!.length <= NOTES_MAX_CHARS);
    assert.ok(p.notes[0]!.items[0]!.endsWith("..."));
    // A huge file is read only to its limit.
    const dir = tempDir();
    writeFileSync(join(dir, "CHANGELOG.md"), `## 2.0.0\n- First.\n${"- filler\n".repeat(60_000)}`);
    const read = readChangelog(dir)!;
    assert.equal(Buffer.byteLength(read), CHANGELOG_MAX_BYTES);
    assert.equal(noteFor(read, "2.0.0")!.items[0], "First.");
  });

  test("words for the main bot: newest first, a count of what was left out", () => {
    const p = pickNotes(LOG, "0.44.0", "0.46.0");
    assert.deepEqual(notesWords(p.notes, 4), ["0.46.0: Something new with a link. A long bullet that goes on on the next line. A fix in code.", "0.45.1: A small fix.", "(1 more change not listed.)"]);
    assert.deepEqual(notesWords(undefined), []);
  });

  test("the repository's own CHANGELOG.md has an entry for this version, and plain words only", () => {
    const own = readFileSync(fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)), "utf8");
    assert.ok(hasEntry(own, ENGINE_VERSION), `CHANGELOG.md has an entry for ${ENGINE_VERSION}`);
    const notes = parseChangelog(own);
    assert.ok(notes.every((n) => n.items.length > 0 && n.date), "every version has a date and bullets");
    for (const n of notes) for (const item of n.items) assert.doesNotMatch(item, /[—–!]|\.tsx?\b|\.mjs\b/, `${n.version}: "${item}" is plain`);
  });
});
