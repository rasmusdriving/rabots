// The window check, section "railresize". Run it alone: node scripts/ui-check.mjs --only=railresize
// A wider rail, and nothing in it runs past its edge (17 Nov 2026, docs/build/step-rail-resize.md):
// the handle on the rail's left edge drags it wider and narrower within its bounds, the chat keeps
// its place, a reload keeps the width with no jump, a double-click puts it back, the keys move it,
// there is no handle on the phone or beside the artifact panel. And with long words and addresses in
// every card kind and row (&longtext=1, ui/engine/mock-longtext.ts) nothing in the rail reaches past
// its edge and the rail never scrolls sideways, at laptop widths, the narrowest and widest rail, and
// on the phone at 390 and 360, light and dark.
import { b, check, ev, until, open, shot, houseRules, focusRings, sleep, key, fixClock, page } from "../lib.mjs";
import { pathToFileURL } from "node:url";

const Q = "atwork=1&todos=1&tm=1&typed=1&longtext=1";
const KEY = "pobots.railWidth";
const railW = `Math.round($(".app-rail").getBoundingClientRect().width)`;
const handle = `$(".pb-rail-handle")`;

/** Everything in the rail stays inside what the rail shows, and every card's parts inside the card. */
const fits = `(() => {
  const r = $(".app-rail");
  const box = r.getBoundingClientRect();
  const edge = box.left + r.clientLeft + r.clientWidth + 0.5;
  const name = (el) => (typeof el.className === "string" && el.className ? el.className.split(" ")[0] : el.tagName) + ":" + (el.textContent || "").trim().slice(0, 20);
  const past = $$(".app-rail *").filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right > edge && !el.closest("[data-leaving]"); }).map(name);
  // Text runs past its own box without moving the box, so each line of text is measured too, as far
  // as a box that clips it (an ellipsis row) lets it show.
  const shown = (node) => { const range = document.createRange(); range.selectNodeContents(node); let right = range.getBoundingClientRect().right;
    for (let a = node.parentElement; a && a !== r; a = a.parentElement) { if (getComputedStyle(a).overflowX !== "visible") { right = Math.min(right, a.getBoundingClientRect().right); break; } }
    return right; };
  const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest("[data-leaving]") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const text = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (shown(n) > edge) text.push(n.textContent.trim().slice(0, 30));
  const inCards = $$(".app-rail .pb-card").flatMap((c) => { const cr = c.getBoundingClientRect().right + 0.5; return $$("*", c).filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > cr; }).map(name); });
  return { past: past.slice(0, 5), text: text.slice(0, 5), inCards: inCards.slice(0, 5), scroll: r.scrollWidth - r.clientWidth, cards: $$(".app-rail .pb-card").length, w: Math.round(box.width) };
})()`;

/** All long-text parts are in the rail, so the fit check sees each kind. */
const allThere = `(() => {
  const t = $(".app-rail").textContent;
  return ["The notes are in", "Which Onboardingstatus", "Where should the report go", "Open https://example.com", "backup failed", "Your answer"].every((s) => t.includes(s) || !!$('.app-rail input[placeholder="' + s + '"]'))
    && !!$(".app-rail .pb-todo-item") && !!$(".app-rail .pb-atwork-item") && !!$(".app-rail .pb-later-item");
})()`;

async function fitsAt(where) {
  const f = await ev(fits);
  check(`${where}: nothing in the rail reaches past its edge, no part past its card (${f?.cards} cards, rail ${f?.w} px)`, !!f && f.past.length === 0 && f.text.length === 0 && f.inCards.length === 0, f);
  check(`${where}: the rail does not scroll sideways`, !!f && f.scroll <= 0, f?.scroll);
}

async function mouse(type, x, y, extra = {}) {
  await b.cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
}

