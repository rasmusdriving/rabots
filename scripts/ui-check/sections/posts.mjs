// The window check, section "posts". Run it alone: node scripts/ui-check.mjs --only=posts
// Bots post in channels on their own (15 Nov 2026, docs/build/step-channel-posts.md): a channel's
// "Posts" section with a switch per bot (off by default, saved, back off), the line when no address
// for answers is set, and in a bot's chat the quiet "Posted in Ops - Internal" with "Show the post"
// that opens the post in a well below the line (the line keeps its place), and the failed post's
// line in the error tone. The stand-in engine seeds them with &posts=1 (ui/engine/mock-posts.ts).
import { check, ev, until, open, shot, goTo, houseRules, sleep } from "../lib.mjs";

const OPS = "Ops - Internal";

/** On the phone: back until the roster shows, then a row. */
async function toRoster() {
  const phone = await ev(`!!$(".app-shell")?.dataset.phoneScreen`);
  if (!phone) return;
  const shown = `$$(".pb-channel-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(shown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
}

async function openChannel(name) {
  await toRoster();
  await ev(`click($$(".pb-channel-row").find((r) => r.querySelector(".pb-channel-name").textContent === ${JSON.stringify(name)}))`);
  return until(`$(".app-channel")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
}

async function openChat(name) {
  const phone = await ev(`!!$(".app-shell")?.dataset.phoneScreen`);
  if (!phone) return goTo(name, "chat");
  await toRoster();
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
  return until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
}

const posts = `$$(".pb-channel-page .pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Posts")`;
const sw = (bot) => `${posts}?.querySelector('.pb-switch[aria-label="${bot} may post"]')`;

