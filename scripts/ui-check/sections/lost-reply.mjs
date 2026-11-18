// The window check, section "lost-reply". Run it alone: node scripts/ui-check.mjs --only=lost-reply
// Engine 0.31.2 (docs/build/step-lost-reply.md): every turn keeps its own answer. On 17 Nov 2026 a
// turn the harness began by itself (a command in the background had ended) was drawn into the answer
// before it, and that answer folded away into "Worked for". The stand-in engine seeds that stored
// shape in Onboardings' chat with &lostreply=1 (ui/engine/mock-lostreply.ts) and plays it live when
// a message asks for a check in the background: the earlier answer does not move while the new turn begins, the new turn's thinking
// line stands in an answer of its own with its face, name and quiet line, and the turn fills it.
import { check, ev, until, open, shot, goTo, houseRules, sleep, type } from "../lib.mjs";

const BOT = "Onboardings";
const ANSWER = "The import stopped because the file from Nordvik had a new column";
const LATER = "Nothing has changed. That notice was about the check I started earlier";
const LIVE_ANSWER = "The check runs in the background. The mapping looks right so far";
const LIVE_LATER = "The check has finished. All rows passed.";
const WOKE = "A helper or background task reported back";

/** The newest answer article holding these words. */
const art = (words) => `$$(".app-main article.pb-answer").findLast((a) => a.textContent.includes(${JSON.stringify(words)}))`;
const rowLine = `$$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(BOT)})?.querySelector(".pb-row-line")?.textContent`;

/**
 * Sends the message, waits for its turn's answer and for `between` (the bot between the turns), then
 * watches the turn that begins by itself: the earlier answer neither moves nor changes (its fold state
 * stays `folded`), the new turn's thinking line stands in an answer of its own with face, name and
 * quiet line, and its first item takes the line's place. Then both turns end folded, each answer in sight.
 */
async function live(T, ask, between, folded) {
  const tag = folded ? "after rest" : "while working";
  await ev(`(() => { const t = $('.app-main textarea[aria-label="Message ${BOT}"]'); t.focus(); return true; })()`);
  await type(ask);
  await ev(`click($(".app-main .pb-send"))`);
  const first = await until(`(() => { const a = ${art(LIVE_ANSWER)}; return !!a && !a.dataset.checked && ${between}; })()`, 8000);
  check(T(`${tag}: the message's turn answers`), !!first, await ev(rowLine));
  await sleep(400);
  // From now until the new turn has said its words: the earlier answer does not move or change.
  // Its own thinking line ("Working in the background") goes: the new turn's answer takes it over.
  // Places are layout places in the chat (offsets), so the arrive fade of a new answer does not count.
  await ev(`(() => {
    const a = ${art(LIVE_ANSWER)};
    a.dataset.checked = "1";
    const thread = $(".app-main .pb-thread");
    const abs = (el) => { let t = 0; for (let e = el; e; e = e.offsetParent) t += e.offsetTop; return t; };
    const rel = (el) => ({ top: abs(el) - abs(thread), h: el.offsetHeight });
    const parts = () => [a.querySelector(".pb-msg-head"), ...a.querySelectorAll(".pb-answer-flow > :not(.pb-pending)")].filter(Boolean).map((el) => { const r = rel(el); return r.top + ":" + r.h; }).join(",");
    const s = window.__lr = { a, before: parts(), folded: a.dataset.folded ?? null, moved: [], kids: 0, thinkAt: null, firstAt: null, headAt: [], same: true, wokeFirst: null, done: false };
    const pend = (n) => n.nodeType === 1 && (n.matches(".pb-pending") || !!n.querySelector(".pb-pending"));
    const obs = new MutationObserver((list) => { for (const m of list) if (m.type === "childList" && !m.target.closest?.(".pb-avatar")) s.kids += [...m.addedNodes, ...m.removedNodes].filter((n) => !pend(n)).length; });
    obs.observe(a, { subtree: true, childList: true });
    const look = () => {
      const now = parts();
      if (now !== s.before) s.moved.push(now);
      if ((a.dataset.folded ?? null) !== s.folded) s.moved.push({ folded: a.dataset.folded ?? null });
      const next = $$(".app-main article.pb-answer").at(-1);
      if (next && next !== a) {
        if (!s.b) { s.b = next; s.wokeFirst = next.querySelector(".pb-woke")?.textContent ?? null; s.headFirst = !!next.querySelector(".pb-msg-head"); }
        if (next !== s.b) s.same = false;
        const pending = next.querySelector(".pb-pending");
        if (pending && s.firstAt === null) s.thinkAt = rel(pending).top;
        const piece = next.querySelector(".pb-answer-flow > :not(.pb-pending)");
        if (piece && s.firstAt === null) s.firstAt = rel(piece).top;
        const head = next.querySelector(".pb-msg-head");
        if (head) { const t = rel(head).top; if (s.headAt.at(-1) !== t) s.headAt.push(t); }
        if (next.textContent.includes(${JSON.stringify(LIVE_LATER)})) { s.done = true; obs.disconnect(); return; }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    return true;
  })()`);
  const ended = await until(`window.__lr.done`, 12_000);
  const s = await ev(`(() => { const s = window.__lr; return { before: s.before, folded: s.folded, moved: s.moved.slice(0, 5), kids: s.kids, thinkAt: s.thinkAt, firstAt: s.firstAt, headAt: s.headAt, same: s.same, wokeFirst: s.wokeFirst, headFirst: s.headFirst }; })()`);
  check(T(`${tag}: the turn that began by itself says its words`), !!ended, s);
  check(T(`${tag}: the earlier answer did not move or change while it began`), !!s && s.folded === folded && s.moved.length === 0 && s.kids === 0, s);
  check(T(`${tag}: its thinking line stood in an answer of its own, with face, name and quiet line from the start`), !!s && s.thinkAt !== null && s.headFirst === true && s.wokeFirst === WOKE, s);
  check(T(`${tag}: its first item took the thinking line's place, in the same answer`), !!s && s.same && s.firstAt !== null && Math.abs(s.firstAt - s.thinkAt) <= 1 && s.headAt.length === 1, s);
  // Once the bot is done, each turn folds on its own and both answers stay in sight.
  const settled = await until(`(() => { const a = ${looks(LIVE_ANSWER)}, b = ${looks(LIVE_LATER)}; return a && b && a.folded && b.folded ? { a, b } : null; })()`, 6000);
  check(T(`${tag}: both turns fold on their own, each answer in sight`), !!settled && settled.a.answerSeen && settled.b.answerSeen && !!settled.a.worked && !!settled.b.worked, settled);
  check(T(`${tag}: only the turn that began by itself has the quiet line`), !!settled && settled.a.woke === null && settled.b.woke === WOKE, settled);
}
/** What an answer shows. */
const looks = (words) => `(() => {
  const a = ${art(words)};
  if (!a) return null;
  const body = [...a.querySelectorAll(".pb-msg-body")].find((b) => b.textContent.includes(${JSON.stringify(words)}));
  return {
    head: !!a.querySelector(":scope > .pb-answer-col > .pb-msg-head"),
    woke: a.querySelector(":scope > .pb-answer-col > .pb-woke")?.textContent ?? null,
    worked: a.querySelector(".pb-worked-words")?.textContent ?? null,
    folded: a.dataset.folded === "true",
    answerSeen: !!body && body.checkVisibility() && !body.dataset.work,
  };
})()`;

