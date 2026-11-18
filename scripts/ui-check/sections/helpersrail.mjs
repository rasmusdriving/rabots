// The window check, section "helpersrail". Run it alone: node scripts/ui-check.mjs --only=helpersrail
// Helpers at work (16 Nov 2026, docs/build/step-helpers-in-rail.md): every helper that works now,
// across the bots, in the rail just above "Your to-do" and on the phone's Needs you screen; a click
// opens its thread, also of another bot and of a fresh run; "N more" past three; rows leave when
// helpers end; nothing above it moves. The waiting line in the chat leads to the helpers it waits
// for. The stand-in engine seeds helpers with &atwork=1 (two) or &atwork=5 and has levers on
// window.pobotsAtWork (ui/engine/mock-atwork.ts).
import { check, ev, until, open, shot, goTo, houseRules, focusRings, sleep, fixClock } from "../lib.mjs";

const rows = `$$(".app-rail .pb-atwork-slot:not([data-leaving]) .pb-atwork-item").map((r) => ({
  id: r.dataset.helperId, bot: r.dataset.botId, name: r.querySelector(".pb-atwork-name").textContent, whose: r.querySelector(".pb-atwork-whose").textContent,
  face: !!r.querySelector(".pb-avatar"), provider: r.querySelector(".pb-atwork-mark")?.dataset.provider ?? null, when: r.querySelector(".pb-atwork-when").textContent,
  h: Math.round(r.getBoundingClientRect().height), marked: r.hasAttribute("data-marked") }))`;
const sectionNow = `(() => { const s = $(".app-rail .pb-atwork"); return s && { title: s.querySelector(".pb-atwork-title").firstChild.textContent, count: s.querySelector(".pb-atwork-count").textContent, more: s.querySelector(".pb-atwork-more")?.textContent ?? null, rows: ${rows} }; })()`;
const barTitle = `($(".app-main .pb-helper-bar-title")?.textContent ?? null)`;
const waitLine = `(() => { const l = $$(".app-main .pb-pending").at(-1); return l && { text: l.textContent, go: !!l.querySelector(".pb-pending-go"), h: Math.round(l.getBoundingClientRect().height) }; })()`;
const tops = (sel) => `$$("${sel}").map((e) => Math.round(e.getBoundingClientRect().top)).join(",")`;

/** Back to the bot's chat from a helper's thread. */
async function backToChat() {
  for (let i = 0; i < 4 && (await ev(`!!$(".app-main .pb-helper-back")`)); i++) {
    await ev(`click($(".app-main .pb-helper-back"))`);
    await sleep(200);
  }
}

export default async function section() {
  // The rail's "Later today" must have runs to come, which the mock's day has only before the evening:
  // the page's clock reads 10:00 for this section (fix 0.26.3), so it passes at any hour.
  const unfix = await fixClock(10, 0);
  try {
    await walk();
  } finally {
    await unfix();
  }
}

