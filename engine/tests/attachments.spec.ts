// Pictures and files in the chat (docs/build/step-files.md): kinds by contents, the readers, the
// pictures, the HTTP routes and their rules, and a message with attachments through the engine on
// both harnesses (FakeSession for Claude, the fake app-server for Codex). No model. The outside
// programs (sips, osascript, textutil) are macOS's own and run for real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { crc32, deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { Attachment, Events, NoticeItem, UserItem } from "../../shared/protocol.js";
import { ATTACHMENT_MAX_BYTES } from "../../shared/protocol.js";
import {
  ATTACH_WORDS,
  cleanName,
  cleanOldUploads,
  columnOf,
  contentFor,
  ensureIgnored,
  extractText,
  jpegOrientation,
  MAX_SIDE_PX,
  META_FILE,
  moveOps,
  pptxRead,
  pptxText,
  sniff,
  TEXT_MAX,
  UPLOAD_CLEAN_EVERY_MS,
  UPLOADS_TOTAL_MAX,
  uploadDir,
  xlsxRead,
  xlsxText,
} from "../attachments.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { EngineServer, UPLOADS_AT_ONCE } from "../server.js";
import { codexWorld, waitFor } from "./codex-fake.js";
import { settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

// ------------------------------------------------------------ test files, made here

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A PNG of one colour. */
function png(w: number, h: number, rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateRawToZlib(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function deflateRawToZlib(raw: Buffer): Buffer {
  // zlib wrapper around a raw deflate stream: header, data, Adler-32.
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0x9c]), deflateRawSync(raw), adler]);
}

