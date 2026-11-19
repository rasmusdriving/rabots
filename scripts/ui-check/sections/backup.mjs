// The Backup section, against the stand-in engine.
import { check, ev, open, shot, until } from "../lib.mjs";

const line = 'document.querySelector(".pb-backup-line [data-show]")?.textContent ?? ""';
const button = 'document.querySelector(".pb-backup-now")';
const field = 'document.querySelector("#backup-password-ref")';

async function settings(seed, dimensions) {
  await open(`backup=${seed}`, dimensions);
  await ev('document.querySelector(".pb-foot-settings").click()');
  await until('!!document.querySelector("#backup-password-ref")');
}

export default async function section() {
  for (const [seed, words] of [
    ["missing", "Install restic: brew install restic"],
    ["none", "Add a 1Password reference"],
    ["key", "No backups yet"],
    ["saved", "Saved to iCloud"],
    ["unconfirmed", "Made, upload not confirmed"],
    ["failed", "Backup failed"],
    ["made", "Made, checking upload"],
  ]) {
    await settings(seed);
    check(`backup: ${seed} has its own state`, !!(await until(`(${line}).includes(${JSON.stringify(words)})`)));
    if (seed === "missing" || seed === "none") check(`backup: ${seed} disables Back up now`, await ev(`${button}.disabled`));
    if (seed === "missing") {
      await ev('document.querySelector(".pb-backup").scrollIntoView({block:"start"})');
      await shot("backup-headless-restic-missing");
    }
    if (seed === "saved") check("backup: shows the iCloud folder, size and snapshot count", await ev('document.querySelector(".pb-backup").innerText.includes("iCloud Drive · Pobots Backup") && /MB · [0-9]+ snapshots/.test(document.querySelector(".pb-backup").innerText)'));
  }

  await settings("none", { width: 360, height: 780, theme: "light" });
  const ref = "op://Example/Pobots backup/password";
  const paste = (value) => ev(`(() => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", ${JSON.stringify(value)});
    ${field}.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  })()`);
  await paste("stand-in password that must never be sent");
  check("backup: a bad paste is rejected before sending or showing it", !!(await until('document.querySelector("#backup-reference-result[role=alert]") !== null')) && (await ev(`${field}.value === "" && window.pobotsMock.backupReferenceTexts().length === 0`)));
  await paste(ref);
  await ev('document.querySelector(".pb-backup-save").click()');
  check("backup: only a valid reference is sent and shown on return", !!(await until(`!${button}.disabled && ${field}.value === ${JSON.stringify(ref)} && window.pobotsMock.backupReferenceTexts().length === 1`)));
  await ev('document.querySelector(".pb-backup").scrollIntoView({block:"start"})');
  const measure = `[...${JSON.stringify([".pb-backup-line", ".pb-backup-now", "#backup-password-ref"])}].map(s => {
    const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
  })`;
  const before = await ev(measure);
  await ev(`${button}.click()`);
  check("backup: shows an immediate in-place running state", !!(await until(`(${line}).includes("Backing up now") && ${button}.disabled`)));
  check("backup: starting a run keeps the controls in place at Android width", JSON.stringify(await ev(measure)) === JSON.stringify(before));
  check("backup: manual run ends in saved", !!(await until(`(${line}).includes("Saved to iCloud") && !${button}.disabled`, 6000)));
  check("backup: recent run records amount added and who started it", await ev('document.querySelector(".pb-backup-runs li:last-child").innerText.includes("By you · 100 KB added")'));
  await shot("backup-headless-android-light");
  const widths = await ev('(() => { const section = document.querySelector(".pb-backup"); return [section.scrollWidth, section.clientWidth, ...[...section.children].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className)]; })()');
  check("backup: phone section fits horizontally", widths[0] <= widths[1] + 1, JSON.stringify(widths));
  for (const [width, height, theme, seed] of [[390, 844, "dark", "unconfirmed"], [390, 844, "light", "saved"], [360, 780, "dark", "failed"]]) {
    await settings(seed, { width, height, theme });
    await ev('document.querySelector(".pb-backup").scrollIntoView({block:"start"})');
    const fit = await ev('(() => { const s = document.querySelector(".pb-backup"); return s.scrollWidth <= s.clientWidth + 1; })()');
    check(`backup: ${seed} fits at ${width} × ${height} in ${theme}`, fit);
    await shot(`backup-headless-${width}-${theme}-${seed}`);
  }
}
