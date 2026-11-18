// The window check, section "taskmanagers". Run it alone: node scripts/ui-check.mjs --only=taskmanagers
// Task managers (protocol 21, docs/build/step-task-managers.md): "Task managers" in the rail just above
// "Helpers at work" and on the phone's Needs you screen; a row opens its thread, with its settings, a
// message box, Stop and End task manager; its workers stand in its thread and read "<bot>, for <task>"
// in Helpers at work; its cards and to-dos say "<task>, for <bot>"; an ended one leaves the rail. The
// stand-in engine seeds two with &tm=1 and has levers on window.pobotsTaskManagers
// (ui/engine/mock-taskmanagers.ts).
import { check, ev, until, open, shot, goTo, houseRules, focusRings, sleep, type, key } from "../lib.mjs";

const rows = `$$(".app-rail .pb-tms .pb-atwork-slot:not([data-leaving]) .pb-tms-item").map((r) => ({
  id: r.dataset.managerId, bot: r.dataset.botId, state: r.dataset.state, name: r.querySelector(".pb-atwork-name").textContent, whose: r.querySelector(".pb-atwork-whose").textContent,
  face: !!r.querySelector(".pb-avatar"), when: r.querySelector(".pb-atwork-when").textContent, h: Math.round(r.getBoundingClientRect().height) }))`;
const sectionNow = `(() => { const s = $(".app-rail .pb-tms"); return s && { title: s.querySelector(".pb-atwork-title").firstChild.textContent, count: s.querySelector(".pb-atwork-count").textContent, rows: ${rows} }; })()`;
const pane = `(() => { const bar = $(".app-main .pb-helper-bar"); if (!bar) return null; return {
  title: bar.querySelector(".pb-helper-bar-title")?.textContent, state: bar.querySelector(".pb-tm-state")?.textContent ?? null, back: bar.querySelector(".pb-helper-back-name")?.textContent,
  settings: $$(".app-main .pb-tm-list > span:not(.pb-tm-model)").map((s) => s.textContent.replace(/^·/, "")), composer: !!$(".app-main .pb-tm-composer textarea"),
  stop: (() => { const b = btn("Stop", $(".app-main .pb-tm-foot") ?? document.createElement("div")); return b ? !b.hasAttribute("data-gone") : null; })(),
  end: !!btn("End task manager", $(".app-main") ?? document), note: $(".app-main .pb-helper-note")?.textContent ?? null,
  workers: $$(".app-main .pb-main-scroll .pb-helper").map((h) => h.querySelector(".pb-helper-title").textContent) }; })()`;

async function backToChat() {
  for (let i = 0; i < 4 && (await ev(`!!$(".app-main .pb-helper-back")`)); i++) {
    await ev(`click($(".app-main .pb-helper-back"))`);
    await sleep(200);
  }
}

