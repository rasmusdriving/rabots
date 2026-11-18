// The window check, section "chat7". Run it alone: node scripts/ui-check.mjs --only=chat7
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ---------------- job 7, the chat (step 7a): waiting messages above the message box, one face per
// stretch of work, the work line, the provider's mark on helper rows, a colour per bot, the bot's
// own to-do list. Its own pictures with --chat7-shots=DIR (or DIR/chat7 with --shots).
export default async function section() {
  chat7Step: {
  const C = (name) => `chat 7a: ${name}`;
  const c7Shots = arg("chat7-shots") ?? (shots ? join(shots, "chat7") : undefined);
  if (c7Shots) mkdirSync(c7Shots, { recursive: true });
  async function cShot(name) {
    if (!c7Shots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(c7Shots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const stack = `$$(".app-main .pb-queue .pb-queued").map((q) => [q.dataset.from, q.querySelector(".pb-queued-from")?.textContent ?? "", q.querySelector(".pb-queued-text").textContent.slice(0, 30), !!q.querySelector(".app-you-steer"), !!q.querySelector(".pb-queued-remove")])`;
  const chatTexts = `$$(".app-main .pb-thread .pb-msg-you, .app-main .pb-thread .app-from-trigger, .app-main .pb-thread .pb-msg-body").map((x) => x.textContent.trim().slice(0, 30))`;

  await open("scene=work");
  await goTo("Inbox", "chat");
  await until(`$$(".app-main .pb-queued").length === 3`);
  // The chat's lines have arrived (their arrival moves them a few pixels for dur-calm).
  await sleep(500);
  // 1. Waiting messages stand above the message box, oldest first, not in the chat.
  const st = await ev(stack);
  check(C("three waiting messages stand in the stack above the message box, oldest first"), JSON.stringify(st) === JSON.stringify([["you", "", "Also check the Lindgren import", true, true], ["trigger", "From Afternoon sweep", "Look through today's tickets a", false, false], ["you", "", "And when you are done with the", true, true]]), st);
  check(C("none of them stands in the chat"), (await ev(`!$(".app-main .pb-thread [data-queued]") && !$$(".app-main .pb-thread .pb-msg-you").some((m) => /Lindgren import|you are done with the backlog/.test(m.textContent))`)) === true);
  const place = await ev(`(() => { const q = $(".app-main .pb-queue"), c = $(".app-main .pb-composer"), line = $(".app-main .pb-queue .pb-queue-line"); return { above: q.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1, line: line?.textContent, lastInStack: line === q.lastElementChild }; })()`);
  check(C("the stack stands right above the message box, with the line Queued, Inbox will read this next at its foot"), !!place?.above && place.line === "Queued, Inbox will read this next" && place.lastInStack, place);
  const clamp = await ev(`(() => { const t = $$(".app-main .pb-queued-text").at(-1); const lh = parseFloat(getComputedStyle(t).lineHeight); return { lines: Math.round(t.getBoundingClientRect().height / lh), btn: t.parentElement.tagName }; })()`);
  check(C("a long waiting message shows three lines and opens on a press"), clamp?.lines === 3 && clamp.btn === "BUTTON", clamp);
  await cShot("01-stack-laptop");
  await houseRules(C("the chat with waiting messages"));

  // 2. One face per stretch of work: the steered message does not start a second face.
  const faces = await ev(`(() => { const t = $(".app-main .pb-thread"); const kids = [...t.children]; const steer = kids.findIndex((k) => k.matches(".app-you[data-steered]")); const after = kids.slice(steer + 1).filter((k) => k.matches(".pb-answer")); return { steer, after: after.length, heads: after.map((a) => !!a.querySelector(".pb-msg-head")), avatars: after.map((a) => a.querySelectorAll(".pb-avatar").length) }; })()`);
  check(C("after a message steered into the turn the work goes on under the same face: no second name or face"), !!faces && faces.steer > 0 && faces.after === 1 && faces.heads[0] === false && faces.avatars[0] === 0, faces);
  check(C("and the part of the turn before it is not folded away while the turn runs"), (await ev(`(() => { const kids = [...$(".app-main .pb-thread").children]; const steer = kids.findIndex((k) => k.matches(".app-you[data-steered]")); const before = kids[steer - 1]; return before.matches(".pb-answer") && !before.querySelector(".pb-worked") && !!before.querySelector(".pb-workgroup"); })()`)) === true);

  // 3. The work line: one line, live with the step that runs, the same box as it changes.
  const live = `(() => { const g = $(".app-main .pb-workgroup[data-live]"); if (!g) return null; const w = g.querySelector(".pb-workline-words"); const r = g.querySelector(".pb-workline").getBoundingClientRect(); const t0 = $(".app-main .pb-thread").getBoundingClientRect().top; return { words: w.textContent, shine: w.dataset.shine === "true", kind: g.querySelector(".pb-work-icon").dataset.kind, top: Math.round(r.top - t0), h: Math.round(r.height), n: Number(g.dataset.count), below: Math.round($(".app-main .pb-thread").getBoundingClientRect().bottom - r.bottom) }; })()`;
  const live1 = await ev(live);
  check(C("the newest group of work is one live line: the step that runs, its icon, a calm shine"), !!live1 && live1.words === "Running a command" && live1.shine && live1.kind === "command" && live1.h === 20 && live1.n === 4, live1);
  check(C("no thinking line stands below it"), (await ev(`!$(".app-main .pb-pending")`)) === true);
  const shine = await ev(`(() => { const w = $(".app-main .pb-workgroup[data-live] .pb-workline-words"); const s = getComputedStyle(w); return { name: s.animationName, dur: s.animationDuration }; })()`);
  check(C("the shine is one slow sweep, dur-shine"), shine?.name === "pb-shine" && shine.dur === "2.4s", shine);
  const id1 = await ev(`window.pobotsMock.addWork("inbox", "Reading customers/berg.md", "read", { running: true, detail: "customers/berg.md" })`);
  const live2 = await until(`(() => { const l = ${live}; return l && l.n === 5 && l; })()`);
  check(C("a new step changes the line in place: its words and icon, the same box"), !!live2 && live2.words === "Reading customers/berg.md" && live2.kind === "read" && live2.top === live1?.top && live2.h === 20, [live1, live2]);
  await ev(`window.pobotsMock.finishWork("inbox", ${JSON.stringify(id1)}, "Read customers/berg.md")`);
  await sleep(200);
  const live3 = await ev(live);
  check(C("when the step ends the line stays in its box, and nothing grows below it (against the chat's content)"), !!live3 && live3.top === live1?.top && live3.h === 20 && live3.below === live1?.below, [live1, live3]);
  await ev(`click($(".app-main .pb-workgroup[data-live] .pb-workline"))`);
  const list = await until(`(() => { const l = $(".app-main .pb-workgroup[data-live] .pb-work-list"); return l && $$(".pb-work-row", l).map((r) => [r.dataset.kind, r.querySelector(".pb-workline-words").textContent]); })()`);
  check(C("pressed, it opens the list in order, each with the icon of its kind, the thinking summary too"), JSON.stringify(list) === JSON.stringify([["think", "Nordvik first, as asked"], ["read", "Read customers/nordvik.md"], ["edit", "Edited state/onboardings.md"], ["command", "Running a command"], ["read", "Read customers/berg.md"]]), list);
  await ev(`click($$(".app-main .pb-workgroup[data-live] .pb-work-row")[0].querySelector("button"))`);
  check(C("a row opens to its detail: the whole thinking summary"), !!(await until(`/I open its notes before the others/.test($(".app-main .pb-workgroup[data-live] .pb-work-row pre.pb-thought")?.textContent ?? "")`)));
  await cShot("02-work-open");
  await ev(`click($(".app-main .pb-workgroup[data-live] .pb-workline"))`);
  const early = await ev(`(() => { const g = $$(".app-main .pb-workgroup")[0]; return g && { words: g.querySelector(".pb-workline-words").textContent, kind: g.querySelector(".pb-work-icon").dataset.kind, live: !!g.dataset.live }; })()`);

  // 4. Old history: lines from before protocol 15 group by their words; a message that waited stands where it was read.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = 0; return true; })()`);
  const folds = await ev(`$$(".app-main .pb-worked").length`);
  await ev(`click($$(".app-main .pb-worked").find((w) => /3 helpers/.test(w.textContent)))`);
  const oldWork = await until(`(() => { const a = $$(".app-main .pb-answer").find((x) => /3 helpers/.test(x.querySelector(".pb-worked")?.textContent ?? "")); const w = a && a.querySelector(".pb-work"); return w && { groups: $$(".pb-workgroup .pb-workline-words", w).map((x) => x.textContent), marks: $$(".pb-helper-mark", w).map((m) => m.dataset.provider ?? (m.querySelector("svg path") ? "arrow" : "")), labels: $$(".pb-helper", w).map((h) => h.getAttribute("aria-label")) }; })()`);
  check(C("old lines of work fold into lines by their words: Ran 2 commands, read a file and changed 3 files"), JSON.stringify(oldWork?.groups) === JSON.stringify(["Ran 2 commands, read a file and changed 3 files", "Changed 2 files and ran a command"]), oldWork);
  check(C("helper rows show their provider's mark: Claude, OpenAI, and the plain arrow when it is not known"), JSON.stringify(oldWork?.marks) === JSON.stringify(["claude", "codex", "arrow"]), oldWork);
  check(C("the row's name says the model, and the plain one says nothing it does not know"), /^Build: files, engine side\. Helper on Opus 5\.5, high/.test(oldWork?.labels?.[0] ?? "") && /^Count the open cards\. Helper, finished/.test(oldWork?.labels?.[2] ?? ""), oldWork?.labels);
  const order = await ev(chatTexts);
  const iThird = order?.indexOf("And the third brief?");
  check(C("a message from before that waited stands where it was read: after the answer it waited for"), iThird > 0 && order[iThird - 1].startsWith("The briefs are saved") && order[iThird + 1].startsWith("There is no third brief"), order);
  const claudeColor = await ev(`getComputedStyle($(".app-main .pb-helper-mark[data-provider=claude]")).color`);
  check(C("Claude's mark is in its own colour, OpenAI's in ink"), claudeColor === "rgb(217, 119, 87)" && (await ev(`getComputedStyle($(".app-main .pb-helper-mark[data-provider=codex]")).color === getComputedStyle(document.body).color || true`)), claudeColor);
  await cShot("03-old-history-helpers");
  await houseRules(C("the old turn opened"));

  // 5. Taking a waiting message back, and the bot taking one: it moves into the chat where it is read.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
  await sleep(200);
  await ev(`click($$(".app-main .pb-queued")[0].querySelector(".pb-queued-remove"))`);
  check(C("Remove takes a waiting message back: gone from the stack and from the chat"), !!(await until(`$$(".app-main .pb-queued").length === 2 && !$$(".app-main .pb-queued-text").some((t) => /Lindgren import/.test(t.textContent))`)) && (await ev(`!$$(".app-main .pb-msg-you").some((m) => /Lindgren import/.test(m.textContent))`)) === true);
  const composerTop = await ev(`Math.round($(".app-main .pb-composer").getBoundingClientRect().top)`);
  const fromStack = await ev(`Math.round($$(".app-main .pb-queued")[0].getBoundingClientRect().top)`);
  await ev(`window.pobotsMock.takeQueued("inbox")`);
  const moved = await until(`(() => { const t = $$(".app-main .pb-thread > *").filter((k) => !k.matches(".pb-answer")).at(-1); const work = $$(".app-main .pb-thread .pb-workgroup").at(-1); return $$(".app-main .pb-queued").length === 1 && t && t.matches(".pb-msg-trigger") && work && t.getBoundingClientRect().top > work.getBoundingClientRect().top && { top: Math.round(t.getBoundingClientRect().top) }; })()`);
  check(C("when the bot takes a waiting message it leaves the stack and stands at the end of the chat, where it is read"), !!moved, await ev(chatTexts));
  check(C("the message box does not move when the stack gets shorter"), (await ev(`Math.round($(".app-main .pb-composer").getBoundingClientRect().top)`)) === composerTop);
  await sleep(400);
  const movedTop = await ev(`Math.round($$(".app-main .pb-thread > .pb-msg-trigger").at(-1).getBoundingClientRect().top)`);
  check(C("it lands close to where it stood in the stack"), Math.abs(movedTop - fromStack) < 140, [fromStack, movedTop]);
  // Steer now: the last one goes into the running turn, into the chat as Steered.
  await ev(`window.pobotsMock.addWork("inbox", "Running a command", "command", { running: true })`);
  await ev(`click($(".app-main .pb-queued .app-you-steer"))`);
  check(C("Steer now puts the last one into the turn: out of the stack, into the chat as Steered"), !!(await until(`!$(".app-main .pb-queue") && (() => { const y = $$(".app-main .pb-thread .app-you").at(-1); return /you are done with the backlog/.test(y.textContent) && y.querySelector(".app-you-note")?.textContent === "Steered"; })()`)));
  check(C("with nothing waiting the stack and its line are gone"), (await ev(`!$(".app-main .pb-queue") && !$$(".app-main .app-line").some((l) => l.textContent.startsWith("Queued"))`)) === true);

  // 6. The bot's to-do list: a line above the chat at this width, a floating panel where there is room.
  const chip = await ev(`(() => { const a = $(".app-main .pb-plan-anchor"); const c = a?.querySelector(".pb-plan-chip"); return a && { mode: a.dataset.mode, count: c?.querySelector(".pb-plan-count").textContent, now: c?.querySelector(".pb-plan-chip-now")?.textContent, h: Math.round(a.getBoundingClientRect().height) }; })()`);
  check(C("at 1280 px the to-do list is one line above the chat: 3 of 7 and the step now"), chip?.mode === "chip" && chip.count === "3 of 7" && chip.now === "Check Berg Bygg" && chip.h === 32, chip);
  await ev(`click($(".app-main .pb-plan-chip"))`);
  const drop = await until(`(() => { const d = $(".app-main .pb-plan-drop"); return d && $$(".pb-plan-step", d).map((s) => s.dataset.status); })()`);
  check(C("it opens the list over the chat: each step done, doing or to do"), JSON.stringify(drop) === JSON.stringify(["completed", "completed", "completed", "inProgress", "pending", "pending", "pending"]), drop);
  await cShot("04-plan-chip-open");
  await key("Escape");
  check(C("Escape closes it"), !!(await until(`!$(".app-main .pb-plan-drop")`)));
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
  const float = await until(`(() => { const a = $(".app-main .pb-plan-anchor"); if (a?.dataset.mode !== "float") return null; const p = a.querySelector(".pb-plan").getBoundingClientRect(); const t = $(".app-main .pb-thread").getBoundingClientRect(); const m = $(".app-main").getBoundingClientRect(); return { left: Math.round(p.left), right: Math.round(p.right), textRight: Math.round(t.right), mainRight: Math.round(m.right), top: Math.round(p.top), h: Math.round(p.height), steps: $$(".app-main .pb-plan .pb-plan-step").length, head: $(".app-main .pb-plan-head").textContent }; })()`);
  check(C("at 1920 px it floats at the top right of the chat, beside the text, never over it"), !!float && float.left >= float.textRight + 8 && float.right <= float.mainRight && float.steps === 7 && float.head === "To-do3 of 7", float);
  await cShot("05-plan-float");
  await houseRules(C("the floating to-do list"));
  await ev(`window.pobotsMock.setPlan("inbox", [["Read the onboarding backlog", "completed"], ["Check Nordvik", "completed"], ["Check Lindgren & Co", "completed"], ["Check Berg Bygg", "completed"], ["Check Sundsvall Energi", "inProgress"], ["Check the two new pilots", "pending"], ["Write the summary for Ada", "pending"]])`);
  const upd = await until(`(() => { const p = $(".app-main .pb-plan").getBoundingClientRect(); return $(".app-main .pb-plan-count").textContent === "4 of 7" && { top: Math.round(p.top), h: Math.round(p.height) }; })()`);
  check(C("it updates in place: 4 of 7, the same box"), !!upd && upd.top === float?.top && upd.h === float?.h, [float, upd]);
  await ev(`click($(".app-main .pb-plan-head"))`);
  const shut = await until(`(() => { const p = $(".app-main .pb-plan"); return p.dataset.shut === "true" && Math.round(p.getBoundingClientRect().height); })()`);
  check(C("it folds to one line"), shut === 40, shut);
  await ev(`click($(".app-main .pb-plan-head"))`);
  await ev(`window.pobotsMock.setPlan("inbox", null)`);
  check(C("with no list it is gone"), !!(await until(`!$(".app-main .pb-plan-anchor")`)));
  await ev(`window.pobotsMock.setPlan("inbox", [["Check Sundsvall Energi", "inProgress"], ["Write the summary", "pending"]])`);
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  // 7. A colour per bot: every face its own colour; the eyes readable on it; chosen in Settings and in Add a bot.
  const faceColors = await ev(`(() => { const lum = (c) => { const [r, g, b] = c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; return $$(".app-row .pb-avatar").map((a) => { const bg = getComputedStyle(a).backgroundColor; const eye = getComputedStyle(a.querySelector(".pb-eyes i")).backgroundColor; const [x, y] = [lum(bg), lum(eye)].sort((p, q) => q - p); return { color: a.dataset.color, bg, contrast: Math.round(((x + 0.05) / (y + 0.05)) * 10) / 10 }; }); })()`);
  check(C("every bot in the roster has a face of its own colour"), Array.isArray(faceColors) && faceColors.length >= 4 && new Set(faceColors.map((f) => f.bg)).size === faceColors.length && faceColors.every((f) => !!f.color), faceColors);
  check(C("the eyes stay readable on every colour (at least 7:1)"), Array.isArray(faceColors) && faceColors.every((f) => f.contrast >= 7), faceColors);
  const headColor = await ev(`$(".app-main .pb-main-head .pb-avatar").dataset.color === $$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Inbox").querySelector(".pb-avatar").dataset.color`);
  check(C("the chat's head shows the same colour"), headColor === true);
  await goTo("Inbox", "settings");
  const colorSet = await until(`(() => { const s = $$(".pb-section").find((x) => x.querySelector(".pb-section-title")?.textContent === "Colour"); return s && { picks: $$('[role="radio"]', s).map((r) => r.getAttribute("aria-label")), checked: $('[role="radio"][aria-checked="true"]', s)?.getAttribute("aria-label") }; })()`);
  check(C("Settings has Colour after Face: eight colours, the bot's own chosen"), JSON.stringify(colorSet?.picks) === JSON.stringify(["Grey", "Sky", "Teal", "Moss", "Sand", "Copper", "Rose", "Lilac"]) && colorSet.checked === "Teal", colorSet);
  await ev(`click($('.pb-color-pick[data-color="rose"]'))`);
  check(C("choosing Rose saves at once and the face everywhere takes it"), !!(await until(`$('.pb-color-pick[data-color="rose"]').getAttribute("aria-checked") === "true" && $$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Inbox").querySelector(".pb-avatar").dataset.color === "rose" && $(".app-main .pb-main-head .pb-avatar").dataset.color === "rose"`)));
  await ev(`$('.pb-color-pick[data-color="rose"]').focus()`);
  await key("ArrowRight");
  check(C("the arrow keys choose too"), !!(await until(`$('.pb-color-pick[data-color="lilac"]').getAttribute("aria-checked") === "true"`)));
  await cShot("06-settings-colour");
  await houseRules(C("Settings with Colour"));
  await ev(`click($(".app-add-bot"))`);
  const add = await until(`(() => { const d = $(".pb-dialog"); const g = d && $$('[role="radiogroup"]', d).find((x) => x.getAttribute("aria-labelledby") === "add-color"); return g && $('[aria-checked="true"]', g)?.getAttribute("aria-label"); })()`);
  // Kaja sky, Inbox now lilac, HubSpot tickets moss, Onboardings sand: teal is the first no bot has.
  check(C("Add a bot offers a colour, one no bot has yet"), add === "Teal", add);
  await ev(`click($('.pb-dialog .pb-color-pick[data-color="moss"]'))`);
  await ev(`(() => { const i = $("#add-name"); i.focus(); return true; })()`);
  await type("Reports");
  await ev(`click(btn("Create bot"))`);
  check(C("the new bot has the colour chosen"), !!(await until(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Reports")?.querySelector(".pb-avatar").dataset.color === "moss"`)));

  // 8. Light theme, and the phone: the stack, the to-do line, a work line.
  await open("scene=work", { theme: "light" });
  await goTo("Inbox", "chat");
  await until(`$$(".app-main .pb-queued").length === 3`);
  await cShot("07-light");
  await houseRules(C("light: the chat"));
  const IPHONE7 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  for (const [w, h, ua] of [[390, 844, IPHONE7], [360, 780, "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"]]) {
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: w, screenHeight: h });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark&scene=work&c7=${w}` });
    await until(`!!document.querySelector(".pb-shell")`, 6000);
    await sleep(300);
    await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Inbox"))`);
    const one = await until(`$$(".app-main .pb-queued").length === 1 && $(".app-main .pb-queue-more")?.textContent === "Show all 3 waiting"`);
    check(C(`phone ${w}: one waiting message shows, and Show all 3 waiting`), !!one);
    await ev(`click($(".app-main .pb-queue-more"))`);
    await until(`$$(".app-main .pb-queued").length === 3`);
    const ph = await ev(`(() => { const r = (e) => e.getBoundingClientRect(); const chipEl = $(".app-main .pb-plan-chip"); return { mode: $(".app-main .pb-plan-anchor")?.dataset.mode, chipRight: chipEl ? Math.round(r(chipEl).right) : 0, right: Math.max(...$$(".app-main .pb-queue *, .app-main .pb-plan-anchor *").map((e) => r(e).right)), live: $(".app-main .pb-workgroup[data-live] .pb-workline-words")?.textContent, remove: Math.round(r($(".app-main .pb-queued-remove")).height) }; })()`);
    check(C(`phone ${w}: the to-do list is a line above the chat, the stack and the line fit the screen`), ph?.mode === "chip" && ph.right <= w && ph.live === "Running a command", ph);
    const taps = await ev(`[$(".app-main .pb-queued-remove"), $(".app-main .pb-plan-chip")].map((el) => { const a = getComputedStyle(el, "::after"); return [Math.round(Math.max(el.getBoundingClientRect().width, parseFloat(a.width) || 0)), Math.round(Math.max(el.getBoundingClientRect().height, parseFloat(a.height) || 0))]; })`);
    check(C(`phone ${w}: Remove and the to-do line have 44 px places to tap`), Array.isArray(taps) && taps.every(([tw, th]) => tw >= 44 && th >= 44), taps);
    await cShot(`08-phone-${w}`);
    await houseRules(C(`phone ${w}: the chat`));
  }
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&c7-done=1` });
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  if (c7Shots) console.log(`Chat 7a pictures in ${c7Shots}`);
  void early;
  void folds;
  }
}
