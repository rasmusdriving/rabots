#!/usr/bin/env node
// Groundwork for the nightly backup (job 5, docs/build/notes-backup-groundwork.md): does a file we
// write into the OneDrive "Pobot" folder reach OneDrive, and how can a program tell?
//
// Writes one small file named pobots-trial-<time>.txt, watches its upload state every 2 seconds
// (the Swift helper, fileproviderctl evaluate, extended attribute names), prints every change with
// the time since writing, and removes the file at the end. Touches nothing else in the folder.
//
//   swiftc -O -o <tmp>/upload-state scripts/dev/upload-state.swift
//   node scripts/dev/onedrive-trial.mjs --helper=<tmp>/upload-state [--size=<bytes>] [--keep-watching=<s>]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const helper = arg("helper");
if (!helper || !existsSync(helper)) {
  console.error("Give --helper=<compiled upload-state>.");
  process.exit(2);
}
const size = Number(arg("size", "200"));
const keepWatching = Number(arg("keep-watching", "10")) * 1000;
const LIMIT_MS = 5 * 60 * 1000;
const jxa = fileURLToPath(new URL("./upload-state.js", import.meta.url));
const poll = Number(arg("poll-ms", "2000"));

const folder = join(homedir(), "Library", "CloudStorage", "OneDrive-Personal", "Pobot");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const file = join(folder, `pobots-trial-${stamp}.txt`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bytes sent so far by all OneDrive processes, from nettop (a system tool). */
function oneDriveBytesOut() {
  try {
    const text = execFileSync("nettop", ["-P", "-L", "1", "-n", "-x", "-J", "bytes_in,bytes_out"], { encoding: "utf8", timeout: 10_000 });
    let sum = 0;
    for (const line of text.split("\n")) if (/^OneDrive/.test(line)) sum += Number(line.split(",")[2]) || 0;
    return sum;
  } catch {
    return undefined;
  }
}
const sentBefore = oneDriveBytesOut();

function state() {
  const out = {};
  try {
    out.swift = JSON.parse(execFileSync(helper, [file], { encoding: "utf8", timeout: 10_000 }).trim());
  } catch (e) {
    out.swift = { error: String(e.message).split("\n")[0] };
  }
  try {
    out.jxa = JSON.parse(execFileSync("osascript", ["-l", "JavaScript", jxa, file], { encoding: "utf8", timeout: 10_000 }).trim());
  } catch (e) {
    out.jxa = { error: String(e.message).split("\n")[0] };
  }
  try {
    const ev = execFileSync("fileproviderctl", ["evaluate", file], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const pick = (k) => (new RegExp(`\\b${k} = ([^;]+);`).exec(ev) || [])[1];
    out.fp = { isUploaded: pick("isUploaded"), isUploading: pick("isUploading"), uploadingError: pick("uploadingError") ?? null, itemIdentifier: pick("itemIdentifier") };
  } catch (e) {
    out.fp = { error: String(e.message).split("\n")[0] };
  }
  try {
    out.xattrs = execFileSync("xattr", [file], { encoding: "utf8", timeout: 5000 }).trim().split("\n").filter(Boolean).sort();
  } catch (e) {
    out.xattrs = { error: String(e.message).split("\n")[0] };
  }
  return out;
}

const t0 = Date.now();
const body = `Pobots trial file, written ${new Date().toISOString()}. Safe to delete.\n` + randomBytes(Math.max(0, size)).toString("base64").slice(0, Math.max(0, size));
writeFileSync(file, body);
console.log(`wrote ${file} (${statSync(file).size} bytes)`);

let last = "";
let uploadedAt;
try {
  while (Date.now() - t0 < LIMIT_MS) {
    const s = state();
    const key = JSON.stringify(s);
    if (key !== last) {
      console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${key}`);
      last = key;
    }
    const sent = oneDriveBytesOut();
    const sentKey = sent !== undefined && sentBefore !== undefined ? Math.round((sent - sentBefore) / 1e5) / 10 : "?";
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s OneDrive has sent ${sentKey} MB since the file was written`);
    const up = s.swift?.uploaded === true;
    if (up && uploadedAt === undefined) uploadedAt = Date.now();
    if (uploadedAt !== undefined && Date.now() - uploadedAt >= keepWatching) break;
    await wait(poll);
  }
  console.log(uploadedAt ? `uploaded after ${((uploadedAt - t0) / 1000).toFixed(1)}s` : `not uploaded within ${LIMIT_MS / 1000}s`);
} finally {
  unlinkSync(file);
  console.log(`removed ${file}: ${existsSync(file) ? "STILL THERE" : "gone"}`);
}
