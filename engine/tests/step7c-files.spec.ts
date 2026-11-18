// Step 7c, part 1: any file can be attached, and attachments are kept 14 days. A file Pobots does not
// read is kept as it is and the bot is told its name, kind, size and path; the daily clean-up removes
// old attachment folders from `.attachments` and nothing else; the chat then says "No longer kept".
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Attachment, UserItem } from "../../shared/protocol.js";
import { ATTACHMENT_KEEP_DAYS, ATTACHMENT_MAX_BYTES } from "../../shared/protocol.js";
import { ATTACH_WORDS, ATTACHED_HEAD, ATTACHMENT_KEEP_MS, attachmentLines, cleanOldAttachments, contentFor, kindWords, META_FILE, otherFile, READ_MAX_BYTES, sizeWords } from "../attachments.js";
import type { Engine } from "../engine.js";
import { settle, setup } from "./fake.js";
import { tempDir } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

async function upload(engine: Engine, botId: string, name: string, bytes: Buffer): Promise<Attachment> {
  const { id, part } = engine.beginUpload(botId);
  writeFileSync(part, bytes);
  return engine.finishUpload(id, botId, name);
}

/** An attachment folder as the engine makes it, sent `agoDays` ago. */
function sent(botDir: string, month: string, id: string, name: string, agoDays: number, now = Date.now()): string {
  const dir = join(botDir, ".attachments", month, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `bytes of ${name}`);
  const at = new Date(now - agoDays * DAY).toISOString();
  writeFileSync(join(dir, META_FILE), JSON.stringify({ v: 1, id, botId: "kaja", at, sentAt: at, name, kind: "file", type: "application/zip", family: "other", size: 10, file: name }));
  return dir;
}

