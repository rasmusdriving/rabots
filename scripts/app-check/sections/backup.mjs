// The app check, section "backup": step 16, the nightly backup into a folder of the check's own in OneDrive.
// Run it alone: node scripts/app-check.mjs --only=backup
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  root,
  sleep,
  work,
  dataDir,
  botsDir,
  backupDir,
  backupReady,
  keysDir,
  check,
  engineLog,
  startEngine,
  stopEngine,
  sideChannel,
  cmd,
  js,
  shot,
  until,
  clickButton,
  openWindow,
  run,
} from "../lib.mjs";

// 16. The nightly backup (job 5), no model calls: the settings page from the foot of the roster,
//     the key's refusals and its fingerprint, "Back up now" through its states to saved (the Mac's
//     real upload state, in a folder of the check's own), the restore script, a failed nightly
//     run's card and its dismissal, a card that goes by itself after a good run, a reload.
export default async function section() {
  let { endpoint } = run;
  check("OneDrive's Pobot folder is on this Mac, so the check has a backup folder of its own", backupReady, backupDir);
  const side3 = await sideChannel(endpoint);
  const pad = (n) => String(n).padStart(2, "0");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keygen = (name, kind) => execFileSync("ssh-keygen", [...kind, "-N", "", "-C", "pobots-app-check", "-q", "-f", join(keysDir, name)], { stdio: "ignore" });
  keygen("right", ["-t", "rsa", "-b", "4096"]);
  keygen("short", ["-t", "rsa", "-b", "2048"]);
  keygen("ed", ["-t", "ed25519"]);
  const pub = (name) => readFileSync(join(keysDir, `${name}.pub`), "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", join(keysDir, "right.pub")], { encoding: "utf8" }).split(/\s+/)[1];
  const shown = (sel) => `(document.querySelector(${JSON.stringify(`${sel} .pb-swap-line[data-show]`)})?.textContent ?? "")`;
  const stateLine = shown(".pb-backup-line");
  const keyNote = shown("#backup-key-note");
  const printText = shown(".pb-backup-print-text");
  const openSettings = async () => {
    await until(`!!document.querySelector(".pb-foot-settings")`, 15_000);
    await js(`document.querySelector(".pb-foot-settings").click()`);
    return !!(await until(`!!document.querySelector(".app-appsettings .pb-backup")`, 10_000));
  };
  const paste = async (text) => {
    await js(`(() => { const t = document.querySelector("#backup-public-key"); t.focus(); t.select(); })()`);
    await cmd("Input.insertText", { text });
  };
  const runsNow = async () => (await side3.request("snapshot")).backup;

  check("the settings window opens from the gear at the foot of the roster", await openSettings());
  check("with no key the page says so", (await until(`${stateLine} === "No backups yet. Add a key to start."`, 10_000)) === true && (await js(`document.querySelector(".pb-backup")?.dataset.key`)) === "none", String(await js(stateLine)));
  await shot("47-backup-no-key");

  await paste(pub("ed"));
  await clickButton("Save key");
  const edNote = await until(`(() => { const t = ${keyNote}; return /Ed25519/.test(t) ? t : ""; })()`, 10_000);
  check("an Ed25519 key is refused with the engine's plain sentence", edNote === "That is an Ed25519 key. Make an RSA key of 4096 bits instead.", String(edNote ?? (await js(keyNote))));
  await paste(pub("short"));
  await clickButton("Save key");
  const shortNote = await until(`(() => { const t = ${keyNote}; return /2048/.test(t) ? t : ""; })()`, 10_000);
  check("a 2048-bit key is refused with the engine's plain sentence", shortNote === "This RSA key has 2048 bits. Make one of 4096 bits.", String(shortNote ?? (await js(keyNote))));
  await shot("48-backup-refused-2048");
  // A private key pasted by mistake: the window refuses it itself, empties the field and never sends it.
  const privateText = readFileSync(join(keysDir, "short"), "utf8");
  const piece = privateText.split("\n").find((l) => l.length > 40 && !l.startsWith("-----"))?.slice(8, 40) ?? "";
  await paste(privateText);
  await sleep(500);
  const afterPrivate = await js(`({ note: ${keyNote}, field: document.querySelector("#backup-public-key").value, inPage: document.body.innerHTML.includes(${JSON.stringify(piece)}) })`);
  check(
    "a pasted private key is refused in the window with the same sentence, the field is emptied, and nothing of it reaches the page or the engine's log",
    afterPrivate.note === "That is a private key. Paste the public key instead, and keep the private key in 1Password." && afterPrivate.field === "" && !afterPrivate.inPage && piece.length > 20 && !engineLog.join("").includes(piece),
    afterPrivate.note,
  );
  check("no key was saved by any of these", !(await runsNow()).key);

  await paste(pub("right"));
  await clickButton("Save key");
  const shownPrint = await until(`(() => { const t = ${printText}; return t.startsWith("SHA256:") ? t : ""; })()`, 10_000);
  check("the right key is saved and the page shows the fingerprint ssh-keygen prints", shownPrint === fingerprint, `${shownPrint} / ${fingerprint}`);
  const keySavedAt = Date.parse((await runsNow()).key?.savedAt ?? "");
  await shot("49-backup-key-saved");

  // "Back up now": every line keeps its box while the state changes in place, watched every 50 ms.
  await js(`(() => {
    const sels = [".pb-backup-line", ".pb-backup-next", ".pb-backup-now", ".pb-backup-key", "#backup-folder", "#backup-runs"];
    const box = () => JSON.stringify(sels.map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; }));
    const w = (window.__backupWatch = { first: box(), moved: [], lines: [] });
    // Every change of the state line, as it happens; the boxes every 50 ms and at each change.
    const look = () => {
      const b = box();
      if (b !== w.first && w.moved.length < 5) w.moved.push(b);
      const l = ${stateLine};
      if (w.lines[w.lines.length - 1] !== l) w.lines.push(l);
    };
    look();
    w.observer = new MutationObserver(look);
    w.observer.observe(document.querySelector(".pb-backup-line"), { subtree: true, attributes: true, childList: true, characterData: true });
    w.timer = setInterval(look, 50);
  })()`);
  const pressedAt = new Date();
  await js(`document.querySelector(".pb-backup-now").click()`);
  const nameAt = (d) => `pobots-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}.pobotsbackup`;
  const names = [nameAt(pressedAt), nameAt(new Date(pressedAt.getTime() + 60_000))];
  let fileName;
  for (let i = 0; i < 120 && !fileName && backupReady; i++) {
    fileName = readdirSync(backupDir).find((n) => /^pobots-backup-\d{4}-\d{2}-\d{2}T\d{4}\.pobotsbackup$/.test(n));
    if (!fileName) await sleep(250);
  }
  check("the file appears in the backup folder with the right name", !!fileName && names.includes(fileName), `${fileName} (expected ${names[0]})`);
  const checkingLine = await until(`(() => { const t = ${stateLine}; return /Checking that OneDrive has it\\.$/.test(t) ? t : ""; })()`, 20_000, 100);
  check("while the engine waits for OneDrive the page says the file is made and its arrival is checked", !!checkingLine, String(checkingLine ?? (await js(stateLine))));
  await shot("50-backup-checking");
  // The engine holds "uploaded" for a minute before it says saved; it gives up after 10 minutes.
  const savedLine = await until(`(() => { const t = ${stateLine}; return /saved to OneDrive\\.$|has not confirmed|failed/.test(t) ? t : ""; })()`, 11 * 60_000, 1000);
  check("the page ends as saved to OneDrive", /^(Today|Last night) at \d\d:\d\d, .+, saved to OneDrive\.$/.test(String(savedLine)), `${savedLine} after ${Math.round((Date.now() - pressedAt.getTime()) / 1000)} s`);
  const watch = await js(`(() => { const w = window.__backupWatch; clearInterval(w.timer); w.observer.disconnect(); return { moved: w.moved, first: w.first, lines: w.lines }; })()`);
  check("no line on the page moved through the run", watch.moved.length === 0, watch.moved.length ? `${watch.first} -> ${watch.moved[0]}` : `${watch.lines.length} states`);
  check(
    "the page went through its states in order: backing up, made and checking, saved",
    watch.lines.some((l) => l === "Backing up now.") && watch.lines.findIndex((l) => /Checking that OneDrive/.test(l)) > watch.lines.indexOf("Backing up now.") && /saved to OneDrive\.$/.test(watch.lines[watch.lines.length - 1]) && !watch.lines.some((l) => /has not confirmed|failed/.test(l)),
    watch.lines.join(" | "),
  );
  const runRows = await js(`[...document.querySelectorAll(".pb-backup-runs .pb-run")].map((r) => r.dataset.status + ": " + r.innerText.replace(/\\s+/g, " "))`);
  check("the recent backups list shows it as saved", runRows.length === 1 && /^saved: Saved to OneDrive/.test(runRows[0]), JSON.stringify(runRows));
  const afterRun = await runsNow();
  check("the engine says the same: saved, by you, with the file's name", afterRun.history[0]?.status === "saved" && afterRun.history[0]?.by === "you" && afterRun.history[0]?.file === fileName && !afterRun.running, JSON.stringify(afterRun.history[0]));
  await shot("51-backup-saved");

  // A reload of the page keeps the state.
  await js(`window.__beforeReload = true`);
  await cmd("Page.reload");
  await until(`!window.__beforeReload && !!document.querySelector(".app-row")`, 15_000);
  await openSettings();
  check("after a reload the page shows the same state, key and runs", (await until(`${stateLine} === ${JSON.stringify(savedLine)} && ${printText} === ${JSON.stringify(fingerprint)} && document.querySelectorAll(".pb-backup-runs .pb-run").length === 1`, 15_000)) === true, String(await js(stateLine)));

  // The restore script, with the private key on standard input straight from its file.
  const backupFile = join(backupDir, fileName ?? "missing");
  const restore = (keyName, args) =>
    new Promise((resolve) => {
      const fd = openSync(join(keysDir, keyName), "r");
      const child = spawn(process.execPath, [join(root, "scripts", "restore.mjs"), ...args, backupFile], { cwd: root, stdio: [fd, "pipe", "pipe"] });
      closeSync(fd);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.on("exit", (code) => (clearTimeout(timer), resolve({ code, out: out.trim() })));
    });
  const opened = await restore("right", ["--check"]);
  check("restore --check with the right key says it opens the backup", opened.code === 0 && /This key opens the backup/.test(opened.out) && !opened.out.includes(piece), opened.out.split("\n").pop());
  const refused = await restore("short", ["--check"]);
  check("restore --check with another key says it does not", refused.code === 2 && /does not open this backup/.test(refused.out), refused.out.split("\n").pop());
  const restored = { data: join(work, "restored", "data"), bots: join(work, "restored", "bots") };
  const put = await restore("right", ["--folders", `--data-dir=${restored.data}`, `--bots-dir=${restored.bots}`]);
  check("restore --folders puts the backup into temporary folders", put.code === 0 && existsSync(join(restored.data, "pobots.db")), put.out.split("\n").pop());
  const countsOf = (data, bots) => {
    const out = { bots: existsSync(bots) ? readdirSync(bots).filter((d) => existsSync(join(bots, d, "bot.json"))).sort() : [], items: {} };
    try {
      const db = new DatabaseSync(join(data, "pobots.db"), { readOnly: true });
      for (const r of db.prepare("SELECT t.bot_id AS bot, t.kind AS kind, COUNT(i.id) AS n FROM threads t LEFT JOIN items i ON i.thread_id = t.id GROUP BY t.id ORDER BY t.bot_id, t.kind, t.id").all()) {
        const k = `${r.bot}/${r.kind}`;
        out.items[k] = (out.items[k] ?? 0) + Number(r.n);
      }
      db.close();
    } catch (err) {
      out.error = err.message;
    }
    return out;
  };
  const madeCounts = countsOf(dataDir, botsDir);
  const restoredCounts = countsOf(restored.data, restored.bots);
  check("the restored bots and chat counts are what the check made", !madeCounts.error && madeCounts.bots.length > 0 && JSON.stringify(restoredCounts) === JSON.stringify(madeCounts), `${JSON.stringify(restoredCounts)} vs ${JSON.stringify(madeCounts)}`);

  // A nightly run that fails: the engine's time is set to the minute that has just begun (after the
  // key was saved and after the last run), the folder is made unwritable, and the engine restarted.
  const configPath = join(dataDir, "config.json");
  const nightNow = async (after) => {
    let slot = Math.floor(Date.now() / 60_000) * 60_000;
    if (slot <= after) {
      slot = Math.floor(after / 60_000) * 60_000 + 60_000;
      while (Date.now() < slot + 500) await sleep(500);
    }
    const d = new Date(slot);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const restartWithTime = async (time) => {
    side3.close();
    await stopEngine();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.backup = { ...config.backup, time };
    writeFileSync(configPath, JSON.stringify(config));
    endpoint = await startEngine();
    run.endpoint = endpoint;
    await openWindow(endpoint);
    return sideChannel(endpoint);
  };
  const systemCard = `document.querySelector(".pb-rail .pb-card-system")`;
  const cardWords = `(${systemCard} ? ${systemCard}.querySelector(".pb-card-title").textContent + " / " + (${systemCard}.querySelector(".pb-card-text")?.textContent ?? "") : "")`;
  const failedWords = "Last night's backup failed / Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.";
  let side4;
  if (backupReady) chmodSync(backupDir, 0o500);
  try {
    side4 = await restartWithTime(await nightNow(Math.max(keySavedAt, Date.parse(afterRun.history[0]?.at ?? "0"))));
    const card1 = await until(`(() => { const t = ${cardWords}; return t ? t : ""; })()`, 90_000, 500);
    check("a failed nightly run puts a card from Pobots on the Needs you rail with the plain reason", card1 === failedWords && !!(await js(`!!${systemCard}.querySelector(".pb-pobots-mark")`)), String(card1));
    await shot("52-backup-failed-card");
    await js(`[...${systemCard}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Dismiss").click()`);
    check("Dismiss puts the card away", !!(await until(`!${systemCard}`, 10_000)) && !(await side4.request("snapshot")).cards.some((c) => c.kind === "system"));
    const failedAt = Date.parse((await side4.request("snapshot")).backup.history[0]?.at ?? "0");
    side4.close();
    side4 = await restartWithTime(await nightNow(failedAt));
    const card2 = await until(`(() => { const t = ${cardWords}; return t ? t : ""; })()`, 90_000, 500);
    check("the next failed night puts up a new card", card2 === failedWords, String(card2));
  } finally {
    if (backupReady) chmodSync(backupDir, 0o700);
  }
  await openSettings();
  await js(`document.querySelector(".pb-backup-now").click()`);
  const goodAgain = await until(`(() => { const t = ${stateLine}; return /saved to OneDrive\\.$|has not confirmed|failed\\./.test(t) && !${systemCard} ? t : ""; })()`, 11 * 60_000, 1000);
  check("after a good run the failure card is gone by itself", /saved to OneDrive\.$/.test(String(goodAgain)) && !(await side4.request("snapshot")).cards.some((c) => c.kind === "system"), String(goodAgain ?? (await js(cardWords))));
  await shot("53-backup-card-gone");
  side4.close();
}