async function walk() {
  const M = (name) => `helpersrail: ${name}`;
  for (const theme of ["dark", "light"]) {
    const T = (n) => M(`${theme}: ${n}`);

    // No helper, no section.
    await open("", { theme });
    check(T("hidden while no helper works"), (await ev(`!$(".app-rail .pb-atwork")`)) === true);

    // Two helpers: Onboardings' in a fresh run (on GPT), Kaja's in its chat.
    await open("atwork=1&todos=1", { theme });
    const s = await until(`(() => { const s = ${sectionNow}; return s?.rows.length === 2 ? s : null; })()`);
    check(T("Helpers at work with its count"), s?.title === "Helpers at work" && s.count === "2" && s.more === null, s);
    check(T("oldest first: face, title, whose (and its run), provider mark, how long"),
      s?.rows[0].name === "Sort the overnight mails" && s.rows[0].whose === "Onboardings, in Morning work round" && s.rows[0].face && s.rows[0].provider === "codex" && s.rows[0].when === "12 min" &&
        s.rows[1].name === "Check the Nordvik import date" && s.rows[1].whose === "Kaja" && s.rows[1].provider === "claude" && s.rows[1].when === "4 min",
      s?.rows);
    const place = await ev(`(() => { const rail = $(".app-rail"); const a = $(".app-rail .pb-atwork"); const t = $(".app-rail .pb-todo"); const l = $(".app-rail .pb-later"); const r = rail.getBoundingClientRect(), ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect(), fr = $(".app-rail .pb-rail-foot").getBoundingClientRect();
      return { order: !!(l.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING), aboveTodo: ar.bottom <= tr.top + 1, inView: ar.top >= r.top && tr.bottom <= r.bottom + 1, footAtFoot: Math.abs(r.bottom - fr.bottom) <= 1, overflow: rail.scrollHeight > rail.clientHeight }; })()`);
    check(T("after Later today, just above Your to-do, in sight at the rail's foot while the cards overflow"), place?.order && place.aboveTodo && place.inView && place.footAtFoot && place.overflow, place);
    if (theme === "dark") await houseRules(T("the rail with helpers at work"));
    await ev(`$(".app-rail .pb-atwork")?.scrollIntoView({ block: "nearest" })`);
    await shot(`helpersrail-${theme}-rail`);

    // Nothing above it moves when a helper starts; the to-do under it keeps its place too.
    await sleep(600);
    const before = { cards: await ev(tops(".app-rail .pb-card")), later: await ev(tops(".app-rail .pb-later-item")), todo: await ev(tops(".app-rail .pb-todo"))};
    const third = await ev(`window.pobotsAtWork.start("hubspot-tickets", { title: "Read ticket 48213" })`);
    await until(`${rows}.length === 3`);
    await sleep(400);
    const after = { cards: await ev(tops(".app-rail .pb-card")), later: await ev(tops(".app-rail .pb-later-item")), todo: await ev(tops(".app-rail .pb-todo")), rows: await ev(rows) };
    check(T("a new helper comes at the end, and the cards, Later today and the to-do keep their place"), after.rows.at(-1).id === third && after.rows.at(-1).when === "now" && after.cards === before.cards && after.later === before.later && after.todo === before.todo, { before, after });

    // A click opens the helper's thread, going to its bot.
    await goTo("Kaja");
    await ev(`click($('.app-rail .pb-atwork-item[data-bot-id="onboardings"]'))`);
    const opened = await until(`$(".app-main")?.getAttribute("aria-label") === "Onboardings" && ${barTitle}`);
    check(T("a click opens the thread of another bot's helper, in a fresh run"), opened === "Sort the overnight mails", opened);
    await backToChat();

    // Kaja's waiting line: one helper, a click opens it.
    await goTo("Kaja");
    const one = await until(`(() => { const l = ${waitLine}; return l?.go ? l : null; })()`);
    check(T("the waiting line says it waits for a helper and leads to it, in one line"), one?.text === "Waiting for a helper" && one.h === 20, one);
    await ev(`click($(".app-main .pb-pending-go"))`);
    const oneOpened = await until(barTitle);
    check(T("one helper: the line opens its thread"), oneOpened === "Check the Nordvik import date", oneOpened);
    await backToChat();
    // Two in the chat: their rows are brought into view and marked.
    await ev(`window.pobotsAtWork.start("kaja", { title: "Find the Aalto report template", say: "Another helper looks for the template." })`);
    const two = await until(`(() => { const l = ${waitLine}; return l?.text === "Waiting for 2 helpers" ? l : null; })()`);
    check(T("two helpers: the line says how many"), !!two && two.go && two.h === 20, two);
    await ev(`click($(".app-main .pb-pending-go"))`);
    const marked = await until(`(() => { const m = $$(".app-main .pb-helper[data-marked]"); return m.length === 2 ? m.map((x) => x.querySelector(".pb-helper-title").textContent) : null; })()`, 1500);
    check(T("several in the chat: their rows are marked"), JSON.stringify(marked) === JSON.stringify(["Check the Nordvik import date", "Find the Aalto report template"]), marked);
    await shot(`helpersrail-${theme}-marked-chat`);
    const unmarked = await until(`$$(".app-main .pb-helper[data-marked]").length === 0`, 4000);
    check(T("the mark goes after a moment"), !!unmarked);
    // Waiting for his answer while helpers work: the line stays a plain line, it is not about the helpers.
    await ev(`window.pobotsAtWork.activity("kaja", "Waiting for your answer")`);
    const asks = await until(`(() => { const l = ${waitLine}; return l?.text === "Waiting for your answer" ? l : null; })()`);
    check(T("waiting for his answer, the line does not lead to the helpers"), !!asks && !asks.go && asks.h === 20, asks);
    await ev(`window.pobotsAtWork.activity("kaja", "Waiting for 2 helpers")`);

    // Onboardings: its helper in a fresh run and one started by that helper. The line names the run and marks the rail's rows.
    await goTo("Onboardings");
    const parent = await ev(`${rows}.find((r) => r.bot === "onboardings").id`);
    await ev(`window.pobotsAtWork.start("onboardings", { title: "Read the Nordvik thread", parent: ${JSON.stringify(parent)} })`);
    const inRun = await until(`(() => { const l = ${waitLine}; return l?.go && l.text.startsWith("Waiting for 2") ? l : null; })()`);
    check(T("the line names the fresh run all its helpers work for"), inRun?.text === "Waiting for 2 helpers in Morning work round", inRun);
    await ev(`click($(".app-main .pb-pending-go"))`);
    const railMarked = await until(`(() => { const m = ${rows}.filter((r) => r.marked); return m.length ? m.map((r) => r.name) : null; })()`, 1500);
    check(T("rows not in this chat: the rail's rows are marked"), JSON.stringify(railMarked) === JSON.stringify(["Sort the overnight mails", "Read the Nordvik thread"]), railMarked);
    await shot(`helpersrail-${theme}-marked-rail`);

    // More than three: three rows, then "N more"; it opens in place.
    const many = await until(`(() => { const s = ${sectionNow}; return s?.count === "5" ? s : null; })()`);
    const shown = await ev(`$$(".app-rail .pb-atwork-item").length`);
    check(T("past three rows, N more"), many?.more === "Show less" || (shown === 3 && many?.more === "2 more"), { more: many?.more, shown });
    if (many?.more === "2 more") {
      await ev(`click($(".app-rail .pb-atwork-more"))`);
      const all = await until(`$$(".app-rail .pb-atwork-item").length === 5 && $(".app-rail .pb-atwork-more").textContent`);
      check(T("N more shows the rest, then Show less"), all === "Show less", all);
    }
    if (theme === "dark") {
      await ev(`$(".app-rail .pb-atwork-item").focus()`);
      await focusRings(T("helpers at work"), 6);
    }

    // Helpers end: rows fold away; the section goes with the last one.
    const ids = (await ev(rows)).map((r) => r.id);
    await ev(`window.pobotsAtWork.end(${JSON.stringify(ids[0])})`);
    const fewer = await until(`(() => { const r = ${rows}; return r.length === ${ids.length - 1} ? r.map((x) => x.id) : null; })()`);
    check(T("a helper that ends leaves the list"), !!fewer && !fewer.includes(ids[0]), fewer);
    // The rest end at once, in a different order and in several updates (as on the test copy): the
    // rows that fold away keep the places they had.
    const slots = `$$(".app-rail .pb-atwork-slot .pb-atwork-item").map((r) => r.dataset.helperId)`;
    const order = (await ev(slots)).filter((id) => ids.slice(1).includes(id));
    await ev(`(() => { for (const id of ${JSON.stringify([...ids.slice(1)].reverse())}) window.pobotsAtWork.end(id); })()`);
    const folding = await ev(slots);
    check(T("rows that end together fold away where they stood"), JSON.stringify(folding.filter((id) => order.includes(id))) === JSON.stringify(order), { order, folding });
    const gone = await until(`!$(".app-rail .pb-atwork")`, 2000);
    check(T("the section goes when no helper works"), !!gone);
    const line = await until(`(() => { const l = ${waitLine}; return l ? l : "none"; })()`);
    check(T("the waiting line is no longer a button"), line === "none" || line.go === false, line);
  }

  // The phone: on the Needs you screen; a tap opens the helper on the bot's screen.
  for (const [width, height] of [
    [390, 844],
    [360, 780],
  ]) {
    for (const theme of ["dark", "light"]) {
      const P = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("atwork=5", { width, height, theme });
      await ev(`click($(".app-needs-row"))`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      const s = await until(`(() => { const s = ${sectionNow}; return s?.rows.length === 3 ? s : null; })()`);
      check(P("on the Needs you screen, three rows and N more"), s?.more === "2 more", s);
      const fit = await ev(`(() => { const r = $$(".app-rail .pb-atwork-item").map((x) => x.getBoundingClientRect()); const m = $(".app-rail .pb-atwork-more").getBoundingClientRect(); return { h: r.map((x) => x.height), rowsTall: r.every((x) => Math.round(x.height) >= 44), moreTall: Math.round(m.height) >= 44, inside: r.every((x) => x.left >= 0 && x.right <= innerWidth), wide: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(P("rows and N more are easy to tap and fit the width"), fit?.rowsTall && fit.moreTall && fit.inside && fit.wide <= 0, fit);
      await ev(`$(".app-rail .pb-atwork")?.scrollIntoView({ block: "nearest" })`);
      await shot(`helpersrail-${theme}-${width}-needs`);
      await ev(`click($('.app-rail .pb-atwork-item[data-bot-id="onboardings"]'))`);
      const opened = await until(`$(".app-shell").dataset.phoneScreen === "bot" && $(".app-main")?.getAttribute("aria-label") === "Onboardings" && ${barTitle}`);
      check(P("a tap opens the helper's thread on its bot's screen"), opened === "Sort the overnight mails", opened);
      await shot(`helpersrail-${theme}-${width}-thread`);
      // Back goes to the bot's chat, then to Needs you.
      await ev(`(history.back(), true)`);
      const chat = await until(`$(".app-shell").dataset.phoneScreen === "bot" && !$(".app-main .pb-helper-bar") && $(".app-main")?.getAttribute("aria-label")`);
      check(P("back goes to the bot's chat"), chat === "Onboardings", chat);
      // Onboardings waits on one helper in a fresh run: the line opens it.
      const l = await until(`(() => { const l = ${waitLine}; return l?.go ? l : null; })()`);
      check(P("its waiting line names the run"), l?.text === "Waiting for a helper in Morning work round", l);
      await ev(`(history.back(), true)`);
      const needs = await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      check(P("and back again to Needs you"), !!needs);
    }
  }
}
