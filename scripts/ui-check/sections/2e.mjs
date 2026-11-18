// The window check, section "2e". Run it alone: node scripts/ui-check.mjs --only=2e
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, fixClock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 2e: helpers
export default async function section() {
  part2e: {
  // The mock's "helpers" scene: Kaja's chat holds two helpers started together (a long title, one
  // that failed), a helper inside the first, and one the person stopped. A message that says
  // "helper" starts one in the background; levers hold it before its end and hold the bot's waking.
  const HS = "scene=helpers";
  const rowsOf = `$$(".app-main .pb-thread .pb-helper")`;
  /** Opens every closed "Worked for" line in the open chat: a finished turn folds its work, helper rows included (step 2e addition). */
  const openWork = async () => {
    await until(`!!$(".app-main .pb-worked")`);
    return ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
  };
  const rowBy = (title) => `${rowsOf}.find((r) => r.querySelector(".pb-helper-title").textContent.startsWith(${JSON.stringify(title)}))`;
  const rowFacts = (sel) => `(() => { const r = ${sel}; if (!r) return null; const b = r.getBoundingClientRect(); return { status: r.dataset.status, title: r.querySelector(".pb-helper-title").textContent, last: r.querySelector(".pb-helper-last").textContent, state: r.querySelector(".pb-helper-state").innerText.replace(/\\s+/g, " ").trim(), height: Math.round(b.height * 10) / 10, top: Math.round(b.top * 10) / 10 }; })()`;
  const bar = `({ back: $(".pb-helper-back")?.getAttribute("aria-label"), backText: $(".pb-helper-back-name")?.textContent, title: $(".pb-helper-bar-title")?.textContent, state: $(".pb-helper-bar-state")?.innerText.trim(), focus: document.activeElement === $(".pb-helper-back") })`;
  const scrollerNow = `({ top: $(".app-main .pb-main-scroll").scrollTop, height: $(".app-main .pb-main-scroll").scrollHeight })`;
  const visible = (sel) => `(() => { const el = ${sel}; return !!el && el.checkVisibility({ visibilityProperty: true }); })()`;
  const LEAKS = /subagent|agent|task|worker/i;
  /** Brings the open thread to its top, the way a person scrolls, so it stays there. */
  const toTop = `(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return true; })()`;
  const appWords = `[...$$(".pb-helper-bar-state, .pb-helper-note, .pb-helper-foot .pb-btn, .pb-msg-task .pb-msg-from, .pb-helper-word, .pb-pending-line, .pb-task-more").map((e) => e.innerText), ...$$(".pb-helper").map((r) => r.getAttribute("aria-label").replace(r.querySelector(".pb-helper-title").textContent, "").replace(r.querySelector(".pb-helper-last").textContent, "")), ...$$(".pb-helper-back").map((b) => b.getAttribute("aria-label").replace(b.textContent, ""))].join(" | ")`;
  /** Watches the open thread: every item's top, every helper row's height, the scroller. */
  const startWatch = () =>
    ev(`(() => {
      const scroller = $(".app-main .pb-main-scroll");
      const measure = () => ({
        tops: $$(".app-main .pb-thread > *").filter((k) => !k.classList.contains("pb-pending")).map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10),
        rows: $$(".app-main .pb-helper").map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10),
        statuses: $$(".app-main .pb-helper").map((r) => r.dataset.status).join(","),
        scroll: scroller.scrollTop,
        height: scroller.scrollHeight,
        lasts: $$(".app-main .pb-helper-last").map((l) => l.textContent).join("|"),
      });
      window.__hw = [measure()];
      window.__hwObs?.disconnect();
      window.__hwObs = new MutationObserver(() => window.__hw.push(measure()));
      window.__hwObs.observe(scroller, { subtree: true, childList: true, attributes: true, characterData: true });
      return true;
    })()`);
  const stopWatch = () => ev(`(() => { window.__hwObs.disconnect(); return window.__hw; })()`);
  /** Nothing moved: the same tops for the items that were there, the same row heights and scroll. */
  const still = (samples) => {
    const first = samples[0];
    const bad = samples.filter((s) => s.scroll !== first.scroll || s.height !== first.height || s.rows.some((h) => h !== first.rows[0]) || first.tops.some((t, i) => Math.abs((s.tops[i] ?? t) - t) > 0.5));
    return { ok: samples.length > 1 && bad.length === 0, samples: samples.length, bad: bad.slice(0, 2), first };
  };
  const helperShots = arg("helper-shots") ?? (shots ? join(shots, "helpers") : undefined);
  if (helperShots) mkdirSync(helperShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it, or of the whole window. */
  async function hShot(name, selector) {
    if (!helperShots) return;
    await sleep(500);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(helperShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }

  // ---------------- the rows in the chat
  await open(HS);
  await goTo("Kaja", "chat");
  check("the finished turns with helpers are folded: no rows until their work is opened", !!(await until(`$$(".app-main .pb-worked").length >= 2`)) && (await ev(`${rowsOf}.length`)) === 0);
  await openWork();
  check("Kaja's chat shows three helper rows", !!(await until(`${rowsOf}.length === 3`)), await ev(`${rowsOf}.length`));
  const groups = await ev(`$$(".app-main .pb-thread .pb-helper-group").map((g) => g.querySelectorAll(".pb-helper").length)`);
  check("the two started together sit in one group, the later one alone", JSON.stringify(groups) === "[2,1]", groups);
  const gap = await ev(`(() => { const [a, b] = $$(".app-main .pb-helper-group")[0].querySelectorAll(".pb-helper"); return Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom); })()`);
  check("rows in a group sit close, closer than messages", gap > 0 && gap <= 8, gap);
  const longRow = await ev(rowFacts(rowBy("Inventory the work-bot")));
  check("a finished row: title, its last line, Finished and the time it ended", longRow?.status === "done" && longRow.last.startsWith("Nine agents in all.") && /^Finished · \d\d:\d\d$/.test(longRow.state), longRow);
  const failedRow = await ev(rowFacts(rowBy("Read the dispatcher's logs")));
  check("a failed row: Failed and the time", failedRow?.status === "failed" && /^Failed · \d\d:\d\d$/.test(failedRow.state), failedRow);
  check("Failed is in the error tone", (await ev(`(() => { const p = document.createElement("span"); p.style.color = "var(--clay)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return getComputedStyle(${rowBy("Read the dispatcher's logs")}.querySelector(".pb-helper-word")).color === c; })()`)) === true);
  const stoppedRow = await ev(rowFacts(rowBy("Search the onboarding chat")));
  check("a stopped row: Stopped and the time", stoppedRow?.status === "stopped" && /^Stopped · \d\d:\d\d$/.test(stoppedRow.state), stoppedRow);
  const heights = await ev(`${rowsOf}.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10)`);
  check("every row has the same fixed height", Array.isArray(heights) && heights.every((h) => h === heights[0]) && heights[0] >= 44 && heights[0] <= 60, heights);
  const cut = await ev(`(() => { const t = ${rowBy("Inventory the work-bot")}.querySelector(".pb-helper-title"), l = ${rowBy("Inventory the work-bot")}.querySelector(".pb-helper-last"); return { title: t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === "ellipsis", oneLine: Math.round(l.getBoundingClientRect().height) <= 20 && getComputedStyle(l).whiteSpace === "nowrap" && getComputedStyle(l).textOverflow === "ellipsis" }; })()`);
  check("the long title is cut with an ellipsis, and the line is one line", cut?.title && cut.oneLine, cut);
  const look2 = await ev(`(() => {
    const r = ${rowsOf}[0], mark = r.querySelector(".pb-helper-mark"), s = getComputedStyle(r);
    const title = getComputedStyle(r.querySelector(".pb-helper-title")), name = getComputedStyle($(".app-main article.pb-msg:not(.pb-msg-trigger):not(.pb-msg-channel) .pb-msg-head b"));
    const act = $(".app-main .pb-activity").getBoundingClientRect(), thread = $(".app-main .pb-thread").getBoundingClientRect();
    return {
      face: !!r.querySelector(".pb-avatar"), drawn: !!mark.querySelector("svg"), disc: getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)" && parseFloat(getComputedStyle(mark).borderTopLeftRadius) >= 14,
      surface: s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.boxShadow === "none",
      nameInk: title.color === name.color && title.fontWeight === name.fontWeight,
      quieter: parseFloat(title.fontSize) < parseFloat(getComputedStyle($(".app-main .pb-msg-body")).fontSize),
      indented: Math.round(r.getBoundingClientRect().left - thread.left) === Math.round(act.left - thread.left + parseFloat(getComputedStyle($(".app-main .pb-activity")).paddingLeft)),
      arrow: !!r.querySelector(".pb-helper-go svg"),
    };
  })()`);
  check("the mark is drawn on a soft disc, not a face", look2 && !look2.face && look2.drawn && look2.disc, look2);
  check("the row is a soft surface without a shadow, its title in the ink and weight of a name, smaller than a message", look2?.surface && look2.nameInk && look2.quieter, look2);
  check("the row is indented under the bot like its lines of work, with an arrow at the right", look2?.indented && look2.arrow, look2);
  check("the rows are pieces of the bot's answer, not messages of their own", (await ev(`${rowsOf}.every((r) => !!r.closest(".pb-answer-flow") && !r.closest(".pb-msg-body") && !r.matches("article"))`)) === true);
  check("the app's own words never say subagent, agent, task or worker", !LEAKS.test((await ev(appWords)) ?? "x"), await ev(appWords));
  await houseRules("chat with helper rows");
  await ev(`inPanel($$(".app-main .pb-helper-group")[0])`);
  await hShot("rows-together-dark-1280", `$$(".app-main .pb-helper-group")[0]`);
  await hShot("row-finished-dark-1280", rowBy("Inventory the work-bot"));
  await hShot("row-failed-dark-1280", rowBy("Read the dispatcher's logs"));
  await ev(`inPanel(${rowBy("Search the onboarding chat")})`);
  await hShot("row-stopped-dark-1280", rowBy("Search the onboarding chat"));

  // ---------------- an old "Had a helper" line, and a helper inside a folded turn
  await goTo("Onboardings", "chat");
  await openWork();
  check("an old Had a helper line stays an ordinary line of work", !!(await until(`$$(".app-main .pb-activity :is(.app-activity-label, .pb-workline-words)").some((l) => l.textContent === "Had a helper check the open onboardings") && !$(".app-main .pb-helper")`)));
  await goTo("Inbox", "chat");
  await until(`!!$(".app-main .pb-fold")`);
  check("in a turn another bot started, the helper row is folded away with the turn", (await ev(`!$(".app-main .pb-helper")`)) === true);
  await ev(`click($$(".app-main .pb-fold")[0])`);
  check("opened, the fold holds the helper row like its other lines", !!(await until(`!!$(".app-main .pb-fold-body .pb-helper") && $(".app-main .pb-fold-body .pb-helper .pb-helper-title").textContent === "Read the onboarding chat since 09:00"`)));
  await ev(`click($(".app-main .pb-fold-body .pb-helper"))`);
  check("and opens Inbox's helper's thread", !!(await until(`$(".pb-helper-bar-title")?.textContent === "Read the onboarding chat since 09:00" && $(".pb-helper-back")?.getAttribute("aria-label") === "Back to Inbox"`)));
  await ev(`click($(".pb-helper-back"))`);
  check("back, the fold is still open where it was", !!(await until(`!$(".pb-helper-bar") && !!$(".app-main .pb-fold-body .pb-helper")`)));

  // ---------------- the keyboard: the row is one of the chat's line buttons, and opens the thread
  await goTo("Kaja", "chat");
  await until(`${rowsOf}.length === 3`);
  const lineStops = `$$(".app-main :is(.app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked)")`;
  check("the newest helper row, the newest of the chat's lines, is their one Tab stop", (await ev(`${lineStops}.filter((b) => b.tabIndex === 0).map((b) => b.dataset.helperId).join() === ${rowBy("Search the onboarding chat")}.dataset.helperId`)) === true);
  await ev(`${lineStops}.find((b) => b.tabIndex === 0).focus()`);
  check("focused, it shows the focus ring", (await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.classList.contains("pb-helper") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`)) === true);
  await key("ArrowUp");
  check("Up arrow goes to the line above it, the Worked for line of its turn", (await ev(`document.activeElement?.classList.contains("pb-worked") && document.activeElement.getAttribute("aria-expanded") === "true"`)) === true);
  await key("ArrowUp");
  check("Up arrow again goes to the row above, which becomes the one Tab stop", (await ev(`document.activeElement?.dataset.helperId === ${rowBy("Read the dispatcher's logs")}.dataset.helperId && ${lineStops}.filter((b) => b.tabIndex === 0).length === 1`)) === true);
  // Read a little higher up, so going back must find the same place.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"), r = ${rowBy("Inventory the work-bot")}; s.scrollTop = Math.min(s.scrollTop + r.getBoundingClientRect().top - s.getBoundingClientRect().top - 120, s.scrollHeight - s.clientHeight - 120); s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(150);
  const place = await ev(`({ scroll: $(".app-main .pb-main-scroll").scrollTop, row: Math.round(${rowBy("Inventory the work-bot")}.getBoundingClientRect().top) })`);
  check("the chat is read scrolled up, with the row in view", place?.scroll > 0 && (await ev(`(() => { const s = $(".app-main .pb-main-scroll"), r = ${rowBy("Inventory the work-bot")}.getBoundingClientRect(), v = s.getBoundingClientRect(); return s.scrollHeight - s.clientHeight - s.scrollTop > 40 && r.top >= v.top && r.bottom <= v.bottom; })()`)) === true, place);
  await ev(`${rowBy("Inventory the work-bot")}.focus()`);
  await key("Enter");
  check("Enter on the row opens the helper's thread in the place of the chat", !!(await until(`!!$(".pb-helper-bar") && !$(".pb-composer") && $(".app-main .pb-thread")?.getAttribute("aria-label")?.startsWith("Helper's thread: Inventory the work-bot") && !!$(".app-main .pb-msg-task")`)));
  const barA = await ev(bar);
  check("above it one line: back to Kaja, the helper's title and Finished", barA?.back === "Back to Kaja" && barA.backText === "Kaja" && barA.title.startsWith("Inventory the work-bot agents") && barA.state === "Finished", barA);
  check("the focus is on the way back", barA?.focus === true);
  check("the bot's header, tabs and status stay above it", (await ev(`$(".app-head h1")?.textContent === "Kaja" && $('.pb-tab[aria-selected="true"]')?.dataset.tab === "chat"`)) === true);
  const thread = await ev(`(() => {
    const kids = $$(".app-main .pb-thread > *");
    const task = $(".app-main .pb-msg-task");
    return {
      firstIsTask: kids[0] === task || kids[0]?.contains(task),
      taskHead: task?.querySelector(".pb-msg-head").innerText.replace(/\\s+/g, " "),
      taskFace: !!task?.querySelector(".pb-avatar"),
      helperMsgs: $$(".app-main article[data-helper]").map((a) => ({ name: a.querySelector(".pb-msg-head b").textContent, face: !!a.querySelector(".pb-avatar"), mark: !!a.querySelector(".pb-who-mark svg") })),
      // Since step 7a steps that follow each other are one work line, opened below (WORK_STEPS).
      steps: [],
      nested: $$(".app-main .pb-helper .pb-helper-title").map((t) => t.textContent),
      lastIsResult: kids.at(-1)?.matches("article[data-helper]") && kids.at(-1).innerText.includes("Nine agents in all"),
      chatLeak: $(".app-main .pb-thread").innerText.includes("Read through the old work bot"),
    };
  })()`);
  check("the thread starts with the task, from Kaja's face, saying Kaja asked the helper", thread?.firstIsTask && /^Kaja asked the helper \d\d:\d\d$/.test(thread.taskHead) && thread.taskFace, thread);
  check("the helper's answer carries the helper's mark and the word Helper once, not Kaja's face", thread?.helperMsgs.length === 1 && thread.helperMsgs.every((m) => m.name === "Helper" && !m.face && m.mark), thread?.helperMsgs);
  // The work lines opened: a group's rows, or a single step's own words.
  await ev(`(() => { $$(".app-main .pb-workgroup").forEach((g) => { if (Number(g.dataset.count) > 1 && !g.querySelector(".pb-work-list")) g.querySelector("button.pb-workline").click(); }); return true; })()`);
  if (thread) thread.steps = (await until(`(() => { const gs = $$(".app-main .pb-workgroup"); if (gs.some((g) => Number(g.dataset.count) > 1 && !g.querySelector(".pb-work-list"))) return null; return gs.flatMap((g) => Number(g.dataset.count) > 1 ? $$(".pb-work-row .pb-workline-words", g).map((l) => l.textContent) : [g.querySelector(".pb-workline-words").textContent]); })()`)) ?? [];
  check("then its lines of work, its own helper as a row, and its result last", thread?.steps.join("|") === "Listed agents/|Read agents/inbox/AGENTS.md|Read agents/tickets/AGENTS.md|Read config/webhooks.json" && thread.nested.join("|") === "Check which schedules still run" && thread.lastIsResult, thread);
  check("nothing of the bot's own chat is drawn in it", thread?.chatLeak === false);
  const foot = await ev(`({ note: $(".pb-helper-note")?.textContent, stop: ${visible(`btn("Stop helper")`)}, composer: !!$(".pb-composer") })`);
  check("where the message box was: This helper works for Kaja. Write to Kaja to change what it does.", foot?.note === "This helper works for Kaja. Write to Kaja to change what it does." && !foot.composer, foot);
  check("a finished helper has no Stop helper", foot?.stop === false, foot);
  const clamp = await ev(`(() => { const b = $(".app-main .pb-task-body"); return { h: b.getBoundingClientRect().height, line: parseFloat(getComputedStyle(b).lineHeight), more: btn("Show all")?.getAttribute("aria-expanded") }; })()`);
  check("the long task shows four lines and Show all", clamp && Math.round(clamp.h) === Math.round(clamp.line * 4) && clamp.more === "false", clamp);
  await ev(toTop);
  await sleep(600);
  check("scrolled up to the task, the helper's thread stays there", (await ev(`$(".app-main .pb-main-scroll").scrollTop === 0 && $(".app-main .pb-msg-task").getBoundingClientRect().top >= $(".app-main .pb-main-scroll").getBoundingClientRect().top`)) === true, await ev(scrollerNow));
  await hShot("thread-open-dark-1280");
  await ev(`click(btn("Show all"))`);
  check("Show all opens the whole task, and Show less closes it", !!(await until(`$(".app-main .pb-task-body").innerText.includes("leave out anything about how the old one was set up") && $(".app-main .pb-task-body").getBoundingClientRect().height > ${clamp?.h ?? 0} + 20 && btn("Show less")?.getAttribute("aria-expanded") === "true"`)));
  await ev(`click(btn("Show less"))`);
  await until(`!!btn("Show all")`);
  await houseRules("a helper's thread");
  check("the app's own words in a helper's thread never say subagent, agent, task or worker", !LEAKS.test((await ev(appWords)) ?? "x"), await ev(appWords));
  await ev(`$(".pb-helper-back").focus()`);
  await focusRings("a helper's thread from the way back on", 8);

  // ---------------- a helper inside a helper, one level further and back up
  await ev(`click($(".app-main .pb-thread .pb-helper"))`);
  const top2 = await until(`$(".pb-helper-bar-title")?.textContent === "Check which schedules still run" && !!$(".app-main .pb-msg-task") && ${bar}`);
  check("a helper's own helper opens one level further, back named after the helper above", top2?.back?.startsWith("Back to Inventory the work-bot") && top2.state === "Finished", top2);
  check("its task reads Helper asked this helper, with the helper's mark", /^Helper asked this helper \d\d:\d\d$/.test((await ev(`$(".app-main .pb-msg-task .pb-msg-head").innerText.replace(/\\s+/g, " ")`)) ?? "") && (await ev(`!$(".app-main .pb-msg-task .pb-avatar") && !!$(".app-main .pb-msg-task .pb-who-mark")`)) === true);
  await hShot("thread-nested-dark-1280");
  await key("Enter");
  check("back (Enter on it) goes one level up, to the first helper's thread", !!(await until(`$(".pb-helper-bar-title")?.textContent.startsWith("Inventory the work-bot") && $(".pb-helper-back")?.getAttribute("aria-label") === "Back to Kaja"`)));
  check("and the row it came from has the focus again", !!(await until(`document.activeElement?.classList.contains("pb-helper") && document.activeElement.querySelector(".pb-helper-title").textContent === "Check which schedules still run"`)));
  await ev(`history.back()`);
  check("the browser's back goes to Kaja's chat", !!(await until(`!$(".pb-helper-bar") && !!$(".pb-composer")`)));
  const back1 = await ev(`({ scroll: $(".app-main .pb-main-scroll").scrollTop, row: Math.round(${rowBy("Inventory the work-bot")}.getBoundingClientRect().top) })`);
  check("at the place the person was: same scroll, the row in the same spot", back1?.scroll === place?.scroll && back1.row === place.row, [place, back1]);
  check("and the row has the focus again", !!(await until(`document.activeElement?.dataset.helperId === ${rowBy("Inventory the work-bot")}.dataset.helperId`)));
  await ev(`history.forward()`);
  check("the browser's forward opens the helper's thread again", !!(await until(`$(".pb-helper-bar-title")?.textContent.startsWith("Inventory the work-bot")`)));
  await ev(`click($(".pb-helper-back"))`);
  check("the back control goes to the chat, at the same place", !!(await until(`!$(".pb-helper-bar")`)) && JSON.stringify(await ev(`({ scroll: $(".app-main .pb-main-scroll").scrollTop, row: Math.round(${rowBy("Inventory the work-bot")}.getBoundingClientRect().top) })`)) === JSON.stringify(place));
  // Opening and going back must not jump: the rows and messages keep their places on screen.
  await startWatch();
  await ev(`click(${rowBy("Read the dispatcher's logs")})`);
  await until(`!!$(".pb-helper-bar")`);
  await ev(`click($(".pb-helper-back"))`);
  await until(`!$(".pb-helper-bar")`);
  await sleep(300);
  const there = await ev(`$$(".app-main .pb-thread > *").filter((k) => !k.classList.contains("pb-pending")).map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10)`);
  const before0 = await ev(`window.__hw[0].tops`);
  await ev(`window.__hwObs.disconnect()`);
  check("opening a helper's thread and going back leaves every line where it was", JSON.stringify(there) === JSON.stringify(before0), [before0?.slice(-4), there?.slice(-4)]);

  // ---------------- a reload keeps the helper's thread open
  await ev(`click(${rowBy("Read the dispatcher's logs")})`);
  await until(`$(".pb-helper-bar-title")?.textContent === "Read the dispatcher's logs"`);
  await b.cmd("Page.reload", {});
  await until(`!!$(".pb-shell")`, 6000);
  const reloaded = await until(`$(".pb-helper-bar-title")?.textContent === "Read the dispatcher's logs" && $(".app-main .pb-thread")?.innerText.includes("I could not open the log folder") && ${bar}`, 6000);
  check("a reload keeps the helper's thread open, with its state", reloaded?.state === "Failed" && reloaded.back === "Back to Kaja", reloaded);
  check("in the error tone", (await ev(`$(".pb-helper-bar-state").dataset.status === "failed"`)) === true);
  await ev(`click($(".pb-helper-back"))`);
  check("and back still goes to the chat", !!(await until(`!$(".pb-helper-bar") && !!$(".app-main .pb-worked")`)) && !!(await openWork()) && !!(await until(`${rowsOf}.length === 3`)));

  // ---------------- a helper in the background, watched from start to end
  await open(HS);
  await goTo("Kaja", "chat");
  await openWork();
  await until(`${rowsOf}.length === 3`);
  await ev(`window.pobotsMock.holdHelpers(true)`);
  await ev(`window.pobotsMock.holdWake(true)`);
  await ev(`$(".pb-composer textarea").focus()`);
  await type("Start a helper to read the notes, please.");
  await key("Enter");
  check("a new row arrives, Working, with the thinking dots", !!(await until(`${rowsOf}.length === 4 && ${rowsOf}[3].dataset.status === "running" && ${rowsOf}[3].querySelector(".pb-helper-state .pb-mark-thinking") && ${rowsOf}[3].querySelector(".pb-helper-word").textContent === "Working"`)));
  check("while the bot's own turn runs, the running row is the live line: nothing stands below it", (await ev(`(() => { const r = ${rowsOf}[3], flow = r.closest(".pb-answer-flow"); return flow.lastElementChild !== r.closest(".pb-helper-group") || !flow.querySelector(".pb-pending"); })()`)) === true);
  check("after the bot's turn the row still runs", !!(await until(`$$(".app-main article.pb-msg").at(-1)?.innerText.includes("I started a helper to read the notes") && ${rowsOf}[3].dataset.status === "running"`, 5000)));
  check("the roster line reads Waiting for a helper", !!(await until(`${rowLine("Kaja")} === "Waiting for a helper"`)));
  check("Kaja reads Working, never Done, with no new mark", (await ev(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").dataset.state === "working" && $(".app-head .pb-status").innerText.trim() === "Working" && !$(".app-side .pb-badge, .app-head .pb-badge")`)) === true);
  check("the thinking line stands at the end and reads Waiting for a helper", !!(await until(`(() => { const p = $(".app-main .pb-pending"); return !!p && p === $$(".app-main .pb-thread > .pb-answer").at(-1).querySelector(".pb-answer-flow").lastElementChild && p.innerText.trim() === "Waiting for a helper"; })()`, 3000)), await ev(`$(".app-main .pb-pending")?.innerText`));
  check("a turn whose helper still works is not folded", (await ev(`(() => { const a = ${rowsOf}[3].closest(".pb-answer"); return !a.querySelector(".pb-worked") && !a.dataset.folded && a.contains(${rowsOf}[3]); })()`)) === true);
  const box = await ev(`({ stop: $('.pb-send[aria-label="Stop Kaja"]')?.getAttribute("title") })`);
  check("Stop is offered while only the helper works, and says it stops the helpers too", box?.stop === "Stop Kaja and its helpers", box);
  await type("x");
  check("with text, the button sends at once (a message is not held back for helpers)", (await ev(`$(".pb-send").getAttribute("aria-label")`)) === "Send");
  await ev(`(() => { const t = $(".pb-composer textarea"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await goTo("Kaja", "settings");
  await until(`!!${memory}`);
  check("Settings: Start fresh now is off with Kaja's helper is working", (await ev(`btn("Start fresh now", ${memory}).getAttribute("aria-disabled") === "true" && ${memory}.querySelector(".pb-memory-act .pb-hint").textContent`)) === "Kaja's helper is working. Try again when it is done.");
  await goTo("Kaja", "chat");
  await until(`${rowsOf}.length === 4`);
  // The row's line changes in place while it works: nothing moves.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(200);
  check("its line says the step that runs", !!(await until(`/^Reading /.test(${rowsOf}[3].querySelector(".pb-helper-last").textContent)`, 4000)));
  await ev(`inPanel(${rowsOf}[3])`);
  await hShot("row-working-dark-1280", `${rowsOf}[3]`);
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(200);
  await startWatch();
  await until(`${rowsOf}[3].querySelector(".pb-helper-last").textContent.startsWith("Searching")`, 5000);
  await sleep(1500);
  const lineWatch = still(await stopWatch());
  const lineChanges = new Set((await ev(`window.__hw.map((s) => s.lasts.split("|").at(-1))`)) ?? []);
  check("the line changed in place, and nothing in the thread moved", lineWatch.ok && lineChanges.size >= 2, { ...lineWatch, lines: [...lineChanges] });
  const leak = await ev(`$$(".app-main .pb-thread > * .app-activity-label").map((l) => l.textContent).filter((t) => /memory\\/MEMORY\\.md|AGENTS\\.md|open promises/.test(t) && !t.startsWith("Read AGENTS.md"))`);
  check("the helper's own steps are not drawn into the bot's chat", Array.isArray(leak) && leak.length === 0, leak);
  // Its thread, live.
  await ev(`click(${rowsOf}[3])`);
  check("its thread opens, Working, with the task first", !!(await until(`$(".pb-helper-bar-state")?.innerText.trim() === "Working" && !!$(".pb-helper-bar-state .pb-mark-thinking") && $(".app-main .pb-msg-task")?.innerText.includes("Read AGENTS.md and the memory folder")`)));
  // Since step 7a its three steps are one work line; its result follows, and the thinking line, Working, at the very end.
  check("its steps as one work line, and the thinking line, Working, at its very end under the helper's mark", !!(await until(`$(".app-main .pb-workgroup")?.dataset.count === "3" && $(".app-main .pb-pending-line")?.textContent === "Working" && !!$(".app-main .pb-answer[data-helper] > .pb-who-mark") && $(".app-main .pb-pending") === $(".app-main .pb-answer[data-helper] .pb-answer-flow").lastElementChild`, 4000)), await ev(`[$(".app-main .pb-workgroup")?.dataset.count, $(".app-main .pb-pending-line")?.textContent]`));
  check("Stop helper is there while it works", (await ev(visible(`btn("Stop helper")`))) === true);
  await houseRules("a running helper's thread");
  await hShot("thread-working-dark-1280");
  await ev(`click($(".pb-helper-back"))`);
  await until(`!$(".pb-helper-bar")`);
  // The helper ends: the row turns Finished, and the thread does not change height. The bot's waking is held.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(300);
  await startWatch();
  await ev(`window.pobotsMock.holdHelpers(false)`);
  check("the row turns Finished with the time it ended", !!(await until(`${rowsOf}[3].dataset.status === "done" && /^Finished · \\d\\d:\\d\\d$/.test(${rowsOf}[3].querySelector(".pb-helper-state").innerText.replace(/\\s+/g, " ").trim())`, 6000)));
  await sleep(400);
  const endWatch = still(await stopWatch());
  check("as the row changes state the thread keeps its height and nothing moves", endWatch.ok, endWatch);
  check("its line is now the start of its result", (await ev(`${rowsOf}[3].querySelector(".pb-helper-last").textContent`))?.startsWith("Two things are still open"));
  check("the bot wakes by itself: thinking, with no message of the person's", !!(await until(`${rowLine("Kaja")} === "Reading what the helper found"`)) && (await ev(`$$(".app-main .app-you").at(-1)?.innerText.includes("Start a helper")`)) === true);
  await ev(`window.pobotsMock.holdWake(false)`);
  check("it answers, and is Done the usual way", !!(await until(`$$(".app-main article.pb-msg").at(-1)?.innerText.includes("The helper is done.") && $$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").dataset.state === "done" && /^Answered at /.test(${rowLine("Kaja")})`, 5000)));
  check("no pending line is left over", !!(await until(`!$(".app-main .pb-pending")`)));

  // ---------------- two helpers, a message from the person meanwhile, and stopping one
  await ev(`window.pobotsMock.holdHelpers(true)`);
  await ev(`$(".pb-composer textarea").focus()`);
  await type("Start two helpers for this.");
  await key("Enter");
  check("two rows arrive together as one group", !!(await until(`$$(".app-main .pb-thread .pb-helper-group").at(-1)?.querySelectorAll(".pb-helper").length === 2 && $$(".app-main .pb-thread .pb-helper-group").at(-1).querySelectorAll('.pb-helper[data-status="running"]').length === 2`)));
  check("after the turn: Waiting for 2 helpers", !!(await until(`${rowLine("Kaja")} === "Waiting for 2 helpers"`, 5000)));
  await ev(`$(".pb-composer textarea").focus()`);
  await type("What is the date of the Nordvik import?");
  await key("Enter");
  check("a message sent while helpers work is not queued", !!(await until(`$$(".app-main .app-you").at(-1)?.innerText.startsWith("What is the date") && !$$(".app-main .app-you").at(-1).innerText.includes("Queued")`)) && !(await ev(`$$(".app-line").some((l) => l.textContent.startsWith("Queued"))`)));
  check("it starts a turn at once and is answered", !!(await until(`$$(".app-main article.pb-msg").at(-1)?.innerText.includes("Done. I looked through")`, 6000)));
  check("after that turn the bot is still Waiting for 2 helpers, not done", !!(await until(`${rowLine("Kaja")} === "Waiting for 2 helpers" && $$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").dataset.state === "working"`)));
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await ev(`inPanel($$(".app-main .pb-thread .pb-helper-group").at(-1))`);
  await hShot("rows-together-working-dark-1280", `$$(".app-main .pb-thread .pb-helper-group").at(-1)`);
  await ev(`click($$(".app-main .pb-thread .pb-helper-group").at(-1).querySelector(".pb-helper"))`);
  await until(`!!$(".pb-helper-bar")`);
  const footH = await ev(`$(".pb-main-foot").getBoundingClientRect().height`);
  await ev(`btn("Stop helper").focus()`);
  await key("Enter");
  check("Stop helper asks first", !!(await until(`text(".pb-dialog-title") === "Stop this helper?"`)));
  check("in its words: Kaja is told that it was stopped and carries on without its result.", (await ev(`text(".pb-dialog-text")`)) === "Kaja is told that it was stopped and carries on without its result.");
  check("its buttons: Cancel and Stop helper, Cancel first", (await ev(`$$(".pb-dialog button").map((x) => x.textContent).join("|") + "|" + (document.activeElement?.textContent ?? "")`)) === "Cancel|Stop helper|Cancel");
  await houseRules("stop helper confirm");
  await hShot("stop-helper-confirm-dark-1280");
  await key("Escape");
  check("Escape closes it, focus back on Stop helper, nothing asked of the engine", !!(await until(`!$(".pb-dialog") && document.activeElement?.textContent === "Stop helper"`)) && !(await ev(`window.pobotsMock.requests()["helper.stop"]`)));
  await key("Enter");
  await until(`!!$(".pb-dialog")`);
  await ev(`click($$(".pb-dialog button").find((x) => x.textContent === "Stop helper"))`);
  check("Stop helper stops it: the window asks the engine once (helper.stop)", !!(await until(`!$(".pb-dialog") && window.pobotsMock.requests()["helper.stop"] === 1`)));
  check("the line above turns Stopped, and Stop helper goes", !!(await until(`$(".pb-helper-bar-state")?.innerText.trim() === "Stopped" && !${visible(`btn("Stop helper")`)}`)));
  check("the foot keeps its height", (await ev(`$(".pb-main-foot").getBoundingClientRect().height`)) === footH);
  await ev(`click($(".pb-helper-back"))`);
  check("in the chat the row reads Stopped, the other still works", !!(await until(`[...$$(".app-main .pb-thread .pb-helper-group").at(-1).querySelectorAll(".pb-helper")].map((r) => r.dataset.status).join(",") === "stopped,running"`)));
  check("the bot is told and carries on: it wakes and says so", !!(await until(`$$(".app-main article.pb-msg").some((a) => a.innerText.includes("You stopped the helper, so I carry on without its result."))`, 5000)));
  check("then waits for the other one", !!(await until(`${rowLine("Kaja")} === "Waiting for a helper"`, 5000)));

  // ---------------- Stop at the message box with only a helper working
  const twoRows = await ev(`[...$$(".app-main .pb-thread .pb-helper-group").at(-1).querySelectorAll(".pb-helper")].map((r) => r.dataset.helperId)`);
  await ev(`click($('.pb-send[aria-label="Stop Kaja"]'))`);
  // Once both have stopped their turn has ended and folds its work: read the rows from the opened line.
  const stoppedBoth = await until(`(() => { const w = $$(".app-main .pb-thread > .pb-answer").filter((a) => a.innerText.includes("I started two helpers")).map((a) => a.querySelector(".pb-worked")).find(Boolean); if (!w) return false; if (w.getAttribute("aria-expanded") === "false") w.click(); const ids = ${JSON.stringify(twoRows ?? [])}; const rows = $$(".app-main .pb-helper").filter((r) => ids.includes(r.dataset.helperId)); return rows.length === 2 && rows.every((r) => r.dataset.status === "stopped") && w.innerText.includes("· 2 helpers"); })()`);
  check("Stop at the message box stops the helper too (turn.interrupt), and the turn then folds with both rows Stopped", !!stoppedBoth && (await ev(`window.pobotsMock.requests()["turn.interrupt"]`)) === 1);
  check("and the bot rests: Stopped by you, no wake afterwards", !!(await until(`${rowLine("Kaja")} === "Stopped by you"`)) && (await sleep(1200), (await ev(`${rowLine("Kaja")}`)) === "Stopped by you"));
  await ev(`window.pobotsMock.holdHelpers(false)`);

  // ---------------- two helpers that both report back: every result stays in sight after the fold
  // Engine 0.31.2: each helper's result is told in a turn of its own, and every turn is an answer of
  // its own, with a quiet line under the name; the turn that started them keeps its own answer.
  await ev(`$(".pb-composer textarea").focus()`);
  await type("Start two helpers for this.");
  await key("Enter");
  const bothSaid = await until(
    `(() => {
      const you = $$(".app-main .pb-thread > .app-you").filter((y) => y.textContent.includes("Start two helpers for this.")).at(-1);
      if (!you) return false;
      const after = [];
      for (let e = you.nextElementSibling; e; e = e.nextElementSibling) if (e.classList.contains("pb-answer")) after.push(e);
      const seen = (a, start) => [...a.querySelectorAll(".pb-msg-body")].some((b) => b.innerText.startsWith(start) && b.checkVisibility());
      const results = after.filter((a) => seen(a, "The helper is done."));
      const woke = results.filter((a) => a.querySelector(".pb-woke")?.textContent === "A helper or background task reported back");
      return after.length === 3 && after[0].hasAttribute("data-folded") && seen(after[0], "I started two helpers") && results.length === 2 && woke.length === 2 && !after[0].querySelector(".pb-woke") ? after.length : false;
    })()`,
    30000,
  );
  check(
    "two helpers that both report back: each result is an answer of its own with the quiet line, and the turn that started them keeps its answer",
    bothSaid === 3,
    bothSaid || (await ev(`(() => { const as = $$(".app-main .pb-thread > .pb-answer").slice(-3); return JSON.stringify(as.map((a) => ({ folded: a.hasAttribute("data-folded"), woke: a.querySelector(".pb-woke")?.textContent ?? null, said: [...a.querySelectorAll(".pb-msg-body")].map((b) => b.innerText.slice(0, 40)) }))); })()`)),
  );

  // ---------------- 1280 and 800 px, light and dark: rows, a working row, the thread
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      const tag = `${theme}-${width}`;
      await open(HS, { width, theme });
      await goTo("Kaja", "chat");
      await openWork();
      await until(`${rowsOf}.length === 3`);
      await ev(`inPanel($$(".app-main .pb-helper-group")[0])`);
      const fit = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, view: $(".app-main .pb-main-scroll").scrollWidth - $(".app-main .pb-main-scroll").clientWidth, rows: ${rowsOf}.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10), inside: ${rowsOf}.every((r) => r.getBoundingClientRect().right <= $(".app-main .pb-thread").getBoundingClientRect().right + 0.5), words: ${rowsOf}.every((r) => { const s = r.querySelector(".pb-helper-state").getBoundingClientRect(), t = r.querySelector(".pb-helper-text").getBoundingClientRect(); return t.right <= s.left; }) })`);
      check(`${theme}, ${width} px: rows fit, keep one height, and the title never runs under the state`, fit && fit.page <= 0 && fit.view <= 1 && fit.inside && fit.words && fit.rows.every((h) => h === fit.rows[0]), fit);
      await houseRules(`${theme}, ${width} px, helper rows`);
      if (theme !== "dark" || width !== 1280) {
        await hShot(`rows-together-${tag}`, `$$(".app-main .pb-helper-group")[0]`);
        await hShot(`row-finished-${tag}`, rowBy("Inventory the work-bot"));
        await hShot(`row-failed-${tag}`, rowBy("Read the dispatcher's logs"));
        await ev(`inPanel(${rowBy("Search the onboarding chat")})`);
        await hShot(`row-stopped-${tag}`, rowBy("Search the onboarding chat"));
      }
      await hShot(`chat-with-rows-${tag}`);
      await ev(`click(${rowBy("Inventory the work-bot")})`);
      await until(`!!$(".pb-helper-bar")`);
      const fitT = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, view: $(".app-main .pb-main-scroll").scrollWidth - $(".app-main .pb-main-scroll").clientWidth, bar: (() => { const b = $(".pb-helper-bar").getBoundingClientRect(), t = $(".app-main .pb-thread").getBoundingClientRect(); return Math.abs(b.left + parseFloat(getComputedStyle($(".pb-helper-bar")).paddingLeft) - t.left) <= 1; })(), state: $(".pb-helper-bar-state").getBoundingClientRect().right <= $(".pb-helper-bar").getBoundingClientRect().right })`);
      check(`${theme}, ${width} px: the helper's thread fits, its top line aligned with the thread`, fitT && fitT.page <= 0 && fitT.view <= 1 && fitT.bar && fitT.state, fitT);
      await houseRules(`${theme}, ${width} px, a helper's thread`);
      await until(`!!$(".app-main .pb-msg-task")`);
      await sleep(200);
      await ev(toTop);
      await hShot(`thread-open-${tag}`);
      await ev(`click($(".pb-helper-back"))`);
      await until(`!$(".pb-helper-bar")`);
      await ev(`window.pobotsMock.holdHelpers(true)`);
      await ev(`$(".pb-composer textarea").focus()`);
      await type("Start a helper for this.");
      await key("Enter");
      await until(`${rowsOf}.length === 4 && /^Reading /.test(${rowsOf}[3].querySelector(".pb-helper-last").textContent)`, 5000);
      const runH = await ev(`Math.round(${rowsOf}[3].getBoundingClientRect().height * 10) / 10`);
      check(`${theme}, ${width} px: a working row has the same height`, runH === fit?.rows[0], [runH, fit?.rows[0]]);
      await ev(`inPanel(${rowsOf}[3])`);
      if (theme !== "dark" || width !== 1280) await hShot(`row-working-${tag}`, `${rowsOf}[3]`);
      await ev(`click(${rowsOf}[3])`);
      await until(`$(".pb-helper-bar-state")?.innerText.trim() === "Working"`);
      await until(`$$(".app-main .pb-activity").length >= 2`, 4000);
      if (theme !== "dark" || width !== 1280) await hShot(`thread-working-${tag}`);
      await houseRules(`${theme}, ${width} px, a running helper's thread`);
      await ev(`window.pobotsMock.holdHelpers(false)`);
      // Leave the chat as it was found: an open helper thread is kept in the history entry, and the
      // next page opened at the same address would start in it.
      await ev(`click($(".pb-helper-back"))`);
      await until(`!$(".pb-helper-bar")`);
    }
  }
  check("back in the chat, no helper thread is left open in the history entry", (await ev(`!history.state?.pobotsHelpers || Object.keys(history.state.pobotsHelpers).length === 0`)) === true, await ev(`JSON.stringify(history.state)`));
  if (helperShots) console.log(`Helper pictures in ${helperShots}`);


  // ================================================================ step 2e, addition: a turn in order, and its work folded (in section 2e: it uses that step's helpers)
  // docs/build/step-2e-flow.md. In the mock a message that says "step by step" runs a turn with a
  // text, two steps and more text, and the lever holdSteps makes it wait at every moment. Positions are
  // measured against the thread's own top (its content, not the screen) on every change, from the
  // moment the answer's first line has arrived until the turn's work folds.
  const flowShots = arg("flow-shots") ?? (shots ? join(shots, "flow") : undefined);
  if (flowShots) mkdirSync(flowShots, { recursive: true });
  async function fShot(name) {
    if (!flowShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(flowShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const STEP_ASK = "Go through Thursday step by step.";
  const LAST_TEXT = "Two things are open for Thursday: the Nordvik import at 10:00, and the kickoff for Lindgren & Co, which still has no date. Both are in tomorrow's plan.";
  const PHASES = [
    "thinking before the first text",
    "halfway through the first text",
    "thinking before Read memory/promises.md",
    "running Read memory/promises.md",
    "thinking before Read the calendar for Thursday",
    "running Read the calendar for Thursday",
    "thinking before the answer",
    "halfway through the answer",
  ];
  const PICTURE_AT = { "halfway through the first text": "2-text-arriving", "running Read memory/promises.md": "3-step-running", "thinking before Read the calendar for Thursday": "4-thinking-between-steps", "halfway through the answer": "5-answer-arriving" };
  const stepPhase = `window.pobotsMock.stepPhase()`;
  const newest = `$$(".app-main .pb-thread > .pb-answer").at(-1)`;
  const WORKED = /^Worked for (\d+s|\d+m( \d+s)?)$/;
  /** What the newest answer shows now. */
  const answerNow = `(() => {
    const a = ${newest};
    if (!a) return null;
    const kids = [...a.querySelector(".pb-answer-flow").children];
    const last = kids.at(-1);
    return {
      faces: a.querySelectorAll(".pb-avatar").length,
      heads: a.querySelectorAll(".pb-msg-head").length,
      who: a.querySelector(".pb-msg-head b")?.textContent,
      pendings: $$(".app-main .pb-pending").length,
      pendingLast: !!last?.classList.contains("pb-pending"),
      words: last?.classList.contains("pb-pending") ? last.innerText.trim() : null,
      lastIsText: !!last?.matches(".pb-msg-body"),
      lastIsRunningStep: !!last?.matches(".pb-step") && !!last.querySelector(".pb-mark-working"),
      running: a.querySelectorAll(".pb-mark-working").length,
      // Step 7a: the newest group of work is one live line; it shows the step that runs, or "Thinking".
      live: last?.matches(".pb-workgroup[data-live]") ? last.querySelector(".pb-workline-words").textContent : null,
    };
  })()`;
  // The watch: every item's top against the thread's top must never change once drawn; the pieces of
  // the answer stand in order; the thinking line is only ever the last thing and never below a running
  // step; what takes its place starts at its top edge; the face and name stand once; the chat stays at
  // the bottom. When the work folds, the answer's distance to the foot of the chat is noted.
  const WATCH = `(() => {
    window.__tw?.obs.disconnect();
    const scroller = $(".app-main .pb-main-scroll");
    const first = new WeakMap();
    const st = { samples: 0, moved: [], order: [], replaced: [], below: [], heads: new Set(), unpinned: 0, pendingTop: null, kidsText: [], footBefore: null, footAfter: null, pinnedAfter: null, folded: false };
    let prevKids = [];
    const foot = (a) => {
      const texts = a.querySelectorAll(".pb-msg-body");
      const last = texts[texts.length - 1];
      return last ? Math.round((scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) * 10) / 10 : null;
    };
    const sample = () => {
      if (st.folded) return;
      const t = $(".app-main .pb-thread");
      const a = $$(".app-main .pb-thread > .pb-answer").at(-1);
      if (!t || !a) return;
      if (a.dataset.folded) {
        st.folded = true;
        st.footAfter = foot(a);
        st.pinnedAfter = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
        return;
      }
      st.samples++;
      const t0 = t.getBoundingClientRect().top;
      const rel = (el) => { const r = el.getBoundingClientRect(); return { top: r.top - t0, bottom: r.bottom - t0 }; };
      const kids = [...a.querySelector(".pb-answer-flow").children];
      const tracked = [...$$(".app-main .pb-thread > *").filter((k) => k !== a), a.querySelector(".pb-msg-head"), ...kids].filter(Boolean);
      for (const el of tracked) {
        if (el.classList.contains("pb-pending")) continue;
        const top = Math.round(rel(el).top * 10) / 10;
        if (!first.has(el)) first.set(el, top);
        else if (Math.abs(first.get(el) - top) > 0.5) st.moved.push({ what: String(el.className || el.tagName).slice(0, 40), from: first.get(el), to: top });
      }
      for (let i = 1; i < kids.length; i++) {
        const p = rel(kids[i - 1]), n = rel(kids[i]);
        if (n.top < p.bottom - 0.5) st.order.push({ i, prevBottom: p.bottom, top: n.top });
      }
      const last = kids[kids.length - 1];
      const pend = last && last.classList.contains("pb-pending") ? last : null;
      if ($$(".app-main .pb-pending").some((p) => p !== pend)) st.below.push("a thinking line that is not the last thing");
      if (pend && a.querySelector(".pb-answer-flow .pb-mark-working")) st.below.push("a thinking line below a running step");
      const fresh = kids.filter((k) => !prevKids.includes(k) && !k.classList.contains("pb-pending"));
      if (pend) st.pendingTop = Math.round(rel(pend).top * 10) / 10;
      else if (fresh.length && st.pendingTop !== null) {
        st.replaced.push({ was: st.pendingTop, now: Math.round(rel(fresh[0]).top * 10) / 10, what: String(fresh[0].className).slice(0, 30) });
        st.pendingTop = null;
      }
      st.heads.add(a.querySelectorAll(".pb-avatar").length + "/" + a.querySelectorAll(".pb-msg-head").length);
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1) st.unpinned++;
      prevKids = kids;
      st.kidsText = kids.filter((k) => !k.classList.contains("pb-pending")).map((k) => k.innerText.replace(/\\s+/g, " ").trim());
      st.footBefore = foot(a);
    };
    const obs = new MutationObserver(sample);
    obs.observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true });
    sample();
    window.__tw = { st, obs };
    return true;
  })()`;
  const watchResult = `(() => { window.__tw.obs.disconnect(); const s = window.__tw.st; return { ...s, heads: [...s.heads] }; })()`;
  // Since step 7a the steps that follow each other are one live work line: while one runs it shows that
  // step's words; between them it says "Thinking" itself (no thinking line of its own below it).
  const RUNNING_WORDS = { "running Read memory/promises.md": "Reading memory/promises.md", "running Read the calendar for Thursday": "Reading the calendar for Thursday" };
  const expected = (m) =>
    m.name.startsWith("thinking")
      ? (m.pendingLast && m.pendings === 1 && m.words === "Thinking" && m.running === 0) || (m.pendings === 0 && m.live === "Thinking")
      : m.name.startsWith("halfway")
        ? m.pendings === 0 && m.lastIsText
        : m.pendings === 0 && m.live === RUNNING_WORDS[m.name];

  /** Sends the "step by step" message, holds the turn at every moment and checks each one. */
  async function stepTurn(where, { pics, readUp } = {}) {
    await ev(`window.pobotsMock.holdSteps(true)`);
    await ev(`$(".pb-composer textarea").focus()`);
    await type(STEP_ASK);
    await key("Enter");
    const started = await until(`${stepPhase} === ${JSON.stringify(PHASES[0])}`, 5000);
    const at0 = await ev(answerNow);
    check(`${where}: the message is answered at once by the thinking line, under the face and name, at the very end`, !!started && at0?.pendingLast && at0.words === "Thinking" && at0.faces === 1 && at0.heads === 1, at0);
    await sleep(450);
    if (pics) await fShot(`${pics}-1-thinking`);
    let reading;
    if (readUp) {
      // The person reads further up while the turn runs below.
      reading = await ev(`(() => { const s = $(".app-main .pb-main-scroll"); const m = $$(".app-main .pb-thread > *").find((k) => k.innerText.includes(${JSON.stringify(readUp)})); inPanel(m); s.dispatchEvent(new Event("scroll")); return { up: s.scrollHeight - s.scrollTop - s.clientHeight, top: Math.round(m.getBoundingClientRect().top * 10) / 10, scroll: s.scrollTop }; })()`);
      await sleep(150);
    }
    await ev(WATCH);
    const moments = [];
    const tops = [];
    for (const name of PHASES) {
      const ok = await until(`${stepPhase} === ${JSON.stringify(name)}`, 5000);
      // Right after text the thinking line waits a moment (a turn usually ends there); it then stands at the end.
      if (name.startsWith("thinking")) await until(`(() => { const m = ${answerNow}; return !!m && m.pendingLast; })()`, 3000);
      await sleep(80);
      moments.push({ name, ok: !!ok, ...(await ev(answerNow)) });
      if (readUp) tops.push(await ev(`Math.round($$(".app-main .pb-thread > *").find((k) => k.innerText.includes(${JSON.stringify(readUp)})).getBoundingClientRect().top * 10) / 10`));
      if (pics && PICTURE_AT[name]) await fShot(`${pics}-${PICTURE_AT[name]}`);
      await ev(`window.pobotsMock.stepOn()`);
    }
    const folded = await until(`!!${newest}?.dataset.folded`, 6000);
    await sleep(350);
    if (readUp) tops.push(await ev(`Math.round($$(".app-main .pb-thread > *").find((k) => k.innerText.includes(${JSON.stringify(readUp)})).getBoundingClientRect().top * 10) / 10`));
    await ev(`window.pobotsMock.holdSteps(false)`);
    return { moments, w: await ev(watchResult), folded: !!folded, reading, tops, scrollAfter: await ev(`$(".app-main .pb-main-scroll").scrollTop`) };
  }

  /** The checks on one watched turn. */
  function turnChecks(where, r) {
    const off = r.moments.filter((m) => !m.ok || !expected(m));
    check(`${where}: at every moment the live thing is the last thing (the thinking line only between things, never below a running step or arriving text)`, off.length === 0 && r.w.below.length === 0, { off: off.slice(0, 2), below: r.w.below.slice(0, 2) });
    check(`${where}: the face and name stand once in the turn`, r.moments.every((m) => m.faces === 1 && m.heads === 1 && (m.who === "HubSpot tickets" || m.who === "Kaja")) && r.w.heads.length === 1 && r.w.heads[0] === "1/1", { heads: r.w.heads, moments: r.moments.map((m) => `${m.faces}/${m.heads}`) });
    check(`${where}: each new item starts at or below the bottom of the item before it`, r.w.order.length === 0 && r.w.samples > 10, { order: r.w.order.slice(0, 2), samples: r.w.samples });
    check(`${where}: no item's top edge changes after it was drawn (against the thread's content)`, r.w.moved.length === 0, r.w.moved.slice(0, 3));
    check(`${where}: the thinking line and what takes its place share a top edge`, r.w.replaced.length >= 2 && r.w.replaced.every((x) => Math.abs(x.was - x.now) <= 0.5), r.w.replaced);
    check(`${where}: the finished turn folds its work`, r.folded);
  }

  // ---------------- the turn, watched, at 1280 and 800 px, light and dark, and with reduced motion
  const flowRuns = [
    ["dark", 1280, false],
    ["dark", 800, false],
    ["light", 1280, false],
    ["light", 800, false],
    ["dark", 1280, true],
  ];
  for (const [theme, width, reduce] of flowRuns) {
    const tag = `${theme}-${width}${reduce ? "-reduced-motion" : ""}`;
    await open("", { width, theme });
    if (reduce) await b.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await goTo("HubSpot tickets", "chat");
    await until(`!!$(".app-main .pb-fold")`);
    const r = await stepTurn(`turn in order, ${tag}`, { pics: reduce ? undefined : `turn-${tag}` });
    turnChecks(`turn in order, ${tag}`, r);
    check(`${tag}: the chat stays at the bottom while the turn runs`, r.w.unpinned === 0, r.w.unpinned);
    check(`${tag}: at the bottom, the answer keeps its distance to the foot of the chat as the work folds`, r.w.footBefore !== null && Math.abs(r.w.footBefore - r.w.footAfter) <= 0.5 && r.w.pinnedAfter, { before: r.w.footBefore, after: r.w.footAfter, pinned: r.w.pinnedAfter });
    const fold = await ev(`(() => {
      const a = ${newest}, w = a.querySelector(".pb-worked");
      return { lines: a.querySelectorAll(".pb-worked").length, words: w?.querySelector(".pb-worked-words")?.textContent, time: /^\\d\\d:\\d\\d$/.test(w?.querySelector("time")?.textContent ?? ""), texts: [...a.querySelectorAll(".pb-msg-body")].map((t) => t.innerText.trim()), steps: a.querySelectorAll(".pb-activity").length, work: !!a.querySelector(".pb-work"), lastIsAnswer: a.querySelector(".pb-answer-flow").lastElementChild.matches(".pb-msg-body") };
    })()`);
    check(`${tag}: one quiet line, Worked for and the length, with the time at the right, and the answer in full below it`, fold?.lines === 1 && WORKED.test(fold.words ?? "") && fold.time && fold.texts.length === 1 && fold.texts[0] === LAST_TEXT && fold.steps === 0 && !fold.work && fold.lastIsAnswer, fold);
    await houseRules(`${tag}, a folded turn`);
    if (!reduce) await fShot(`turn-${tag}-6-folded`);
    // Opened: the work as it stood, in the same order, then the answer.
    await ev(`click(${newest}.querySelector(".pb-worked"))`);
    const opened = await until(`(() => { const a = ${newest}; const work = a.querySelector(".pb-work"); if (!work || a.querySelector(".pb-worked").getAttribute("aria-expanded") !== "true") return false; return [...work.children, ...[...a.querySelector(".pb-answer-flow").children].filter((k) => k.matches(".pb-msg-body"))].map((k) => k.innerText.replace(/\\s+/g, " ").trim()); })()`);
    check(`${tag}: the line opens on click and shows the same items as before, in order`, JSON.stringify(opened) === JSON.stringify(r.w.kidsText), { opened, before: r.w.kidsText });
    await houseRules(`${tag}, an opened fold`);
    if (!reduce) await fShot(`turn-${tag}-7-opened`);
    await ev(`click(${newest}.querySelector(".pb-worked"))`);
    check(`${tag}: and closes again on click`, !!(await until(`!${newest}.querySelector(".pb-work") && ${newest}.querySelector(".pb-worked").getAttribute("aria-expanded") === "false"`)));
    if (reduce) await b.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }

  // ---------------- the fold line with the keyboard: one of the chat's line buttons
  const workLine = `${newest}.querySelector(".pb-worked")`;
  const allLines = `$$(".app-main :is(.app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked)")`;
  check("the newest Worked for line is the chat lines' one Tab stop", (await ev(`${allLines}.filter((x) => x.tabIndex === 0).length === 1 && ${workLine}.tabIndex === 0`)) === true);
  await ev(`${workLine}.focus()`);
  check("focused, it shows the focus ring", (await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.classList.contains("pb-worked") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`)) === true);
  await key("Enter");
  check("Enter opens it", !!(await until(`${workLine}.getAttribute("aria-expanded") === "true" && !!${newest}.querySelector(".pb-work")`)));
  await key("Enter");
  check("Enter closes it again, focus stays on it", !!(await until(`${workLine}.getAttribute("aria-expanded") === "false" && !${newest}.querySelector(".pb-work") && document.activeElement === ${workLine}`)));

  // ---------------- a turn without steps gets no line, and notices stay outside
  check("a turn with no steps and one text gets no line: it is just the answer", (await ev(`(() => { const a = $$(".app-main .pb-thread > .pb-answer").find((x) => x.innerText.includes("No new tickets since 09:40.")); return !!a && !a.querySelector(".pb-worked") && !a.dataset.folded; })()`)) === true);
  // A turn that is stopped keeps its notice in sight, outside the fold.
  await ev(`window.pobotsMock.holdSteps(true)`);
  await ev(`$(".pb-composer textarea").focus()`);
  await type(STEP_ASK);
  await key("Enter");
  await until(`${stepPhase} === "thinking before the first text"`, 5000);
  for (const name of PHASES.slice(0, 3)) {
    await until(`${stepPhase} === ${JSON.stringify(name)}`, 5000);
    await ev(`window.pobotsMock.stepOn()`);
  }
  await until(`${stepPhase} === "running Read memory/promises.md"`, 5000);
  await ev(`click($('.pb-send[aria-label="Stop HubSpot tickets"]'))`);
  const stopped = await until(`(() => { const kids = $$(".app-main .pb-thread > *"); const n = kids.at(-1); const a = kids.at(-2); return !!n && n.matches(".app-notice") && n.innerText.startsWith("Stopped.") && a?.matches(".pb-answer") && !!a.dataset.folded && n.checkVisibility() && !n.closest(".pb-answer"); })()`, 6000);
  check("a stopped turn folds its work and keeps its notice in sight, outside the fold", !!stopped, await ev(`$$(".app-main .pb-thread > *").slice(-2).map((k) => k.className + ":" + k.innerText.slice(0, 40))`));
  await ev(`window.pobotsMock.holdSteps(false)`);
  await goTo("Inbox", "chat");
  check("Inbox: a turn with no steps gets no line either", !!(await until(`(() => { const a = $$(".app-main .pb-thread > .pb-answer").find((x) => x.innerText.includes("I will. I tell Kaja")); return !!a && !a.querySelector(".pb-worked"); })()`)));
  check("a turn another bot started is still one folded line of its own", (await ev(`$$(".app-main .pb-fold").length === 1 && text(".pb-fold").startsWith("Kaja asked Inbox, 2 messages")`)) === true);
  await goTo("Kaja", "chat");
  const kajaFolds = await until(`(() => {
    const kids = $$(".app-main .pb-thread > *");
    const n = kids.findIndex((k) => k.matches(".app-notice") && k.innerText.startsWith("Answered in Ops - Internal"));
    const before = kids[n - 1];
    return n > 0 && before.matches(".pb-answer[data-folded]") && kids[n].checkVisibility() && !!$(".app-main .pb-fresh-wrap") && $$(".app-main .pb-worked").length;
  })()`);
  check("Kaja's finished turns are folded; Answered in Ops - Internal and the fresh start line stay outside, where they were", kajaFolds >= 3, kajaFolds);
  check("old turns are closed by default", (await ev(`$$(".app-main .pb-worked").every((w) => w.getAttribute("aria-expanded") === "false") && !$(".app-main .pb-work")`)) === true);

  // ---------------- in Kaja's long chat: at the bottom, then reading further up
  {
    const r = await stepTurn("Kaja, at the bottom");
    turnChecks("Kaja, at the bottom", r);
    check("Kaja, at the bottom: the chat follows the end and stays at the bottom", r.w.unpinned === 0, r.w.unpinned);
    check("Kaja, at the bottom: the answer keeps its distance to the foot of the chat as the work folds", r.w.footBefore !== null && Math.abs(r.w.footBefore - r.w.footAfter) <= 0.5 && r.w.pinnedAfter, { before: r.w.footBefore, after: r.w.footAfter });
    const u = await stepTurn("Kaja, reading further up", { readUp: "Result of Morning brief" });
    check("Kaja: the person reads further up, not at the bottom", (u.reading?.up ?? 0) > 120, u.reading);
    turnChecks("Kaja, reading further up", u);
    check("reading further up: what the person reads does not move while the turn runs or when its work folds, and nothing scrolls", u.tops.length === PHASES.length + 1 && u.tops.every((t) => Math.abs(t - u.tops[0]) <= 0.5) && u.scrollAfter === u.reading?.scroll, { tops: u.tops, scroll: [u.reading?.scroll, u.scrollAfter] });
  }

  // ---------------- a folded turn with helpers
  // Its first turn lasted 7 minutes and ended at 09:37 of the mock's day. In the first half hour
  // after midnight there is not that much of today before now (mock-data's seedToday), so then these
  // pages read 10:00, as the helpers rail does (fix 0.26.3).
  const nowMinutes = clock ? Number(clock[1]) * 60 + Number(clock[2]) : new Date().getHours() * 60 + new Date().getMinutes();
  const unfix = nowMinutes < 30 ? await fixClock(10, 0) : undefined;
  if (unfix) console.log("The folded turns with helpers are seen with the page's clock at 10:00.");
  try {
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      const tag = `${theme}-${width}`;
      await open(HS, { width, theme });
      await goTo("Kaja", "chat");
      await until(`$$(".app-main .pb-worked").length >= 2`);
      const words = await ev(`$$(".app-main .pb-worked-words").map((w) => w.textContent)`);
      check(`${tag}: a folded turn with helpers names them after the length`, words?.includes("Worked for 7m · 2 helpers") && words.includes("Worked for 2m · 1 helper"), words);
      const withHelpers = `$$(".app-main .pb-worked").find((w) => w.textContent.includes("2 helpers"))`;
      await ev(`inPanel(${withHelpers}.closest(".pb-answer"))`);
      await fShot(`fold-helpers-${tag}`);
      await ev(`click(${withHelpers})`);
      check(`${tag}: opened, the work shows again in place, helper rows included`, !!(await until(`${withHelpers}.closest(".pb-answer").querySelectorAll(".pb-work .pb-helper").length === 2`)));
      await houseRules(`${tag}, an opened fold with helpers`);
      await ev(`inPanel(${withHelpers}.closest(".pb-answer"))`);
      await fShot(`fold-helpers-open-${tag}`);
    }
  }
  } finally {
    await unfix?.();
  }
  if (flowShots) console.log(`Turn pictures in ${flowShots}`);

  }
}
