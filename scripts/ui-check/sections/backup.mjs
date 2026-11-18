// The window check, section "backup". Run it alone: node scripts/ui-check.mjs --only=backup
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ the nightly backup (job 5)
// docs/build/step-backup.md, "The app builder". The mock's backup (ui/engine/mock-backup.ts) starts
// from &backup=none|key|saved|unconfirmed|failed|stale|running|nofolder; "Back up now" takes the
// time `backupRunMs` sets and ends as `backupNext` says (saved by default). A nightly run that fails
// or stays unconfirmed puts a card from Pobots on the rail in the place of an older one.
export default async function section() {
  backupStep: {
  const backupShots = arg("backup-shots") ?? (shots ? join(shots, "backup") : undefined);
  if (backupShots) mkdirSync(backupShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it, or of the whole window. */
  async function bShot(name, selector) {
    if (!backupShots) return;
    await sleep(450);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      if (r && !r.error) clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(backupShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }

  // Public keys of the right shape for the mock: the type, e and n, each with its length. n is random
  // with its top bit set, so it has exactly `bits` bits. Not real keys; nobody holds them.
  const { createHash, randomBytes } = await import("node:crypto");
  const sshKey = (bits, comment = "pobots-test@example.com") => {
    const str = (buf) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length);
      return Buffer.concat([len, buf]);
    };
    const n = randomBytes(bits / 8);
    n[0] |= 0x80;
    const blob = Buffer.concat([str(Buffer.from("ssh-rsa")), str(Buffer.from([1, 0, 1])), str(Buffer.concat([Buffer.from([0]), n]))]);
    const b64 = blob.toString("base64");
    return { line: `ssh-rsa ${b64} ${comment}`, b64, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
  };
  /** The engine's sentence for a backup folder that is missing or cannot be written. */
  const CANNOT_WRITE = "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.";
  /** Where every box above the steps of "How to make a key" stands. */
  const aboveHow = `() => { const R = (x) => Math.round(x * 10) / 10; return [".pb-appsettings-head", ".pb-backup-line", ".pb-backup-next", ".pb-backup-now", ".pb-backup-key-text", ".pb-backup-print", "#backup-public-key", ".pb-backup-save", ".pb-backup-note", ".pb-backup-how-toggle"].map((s) => document.querySelector(s)).flatMap((e) => { const b = e ? e.getBoundingClientRect() : { top: -1, left: -1, height: -1, width: -1 }; return [b.top, b.left, b.height, b.width]; }).map(R).join(","); }`;
  /** Watches, every frame, how readable the shown fingerprint and its facts are, and which fingerprints were shown. */
  const printWatch = `(() => { const id = Math.random(); window.__pwId = id; const s = (window.__pw = { min: 1, texts: [], anims: 0, frames: 0 }); const tick = () => { if (window.__pwId !== id) return; s.frames++; const el = $(".pb-backup-print-text .pb-swap-line[data-show]"); const f = $(".pb-backup-print-facts .pb-swap-line[data-show]"); for (const e of [el, f]) { if (!e) { s.min = 0; continue; } s.min = Math.min(s.min, Number(getComputedStyle(e).opacity)); s.anims += e.getAnimations().length; } const t = el?.textContent ?? ""; if (s.texts.at(-1) !== t) s.texts.push(t); requestAnimationFrame(tick); }; tick(); return true; })()`;
  const printStop = `(() => { window.__pwId = null; return window.__pw; })()`;

  // The words behind the page (ui/lib/backup.ts), read straight from the source.
  const lib = await import(pathToFileURL(join(root, "ui/lib/backup.ts")).href);
  check("backup: a folder in the Mac's OneDrive reads OneDrive, folder Pobot, with the folders after it", lib.folderWords("/Users/someone/Library/CloudStorage/OneDrive-Personal/Pobot/test-copy") === "OneDrive, folder Pobot / test-copy" && lib.folderWords("~/Library/CloudStorage/OneDrive-Example/Pobot") === "OneDrive, folder Pobot");
  check("backup: any other folder reads by its last two names", lib.folderWords("/Volumes/Disk/Backups/Pobots") === "Folder Backups / Pobots");
  const stateWith = (savedAt, runs) => ({ key: { fingerprint: "SHA256:x", bits: 4096, savedAt }, folder: { path: "/x", ok: true }, time: "03:00", keep: 14, running: false, history: runs.map(([at, status]) => ({ at, status, by: "night" })) });
  check(
    "backup: files made before the key was saved count as locked to an older key; failed runs and later files do not",
    lib.hasOlderKeyBackups(stateWith("2026-11-13T10:00:00Z", [["2026-11-13T03:00:00Z", "saved"]])) && !lib.hasOlderKeyBackups(stateWith("2026-11-13T10:00:00Z", [["2026-11-13T11:00:00Z", "saved"], ["2026-11-13T03:00:00Z", "failed"]])),
  );
  const FAKE_PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAbm90LWEtcmVhbC1rZXk=\n-----END OPENSSH PRIVATE KEY-----";

  // Step 7b: the way in is the gear of the icon row at the foot of the roster, and the page is the settings window.
  const ENTRY = ".pb-foot-settings";
  const PAGE = ".app-appsettings";
  /** What the backup section shows, in words. */
  const pageWords = `(() => { const p = $(".pb-backup"); if (!p) return null; const shown = (el) => el ? ($$(".pb-swap-line[data-show]", el)[0]?.textContent ?? el.textContent).trim() : null; return {
      line: shown($(".pb-backup-line")), tone: $(".pb-backup-line")?.dataset.tone, next: shown($(".pb-backup-next")), button: shown($(".pb-backup-now")), off: $(".pb-backup-now")?.getAttribute("aria-disabled") === "true",
      keyText: shown($(".pb-backup-key-text")), print: shown($(".pb-backup-print-text")), facts: shown($(".pb-backup-print-facts")), note: shown($(".pb-backup-note")), noteError: !!$(".pb-backup-note .pb-swap-line[data-show].app-hint-error"), noteAlert: $(".pb-backup-note")?.getAttribute("role") === "alert",
      field: $("#backup-public-key")?.value ?? null, label: $('label[for="backup-public-key"]')?.textContent, saved: !!$(".pb-backup-key .pb-saved[data-show]"), folder: $(".pb-backup-folder")?.textContent,
      runs: $$(".pb-backup-runs .pb-run").map((r) => r.querySelector(".pb-run-word").textContent + " | " + r.querySelector(".pb-run-note").textContent), key: p.dataset.key,
    }; })()`;
  /** Where every box of the page stands, down to the rows of Recent backups that stood when the watch began (`watchPage`), and the roster's rows. */
  const pageLayout = `() => { const r = (e) => e ? e.getBoundingClientRect() : { top: -1, left: -1, height: -1, width: -1 }; const R = (x) => Math.round(x * 10) / 10;
      const parts = [".pb-backup-line", ".pb-backup-line > .pb-mark", ".pb-backup-next", ".pb-backup-now", ".pb-backup-act-error", ".pb-backup-key-text", ".pb-backup-print", ".pb-backup-print-text", ".pb-backup-print-facts", ".pb-backup-print-old", "#backup-public-key", ".pb-backup-save", ".pb-backup-note", ".pb-backup-how-toggle", ".pb-backup-folder", ".pb-backup-folder-problem", "#backup-runs", ".pb-appsettings-head"].map((s) => document.querySelector(s))
        // After the tester: the rows of Recent backups that stood when the watch began must not move either.
        .concat([...document.querySelectorAll(".pb-backup-runs .pb-run")].slice(0, window.__bwRows ?? 0));
      return parts.flatMap((e) => { const b = r(e); return [b.top, b.left, b.height, b.width]; }).map(R).join(","); }`;
  const rosterLayout = `() => { const r = (e) => e.getBoundingClientRect(); const R = (x) => Math.round(x * 10) / 10;
      return [...document.querySelectorAll(".app-side .pb-wordmark, .app-side .app-row, .app-side .pb-channel-row, .app-side .pb-browser-line, .app-side .pb-side-line, .app-side .pb-foot-icon, .app-side .pb-side-title")].flatMap((e) => [r(e).top, r(e).left, r(e).height, r(e).width]).map(R).join(","); }`;
  // Each watch has its own id, so the frame loop of a watch that was stopped never writes into the next one.
  const startWatch = (layoutFn) => `(() => { const L = ${layoutFn}; const id = Math.random(); const samples = [L()]; window.__bw = samples; window.__bwId = id; window.__bwObs?.disconnect(); window.__bwObs = new MutationObserver(() => samples.push(L())); window.__bwObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); const tick = () => { if (window.__bwId !== id) return; samples.push(L()); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`;
  const stopWatch = `(() => { window.__bwId = null; window.__bwObs.disconnect(); const a = window.__bw; return { samples: a.length, first: a[0], bad: a.filter((x) => x !== a[0]).slice(0, 2) }; })()`;
  const still = (w) => !!w && w.samples > 1 && w.bad.length === 0;
  /** Watches every box of the backup page, the rows of Recent backups shown now among them. */
  const watchPage = async () => {
    // Job 4: Backup sits below Notifications now, under the fold. It is brought to the top of the page
    // first, as a person scrolls to it, so focusing the key field does not scroll the page in the watch.
    await ev(`(() => { const s = $('[data-section="backup"]'); if (s) inPanel(s); return true; })()`);
    await ev(`(() => { window.__bwRows = document.querySelectorAll(".pb-backup-runs .pb-run").length; return true; })()`);
    return ev(startWatch(pageLayout));
  };
  const settled = async (sel) => {
    await sleep(300);
    await until(`(() => { const el = $(${JSON.stringify(sel)}); return !!el && el.getAnimations({ subtree: true }).every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity); })()`, 3000);
    await sleep(100);
  };
  /** Puts this text in the key field as a paste would, then presses Save key. */
  const pasteKey = async (text, { enter = false } = {}) => {
    await ev(`(() => { const t = $("#backup-public-key"); t.focus(); t.select(); return true; })()`);
    if (text) await type(text);
    else await ev(`(() => { const t = $("#backup-public-key"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    if (enter) await key("Enter");
    else await ev(`click($(".pb-backup-save"))`);
    await sleep(250);
  };
  const openPage = async () => {
    await ev(`click($(${JSON.stringify(ENTRY)}))`);
    const ok = await until(`!!$(${JSON.stringify(PAGE)})`);
    await settled(PAGE);
    return ok;
  };
  const clock = `(() => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); })()`;

  for (const theme of ["dark", "light"]) {
    const T = (name) => `${theme}: backup: ${name}`;
    const first = theme === "dark";

    // ---------------- the entry at the foot of the roster
    await open("backup=none", { theme });
    const entry = await ev(`(() => { const e = $(${JSON.stringify(ENTRY)}); if (!e) return null; const foot = $(".app-side-foot"); return { title: e.getAttribute("title"), inFoot: !!foot && foot.contains(e), last: foot?.lastElementChild?.contains(e), dot: !!e.querySelector(".pb-foot-dot[data-show]"), label: e.getAttribute("aria-label"), tag: e.tagName }; })()`);
    check(T("a quiet entry, the settings gear, at the very foot of the roster"), entry?.title?.startsWith("Settings") && entry.inFoot && entry.last && entry.tag === "BUTTON", entry);
    check(T("with no key the entry carries a quiet mark, read out as backup not set up"), entry?.dot && entry.label === "Settings, backup not set up", entry);
    const dotColour = await ev(`(() => { const d = $(".pb-foot-dot"); const s = getComputedStyle(d); const probe = document.createElement("div"); probe.style.color = "var(--ink-muted)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return { bg: s.backgroundColor, inkMuted: c, w: d.getBoundingClientRect().width }; })()`);
    check(T("the mark is a small dot in a quiet grey, not an alarm colour"), dotColour?.bg === dotColour?.inkMuted && dotColour.w <= 8, dotColour);
    await bShot(`entry-no-key-${theme}`, `$(".app-side-foot")`);

    // Opening moves nothing in the roster, and the chat stays where it was underneath.
    await goTo("Kaja", "chat");
    await until(`$$(".app-main .pb-main-scroll .pb-msg").length > 3`);
    await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 240); return true; })()`);
    await sleep(200);
    const chatTop = await ev(`$(".app-main .pb-main-scroll").scrollTop`);
    await ev(startWatch(rosterLayout));
    await openPage();
    let w = await ev(stopWatch);
    check(T("opening the page does not move the roster by a pixel"), still(w), w);
    const opened = await ev(`(() => ({ page: !!$(${JSON.stringify(PAGE)}), current: $(${JSON.stringify(ENTRY)}).getAttribute("aria-current"), rowCurrent: $$('.app-row[aria-current="true"]').length, focus: document.activeElement?.textContent, title: $(".pb-appsettings-title")?.textContent, chatHidden: getComputedStyle($(".app-main:not(.app-appsettings)")).visibility, inert: $(".app-main:not(.app-appsettings)").inert, sections: $$(".pb-appsettings-section").map((s) => s.dataset.section), back: $(".pb-appsettings-back")?.getAttribute("aria-label"), modal: $(".app-appsettings")?.getAttribute("aria-modal") }))()`);
    // Step 7b: a window over the app (was: the page in the reading panel).
    check(T("the settings window opens over the app, the gear marked as the open page"), opened?.page && opened.current === "page" && opened.modal === "true" && opened.title === "Settings", opened);
    // Job 4: Notifications stands first (was: Backup is the first section). Steering (protocol 14) put
    // "When a bot is working" between them; Backup and its list of runs stay last.
    check(T("Backup is its section after About you, Notifications and When a bot is working, built for more to follow"), opened?.sections?.join(",") === "about,notify,chat,backup", opened);
    check(T("the window takes the focus on its title; the chat stays where it was underneath, out of reach"), opened?.focus === "Settings" && opened.chatHidden === "visible" && opened.inert === true, opened);
    check(T("the window has a close control"), opened?.back === "Close settings", opened);
    await houseRules(T("the page with no key"));

    // ---------------- the page without a key
    let words = await ev(pageWords);
    check(T("no key: the state says so plainly"), words?.line === "No backups yet. Add a key to start." && words.tone === "none" && words.key === "none", words);
    check(T("no key: what to do, in plain sentences, with the private key staying in 1Password"), /^In your private vault in 1Password, make an SSH Key of the kind RSA, 4096 bits\. Copy its public key and paste it below\. The private key stays in 1Password/.test(words?.keyText ?? ""), words);
    check(T("no key: the well keeps the fingerprint's place, and Back up now is off with its reason"), words?.print === "No key yet" && words.off && words.next === "Backups start once a key is saved.", words);
    const intro = await ev(`$(".pb-backup > .pb-section-text").textContent`);
    check(T("the page says what the backup is and that only the key in 1Password opens it"), /Every night at 03:00 Pobots packs all chats, every bot's folder and the settings into one locked file and puts it in your OneDrive\. Only your key in 1Password can open it\. The last 14 nights are kept\./.test(intro ?? ""), intro);
    const jargon = await ev(`document.querySelector(".app-appsettings").innerText.match(/RSA-OAEP|AES|GCM|encrypt|cipher|PKCS|tarball|\\bjson\\b/gi)`);
    check(T("no jargon on the page"), jargon === null, jargon);
    const before = (await ev(`window.pobotsMock.requests()["backup.run"] ?? 0`)) ?? 0;
    await ev(`click($(".pb-backup-now"))`);
    await sleep(300);
    check(T("no key: pressing Back up now asks nothing of the engine"), ((await ev(`window.pobotsMock.requests()["backup.run"] ?? 0`)) ?? 0) === before);
    await bShot(`page-no-key-${theme}`);

    // ---------------- each refusal, in the place under the field, moving nothing
    const k2048 = sshKey(2048);
    const refusals = [
      ["", "Paste the public key. It starts with ssh-rsa."],
      ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJhY2t1cC10ZXN0LWtleS1ub3QtcmVhbA pobots-test@example.com", "That is an Ed25519 key. Make an RSA key of 4096 bits instead."],
      ["my key from 1Password", "That does not look like a public key. It should start with ssh-rsa."],
      [`ssh-rsa ${sshKey(4096).b64.slice(0, 300)}`, "The key is incomplete. Copy the whole public key again."],
      [k2048.line, "This RSA key has 2048 bits. Make one of 4096 bits."],
    ];
    await watchPage();
    for (const [text, sentence] of refusals) {
      await pasteKey(text);
      words = await ev(pageWords);
      check(T(`a refused key shows the engine's sentence under the field: "${sentence}"`), words?.note === sentence && words.noteError && words.noteAlert && words.key === "none", words);
    }
    await sleep(200);
    w = await ev(stopWatch);
    check(T("the refusals change words in place: nothing on the page moves"), still(w), w);
    if (first) await bShot(`refusal-2048-${theme}`, `$(".pb-backup-key")`);

    // A private key is refused by the window itself, never sent and never kept.
    const sentBefore = await ev(`window.pobotsMock.backupKeyTexts().length`);
    await ev(`(() => { const t = $("#backup-public-key"); t.focus(); t.select(); return true; })()`);
    await type(FAKE_PRIVATE);
    await sleep(200);
    words = await ev(pageWords);
    const leak = await ev(`(() => { const state = JSON.stringify(window.pobotsState()); const sent = window.pobotsMock.backupKeyTexts(); return { inState: state.includes("PRIVATE KEY") || state.includes("b3BlbnNzaC1rZXkt"), sent: sent.length, anySent: sent.some((x) => /PRIVATE KEY/.test(x)), inPage: document.body.innerHTML.includes("b3BlbnNzaC1rZXkt") }; })()`);
    check(T("a pasted private key is refused at once with the engine's sentence, and the field is emptied"), words?.note === "That is a private key. Paste the public key instead, and keep the private key in 1Password." && words.field === "" && words.noteError, words);
    check(T("a pasted private key is never sent to the engine, kept in the state or left in the page"), leak && !leak.inState && !leak.anySent && leak.sent === sentBefore && !leak.inPage, leak);
    await ev(`click($(".pb-backup-save"))`);
    await sleep(250);
    check(T("Save after a refused private key sends nothing that holds it"), !(await ev(`window.pobotsMock.backupKeyTexts().some((x) => /PRIVATE KEY/.test(x))`)));

    // ---------------- saving a key: words change in place, the fingerprint to compare
    const good = sshKey(4096);
    await watchPage();
    await pasteKey(good.line);
    await until(`$(".pb-backup")?.dataset.key === "set"`);
    await sleep(300);
    w = await ev(stopWatch);
    words = await ev(pageWords);
    const now = await ev(clock);
    check(T("saving a key shows its fingerprint exactly as ssh-keygen prints it"), words?.print === good.fingerprint, { print: words?.print, want: good.fingerprint });
    check(T("the key's size and when it was saved, and to compare it with 1Password"), /^RSA 4096 · Saved today at \d\d:\d\d$/.test(words?.facts ?? "") && /^Compare this with the fingerprint in 1Password\./.test(words.keyText), { words, now });
    check(T("the field empties, says Saved, and is ready for a new public key"), words?.field === "" && words.saved && words.label === "New public key" && words.note === "One line that starts with ssh-rsa. It can only lock backups, not open them.", words);
    check(T("with a key the state reads No backups yet, the next run is tonight, Back up now is on"), words?.line === "No backups yet." && words.next === "Next backup tonight at 03:00." && !words.off, words);
    check(T("saving a key changes words in place: nothing on the page moves"), still(w), w);
    const entryAfter = await ev(`({ dot: !!$(".pb-foot-dot[data-show]"), label: $(${JSON.stringify(ENTRY)}).getAttribute("aria-label") })`);
    check(T("with a key the roster's quiet mark is gone"), entryAfter && !entryAfter.dot && entryAfter.label === "Settings", entryAfter);
    await bShot(`page-key-saved-${theme}`);

    // A key broken over lines, with spaces around it, saved with Enter, of 3072 bits.
    const k3072 = sshKey(3072);
    const broken = `  ssh-rsa ${k3072.b64.slice(0, 200)}\n${k3072.b64.slice(200)} pobots-test@example.com  `;
    await ev(printWatch);
    await pasteKey(broken, { enter: true });
    await until(`window.pobotsMock.backupState().key?.bits === 3072`);
    await sleep(400);
    const print = await ev(printStop);
    check(T("saving a new key: the old fingerprint stays fully readable until the new one stands in its box, no fade"), print?.frames > 5 && print.min === 1 && print.anims === 0 && print.texts.join("|") === `${good.fingerprint}|${k3072.fingerprint}`, print);
    words = await ev(pageWords);
    check(T("a key broken over lines is joined and saved with Enter; 3072 bits are accepted"), words?.print === k3072.fingerprint && words.facts.startsWith("RSA 3072"), words);

    // ---------------- Back up now: running, then saved; every line keeps its box
    await ev(`window.pobotsMock.backupRunMs(1200)`);
    const nowBox = await ev(`(() => { const b = $(".pb-backup-now").getBoundingClientRect(); return [b.width, b.height].join("x"); })()`);
    await watchPage();
    await ev(`click($(".pb-backup-now"))`);
    const running = await until(`(() => { const w = ${pageWords}; return w.button === "Backing up" ? w : null; })()`, 2000);
    const runBox = await ev(`(() => { const b = $(".pb-backup-now").getBoundingClientRect(); return [b.width, b.height].join("x"); })()`);
    check(T("Back up now turns Backing up at the same size, and the state says so"), running?.line === "Backing up now." && running.off && runBox === nowBox, { running, nowBox, runBox });
    if (first) await bShot(`running-${theme}`, `$(".pb-backup-state")`);
    const done = await until(`(() => { const w = ${pageWords}; return w.button === "Back up now" && w.tone === "saved" ? w : null; })()`, 4000);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("the run ends saved: when, how large, saved to OneDrive"), /^Today at \d\d:\d\d, 3\.\d MB, saved to OneDrive\.$/.test(done?.line ?? ""), done);
    check(T("the new run is the last of Recent backups, at the bottom, by you"), /^Saved to OneDrive \| 3\.\d MB · By you$/.test(done?.runs?.at(-1) ?? ""), done?.runs);
    check(T("through the whole run every line above Recent backups keeps its box"), still(w), w);
    await houseRules(T("the page with a key and a run"));

    // A run that stays unconfirmed, then one that fails: the words change, the boxes do not.
    await ev(`window.pobotsMock.backupNext("unconfirmed")`);
    await watchPage();
    await ev(`click($(".pb-backup-now"))`);
    const unconf = await until(`(() => { const w = ${pageWords}; return w.tone === "unconfirmed" && w.button === "Back up now" ? w : null; })()`, 4000);
    check(T("an unconfirmed run says the file was made but OneDrive has not confirmed it"), /^Made today at \d\d:\d\d, but OneDrive has not confirmed it yet\.$/.test(unconf?.line ?? "") && /^Not confirmed by OneDrive \| 3\.\d MB · By you · OneDrive did not take the file\./.test(unconf.runs.at(-1)), unconf);
    await ev(`window.pobotsMock.backupNext("failed", "Pobots could not write the file to the OneDrive folder.")`);
    await ev(`click($(".pb-backup-now"))`);
    const failedRun = await until(`(() => { const w = ${pageWords}; return w.tone === "failed" && w.button === "Back up now" ? w : null; })()`, 4000);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("a failed run says so, and its line under Recent backups gives the reason"), /^The backup today at \d\d:\d\d failed\. The reason is under Recent backups\.$/.test(failedRun?.line ?? "") && failedRun.runs.at(-1) === "Failed | Pobots could not write the file to the OneDrive folder.", failedRun);
    check(T("unconfirmed and failed runs move nothing above Recent backups"), still(w), w);
    const failedColour = await ev(`(() => { const probe = document.createElement("div"); probe.style.color = "var(--clay)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return { word: getComputedStyle($$(".pb-backup-runs .pb-run").at(-1).querySelector(".pb-run-word")).color, clay: c, mark: !!$(".pb-backup-line > .pb-mark-blocked") }; })()`);
    check(T("a failed run is marked by its word and mark, not by colour alone"), failedColour?.word === failedColour?.clay && failedColour.mark, failedColour);
    await bShot(`page-failed-${theme}`);

    // ---------------- going back: the chat as it was, the focus where it came from
    await ev(`click($(".pb-appsettings-back"))`);
    await until(`!$(${JSON.stringify(PAGE)})`);
    await sleep(250);
    const back = await ev(`(() => ({ top: $(".app-main .pb-main-scroll").scrollTop, label: $(".app-main").getAttribute("aria-label"), visible: getComputedStyle($(".app-main")).visibility, row: $('.app-row[aria-current="true"] .pb-row-name')?.textContent, focus: document.activeElement?.className, current: $(${JSON.stringify(ENTRY)}).getAttribute("aria-current") }))()`);
    check(T("going back returns to the chat that was open, at the same place"), back?.label === "Kaja" && back.visible === "visible" && back.row === "Kaja" && Math.abs(back.top - chatTop) <= 1 && back.current === null, { back, chatTop });
    check(T("going back gives the focus to the entry it came from"), back?.focus === "pb-foot-icon pb-foot-settings", back);
    // Escape on the page goes back too; in the field it does not.
    await openPage();
    await ev(`$("#backup-public-key").focus()`);
    await key("Escape");
    check(T("Escape in the key field leaves the page open"), !!(await ev(`!!$(${JSON.stringify(PAGE)})`)));
    await ev(`$(".pb-appsettings-title").focus()`);
    await key("Escape");
    check(T("Escape on the page goes back"), !!(await until(`!$(${JSON.stringify(PAGE)})`)));
    // Opening a bot from the roster while the page is open closes it.
    await openPage();
    await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Inbox"))`);
    check(T("choosing a bot in the roster leaves the page for that bot"), !!(await until(`!$(${JSON.stringify(PAGE)}) && $(".app-main").getAttribute("aria-label") === "Inbox"`)));

    // ---------------- the keyboard: reach the entry, the field, the buttons; focus rings
    await open("backup=none", { theme });
    await ev(`$$(".app-row").at(-1).focus()`);
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await key("Tab");
      reached = await ev(`document.activeElement?.classList.contains("pb-foot-settings")`);
    }
    const ring = await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
    check(T("the entry is reached with Tab and shows the focus ring"), reached && ring, { reached, ring });
    await key("Enter");
    check(T("Enter on the entry opens the page with the focus on its title"), !!(await until(`!!$(${JSON.stringify(PAGE)}) && document.activeElement?.classList.contains("pb-appsettings-title")`)));
    await settled(PAGE);
    const order = [];
    // Job 4: the controls of the Notifications section, which stands above Backup now, are passed over;
    // so is the one stop of "When a bot is working" (steering), which stands between them, and About
    // you (engine 0.33.0), first on the page.
    for (let i = 0; i < 24 && order.length < 6; i++) {
      await key("Tab");
      if (await ev(`!!document.activeElement?.closest(".pb-notify, .pb-followup, .pb-about")`)) continue;
      order.push(await ev(`(() => { const a = document.activeElement; const s = getComputedStyle(a); return (a.id || a.className.split(" ").filter((c) => c.startsWith("pb-backup") || c.startsWith("pb-appsettings")).join(".") || a.tagName) + (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 ? "" : "!noring"); })()`));
    }
    // Step 7b: the window's close, then its section list (one stop), then the section.
    check(T("Tab goes from the close to the sections, then Back up now, the key field and Save key, each with a focus ring"), order.slice(0, 5).join(",") === "pb-appsettings-back,setwin-tab-general,pb-backup-now,backup-public-key,pb-backup-save", order);
    await ev(`$(".pb-appsettings-title").focus()`);
    await focusRings(T("the page"), 8);
    // Typing a key and pressing Enter saves it, read out by the field's own words.
    await ev(`$("#backup-public-key").focus()`);
    await type(sshKey(4096).line);
    await key("Enter");
    check(T("a key typed by keyboard is saved with Enter"), !!(await until(`$(".pb-backup")?.dataset.key === "set"`)));
    const sr = await ev(`(() => ({ status: $(".pb-backup-line").getAttribute("role"), described: document.getElementById($("#backup-public-key").getAttribute("aria-describedby"))?.textContent.includes("starts with ssh-rsa"), hidden: $$(".pb-swap-line:not([data-show])").every((x) => x.getAttribute("aria-hidden") === "true"), shown: $$(".pb-swap-line[data-show]").every((x) => !x.hasAttribute("aria-hidden")) }))()`);
    check(T("for a screen reader: the state is a status, the field is described, only the shown words are read out"), sr?.status === "status" && sr.described && sr.hidden && sr.shown, sr);

    // ---------------- 800 px: the page, the roster of faces only with its mark
    await open("backup=none", { width: 800, theme });
    const narrow = await ev(`(() => { const e = $(${JSON.stringify(ENTRY)}); const dot = e.querySelector(".pb-foot-dot"); const side = $(".app-side").getBoundingClientRect(); const r = (x) => x.getBoundingClientRect(); return { inSide: r(e).left >= side.left && r(e).right <= side.right, dotIn: r(dot).right <= r(e).right && r(dot).left >= r(e).left, label: e.getAttribute("aria-label") }; })()`);
    check(T("800 px: the roster shows the gear with the quiet dot, the words read out"), narrow?.inSide && narrow.dotIn && narrow.label === "Settings, backup not set up", narrow);
    await bShot(`entry-800-${theme}`, `$(".app-side-foot")`);
    await ev(startWatch(rosterLayout));
    await openPage();
    w = await ev(stopWatch);
    check(T("800 px: opening the page does not move the roster"), still(w), w);
    await houseRules(T("800 px, the page with no key"));
    await bShot(`page-800-no-key-${theme}`);
    await watchPage();
    await pasteKey(k2048.line);
    await pasteKey("ssh-rsa AAAAB3NzaC1yc2E");
    await pasteKey(sshKey(4096).line);
    await until(`$(".pb-backup")?.dataset.key === "set"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("800 px: refusals and saving a key move nothing"), still(w), w);
    await ev(`window.pobotsMock.backupRunMs(900)`);
    await watchPage();
    await ev(`click($(".pb-backup-now"))`);
    await until(`(() => { const w = ${pageWords}; return w.tone === "saved" && w.button === "Back up now"; })()`, 4000);
    await ev(`window.pobotsMock.backupNext("unconfirmed")`);
    await ev(`click($(".pb-backup-now"))`);
    await until(`(() => { const w = ${pageWords}; return w.tone === "unconfirmed" && w.button === "Back up now"; })()`, 4000);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("800 px: a run from none to saved to unconfirmed keeps every line's box"), still(w), w);
    await houseRules(T("800 px, the page with runs"));
    await bShot(`page-800-runs-${theme}`);

    // ---------------- other starting points
    await open("backup=nofolder", { theme });
    await openPage();
    const nofolder = await ev(`({ problem: $(".pb-backup-folder-problem .pb-swap-line[data-show]")?.textContent, role: $(".pb-backup-folder-problem")?.getAttribute("role") })`);
    check(T("a missing OneDrive folder is said plainly under Where the files go, with what to check"), nofolder?.problem === "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there." && nofolder.role === "alert", nofolder);
    await open("backup=running", { theme });
    await openPage();
    const startRunning = await ev(pageWords);
    check(T("a backup under way when the page opens reads Backing up"), startRunning?.button === "Backing up" || startRunning?.tone === "saved", startRunning);

    // ---------------- after the tester (13 Nov 2026)
    for (const width of [1280, 800]) {
      const W = (name) => T(`${width} px: ${name}`);
      await open("backup=saved", { width, theme });
      await openPage();
      await ev(`window.pobotsMock.backupRunMs(700)`);
      const rowsBefore = await ev(`$$(".pb-backup-runs .pb-run time").map((t) => t.getAttribute("datetime"))`);
      const lastOnPage = await ev(`(() => { const s = $(".pb-backup"); return s.lastElementChild === $("#backup-runs").closest(".pb-backup-part") && $(".pb-settings").lastElementChild.contains(s); })()`);
      check(W("Recent backups read oldest first with the newest at the bottom, and are the last thing on the page"), Array.isArray(rowsBefore) && rowsBefore.length >= 2 && rowsBefore.every((t, n) => n === 0 || Date.parse(rowsBefore[n - 1]) < Date.parse(t)) && lastOnPage === true, { rowsBefore, lastOnPage });
      // A run by hand that fails on the folder, then the next run: nothing under the status area moves, no row of Recent backups either.
      await watchPage();
      await ev(`window.pobotsMock.backupNext("failed", ${JSON.stringify(CANNOT_WRITE)})`);
      await ev(`click($(".pb-backup-now"))`);
      const failedFolder = await until(`(() => { const w = ${pageWords}; const p = $(".pb-backup-folder-problem .pb-swap-line[data-show]")?.textContent; return w.tone === "failed" && w.button === "Back up now" && p ? { ...w, problem: p } : null; })()`, 4000);
      await sleep(300);
      await ev(`click($(".pb-backup-now"))`);
      // The engine looks at the folder again when the run starts (a moment after the button turns).
      const again = await until(`(() => { const w = ${pageWords}; const problem = $(".pb-backup-folder-problem .pb-swap-line[data-show]")?.textContent; return w.button === "Backing up" && problem === "" ? { ...w, problem } : null; })()`, 2000);
      const after = await until(`(() => { const w = ${pageWords}; return w.tone === "saved" && w.button === "Back up now" ? w : null; })()`, 4000);
      await sleep(300);
      w = await ev(stopWatch);
      check(W("a run by hand that fails on the folder says so under Where the files go, with what to check"), failedFolder?.problem === CANNOT_WRITE && failedFolder.runs.at(-1) === `Failed | ${CANNOT_WRITE}`, failedFolder);
      check(W("the next run finds the folder again, and its line goes quiet"), again?.problem === "" && !!after, { again, after });
      check(W("through a failed run by hand and the run after it nothing under the status area moves, not one row of Recent backups"), still(w), w);
      const rowsAfter = await ev(`$$(".pb-backup-runs .pb-run time").map((t) => t.getAttribute("datetime"))`);
      check(
        W("each new run is added below everything, the rows before it unchanged"),
        rowsAfter?.length === rowsBefore.length + 2 && rowsBefore.every((t, n) => rowsAfter[n] === t) && /^Saved to OneDrive \| .* By you$/.test(after?.runs?.at(-1) ?? "") && after.runs.at(-2) === `Failed | ${CANNOT_WRITE}`,
        { rowsBefore, rowsAfter, runs: after?.runs },
      );
    }

    // A reload while a backup runs keeps the page; back still returns to the chat that was open.
    await open("backup=saved", { theme });
    await goTo("Kaja", "chat");
    await openPage();
    await ev(`window.pobotsMock.backupRunMs(5000)`);
    await ev(`click($(".pb-backup-now"))`);
    await until(`(() => { const w = ${pageWords}; return w.button === "Backing up"; })()`, 2000);
    await b.cmd("Page.reload", {});
    await sleep(300);
    const reloaded = await until(`(() => $(${JSON.stringify(PAGE)}) && $(".pb-backup") ? { title: $(".pb-appsettings-title")?.textContent, back: $(".pb-appsettings-back")?.getAttribute("aria-label"), current: $(${JSON.stringify(ENTRY)})?.getAttribute("aria-current") } : null)()`, 6000);
    check(T("a reload while a backup runs keeps the settings open"), reloaded?.title === "Settings" && reloaded.current === "page" && reloaded.back === "Close settings", reloaded);
    await settled(PAGE);
    await ev(`click($(".pb-appsettings-back"))`);
    check(T("after the reload, back still returns to the chat that was open"), !!(await until(`!$(${JSON.stringify(PAGE)}) && $(".app-main").getAttribute("aria-label") === "Kaja"`, 3000)));
    await b.cmd("Page.reload", {});
    await sleep(300);
    await until(`!!document.querySelector(".pb-shell")`, 6000);
    await sleep(300);
    check(T("back in the chat, a reload stays in the chat"), !!(await ev(`!$(${JSON.stringify(PAGE)}) && $(".app-main").getAttribute("aria-label") === "Kaja"`)));

    // The words: the folder as a person says it, the steps for a key kept reachable, an older key named.
    await open("backup=saved", { theme });
    await openPage();
    const keyWords = await ev(`(() => { const f = $(".pb-backup-folder"); return { old: $(".pb-backup-print-old .pb-swap-line[data-show]")?.textContent ?? null, folder: f.textContent.trim(), title: f.getAttribute("title"), described: document.getElementById(f.getAttribute("aria-describedby"))?.textContent, how: $(".pb-backup-how-toggle")?.textContent, expanded: $(".pb-backup-how-toggle")?.getAttribute("aria-expanded"), steps: !!$("#backup-how") }; })()`);
    check(T("the folder reads as a person says it, the full path as its tooltip and description"), keyWords?.folder === "OneDrive, folder Pobot" && keyWords.title === "~/Library/CloudStorage/OneDrive-Personal/Pobot" && keyWords.described === keyWords.title, keyWords);
    check(T("with the key that made every backup, no line about an old key"), keyWords?.old === "", keyWords);
    check(T("with a key saved, How to make a key is there, closed"), keyWords?.how === "How to make a key" && keyWords.expanded === "false" && !keyWords.steps, keyWords);
    await ev(startWatch(aboveHow));
    await ev(`click($(".pb-backup-how-toggle"))`);
    await settled(".pb-backup-how");
    w = await ev(stopWatch);
    const steps = await ev(`(() => ({ expanded: $(".pb-backup-how-toggle").getAttribute("aria-expanded"), text: $("#backup-how")?.innerText ?? "", below: $("#backup-how").getBoundingClientRect().top >= $(".pb-backup-how-toggle").getBoundingClientRect().bottom, last: $(".pb-backup-key").lastElementChild.contains($("#backup-how")) }))()`);
    check(T("How to make a key opens the short steps in place, below everything else in the key part"), steps?.expanded === "true" && steps.below && steps.last && /SSH Key/.test(steps.text) && /RSA and the size 4096/.test(steps.text), steps);
    check(T("the steps say the key belongs in the private vault and the private key never leaves 1Password"), /private vault/.test(steps?.text ?? "") && /The private key never leaves 1Password/.test(steps?.text ?? ""), steps);
    check(T("opening the steps moves nothing above them"), still(w), w);
    const tech = await ev(`(() => { const print = $(".pb-backup-print-text .pb-swap-line[data-show]").textContent; const room = $(".pb-backup-print-text .pb-swap-room")?.textContent ?? "SHA256:"; const t = $(".app-appsettings").innerText.split(print).join("").split(room).join(""); return { ssh: t.match(/\\bSSH\\b(?! Key)/g), sha: t.match(/SHA256/g), rsa: (t.match(/.{0,12}ssh-rsa/g) ?? []).filter((m) => !/starts? with ssh-rsa$/.test(m)), ed: t.match(/Ed25519/g) }; })()`);
    check(T("no technical words on the page but the ones 1Password shows"), !!tech && !tech.ssh && !tech.sha && tech.rsa.length === 0 && !tech.ed, tech);
    const fresh = sshKey(4096);
    await watchPage();
    await pasteKey(fresh.line);
    await until(`window.pobotsMock.backupState().key?.fingerprint === ${JSON.stringify(fresh.fingerprint)}`);
    await sleep(300);
    w = await ev(stopWatch);
    const oldLine = await ev(`$(".pb-backup-print-old .pb-swap-line[data-show]")?.textContent`);
    check(T("after the key is changed, one quiet line says older backups still need the old key"), oldLine === "Backups made before you changed the key still need the old key.", oldLine);
    check(T("changing the key moves nothing on the page"), still(w), w);
    if (first) await bShot(`after-tester-key-${theme}`, `$(".pb-backup-key")`);

    // ---------------- the card from Pobots itself on the rail
    await open("", { theme });
    const kajaBefore = await ev(`window.pobotsState().bots.find((b) => b.id === "kaja").state`);
    const railBefore = await ev(`$$(".app-rail .pb-card").length`);
    await ev(`window.pobotsMock.backupRunMs(300)`);
    await ev(`window.pobotsMock.backupNext("failed", "Pobots could not write the file to the OneDrive folder.")`);
    await ev(`window.pobotsMock.backupNight()`);
    const card = await until(`(() => { const c = $(".pb-card-system"); if (!c) return null; return { title: c.querySelector(".pb-card-title").textContent, text: c.querySelector(".pb-card-text")?.textContent, mark: c.querySelector(".pb-pobots-mark")?.textContent, face: !!c.querySelector(".pb-avatar"), head: [...c.querySelector(".pb-card-head").childNodes].filter((n) => !n.classList?.contains("pb-pobots-mark")).map((n) => n.textContent).join(""), buttons: $$("button", c).map((x) => x.textContent) }; })()`, 3000);
    check(T("a failed nightly run puts a card from Pobots on the rail, with Pobots' own mark and no face"), card?.title === "Last night's backup failed" && card.text === "Pobots could not write the file to the OneDrive folder." && card.mark === "P" && !card.face && card.head === "Pobots tells you", card);
    check(T("the card offers to open the backup page and to dismiss it"), card?.buttons?.join("|") === "Open backup settings|Dismiss", card);
    const counts = await ev(`({ rail: $$(".app-rail .pb-card").length, title: $(".app-rail-title span")?.textContent, kaja: window.pobotsState().bots.find((b) => b.id === "kaja").state })`);
    check(T("the rail counts it, and the main bot does not start waiting because of it"), counts?.rail === railBefore + 1 && counts.kaja === kajaBefore && /^\d+ (today|open)$/.test(counts.title ?? ""), { counts, railBefore, kajaBefore });
    await settled(".pb-card-system");
    await ev(`(() => { const c = $(".pb-card-system"); c.__same = true; return true; })()`);
    const cardTop = await ev(`Math.round($(".pb-card-system").getBoundingClientRect().top)`);
    // The engine withdraws the old card and adds the new one; the other order must look the same.
    const cardOrder = first ? "withdraw-first" : "add-first";
    await ev(`window.pobotsMock.backupCardOrder(${JSON.stringify(cardOrder)})`);
    await ev(`window.pobotsMock.backupNext("unconfirmed")`);
    await ev(`window.pobotsMock.backupNight()`);
    const replaced = await until(`(() => { const all = $$(".pb-card-system"); const c = all[0]; if (!c || c.querySelector(".pb-card-title").textContent !== "Last night's backup did not reach OneDrive") return null; return { n: all.length, same: c.__same === true, top: Math.round(c.getBoundingClientRect().top), leaving: $$(".app-card-slot[data-leaving] .pb-card-system").length, engine: window.pobotsMock.backupCard() === c.dataset.cardId }; })()`, 3000);
    await sleep(600);
    const afterReplace = await ev(`({ n: $$(".pb-card-system").length, rail: $$(".app-rail .pb-card").length })`);
    check(T(`a newer card takes the old one's place (${cardOrder}): replaced, not stacked, nothing leaves`), replaced?.n === 1 && replaced.same && replaced.top === cardTop && replaced.leaving === 0 && replaced.engine && afterReplace?.n === 1 && afterReplace.rail === railBefore + 1, { replaced, cardTop, afterReplace });
    await ev(`(() => { const r = $(".app-rail"); r.scrollTop = r.scrollHeight; return true; })()`);
    await bShot(`card-${theme}`, `$(".pb-card-system")`);
    if (first) await bShot(`rail-with-card-${theme}`);
    await houseRules(T("the rail with the card"));
    await ev(`click(btn("Open backup settings", $(".pb-card-system")))`);
    const fromCard = await until(`!!$(${JSON.stringify(PAGE)}) && document.activeElement?.classList.contains("pb-appsettings-title")`);
    check(T("Open backup settings on the card opens the backup page"), !!fromCard);
    await ev(`click($(".pb-appsettings-back"))`);
    await until(`!$(${JSON.stringify(PAGE)})`);
    await ev(`click(btn("Dismiss", $(".pb-card-system")))`);
    const dismissed = await until(`!$(".pb-card-system") && window.pobotsMock.backupCard() === null`, 3000);
    check(T("Dismiss puts the card away"), !!dismissed);
    await ev(`window.pobotsMock.backupStale()`);
    const stale = await until(`$(".pb-card-system .pb-card-title")?.textContent`, 3000);
    check(T("no backup for two days: a card says so"), stale === "No backup for two days", stale);
    await ev(`window.pobotsMock.backupNight()`);
    const removed = await until(`!$(".pb-card-system") && window.pobotsMock.backupCard() === null`, 4000);
    check(T("the engine takes the card away after the next saved backup"), !!removed);
    const stillThere = await ev(`({ rail: $$(".app-rail .pb-card").length, kaja: window.pobotsState().bots.find((b) => b.id === "kaja").state })`);
    check(T("the bots' own cards are untouched"), stillThere?.rail === railBefore && stillThere.kaja === kajaBefore, stillThere);

    // The card as it is at start (failed in the night), in a rail with no other cards.
    await open("scene=empty-rail&backup=failed", { theme });
    const alone = await ev(`({ cards: $$(".app-rail .pb-card").length, title: $(".pb-card-system .pb-card-title")?.textContent, empty: !!$(".app-rail-empty") })`);
    check(T("a card from Pobots alone on the rail: no empty line, no crash"), alone?.cards === 1 && alone.title === "Last night's backup failed" && !alone.empty, alone);
    await ev(`click(btn("Dismiss", $(".pb-card-system")))`);
    check(T("dismissing the last card brings the rail's quiet line back"), !!(await until(`!!$(".app-rail-empty") && !$(".pb-card-system")`, 3000)));
    if (first) {
      await open("scene=artifacts&backup=unconfirmed", { theme });
      const sys = await ev(`!!$(".pb-card-system")`);
      check(T("the unconfirmed starting point shows its card"), sys);
    }
  }
  if (backupShots) console.log(`Backup pictures in ${backupShots}`);
  }
}
