// One heavy Pobots check at a time on this Mac, across helpers and working copies.
//   node scripts/dev/check-lock.mjs -- npm run check:ui
// Waits (quietly, up to 90 minutes) until no other heavy check runs, then runs the command in the
// current folder and passes its exit code on. A lock left by a process that is gone is taken over.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const lock = join(homedir(), ".cache", "pobots-heavy-check.lock");
const args = process.argv.slice(2);
const at = args.indexOf("--");
const command = at >= 0 ? args.slice(at + 1) : args;
if (!command.length) {
  console.error("Usage: node check-lock.mjs -- <command> [args]");
  process.exit(2);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function take() {
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${process.pid}\n${process.cwd()}\n${command.join(" ")}\n`);
    return true;
  } catch {
    try {
      const pid = Number(readFileSync(join(lock, "owner"), "utf8").split("\n")[0]);
      if (!pid || !alive(pid)) {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch {
      // The owner file is not written yet, or the lock just went away: look again.
    }
    return false;
  }
}

const started = Date.now();
let said = false;
while (!take()) {
  if (!said) {
    console.error("Another heavy check is running on this Mac. Waiting for it to end.");
    said = true;
  }
  if (Date.now() - started > 90 * 60 * 1000) {
    console.error("Gave up waiting for the other check after 90 minutes.");
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const release = () => rmSync(lock, { recursive: true, force: true });
const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  release();
  console.error(String(err));
  process.exit(1);
});
