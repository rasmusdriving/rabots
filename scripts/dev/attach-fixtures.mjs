// Test files for the attachment trials (groundwork for pictures and files in the chat).
// No dependencies: PNGs are written with node:zlib, the PDF by hand.
//
//   wordPng(word, { fg, bg, scale })   a PNG with the word in big block letters (K, I, W, A, P, L, E, M, N, O, R, G, T, S known)
//   colourPng(w, h, rgb)               a PNG of one plain colour
//   noisePng(w, h)                     a PNG of random pixels: it does not compress, so the file is about w*h*3 bytes
//   textPdf(lines)                     a one-page PDF with the lines as text
//   pngSize(buf)                       { width, height } read from a PNG's header
//   zipFile(entries), xlsxFile(rows)   a zip of text parts, and a small workbook made from it
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** rows: function (y) => Buffer of w*3 RGB bytes. */
function png(w, h, rows, level = 9) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rows(y).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GLYPHS = {
  K: ["1...1", "1..1.", "1.1..", "11...", "1.1..", "1..1.", "1...1"],
  I: ["11111", "..1..", "..1..", "..1..", "..1..", "..1..", "11111"],
  W: ["1...1", "1...1", "1...1", "1.1.1", "1.1.1", "11.11", "1...1"],
  A: [".111.", "1...1", "1...1", "11111", "1...1", "1...1", "1...1"],
  P: ["1111.", "1...1", "1...1", "1111.", "1....", "1....", "1...."],
  L: ["1....", "1....", "1....", "1....", "1....", "1....", "11111"],
  E: ["11111", "1....", "1....", "1111.", "1....", "1....", "11111"],
  M: ["1...1", "11.11", "1.1.1", "1.1.1", "1...1", "1...1", "1...1"],
  N: ["1...1", "11..1", "1.1.1", "1..11", "1...1", "1...1", "1...1"],
  O: [".111.", "1...1", "1...1", "1...1", "1...1", "1...1", ".111."],
  R: ["1111.", "1...1", "1...1", "1111.", "1.1..", "1..1.", "1...1"],
  G: [".111.", "1...1", "1....", "1.111", "1...1", "1...1", ".111."],
  T: ["11111", "..1..", "..1..", "..1..", "..1..", "..1..", "..1.."],
  S: [".1111", "1....", "1....", ".111.", "....1", "....1", "1111."],
};

export function wordPng(word, { fg = [0, 0, 0], bg = [255, 220, 0], scale = 16 } = {}) {
  const letters = [...word.toUpperCase()].map((c) => GLYPHS[c] ?? GLYPHS.O);
  const pad = 2 * scale;
  const w = letters.length * 6 * scale - scale + 2 * pad;
  const h = 7 * scale + 2 * pad;
  return png(w, h, (y) => {
    const row = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      let on = false;
      const gx = x - pad;
      const gy = y - pad;
      if (gx >= 0 && gy >= 0 && gy < 7 * scale) {
        const li = Math.floor(gx / (6 * scale));
        const cx = Math.floor((gx % (6 * scale)) / scale);
        const cy = Math.floor(gy / scale);
        on = li < letters.length && cx < 5 && letters[li][cy][cx] === "1";
      }
      const c = on ? fg : bg;
      row[x * 3] = c[0];
      row[x * 3 + 1] = c[1];
      row[x * 3 + 2] = c[2];
    }
    return row;
  });
}

export function colourPng(w, h, rgb) {
  const row = Buffer.alloc(w * 3);
  for (let x = 0; x < w; x++) rgb.forEach((v, i) => (row[x * 3 + i] = v));
  return png(w, h, () => row);
}

export function noisePng(w, h) {
  return png(w, h, () => randomBytes(w * 3), 1);
}

export function textPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = ["BT", "/F1 18 Tf", "72 720 Td", "24 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A zip file of text parts (deflated). */
export function zipFile(entries) {
  const locals = [];
  const central = [];
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

/** A small workbook (one sheet, shared strings) with the given rows. */
export function xlsxFile(rows) {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const strings = [];
  const idx = (s) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = rows
    .map((r, y) => `<row r="${y + 1}">${r.map((v, x) => (typeof v === "number" ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="s"><v>${idx(v)}</v></c>`)).join("")}</row>`)
    .join("");
  return zipFile({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  });
}
