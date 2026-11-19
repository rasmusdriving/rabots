// Real engine and restic in an isolated local folder. No cloud wait, no model, no external tools.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRestic } from "../../../engine/core/restic-cli.ts";
import { backupDir, botsDir, check, clickButton, cmd, connectBrowser, dataDir, engineLog, js, openWindow, root, sideChannel, startEngine, until, work } from "../lib.mjs";

export default async function section() {
  if (!findRestic()) {
    check("skipped: restic not installed", true);
    return;
  }
  const began = performance.now();
  const throwaway = randomBytes(24).toString("hex");
  const ref = "op://Pobots-test/Throwaway/password";
  const endpoint = await startEngine({ env: { POBOTS_TEST_RESTIC_PASSWORD: throwaway } });
  const side = await sideChannel(endpoint);
  try {
    await side.request("bot.create", { name: "Example", welcome: false });
    await connectBrowser();
    await cmd("Page.enable");
    await openWindow(endpoint);
    const stateLine = 'document.querySelector(".pb-backup-line [data-show]")?.textContent ?? ""';
    const state = () => side.request("snapshot").then((s) => s.backup);
    const latest = () => state().then((s) => s.history[0]);
    const finished = async (status) => !!(await until(`(${stateLine}).startsWith(${JSON.stringify(status)}) && !document.querySelector(".pb-backup-now")?.disabled`, 18_000));
    const field = "#backup-password-ref";
    await until('!!document.querySelector(".pb-foot-settings")', 10_000);
    await js('document.querySelector(".pb-foot-settings").click()');
    check("backup: no reference disables Back up now", !!(await until(`(${stateLine}).includes("Add a 1Password reference") && document.querySelector(".pb-backup-now")?.disabled`)));
    await js(`document.querySelector("${field}").focus()`);
    await cmd("Input.insertText", { text: ref });
    await clickButton("Save reference");
    check("backup: the window saves the reference", !!(await until(`document.querySelector("#backup-reference-result [data-show]")?.textContent === "Saved"`)) && (await state()).passwordRef === ref);
    const note = join(botsDir, "example", "fixture.txt");
    writeFileSync(note, "first version\n");
    await js('document.querySelector(".pb-backup-now").click()');
    check("backup: snapshot made locally and upload not claimed", await finished("Made, upload not confirmed"));
    const first = await latest();
    check("backup: the first snapshot is recorded with size", !!first?.snapshot && first.bytes > 0 && (await state()).repositoryBytes >= first.bytes, first?.problem ?? "");
    if (!first?.snapshot) return;
    writeFileSync(note, "second version\n");
    await js('document.querySelector(".pb-backup-now").click()');
    check("backup: second snapshot is incremental", await finished("Made, upload not confirmed") && (await state()).snapshots === 2 && (await latest()).bytes < first.bytes);

    const cli = (args, password = throwaway) => spawnSync(process.execPath, [join(root, "scripts", "restore.mjs"), ...args, backupDir], {
      env: { ...process.env, RESTIC_PASSWORD: password }, encoding: "utf8", timeout: 10_000,
    });
    const listed = cli(["--check"]);
    check("backup restore: check opens and lists the two snapshots", listed.status === 0 && listed.stdout.includes(first.snapshot) && listed.stdout.includes("2 completed Pobots snapshots"), listed.stderr);
    const bad = cli(["--check"], randomBytes(24).toString("hex"));
    check("backup restore: wrong password is refused", bad.status !== 0 && /password did not open/.test(bad.stderr));
    const dest = join(work, "restored");
    const restored = cli(["--folders", `--data-dir=${join(dest, "data")}`, `--bots-dir=${join(dest, "bots")}`, `--snapshot=${first.snapshot}`]);
    const earlier = join(dest, "bots", "example", "fixture.txt");
    check("backup restore: restores the older file and a checked SQLite database", restored.status === 0 && existsSync(earlier) && readFileSync(earlier, "utf8") === "first version\n" && existsSync(join(dest, "data", "pobots.db")), restored.stderr);
    const sensitive = [listed.stdout, listed.stderr, bad.stderr, restored.stdout, restored.stderr, ...engineLog,
      readFileSync(join(dataDir, "config.json"), "utf8"), readFileSync(join(dataDir, "backup.json"), "utf8")];
    check("backup: the throwaway password is absent from output, log and settings", sensitive.every((s) => !s.includes(throwaway)));
    console.log(`Backup section: ${((performance.now() - began) / 1000).toFixed(1)} s.`);
  } finally {
    side.close();
  }
}