export default async function section() {
  const M = (name) => `posts: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("posts=1", { width, height, theme });

      // ---------------- the channel's page
      check(T("the channel's page opens"), !!(await openChannel(OPS)));
      const order = await ev(`$$(".pb-channel-page .pb-section-title").map((x) => x.textContent)`);
      check(T("Posts stands between Answers and What the flow sends"), order.indexOf("Posts") === order.indexOf("Answers") + 1 && order.indexOf("What the flow sends") === order.indexOf("Posts") + 1, order);
      const first = await until(`(() => { const s = ${posts}; if (!s) return null; return {
        text: s.querySelector(".pb-section-text")?.textContent ?? "",
        rows: $$(".pb-peer", s).map((r) => r.querySelector(".pb-peer-name").textContent + ":" + r.querySelector(".pb-switch").checked),
        faces: $$(".pb-peer", s).every((r) => !!r.querySelector(".pb-avatar, .pb-face, svg")),
        noAddress: s.textContent.includes("No address for answers is set yet"),
        h: s.getBoundingClientRect().height,
        wide: document.scrollingElement.scrollWidth - innerWidth,
      }; })()`);
      check(T("it says what the switch does, plainly"), first?.text === "A bot with the switch on may write new posts here on its own, not only answer, through the address for answers. At most 6 an hour each.", first?.text);
      check(T("a row per bot with its face, Kaja on (seeded), the others off by default"), first?.rows.join("|") === "Kaja:true|Inbox:false|HubSpot tickets:false|Onboardings:false" && first.faces, first?.rows);
      check(T("with an address for answers there is no warning line"), first?.noAddress === false, first);
      check(T("the page never scrolls sideways"), !!first && first.wide <= 0, first?.wide);
      await ev(`${posts}.scrollIntoView({ block: "center" })`);
      await shot(`posts-section-${theme}-${width}`);

      // Switch Inbox on: it shows at once, saves, says Saved, the section keeps its height.
      await ev(`click(${sw("Inbox")})`);
      const on = await until(`(() => { const s = ${posts}; return ${sw("Inbox")}?.checked && s.textContent.includes("Saved") ? s.getBoundingClientRect().height : null; })()`);
      check(T("switched on, it saves and says Saved"), typeof on === "number", on);
      check(T("the section keeps its height while it says Saved"), typeof on === "number" && Math.abs(on - first.h) < 1, { before: first?.h, on });
      const saved = await until(`(() => { const m = window.pobotsState?.().channels?.find((c) => c.name === ${JSON.stringify(OPS)})?.mayPost; return m && m.length === 2 ? m : null; })()`);
      check(T("the channel now lets Kaja and Inbox post"), Array.isArray(saved) && saved.join(",") === "kaja,inbox", saved);
      await sleep(50);
      await ev(`click(${sw("Inbox")})`);
      const off = await until(`${sw("Inbox")}?.checked === false || null`);
      check(T("and off again"), off === true);
      const after = await until(`(() => { const m = window.pobotsState?.().channels?.find((c) => c.name === ${JSON.stringify(OPS)})?.mayPost; return m && m.join(",") === "kaja" ? m : null; })()`);
      check(T("the channel lets only Kaja post again"), !!after, after);
      await houseRules(`posts section, ${theme}, ${width} px`);

      // A channel without an address for answers says posts cannot go out yet.
      check(T("Customer pilots opens"), !!(await openChannel("Customer pilots")));
      const none = await until(`(() => { const s = ${posts}; return s ? { line: s.textContent.includes("No address for answers is set yet, so posts cannot go out. Set it under Answers."), all: $$(".pb-switch", s).every((x) => !x.checked) } : null; })()`);
      check(T("without an address for answers a line says posts cannot go out yet"), none?.line === true, none);
      check(T("and every switch there is off by default"), none?.all === true, none);

      // ---------------- Kaja's chat: the posted line and the failed one
      check(T("Kaja's chat opens"), !!(await openChat("Kaja")));
      const line = await until(`(() => {
        const n = $$(".app-main .app-notice").find((x) => x.dataset.mark === "posted");
        if (!n) return null;
        const b = n.querySelector(".pb-notice-btn");
        return { text: n.querySelector("span")?.textContent, btn: b?.textContent, expanded: b?.getAttribute("aria-expanded"), top: n.getBoundingClientRect().top, wide: document.scrollingElement.scrollWidth - innerWidth };
      })()`);
      check(T("the post's line reads Posted in Ops - Internal"), line?.text === `Posted in ${OPS}`, line);
      check(T("with a quiet Show the post, closed"), line?.btn === "Show the post" && line.expanded === "false", line);
      check(T("the chat never scrolls sideways"), !!line && line.wide <= 0, line?.wide);
      await ev(`$$(".app-main .app-notice").find((x) => x.dataset.mark === "posted").scrollIntoView({ block: "center" })`);
      await sleep(100);
      const before = await ev(`$$(".app-main .app-notice").find((x) => x.dataset.mark === "posted").getBoundingClientRect().top`);
      await ev(`click($$(".app-main .app-notice").find((x) => x.dataset.mark === "posted").querySelector(".pb-notice-btn"))`);
      const opened = await until(`(() => {
        const n = $$(".app-main .app-notice").find((x) => x.dataset.mark === "posted");
        const w = n?.closest(".pb-notice-wrap")?.querySelector(".pb-notice-post");
        if (!w) return null;
        return { btn: n.querySelector(".pb-notice-btn").textContent, strong: w.querySelector("strong")?.textContent, items: $$("li", w).length, top: n.getBoundingClientRect().top, wide: document.scrollingElement.scrollWidth - innerWidth };
      })()`);
      check(T("Show the post opens the post as markdown in a well below the line"), opened?.strong === "Ops status, week 46" && opened.items === 3 && opened.btn === "Hide the post", opened);
      check(T("the line keeps its place when the post opens"), !!opened && Math.abs(opened.top - before) < 1, { before, after: opened?.top });
      check(T("an open post never makes the chat scroll sideways"), !!opened && opened.wide <= 0, opened?.wide);
      await houseRules(`posts chat, ${theme}, ${width} px`);
      await shot(`posts-chat-${theme}-${width}`);
      await ev(`click($$(".app-main .app-notice").find((x) => x.dataset.mark === "posted").querySelector(".pb-notice-btn"))`);
      check(T("Hide the post closes it"), !!(await until(`!$$(".app-main .pb-notice-post").length || null`)));

      const failed = await until(`(() => {
        const n = $$(".app-main .app-notice-error").find((x) => x.textContent.includes("Could not post in ${OPS}"));
        return n ? { text: [...n.children].find((c) => c.tagName === "SPAN" && c.textContent.startsWith("Could"))?.textContent, btn: n.querySelector(".pb-notice-btn")?.textContent, mark: !!n.querySelector(".pb-mark, svg"), color: getComputedStyle(n).color } : null;
      })()`);
      check(
        T("a post that could not go out is said in the error tone, with the next step and the post behind Show the post"),
        failed?.text === `Could not post in ${OPS}: no answer in time. Check the channel before posting again` && failed.btn === "Show the post" && failed.mark,
        failed,
      );
      await ev(`$$(".app-main .app-notice-error").find((x) => x.textContent.includes("Could not post"))?.scrollIntoView({ block: "center" })`);
      await shot(`posts-failed-${theme}-${width}`);
    }
  }
}