/** A one-page PDF with the lines as text (none: a page without text, like a scan). */
function pdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = ["BT", "/F1 18 Tf", "72 720 Td", "24 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A zip file (deflated parts), for Office files made by hand. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function xlsx(): Buffer {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Coffee </t></r><r><t>beans</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>The code word is walrus</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  });
}
function pptx(): Buffer {
  const slide = (texts: string[]) =>
    `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(["Second in order", "The code word is otter"]),
    "ppt/slides/slide2.xml": slide(["Welcome &lt;team&gt;"]),
  });
}

/** A Word file made by macOS itself (textutil). */
function docx(dir: string, text: string): Buffer {
  const src = join(dir, "src.txt");
  const out = join(dir, "made.docx");
  writeFileSync(src, text);
  execFileSync("/usr/bin/textutil", ["-convert", "docx", src, "-output", out]);
  return readFileSync(out);
}

/** A JPEG made by sips from a PNG, with an EXIF orientation written in by hand (6: turned 90 degrees). */
function turnedJpeg(dir: string, w: number, h: number): Buffer {
  const src = join(dir, "turn.png");
  const out = join(dir, "turn.jpg");
  writeFileSync(src, png(w, h, [20, 120, 220]));
  execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", src, "--out", out], { stdio: "ignore" });
  const jpg = readFileSync(out);
  const segs: Buffer[] = [];
  let i = 2;
  while (i < jpg.length) {
    const m = jpg[i + 1]!;
    const len = jpg.readUInt16BE(i + 2);
    if (m === 0xda) {
      segs.push(jpg.subarray(i));
      break;
    }
    if (m !== 0xe1) segs.push(jpg.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpg.subarray(0, 2), segs[0]!, seg, ...segs.slice(1)]);
}

function sipsSize(file: string): { w: number; h: number } {
  const out = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  return { w: Number(/pixelWidth:\s*(\d+)/.exec(out)![1]), h: Number(/pixelHeight:\s*(\d+)/.exec(out)![1]) };
}

// ------------------------------------------------------------ helpers for the engine

/** An upload as the server makes it, without HTTP. */
async function upload(engine: Engine, botId: string, name: string, bytes: Buffer): Promise<Attachment> {
  const { id, part } = engine.beginUpload(botId);
  writeFileSync(part, bytes);
  return engine.finishUpload(id, botId, name);
}

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const notices = (events: Ev[]) => items(events).filter((i): i is NoticeItem => i.kind === "notice").map((n) => n.text);
const userItem = (events: Ev[], id: string) => items(events).find((i): i is UserItem => i.kind === "user" && i.id === id)!;

// ------------------------------------------------------------ the pieces

describe("attachments: names and kinds", () => {
  test("a name from the person is cleaned: no path, no slashes, no leading dots, no control or shell characters, readable", () => {
    assert.equal(cleanName("Screenshot 2026-11-13 08.12.png"), "Screenshot 2026-11-13 08.12.png");
    assert.equal(cleanName("../../etc/passwd"), "passwd");
    assert.equal(cleanName("C:\\Users\\me\\report.pdf"), "report.pdf");
    assert.equal(cleanName(".bashrc"), "bashrc");
    assert.equal(cleanName("...hidden. "), "hidden");
    assert.equal(cleanName("a\u0000b\nc\u202ed.txt"), "abcd.txt");
    assert.equal(cleanName('$(rm -rf ~)`x`"q".txt'), "(rm -rf ~)-x--q-.txt", "no leading dash either, so a name never reads as an option");
    assert.equal(cleanName("Räkning för mars: del 1?.pdf"), "Räkning för mars- del 1-.pdf");
    assert.equal(cleanName(""), "file");
    assert.equal(cleanName("..."), "file");
    const long = cleanName("x".repeat(300) + ".xlsx");
    assert.equal(long.length, 120);
    assert.ok(long.endsWith(".xlsx"));
  });

  test("the kind is decided by the bytes, not by the name; SVG and HTML are text files; archives and programs are refused", () => {
    const dir = tempDir();
    assert.deepEqual(sniff(png(4, 4), "notes.txt"), { family: "png", kind: "picture", type: "image/png" });
    assert.equal(sniff(Buffer.from("just words"), "photo.png")?.kind, "file");
    assert.equal(sniff(Buffer.from("just words"), "photo.png")?.type, "text/plain");
    assert.deepEqual(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg"), { family: "text", kind: "file", type: "text/plain" });
    assert.deepEqual(sniff(Buffer.from("<html><script>alert(1)</script></html>"), "x.html"), { family: "text", kind: "file", type: "text/html" });
    assert.equal(sniff(pdf(["Hi"]), "x.bin")?.family, "pdf");
    assert.equal(sniff(docx(dir, "Hello"), "x.docx")?.family, "docx");
    assert.equal(sniff(xlsx(), "book.zip")?.family, "xlsx");
    assert.equal(sniff(pptx(), "deck")?.family, "pptx");
    assert.equal(sniff(Buffer.from("{\\rtf1 hello}"), "x.rtf")?.family, "rtf");
    assert.equal(sniff(zip({ "readme.txt": "hi" }), "archive.docx"), undefined, "a plain zip is refused, whatever its name");
    assert.equal(sniff(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]), "tool.txt"), undefined);
    assert.equal(sniff(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), "app"), undefined);
    assert.equal(sniff(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40, 0)]), "song.txt"), undefined);
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, 0)]);
    assert.equal(sniff(ole, "old.doc")?.family, "doc");
    assert.equal(sniff(ole, "old.xls")?.family, "xls");
    assert.equal(sniff(ole, "setup.msi"), undefined);
    assert.equal(sniff(Buffer.from([0xff, 0xfe, 0x41, 0x00]), "utf16.txt"), undefined, "not UTF-8 (NUL bytes): refused");
  });

  test("the readers: xlsx sheets as tab-separated lines, pptx slides in order, textutil on a real docx, PDFKit on a PDF, a PDF without text", async () => {
    const dir = tempDir();
    assert.equal(xlsxText(xlsx()), "Sheet: Budget\nItem\tCost\nCoffee beans\t\t12.5\n\nSheet: Notes & more\nThe code word is walrus\tTRUE");
    assert.equal(pptxText(pptx()), "Slide 1\nWelcome <team>\n\nSlide 2\nSecond in order\nThe code word is otter");
    const d = join(dir, "d.docx");
    writeFileSync(d, docx(dir, "The code word is heron.\nÅäö too.\n"));
    assert.deepEqual(await extractText(d, "docx"), { status: "ok", text: "The code word is heron.\nÅäö too.\n" });
    const p = join(dir, "p.pdf");
    writeFileSync(p, pdf(["Quarterly report", "The code word is lantern."]));
    const got = await extractText(p, "pdf");
    assert.equal(got.status, "ok");
    assert.match((got as { text: string }).text, /The code word is lantern\./);
    const scan = join(dir, "scan.pdf");
    writeFileSync(scan, pdf([]));
    assert.deepEqual(await extractText(scan, "pdf"), { status: "scan" });
    const broken = join(dir, "broken.pdf");
    writeFileSync(broken, Buffer.from("%PDF-1.4 nothing else"));
    assert.equal((await extractText(broken, "pdf")).status === "ok", false);
  });

  test("the unsent uploads older than a day are removed when the engine starts; newer ones stay", () => {
    const dataDir = tempDir();
    const old = uploadDir(dataDir, "att_oldoldoldoldoldold");
    const fresh = uploadDir(dataDir, "att_newnewnewnewnewnew");
    const half = uploadDir(dataDir, "att_halfhalfhalfhalfha");
    for (const d of [old, fresh, half]) mkdirSync(d, { recursive: true });
    const meta = (id: string, at: string) => JSON.stringify({ v: 1, id, botId: "b", at, name: "x.txt", kind: "file", type: "text/plain", family: "text", size: 1, file: "x.txt" });
    writeFileSync(join(old, META_FILE), meta("att_oldoldoldoldoldold", new Date(Date.now() - 25 * 3600_000).toISOString()));
    writeFileSync(join(fresh, META_FILE), meta("att_newnewnewnewnewnew", new Date().toISOString()));
    // An upload that broke off without its notes goes by the folder's age.
    writeFileSync(join(half, ".upload.part"), "x");
    const t = (Date.now() - 30 * 3600_000) / 1000;
    utimesSync(half, t, t);
    mkdirSync(join(dataDir, "uploads", "not-an-upload"));
    const { engine, store } = setup({ dataDir, botsDir: tempDir() });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(half), false);
    assert.equal(existsSync(join(dataDir, "uploads", "not-an-upload")), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(cleanOldUploads(dataDir), 0);
    engine.shutdown();
    store.close();
  });
});

describe("attachments: pictures", () => {
  test("a small PNG: its size, a preview, and the model gets the picture itself", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const a = await upload(engine, bot.id, "image.png", png(432, 176));
    assert.equal(a.kind, "picture");
    assert.equal(a.type, "image/png");
    assert.equal(a.width, 432);
    assert.equal(a.height, 176);
    assert.equal(a.path, "");
    assert.match(a.id, /^att_[a-z0-9]{20}$/);
    const dir = uploadDir(dirs.dataDir, a.id);
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
    assert.deepEqual(meta.model, { file: "image.png", type: "image/png" });
    assert.equal(meta.preview, ".preview.jpg");
    assert.deepEqual(sipsSize(join(dir, ".preview.jpg")), { w: 432, h: 176 }, "a small picture is never made larger");
    engine.shutdown();
    store.close();
  });

  test("a big picture gets a model copy of at most 2000 px and a preview of at most 1024 px", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const a = await upload(engine, bot.id, "wide.png", png(3000, 600));
    const dir = uploadDir(dirs.dataDir, a.id);
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
    assert.deepEqual(meta.model, { file: ".model.jpg", type: "image/jpeg" });
    assert.deepEqual(sipsSize(join(dir, ".model.jpg")), { w: 2000, h: 400 });
    assert.deepEqual(sipsSize(join(dir, ".preview.jpg")), { w: 1024, h: 205 });
    engine.shutdown();
    store.close();
  });

  test("a photo turned by its EXIF orientation: width and height upright, copies turned upright and no longer marked turned", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const bytes = turnedJpeg(tempDir(), 400, 100);
    assert.equal(jpegOrientation(bytes), 6);
    const a = await upload(engine, bot.id, "photo.jpg", bytes);
    assert.equal(a.width, 100);
    assert.equal(a.height, 400);
    const dir = uploadDir(dirs.dataDir, a.id);
    for (const f of [".preview.jpg", ".model.jpg"]) {
      assert.deepEqual(sipsSize(join(dir, f)), { w: 100, h: 400 }, f);
      assert.equal(jpegOrientation(readFileSync(join(dir, f))), 1, f);
    }
    engine.shutdown();
    store.close();
  });

  test("TIFF and BMP are converted to PNG, HEIC to JPEG, and named so; a broken picture and an unknown kind are kept as files (step 7c)", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const tmp = tempDir();
    writeFileSync(join(tmp, "a.png"), png(40, 30));
    execFileSync("/usr/bin/sips", ["-s", "format", "tiff", join(tmp, "a.png"), "--out", join(tmp, "a.tiff")], { stdio: "ignore" });
    const t = await upload(engine, bot.id, "scan.tiff", readFileSync(join(tmp, "a.tiff")));
    assert.equal(t.name, "scan.png");
    assert.equal(t.type, "image/png");
    assert.equal(t.width, 40);
    // A phone photo (HEIC) becomes a JPEG; a BMP a PNG. Both made by sips here.
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", join(tmp, "a.png"), "--out", join(tmp, "a.heic")], { stdio: "ignore" });
    const h = await upload(engine, bot.id, "IMG_0001.HEIC", readFileSync(join(tmp, "a.heic")));
    assert.deepEqual([h.name, h.type, h.width, h.height], ["IMG_0001.jpg", "image/jpeg", 40, 30]);
    execFileSync("/usr/bin/sips", ["-s", "format", "bmp", join(tmp, "a.png"), "--out", join(tmp, "a.bmp")], { stdio: "ignore" });
    const b = await upload(engine, bot.id, "old.bmp", readFileSync(join(tmp, "a.bmp")));
    assert.deepEqual([b.name, b.type, b.width], ["old.png", "image/png", 40]);
    const brokenPng = png(40, 30).subarray(0, 30);
    // Step 7c: a picture that does not open is kept as the file it is, its bytes unchanged; a zip too.
    const cut = await upload(engine, bot.id, "cut.png", brokenPng);
    assert.deepEqual([cut.name, cut.kind, cut.type, cut.size, cut.width], ["cut.png", "file", "application/octet-stream", 30, undefined]);
    assert.deepEqual(readdirSync(uploadDir(dirs.dataDir, cut.id)).sort(), [".meta.json", "cut.png"]);
    assert.deepEqual(readFileSync(join(uploadDir(dirs.dataDir, cut.id), "cut.png")), brokenPng);
    const z = await upload(engine, bot.id, "tool.zip", zip({ "a.txt": "a" }));
    assert.deepEqual([z.name, z.kind, z.type], ["tool.zip", "file", "application/zip"]);
    engine.shutdown();
    store.close();
  });
});

// ------------------------------------------------------------ HTTP

const TOKEN = "test-token-0123456789";
const LOGIN = "someone@example.com";
const HOST = "mac.example.ts.net";

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function http(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: Buffer; chunked?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers = { ...(o.headers ?? {}) };
    if (o.body && !o.chunked) headers["Content-Length"] = String(o.body.length);
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("error", (err) => reject(err));
    if (o.body && o.chunked) {
      // Sent in pieces without a length, the way a stream would be.
      let at = 0;
      const step = 1024 * 1024;
      const more = () => {
        while (at < o.body!.length) {
          const piece = o.body!.subarray(at, at + step);
          at += step;
          if (!req.write(piece)) return void req.once("drain", more);
        }
        req.end();
      };
      req.on("error", () => undefined);
      more();
    } else req.end(o.body);
  });
}

const openServers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of openServers.splice(0)) await close().catch(() => undefined);
});

async function serverWorld() {
  const w = setup();
  const server = new EngineServer(TOKEN, { allowedLogins: [LOGIN] });
  server.attach(w.engine);
  const port = await server.listen(0);
  const bot = w.engine.createBot("Kaja");
  let closed = false;
  const done = async () => {
    if (closed) return;
    closed = true;
    await server.close();
    w.engine.shutdown();
    w.store.close();
  };
  // Closed at the end also when a test failed half way, so nothing keeps the run waiting.
  openServers.push(done);
  return { ...w, server, port, bot, done };
}

const tailnet = { "Tailscale-User-Login": LOGIN, Host: HOST, Origin: `https://${HOST}` };
const up = (botId: string, name: string) => `/api/attachments?bot=${encodeURIComponent(botId)}&name=${encodeURIComponent(name)}`;

describe("attachments: the HTTP routes", () => {
  test("POST passes the socket's own rule: no token and no login refused, another origin refused, the page's own origin and the token let in", async () => {
    const w = await serverWorld();
    const body = png(20, 10);
    assert.equal((await http(w.port, up(w.bot.id, "a.png"), { method: "POST", body })).status, 401, "no token, no login");
    assert.equal((await http(w.port, up(w.bot.id, "a.png") + "&token=wrong", { method: "POST", body })).status, 401, "a wrong token");
    assert.equal((await http(w.port, up(w.bot.id, "a.png"), { method: "POST", body, headers: { ...tailnet, Origin: "https://evil.example.com" } })).status, 401, "another origin");
    assert.equal((await http(w.port, up(w.bot.id, "a.png"), { method: "POST", body, headers: { "Tailscale-User-Login": LOGIN, Host: HOST } })).status, 401, "no origin at all");
    assert.equal((await http(w.port, up(w.bot.id, "a.png"), { method: "POST", body, headers: { ...tailnet, "Tailscale-User-Login": "other@example.com" } })).status, 401, "a login not on the list");
    const ok = await http(w.port, up(w.bot.id, "a.png"), { method: "POST", body, headers: tailnet });
    assert.equal(ok.status, 200);
    const a = (JSON.parse(ok.body.toString()) as { attachment: Attachment }).attachment;
    assert.equal(a.kind, "picture");
    assert.equal(a.width, 20);
    const local = await http(w.port, up(w.bot.id, "b.png") + `&token=${TOKEN}`, { method: "POST", body });
    assert.equal(local.status, 200);
    assert.equal((await http(w.port, up("nobody", "a.png") + `&token=${TOKEN}`, { method: "POST", body })).status, 404);
    assert.equal((await http(w.port, `/api/attachments?name=a.png&token=${TOKEN}`, { method: "POST", body })).status, 400);
    assert.equal((await http(w.port, `/api/attachments?token=${TOKEN}`, { method: "PUT", body })).status, 405);
    await w.done();
  });

  test("the limits: over 100 MB by its length or by what came, with the words and no file left; any kind is taken (step 7c)", async () => {
    const w = await serverWorld();
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x41);
    const byLength = await http(w.port, up(w.bot.id, "big.txt") + `&token=${TOKEN}`, { method: "POST", body: big });
    assert.equal(byLength.status, 413);
    assert.deepEqual(JSON.parse(byLength.body.toString()), { error: { code: "too_large", message: "big.txt is too big. A file can be up to 100 MB." } });
    let streamed: Answer | undefined;
    try {
      streamed = await http(w.port, up(w.bot.id, "big.txt") + `&token=${TOKEN}`, { method: "POST", body: big, chunked: true });
    } catch {
      // The engine may close the connection while the rest is still being sent.
    }
    if (streamed) {
      assert.equal(streamed.status, 413);
      assert.equal(JSON.parse(streamed.body.toString()).error.code, "too_large");
    }
    // Exactly the limit is fine.
    const edge = await http(w.port, up(w.bot.id, "edge.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x41) });
    assert.equal(edge.status, 200);
    const song = await http(w.port, up(w.bot.id, "song.mp3") + `&token=${TOKEN}`, { method: "POST", body: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100, 0)]) });
    assert.equal(song.status, 200);
    const sa = (JSON.parse(song.body.toString()) as { attachment: Attachment }).attachment;
    assert.deepEqual([sa.name, sa.kind, sa.type, sa.size], ["song.mp3", "file", "audio/mpeg", 103]);
    await waitFor(() => readdirSync(join(w.dirs.dataDir, "uploads")).length === 2, 3000, "only the uploads that were let in to stay");
    await w.done();
  });

  test("GET: a checked picture and its preview inline, an HTML or SVG file only ever as a download that cannot run, nothing without the rule", async () => {
    const w = await serverWorld();
    const pic = (JSON.parse((await http(w.port, up(w.bot.id, "red.png") + `&token=${TOKEN}`, { method: "POST", body: png(30, 20) })).body.toString()) as { attachment: Attachment }).attachment;
    const html = (JSON.parse((await http(w.port, up(w.bot.id, "page.html") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("<html><script>alert(1)</script></html>") })).body.toString()) as { attachment: Attachment }).attachment;
    const svg = (JSON.parse((await http(w.port, up(w.bot.id, "draw.svg") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') })).body.toString()) as { attachment: Attachment }).attachment;

    const preview = await http(w.port, `/api/attachments/${pic.id}/preview`, { headers: { "Tailscale-User-Login": LOGIN, Host: HOST } });
    assert.equal(preview.status, 200, "an <img> sends no Origin; the login is the check");
    assert.equal(preview.headers["content-type"], "image/jpeg");
    assert.match(String(preview.headers["content-disposition"]), /^inline;/);
    assert.equal(preview.headers["x-content-type-options"], "nosniff");
    assert.match(String(preview.headers["content-security-policy"]), /sandbox/);
    assert.match(String(preview.headers["cache-control"]), /immutable/);
    assert.deepEqual([...preview.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const full = await http(w.port, `/api/attachments/${pic.id}/full?token=${TOKEN}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "image/png");
    assert.deepEqual(full.body, png(30, 20));

    for (const f of [html, svg]) {
      const r = await http(w.port, `/api/attachments/${f.id}/full?token=${TOKEN}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "application/octet-stream", f.name);
      assert.match(String(r.headers["content-disposition"]), /^attachment;/, f.name);
      assert.equal(r.headers["content-security-policy"], "sandbox; default-src 'none'", f.name);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal((await http(w.port, `/api/attachments/${f.id}/preview?token=${TOKEN}`)).status, 404, "a file has no preview");
    }

    assert.equal((await http(w.port, `/api/attachments/${pic.id}/full`)).status, 401, "no token and no login");
    assert.equal((await http(w.port, `/api/attachments/att_nosuchnosuchnosuchno/full?token=${TOKEN}`)).status, 404);
    assert.equal((await http(w.port, `/api/attachments/${pic.id}/other?token=${TOKEN}`)).status, 404);
    assert.equal((await http(w.port, `/api/attachments/${pic.id}/full?token=${TOKEN}`, { method: "POST", body: Buffer.from("x") })).status, 405);

    // Sent: served from the bot's folder now. A file the bot later overwrote with HTML is no longer shown inline.
    const item = w.engine.sendMessage({ botId: w.bot.id, text: "", attachments: [pic.id] });
    const path = item.attachments![0]!.path;
    assert.equal((await http(w.port, `/api/attachments/${pic.id}/full?token=${TOKEN}`)).headers["content-type"], "image/png");
    const botDir = join(w.dirs.botsDir, w.bot.id);
    writeFileSync(join(botDir, path), "<html><script>alert(1)</script></html>");
    const after = await http(w.port, `/api/attachments/${pic.id}/full?token=${TOKEN}`);
    assert.equal(after.headers["content-type"], "application/octet-stream");
    assert.match(String(after.headers["content-disposition"]), /^attachment;/);
    await w.done();
  });

  test("the desktop window's file page: a preflight with the token is answered for it alone, and its answers may be read", async () => {
    const w = await serverWorld();
    const pre = await http(w.port, `/api/attachments?token=${TOKEN}`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "null");
    assert.equal((await http(w.port, `/api/attachments`, { method: "OPTIONS", headers: { Origin: "null" } })).status, 403, "no token");
    assert.equal((await http(w.port, `/api/attachments?token=${TOKEN}`, { method: "OPTIONS", headers: { Origin: "https://evil.example.com" } })).status, 403, "a web page");
    const r = await http(w.port, up(w.bot.id, "n.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("hi"), headers: { Origin: "null" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], "null");
    const page = await http(w.port, up(w.bot.id, "n.txt"), { method: "POST", body: Buffer.from("hi"), headers: { ...tailnet } });
    assert.equal(page.headers["access-control-allow-origin"], undefined, "the page needs none");
    await w.done();
  });
});

// ------------------------------------------------------------ through the engine

describe("attachments: a message through the engine", () => {
  test("send: the files move into the bot's folder, the item keeps them, the Claude fake gets image blocks and the note, no text block for a PDF but one for Word", async () => {
    const { engine, store, sessions, events, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const tmp = tempDir();
    const pic = await upload(engine, bot.id, "Screenshot 2026-11-13 08.12.png", png(50, 40));
    const doc = await upload(engine, bot.id, "report.pdf", pdf(["The code word is lantern."]));
    const word = await upload(engine, bot.id, "notes.docx", docx(tmp, "The code word is heron."));
    const item = engine.sendMessage({ botId: bot.id, text: "Look at these", attachments: [pic.id, doc.id, word.id] });
    assert.deepEqual(item.attachments!.map((a) => a.name), ["Screenshot 2026-11-13 08.12.png", "report.pdf", "notes.docx"]);
    const month = new Date().toISOString().slice(0, 7);
    for (const a of item.attachments!) {
      assert.match(a.path, new RegExp(`^\\.attachments/${month.replace("-", "\\-")}/${a.id}/`));
      assert.ok(statSync(join(dirs.botsDir, bot.id, a.path)).isFile(), a.name);
      assert.equal(existsSync(uploadDir(dirs.dataDir, a.id)), false, "no longer among the uploads");
    }
    assert.deepEqual((store.getItem(item.id) as UserItem).attachments, item.attachments, "stored on the item");
    await settle();
    const s = sessions[0]!;
    const sent = s.sent[0]!;
    assert.equal(sent.pictures?.length, 1);
    assert.equal(sent.pictures![0]!.type, "image/png");
    assert.ok(sent.pictures![0]!.path.endsWith(item.attachments![0]!.path), "the model gets the picture from the bot's folder");
    assert.match(sent.text, /^Look at these\n\nNote from Pobots\. Attached \(saved in your folder for 14 days; copy a file elsewhere in your folder if you need it longer\):\n/);
    assert.match(sent.text, new RegExp(`- report\\.pdf: ${item.attachments![1]!.path.replace(/\./g, "\\.")}\\n`));
    assert.doesNotMatch(sent.text, /<data from="attachment" name="report\.pdf"/, "a Claude bot reads a PDF by path");
    assert.match(sent.text, /<data from="attachment" name="notes\.docx" path="[^"]+">\nThe code word is heron\.\n*<\/data>/, "a Claude bot gets the text of a Word file");
    assert.ok(userItem(events, item.id).attachments, "the upsert carries them");
    s.reply("Seen");
    await settle();
    engine.shutdown();
    store.close();
  });

  test("the rules of send: text may be empty with an attachment, at most 10, only this bot's unsent uploads, discard", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const other = engine.createBot("Other");
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await upload(engine, bot.id, `n${i}.txt`, Buffer.from(`note ${i}`))).id);
    assert.throws(() => engine.sendMessage({ botId: bot.id, text: "x", attachments: ids }), (e: unknown) => e instanceof EngineError && e.code === "too_many" && e.message === "You can attach up to 10 files to one message.");
    assert.throws(() => engine.sendMessage({ botId: other.id, text: "x", attachments: [ids[0]!] }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.throws(() => engine.sendMessage({ botId: bot.id, text: "x", attachments: ["att_nosuchnosuchnosuchno"] }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.throws(() => engine.sendMessage({ botId: bot.id, text: "  " }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
    // Removed from the box: gone, and no longer sendable. Discarding twice is no error.
    engine.discardAttachment(ids[10]!);
    assert.equal(existsSync(uploadDir(dirs.dataDir, ids[10]!)), false);
    engine.discardAttachment(ids[10]!);
    engine.discardAttachment("not an id");
    assert.throws(() => engine.sendMessage({ botId: bot.id, text: "x", attachments: [ids[10]!] }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    const item = engine.sendMessage({ botId: bot.id, text: "", attachments: [ids[0]!, ids[0]!] });
    assert.equal(item.text, "");
    assert.equal(item.attachments!.length, 1, "the same id twice is one attachment");
    // A sent attachment is never removed by a discard.
    engine.discardAttachment(ids[0]!);
    assert.ok(existsSync(join(dirs.botsDir, bot.id, item.attachments![0]!.path)));
    await settle();
    assert.match(sessions[0]!.sent[0]!.text, /^Note from Pobots\. Attached \(saved in your folder for 14 days; copy a file elsewhere in your folder if you need it longer\):\n- n0\.txt: /);
    engine.shutdown();
    store.close();
  });

  test("queued, held after Stop and carried over a restart: the message keeps its attachments and sends them when its turn starts", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const T = { wakeGraceMs: 30, helperStopMs: 150, helperNudgeMs: 20, liveCheckMs: 40 };
    const first = setup(dirs, () => true, T);
    const bot = first.engine.createBot("Po");
    first.engine.sendMessage({ botId: bot.id, text: "Long job" });
    await settle();
    const s = first.sessions[0]!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    // Queued behind the running turn.
    const a1 = await upload(first.engine, bot.id, "one.png", png(10, 10));
    const queuedItem = first.engine.sendMessage({ botId: bot.id, text: "First picture", attachments: [a1.id] });
    assert.equal(queuedItem.queued, true);
    // Stop: it is held. Then the engine stops.
    await first.engine.interrupt(bot.id);
    s.emit({ type: "turn-end", ok: false, subtype: "error_during_execution", errors: [], sessionId: "sess-1", own: true });
    await settle();
    assert.equal(s.sent.length, 1, "the held message was not sent");
    first.engine.shutdown();
    first.store.close();

    // After the restart it still waits; the person's next message (with its own picture) lets it go first.
    const second = setup(dirs, () => true, T);
    await settle();
    assert.equal(second.sessions.length, 0);
    const a2 = await upload(second.engine, bot.id, "two.png", png(12, 12));
    second.engine.sendMessage({ botId: bot.id, text: "Go on", attachments: [a2.id] });
    await settle();
    const s2 = second.sessions.at(-1)!;
    assert.match(s2.sent[0]!.text, /^First picture\n\nNote from Pobots/);
    assert.equal(s2.sent[0]!.pictures?.length, 1);
    assert.ok(s2.sent[0]!.pictures![0]!.path.endsWith("one.png"));
    s2.reply("Done.");
    await settle();
    assert.match(s2.sent[1]!.text, /^Go on\n\nNote from Pobots/);
    assert.ok(s2.sent[1]!.pictures![0]!.path.endsWith("two.png"));
    second.engine.shutdown();
    second.store.close();
  });

  test("a file gone before its turn: missing on the item, a line to the bot, and the turn still runs", async () => {
    const { engine, store, sessions, events, dirs } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Busy" });
    await settle();
    const a = await upload(engine, bot.id, "gone.pdf", pdf(["x"]));
    const b = await upload(engine, bot.id, "kept.txt", Buffer.from("still here"));
    const item = engine.sendMessage({ botId: bot.id, text: "Read these", attachments: [a.id, b.id] });
    const gone = item.attachments![0]!;
    rmSync(join(dirs.botsDir, bot.id, gone.path));
    // The history already shows it as gone.
    const read = engine.readThread({ threadId: bot.mainThreadId }).items.find((i) => i.id === item.id) as UserItem;
    assert.equal(read.attachments![0]!.missing, true);
    assert.equal(read.attachments![1]!.missing, undefined);
    const s = sessions[0]!;
    s.reply("Ok");
    await settle();
    const sent = s.sent[1]!;
    assert.match(sent.text, new RegExp(`- gone\\.pdf: ${gone.path.replace(/\./g, "\\.")} \\(This file is no longer on the Mac\\.\\)`));
    assert.match(sent.text, /- kept\.txt: /);
    const stored = store.getItem(item.id) as UserItem;
    assert.equal(stored.attachments![0]!.missing, true, "kept on the item");
    assert.equal(userItem(events, item.id).attachments![0]!.missing, true, "and sent to the page");
    s.reply("Read what was there");
    await settle();
    // Brought back (a restore): the history no longer says it is gone.
    writeFileSync(join(dirs.botsDir, bot.id, gone.path), pdf(["x"]));
    const back = engine.readThread({ threadId: bot.mainThreadId }).items.find((i) => i.id === item.id) as UserItem;
    assert.equal(back.attachments![0]!.missing, undefined);
    engine.shutdown();
    store.close();
  });

  test("the bot's history leaves .attachments out; search_chat finds a file by its name and read_chat names it", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const a = await upload(engine, bot.id, "invoice march.pdf", pdf(["Total 100"]));
    const item = engine.sendMessage({ botId: bot.id, text: "", attachments: [a.id] });
    await settle();
    const s = sessions[0]!;
    writeFileSync(join(dirs.botsDir, bot.id, "memory", "seen.md"), "noted\n");
    s.reply("Noted");
    await settle();
    const botDir = join(dirs.botsDir, bot.id);
    const tracked = execFileSync("git", ["-C", botDir, "ls-files"], { encoding: "utf8" });
    assert.match(tracked, /memory\/seen\.md/, "the turn's own change was saved");
    assert.doesNotMatch(tracked, /\.attachments/);
    const status = execFileSync("git", ["-C", botDir, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
    assert.doesNotMatch(status, /^\?\? \.attachments/m, "not even waiting to be added");

    const found = await s.tool("search_chat", { query: "invoice" });
    const text = found.content.map((c) => ("text" in c ? c.text : "")).join("");
    assert.match(text, new RegExp(`seq ${item.seq}, .*\\[attached: invoice march\\.pdf at \\.attachments/`));
    const around = await s.tool("read_chat", { around: item.seq });
    assert.match(around.content.map((c) => ("text" in c ? c.text : "")).join(""), /\[attached: invoice march\.pdf at \.attachments\/\d{4}-\d{2}\/att_[a-z0-9]+\/invoice march\.pdf\]/);
    engine.shutdown();
    store.close();
  });

  test("a fresh session's history names the attachments; pictures are not sent again", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = setup(dirs);
    const bot = first.engine.createBot("Kaja");
    const a = await upload(first.engine, bot.id, "chart.png", png(10, 10));
    first.engine.sendMessage({ botId: bot.id, text: "Here is the chart", attachments: [a.id] });
    await settle();
    first.sessions[0]!.reply("Nice chart");
    await settle();
    first.engine.shutdown();
    first.store.close();
    // After a restart the session cannot be restored: the next one starts with the end of the chat from Pobots' history.
    const second = setup(dirs, () => false);
    second.engine.sendMessage({ botId: bot.id, text: "And now?" });
    await settle();
    const s = second.sessions.at(-1)!;
    const handoff = s.sent.at(-1)!.before.join("\n");
    assert.match(handoff, /The person: Here is the chart \[attached: chart\.png at \.attachments\/[^\]]+\/chart\.png\]/);
    assert.equal(s.sent.at(-1)!.pictures, undefined);
    second.engine.shutdown();
    second.store.close();
  });
});

describe("attachments: a bot on a GPT model", () => {
  test("Codex gets localImage items and the text of a PDF in a data block; a model without pictures gets the path and the chat says so", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "asks-first" });
    const pic = await upload(w.engine, bot.id, "kiwi.png", png(40, 20));
    const doc = await upload(w.engine, bot.id, "report.pdf", pdf(["The code word is lantern."]));
    const sheet = await upload(w.engine, bot.id, "budget.xlsx", xlsx());
    const old = await upload(w.engine, bot.id, "old.ppt", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, 0)]));
    const item = w.engine.sendMessage({ botId: bot.id, text: "What is in these? [[answer:ok]]", attachments: [pic.id, doc.id, sheet.id, old.id] });
    await waitFor(() => w.codex.received("turn/start").length === 1, 8000, "the turn");
    const input = w.codex.received("turn/start")[0]!.input as { type: string; text?: string; path?: string }[];
    const images = input.filter((i) => i.type === "localImage");
    assert.equal(images.length, 1);
    assert.ok(images[0]!.path!.endsWith(item.attachments![0]!.path), "the absolute path of the picture in the bot's folder");
    assert.deepEqual(input.map((i) => i.type), ["text", "localImage"], "the message's text, then its pictures");
    const text = input[0]!.text!;
    assert.match(text, /^What is in these\? \[\[answer:ok\]\]\n\nNote from Pobots\. Attached \(saved in your folder for 14 days; copy a file elsewhere in your folder if you need it longer\):/);
    assert.match(text, /<data from="attachment" name="report\.pdf" path="\.attachments\/[^"]+\/report\.pdf">\nThe code word is lantern\.\n<\/data>/);
    assert.match(text, /<data from="attachment" name="budget\.xlsx" path="[^"]+">\nSheet: Budget\nItem\tCost/);
    assert.match(text, /- old\.ppt: [^\n]+ \(Pobots could not get the text out of this file\.\)/);
    await waitFor(() => w.engine.snapshot().bots.find((b) => b.id === bot.id)!.state === "done", 8000, "done");

    // A model whose Codex list says it takes no pictures.
    w.codex.setup.noPictures = ["gpt-6-luna"];
    await w.engine.recheckCodex();
    const pic2 = await upload(w.engine, bot.id, "plain.png", png(10, 10));
    w.engine.sendMessage({ botId: bot.id, text: "And this? [[answer:ok]]", attachments: [pic2.id] });
    await waitFor(() => w.codex.received("turn/start").length === 2, 8000, "the second turn");
    const input2 = w.codex.received("turn/start")[1]!.input as { type: string; text?: string }[];
    assert.equal(input2.filter((i) => i.type === "localImage").length, 0);
    assert.match(input2.find((i) => i.type === "text")!.text!, /- plain\.png: [^\n]+ \(a picture; your model can't be shown pictures\)/);
    assert.ok(notices(w.events).includes("This bot's model can't see pictures."));
    await waitFor(() => w.engine.snapshot().bots.find((b) => b.id === bot.id)!.state === "done", 8000, "done");
    w.engine.shutdown();
    w.store.close();
  });

  test("a long text file is cut at 50,000 characters with the words, in the stored text and the block", async () => {
    const w = codexWorld();
    await w.engine.recheckCodex();
    const bot = w.engine.createBot({ name: "Gee", model: "gpt-6-luna", effort: "low", access: "asks-first" });
    const long = await upload(w.engine, bot.id, "log.txt", Buffer.from("abcdefghij".repeat(6000) + "</data> after"));
    const item = w.engine.sendMessage({ botId: bot.id, text: "[[answer:ok]]", attachments: [long.id] });
    await waitFor(() => w.codex.received("turn/start").length === 1, 8000, "the turn");
    const text = (w.codex.received("turn/start")[0]!.input as { type: string; text?: string }[]).find((i) => i.type === "text")!.text!;
    const block = /<data from="attachment"[^>]*>\n([\s\S]*?)\n<\/data>/.exec(text)![1]!;
    assert.equal(block.length, TEXT_MAX);
    assert.match(text, new RegExp(`</data>\\n\\(cut off; the whole file is at ${item.attachments![0]!.path.replace(/\./g, "\\.")}\\)`));
    await waitFor(() => w.engine.snapshot().bots.find((b) => b.id === bot.id)!.state === "done", 8000, "done");
    w.engine.shutdown();
    w.store.close();
  });
});

// ------------------------------------------------------------ the review's findings (docs/build/notes-files-fixes.md)

/** A sheet as XML, from rows of [reference, inline text]. */
function sheetXml(rows: [string, string][][]): string {
  const body = rows.map((cells, i) => `<row r="${i + 1}">${cells.map(([r, t]) => `<c r="${r}" t="inlineStr"><is><t>${t}</t></is></c>`).join("")}</row>`).join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
/** A workbook whose sheets are found by their part names (no workbook.xml list). */
function workbook(sheets: string[]): Buffer {
  const entries: Record<string, string> = { "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>` };
  sheets.forEach((x, i) => (entries[`xl/worksheets/sheet${i + 1}.xml`] = x));
  return zip(entries);
}

describe("attachments: the review's findings", () => {
  test("1. a spreadsheet naming a far-away column, too many cells or a zip bomb is read within its budget and marked cut", async () => {
    assert.equal(columnOf("XFD7"), 16383, "the last column Excel has");
    assert.equal(columnOf("XFE1"), "bad");
    assert.equal(columnOf("AAAAAAAAAA1"), "bad");
    assert.equal(columnOf("A1048576"), 0);
    assert.equal(columnOf("A1048577"), "bad");
    assert.equal(columnOf(undefined), undefined);

    // A tiny file with a cell in column AAAAAAAAAA: once the engine allocated until memory ran out.
    const t0 = Date.now();
    const far = xlsxRead(workbook([sheetXml([[["A1", "kept"], ["AAAAAAAAAA1", "far away"]], [["B2", "also kept"], ["XFE2", "past XFD"]], [["A3", "row ok"]]])]))!;
    assert.equal(far.text, "Sheet: Sheet 1\nkept\n\talso kept\nrow ok");
    assert.equal(far.cut, true);
    assert.ok(Date.now() - t0 < 2000);

    // Every row with a cell in the last column: the empty cells in front count, so it stops.
    const wide = xlsxRead(workbook([sheetXml(Array.from({ length: 200 }, (_, i) => [[`XFD${i + 1}`, "x"]]))]), 10_000_000)!;
    assert.equal(wide.cut, true);
    assert.ok(wide.text.split("\n").length - 1 < 20, "stopped after the budget of cells");

    // The characters: a long sheet stops at the limit and is marked cut.
    const long = xlsxRead(workbook([sheetXml(Array.from({ length: 5000 }, (_, i) => [[`A${i + 1}`, "a line of words in a cell"]]))]), 1000)!;
    assert.equal(long.cut, true);
    assert.ok(long.text.length < 1100);

    // A zip bomb: one part of 64 MB of nothing, about 64 KB in the file. Nothing is inflated beyond the budget.
    const bomb = zip({ "xl/workbook.xml": "<workbook/>", "xl/worksheets/sheet1.xml": "\0".repeat(64 * 1024 * 1024) });
    assert.ok(bomb.length < 1024 * 1024);
    const t1 = Date.now();
    const boom = xlsxRead(bomb)!;
    assert.equal(boom.cut, true);
    assert.ok(Date.now() - t1 < 3000);
    // The whole file's budget: parts past it are not read at all.
    const many = workbook(Array.from({ length: 6 }, (_, n) => sheetXml(Array.from({ length: 3000 }, (_, i) => [[`A${i + 1}`, `sheet ${n + 1} row ${i + 1} with some words`]]))));
    const some = xlsxRead(many, 10_000_000, { file: 400_000 })!;
    assert.equal(some.cut, true);
    assert.match(some.text, /^Sheet: Sheet 1\n/);
    assert.doesNotMatch(some.text, /Sheet: Sheet 6/);
    // A part bigger than its own budget gives its start, not nothing.
    const start = xlsxRead(many, 10_000_000, { part: 100_000 })!;
    assert.equal(start.cut, true);
    assert.match(start.text, /sheet 1 row 1 with some words/);
    // The same budget for the slides.
    const deck = pptxRead(zip({ "ppt/presentation.xml": "<p/>", "ppt/slides/slide1.xml": `<p:sld>${"<a:p><a:r><a:t>words</a:t></a:r></a:p>".repeat(5000)}</p:sld>` }), 10_000_000, { cells: 100 })!;
    assert.equal(deck.cut, true);
    assert.equal(deck.text.split("\n").length, 101);

    // Through the engine: what was read is kept, and the bot is told the text is cut.
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const a = await upload(engine, bot.id, "far.xlsx", workbook([sheetXml([[["A1", "The code word is walrus"], ["AAAAAAAAAA1", "x"]]])]));
    const meta = JSON.parse(readFileSync(join(uploadDir(dirs.dataDir, a.id), META_FILE), "utf8"));
    assert.deepEqual({ status: meta.text.status, cut: meta.text.cut }, { status: "ok", cut: true });
    engine.shutdown();
    store.close();
  });

  test("2. uploads: at most 10 at once (429), 2 GB of unsent uploads in all, a page that went away leaves nothing, the hourly tidy, pixels checked before sips", async () => {
    const w = await serverWorld();
    const uploads = join(w.dirs.dataDir, "uploads");
    const count = () => (existsSync(uploads) ? readdirSync(uploads).length : 0);
    // Ten uploads that are still arriving.
    const open: ReturnType<typeof request>[] = [];
    for (let i = 0; i < UPLOADS_AT_ONCE; i++) {
      const req = request({ host: "127.0.0.1", port: w.port, path: up(w.bot.id, `slow${i}.txt`) + `&token=${TOKEN}`, method: "POST", headers: { "Content-Length": "1000" } });
      req.on("error", () => undefined);
      req.write("still coming");
      open.push(req);
    }
    await waitFor(() => count() === UPLOADS_AT_ONCE, 5000, "ten uploads running");
    const busy = await http(w.port, up(w.bot.id, "one more.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("hello") });
    assert.equal(busy.status, 429);
    assert.deepEqual(JSON.parse(busy.body.toString()), { error: { code: "bad_request", message: ATTACH_WORDS.busy } });
    for (const req of open) req.destroy();
    await waitFor(() => count() === 0, 5000, "the broken-off uploads gone");
    assert.equal((await http(w.port, up(w.bot.id, "now.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("hello") })).status, 200, "let in again");

    // 2 GB of unsent uploads in all.
    const realSize = w.engine.uploadsSize.bind(w.engine);
    w.engine.uploadsSize = () => UPLOADS_TOTAL_MAX - 10;
    const full = await http(w.port, up(w.bot.id, "more.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("hello world") });
    assert.equal(full.status, 413);
    assert.deepEqual(JSON.parse(full.body.toString()), { error: { code: "too_large", message: ATTACH_WORDS.uploadsFull } });
    w.engine.uploadsSize = realSize;
    assert.ok(realSize() > 0 && realSize() < 1000, "the real count: the one upload let in");

    // The page goes away while the engine works on what arrived: the upload is not kept.
    const before = count();
    const finish = w.engine.finishUpload.bind(w.engine);
    let client: ReturnType<typeof request> | undefined;
    w.engine.finishUpload = async (...args: Parameters<Engine["finishUpload"]>) => {
      client!.destroy();
      await new Promise((r) => setTimeout(r, 100));
      return finish(...args);
    };
    await new Promise<void>((resolve) => {
      const body = png(30, 20);
      client = request({ host: "127.0.0.1", port: w.port, path: up(w.bot.id, "gone.png") + `&token=${TOKEN}`, method: "POST", headers: { "Content-Length": String(body.length) } });
      client.on("error", () => resolve());
      client.on("close", () => resolve());
      client.end(body);
    });
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => count() === before, 5000, "the upload of the page that went away removed");
    w.engine.finishUpload = finish;

    // The tidy that runs every hour (and at start).
    assert.equal(UPLOAD_CLEAN_EVERY_MS, 3600_000);
    const id = (JSON.parse((await http(w.port, up(w.bot.id, "old.txt") + `&token=${TOKEN}`, { method: "POST", body: Buffer.from("old") })).body.toString()) as { attachment: Attachment }).attachment.id;
    const metaFile = join(uploadDir(w.dirs.dataDir, id), META_FILE);
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    writeFileSync(metaFile, JSON.stringify({ ...meta, at: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    assert.equal(w.engine.tidyUploads(), 1);
    assert.equal(existsSync(uploadDir(w.dirs.dataDir, id)), false);

    // Pixels: a picture longer than 30,000 px on a side is never opened as a picture, also not before a
    // TIFF is converted. Step 7c: it is kept as the file it is.
    const tmp = tempDir();
    const strip = png(MAX_SIDE_PX + 1, 1);
    const wide = await http(w.port, up(w.bot.id, "strip.png") + `&token=${TOKEN}`, { method: "POST", body: strip });
    assert.equal(wide.status, 200);
    const wa = (JSON.parse(wide.body.toString()) as { attachment: Attachment }).attachment;
    assert.deepEqual([wa.name, wa.kind, wa.width], ["strip.png", "file", undefined]);
    writeFileSync(join(tmp, "strip.png"), strip);
    execFileSync("/usr/bin/sips", ["-s", "format", "tiff", join(tmp, "strip.png"), "--out", join(tmp, "strip.tiff")], { stdio: "ignore" });
    const tiff = await http(w.port, up(w.bot.id, "strip.tiff") + `&token=${TOKEN}`, { method: "POST", body: readFileSync(join(tmp, "strip.tiff")) });
    assert.equal(tiff.status, 200);
    const ta = (JSON.parse(tiff.body.toString()) as { attachment: Attachment }).attachment;
    assert.deepEqual([ta.name, ta.kind], ["strip.tiff", "file"], "kept as the TIFF it is, not converted");
    assert.deepEqual(readdirSync(uploadDir(w.dirs.dataDir, ta.id)).sort(), [".meta.json", "strip.tiff"]);
    await w.done();
  });

  test("3. an existing bot: the .gitignore line is added without touching other lines, and an attachment the bot staged itself is not saved", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const botDir = join(dirs.botsDir, bot.id);
    // A bot from before attachments: its .gitignore does not name them (with CRLF lines, to keep them).
    const old = "# mine\r\n.DS_Store\r\n.claude/settings.local.json\r\n*.pobots-tmp\r\nbot.json.tmp\r\nkeep-out.txt";
    writeFileSync(join(botDir, ".gitignore"), old);
    execFileSync("git", ["-C", botDir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "old ignore"]);
    const a = await upload(engine, bot.id, "secret plan.txt", Buffer.from("not for the history"));
    const item = engine.sendMessage({ botId: bot.id, text: "", attachments: [a.id] });
    assert.equal(readFileSync(join(botDir, ".gitignore"), "utf8"), `${old}\r\n.attachments/\r\n`, "added at the end, the rest as it was");
    ensureIgnored(botDir);
    assert.equal(readFileSync(join(botDir, ".gitignore"), "utf8"), `${old}\r\n.attachments/\r\n`, "never twice");
    // The bot itself staged it (a git add of its own before the line was there).
    execFileSync("git", ["-C", botDir, "add", "-f", "--", item.attachments![0]!.path]);
    await settle();
    writeFileSync(join(botDir, "memory", "seen.md"), "noted\n");
    sessions[0]!.reply("Noted");
    await settle();
    const tracked = execFileSync("git", ["-C", botDir, "ls-files"], { encoding: "utf8" });
    assert.match(tracked, /memory\/seen\.md/, "the turn's own change was saved");
    assert.doesNotMatch(tracked, /\.attachments/, "the staged attachment was not");
    const all = execFileSync("git", ["-C", botDir, "log", "--all", "--name-only", "--format="], { encoding: "utf8" });
    assert.doesNotMatch(all, /\.attachments\//, "in no commit");
    assert.ok(existsSync(join(botDir, item.attachments![0]!.path)), "the file stays on disk");
    // A folder without a .gitignore gets one with the line.
    const bare = tempDir();
    ensureIgnored(bare);
    assert.equal(readFileSync(join(bare, ".gitignore"), "utf8"), ".attachments/\n");
    engine.shutdown();
    store.close();
  });

  test("4. a send whose message cannot be stored puts the files back among the uploads, also when they were copied across disks", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const botDir = join(dirs.botsDir, bot.id);
    const a = await upload(engine, bot.id, "one.txt", Buffer.from("one"));
    const b = await upload(engine, bot.id, "two.png", png(10, 10));
    const rename = moveOps.rename;
    const realEnqueue = (engine as unknown as { enqueue: unknown }).enqueue;
    try {
      // Every move crosses disks: rename says EXDEV, so the files are copied and the originals removed.
      moveOps.rename = () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      };
      (engine as unknown as { enqueue: () => never }).enqueue = () => {
        throw new Error("the database is full");
      };
      assert.throws(() => engine.sendMessage({ botId: bot.id, text: "Here", attachments: [a.id, b.id] }), /database is full/);
      for (const x of [a, b]) {
        assert.ok(existsSync(join(uploadDir(dirs.dataDir, x.id), META_FILE)), `${x.name} is back among the uploads`);
        assert.ok(existsSync(join(uploadDir(dirs.dataDir, x.id), x.name)));
      }
      const left = existsSync(join(botDir, ".attachments")) ? execFileSync("find", [join(botDir, ".attachments"), "-type", "f"], { encoding: "utf8" }) : "";
      assert.equal(left, "", "nothing left in the bot's folder");
      // A copy that breaks off half way is removed, and the upload stays where it was.
      delete (engine as unknown as { enqueue?: unknown }).enqueue;
      const cp = join(uploadDir(dirs.dataDir, a.id), "unreadable");
      writeFileSync(cp, "x");
      execFileSync("chmod", ["000", cp]);
      assert.throws(() => engine.sendMessage({ botId: bot.id, text: "Here", attachments: [b.id, a.id] }));
      execFileSync("chmod", ["600", cp]);
      rmSync(cp);
      for (const x of [a, b]) assert.ok(existsSync(join(uploadDir(dirs.dataDir, x.id), META_FILE)), `${x.name} still among the uploads`);
      const left2 = existsSync(join(botDir, ".attachments")) ? execFileSync("find", [join(botDir, ".attachments"), "-type", "f"], { encoding: "utf8" }) : "";
      assert.equal(left2, "", "no half copy left in the bot's folder");
      // Sent for real afterwards, still across disks.
      const item = engine.sendMessage({ botId: bot.id, text: "Here", attachments: [a.id, b.id] });
      for (const x of item.attachments!) assert.ok(existsSync(join(botDir, x.path)));
    } finally {
      moveOps.rename = rename;
      void realEnqueue;
    }
    await settle();
    engine.shutdown();
    store.close();
  });

  test("5. the text kept from the upload is used only while the file is unchanged", async () => {
    const { engine, store, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const botDir = join(dirs.botsDir, bot.id);
    const a = await upload(engine, bot.id, "notes.txt", Buffer.from("The first version."));
    const item = engine.sendMessage({ botId: bot.id, text: "", attachments: [a.id] });
    const att = item.attachments![0]!;
    const first = await contentFor(botDir, "", [att], { harness: "codex", seesPictures: true });
    assert.match(first.text, /The first version\./);
    writeFileSync(join(botDir, att.path), "The second version, changed by the bot.");
    const second = await contentFor(botDir, "", [att], { harness: "codex", seesPictures: true });
    assert.match(second.text, /The second version, changed by the bot\./);
    assert.doesNotMatch(second.text, /The first version/);
    // The same size, another time.
    writeFileSync(join(botDir, att.path), "The THIRD version, changed by the bot.".slice(0, "The second version, changed by the bot.".length));
    const t = new Date(Date.now() + 5000);
    utimesSync(join(botDir, att.path), t, t);
    const third = await contentFor(botDir, "", [att], { harness: "codex", seesPictures: true });
    assert.match(third.text, /The THIRD version/);
    await settle();
    engine.shutdown();
    store.close();
  });
});

// Keep the unused helper types honest for the type checker.
export type { Events, FakeSession };
