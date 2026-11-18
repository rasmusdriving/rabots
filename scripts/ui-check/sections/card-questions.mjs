// The window check, section "card-questions". Run it alone: node scripts/ui-check.mjs --only=card-questions
// Protocol 23 (docs/build/step-card-follow-ups.md): the person asks a bot about a question card or a
// to-do before he acts. The box stands at the foot, under the card's own buttons, which never move;
// Enter sends, Shift+Enter makes a new line; a waiting line keeps one line's height; the answer lands
// in the card; a second question keeps the order; the card stays open. Not on approvals or notes.
// The chat marks his message "Question on your card". Laptop and both phone sizes, dark and light.
// The stand-in engine's part: ui/engine/mock-cardquestions.ts (window.pobotsCardQuestions).
import { check, ev, until, open, key, type, shot, goTo, houseRules, sleep } from "../lib.mjs";

const CARD = "Kickoff date for the new onboarding";
const TODO = "todo_mocknordvik00001";
const card = `$$(".app-rail .pb-card").find((c) => c.querySelector(".pb-card-title")?.textContent.startsWith("Kickoff date"))`;
const box = (root) => `(${root})?.querySelector(".pb-cq-input")`;
const thread = (root) => `[...((${root})?.querySelectorAll(".pb-cq-item") ?? [])].map((i) => ({ q: i.querySelector(".pb-cq-question")?.textContent, a: i.querySelector(".pb-cq-answer")?.textContent ?? null, wait: i.querySelector(".pb-cq-wait")?.textContent ?? null, waitH: Math.round(i.querySelector(".pb-cq-wait")?.getBoundingClientRect().height ?? 0) }))`;

/** Types into the box of `root` and presses Enter (the box takes the focus first, as a tap does). */
async function ask(root, text) {
  await ev(`(() => { const t = ${box(root)}; t.focus(); t.select(); return true; })()`);
  await type(text);
  await key("Enter");
}

/** Needs you in sight with its cards: on the phone its screen is opened; on the laptop the rail is
 * waited for. On a busy Mac (the full check runs sections side by side) the page can take a while. */
async function toNeeds() {
  if (!(await until(`!!$(".app-rail .pb-card")`, 15_000))) return false;
  if (!(await ev(`!!$(".app-shell")?.dataset.phoneScreen`))) return true;
  await ev(`click($(".app-needs-row"))`);
  return until(`$(".app-shell").dataset.phoneScreen === "needs"`, 8000);
}