export default async function section() {
  const M = (name) => `taskmanagers: ${name}`;
  for (const theme of ["dark", "light"]) {
    const T = (n) => M(`${theme}: ${n}`);

    await open("", { theme });
    check(T("hidden while there is no task manager"), (await ev(`!$(".app-rail .pb-tms")`)) === true);

    // Two: HubSpot tickets' resting, Kaja's with two workers and a question card.
    await open("tm=1&todos=1", { theme });
    const s = await until(`(() => { const s = ${sectionNow}; return s?.rows.length === 2 ? s : null; })()`);
    check(T("Task managers with its count"), s?.title === "Task managers" && s.count === "2", s);
    check(T("oldest first: face, title, whose and what it does, how long"),
      s?.rows[0].name === "Move the old tickets" && s.rows[0].whose === "HubSpot tickets, resting" && s.rows[0].face && s.rows[0].when === "1 h 10 min" &&
        s.rows[1].name === "Build the booking page" && s.rows[1].whose === "Kaja, waits for you" && s.rows[1].state === "waiting" && s.rows[1].when === "25 min",
      s?.rows);
    const place = await ev(`(() => { const t = $(".app-rail .pb-tms"), a = $(".app-rail .pb-atwork:not(.pb-tms)"), foot = $(".app-rail .pb-rail-foot"); if (!t || !a) return null;
      return { inFoot: foot.contains(t), above: t.getBoundingClientRect().bottom <= a.getBoundingClientRect().top + 1, order: !!(t.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
    check(T("in the rail's foot, just above Helpers at work"), place?.inFoot && place.above && place.order, place);
    const workers = await ev(`$$(".app-rail .pb-atwork:not(.pb-tms) .pb-atwork-item").map((r) => r.querySelector(".pb-atwork-name").textContent + " / " + r.querySelector(".pb-atwork-whose").textContent)`);
    check(T("its workers in Helpers at work read <bot>, for <task>"),
      JSON.stringify(workers) === JSON.stringify(["Draw the booking form / Kaja, for Build the booking page", "Write the booking API / Kaja, for Build the booking page"]), workers);
    const card = await ev(`(() => { const c = $$(".app-rail .pb-card").find((x) => x.querySelector(".pb-card-head-who")); return c && { who: c.querySelector(".pb-card-head-who").textContent, verb: c.querySelector(".pb-card-helper")?.textContent, face: !!c.querySelector(".pb-card-head .pb-avatar") }; })()`);
    check(T("its card says <task>, for <bot>, and what it asks under it"), card?.who === "Build the booking page, for Kaja" && card.verb === "Needs a choice" && card.face, card);
    if (theme === "dark") await houseRules(T("the rail with task managers"));
    await ev(`$(".app-rail .pb-tms")?.scrollIntoView({ block: "nearest" })`);
    await shot(`taskmanagers-${theme}-rail`);

    // A click opens its thread, going to its bot: head, settings, workers, message box, Stop, End.
    await goTo("Inbox");
    await ev(`click($('.app-rail .pb-tms-item[data-bot-id="kaja"]'))`);
    const p = await until(`$(".app-main")?.getAttribute("aria-label") === "Kaja" && (() => { const p = ${pane}; return p?.workers.length === 2 ? p : null; })()`);
    check(T("a click opens its thread on its bot, with its title and state"), p?.title === "Build the booking page" && p.state === "Waits for you" && p.back === "Kaja", p);
    check(T("the head shows its settings"),
      JSON.stringify(p?.settings) === JSON.stringify(["2 workers at once, 2 now", "Workers, Questions to you, Notes to you, Messages to bots, Pages", "May message Kaja, Onboardings"]), p?.settings);
    const names = await ev(`({ task: $(".app-main .pb-msg-task .pb-msg-from")?.textContent, said: $$(".app-main .pb-answer .pb-msg-head b").map((b) => b.textContent)[0] })`);
    check(T("in its thread: the bot asked the task manager, and it speaks as Task manager"), names?.task === "asked the task manager" && names.said === "Task manager", names);
    check(T("its workers stand in its thread"), JSON.stringify(p?.workers) === JSON.stringify(["Draw the booking form", "Write the booking API"]), p?.workers);
    check(T("a message box, Stop while it works, End task manager"), p?.composer && p.stop === true && p.end, p);
    if (theme === "dark") await houseRules(T("a task manager's thread"));
    await shot(`taskmanagers-${theme}-thread`);

    // The person writes to it: Enter sends; the message stands in its thread.
    await ev(`$(".app-main .pb-tm-composer textarea").focus()`);
    await type("Use the blue buttons from the design system.");
    await key("Enter");
    const sent = await until(`(() => { const s = window.pobotsTaskManagers.sent(); return s.length ? s : null; })()`);
    check(T("Enter sends the message to it"), sent?.at(-1)?.text === "Use the blue buttons from the design system." && (await ev(`$(".app-main .pb-tm-composer textarea").value`)) === "", sent);
    const inThread = await until(`$$(".app-main .pb-main-scroll .pb-msg-you").some((m) => m.textContent.includes("Use the blue buttons"))`);
    check(T("the message stands in its thread"), !!inThread);
    const answered = await until(`$$(".app-main .pb-main-scroll .pb-msg-body").some((m) => m.textContent.includes("Noted. I take that"))`, 3000);
    check(T("its answer comes in its thread"), !!answered);

    // Answering its card: it works again; the row says how many workers, in the same box.
    const h0 = (await ev(rows)).find((r) => r.bot === "kaja")?.h;
    await ev(`click(btn("Week view"))`);
    const working = await until(`(() => { const r = ${rows}.find((r) => r.bot === "kaja"); return r?.whose === "Kaja, 2 workers" ? r : null; })()`);
    check(T("after its card is answered: <bot>, 2 workers, and the row keeps its height"), !!working && working.h === h0, { working, h0 });
    const st = await until(`(() => { const p = ${pane}; return p?.state === "Working" ? p : null; })()`);
    check(T("its head says Working"), !!st, st);
    // A worker ends: the row and the settings say so; nothing jumps.
    const ids = await ev(`window.pobotsTaskManagers.list().find((t) => t.title === "Build the booking page").id`);
    const firstWorker = await ev(`$$(".app-main .pb-main-scroll .pb-helper")[0].dataset.helperId`);
    await ev(`window.pobotsTaskManagers.endWorker(${JSON.stringify(firstWorker)})`);
    const one = await until(`(() => { const r = ${rows}.find((r) => r.bot === "kaja"); return r?.whose === "Kaja, 1 worker" ? r : null; })()`);
    check(T("a worker ends: <bot>, 1 worker"), !!one && one.h === h0, one);
    const set1 = await until(`(() => { const p = ${pane}; return p?.settings[0] === "2 workers at once, 1 now" ? p : null; })()`);
    check(T("its settings say 1 now"), !!set1, set1?.settings);

    // A worker from Helpers at work opens inside its thread; back leads to the task manager. Its note
    // comes once its row in the task manager's thread has loaded, so wait for both.
    await ev(`click($(".app-rail .pb-atwork:not(.pb-tms) .pb-atwork-item"))`);
    const wk = await until(`(() => { const p = ${pane}; return p?.title === "Write the booking API" && p.note?.startsWith("This worker works for") ? p : null; })()`);
    check(T("a worker opens inside its task manager's thread, and says it works for it"), wk?.back === "Build the booking page" && wk.note === "This worker works for the task manager Build the booking page. Write to it to change what it does.", wk);
    await ev(`click($(".app-main .pb-helper-back"))`);
    const backTm = await until(`(() => { const p = ${pane}; return p?.title === "Build the booking page" ? p : null; })()`);
    check(T("back from the worker lands in the task manager's thread"), !!backTm?.composer, backTm);

    // Stop: it rests, its workers stop, Stop goes out of sight without the foot changing.
    const foot0 = await ev(`Math.round($(".app-main .pb-tm-foot").getBoundingClientRect().height)`);
    await ev(`click(btn("Stop", $(".app-main .pb-tm-foot")))`);
    await until(`!!$(".pb-dialog")`);
    await ev(`click(btn("Stop", $(".pb-dialog")))`);
    const rested = await until(`(() => { const p = ${pane}; return p?.state === "Resting" && p.stop === false ? p : null; })()`);
    check(T("Stop: it rests and Stop goes out of sight"), !!rested, rested);
    const stopped = await ev(`({ notice: $$(".app-main .pb-main-scroll .app-notice").some((n) => n.textContent.includes("Stopped.")), words: $$(".app-main .pb-main-scroll .pb-helper .pb-helper-word").map((w) => w.textContent), foot: Math.round($(".app-main .pb-tm-foot").getBoundingClientRect().height) })`);
    check(T("its workers stopped, a notice says so, the foot keeps its height"), stopped.notice && stopped.words.includes("Stopped") && stopped.foot === foot0, { stopped, foot0 });
    const restRow = await until(`(() => { const r = ${rows}.find((r) => r.bot === "kaja"); return r?.whose === "Kaja, resting" ? r : null; })()`);
    check(T("the rail says resting"), !!restRow);

    // Its row in the bot's chat says its state.
    await backToChat();
    // Once it rests, its turn is over and folds like a finished helper's: the fold opens to it.
    const chatRow = await until(`(() => { const r = $(".app-main .pb-helper[data-task-manager]"); if (!r) $$('.app-main .pb-worked[aria-expanded="false"], .app-main .pb-fold[aria-expanded="false"]').at(-1)?.click(); return r && { word: r.querySelector(".pb-helper-word").textContent, label: r.getAttribute("aria-label") }; })()`);
    check(T("its row in the bot's chat says Resting and that it is a task manager"), chatRow?.word === "Resting" && chatRow.label.includes("Task manager"), chatRow);
    if (theme === "dark") {
      await ev(`$(".app-rail .pb-tms-item").focus()`);
      await focusRings(T("task managers"), 6);
    }

    // End: from its thread. It leaves the rail; its thread says it ended; its chat row says Ended.
    await ev(`click($('.app-rail .pb-tms-item[data-bot-id="kaja"]'))`);
    await until(`(() => { const p = ${pane}; return p?.title === "Build the booking page" && p.end ? p : null; })()`);
    await ev(`click(btn("End task manager", $(".app-main")))`);
    await until(`!!$(".pb-dialog")`);
    await ev(`click(btn("End task manager", $(".pb-dialog")))`);
    const ended = await until(`(() => { const p = ${pane}; return p?.state === "Ended" ? p : null; })()`);
    check(T("ended: its thread says so, no message box, no buttons"), !!ended && !ended.composer && !ended.end && ended.note?.startsWith("This task manager has ended"), ended);
    const left = await until(`(() => { const s = ${sectionNow}; return s?.rows.length === 1 ? s : null; })()`, 2000);
    check(T("it leaves the rail"), left?.count === "1" && left.rows[0].name === "Move the old tickets", left);
    await backToChat();
    const endedRow = await until(`(() => { const r = $(".app-main .pb-helper[data-task-manager] .pb-helper-word"); if (!r) $$('.app-main .pb-worked[aria-expanded="false"], .app-main .pb-fold[aria-expanded="false"]').at(-1)?.click(); return r?.textContent === "Ended"; })()`);
    check(T("its row in the chat says Ended"), !!endedRow);
    check(T("no notice of it left in the rail's cards"), (await ev(`!$$(".app-rail .pb-card-head-who").length`)) === true);

    // A to-do from a task manager says <task>, for <bot>.
    const other = await ev(`window.pobotsTaskManagers.list()[0].id`);
    const todoId = await ev(`window.pobotsTaskManagers.todo(${JSON.stringify(other)}, "Check the moved tickets")`);
    await until(`!!$('.pb-todo-item[data-todo-id="${todoId}"]')`);
    const todoLabel = await ev(`$('.pb-todo-item[data-todo-id="${todoId}"]').getAttribute("aria-label")`);
    check(T("its to-do's row names it"), typeof todoLabel === "string" && todoLabel.startsWith("Check the moved tickets, from Move the old tickets, for HubSpot tickets"), todoLabel);
    await ev(`click($('.pb-todo-item[data-todo-id="${todoId}"]'))`);
    const from = await until(`$(".pb-todo-from-tm")?.textContent`);
    check(T("its to-do's window says <task>, for <bot>"), from === "Move the old tickets, for HubSpot tickets", from);
    await shot(`taskmanagers-${theme}-todo`);
    await key("Escape");

    // Its approval card offers Always allow, as its bot's own does; that saves the rule to its bot (fix 0.26.1).
    const apId = await ev(`window.pobotsTaskManagers.approve(${JSON.stringify(other)}, "Run npm test?", "npm test")`);
    const ap = await until(`(() => { const c = $$(".app-rail .pb-card").find((x) => x.querySelector(".pb-card-head-who") && $$("button", x).some((b) => b.textContent.trim() === "Always allow")); return c && { who: c.querySelector(".pb-card-head-who").textContent, buttons: $$("button", c).map((b) => b.textContent.trim()).filter(Boolean) }; })()`);
    check(T("its approval card says <task>, for <bot>, and offers Always allow"), ap?.who === "Move the old tickets, for HubSpot tickets" && ap.buttons.includes("Allow once") && ap.buttons.includes("Always allow"), ap);
    await shot(`taskmanagers-${theme}-always`);
    await ev(`click(btn("Always allow", $$(".app-rail .pb-card").find((x) => x.querySelector(".pb-card-head-who"))))`);
    const goneCard = await until(`!$$(".app-rail .pb-card-head-who").length`, 2000);
    check(T("Always allow takes the card away"), !!goneCard && typeof apId === "string");

    // Its bot ends the last one: the section goes.
    await ev(`window.pobotsTaskManagers.end(${JSON.stringify(other)})`);
    const gone = await until(`!$(".app-rail .pb-tms")`, 2000);
    check(T("the section goes with the last one"), !!gone);
    void ids;
  }

  // The phone: on the Needs you screen; a tap opens its thread on its bot's screen.
  for (const [width, height] of [
    [390, 844],
    [360, 780],
  ]) {
    for (const theme of ["dark", "light"]) {
      const P = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("tm=1", { width, height, theme });
      await ev(`click($(".app-needs-row"))`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      const s = await until(`(() => { const s = ${sectionNow}; return s?.rows.length === 2 ? s : null; })()`);
      check(P("on the Needs you screen"), s?.title === "Task managers", s);
      const fit = await ev(`(() => { const r = $$(".app-rail .pb-tms-item").map((x) => x.getBoundingClientRect()); return { tall: r.every((x) => Math.round(x.height) >= 44), inside: r.every((x) => x.left >= 0 && x.right <= innerWidth), wide: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(P("rows are easy to tap and fit the width"), fit?.tall && fit.inside && fit.wide <= 0, fit);
      await ev(`$(".app-rail .pb-tms")?.scrollIntoView({ block: "nearest" })`);
      await shot(`taskmanagers-${theme}-${width}-needs`);
      await ev(`click($('.app-rail .pb-tms-item[data-bot-id="kaja"]'))`);
      const p = await until(`$(".app-shell").dataset.phoneScreen === "bot" && (() => { const p = ${pane}; return p?.title === "Build the booking page" && p.composer ? p : null; })()`);
      check(P("a tap opens its thread on its bot's screen, with the message box"), !!p, p);
      const fits = await ev(`(() => { const f = $(".app-main .pb-tm-foot"); const bs = $$("button", f).filter((b) => !b.hasAttribute("data-gone")).map((b) => b.getBoundingClientRect()); const c = $(".app-main .pb-tm-composer").getBoundingClientRect(); const set = $(".app-main .pb-tm-clip").getBoundingClientRect();
        return { tall: bs.every((x) => Math.round(x.height) >= 44), inside: [...bs, c, set].every((x) => x.left >= 0 && x.right <= innerWidth + 0.5), wide: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(P("its settings, message box and buttons fit and are easy to tap"), fits?.tall && fits.inside && fits.wide <= 0, fits);
      const model = await ev(`(() => { const vis = (e) => !!e && getComputedStyle(e).display !== "none"; const t = $(".app-main .pb-helper-bar-title"); return { inHead: vis($(".app-main .pb-tm-bar-model")), inSettings: vis($(".app-main .pb-tm-list > .pb-tm-model")) && $(".app-main .pb-tm-model").textContent, titleWhole: t.scrollWidth <= t.clientWidth }; })()`);
      // At 390 px the mock's title is whole; at 360 px a long title may still lose a few letters to the state word.
      check(P("the model stands first in the settings line, not in the head, so the title has room"), model && !model.inHead && !!model.inSettings && (width < 390 || model.titleWhole), model);
      await shot(`taskmanagers-${theme}-${width}-thread`);
      await ev(`(history.back(), true)`);
      const chat = await until(`$(".app-shell").dataset.phoneScreen === "bot" && !$(".app-main .pb-helper-bar") && $(".app-main")?.getAttribute("aria-label")`);
      check(P("back goes to the bot's chat"), chat === "Kaja", chat);
      await ev(`(history.back(), true)`);
      const needs = await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      check(P("and back again to Needs you"), !!needs);
    }
  }
}