export default async function section() {
  const M = (name) => `lost-reply: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);

      // ---------------------------------------------------------------- the stored shape of 17 Nov
      await open("lostreply=1&lostgap=2500", { width, height, theme });
      await goTo(BOT, "chat");
      check(T("the chat holds both turns"), !!(await until(`!!${art(ANSWER)} && !!${art(LATER)}`, 6000)));
      const a = await until(looks(ANSWER));
      const b = await ev(looks(LATER));
      const two = await ev(`${art(ANSWER)} !== ${art(LATER)}`);
      check(T("the two turns are two answers"), two === true, { a, b });
      check(T("the first turn's answer is in sight, below its own Worked for"), !!a && a.answerSeen && a.folded && /^Worked for 7m/.test(a.worked ?? ""), a);
      check(T("the turn that began by itself has its own face, name, quiet line and answer"), !!b && b.head && b.woke === WOKE && b.answerSeen, b);
      check(T("its Worked for counts its own work, not from the question"), !!b && b.worked !== null && !/^Worked for (3\dm|\d+h)/.test(b.worked), b?.worked);
      check(T("the first turn has no quiet line"), a?.woke === null, a);
      check(T("nothing wider than the screen"), (await ev(`document.scrollingElement.scrollWidth - innerWidth`)) <= 0);
      await ev(`${art(ANSWER)}?.scrollIntoView({ block: "start" })`);
      await sleep(150);
      await shot(`lost-reply-${theme}-${width}-stored`);
      if (width === 1280 && theme === "dark") await houseRules(T("the chat"));

      // ---------------------------------------------------------------- live: a turn begins by itself
      // While the command still works in the background: the earlier answer stands open and stays so.
      await live(T, "Run the import check in the background and tell me", `${rowLine} === "Working in the background"`, null);
      // After the bot came to rest (its answer folded): the earlier answer stays folded.
      await live(T, "Run the import check in the background and tell me later", `${art(LIVE_ANSWER)}?.dataset.folded === "true" && /^Answered at/.test(${rowLine})`, "true");
      check(T("nothing wider than the screen after it"), (await ev(`document.scrollingElement.scrollWidth - innerWidth`)) <= 0);
      await shot(`lost-reply-${theme}-${width}-live`);
    }
  }
}
