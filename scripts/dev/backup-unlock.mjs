#!/usr/bin/env node
// Groundwork for the nightly backup (job 5). Unlocks one backup file into a folder. The private key
// comes on standard input only, never as a file path or an argument:
//   op read "op://<vault>/<item>/private key" | node scripts/dev/backup-unlock.mjs <file> <folder>
// (In the trial the stand-in key is piped in from a temporary folder.)
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { fingerprintOfPrivate, readPrivateKey, unlockStream } from "./backup-lock.mjs";

const [file, folder] = process.argv.slice(2);
if (!file || !folder) {
  console.error("usage: <private key on stdin> | node backup-unlock.mjs <file> <folder>");
  process.exit(2);
}
if (process.stdin.isTTY) {
  console.error("Pipe the private key in, for example from: op read \"op://<vault>/<item>/private key\"");
  process.exit(2);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const keyText = Buffer.concat(chunks);
let key;
try {
  key = readPrivateKey(keyText.toString("utf8"));
} catch (e) {
  console.error(`The private key could not be read: ${e.message.split("\n")[0]}`);
  process.exit(1);
} finally {
  keyText.fill(0);
}
const fp = fingerprintOfPrivate(key);
mkdirSync(folder, { recursive: true });
const tar = spawn("tar", ["-xzf", "-", "-C", folder], { stdio: ["pipe", "inherit", "inherit"] });
const tarDone = new Promise((res, rej) => tar.on("close", (code) => (code === 0 ? res() : rej(new Error(`tar ended with ${code}`)))));
try {
  await pipeline(
    createReadStream(file),
    unlockStream(key, (h) => {
      if (h.keyFingerprint !== fp) console.error(`Note: this backup was locked to ${h.keyFingerprint}, the key given is ${fp}.`);
      console.error(`backup from ${h.createdAt ?? "?"}, engine ${h.engineVersion ?? "?"}, format ${h.format}`);
    }),
    tar.stdin,
  );
  await tarDone;
  console.error("unlocked");
} catch (e) {
  tar.kill();
  console.error(`Could not unlock: ${e.message}`);
  process.exit(1);
}
