// The window check, section "steer". Run it alone: node scripts/ui-check.mjs --only=steer
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ---------------- steering (protocol 14): a message sent while a bot works goes into its turn, or
// waits; the setting in Pobots settings; the other way for one message; "Steer now" on a queued one
export default async function section() {
  steerStep: {
  const S = (name) => `steering: ${name}`;
  const steerShots = arg("steer-shots") ?? (shots ? join(shots, "steer") : undefined);
  if (steerShots) mkdirSync(steerShots, { recursive: true });
  async function sShot(name) {
    if (!steerShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(steerShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const SEC = `$('[data-section="chat"]')`;
  const choice = (id) => `${SEC}.querySelector('[data-follow="${id}"]')`;
  const sectionRects = `$$('[data-section="chat"] .pb-section-title, [data-section="chat"] .pb-choice, [data-section="chat"] .pb-followup-other, [data-section="chat"] .pb-followup-problem, [data-section="backup"]').map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)].join(":"); }).join(",")`;
  const lastYou = `$$(".app-main .app-you").at(-1)`;
  const youNotes = `$$(".app-main .app-you").map((y) => [y.querySelector(".pb-msg-you")?.textContent ?? "", y.querySelector(".app-you-note")?.textContent ?? ""])`;
  // Since step 7a a waiting message stands in the stack above the message box, not in the chat.
  const waitingRow = (text) => `$$(".app-main .pb-queued").find((q) => q.querySelector(".pb-queued-text")?.textContent === ${JSON.stringify(text)})`;
  const sendBtn = `$(".app-main .pb-composer .pb-send")`;
  async function chooseFollowUp(id) {
    await ev(`click($(".pb-foot-settings"))`);
    await until(`!!${SEC}`);
    await ev(`click(${choice(id)})`);
    const ok = await until(`${choice(id)}.getAttribute("aria-checked") === "true" && !!${SEC}.querySelector(".pb-saved[data-show]")`);
    await ev(`click($(".pb-appsettings-back") ?? $(".pb-phone-back"))`);
    await until(`!$(".app-appsettings")`);
    return !!ok;
  }
  async function sendText(text, modifiers = 0) {
    await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
    await type(text);
    await until(`$(".app-main .pb-composer textarea").value === ${JSON.stringify(text)}`);
    await key("Enter", modifiers);
    await until(`$(".app-main .pb-composer textarea").value === ""`);
  }

  // The setting, on the laptop.
  await open("");
  await ev(`click($(".pb-foot-settings"))`);
  const setting = await until(`(() => { const s = ${SEC}; if (!s) return null; return { sections: $$(".pb-appsettings-section").map((x) => x.dataset.section).join(","), title: s.querySelector(".pb-section-title")?.textContent, intro: s.querySelector(".pb-section-text")?.textContent, choices: $$('[data-section="chat"] .pb-choice').map((c) => [c.dataset.follow, c.querySelector(".pb-choice-label").textContent, c.querySelector(".pb-choice-hint").textContent, c.getAttribute("aria-checked")]), other: s.querySelector(".pb-followup-other")?.textContent, group: s.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby") }; })()`);
  check(S("Pobots settings has the section When a bot is working, between Notifications and Backup"), setting?.sections === "notify,chat,backup" && setting.title === "When a bot is working" && setting.intro === "What happens to a message you send while a bot is in the middle of something.", setting);
  check(S("two choices with their words, Steer chosen by default, as a radio group named by the title"), JSON.stringify(setting?.choices) === JSON.stringify([["steer", "Steer", "Your message goes into what it is doing now. It reads it at its next step.", "true"], ["queue", "Queue", "Your message waits until it is done.", "false"]]) && setting.group === "set-followup", setting?.choices);
  check(S("a line says how to do the other for one message, on a computer and on a phone"), /^For one message, do the other: press (⌘|Ctrl)\+Enter on a computer, or hold the send button on a phone\.$/.test(setting?.other ?? ""), setting?.other);
  await houseRules(S("Pobots settings"));
  const rectsBefore = await ev(sectionRects);
  await ev(`click(${choice("queue")})`);
  const savedQueue = await until(`${choice("queue")}.getAttribute("aria-checked") === "true" && ${choice("steer")}.getAttribute("aria-checked") === "false" && !!${SEC}.querySelector(".pb-saved[data-show]")`);
  check(S("choosing Queue saves at once and says Saved"), !!savedQueue);
  check(S("and nothing in the section or below it moves"), (await ev(sectionRects)) === rectsBefore, [rectsBefore, await ev(sectionRects)]);
  await sShot("01-setting-queue");
  // Arrow keys move the choice, as in every radio group.
  await ev(`${choice("queue")}.focus()`);
  await key("ArrowUp");
  check(S("the arrow keys choose too"), !!(await until(`${choice("steer")}.getAttribute("aria-checked") === "true" && document.activeElement === ${choice("steer")}`)));
  await ev(`click(${choice("queue")})`);
  await until(`${choice("queue")}.getAttribute("aria-checked") === "true" && !!${SEC}.querySelector(".pb-saved[data-show]")`);
  await ev(`click($(".pb-appsettings-back"))`);
  await until(`!$(".app-appsettings")`);
  await sleep(300);

  // Queue chosen: a message sent while Kaja works waits; Steer now puts it in, in the same box.
  await ev(`window.pobotsMock.holdTurns(true)`);
  await goTo("Kaja", "chat");
  await sendText("Count the files in the folder.");
  check(S("Kaja is at work"), !!(await until(`$$(".app-main .app-you").at(-1)?.querySelector(".pb-msg-you")?.textContent === "Count the files in the folder." && !$$(".app-main .app-you").at(-1).querySelector(".app-you-note")`, 4000)));
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("Then count the folders.");
  const queueBtn = await until(`(() => { const b = ${sendBtn}; return b && b.getAttribute("aria-label") === "Queue message" && { follow: b.dataset.follow, title: b.title, icon: b.querySelector("path")?.getAttribute("d") ?? "" }; })()`);
  check(S("while it works the send button says Queue message, shows the queue mark, and its hint names the other way"), !!queueBtn && queueBtn.follow === "queue" && /^Queue message · (⌘|Ctrl)\+Enter to steer$/.test(queueBtn.title) && queueBtn.icon.startsWith("M3 4.5h10"), queueBtn);
  await key("Enter");
  const queuedNote = await until(`(() => { const q = ${waitingRow("Then count the folders.")}; return !!q && q.querySelector(".app-you-steer")?.textContent === "Steer now" && !$$(".app-main .pb-thread .pb-msg-you").some((m) => m.textContent === "Then count the folders."); })()`);
  check(S("the message waits in the stack above the message box, with Steer now under it"), !!queuedNote, await ev(youNotes));
  check(S("and the line above the box says it is queued"), (await ev(`$$(".app-main .app-line").some((l) => l.textContent === "Queued, Kaja will read this next")`)) === true);
  await sShot("02-queued-steer-now");
  await ev(`click(${waitingRow("Then count the folders.")}.querySelector(".app-you-steer"))`);
  const steeredNow = await until(`(() => { const y = ${lastYou}; return y?.querySelector(".pb-msg-you")?.textContent === "Then count the folders." && y.querySelector(".app-you-note")?.textContent === "Steered" && y.dataset.steered === "true" && !${waitingRow("Then count the folders.")}; })()`);
  check(S("Steer now puts it into the turn: it leaves the stack and stands in the chat, Steered"), !!steeredNow, await ev(youNotes));
  check(S("and nothing is queued any more"), (await ev(`!$$(".app-main .app-line").some((l) => l.textContent.startsWith("Queued"))`)) === true);
  // Ctrl+Enter does the other for one message: it steers while the setting says queue.
  await sendText("Also say how big they are.", 2);
  check(S("Ctrl+Enter steers this one message although the setting says queue"), !!(await until(`${lastYou}?.querySelector(".pb-msg-you")?.textContent === "Also say how big they are." && ${lastYou}.querySelector(".app-you-note")?.textContent === "Steered"`)), await ev(youNotes));
  await sShot("03-steered");
  await houseRules(S("the chat with steered and queued messages"));
  await ev(`window.pobotsMock.holdTurns(false)`);
  const atRest = `!$('.app-main button[aria-label="Stop Kaja"]') && !!$('.app-main .pb-composer .pb-send')`;
  check(S("the turn ends"), !!(await until(atRest, 15000)));

  // Steer chosen again: sending steers; Ctrl+Enter queues one; no Steer now while nothing works.
  check(S("Steer can be chosen again"), await chooseFollowUp("steer"));
  await ev(`window.pobotsMock.holdTurns(true)`);
  await sendText("Count the files again.");
  await until(`$$(".app-main .app-you").at(-1)?.querySelector(".pb-msg-you")?.textContent === "Count the files again."`);
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("And the folders.");
  const steerBtn = await until(`(() => { const b = ${sendBtn}; return b && b.getAttribute("aria-label") === "Steer message" && { follow: b.dataset.follow, title: b.title, icon: b.querySelector("path")?.getAttribute("d") ?? "" }; })()`);
  check(S("with Steer chosen the send button says Steer message, keeps the send arrow, and its hint names the other way"), !!steerBtn && steerBtn.follow === "steer" && /^Steer message · (⌘|Ctrl)\+Enter to queue$/.test(steerBtn.title) && steerBtn.icon.startsWith("M8 13V3"), steerBtn);
  await key("Enter");
  check(S("Enter steers it: Steered, nothing queued"), !!(await until(`${lastYou}?.querySelector(".pb-msg-you")?.textContent === "And the folders." && ${lastYou}.querySelector(".app-you-note")?.textContent === "Steered" && !$$(".app-main .app-line").some((l) => l.textContent.startsWith("Queued"))`)), await ev(youNotes));
  await sendText("Afterwards, tidy up.", 2);
  check(S("Ctrl+Enter queues this one message"), !!(await until(`!!${waitingRow("Afterwards, tidy up.")}?.querySelector(".app-you-steer")`)), await ev(youNotes));
  await ev(`window.pobotsMock.holdTurns(false)`);
  check(S("when the turn ends the queued one is read: it leaves the stack and stands in the chat"), !!(await until(`!$(".app-main .pb-queue") && $$(".app-main .pb-thread .pb-msg-you").some((m) => m.textContent === "Afterwards, tidy up.")`, 12000)), await ev(youNotes));
  await until(atRest, 15000);
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("x");
  check(S("an idle bot's send button is plain Send"), (await ev(`(${sendBtn}).getAttribute("aria-label") === "Send" && !(${sendBtn}).dataset.follow && !(${sendBtn}).title`)) === true, await ev(`[(${sendBtn}).getAttribute("aria-label"), (${sendBtn}).title]`));
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // On a phone: the setting fits, and holding the send button does the other for one message.
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: IPHONE, platform: "iPhone" });
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark&steer-phone=1` });
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  await sleep(300);
  await ev(`click($(".pb-foot-settings"))`);
  const phoneSetting = await until(`(() => { const s = ${SEC}; if (!s) return null; const r = (e) => e.getBoundingClientRect(); return { choices: $$('[data-section="chat"] .pb-choice').map((c) => Math.round(r(c).height)), right: Math.max(...$$('[data-section="chat"] *').map((e) => r(e).right)), checked: ${choice("steer")}.getAttribute("aria-checked") }; })()`);
  check(S("phone: the section is there, each choice at least 44 px to tap, nothing wider than the screen"), !!phoneSetting && phoneSetting.choices.length === 2 && phoneSetting.choices.every((h) => h >= 44) && phoneSetting.right <= 390 && phoneSetting.checked === "true", phoneSetting);
  await ev(`${SEC}.scrollIntoView({ block: "start" })`);
  await sShot("04-phone-setting");
  await houseRules(S("phone: Pobots settings"));
  await ev(`history.back()`);
  await until(`!$(".app-appsettings")`);
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja"))`);
  await until(`!!$(".app-main .pb-composer textarea")`);
  await ev(`window.pobotsMock.holdTurns(true)`);
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("Count the photos.");
  await ev(`click(${sendBtn})`);
  await until(`${lastYou}?.querySelector(".pb-msg-you")?.textContent === "Count the photos."`);
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("Hold this one.");
  await until(`(${sendBtn})?.getAttribute("aria-label") === "Steer message"`);
  const youBefore = await ev(`$$(".app-main .app-you").length`);
  // A finger held on the send button, longer than dur-hold, then lifted (the click that follows does nothing more).
  await ev(`(() => { const b = ${sendBtn}; b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch", isPrimary: true })); return true; })()`);
  await sleep(700);
  check(S("phone: while the finger is still down after a held send, the button under it is still send, not Stop"), (await ev(`(${sendBtn}).getAttribute("aria-label") !== "Stop Kaja"`)) === true, await ev(`(${sendBtn}).getAttribute("aria-label")`));
  await ev(`(() => { const b = ${sendBtn}; b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch", isPrimary: true })); b.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, pointerType: "touch" })); b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); return true; })()`);
  const held = await until(`(() => { const rows = $$(".app-main .pb-queued").filter((q) => q.querySelector(".pb-queued-text")?.textContent === "Hold this one."); return rows.length === 1 && !!rows[0].querySelector(".app-you-steer"); })()`);
  await sleep(500);
  check(S("phone: and lifting it stops nothing: Kaja is still at work, and Stop comes back"), !!(await until(`!$$(".app-main .app-notice").some((n) => n.textContent.startsWith("Stopped")) && (${sendBtn}).getAttribute("aria-label") === "Stop Kaja"`, 3000)), await ev(`[(${sendBtn}).getAttribute("aria-label"), $$(".app-main .app-notice").map((n) => n.textContent)]`));
  check(S("phone: holding the send button queues this one message, sent once (in the stack, not in the chat)"), !!held && (await ev(`$$(".app-main .app-you").filter((y) => y.querySelector(".pb-msg-you")?.textContent === "Hold this one.").length`)) === 0 && (await ev(`$$(".app-main .app-you").length`)) === youBefore, await ev(youNotes));
  await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
  await type("Tap this one.");
  await ev(`click(${sendBtn})`);
  check(S("phone: a tap steers it, by the setting"), !!(await until(`${lastYou}?.querySelector(".pb-msg-you")?.textContent === "Tap this one." && ${lastYou}.querySelector(".app-you-note")?.textContent === "Steered"`)), await ev(youNotes));
  const steerNowBox = await ev(`(() => { const b = $$(".app-main .app-you-steer")[0]; if (!b) return null; const r = b.getBoundingClientRect(); const a = getComputedStyle(b, "::after"); return { h: r.height, after: a.content, top: a.top, bottom: a.bottom }; })()`);
  check(S("phone: Steer now has a 44 px place to tap"), !!steerNowBox && steerNowBox.after === '""' && steerNowBox.h + 28 >= 44, steerNowBox);
  check(S("phone: the send button keeps no callout or selection when held"), (await ev(`(() => { const s = getComputedStyle(${sendBtn}); return s.userSelect === "none" || s.webkitUserSelect === "none"; })()`)) === true);
  await sShot("05-phone-chat");
  await houseRules(S("phone: the chat"));
  await ev(`window.pobotsMock.holdTurns(false)`);
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&steer-done=1` });
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  if (steerShots) console.log(`Steering pictures in ${steerShots}`);
  }
}
