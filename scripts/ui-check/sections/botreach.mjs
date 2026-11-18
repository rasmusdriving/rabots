// The window check, section "botreach". Run it alone: node scripts/ui-check.mjs --only=botreach
// Bots reach their helpers and each other (15 Nov 2026, docs/build/step-bot-reach.md): the "May
// steer" setting of a bot (a switch that saves; the main bot's section only says it always may), a
// message the main bot steered into another bot's running turn (from that bot, a quiet "Steered",
// where it went in), and a message a bot sent its helper while it worked. The stand-in engine seeds
// both messages with &botreach=1 (ui/engine/mock-botreach.ts).
import { check, ev, until, open, shot, goTo, houseRules, sleep } from "../lib.mjs";

const BOT_STEER = "Leave the HubSpot mails for now; the tickets bot has them.";
const HELPER_STEER = "Check Northwind first, the call is at 14:00.";

/** A bot's tab, on the phone too: back to Bots, the bot, then its page through "Page". */
async function openOn(name, tab) {
  const phone = await ev(`!!$(".app-shell")?.dataset.phoneScreen`);
  if (!phone) return goTo(name, tab);
  const rowsShown = `$$(".app-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(rowsShown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
  if (tab === "chat") return true;
  const tabShown = `!!$$('.pb-tab[data-tab="${tab}"]').find((t) => t.checkVisibility())`;
  if (!(await ev(tabShown))) await ev(`click($$(".app-phone-page").find((p) => p.checkVisibility()))`);
  await until(tabShown);
  await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
  return until(`$(".app-tabpanel")?.dataset.tab === "${tab}"`);
}

export default async function section() {
  const M = (name) => `botreach: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("botreach=1", { width, height, theme });

      // The setting: the main bot's words, another bot's switch, saved and back.
      await openOn("Kaja", "settings");
      const main = await until(`(() => { const s = $$(".app-main .pb-section").find((x) => x.querySelector(".pb-section-title")?.textContent === "May steer"); return s ? { text: s.textContent, sw: !!s.querySelector(".pb-switch") } : null; })()`);
      check(T("the main bot's section says it may steer every bot, with no switch"), !!main && main.text.includes("Kaja is the main bot, so it may steer every bot.") && main.sw === false, main);
      await openOn("Onboardings", "settings");
      const order = await until(`(() => { const t = $$(".app-main .pb-section-title").map((x) => x.textContent); return t.includes("May steer") ? t : null; })()`);
      check(T("May steer comes right after May message"), Array.isArray(order) && order.indexOf("May steer") === order.indexOf("May message") + 1, order);
      const before = await ev(`(() => { const s = $('.app-main [data-steer="onboardings"]'); const r = s?.closest(".pb-section").getBoundingClientRect(); return s ? { on: s.checked, label: s.getAttribute("aria-label"), h: r.height, wide: document.scrollingElement.scrollWidth - innerWidth } : null; })()`);
      check(T("its switch is off by default and named as a fact"), before?.on === false && before.label === "May steer other bots", before);
      check(T("the page never scrolls sideways"), !!before && before.wide <= 0, before?.wide);
      await ev(`click($('.app-main [data-steer="onboardings"]'))`);
      const saved = await until(`(() => { const s = $('.app-main [data-steer="onboardings"]'); const sec = s?.closest(".pb-section"); return s?.checked && sec?.textContent.includes("Saved") ? sec.getBoundingClientRect().height : null; })()`);
      check(T("switched on, it saves and says Saved"), typeof saved === "number", saved);
      check(T("the section keeps its height while it says Saved"), typeof saved === "number" && Math.abs(saved - before.h) < 1, { before: before?.h, saved });
      const bot = await ev(`window.pobotsState?.().bots.find((b) => b.id === "onboardings")?.maySteer ?? null`);
      check(T("the bot now may steer"), bot === true, bot);
      await ev(`$('.app-main [data-steer="onboardings"]')?.closest(".pb-section").scrollIntoView({ block: "center" })`);
      await shot(`botreach-setting-${theme}-${width}`);
      await sleep(50);
      await ev(`click($('.app-main [data-steer="onboardings"]'))`);
      const off = await until(`$('.app-main [data-steer="onboardings"]')?.checked === false || null`);
      check(T("and off again"), off === true);
      await houseRules(`botreach settings, ${theme}, ${width} px`);

      // Kaja's message, steered into Inbox's turn.
      await openOn("Inbox", "chat");
      const msg = await until(`(() => {
        const a = $$(".app-main article.pb-msg").find((x) => x.textContent.includes(${JSON.stringify(BOT_STEER)}));
        if (!a) return null;
        const steps = $$(".app-main *").filter((e) => e.children.length === 0 && e.textContent.trim() === "Reading the Teams messages");
        const before = (x, y) => !!x && !!y && !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          from: a.querySelector(".pb-msg-head b")?.textContent ?? "",
          verb: a.querySelector(".pb-msg-from")?.textContent ?? "",
          note: a.querySelector(".app-from-note")?.textContent ?? "",
          face: !!a.querySelector(".pb-face, svg"),
          beforeRunning: before(a, steps.at(-1)),
          wide: document.scrollingElement.scrollWidth - innerWidth,
        };
      })()`);
      check(T("the main bot's steer stands in Inbox's chat as from Kaja"), msg?.from === "Kaja" && msg.verb === "passed this on", msg);
      check(T("it says Steered, quietly"), msg?.note === "Steered", msg?.note);
      check(T("it stands where it went in, before the step still running"), msg?.beforeRunning === true, msg);
      check(T("the page never scrolls sideways in the chat"), !!msg && msg.wide <= 0, msg?.wide);
      await ev(`$$(".app-main article.pb-msg").find((x) => x.textContent.includes(${JSON.stringify(BOT_STEER)}))?.scrollIntoView({ block: "center" })`);
      await houseRules(`botreach chat, ${theme}, ${width} px`);
      await shot(`botreach-chat-${theme}-${width}`);

      // Onboardings' message to its helper while it worked.
      await openOn("Onboardings", "chat");
      const row = await until(`$$(".app-main .pb-helper").find((r) => r.textContent.includes("Check the open onboardings")) ? true : null`);
      check(T("the helper's row is in Onboardings' chat"), row === true);
      await ev(`click($$(".app-main .pb-helper").find((r) => r.textContent.includes("Check the open onboardings")))`);
      const task = await until(`(() => {
        const a = $$("article.pb-msg-task").find((x) => x.textContent.includes(${JSON.stringify(HELPER_STEER)}));
        const first = $$("article.pb-msg-task")[0];
        // A message is either cut with "Show all" under it, or shown in full: never cut silently (found on a phone, 15 Nov 2026).
        const hidden = $$("article.pb-msg-task").filter((x) => { const b = x.querySelector(".pb-task-body"); return b.scrollHeight > b.clientHeight + 1 && !x.querySelector(".pb-task-more"); }).length;
        return a ? { verb: a.querySelector(".pb-msg-from")?.textContent ?? "", firstVerb: first?.querySelector(".pb-msg-from")?.textContent ?? "", hidden, wide: document.scrollingElement.scrollWidth - innerWidth } : null;
      })()`);
      check(T("in the helper's thread the bot's message says it was sent while it worked"), task?.verb === "sent this while it worked", task);
      check(T("the task still says the bot asked the helper"), task?.firstVerb === "asked the helper", task);
      check(T("the page never scrolls sideways in the helper's thread"), !!task && task.wide <= 0, task?.wide);
      check(T("no message in the helper's thread is cut without Show all"), task?.hidden === 0, task?.hidden);
      await houseRules(`botreach helper, ${theme}, ${width} px`);
      await shot(`botreach-helper-${theme}-${width}`);
      // Back to the chat: the helper's back on a computer, the browser's back on a phone (an open helper is kept in the page's history).
      if (width < 1000) await ev(`(history.back(), true)`);
      else await ev(`click($(".pb-helper-back"))`);
      const closed = await until(`!$(".pb-helper-bar") && !$$("article.pb-msg-task").length || null`);
      check(T("back closes the helper's thread"), closed === true);
    }
  }
}