describe("step 7c: any file", () => {
  test("the limits and words: 100 MB, 14 days, the head of the note", () => {
    assert.equal(ATTACHMENT_MAX_BYTES, 100 * 1024 * 1024);
    assert.equal(READ_MAX_BYTES, 25 * 1024 * 1024);
    assert.equal(ATTACHMENT_KEEP_DAYS, 14);
    assert.equal(ATTACHMENT_KEEP_MS, 14 * DAY);
    assert.equal(ATTACH_WORDS.tooBig("x.zip"), "x.zip is too big. A file can be up to 100 MB.");
    assert.equal(ATTACH_WORDS.notKept, "No longer kept");
    assert.match(ATTACHED_HEAD, /for 14 days; copy a file elsewhere in your folder if you need it longer/);
    assert.deepEqual(otherFile("Möten.ZIP"), { family: "other", kind: "file", type: "application/zip" });
    assert.deepEqual(otherFile("thing.bin"), { family: "other", kind: "file", type: "application/octet-stream" });
    assert.equal(kindWords("a.zip", "application/zip"), "a ZIP archive");
    assert.equal(kindWords("a.mp3", "audio/mpeg"), "a sound file (.mp3)");
    assert.equal(kindWords("a.bin", "application/octet-stream"), "a .bin file");
    assert.equal(sizeWords(3 * 1024 * 1024 + 200 * 1024), "3.2 MB");
    assert.equal(sizeWords(800), "800 bytes");
  });

  test("a zip, an unknown binary and a text file over 25 MB are taken and kept as they are; the bot gets name, kind, size, type and path", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);
    const z = await upload(engine, bot.id, "TIM möten att följa upp.zip", zipBytes);
    assert.deepEqual([z.kind, z.type, z.size], ["file", "application/zip", 204]);
    const bin = await upload(engine, bot.id, "dump.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    assert.deepEqual([bin.kind, bin.type], ["file", "application/octet-stream"]);
    const big = await upload(engine, bot.id, "huge.txt", Buffer.alloc(READ_MAX_BYTES + 10, 0x41));
    assert.deepEqual([big.kind, big.type], ["file", "application/octet-stream"], "a file over 25 MB is not read, also when it is text");
    engine.sendMessage({ botId: bot.id, text: "Here", attachments: [z.id, bin.id, big.id] });
    await settle();
    const text = sessions[0]!.sent[0]!.text;
    assert.ok(text.startsWith(`Here\n\n${ATTACHED_HEAD}\n`), text);
    const lines = text.split("\n");
    const zl = lines.find((l) => l.startsWith("- TIM möten att följa upp.zip: .attachments/"))!;
    assert.match(zl, /\(a ZIP archive, 204 bytes, type application\/zip\. Pobots does not read this kind of file for you: open it with your own tools, for example unzip it into a folder of your own\)$/);
    assert.match(lines.find((l) => l.startsWith("- dump.bin: "))!, /\(a \.bin file, 6 bytes, type application\/octet-stream\. Pobots does not read this kind of file for you: open it with your own tools\)$/);
    assert.match(lines.find((l) => l.startsWith("- huge.txt: "))!, /\(a \.txt file, 25 MB, type application\/octet-stream\./);
    assert.ok(!text.includes("<data"), "no text block for any of them");
    // The file is in the bot's folder, byte for byte.
    const zipPath = join(dirs.botsDir, bot.id, ...zl.slice(zl.indexOf(": ") + 2, zl.indexOf(" (")).split("/"));
    assert.deepEqual(readFileSync(zipPath), zipBytes);
    engine.shutdown();
    store.close();
  });

  test("a GPT bot is told the same about a zip", async () => {
    const dir = tempDir();
    const id = "att_zzzzzzzzzzzzzzzzzzzz";
    sent(dir, "2026-11", id, "a.zip", 0);
    const a: Attachment = { id, name: "a.zip", kind: "file", type: "application/zip", size: 10, path: `.attachments/2026-11/${id}/a.zip` };
    const got = await contentFor(dir, "", [a], { harness: "codex", seesPictures: true });
    assert.match(got.text, /- a\.zip: \.attachments\/2026-11\/att_z+\/a\.zip \(a ZIP archive, 10 bytes, type application\/zip\. Pobots does not read this kind of file for you: open it with your own tools, for example unzip it/);
  });
});

describe("step 7c: the 14-day clean-up", () => {
  test("only old attachment folders of the right shape go; links are not followed; nothing outside .attachments is touched", () => {
    const botDir = tempDir();
    const outside = tempDir();
    const now = Date.now();
    const old = sent(botDir, "2026-10", "att_oldoldoldoldoldold", "old.zip", 20, now);
    const fresh = sent(botDir, "2026-11", "att_newnewnewnewnewnew", "new.zip", 2, now);
    const edge = sent(botDir, "2026-11", "att_edgeedgeedgeedgeed", "edge.zip", 13.9, now);
    // The bot's own copy of the old file elsewhere in its folder, and a note of its own.
    mkdirSync(join(botDir, "keep"));
    writeFileSync(join(botDir, "keep", "old.zip"), "bytes of old.zip");
    writeFileSync(join(botDir, "AGENTS.md"), "job");
    // A folder of another shape inside .attachments, and an old attachment in a folder outside, reached by links.
    mkdirSync(join(botDir, ".attachments", "2026-10", "notes"));
    writeFileSync(join(botDir, ".attachments", "2026-10", "notes", "x.txt"), "x");
    const far = sent(outside, "2026-09", "att_farfarfarfarfarfarf", "far.zip", 40, now);
    symlinkSync(join(outside, ".attachments", "2026-09"), join(botDir, ".attachments", "2026-09"));
    symlinkSync(far, join(botDir, ".attachments", "2026-11", "att_linklinklinklinklin"));

    assert.equal(cleanOldAttachments(botDir, now), 1);
    assert.equal(existsSync(old), false, "the old attachment went");
    assert.ok(existsSync(fresh) && existsSync(edge), "younger ones stay");
    assert.equal(readFileSync(join(botDir, "keep", "old.zip"), "utf8"), "bytes of old.zip", "the bot's own copy stays");
    assert.ok(existsSync(join(botDir, "AGENTS.md")));
    assert.ok(existsSync(join(botDir, ".attachments", "2026-10", "notes", "x.txt")), "a folder of another shape stays");
    assert.ok(existsSync(far) && existsSync(join(far, "far.zip")), "nothing behind a link is removed");
    // A month folder that is left empty goes (October, now that its other folder is gone, and August).
    rmSync(join(botDir, ".attachments", "2026-10", "notes"), { recursive: true });
    sent(botDir, "2026-08", "att_augaugaugaugaugaug", "aug.zip", 90, now);
    assert.equal(cleanOldAttachments(botDir, now), 1);
    assert.deepEqual(readdirSync(join(botDir, ".attachments")).sort(), ["2026-09", "2026-11"], "the emptied October and August folders went; the link stays");
  });

  test(".attachments itself as a link: nothing is removed", () => {
    const botDir = tempDir();
    const elsewhere = tempDir();
    sent(elsewhere, "2026-01", "att_oldoldoldoldoldold", "old.zip", 300);
    symlinkSync(join(elsewhere, ".attachments"), join(botDir, ".attachments"));
    assert.equal(cleanOldAttachments(botDir), 0);
    assert.ok(existsSync(join(elsewhere, ".attachments", "2026-01", "att_oldoldoldoldoldold", "old.zip")));
  });

  test("the engine's daily pass: not in the first ten minutes, once a day; the chat then says No longer kept", async () => {
    let offset = 0;
    const { engine, store, sessions } = setup(undefined, () => true, undefined, { clock: () => Date.now() + offset });
    const bot = engine.createBot("Kaja");
    const z = await upload(engine, bot.id, "notes.zip", Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]));
    const item = engine.sendMessage({ botId: bot.id, text: "", attachments: [z.id] });
    await settle();
    sessions[0]!.reply("ok");
    await settle();
    assert.equal(engine.tidyAttachments(), 0, "not in the first ten minutes after a start");
    offset = 13 * DAY;
    assert.equal(engine.tidyAttachments(), 0, "13 days: kept");
    let read = engine.readThread({ threadId: bot.mainThreadId }).items.find((i) => i.id === item.id) as UserItem;
    assert.equal(read.attachments![0]!.missing, undefined);
    offset = 13 * DAY + 2 * 60 * 60 * 1000;
    assert.equal(engine.tidyAttachments(), 0, "the last pass was two hours ago");
    offset = 15 * DAY;
    assert.equal(engine.tidyAttachments(), 1, "a day later: 15 days old, removed");
    read = engine.readThread({ threadId: bot.mainThreadId }).items.find((i) => i.id === item.id) as UserItem;
    assert.deepEqual([read.attachments![0]!.missing, read.attachments![0]!.expired], [true, true]);
    assert.deepEqual(attachmentLines(read.attachments), [`[attached: notes.zip at ${z.path || read.attachments![0]!.path}, no longer kept]`]);
    engine.shutdown();
    store.close();
  });
});
