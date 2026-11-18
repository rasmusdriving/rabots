// The window check, section "cards-after-restart". Run it alone: node scripts/ui-check.mjs --only=cards-after-restart
// Engine 0.29.0 (protocol 22, docs/build/step-cards-after-restart.md): open cards come back after a
// restart, and his answer to one reaches the bot as his own message, marked "From your card: <title>"
// quietly above the bubble, as an answer to a to-do is. While the bot works it waits in the stack
// above the message box with the same words, and it cannot be taken back. The stand-in engine seeds
// one answered card with &cardanswer=1 (ui/engine/mock-cardanswer.ts).
import { check, ev, until, open, shot, goTo, houseRules, sleep } from "../lib.mjs";

const TITLE = "Which customer should I start with?";

async function openChat(name) {
  const phone = await ev(`!!$(".app-shell")?.dataset.phoneScreen`);
  if (!phone) return goTo(name, "chat");
  const shown = `$$(".app-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(shown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
  return until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
}

export default async function section() {
  const M = (name) => `cards-after-restart: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("cardanswer=1", { width, height, theme });
      check(T("Kaja's chat opens"), !!(await openChat("Kaja")));
      const msg = await until(`(() => { const y = $$(".app-main .app-you").find((x) => x.querySelector(".pb-from-card")); if (!y) return null;
        const note = y.querySelector(".pb-from-card"), bubble = y.querySelector(".pb-msg-you");
        const n = note.getBoundingClientRect(), bb = bubble.getBoundingClientRect(), main = $(".app-main").getBoundingClientRect();
        return { note: note.textContent, text: bubble.textContent, above: n.bottom <= bb.top + 1, right: Math.abs(n.right - bb.right) <= 2, inside: n.left >= main.left && n.right <= main.right,
          oneLine: Math.round(n.height) <= Math.round(parseFloat(getComputedStyle(note).lineHeight)) + 2, todoLook: note.classList.contains("pb-from-todo"),
          wide: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(T("his answer to a card that came back says so above the bubble: From your card and its question"), msg?.note === `From your card: ${TITLE}` && msg.text === "Nordvik", msg);
      check(T("the line stands above the bubble, on its right edge, in one line, as From your to-do does"), msg?.above && msg.right && msg.oneLine && msg.todoLook && msg.inside, msg);
      check(T("nothing wider than the screen"), msg?.wide <= 0, msg?.wide);
      await shot(`cards-after-restart-${theme}-${width}`);
      if (width === 1280) await houseRules(T("the chat"));

      // While the bot works, a second answer waits in the stack, named the same way, and cannot be taken back.
      if (width !== 360) {
        await ev(`window.pobotsMock.holdTurns(true)`);
        await ev(`window.pobotsCardAnswer.answer("kaja", "Shall I send the summary today?", "Yes, today")`);
        await sleep(300);
        await ev(`window.pobotsCardAnswer.answer("kaja", "Which day suits for the call?", "Thursday")`);
        const row = await until(`(() => { const q = $$(".app-main .pb-queue .pb-queued").find((r) => r.querySelector(".pb-queued-text")?.textContent === "Thursday"); return q && { from: q.querySelector(".pb-queued-from")?.textContent, remove: !!q.querySelector(".pb-queued-remove"), steer: !!q.querySelector(".app-you-steer"), kind: q.dataset.from }; })()`);
        check(T("a waiting answer stands in the stack with From your card and its question"), row?.from === "From your card: Which day suits for the call?" && row.kind === "you", row);
        check(T("it has no Remove: an answer to a card cannot be taken back"), row && row.remove === false, row);
        await shot(`cards-after-restart-${theme}-${width}-waiting`);
        await ev(`window.pobotsMock.holdTurns(false)`);
        const inChat = await until(`$$(".app-main .pb-thread .app-you").some((y) => y.querySelector(".pb-from-card")?.textContent === "From your card: Which day suits for the call?" && y.querySelector(".pb-msg-you")?.textContent === "Thursday")`, 8000);
        check(T("once read it stands in the chat with the same line"), !!inChat);
      }
    }
  }
}
