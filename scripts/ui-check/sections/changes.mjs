// The window check, section "changes". Run it alone: node scripts/ui-check.mjs --only=changes
// What the main bot changes inside Pobots is told in a quiet line in its chat, not on a card under
// "Needs you" (the tester's walk of 15 Nov 2026; engine/core/notes.ts, docs/main-bot.md). Here: the
// lines look calm among the messages at laptop and phone width, in light and dark, nothing about them
// is on the rail, and a line that arrives when a turn ends does not make the chat jump, pinned to the
// bottom or scrolled up. The stand-in engine writes the lines (ui/engine/mock-channels.ts and the
// lever linesAfterTurn).
import { b, check, ev, until, open, key, type, shot, goTo, houseRules, sleep } from "../lib.mjs";

export default async function section() {
  const C = (name) => `changes: ${name}`;
  const CHANNEL_LINE = "Channel Ops - Internal: the tag Inbox reaches Onboardings (was Inbox); cy@example.com may write now; bo@example.com may no longer write";
  const lines = `$$(".app-main .app-notice").filter((n) => /^(Channel |Inbox: |Mira Test: )/.test(n.querySelector("span").textContent))`;
  const sendText = async (text) => {
    await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
    await type(text);
    await until(`$(".app-main .pb-composer textarea").value === ${JSON.stringify(text)}`);
    await key("Enter");
    await until(`$(".app-main .pb-composer textarea").value === ""`);
  };

  // ---------------- how the lines look, at laptop and phone width, light and dark
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
    ]) {
      const T = (n) => C(`${theme}, ${width} px: ${n}`);
      await open("scene=channels", { width, height, theme });
      await goTo("Kaja", "chat");
      await until(`${lines}.length === 2`);
      await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
      await sleep(300);
      const look = await ev(`(() => {
        const ls = ${lines};
        const other = $$(".app-main .app-notice").find((n) => !ls.includes(n));
        const s = $(".app-main .pb-main-scroll").getBoundingClientRect();
        const answer = $$(".app-main .pb-msg-body").at(-1)?.getBoundingClientRect();
        return ls.map((n) => {
          const st = getComputedStyle(n);
          const r = n.getBoundingClientRect();
          return {
            text: n.querySelector("span").textContent,
            time: !!n.querySelector("time.pb-time"),
            size: st.fontSize,
            color: st.color,
            calm: !n.classList.contains("app-notice-error") && n.getAttribute("role") !== "alert",
            sameAsOther: !other || (getComputedStyle(other).color === st.color && getComputedStyle(other).fontSize === st.fontSize),
            fits: r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && n.scrollWidth <= n.clientWidth + 1,
            smaller: !answer || parseFloat(st.fontSize) <= parseFloat(getComputedStyle($$(".app-main .pb-msg-body").at(-1)).fontSize),
            visible: r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5,
          };
        });
      })()`);
      check(T("the main bot's chat ends with the two quiet lines, the channel's first, with its time"), Array.isArray(look) && look.length === 2 && look[0].text === CHANNEL_LINE && /^Inbox: purpose from /.test(look[1].text) && look.every((l) => l.time), look);
      check(T("they are as quiet as the other notice lines: same size and colour, never an alert, no larger than a message"), Array.isArray(look) && look.every((l) => l.calm && l.sameAsOther && l.smaller), look);
      check(T("a long line wraps inside the chat and nothing scrolls sideways"), Array.isArray(look) && look.every((l) => l.fits) && (await ev(`document.scrollingElement.scrollWidth - innerWidth`)) <= 0, look);
      check(T("pinned to the bottom, both lines are in view"), Array.isArray(look) && look.every((l) => l.visible), look);
      const rail = await ev(`window.pobotsState().cards.filter((c) => /Ops - Internal|Inbox: purpose|may write/.test(c.title + " " + (c.text ?? c.detail ?? ""))).map((c) => c.title)`);
      check(T("nothing about them is under Needs you"), Array.isArray(rail) && rail.length === 0, rail);
      await houseRules(`changes, ${theme}, ${width} px`);
      await shot(`changes-${theme}-${width}`);
    }
  }

  // ---------------- a line that arrives when a turn ends: no jump
  await open("", { width: 1280, height: 820, theme: "dark" });
  await goTo("Kaja", "chat");
  await ev(`window.pobotsMock.linesAfterTurn(["Mira Test: purpose from \\"Writes the weekly note\\" to \\"Writes the Friday note\\"; effort from medium to high"])`);
  await sendText("What is on today?");
  // Pinned: the turn runs and ends, the line comes last, and the chat stays at the bottom with it in view.
  const pinnedEnd = await until(`(() => { const l = ${lines}.at(-1); if (!l) return null; const s = $(".app-main .pb-main-scroll"); return { atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 2, last: [...s.querySelectorAll(".app-notice, .pb-msg-body")].at(-1) === l || [...s.querySelectorAll(".app-notice")].at(-1) === l, inView: l.getBoundingClientRect().bottom <= s.getBoundingClientRect().bottom + 0.5 }; })()`, 12_000);
  check(C("pinned to the bottom: the line comes after the answer, and the chat stays at the bottom with it in view"), !!pinnedEnd && pinnedEnd.atBottom && pinnedEnd.last && pinnedEnd.inView, pinnedEnd);
  await shot("changes-after-turn");

  // Scrolled up while a turn runs: what is read does not move when the line arrives (every frame).
  await ev(`window.pobotsMock.linesAfterTurn(["Mira Test: model from Haiku 5.5 to Sonnet 5.5"])`);
  await sendText("And tomorrow?");
  await until(`window.pobotsState().bots.find((b) => b.id === "kaja").state === "thinking" || window.pobotsState().bots.find((b) => b.id === "kaja").state === "working"`, 3000);
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = Math.max(0, s.scrollTop - 500); s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(200);
  await ev(`(() => { window.__lineJumps = { frames: 0, moves: [] }; const s = $(".app-main .pb-main-scroll"); const first = lineTop(s); window.__lineWatch = true;
    const f = () => { if (!window.__lineWatch) return; window.__lineJumps.frames++; const t = first.el.getBoundingClientRect().top - s.getBoundingClientRect().top; if (Math.abs(t - first.top) > 0.5) window.__lineJumps.moves.push({ moved: Math.round(t - first.top), at: window.__lineJumps.frames }); requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
  const arrived = await until(`${lines}.some((n) => n.textContent.startsWith("Mira Test: model from Haiku 5.5 to Sonnet 5.5"))`, 12_000);
  await sleep(500);
  const jumps = await ev(`(() => { window.__lineWatch = false; return window.__lineJumps; })()`);
  check(C("scrolled up: the line arrives at the end of the turn and nothing on screen moves, every frame"), !!arrived && !!jumps && jumps.frames > 20 && jumps.moves.length === 0, jumps);
  check(C("and nothing about the changes went under Needs you"), (await ev(`window.pobotsState().cards.some((c) => /Mira Test/.test(c.title + " " + (c.text ?? "")))`)) === false);
  void b;
}
