// The window check, section "todo". Run it alone: node scripts/ui-check.mjs --only=todo
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 7c (job 7, files-todo)
// A to-do list for the person at the foot of the rail, the to-do's window drawn from the bot's
// blocks, his answer in the chat; any file and "No longer kept"; a helper's card names the helper.
// --only=todo runs the to-dos, --only=anyfile the rest. &todos=1|many, &helpercard=1, &notkept=1 in the mock.
export default async function section() {
  step7cTodo: {
  const D = (name) => `to-do: ${name}`;
  const todoShots = arg("todo-shots") ?? (shots ? join(shots, "todo") : undefined);
  if (todoShots) mkdirSync(todoShots, { recursive: true });
  async function tShot(name) {
    if (!todoShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(todoShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const rows = `$$(".app-rail .pb-todo-item").map((r) => [r.dataset.todoId, r.querySelector(".pb-todo-name").textContent, r.querySelector(".pb-todo-when").textContent])`;
  const rowRects = `Object.fromEntries($$(".app-rail .pb-todo-item").map((r) => [r.dataset.todoId, Math.round(r.getBoundingClientRect().top)]))`;
  const cardRects = `$$(".app-rail .pb-card").map((c) => Math.round(c.getBoundingClientRect().top)).join(",")`;
  const dialog = `$(".pb-dialog")`;
  // A click on a line focuses it first, as a real click does (el.click() alone does not).
  const openRow = (id) => `(() => { const r = $('.app-rail .pb-todo-item[data-todo-id="${id}"]'); r.focus(); return click(r); })()`;

  for (const theme of ["dark", "light"]) {
    const T = (n) => D(`${theme}: ${n}`);
    await open("todos=1", { theme });
    const list = await until(`(() => { const s = $(".app-rail .pb-todo"); return s && { title: s.querySelector(".pb-todo-title").firstChild.textContent, count: s.querySelector(".pb-todo-count").textContent, rows: ${rows} }; })()`);
    check(T("Your to-do at the foot of the rail, with the count"), list?.title === "Your to-do" && list.count === "3", list);
    check(T("the one with a by day first, then the newest; ages and by days in their words"),
      JSON.stringify(list?.rows.map((r) => r[0])) === JSON.stringify(["todo_mocknordvik00001", "todo_mockdate0000003", "todo_mockweekly00002"]) && /^by (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(list.rows[0][2]) && list.rows[1][2] === "40 min" && list.rows[2][2] === "5 h", list?.rows);
    const foot = await ev(`(() => { const r = $(".app-rail").getBoundingClientRect(); const s = $(".app-rail .pb-todo").getBoundingClientRect(); const items = $$(".app-rail .pb-todo-item").map((i) => i.getBoundingClientRect()); return { gap: Math.round(r.bottom - s.bottom), inView: items.every((i) => i.top >= r.top && i.bottom <= r.bottom), cardsOverflow: $(".app-rail").scrollHeight > $(".app-rail").clientHeight }; })()`);
    check(T("it stays in sight at the foot of the rail while the cards overflow above it"), foot?.cardsOverflow === true && foot.inView === true && foot.gap >= -1 && foot.gap <= 1, foot);
    if (theme === "dark") {
      // Nothing moves that need not: a new to-do comes in after the ones with a by day; the cards and the lines under it keep their place.
      // After the cards and lines have arrived (their arrival moves them a pixel for a moment).
      await sleep(800);
      const before = { rows: await ev(rowRects), cards: await ev(cardRects) };
      const newId = await ev(`window.pobotsTodos.add({ botId: "kaja", title: "Read the Aalto contract" })`);
      await until(`$$(".app-rail .pb-todo-item").length === 4`);
      await sleep(350);
      const after = { rows: await ev(rowRects), cards: await ev(cardRects), order: (await ev(rows)).map((r) => r[0]) };
      check(T("a new to-do comes after the ones with a by day, newest first"), JSON.stringify(after.order) === JSON.stringify(["todo_mocknordvik00001", newId, "todo_mockdate0000003", "todo_mockweekly00002"]), after.order);
      check(T("the cards and the lines under the new one keep their place"), after.cards === before.cards && after.rows.todo_mockdate0000003 === before.rows.todo_mockdate0000003 && after.rows.todo_mockweekly00002 === before.rows.todo_mockweekly00002, { before, after });
      await ev(`window.pobotsTodos.remove(${JSON.stringify(newId)})`);
      await until(`$$(".app-rail .pb-todo-item").length === 3`);
    }

    // The window, drawn from the bot's blocks.
    await ev(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } })`);
    await ev(openRow("todo_mocknordvik00001"));
    const win = await until(`(() => { const d = ${dialog}; if (!d) return null; return {
      role: d.getAttribute("role"), title: d.querySelector(".pb-dialog-title").textContent, why: d.querySelector(".pb-dialog-text")?.textContent, from: d.querySelector(".pb-todo-from").textContent,
      focus: document.activeElement === d.querySelector(".pb-todo-from"),
      kinds: [...d.querySelector(".pb-todo-blocks").children].map((e) => e.className.split(" ")[0]),
      bold: d.querySelector(".pb-todo-text strong")?.textContent, facts: $$(".pb-todo-fact", d).map((f) => f.textContent),
      link: d.querySelector(".pb-todo-link")?.getAttribute("href"), linkTarget: d.querySelector(".pb-todo-link")?.target,
      copyLabel: d.querySelector(".pb-todo-copy-label")?.textContent, pictureH: Math.round(d.querySelector(".pb-todo-picture")?.getBoundingClientRect().height ?? 0),
      file: d.querySelector(".pb-todo-file")?.getAttribute("download"), page: d.querySelector(".pb-todo-page-title")?.textContent,
      lang: $$('.pb-choice', d).map((c) => [c.textContent, c.getAttribute("aria-checked")]),
      buttons: $$(".pb-todo-actions button", d).map((x) => [x.textContent, x.classList.contains("pb-btn-primary")]),
    }; })()`);
    check(T("a click opens the to-do's window: its title, why, who and when; the window holds the focus"), win?.role === "dialog" && win.title === "Send the Nordvik import summary" && win.why === "The import is done and Nordvik waits for the summary." && /^HubSpot tickets2 d agoby \w{3}$/.test(win.from) && win.focus, win);
    check(T("every kind of block in the bot's order"), JSON.stringify(win?.kinds) === JSON.stringify(["pb-todo-text", "pb-todo-facts", "pb-todo-link", "pb-todo-copy", "pb-todo-picture-block", "pb-chip-file", "pb-todo-page", "pb-field", "pb-field"]), win?.kinds);
    check(T("text as markdown, facts, a link that opens outside, a text to copy, a picture in a box of 200 px, a file that downloads, a page"),
      win?.bold === "finished" && win.facts.length === 3 && win.facts[0] === "CustomerNordvik AB" && win.link === "https://example.com/tickets/48211" && win.linkTarget === "_blank" && win.copyLabel === "Email draft" && win.pictureH === 200 && win.file === "import-report.pdf" && win.page === "Onboarding status", win);
    check(T("the choice starts on the bot's value; Dismiss, Mark done, then the bot's buttons with its primary last"),
      JSON.stringify(win?.lang) === JSON.stringify([["Swedish", "true"], ["English", "false"]]) && JSON.stringify(win.buttons) === JSON.stringify([["Dismiss", false], ["Mark done", false], ["Change the draft", false], ["I sent it", true]]), win);
    if (theme === "dark") {
      const w0 = await ev(`Math.round($(".pb-todo-copy .pb-copy").getBoundingClientRect().width)`);
      await ev(`click($(".pb-todo-copy .pb-copy"))`);
      const copied = await until(`$(".pb-todo-copy .pb-copy").textContent === "Copied" && { text: window.__copied, w: Math.round($(".pb-todo-copy .pb-copy").getBoundingClientRect().width) }`);
      check(T("Copy copies the draft and says Copied in its own width"), copied?.text?.startsWith("Hej Anna,\n\nImporten") && copied.w === w0, { copied, w0 });
      await houseRules(T("the window"));
    }
    await tShot(`${theme}-window`);
    // Fill in and answer.
    await ev(`$(".pb-dialog textarea").focus()`);
    await type("Add the date of the next survey.");
    await ev(`$('.pb-dialog .pb-choice[aria-checked="true"]').focus()`);
    await key("ArrowDown");
    const picked = await ev(`$$(".pb-dialog .pb-choice").map((c) => c.getAttribute("aria-checked")).join(",") + "|" + document.activeElement.textContent`);
    check(T("the choice moves with the arrow keys"), picked === "false,true|English", picked);
    await ev(`click(btn("I sent it", $(".pb-dialog")))`);
    const gone = await until(`!${dialog} && $$(".app-rail .pb-todo-item").length === 2 && !$('.app-rail .pb-todo-item[data-todo-id="todo_mocknordvik00001"]')`);
    const answers = await ev(`window.pobotsTodos.answers()`);
    check(T("a button sends what the fields hold; the window closes and the to-do leaves the list"), !!gone && JSON.stringify(answers) === JSON.stringify([{ todoId: "todo_mocknordvik00001", buttonId: "sent", values: { note: "Add the date of the next survey.", lang: "English" } }]), answers);
    const focusAfter = await until(`document.activeElement?.dataset.todoId`);
    check(T("its line is gone, so the focus goes to the first line left, not lost"), focusAfter === "todo_mockdate0000003", focusAfter);
    await goTo("HubSpot tickets");
    const msg = await until(`(() => { const y = $$(".app-main .app-you").at(-1); return y && { note: y.querySelector(".pb-from-todo")?.textContent, text: y.querySelector(".pb-msg-you")?.textContent }; })()`);
    check(T("his answer is his message in the bot's chat, marked From your to-do"), msg?.note === "From your to-do: Send the Nordvik import summary" && msg.text === 'Pressed "I sent it".\nAnything to add for the customer?:\nAdd the date of the next survey.\nLanguage: English', msg);
    // Kept open: the answer is shown and the to-do stays.
    await ev(openRow("todo_mockweekly00002"));
    const keptBefore = await until(`${dialog}?.querySelector(".pb-todo-answered")?.textContent`);
    check(T("a to-do the bot keeps open says when he answered last"), keptBefore === "You answered 7 d ago: Looked at them", keptBefore);
    await ev(`click(btn("Looked at them", $(".pb-dialog")))`);
    await until(`!${dialog}`);
    await ev(openRow("todo_mockweekly00002"));
    const kept = await until(`${dialog}?.querySelector(".pb-todo-answered")?.textContent === "You answered just now: Looked at them"`);
    check(T("answered, it stays on the list with the new answer"), !!kept && (await ev(`$$(".app-rail .pb-todo-item").length`)) === 2);
    // A refusal is said in a line that keeps its room; Escape closes and the focus goes back to the line.
    await key("Escape");
    await until(`!${dialog}`);
    await ev(openRow("todo_mockdate0000003"));
    await until(`!!${dialog}?.querySelector("input")`);
    const h0 = await ev(`Math.round(${dialog}.getBoundingClientRect().height)`);
    await ev(`$(".pb-dialog input").focus()`);
    await type("fail");
    await ev(`click(btn("Send", $(".pb-dialog")))`);
    const refused = await until(`(() => { const e = $(".pb-dialog .pb-todo-error"); return e && e.textContent && { text: e.textContent, role: e.getAttribute("role"), h: Math.round($(".pb-dialog").getBoundingClientRect().height) }; })()`);
    check(T("a refusal shows in its line and moves nothing"), refused?.text === "The bot of this to-do is gone." && refused.role === "alert" && refused.h === h0, { refused, h0 });
    await key("Escape");
    const back = await until(`!${dialog} && document.activeElement?.dataset.todoId`);
    check(T("Escape closes it and the focus is back on its line"), back === "todo_mockdate0000003", back);
    // Mark done and Dismiss.
    await ev(openRow("todo_mockdate0000003"));
    await until(`!!${dialog}`);
    await ev(`click(btn("Mark done", $(".pb-dialog")))`);
    check(T("Mark done takes it off the list"), !!(await until(`!${dialog} && $$(".app-rail .pb-todo-item").length === 1`)));
    await ev(openRow("todo_mockweekly00002"));
    await until(`!!${dialog}`);
    await ev(`click(btn("Dismiss", $(".pb-dialog")))`);
    check(T("Dismiss takes it off; with none left the section is gone"), !!(await until(`!${dialog} && !$(".app-rail .pb-todo")`)));
  }

  // A page block opens the bot's page beside the chat.
  await open("todos=1");
  await ev(openRow("todo_mocknordvik00001"));
  await until(`!!${dialog}`);
  await ev(`click($(".pb-dialog .pb-todo-page"))`);
  const panel = await until(`(() => { const s = window.pobotsState(); return !$(".pb-dialog") && s.panel?.kind === "artifact" && { bot: s.openBotId, id: s.panel.artifactId }; })()`);
  check(D("a page block opens the bot's page beside the chat, with the bot open"), panel?.bot === "kaja" && panel.id === "onboarding-status", panel);

  // Many: the list scrolls inside itself and never takes more than its share.
  await open("todos=many");
  const many = await until(`(() => { const l = $(".app-rail .pb-todo-list"); return l && { scrolls: l.scrollHeight > l.clientHeight, h: Math.round(l.getBoundingClientRect().height), count: $(".app-rail .pb-todo-count").textContent }; })()`);
  check(D("twelve: the list scrolls inside itself, at most 240 px high"), many?.scrolls === true && many.h <= 240 && many.count === "12", many);
  await tShot("many-1280");

  // 800 px, and the phone (with nothing but to-dos waiting, the Bots screen's row leads there).
  await open("todos=1", { width: 800, height: 700 });
  const narrow = await until(`(() => { const r = $(".app-rail .pb-todo-item"); return r && { w: Math.round(r.getBoundingClientRect().width), name: getComputedStyle(r.querySelector(".pb-todo-name")).textOverflow }; })()`);
  check(D("800 px: the lines fit the narrower rail, long titles end with an ellipsis"), !!narrow && narrow.name === "ellipsis", narrow);
  await houseRules(D("800 px"));
  for (const [w, h, ua] of [[390, 844, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"], [360, 780, "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"]]) {
    const P = (n) => D(`phone ${w}: ${n}`);
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark&scene=empty-rail&todos=1` });
    const row = await until(`$(".app-needs-row")?.textContent`, 6000);
    check(P("with only to-dos waiting, the Bots screen's row says so"), row === "Three to-dos for you", row);
    await ev(`click($(".app-needs-row"))`);
    const screen = await until(`(() => { const r = $(".app-rail"); const s = $(".app-rail .pb-todo"); return r && s && getComputedStyle(r).visibility === "visible" && { rows: $$(".app-rail .pb-todo-item").length, tap: Math.round($(".app-rail .pb-todo-item").getBoundingClientRect().height) }; })()`);
    check(P("the Needs you screen shows Your to-do, lines at least 44 px to tap"), screen?.rows === 3 && screen.tap >= 44, screen);
    await ev(openRow("todo_mocknordvik00001"));
    const sheet = await until(`(() => { const d = $(".pb-dialog"); return d && { w: Math.round(d.getBoundingClientRect().width), fits: d.getBoundingClientRect().bottom <= innerHeight + 1 }; })()`);
    check(P("the window fits the phone"), !!sheet && sheet.w <= w && sheet.fits, sheet);
    await houseRules(P("the window"));
    await tShot(`phone-${w}-window`);
    await key("Escape");
  }
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  if (todoShots) console.log(`To-do pictures in ${todoShots}`);
  }
}