/** Drags the handle by dx pixels (negative: left), in steps as a hand does. */
async function drag(dx) {
  const h = await ev(`(() => { const r = ${handle}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x, y: h.y });
  await mouse("mousePressed", h.x, h.y, { clickCount: 1, buttons: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", h.x + (dx * i) / steps, h.y, { buttons: 1 });
    await sleep(20);
  }
  await mouse("mouseReleased", h.x + dx, h.y, { clickCount: 1 });
  await sleep(150);
}

async function doubleClick() {
  const h = await ev(`(() => { const r = ${handle}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x, y: h.y });
  await mouse("mousePressed", h.x, h.y, { clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", h.x, h.y, { clickCount: 1 });
  await mouse("mousePressed", h.x, h.y, { clickCount: 2, buttons: 1 });
  await mouse("mouseReleased", h.x, h.y, { clickCount: 2 });
  await sleep(150);
}

/** A picture with the long cards in view, the rail as it was after. */
async function cardsShot(name) {
  // The foot (task managers, helpers, to-do) stands over the cards; it steps aside for the picture.
  await ev(`(() => { $(".app-rail .pb-rail-foot").style.display = "none"; const r = $(".app-rail"); const c = $$(".app-rail .pb-card").find((x) => x.textContent.includes("The notes are in")); r.scrollTop += c.getBoundingClientRect().top - r.getBoundingClientRect().top - 8; return true; })()`);
  await shot(name);
  await ev(`($(".app-rail .pb-rail-foot").style.display = "", $(".app-rail").scrollTop = 0, true)`);
}

/** Records the rail's width in every frame from the first one it is drawn in, for a reload. */
const RECORD = `(() => { window.__railWidths = []; const tick = () => { const r = document.querySelector(".app-rail"); if (r) window.__railWidths.push(Math.round(r.getBoundingClientRect().width)); if (window.__railWidths.length < 30) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();`;

export default async function section() {
  // "Later today" has runs only before the evening: the page's clock reads 10:00 here.
  const unfix = await fixClock(10, 0);
  try {
    await walk();
  } finally {
    await unfix();
  }
}

async function walk() {
  const M = (name) => `railresize: ${name}`;

  // ------------------------------------------------------------ the handle at 1280
  await open(Q, { width: 1280, height: 820 });
  await ev(`(localStorage.removeItem("${KEY}"), true)`);
  await open(Q, { width: 1280, height: 820 });
  check(M("every kind of long text is in the rail"), !!(await until(allThere)), await ev(`$(".app-rail").textContent.slice(0, 200)`));
  check(M("the rail starts at its default width, 344 px"), (await ev(railW)) === 344, await ev(railW));
  const h0 = await ev(`(() => { const h = ${handle}; if (!h) return null; const r = h.getBoundingClientRect(), rail = $(".app-rail").getBoundingClientRect(), s = getComputedStyle(h);
    return { role: h.getAttribute("role"), now: h.getAttribute("aria-valuenow"), min: h.getAttribute("aria-valuemin"), max: h.getAttribute("aria-valuemax"), label: h.getAttribute("aria-label"), cursor: s.cursor,
      left: Math.round(r.left - rail.left), w: Math.round(r.width), grip: getComputedStyle(h.querySelector(".pb-rail-grip")).backgroundColor }; })()`);
  check(M("a handle on the rail's left edge, a separator with its value, min and max"), !!h0 && h0.role === "separator" && h0.now === "344" && h0.min === "280" && h0.max === "536" && h0.left === 0 && h0.w <= 12 && h0.cursor === "col-resize", h0);
  check(M("its grip is drawn quietly, not hidden"), !!h0 && h0.grip !== "rgba(0, 0, 0, 0)", h0?.grip);
  const notOver = await ev(`(() => { const h = ${handle}.getBoundingClientRect(); const m = $(".app-main").getBoundingClientRect(); const c = $(".app-rail .pb-card").getBoundingClientRect(); return h.left >= m.right - 0.5 && h.right <= c.left + 0.5; })()`);
  check(M("the handle covers neither the chat nor a card"), notOver === true);
  await fitsAt(M("1280, default width"));
  await houseRules(M("1280, default width"));
  await shot("railresize-1280-default-dark");
  await cardsShot("railresize-1280-cards-dark");

  // Drag wider; the chat keeps the line at its top.
  const scrolled = await ev(`(() => { const s = $(".app-main .pb-main-scroll"); if (!s || s.scrollHeight - s.clientHeight < 80) return false; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); return true; })()`);
  await sleep(150);
  const top0 = await ev(`(() => { const t = lineTop(); window.__top = t?.el; return t ? Math.round(t.top * 10) / 10 : null; })()`);
  await drag(-120);
  check(M("dragging left makes the rail wider by as much as it was dragged"), Math.abs((await ev(railW)) - 464) <= 2, await ev(railW));
  check(M("the width is remembered in this browser"), Number(await ev(`localStorage.getItem("${KEY}")`)) === (await ev(railW)), await ev(`localStorage.getItem("${KEY}")`));
  if (scrolled) {
    const top1 = await ev(`(() => { const t = lineTop(); return t ? { same: t.el === window.__top, top: Math.round(t.top * 10) / 10 } : null; })()`);
    check(M("the chat keeps the line at its top while the rail gets wider"), !!top1 && top1.same && top0 !== null && Math.abs(top1.top - top0) <= 2, { top0, top1 });
  } else check(M("the chat is long enough to show it keeps its place"), false, "the open chat does not scroll");
  check(M("nothing is left marked as dragging"), (await ev(`document.documentElement.dataset.dragging ?? null`)) === null);
  await drag(-600);
  check(M("never wider than the chat's minimum allows (536 px at 1280)"), (await ev(railW)) === 536, await ev(railW));
  check(M("the chat keeps at least 480 px"), Math.round(await ev(`$(".app-main").getBoundingClientRect().width`)) >= 480, await ev(`$(".app-main").getBoundingClientRect().width`));
  await fitsAt(M("1280, widest"));
  await shot("railresize-1280-widest-dark");
  await drag(600);
  check(M("never narrower than 280 px"), (await ev(railW)) === 280, await ev(railW));
  await fitsAt(M("1280, narrowest"));
  await houseRules(M("1280, narrowest"));
  await shot("railresize-1280-narrowest-dark");
  await cardsShot("railresize-1280-narrowest-cards-dark");
  await drag(-60);
  const kept = await ev(railW);
  check(M("dragging right and left again"), kept === 340, kept);

  // A small move is no drag; the width stays.
  await drag(1);
  check(M("a move under 2 px does not change the width"), (await ev(railW)) === kept, await ev(railW));

  // Reload: the width is there from the first frame.
  await b.cmd("Page.enable");
  const { identifier } = await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: RECORD });
  await b.cmd("Page.reload");
  await until(`!!document.querySelector(".app-rail") && (window.__railWidths ?? []).length >= 30`, 6000);
  await b.cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  const frames = await ev(`window.__railWidths`);
  check(M("after a reload the rail has the chosen width in every frame from the first, no jump"), Array.isArray(frames) && frames.length > 0 && frames.every((w) => w === kept), frames?.slice(0, 8));

  // Double-click: back to the default.
  await doubleClick();
  check(M("a double-click on the handle puts the rail back to its default"), (await ev(railW)) === 344, await ev(railW));
  check(M("and forgets the chosen width"), (await ev(`localStorage.getItem("${KEY}")`)) === null);

  // Keys.
  await ev(`${handle}.focus()`);
  await key("ArrowLeft");
  check(M("Left arrow makes it wider by 16 px"), (await ev(railW)) === 360, await ev(railW));
  await key("ArrowRight");
  await key("ArrowRight");
  check(M("Right arrow makes it narrower"), (await ev(railW)) === 328, await ev(railW));
  await key("Home");
  check(M("Home makes it as wide as it may be"), (await ev(railW)) === 536 && (await ev(`${handle}.getAttribute("aria-valuenow")`)) === "536", await ev(railW));
  await key("End");
  check(M("End makes it as narrow as it may be"), (await ev(railW)) === 280, await ev(railW));
  const ring = await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.classList.contains("pb-rail-handle") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
  check(M("the handle shows the focus ring"), ring === true);
  await doubleClick();

  // ------------------------------------------------------------ other widths, light and dark
  for (const theme of ["dark", "light"]) {
    for (const width of [1920, 1280, 1024, 900]) {
      await open(Q, { width, height: 900, theme });
      await until(allThere);
      const def = width > 1180 ? 344 : width > 900 ? 296 : 280;
      check(M(`${width} ${theme}: the default width is ${def} px`), (await ev(railW)) === def, await ev(railW));
      await fitsAt(M(`${width} ${theme}, default`));
      if (await ev(`!!${handle}`)) {
        await ev(`${handle}.focus()`);
        await key("Home");
        const max = Math.min(720, width - (width > 1180 ? 264 : width > 900 ? 232 : 84) - 480);
        check(M(`${width} ${theme}: as wide as it may be is ${Math.max(def, max)} px`), (await ev(railW)) === Math.max(def, max), await ev(railW));
        await fitsAt(M(`${width} ${theme}, widest`));
        if (width === 1920 || width === 1280) await shot(`railresize-${width}-widest-${theme}`);
        await key("End");
        await fitsAt(M(`${width} ${theme}, narrowest`));
        await doubleClick();
      }
      await houseRules(M(`${width} ${theme}`));
    }
  }

  // A window too narrow for any choice: the rail keeps its default and has no handle.
  await open(Q, { width: 760, height: 820 });
  check(M("760 wide: no handle, the rail at its default"), (await ev(`!${handle}`)) === true && (await ev(railW)) === 280, await ev(railW));
  await fitsAt(M("760"));

  // A stored width wider than a small window allows is shown as wide as the window allows.
  await open(Q, { width: 1920, height: 900 });
  await ev(`${handle}.focus()`);
  await key("Home");
  await open(Q, { width: 1280, height: 820 });
  check(M("a width chosen on a large screen is held to what a smaller window allows"), (await ev(railW)) === 536, await ev(railW));
  await doubleClick();

  // ------------------------------------------------------------ the settings window floats over all: no handle under it
  await open(Q, { width: 1280, height: 820 });
  await ev(`click($(".pb-foot-settings"))`);
  check(M("with the settings window open there is no handle to reach under it"), !!(await until(`!!$(".pb-setwin") && !${handle}`)));
  await key("Escape");
  check(M("closed, the handle is back"), !!(await until(`!$(".pb-setwin") && !!${handle}`)));

  // ------------------------------------------------------------ the artifact panel stands in the rail's place
  await open("scene=artifacts", { width: 1280, height: 820 });
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja"))`);
  await until(`$$(".app-main .pb-thread .pb-artifact").length > 0`);
  await ev(`click($$(".app-main .pb-thread .pb-artifact").filter((r) => r.dataset.artifactId === "onboarding-status").pop())`);
  check(M("with the artifact panel open there is no handle"), !!(await until(`!!$(".app-shell[data-artifact]") && !${handle}`)));
  await key("Escape");

  // ------------------------------------------------------------ the phone: no handle, nothing past the edge
  const phones = [
    { tag: "390", width: 390, height: 844, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
    { tag: "360", width: 360, height: 780, ua: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" },
  ];
  let n = 0;
  try {
    for (const p of phones) {
      for (const theme of ["dark", "light"]) {
        await b.cmd("Emulation.setUserAgentOverride", { userAgent: p.ua });
        await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await b.cmd("Emulation.setDeviceMetricsOverride", { width: p.width, height: p.height, deviceScaleFactor: 2, mobile: true, screenWidth: p.width, screenHeight: p.height });
        await b.cmd("Page.resetNavigationHistory");
        await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&${Q}&fresh=rail${++n}` });
        await until(`!!$(".app-needs-row")`, 6000);
        await ev(`click($(".app-needs-row"))`);
        await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
        await sleep(300);
        check(M(`phone ${p.tag} ${theme}: no handle`), (await ev(`!${handle}`)) === true);
        await until(allThere);
        await fitsAt(M(`phone ${p.tag} ${theme}`));
        check(M(`phone ${p.tag} ${theme}: the page does not scroll sideways`), (await ev(`document.scrollingElement.scrollWidth - innerWidth`)) <= 0);
        await shot(`railresize-phone-${p.tag}-${theme}`);
        await cardsShot(`railresize-phone-${p.tag}-cards-${theme}`);
      }
    }
  } finally {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  }

  // ------------------------------------------------------------ focus rings on the laptop, the handle among them
  await open(Q, { width: 1280, height: 820 });
  await focusRings(M("1280"), 40);
  await ev(`(localStorage.removeItem("${KEY}"), true)`);
}
