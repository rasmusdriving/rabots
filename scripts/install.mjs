// Installs dependencies on the Mac's internal drive and links them into the repo.
//
// The repo lives on the external drive, but dependency folders must not (see AGENTS.md).
// npm replaces a symlinked node_modules with a real folder, so we install in a folder on the
// internal drive that holds a copy of package.json and the lockfile, then link node_modules back.
//
// Run: node scripts/install.mjs            (after cloning, or after editing package.json)
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.env.POBOTS_DEPS_DIR ?? join(homedir(), ".local", "share", "pobots");
mkdirSync(target, { recursive: true });

copyFileSync(join(repo, "package.json"), join(target, "package.json"));
if (existsSync(join(repo, "package-lock.json"))) {
  copyFileSync(join(repo, "package-lock.json"), join(target, "package-lock.json"));
}

const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

copyFileSync(join(target, "package-lock.json"), join(repo, "package-lock.json"));

const link = join(repo, "node_modules");
const stat = lstatSync(link, { throwIfNoEntry: false });
if (stat && !stat.isSymbolicLink()) rmSync(link, { recursive: true, force: true });
if (!stat || !stat.isSymbolicLink()) symlinkSync(join(target, "node_modules"), link);

console.log(`Dependencies are in ${join(target, "node_modules")}, linked from ${link}`);
