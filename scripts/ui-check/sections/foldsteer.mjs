// The window check, section "foldsteer". Run it alone: node scripts/ui-check.mjs --only=foldsteer
// A message the person steered into a turn another bot started stands where the bot read it (fix
// 0.21.1). In 0.21.0 the fold of that turn took every item of it, and the message, kept out of the
// fold, came after all of it: at the very bottom of the chat, though the bot had read it long before
// (decided 15 Nov 2026). Now the fold ends at the message and the rest of the turn stands open after it.
// The stand-in engine seeds the turn with &foldsteer=1 (ui/engine/mock-foldsteer.ts).
import { check, ev, until, open, shot, goTo, houseRules } from "../lib.mjs";

const STEER = "For HubSpot, sign in with SSO only.";
const AFTER = "Got it. I sign in with SSO and read the rest.";

export default async function section() {
  const M = (name) => `foldsteer: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("foldsteer=1", { width, height, theme });
      await goTo("HubSpot tickets", "chat");
      const ready = await until(`$$(".app-main .app-you").some((y) => y.textContent.includes(${JSON.stringify(STEER)}))`);
      check(T("the steered message is in the chat"), ready === true);
      const order = await ev(`(() => {
        const main = $(".app-main");
        const fold = $$(".app-main .pb-fold-wrap").at(-1);
        const you = $$(".app-main .app-you").find((y) => y.textContent.includes(${JSON.stringify(STEER)}));
        const after = $$(".app-main .pb-msg-body").find((b) => b.textContent.includes(${JSON.stringify(AFTER)}));
        const steps = (words) => $$(".app-main *").filter((e) => e.children.length === 0 && e.textContent.trim() === words);
        const running = steps("Reading the fifth ticket").at(-1);
        const before = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const youAll = $$(".app-main .app-you");
        return {
          foldThenYou: before(fold, you),
          youThenAfter: before(you, after),
          youThenRunning: before(you, running),
          youNotLast: youAll.at(-1) !== you || before(you, running),
          note: you?.querySelector(".app-you-note")?.textContent ?? "",
          foldHoldsLater: !!fold && (fold.textContent.includes(${JSON.stringify(AFTER)}) || fold.textContent.includes("Reading the fifth ticket")),
          pageWide: document.scrollingElement.scrollWidth - innerWidth,
        };
      })()`);
      check(T("the fold of Inbox's turn comes before the message"), order?.foldThenYou === true, order);
      check(T("the bot's answer and the steps after the message come after it, not before"), order?.youThenAfter === true && order.youThenRunning === true, order);
      check(T("the message says Steered"), order?.note === "Steered", order?.note);
      check(T("the fold does not hold what came after the message"), order?.foldHoldsLater === false, order);
      check(T("the page never scrolls sideways"), !!order && order.pageWide <= 0, order?.pageWide);
      // Opened, the fold holds the part of the turn before the message, and only that.
      await ev(`click($$(".app-main .pb-fold").at(-1))`);
      const body = await until(`(() => { const b = $$(".app-main .pb-fold-body").at(-1); return b ? b.textContent : null; })()`);
      check(T("opened, the fold holds Inbox's ask and the first two tickets, nothing after the message"), typeof body === "string" && body.includes("Read the five open onboarding tickets") && body.includes("Read 2 files") && !body.includes(AFTER) && !body.includes("Reading the fifth ticket") && !body.includes(STEER), body);
      const still = await ev(`(() => {
        const you = $$(".app-main .app-you").find((y) => y.textContent.includes(${JSON.stringify(STEER)}));
        const fold = $$(".app-main .pb-fold-wrap").at(-1);
        return !!you && !!fold && !!(fold.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING);
      })()`);
      check(T("with the fold open the message still stands after it"), still === true);
      await ev(`click($$(".app-main .pb-fold").at(-1))`);
      await houseRules(`foldsteer, ${theme}, ${width} px`);
      await ev(`$$(".app-main .app-you").find((y) => y.textContent.includes(${JSON.stringify(STEER)}))?.scrollIntoView({ block: "center" })`);
      await shot(`foldsteer-${theme}-${width}`);
    }
  }
}
