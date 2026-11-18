// The window check, section "2d". Run it alone: node scripts/ui-check.mjs --only=2d
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 2d: working memory
export default async function section() {
  part2d: {
  // Helpers for this part: the thread's own children, the Working memory section, a day and time as
  // the Settings tab writes it ("10 Nov 17:24"), and a recorder that measures the fresh start line
  // and its neighbours on every change of the chat until it is stopped.
  const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayAt = (daysAgo, h, m) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getDate()} ${MONTH[d.getMonth()]} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const outsideLine = `$$(".pb-thread > *").filter((el) => !el.classList.contains("pb-fresh-wrap")).map((el) => el.innerText).join(" ")`;
  const TIDY_WORDS = ["Note from Pobots", "Working on the", "memory/MEMORY.md", "memory/promises.md", "Nothing is sent without asking", "Nothing else is promised"];
  const tidyHidden = async () => {
    const t = await ev(outsideLine);
    return typeof t === "string" && TIDY_WORDS.every((w) => !t.includes(w));
  };
  /** Starts measuring: the top of every item from the first up to `upTo` after the line, the line's height, the scroll. */
  const startRecorder = (upTo = 1) =>
    ev(`(() => {
      const scroller = $(".app-main .pb-main-scroll");
      const measure = () => {
        const kids = $$(".pb-thread > *");
        const at = kids.findLastIndex((k) => k.classList.contains("pb-fresh-wrap"));
        const line = kids[at];
        return {
          state: line?.querySelector(".pb-fresh")?.dataset.state ?? "none",
          tops: kids.slice(0, at + 1 + ${upTo}).map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10),
          height: line ? Math.round(line.querySelector(".pb-fresh").getBoundingClientRect().height * 10) / 10 : 0,
          scroll: scroller.scrollTop,
          focus: document.activeElement?.className ?? "",
        };
      };
      window.__samples = [measure()];
      window.__observer?.disconnect();
      window.__observer = new MutationObserver(() => window.__samples.push(measure()));
      window.__observer.observe(scroller, { subtree: true, childList: true, attributes: true, characterData: true });
      return true;
    })()`);
  const stopRecorder = () => ev(`(() => { window.__observer.disconnect(); return window.__samples; })()`);
  /** Every sample up to the first one in the done state, with the line and everything before it in the same place. */
  const steady = (samples, n) => {
    const first = samples[0];
    const upToDone = samples.slice(0, samples.findIndex((s) => s.state === "done") + 1);
    const bad = upToDone.filter((s) => s.height !== first.height || s.scroll !== first.scroll || s.tops.slice(0, n).some((t, i) => Math.abs(t - first.tops[i]) > 0.5));
    return { ok: upToDone.length > 1 && upToDone.at(-1).state === "done" && bad.length === 0, samples: upToDone.length, bad: bad.slice(0, 2), first };
  };

  // ---------------- the fresh start line in the chat
  await open("");
  await goTo("Kaja", "chat");
  check("Kaja's chat has one fresh start line", !!(await until(`$$(".pb-fresh-wrap").length === 1`)));
  check("it reads Started fresh with when", /^Started fresh · (Yesterday )?\d\d:\d\d$/.test((await ev(`text(".pb-fresh-btn")`)) ?? ""), await ev(`text(".pb-fresh-btn")`));
  check("it is closed by default", (await ev(`$(".pb-fresh-btn").getAttribute("aria-expanded") === "false" && !$(".pb-fresh-body")`)) === true);
  check("the tidy turn is not drawn as messages (request, steps, note)", await tidyHidden(), await ev(outsideLine));
  check("no bubble on the right for Pobots' request", (await ev(`$$(".app-you").some((el) => el.innerText.includes("Note from Pobots"))`)) === false);
  check("the line sits where the tidy turn was, after yesterday's sweep and before this morning", (await ev(`(() => { const kids = $$(".pb-thread > *"); const at = kids.findIndex((k) => k.classList.contains("pb-fresh-wrap")); return kids[at - 1].innerText.includes("Two promises are still open") && kids[at + 1].innerText.includes("Result of Morning brief"); })()`)) === true);
  const look = await ev(`(() => {
    const line = $(".pb-fresh"), btn = $(".pb-fresh-btn"), before = getComputedStyle(line, "::before");
    return {
      spans: Math.round(line.getBoundingClientRect().width) === Math.round($(".pb-thread").getBoundingClientRect().width),
      rule: before.height === "1px" && before.backgroundColor !== "rgba(0, 0, 0, 0)" && before.borderTopStyle === "none",
      faint: getComputedStyle(btn).color === getComputedStyle($(".pb-msg-head time")).color,
      quieter: parseFloat(getComputedStyle(btn).fontSize) < parseFloat(getComputedStyle($(".pb-msg-body")).fontSize),
      notMessage: !line.closest("article, .pb-msg"),
      height: line.getBoundingClientRect().height,
    };
  })()`);
  check("the line spans the thread with a 1px divider rule, not a border", look?.spans && look?.rule, look);
  check("its words are ink-faint and smaller than a message, and it is no message", look?.faint && look?.quieter && look?.notMessage, look);
  const lineTop = `Math.round($(".pb-fresh").getBoundingClientRect().top)`;
  await ev(`inPanel($(".pb-fresh-wrap"))`);
  await ev(`$(".app-main .pb-main-scroll").dispatchEvent(new Event("scroll"))`);
  await sleep(100);
  const topBefore = await ev(lineTop);
  await ev(`click($(".pb-fresh-btn"))`);
  check("a click opens it", !!(await until(`$(".pb-fresh-btn").getAttribute("aria-expanded") === "true" && !!$(".pb-fresh-body")`)));
  check("and the line stays where it was", (await ev(lineTop)) === topBefore, [topBefore, await ev(lineTop)]);
  check("open, it says what this is in one sentence", (await ev(`text(".pb-fresh-what")`)) === "Kaja wrote this down for itself before starting fresh. The chat above is still there for you, and Kaja can search it.");
  check("then the note, as markdown", (await ev(`$$(".pb-fresh-note li").length === 4 && text(".pb-fresh-note p").startsWith("Working on the Nordvik onboarding") && !$(".pb-fresh-note").textContent.includes("- Open")`)) === true);
  check("then the steps as the usual quiet lines", (await ev(`$$(".pb-fresh-steps .pb-activity").map((a) => a.querySelector(".app-activity-label").textContent).join("|")`)) === "Edited memory/MEMORY.md|Edited memory/promises.md");
  check("all of it in a well", (await ev(`(() => { const s = getComputedStyle($(".pb-fresh-body")); return s.boxShadow !== "none" && parseFloat(s.borderTopLeftRadius) > 0 && s.backgroundColor !== getComputedStyle($(".app-main")).backgroundColor; })()`)) === true);
  await ev(`click($$(".pb-fresh-steps .app-activity-btn")[1])`);
  check("a step opens its detail", !!(await until(`text(".pb-fresh-steps .app-activity-detail") === "memory/promises.md"`)));
  await houseRules("chat with the fresh start line open");
  await shot("fresh-line-open");
  await ev(`click($(".pb-fresh-btn"))`);
  check("a second click closes it", !!(await until(`$(".pb-fresh-btn").getAttribute("aria-expanded") === "false" && !$(".pb-fresh-body")`)));

  // ---------------- the line with the keyboard: one of the chat's line buttons
  await ev(`(() => { const all = $$(".app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked"); all.find((b) => b.tabIndex === 0).focus(); return true; })()`);
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await key("ArrowUp");
    reached = (await ev(`document.activeElement === $(".pb-fresh-btn")`)) === true;
  }
  check("Up arrow reaches the fresh start line among the chat's lines", reached);
  check("it is then the one Tab stop of those lines", (await ev(`$$(".app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked").filter((b) => b.tabIndex === 0).length === 1 && $(".pb-fresh-btn").tabIndex === 0`)) === true);
  check("it shows the focus ring", (await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`)) === true);
  await key("Enter");
  check("Enter opens it", !!(await until(`$(".pb-fresh-btn").getAttribute("aria-expanded") === "true"`)));
  await key("Enter");
  check("Enter closes it again, focus stays on it", !!(await until(`$(".pb-fresh-btn").getAttribute("aria-expanded") === "false" && document.activeElement === $(".pb-fresh-btn")`)));

  // ---------------- a compacted notice is an ordinary quiet notice line
  await goTo("Onboardings", "chat");
  const compacted = await until(`(() => { const n = $('.app-notice[data-mark="compacted"]'); return n && { text: n.querySelector("span").textContent, button: !!n.closest("button") || !!n.querySelector("button"), size: getComputedStyle(n).fontSize }; })()`);
  check("a compacted notice shows its text as a notice line", compacted?.text === "The session was nearly full, so it was shortened in the middle of this task" && !compacted.button, compacted);
  check("it has no fresh start line of its own", (await ev(`$$(".pb-fresh-wrap").length`)) === 0);

  // ---------------- Settings: the Working memory section
  await goTo("Kaja", "settings");
  await until(`!!${memory}`);
  const titles = await ev(`$$(".pb-settings .pb-section-title").map((t) => t.textContent)`);
  check("Working memory sits after Model and effort and before Always allowed", Array.isArray(titles) && titles.indexOf("Working memory") === titles.indexOf("Model and effort") + 1 && titles.indexOf("Working memory") < titles.indexOf("Always allowed"), titles);
  check("it says what it is in one sentence", (await ev(`${memory}.querySelector(".pb-section-text").textContent`)) === "Kaja keeps one chat with you for good. What Kaja can keep in mind at once is limited, so at calm moments Kaja writes down what matters and starts fresh. This shows how much is in mind now. At 100% Kaja starts fresh by itself.");
  check("its facts: how full, since when", (await ev(`${memory}.querySelector(".pb-memory-facts").textContent`)) === `About 38% full · Since ${dayAt(1, 17, 24)}`, await ev(`${memory}.querySelector(".pb-memory-facts").textContent`));
  check("while Kaja waits on a card the button is off, with the reason beside it", (await ev(`(() => { const s = ${memory}; const b = btn("Start fresh now", s); return b.getAttribute("aria-disabled") === "true" && s.querySelector(".pb-memory-act .pb-hint").textContent === "Kaja is waiting for you. Try again once that is answered." && b.getAttribute("aria-describedby") === s.querySelector(".pb-memory-act .pb-hint").id; })()`)) === true);
  await ev(`click(btn("Start fresh now", ${memory}))`);
  await sleep(150);
  check("and pressing it asks nothing", (await ev(`!$(".pb-dialog")`)) === true);
  check("no meter anywhere, and no share of the session outside Settings", (await ev(`$$('[role="meter"], [role="progressbar"], meter, progress').length === 0 && !$(".app-side").innerText.includes("%") && !$(".app-head").innerText.includes("%")`)) === true);
  await houseRules("settings with Working memory");
  await ev(`inPanel(${memory})`);
  await shot("settings-working-memory");
  await ev(`${memory}.querySelector("button").focus()`);
  await focusRings("settings from Working memory on", 8);
  await goTo("Inbox", "settings");
  await until(`!!${memory}`);
  check("a working bot: About 71% full, and the button off with Inbox is working", (await ev(`${memory}.querySelector(".pb-memory-facts").textContent === "About 71% full · Since ${dayAt(2, 9, 12)}" && btn("Start fresh now", ${memory}).getAttribute("aria-disabled") === "true" && ${memory}.querySelector(".pb-memory-act .pb-hint").textContent === "Inbox is working. Try again when it is done."`)) === true, await ev(`${memory}.innerText`));
  await goTo("HubSpot tickets", "settings");
  await until(`!!${memory}`);
  await ev(`inPanel(${memory})`);
  check("a bot without a session reads Not started yet", (await ev(`${memory}.querySelector(".pb-memory-facts").textContent`)) === "Not started yet");
  check("its button is on, with no hint", (await ev(`!btn("Start fresh now", ${memory}).hasAttribute("aria-disabled") && !${memory}.querySelector(".pb-memory-act .pb-hint")`)) === true);
  await ev(`btn("Start fresh now", ${memory}).focus()`);
  await key("Enter");
  check("Start fresh now asks first", !!(await until(`text(".pb-dialog-title") === "Start fresh now?"`)));
  check("the question's words", (await ev(`text(".pb-dialog-text")`)) === "HubSpot tickets first writes down what matters, then its next message starts in a fresh session. The chat stays as it is.");
  check("its buttons: Cancel and Start fresh", (await ev(`$$(".pb-dialog button").map((b) => b.textContent).join("|")`)) === "Cancel|Start fresh");
  await houseRules("start fresh confirm");
  await shot("settings-start-fresh-confirm");
  await ev(`click(btn("Cancel"))`);
  check("Cancel closes it and focus goes back to the button", !!(await until(`!$(".pb-dialog") && document.activeElement?.textContent === "Start fresh now"`)));
  const asked = (await ev(`window.pobotsMock.requests()["bot.startFresh"] ?? 0`)) ?? 0;
  await key("Enter");
  await until(`!!$(".pb-dialog")`);
  await ev(`click(btn("Start fresh"))`);
  check("with no session, There is nothing to tidy yet shows where Saved shows", !!(await until(`!$(".pb-dialog") && (() => { const w = ${memory}.querySelector(".pb-section-head .pb-saved"); return w.textContent === "There is nothing to tidy yet." && w.dataset.show === "true" && getComputedStyle(w).opacity === "1"; })()`)));
  check("the window asked the engine once (bot.startFresh)", ((await ev(`window.pobotsMock.requests()["bot.startFresh"]`)) ?? 0) === asked + 1);
  await shot("settings-nothing-to-tidy");

  // ---------------- a tidy turn, watched: the roster, the pending line, and nothing jumping
  await open("");
  await goTo("Onboardings", "settings");
  await until(`!!${memory}`);
  check("Onboardings: About 32% full", (await ev(`${memory}.querySelector(".pb-memory-facts").textContent`)) === `About 32% full · Since ${dayAt(3, 8, 0)}`);
  const rowShape = `(() => { const r = $$(".app-row").find((x) => x.querySelector(".pb-row-name").textContent === "Onboardings"); return [...r.querySelectorAll("*")].map((el) => el.tagName + "." + [...el.classList].filter((c) => !c.startsWith("pb-mark-")).join(".")).filter((s) => !s.includes("pb-eyes") && !s.startsWith("I.")).join(" "); })()`;
  const shapeIdle = await ev(rowShape);
  await ev(`window.pobotsMock.holdTidy(true)`);
  await ev(`btn("Start fresh now", ${memory}).focus()`);
  await key("Enter");
  await until(`!!$(".pb-dialog")`);
  await ev(`btn("Start fresh").focus()`);
  await key("Enter");
  check("Start fresh starts a tidy turn: the button goes off with Onboardings is writing down what matters", !!(await until(`!$(".pb-dialog") && btn("Start fresh now", ${memory}).getAttribute("aria-disabled") === "true" && ${memory}.querySelector(".pb-memory-act .pb-hint").textContent === "Onboardings is writing down what matters."`)));
  check("focus stays on the button", (await ev(`document.activeElement?.textContent`)) === "Start fresh now");
  check("the roster line reads what the engine sends", !!(await until(`${rowLine("Onboardings")} === "Writing down what matters"`)));
  check("and the row has no new mark or badge", (await ev(rowShape)) === shapeIdle, [shapeIdle, await ev(rowShape)]);
  check("no meter in the header", (await ev(`!$(".app-head").innerText.includes("%") && !$(".app-head [role=meter], .app-head progress")`)) === true);
  await shot("settings-tidying");
  await ev(`click($('.pb-tab[data-tab="chat"]'))`);
  check("the chat shows one quiet pending line in the tidy turn's place", !!(await until(`$(".pb-fresh")?.dataset.state === "pending" && text(".pb-fresh-pending") === "Writing down what matters"`)));
  const pend = await ev(`(() => {
    const p = $(".pb-fresh-pending"), face = p.querySelector(".pb-avatar");
    return { face: !!face && Math.round(face.getBoundingClientRect().width), status: p.getAttribute("role"), notMessage: !p.closest("article, .pb-msg"), answerLine: !!$(".pb-pending"), last: $$(".pb-thread > *").at(-1).classList.contains("pb-fresh-wrap") };
  })()`);
  check("it carries the bot's small face, as a status, not as a message", pend?.face === 18 && pend.status === "status" && pend.notMessage, pend);
  check("the bot does not look like it answers the person: no answer line", pend?.answerLine === false, pend);
  check("the tidy turn's request, steps and note stay hidden while it runs", !!(await until(`$$(".pb-thread > *").filter((el) => !el.classList.contains("pb-fresh-wrap")).every((el) => !el.innerText.includes("Note from Pobots") && !el.innerText.includes("memory/promises.md")) && !$(".pb-fresh-wrap").innerText.includes("Nordvik")`, 3000)));
  await houseRules("chat while tidying");
  await shot("chat-tidying");
  // The person is at the bottom of the chat. The line turns into "Started fresh": nothing may move.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(700);
  await startRecorder(0);
  await ev(`window.pobotsMock.holdTidy(false)`);
  check("the pending line becomes Started fresh with today's time", !!(await until(`$(".pb-fresh")?.dataset.state === "done" && /^Started fresh · \\d\\d:\\d\\d$/.test(text(".pb-fresh-btn"))`, 4000)));
  const flipA = steady(await stopRecorder(), Infinity);
  check("at the bottom of the chat: the line keeps its height and nothing above it moves, in every state between", flipA.ok, flipA);
  check("the roster line says it started fresh", !!(await until(`${rowLine("Onboardings")}.startsWith("Started fresh at ")`)));
  await ev(`click($(".pb-fresh-btn"))`);
  check("opened, the new line holds the new note and both steps", !!(await until(`$(".pb-fresh-note")?.innerText.includes("Nordvik imports on Thursday at 10:00.") && $$(".pb-fresh-steps .pb-activity").length === 2`)));
  check("the request and the note are still not drawn as messages", await tidyHidden(), await ev(outsideLine));
  await shot("chat-started-fresh-open");
  await ev(`click($('.pb-tab[data-tab="settings"]'))`);
  await until(`!!${memory}`);
  check("Settings now reads an empty session since now, and the button is on again", !!(await until(`/^Nothing in it yet · Since ${dayAt(0, 0, 0).split(" ").slice(0, 2).join(" ")} \\d\\d:\\d\\d$/.test(${memory}.querySelector(".pb-memory-facts").textContent) && !btn("Start fresh now", ${memory}).hasAttribute("aria-disabled")`)), await ev(`${memory}.querySelector(".pb-memory-facts").textContent`));
  await ev(`click(btn("Start fresh now", ${memory}))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click(btn("Start fresh"))`);
  check("a second time right after: nothing to tidy yet", !!(await until(`${memory}.querySelector(".pb-section-head .pb-saved").textContent === "There is nothing to tidy yet."`)));

  // ---------------- a tidy turn the engine begins while the person reads and types
  await open("");
  await goTo("Kaja", "chat");
  await until(`!!$(".pb-fresh-btn")`);
  const last = `$$(".pb-fresh").at(-1)`;
  const lastAt = `$$(".pb-thread > *").findLastIndex((k) => k.classList.contains("pb-fresh-wrap"))`;
  await ev(`window.pobotsMock.holdTidy(true)`);
  await ev(`window.pobotsMock.tidyEndsFirst(true)`);
  await ev(`(() => { const t = $(".pb-composer textarea"); t.focus(); return true; })()`);
  await type("Half a thought");
  // Scrolled up a little, reading.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 40); s.dispatchEvent(new Event("scroll")); return true; })()`);
  const view = `({ scroll: $(".app-main .pb-main-scroll").scrollTop, focus: document.activeElement === $(".pb-composer textarea"), value: $(".pb-composer textarea").value })`;
  const before2 = await ev(view);
  check("the engine's clock begins a tidy turn", (await ev(`window.pobotsMock.startFresh("kaja")`)) === true);
  check("its pending line arrives", !!(await until(`$$(".pb-fresh-wrap").length === 2 && ${last}.dataset.state === "pending"`)));
  const during = await ev(view);
  check("it does not scroll the chat or take the focus, and the typing is kept", during?.scroll === before2?.scroll && during.focus && during.value === "Half a thought", [before2, during]);
  await key("Enter");
  // Since step 7a a waiting message stands in the stack above the message box, not in the chat.
  check("a message sent meanwhile waits in the stack above the message box, not in the chat", !!(await until(`(() => { const kids = $$(".pb-thread > *"); return $$(".app-main .pb-queued").some((q) => q.innerText.includes("Half a thought")) && !kids.some((k) => k.innerText.includes("Half a thought")); })()`)));
  check("and the chat says it is queued", (await ev(`$$(".app-line").some((l) => l.textContent === "Queued, Kaja will read this next")`)) === true);
  check("still no answer line while the tidy turn runs", (await ev(`!$(".pb-pending")`)) === true);
  await sleep(700);
  // Reading a little higher up, so the line, the item above it and the queued message are all in view.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 60); s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(150);
  const reading = await ev(`(() => { const s = $(".app-main .pb-main-scroll"); return { top: s.scrollTop, fromBottom: s.scrollHeight - s.clientHeight - s.scrollTop }; })()`);
  check("the chat is long enough to be read scrolled up", reading?.top > 0 && reading.fromBottom > 32, reading);
  await startRecorder(1);
  // The engine says the tidying is over a moment before the notice comes: the line must hold.
  await ev(`window.pobotsMock.holdTidy(false)`);
  check("the line becomes Started fresh", !!(await until(`${last}.dataset.state === "done"`, 4000)));
  const flipB = steady(await stopRecorder(), Infinity);
  check("scrolled up, with a queued message below: the item above, the line and the message below stay put in every state between", flipB.ok, flipB);
  check("the line never vanished while the notice was on its way", !flipB.bad?.some?.((s) => s.state === "none") && (await ev(`window.__samples.every((s) => s.state !== "none")`)) === true);
  const after2 = await ev(view);
  check("nothing scrolled and the focus stayed in the message box", after2?.scroll === flipB.first?.scroll && after2.focus, [flipB.first?.scroll, after2]);
  check("the waiting message then runs in the fresh session, below the line", !!(await until(`(() => { const kids = $$(".pb-thread > *"); const at = ${lastAt}; return kids.slice(at + 1).some((k) => k.innerText.includes("Half a thought") && !k.innerText.includes("Queued")) && kids.slice(at + 1).some((k) => k.matches("article.pb-msg") && k.innerText.includes("Done. I looked through")); })()`, 8000)));
  await houseRules("chat after a fresh start with a message after it");
  await shot("chat-started-fresh-queued");

  // ---------------- a tidy turn that fails, and one that is stopped, leave nothing
  await open("");
  await goTo("Onboardings", "chat");
  await until(`$$(".pb-thread > *").length >= 3`);
  const itemsBefore = await ev(`$$(".pb-thread > *").length`);
  await ev(`window.pobotsMock.tidyFails(true)`);
  check("a tidy turn that will fail starts", (await ev(`window.pobotsMock.startFresh("onboardings")`)) === true && !!(await until(`$(".pb-fresh")?.dataset.state === "pending"`)));
  const threadNow = `({ items: $$(".pb-thread > *").length, before: ${itemsBefore}, kids: $$(".pb-thread > *").map((k) => k.className.slice(0, 24) + ":" + k.innerText.slice(0, 24)) })`;
  check("when it ends without a note the line goes and nothing is added", !!(await until(`!$(".pb-fresh-wrap") && $$(".pb-thread > *").length === ${itemsBefore}`, 7000)), await ev(threadNow));
  check("no trace of it in the chat", await tidyHidden());
  await ev(`window.pobotsMock.tidyFails(false)`);
  await ev(`window.pobotsMock.holdTidy(true)`);
  check("another starts", (await ev(`window.pobotsMock.startFresh("onboardings")`)) === true && !!(await until(`$(".pb-fresh")?.dataset.state === "pending"`)));
  await ev(`click($('button[aria-label="Stop Onboardings"]'))`);
  check("stopped with the stop button, it leaves nothing either", !!(await until(`!$(".pb-fresh-wrap") && $$(".pb-thread > *").length === ${itemsBefore}`, 7000)) && (await tidyHidden()), await ev(threadNow));
  await ev(`window.pobotsMock.holdTidy(false)`);
  await goTo("Onboardings", "settings");
  check("the session was kept: still About 32% full", (await ev(`${memory}.querySelector(".pb-memory-facts").textContent`)) === `About 32% full · Since ${dayAt(3, 8, 0)}`);

  // ---------------- the engine refuses while the bot started something meanwhile
  await ev(`click(btn("Start fresh now", ${memory}))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`window.pobotsMock.fire(window.pobotsMock.triggerIds("onboardings")[0])`);
  await until(`${rowLine("Onboardings")} !== "Stopped by you"`);
  await ev(`click(btn("Start fresh"))`);
  check("a refusal from the engine shows in the question, which stays open", !!(await until(`$(".pb-dialog [role=alert]")?.textContent === "Onboardings is in the middle of something. Try again when it is done."`)));
  await shot("settings-start-fresh-refused");
  await key("Escape");
  check("Escape closes it", !!(await until(`!$(".pb-dialog")`)));

  // ---------------- 1280 and 800 px, light and dark
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      const tag = `${theme}-${width}`;
      await open("", { width, theme });
      const fits = async (where) => {
        const o = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, panel: $(".app-main").scrollWidth - $(".app-main").clientWidth, view: $(".app-main .pb-main-scroll").scrollWidth - $(".app-main .pb-main-scroll").clientWidth })`);
        check(`${theme}, ${width} px, ${where}: nothing scrolls sideways`, o.page <= 0 && o.panel <= 1 && o.view <= 1, o);
      };
      await goTo("Kaja", "chat");
      await until(`!!$(".pb-fresh-btn")`);
      await ev(`inPanel($(".pb-fresh-wrap"))`);
      await fits("the fresh start line");
      const rules = await ev(`(() => { const l = $(".pb-fresh"); return [getComputedStyle(l, "::before").width, getComputedStyle(l, "::after").width].map(parseFloat); })()`);
      check(`${theme}, ${width} px: the rule shows on both sides of the words`, Array.isArray(rules) && rules.every((w) => w >= 20), rules);
      await shot(`${tag}-fresh-line`);
      await ev(`click($(".pb-fresh-btn"))`);
      await until(`!!$(".pb-fresh-body")`);
      await ev(`inPanel($(".pb-fresh-wrap"))`);
      await fits("the fresh start line open");
      const well = await ev(`(() => { const w = $(".pb-fresh-body").getBoundingClientRect(), t = $(".pb-thread").getBoundingClientRect(); return w.left >= t.left - 0.5 && w.right <= t.right + 0.5; })()`);
      check(`${theme}, ${width} px: the well stays inside the thread`, well === true);
      await shot(`${tag}-fresh-line-open`);
      await goTo("Onboardings", "settings");
      await until(`!!${memory}`);
      await ev(`inPanel(${memory})`);
      await fits("Working memory");
      await shot(`${tag}-settings-working-memory`);
      await ev(`window.pobotsMock.holdTidy(true)`);
      await ev(`window.pobotsMock.startFresh("onboardings")`);
      await until(`${memory}.querySelector(".pb-memory-act .pb-hint")?.textContent === "Onboardings is writing down what matters."`);
      await fits("Working memory while tidying");
      await shot(`${tag}-settings-tidying`);
      await ev(`click($('.pb-tab[data-tab="chat"]'))`);
      await until(`$(".pb-fresh")?.dataset.state === "pending"`);
      await fits("the pending line");
      await shot(`${tag}-chat-tidying`);
      await ev(`window.pobotsMock.holdTidy(false)`);
      await until(`$(".pb-fresh")?.dataset.state === "done"`, 4000);
      await shot(`${tag}-chat-started-fresh`);
      await goTo("Onboardings", "chat");
      await houseRules(`${theme}, ${width} px, chat after a fresh start`);
    }
  }
  for (const scale of [1.25, 1.5]) {
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: scale, mobile: false });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark` });
    await until(`!!$(".pb-shell")`);
    await goTo("Kaja", "chat");
    await until(`!!$(".pb-fresh-btn")`);
    const drawn = await ev(`[$(".pb-fresh"), $(".pb-fresh-btn")].flatMap((el) => [getComputedStyle(el), getComputedStyle(el, "::before"), getComputedStyle(el, "::after")]).filter((s) => ["Top", "Right", "Bottom", "Left"].some((side) => s["border" + side + "Style"] !== "none" && parseFloat(s["border" + side + "Width"]) > 0)).length`);
    check(`at ${scale * 100}% scaling the fresh start line is drawn without borders`, drawn === 0, drawn);
    await ev(`inPanel($(".pb-fresh-wrap"))`);
    await shot(`scale-${scale * 100}-fresh-line`);
  }
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  }
}