export default async function section() {
  const M = (name) => `card-questions: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      const laptop = width === 1280;
      // The page before is cleared first, so nothing below runs on it while the new one loads.
      await ev(`(document.body.replaceChildren(), true)`);
      await open("todos=1", { width, height, theme });
      check(T("Needs you is on screen"), !!(await toNeeds()));
      await sleep(600);

      // ---------------- a question card
      const start = await until(`(() => { const c = ${card}; if (!c) return null; const r = c.getBoundingClientRect();
        return { top: Math.round(r.top), btns: [...c.querySelectorAll(".pb-card-actions .pb-btn")].map((b) => Math.round(b.getBoundingClientRect().top - r.top)),
          placeholder: ${box("c")}?.placeholder, ask: c.querySelector(".pb-cq-form .pb-btn")?.textContent, under: c.querySelector(".pb-cq").getBoundingClientRect().top >= c.querySelector(".pb-card-actions").getBoundingClientRect().bottom,
          others: $$(".app-rail .pb-card").filter((x) => x !== c && x.querySelector(".pb-cq")).length, inputH: Math.round(${box("c")}.getBoundingClientRect().height) }; })()`, 10_000);
      check(T("the question card has the box at its foot, under its buttons: Ask about this before you act, Ask"), start?.placeholder === "Ask about this before you act" && start.ask === "Ask" && start.under, start);
      check(T("approvals and notes have no box"), start?.others === 0, start);
      check(T("the box is a finger's height on the phone, one line on the laptop"), laptop ? start?.inputH === 32 : start?.inputH === 44, start);

      // Refused (the card closed meanwhile): the words he typed come back in the box, with the reason.
      await ev(`window.pobotsCardQuestions.refuseNext("That card is no longer open.")`);
      await ask(card, "Is the room booked?");
      const refused = await until(`(() => { const c = ${card}; const e = c?.querySelector(".pb-cq-error"); return e ? { reason: e.textContent, value: ${box("c")}.value, n: ${thread("c")}.length } : null; })()`);
      check(T("a refused question comes back in the box, with the reason under it"), refused?.reason === "That card is no longer open." && refused.value === "Is the room booked?" && refused.n === 0, refused);

      await ev(`window.pobotsCardQuestions.hold(true)`);
      await ask(card, "Is Thursday better for the customer?");
      const waiting = await until(`(() => { const c = ${card}; const t = ${thread("c")}; return t.length === 1 && t[0].wait ? { t, value: ${box("c")}.value, off: c.querySelector(".pb-cq-form .pb-btn").disabled } : null; })()`);
      check(T("Enter sends: his question stands in the card with the waiting line, and the box is empty"), waiting?.t[0].q === "Is Thursday better for the customer?" && waiting.t[0].wait === "Onboardings is answering" && waiting.value === "", waiting);
      check(T("the waiting line keeps one line's height, and Ask waits for the answer"), waiting?.t[0].waitH === 20 && waiting.off === true, waiting);
      const kept = await ev(`(() => { const c = ${card}; const r = c.getBoundingClientRect(); return { top: Math.round(r.top), btns: [...c.querySelectorAll(".pb-card-actions .pb-btn")].map((b) => Math.round(b.getBoundingClientRect().top - r.top)) }; })()`);
      check(T("the card and its own buttons keep their place"), kept?.top === start?.top && JSON.stringify(kept?.btns) === JSON.stringify(start?.btns), { start, kept });
      await shot(`card-questions-${theme}-${width}-card-waiting`);

      // Shift+Enter makes a new line and sends nothing.
      await ev(`(() => { const t = ${box(card)}; t.focus(); t.select(); return true; })()`);
      await type("Who else");
      await key("Enter", 8);
      await type("attends?");
      const shift = await ev(`({ value: ${box(card)}.value, n: ${thread(card)}.length, h: Math.round(${box(card)}.getBoundingClientRect().height) })`);
      check(T("Shift+Enter makes a new line in the box, which keeps its height, and sends nothing"), shift?.value === "Who else\nattends?" && shift.n === 1 && shift.h === start?.inputH, shift);

      await ev(`window.pobotsCardQuestions.hold(false)`);
      const answered = await until(`(() => { const t = ${thread(card)}; return t[0]?.a ? t : null; })()`, 6000);
      check(T("the answer lands in the card under his question"), /^Good question\./.test(answered?.[0].a ?? "") && answered[0].wait === null, answered);
      await key("Enter");
      const two = await until(`(() => { const t = ${thread(card)}; return t.length === 2 && t[1].a ? t : null; })()`, 6000);
      check(T("a second question is answered too, in order"), two?.[0].q === "Is Thursday better for the customer?" && two[1].q === "Who else\nattends?", two);
      const after = await ev(`(() => { const c = ${card}; const r = c.getBoundingClientRect(); return { top: Math.round(r.top), btns: [...c.querySelectorAll(".pb-card-actions .pb-btn")].map((b) => Math.round(b.getBoundingClientRect().top - r.top)), wide: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(T("the card's own buttons still have not moved, and nothing is wider than the screen"), after?.top === start?.top && JSON.stringify(after?.btns) === JSON.stringify(start?.btns) && after.wide <= 0, { start, after });

      // The bot asks again: the new words take the card's place, the thread stays.
      await ev(`window.pobotsCardQuestions.reask("c2", "Kickoff date, now that you know the customer's week")`);
      const re = await until(`(() => { const c = ${card}; return c && c.querySelector(".pb-card-title").textContent !== ${JSON.stringify(CARD)} ? { title: c.querySelector(".pb-card-title").textContent, n: ${thread("c")}.length, top: Math.round(c.getBoundingClientRect().top), cards: $$(".app-rail .pb-card").length } : null; })()`);
      check(T("when the bot asks again, the new words stand in the same card, at the same place, with the thread"), re?.title === "Kickoff date, now that you know the customer's week" && re.n === 2 && re.top === start?.top, { re, start });
      await shot(`card-questions-${theme}-${width}-card-answered`);
      if (laptop) await houseRules(T("the rail with a card's questions"));

      // ---------------- a to-do
      await ev(`(() => { const r = $('.app-rail .pb-todo-item[data-todo-id="${TODO}"]'); r.scrollIntoView({ block: "center" }); r.focus(); return click(r); })()`);
      const dlg = `$(".pb-dialog")`;
      const win = await until(`(() => { const d = ${dlg}; if (!d || !d.querySelector(".pb-cq")) return null; const acts = d.querySelector(".pb-todo-actions").getBoundingClientRect(); const cq = d.querySelector(".pb-cq").getBoundingClientRect();
        return { top: Math.round(d.getBoundingClientRect().top), acts: Math.round(acts.top), under: cq.top >= acts.bottom, bot: d.querySelector(".pb-todo-from b")?.textContent, placeholder: ${box("d")}?.placeholder, inputH: Math.round(${box("d")}.getBoundingClientRect().height), askH: Math.round(d.querySelector(".pb-cq-form .pb-btn").getBoundingClientRect().height) }; })()`);
      check(T("the to-do window has the box at its foot, under its buttons"), win?.under === true && win.placeholder === "Ask about this before you act", win);
      check(T("in the to-do window the box and Ask are a finger's height on the phone, 36 px on the laptop"), laptop ? win?.inputH === 36 && win.askH === 36 : win?.inputH === 44 && win.askH === 44, win);
      await sleep(400);
      const win0 = await ev(`(() => { const d = ${dlg}; return { top: Math.round(d.getBoundingClientRect().top), acts: Math.round(d.querySelector(".pb-todo-actions").getBoundingClientRect().top) }; })()`);
      await ev(`window.pobotsCardQuestions.hold(true)`);
      await ask(dlg, "Which board is the usual one?");
      const tw = await until(`(() => { const t = ${thread(dlg)}; return t.length === 1 && t[0].wait ? t : null; })()`);
      check(T("the question stands in the to-do with the waiting line in the bot's name"), tw?.[0].q === "Which board is the usual one?" && tw[0].wait === `${win?.bot} is answering` && tw[0].waitH === 20, { tw, bot: win?.bot });
      await ev(`window.pobotsCardQuestions.hold(false)`);
      const ta = await until(`(() => { const t = ${thread(dlg)}; return t[0]?.a ? t : null; })()`, 6000);
      check(T("the answer lands in the to-do"), !!ta?.[0].a, ta);
      await sleep(300);
      const win1 = await ev(`(() => { const d = ${dlg}; return { top: Math.round(d.getBoundingClientRect().top), acts: Math.round(d.querySelector(".pb-todo-actions").getBoundingClientRect().top), scrollTop: Math.round(d.scrollTop) }; })()`);
      check(T("the window keeps its top and its buttons keep their place while the thread grows"), win1?.top === win0?.top && (win1.acts === win0?.acts || win1.scrollTop > 0), { win0, win1 });
      await shot(`card-questions-${theme}-${width}-todo-answered`);
      if (laptop) await houseRules(T("the to-do window with a question"));

      // Closed and opened again: the thread is still there; the to-do is still open.
      await key("Escape");
      await until(`!${dlg}`);
      await ev(`(() => { const r = $('.app-rail .pb-todo-item[data-todo-id="${TODO}"]'); r.focus(); return click(r); })()`);
      const again = await until(`(() => { const t = ${thread(dlg)}; return t.length ? t : null; })()`);
      check(T("opened again, the to-do still has its question and answer"), again?.[0].q === "Which board is the usual one?" && !!again[0].a, again);
      await key("Escape");
      await until(`!${dlg}`);

      // His message in the chat says it is a question on the card.
      if (laptop) {
        await goTo("Onboardings", "chat");
        const note = await until(`$$(".app-main .app-you .pb-from-card").map((n) => n.textContent).find((t) => t.startsWith("Question on your card")) ?? null`);
        check(T("in the chat his message says Question on your card and its title"), note === `Question on your card: ${CARD}`, note);
        // His question went into the bot's waiting ask_human: when the turn has ended and its work
        // folds, the bot's answer to him stays in sight under his question, with the turn's last words.
        await ev(`window.pobotsCardQuestions.askedTurn("Onboardings")`);
        const folded = await until(`(() => { const a = $$(".app-main .pb-answer[data-folded]").at(-1); if (!a) return null;
          const shown = [...a.querySelectorAll(".pb-answer-flow > .pb-msg-body")].map((e) => e.textContent.trim());
          const q = $$(".app-main .app-you").at(-1);
          return { worked: !!a.querySelector(".pb-worked"), shown, steered: q?.dataset.steered === "true", mark: q?.querySelector(".pb-from-card")?.textContent, above: q ? q.getBoundingClientRect().bottom <= a.getBoundingClientRect().top + 1 : false }; })()`, 6000);
        check(T("a turn his card question went into folds its work, but the answer to him stays in sight under his question"), folded?.worked && JSON.stringify(folded.shown) === JSON.stringify(["No, Thursday suits them: their week starts on Wednesday.", "Thursday it is. I have put it in the plan."]) && folded.steered && folded.mark === "Question on your card: Which day for the kickoff?" && folded.above, folded);
        await shot(`card-questions-${theme}-chat-folded-answer`);
      }
    }
  }
}
