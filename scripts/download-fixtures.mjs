// Small real files the browser checks can compare against what it saves.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";

export function zip(entries) {
  let offset = 0;
  const data = [];
  const directory = [];
  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path);
    const bytes = Buffer.from(text);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    data.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, central, end]);
}

function pdf() {
  let text = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f \n"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ];
  for (const [i, obj] of objects.entries()) {
    offsets.push(`${String(text.length).padStart(10, "0")} 00000 n \n`);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  return Buffer.from(`${text}xref\n0 4\n${offsets.join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${text.length}\n%%EOF\n`);
}

export const downloadSamples = {
  "Färdigt [å ä ö].zip": zip({ "readme.txt": "Hello from a zip.\n" }),
  "Summary [v2].pdf": pdf(),
  "Rows åäö.xlsx": zip({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sample" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c t="inlineStr" r="A1"><is><t>Hej</t></is></c></row></sheetData></worksheet>',
  }),
  "Read this [åäö].txt": Buffer.from("Hej, åäö\r\nSecond line.\r\n"),
  "README": Buffer.from("No extension.\n"),
  "report.v2.tar.gz": gzipSync(Buffer.alloc(1024)), // A valid empty tar (two zero blocks).
};

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function savedDownload({ cmd, click, path, name, expected }) {
  mkdirSync(path, { recursive: true });
  const result = await cmd("Page.setDownloadBehavior", { behavior: "allow", downloadPath: path });
  if (result.error) throw new Error(result.error.message);
  await click();
  const end = Date.now() + 6_000;
  const saved = join(path, name);
  while (!existsSync(saved) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return existsSync(saved) && sha(readFileSync(saved)) === sha(expected);
}
