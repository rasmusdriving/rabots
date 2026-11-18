#!/usr/bin/env node
// Groundwork for the nightly backup (job 5, docs/build/notes-backup-groundwork.md): the strong
// proof that a file is on OneDrive's servers. Write a trial file, wait until the file provider
// says it is uploaded, ask macOS to evict the local copy (only allowed for an uploaded file), then
// read it back, which makes OneDrive download it from its servers, and compare the hash.
// Removes its own trial file at the end; touches nothing else.
//
//   node scripts/dev/onedrive-roundtrip.mjs --evict=<compiled evict.swift> [--size=<bytes>]
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const size = Number(arg("size", "2000000"));
const jxaState = fileURLToPath(new URL("./upload-state.js", import.meta.url));
const evictBin = arg("evict"); // compiled scripts/dev/evict.swift
const folder = join(homedir(), "Library", "CloudStorage", "OneDrive-Personal", "Pobot");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const file = join(folder, `pobots-trial-${stamp}.txt`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (t) => `+${((Date.now() - t) / 1000).toFixed(1)}s`;
const state = () => JSON.parse(execFileSync("osascript", ["-l", "JavaScript", jxaState, file], { encoding: "utf8" }).trim());
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const body = randomBytes(size);
const want = sha(body);
const t0 = Date.now();
writeFileSync(file, body);
console.log(`wrote ${file} (${size} bytes)`);
try {
  let s;
  for (;;) {
    s = state();
    if (s.uploaded || Date.now() - t0 > 120_000) break;
    await wait(250);
  }
  console.log(`${since(t0)} state ${JSON.stringify(s)}`);
  // Evicting too early fails; try a few times so the trial also shows when it first succeeds.
  let evicted = "";
  for (let i = 0; i < 40; i++) {
    evicted = execFileSync(evictBin, [file], { encoding: "utf8" }).trim();
    console.log(`${since(t0)} evict: ${evicted}`);
    if (evicted.startsWith("ok")) break;
    await wait(1000);
  }
  await wait(1500);
  console.log(`${since(t0)} after evict, the file on disk (a "dataless" flag means only the cloud has the content):`);
  try {
    console.log("  " + execFileSync("ls", ["-lO", file], { encoding: "utf8" }).trim());
  } catch (e) {
    console.log("  ls failed " + e.message);
  }
  // Node's own read of a dataless file failed with errno 11 (EDEADLK) on 13 Nov 2026: this process
  // may not make macOS fetch the content. Try cat, a separate process, and Node again after it.
  const t1 = Date.now();
  for (const [name, read] of [
    ["node", () => readFileSync(file)],
    ["cat", () => execFileSync("cat", [file], { maxBuffer: 1e9 })],
  ]) {
    try {
      const back = read();
      console.log(`${since(t1)} ${name} read back ${back.length} bytes; hash ${sha(back) === want ? "MATCHES" : "DIFFERS"}`);
    } catch (e) {
      console.log(`${since(t1)} ${name} could not read it: ${String(e.message).split("\n")[0]}`);
    }
  }
} finally {
  unlinkSync(file);
  console.log(`removed ${file}: ${existsSync(file) ? "STILL THERE" : "gone"}`);
}
