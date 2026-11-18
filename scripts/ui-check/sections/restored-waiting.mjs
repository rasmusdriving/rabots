// The window check, section "restored-waiting". Run it alone: node scripts/ui-check.mjs --only=restored-waiting
// Engine 0.31.1 (docs/build/step-restored-waiting.md): a bot at rest with a card that came back after
// a restart reads Waiting for you, with the same mark, tone and words as a bot that waits in a turn,
// in the list, the bot's header and on the phone. It is not in a turn: the send button is a plain
// Send and a message starts a turn at once (Working wins), after which it reads Waiting again. An
// answer goes straight to a turn; Later straight to Idle. The stand-in engine seeds HubSpot tickets
// so with &restoredwait=1 (ui/engine/mock-restoredwait.ts); Kaja waits in a turn there.
import { check, ev, until, open, shot, goTo, houseRules, sleep, type } from "../lib.mjs";

const NAME = "HubSpot tickets";
const TITLE = "Which ticket queue should I watch first?";
const row = (name) => `$$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)})`;
const card = `$$(".app-rail .pb-card").find((c) => c.querySelector(".pb-card-title")?.textContent === ${JSON.stringify(TITLE)})`;
const phone = `!!$(".app-shell")?.dataset.phoneScreen`;

async function toList() {
  if (!(await ev(phone))) return true;
  const shown = `$$(".app-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(shown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
  return ev(shown);
}

async function openChat(name) {
  if (!(await ev(phone))) return goTo(name, "chat");
  await toList();
  await ev(`click(${row(name)})`);
  return until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
}

/** Needs you in sight: its screen on the phone; the rail on the laptop. */
async function toNeeds() {
  if (!(await until(`!!${card}`, 15_000))) return false;
  if (!(await ev(phone))) return true;
  await toList();
  await ev(`click($(".app-needs-row"))`);
  return until(`$(".app-shell").dataset.phoneScreen === "needs"`, 8000);
}

/** Every state the bot's row shows from now on, as it changes (the row stays in the page on the phone too). */
const watch = `(() => { window.__rw = [${row(NAME)}?.dataset.state]; const look = () => { const s = ${row(NAME)}?.dataset.state; if (s && s !== window.__rw.at(-1)) window.__rw.push(s); };
  window.__rwObs?.disconnect(); window.__rwObs = new MutationObserver(look); window.__rwObs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] }); return true; })()`;

const looks = (name) => `(() => { const r = ${row(name)}; if (!r) return null; const m = r.querySelector(".pb-row-text ~ .pb-mark"); const cs = m && getComputedStyle(m);
  return { state: r.dataset.state, line: r.querySelector(".pb-row-line")?.textContent, mark: m?.className, color: cs?.color, bg: cs?.backgroundColor, border: cs?.borderColor, face: r.querySelector(".pb-avatar")?.dataset.state }; })()`;

export default async function section() {
  const M = (name) => `restored-waiting: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("restoredwait=1", { width, height, theme });
      check(T("the list is in sight"), !!(await toList()));

      // The list: the same mark, tone and place as Kaja, who waits in a turn.
      const mine = await until(looks(NAME));
      const kaja = await ev(looks("Kaja"));
      check(T("the row reads Waiting for your answer, with the waiting mark"), mine?.state === "waiting" && mine.line === "Waiting for your answer" && /pb-mark-waiting/.test(mine.mark ?? "") && mine.face === "waiting", mine);
      check(T("its mark looks as a bot's that waits in a turn"), !!kaja && mine?.mark === kaja.mark && mine.color === kaja.color && mine.bg === kaja.bg && mine.border === kaja.border, { mine, kaja });
      await shot(`restored-waiting-${theme}-${width}-list`);

      // The bot's header, and a plain Send: it is not in a turn.
      check(T("the chat opens"), !!(await openChat(NAME)));
      if (width === 1280) {
        const head = await until(`(() => { const s = $(".app-main .pb-status"); return s && { tone: s.className, word: s.textContent, mark: s.querySelector(".pb-mark")?.className }; })()`);
        check(T("the header reads Waiting for you in the waiting tone"), /pb-status-waiting/.test(head?.tone ?? "") && head.word === "Waiting for you" && /pb-mark-waiting/.test(head.mark ?? ""), head);
      } else {
        // The phone's head says it as the bot's row does, with the face waiting.
        const head = await until(`(() => { const h = $(".app-main .app-phone-head"); return h && { line: h.querySelector(".app-phone-status")?.textContent, face: h.querySelector(".pb-avatar")?.dataset.state }; })()`);
        check(T("the phone's head reads Waiting for your answer, the face waiting"), head?.line === "Waiting for your answer" && head.face === "waiting", head);
      }
      const send = await ev(`(() => { const b = $(".app-main .pb-send"); return b && { label: b.getAttribute("aria-label"), follow: b.dataset.follow ?? null }; })()`);
      check(T("the send button is a plain Send, not a steer or a Stop"), send?.label === "Send" && send.follow === null, send);
      check(T("nothing wider than the screen"), (await ev(`document.scrollingElement.scrollWidth - innerWidth`)) <= 0);
      await shot(`restored-waiting-${theme}-${width}-chat`);
      if (width === 1280 && theme === "dark") await houseRules(T("the chat"));

      // A message starts a turn at once: Working wins, then Waiting again, with no Idle or Done between.
      await ev(watch);
      await ev(`(() => { const t = $('.app-main textarea[aria-label="Message ${NAME}"]'); t.focus(); return true; })()`);
      await type("How many tickets came in today?");
      await ev(`click($(".app-main .pb-send"))`);
      const busy = await until(`["thinking", "working"].includes(${row(NAME)}?.dataset.state)`, 4000);
      check(T("a message starts a turn at once"), !!busy, await ev(`window.__rw`));
      const back = await until(`window.__rw.length > 2 && ${row(NAME)}?.dataset.state === "waiting"`, 15_000);
      const seen = await ev(`window.__rw`);
      check(T("when it ends the bot reads Waiting again, with no Idle or Done between"), !!back && !seen.some((s) => s === "idle" || s === "done"), seen);

      if (width === 360) {
        // Later: straight back to the bot's own rest (Done just after a turn, else Idle), nothing else.
        check(T("Needs you is in sight"), !!(await toNeeds()));
        await ev(watch);
        await ev(`click([...${card}.querySelectorAll(".pb-card-actions .pb-btn")].find((b) => b.textContent.trim() === "Later"))`);
        await until(`${row(NAME)}?.dataset.state !== "waiting"`, 4000);
        await sleep(400);
        const later = await ev(`window.__rw`);
        check(T("Later goes straight back to rest"), later?.length === 2 && later[0] === "waiting" && ["done", "idle"].includes(later[1]), later);
        const line = await ev(`${row(NAME)}?.querySelector(".pb-row-line")?.textContent`);
        check(T("the row's line is its own again"), !!line && !/^Waiting/.test(line), line);
        continue;
      }

      // The answer: straight from Waiting into the turn it starts, then at rest without Waiting.
      check(T("Needs you is in sight"), !!(await toNeeds()));
      await ev(watch);
      await ev(`click([...${card}.querySelectorAll(".pb-card-actions .pb-btn")].find((b) => b.textContent.trim() === "Support"))`);
      const ended = await until(`["done", "idle"].includes(${row(NAME)}?.dataset.state) && window.__rw.length > 2`, 15_000);
      const answered = await ev(`window.__rw`);
      check(T("the answer goes from Waiting straight into its turn"), answered?.[0] === "waiting" && ["thinking", "working"].includes(answered?.[1]), answered);
      check(T("then the bot rests, and never read Idle in between"), !!ended && answered.slice(1, -1).every((s) => s === "thinking" || s === "working"), answered);
      await shot(`restored-waiting-${theme}-${width}-answered`);
    }
  }
}
