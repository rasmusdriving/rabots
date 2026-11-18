// The window check, section "phone". Run it alone: node scripts/ui-check.mjs --only=phone
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ the phone layout (job 3)
// docs/build/step-phone.md. Runs at 390 x 844 (an iPhone's user agent) and 360 x 780 (an Android
// phone's), touch on. Two builders work in this section at the same time: each edits only inside
// its own marked block, with small edits. Nothing above this section is changed by this job: those
// checks are the witnesses that the laptop did not change.
export default async function section() {
  phoneStep: {
  const phoneShots = arg("phone-shots") ?? (shots ? join(shots, "phone") : undefined);
  if (phoneShots) mkdirSync(phoneShots, { recursive: true });

  // >>>> phone, shared helpers (builder A writes them; builder B may add its own below A's) >>>>
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  /** The two phones every phone check runs on: an iPhone upright and an Android phone upright. */
  const PHONES = [
    { tag: "390", width: 390, height: 844, ua: IPHONE_UA, ios: true },
    { tag: "360", width: 360, height: 780, ua: ANDROID_UA, ios: false },
  ];
  /** The phone the page is open on now (set by openPhone), and how many taps were made since tapCount(0). */
  let phoneNow = PHONES[0];
  let phoneOpens = 0;
  let phoneTaps = 0;
  /** The on-screen keyboard's height in these checks (a phone's is about 300 to 340 px). */
  const KEYBOARD = 336;
  /** Opens the page as a phone: mobile viewport, touch on, the phone's user agent, scale 2. `size` overrides width and height (a phone on its side, 700 x 900). */
  async function openPhone(query = "", { phone = PHONES[0], theme = "dark", size } = {}) {
    phoneNow = phone;
    const width = size?.width ?? phone.width;
    const height = size?.height ?? phone.height;
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: phone.ua, platform: phone.ios ? "iPhone" : "Linux armv8l" });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height });
    // A new address each time (the mock ignores the counter): going to the same address again would
    // count as a reload, which keeps the screen in history (on purpose); every phone check starts
    // from a fresh entry instead.
    const url = `${pathToFileURL(page).href}?mock=1&theme=${theme}${query ? `&${query}` : ""}&fresh=${++phoneOpens}`;
    // The tab's history starts over: Chromium keeps at most 50 entries, the checks before this
    // section fill them, and then history.length stops growing.
    await b.cmd("Page.resetNavigationHistory");
    await b.cmd("Page.navigate", { url });
    const ok = await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
    await sleep(300);
    return ok;
  }
  /** Leaves the phone: no touch, no phone user agent, the laptop's size. Called once the phone section ends. */
  async function leavePhone() {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    // A fresh entry, so no screen of the phone is kept in the history the next page opens on.
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&fresh=${++phoneOpens}` });
    await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
  }
  /**
   * Acts the on-screen keyboard out. Android (Chrome with interactive-widget=resizes-content): the
   * whole viewport gets `px` shorter. iOS (Safari): the layout stays and only window.visualViewport
   * gets shorter, and Safari may pan it down by `pan` px. `px` 0 closes it again.
   */
  async function phoneKeyboard(px = KEYBOARD, { ios = phoneNow.ios, pan = 0 } = {}) {
    if (ios) {
      await ev(`(() => { const vv = window.visualViewport; delete vv.height; delete vv.offsetTop;
        if (${px} > 0) { const h = innerHeight - ${px}; Object.defineProperty(vv, "height", { configurable: true, get: () => h }); Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => ${pan} }); }
        vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll")); return true; })()`);
    } else {
      const { width, height } = phoneNow;
      await b.cmd("Emulation.setDeviceMetricsOverride", { width, height: height - px, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height });
    }
    // Two frames: the visible height is written in an animation frame, then the page lays itself out.
    await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    await sleep(120);
  }
  /** What the shell has been told about the visible part: --vvh, --vvtop and the keyboard mark. */
  const viewportMarks = () => ev(`({ vvh: document.documentElement.style.getPropertyValue("--vvh"), vvtop: document.documentElement.style.getPropertyValue("--vvtop"), keyboard: document.documentElement.hasAttribute("data-keyboard"), inner: innerHeight, visible: Math.round(visualViewport.height) })`);
  /** Taps the middle of an element (an expression in the page) with a real touch, as a finger does. False when something else is on top there. */
  async function tap(expression) {
    const at = await ev(`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hits: !!hit && (hit === el || el.contains(hit)) }; })()`);
    if (!at || at.error) return false;
    phoneTaps++;
    await b.cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await b.cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(60);
    return at.hits;
  }
  /** Counts taps from here: tapCount(0) starts over, tapCount() reads. */
  const tapCount = (reset) => (reset === 0 ? (phoneTaps = 0) : phoneTaps);
  /**
   * Watches boxes every animation frame from now: `selectors` maps a name to a CSS selector; each
   * frame records each first match's top, left and height (null while there is none). stopFrames()
   * gives the frames back; moved(frames, name) says how far that box moved while it was there.
   */
  const startFrames = (selectors) =>
    ev(`(() => { const sel = ${JSON.stringify(selectors)}; window.__pf = []; window.__pfOn = true;
      const step = () => { if (!window.__pfOn) return; const f = {}; for (const [k, s] of Object.entries(sel)) { const el = document.querySelector(s); if (!el || !el.checkVisibility({ visibilityProperty: true })) { f[k] = null; continue; } const r = el.getBoundingClientRect(); f[k] = { top: Math.round(r.top * 10) / 10, left: Math.round(r.left * 10) / 10, height: Math.round(r.height * 10) / 10 }; } window.__pf.push(f); requestAnimationFrame(step); };
      requestAnimationFrame(step); return true; })()`);
  const stopFrames = () => ev(`(() => { window.__pfOn = false; return window.__pf; })()`);
  const moved = (frames, name) => {
    const seen = (frames ?? []).map((f) => f[name]).filter(Boolean);
    if (seen.length === 0) return { frames: 0, top: 0, left: 0, height: 0 };
    const spread = (k) => Math.round((Math.max(...seen.map((s) => s[k])) - Math.min(...seen.map((s) => s[k]))) * 10) / 10;
    return { frames: seen.length, top: spread("top"), left: spread("left"), height: spread("height") };
  };
  /** Controls on screen under 44 x 44 px to tap, except those named in `allowed` (selectors). A control's own ::after may make its hit area larger. */
  const smallTargets = (allowed = []) =>
    ev(`(() => {
      const allowed = ${JSON.stringify(allowed)};
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true }) && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !el.closest("[inert]"); };
      const hit = (el) => { const r = el.getBoundingClientRect(); const a = getComputedStyle(el, "::after"); let w = r.width, h = r.height; if (a.content !== "none" && a.position === "absolute") { const aw = parseFloat(a.width), ah = parseFloat(a.height); if (aw > w) w = aw; if (ah > h) h = ah; } return { w, h }; };
      return $$("button, a[href], input:not([type=hidden]):not([type=file]), textarea, select, [role=tab], [role=radio], [role=option], [role=switch]").filter(vis).filter((el) => !allowed.some((s) => el.matches(s)))
        .map((el) => { const { w, h } = hit(el); return { what: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.className).trim().slice(0, 40), w: Math.round(w), h: Math.round(h) }; })
        .filter((x) => x.w < 43.5 || x.h < 43.5);
    })()`);
  /** Text fields on screen whose font is under 16 px (iOS zooms the page when one of them gets the focus). */
  const smallFields = () =>
    ev(`$$("input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select").filter((el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest("[inert]") && el.getBoundingClientRect().width > 0).map((el) => ({ what: el.getAttribute("aria-label") || el.placeholder || el.className, font: parseFloat(getComputedStyle(el).fontSize) })).filter((x) => x.font < 16)`);
  /** The house rules on a phone: the window's own (no borders, plain copy, nothing sideways), controls of 44 px, fields of 16 px. */
  async function phoneRules(where, { allowed = [] } = {}) {
    await houseRules(where);
    const small = await smallTargets(allowed);
    check(`${where}: every control on screen is at least 44 x 44 px to tap`, Array.isArray(small) && small.length === 0, small?.slice?.(0, 6) ?? small);
    const fields = await smallFields();
    check(`${where}: every text field on screen has a font of at least 16 px`, Array.isArray(fields) && fields.length === 0, fields);
  }
  /** A picture of the phone screen into the phone pictures folder. */
  async function pShot(name) {
    if (!phoneShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(phoneShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  /** Waits two animation frames in the page. */
  const frames2 = () => ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  // <<<< phone, shared helpers <<<<

  // UI_CHECK_PHONE_BLOCK=release with --only=phone runs only the block "phone, release fixes", for trying it while building.
  const phoneBlock = process.env.UI_CHECK_PHONE_BLOCK;
  // >>>> phone, block A: the shell and getting around >>>>
  phoneA: {
    if (phoneBlock) break phoneA;
    const shell = `$(".app-shell")`;
    const screenNow = () => ev(`({ screen: ${shell}?.dataset.phoneScreen ?? null, sheet: ${shell}?.dataset.phoneSheet ?? null, len: history.length, view: history.state?.pobotsPhone ?? null })`);
    const rowOf = (name) => `$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)})`;
    const rowTop = (name) => ev(`Math.round(${rowOf(name)}.getBoundingClientRect().top * 10) / 10`);
    /** What is on screen: the one part visible in the shell's cell. */
    const shown = () => ev(`$$(".app-shell > *").filter((el) => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0).map((el) => el.className.split(" ").find((c) => c.startsWith("app-")) ?? el.className)`);
    const fills = (sel) => ev(`(() => { const el = $(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return Math.abs(r.left) < 1 && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.top) < 1 && Math.abs(r.height - innerHeight) < 1; })()`);
    const backTo = () => ev(`(() => { const b = $$(".app-phone-back").find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]")); return b ? b.getAttribute("aria-label") : null; })()`);
    const tapBack = () => tap(`$$(".app-phone-back, .pb-artifact-back").find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]"))`);
    const settle = async () => { await frames2(); await sleep(200); };

    for (const phone of PHONES) {
      const P = (s) => `phone ${phone.tag} (${phone.ios ? "iPhone" : "Android"}): ${s}`;

      // ---------------- Bots, the first screen
      await openPhone("", { phone });
      let now = await screenNow();
      check(P("the page opens on the Bots screen, one column, and it is a history entry of its own"), now?.screen === "bots" && now.view?.screen === "bots" && (await ev(`getComputedStyle(${shell}).gridTemplateColumns.split(" ").length`)) === 1, now);
      check(P("only the roster shows, at the full width"), JSON.stringify(await shown()) === JSON.stringify(["app-side"]) && (await ev(`Math.round($(".app-side").getBoundingClientRect().width)`)) === phone.width, await shown());
      const bots = await ev(`$$(".app-row").map((r) => ({ name: r.querySelector(".pb-row-name").textContent, line: r.querySelector(".pb-row-line").checkVisibility({ visibilityProperty: true }), h: Math.round(r.getBoundingClientRect().height) }))`);
      check(P("every bot row shows its name and its line, 56 px tall"), Array.isArray(bots) && bots.length >= 4 && bots.every((x) => x.line && x.h >= 56), bots);
      const needsRow = await ev(`({ text: $(".app-needs-row")?.textContent, h: Math.round($(".app-needs-row")?.getBoundingClientRect().height ?? 0) })`);
      check(P("one raised row says how many things need you, counted gently"), /^(Two|Three|Four|Five|Six) things need you$/.test(needsRow?.text ?? "") && needsRow.h >= 56, needsRow);
      check(P("the foot of the Bots screen has the settings gear"), !!(await ev(`$(".app-side .pb-foot-settings")?.checkVisibility({ visibilityProperty: true })`)));
      await phoneRules(P("the Bots screen"));
      await pShot(`${phone.tag}-01-bots-dark`);

      // ---------------- opening a bot: one tap, one history entry, nothing jumps
      const before = await screenNow();
      const tappedTop = await rowTop("Inbox");
      await ev(`(() => { const s = $(".app-side"); window.__rowTops = () => $$(".app-row").map((r) => Math.round(r.getBoundingClientRect().top * 10) / 10); window.__rows0 = window.__rowTops(); return true; })()`);
      await startFrames({ head: ".app-main .app-phone-head", name: ".app-main .app-phone-name", foot: ".app-main .pb-main-foot", row: ".app-side .app-row" });
      tapCount(0);
      check(P("a bot's row takes the tap"), await tap(rowOf("Inbox")));
      await until(`$(".app-shell").dataset.phoneScreen === "bot" && $(".app-main").getAttribute("aria-label") === "Inbox"`);
      await settle();
      let f = await stopFrames();
      now = await screenNow();
      check(P("one tap opens the bot's screen and adds one history entry"), now?.screen === "bot" && now.len === before.len + 1 && now.view?.bot === "inbox" && tapCount() === 1, { before, now });
      check(P("the bot's chat shows alone, filling the screen"), JSON.stringify(await shown()) === JSON.stringify(["app-main"]) && (await fills(".app-main")), await shown());
      check(P("the chat arrives as a whole: the head, the name and the message box never move while it opens"), moved(f, "head").frames > 0 && moved(f, "head").top === 0 && moved(f, "name").top === 0 && moved(f, "foot").top === 0, { head: moved(f, "head"), name: moved(f, "name"), foot: moved(f, "foot") });
      check(P("the rows did not move while it opened"), moved(f, "row").top === 0 && JSON.stringify(await ev(`window.__rowTops()`)) === JSON.stringify(await ev(`window.__rows0`)), moved(f, "row"));
      const head = await ev(`(() => { const h = $(".app-main .app-phone-head"); const r = h.getBoundingClientRect(); return { top: Math.round(r.top), back: $(".app-main .app-phone-back")?.getAttribute("aria-label"), name: $(".app-main .app-phone-name")?.textContent, line: $(".app-main .app-phone-status")?.textContent, page: !!btn("Page", h), tabs: !!$(".app-main .pb-tabs") }; })()`);
      check(P("the head: the way back to Bots, the name, what it does and Page; no tabs on the chat"), head?.top === 0 && head.back === "Back to Bots" && head.name === "Inbox" && !!head.line && head.page && !head.tabs, head);
      const foot = await ev(`Math.round($(".app-main .pb-composer").getBoundingClientRect().bottom)`);
      check(P("the message box stands at the bottom, on screen"), foot > phone.height - 120 && foot <= phone.height, foot);
      await phoneRules(P("a bot's chat"), { allowed: [".pb-composer *", ".pb-thread *", ".pb-main-foot *"] });
      await pShot(`${phone.tag}-02-bot-dark`);

      // ---------------- back: the gesture and the control do the same
      await ev(`history.back()`);
      await until(`$(".app-shell").dataset.phoneScreen === "bots"`);
      await settle();
      now = await screenNow();
      const focus = await ev(`document.activeElement?.querySelector?.(".pb-row-name")?.textContent ?? document.activeElement?.className`);
      check(P("the browser's back (Android's back, the iOS swipe) goes to Bots"), now?.screen === "bots" && now.view?.screen === "bots", now);
      check(P("back on Bots: the row he tapped is where it was and has the focus"), (await rowTop("Inbox")) === tappedTop && focus === "Inbox", { focus, was: tappedTop, now: await rowTop("Inbox") });
      await tap(rowOf("Inbox"));
      await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
      const lenIn = (await screenNow()).len;
      check(P("the way back reads Bots"), (await backTo()) === "Back to Bots");
      await tapBack();
      await until(`$(".app-shell").dataset.phoneScreen === "bots"`);
      await settle();
      now = await screenNow();
      check(P("the back control goes to Bots by the browser's own back: no new entry, forward leads to the bot again"), now?.screen === "bots" && now.len === lenIn, { lenIn, now });
      await ev(`history.forward()`);
      check(P("forward shows the bot again"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bot" && $(".app-main").getAttribute("aria-label") === "Inbox"`)));

      // ---------------- a reload keeps the screen
      await b.cmd("Page.reload");
      await until(`!!$(".app-shell")`, 6000);
      await sleep(400);
      now = await screenNow();
      check(P("a reload keeps the bot's screen"), now?.screen === "bot" && (await ev(`$(".app-main").getAttribute("aria-label")`)) === "Inbox", now);
      await ev(`history.back()`);
      check(P("and back from it still goes to Bots"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bots"`)));

      // ---------------- Needs you: two taps from Bots to answer a card
      await openPhone("", { phone });
      const cardsBefore = await ev(`window.pobotsMock ? window.pobotsState().cards.length : 0`);
      tapCount(0);
      await startFrames({ title: ".app-rail .app-rail-title", first: ".app-rail .app-card-slot:nth-of-type(1)" });
      await tap(`$(".app-needs-row")`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      await settle();
      f = await stopFrames();
      check(P("Needs you opens from Bots as a screen of its own, as a whole"), JSON.stringify(await shown()) === JSON.stringify(["app-rail"]) && moved(f, "title").top === 0 && moved(f, "first").top === 0 && (await backTo()) === "Back to Bots", { shown: await shown(), title: moved(f, "title") });
      await phoneRules(P("Needs you"));
      await pShot(`${phone.tag}-03-needs-dark`);
      const secondTop = await ev(`Math.round($$(".app-rail .pb-card")[1].getBoundingClientRect().top)`);
      await startFrames({ second: ".app-rail .app-card-slot:not([data-leaving]) .pb-card" });
      await tap(`btn("Allow once", $(".app-rail .pb-card"))`);
      await until(`window.pobotsState().cards.length === ${cardsBefore - 1}`, 3000);
      await sleep(700);
      f = await stopFrames();
      const steps = (f ?? []).map((x) => x.second?.top).filter((x) => x !== undefined);
      const jump = steps.slice(1).reduce((m, t, i) => Math.max(m, Math.abs(t - steps[i])), 0);
      check(P("two taps from Bots answer a card"), tapCount() === 2 && (await ev(`window.pobotsState().cards.length`)) === cardsBefore - 1, { taps: tapCount() });
      check(P("the answered card settles and the next one slides up without a jump"), steps.length > 5 && jump <= 40 && Math.round(steps.at(-1)) < secondTop, { jump, from: secondTop, to: steps.at(-1), frames: steps.length });
      check(P("Needs you stays on screen after an answer"), (await screenNow()).screen === "needs");
      // Every card answered: the screen says so and stays; back goes where he came from.
      for (let i = 0; i < 8; i++) {
        const left = await ev(`$$(".app-rail .app-card-slot:not([data-leaving]) .pb-card").length`);
        if (!left) break;
        await ev(`(() => { const c = $(".app-rail .app-card-slot:not([data-leaving]) .pb-card"); const b = $$("button", c).filter((x) => !x.disabled).at(-1); b.click(); return true; })()`);
        await sleep(650);
      }
      check(P("with every card answered: Nothing needs you, and the screen stays"), !!(await until(`$(".app-rail-empty")?.textContent === "Nothing needs you" && $(".app-shell").dataset.phoneScreen === "needs"`, 3000)));
      await tapBack();
      check(P("back from Needs you goes to Bots, where he came from"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bots"`)));
      check(P("with nothing waiting the Bots screen has no Needs row"), !(await ev(`!!$(".app-needs-row")`)));

      // From a bot's head: Needs you, and back to the bot.
      await openPhone("", { phone });
      await tap(rowOf("Kaja"));
      await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
      check(P("the bot's head says Needs you with the count"), /Needs you, \d/.test((await ev(`$(".app-main .app-phone-needs")?.getAttribute("aria-label")`)) ?? ""));
      await tap(`$(".app-main .app-phone-needs")`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      check(P("from a bot, Needs you leads back to that bot"), (await backTo()) === "Back to Kaja");
      await tapBack();
      check(P("and back shows the bot again"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bot" && $(".app-main").getAttribute("aria-label") === "Kaja"`)));

      // ---------------- a typed answer
      await openPhone("typed=1", { phone });
      await tap(`$(".app-needs-row")`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      const typedCard = `$$(".app-rail .pb-card").find((c) => c.querySelector(".app-card-answer"))`;
      await ev(`(() => { const c = ${typedCard}; c.scrollIntoView({ block: "center" }); return true; })()`);
      await settle();
      const typed = await ev(`(() => { const c = ${typedCard}; const cr = c.getBoundingClientRect(); const i = c.querySelector(".app-card-answer input").getBoundingClientRect(); const s = btn("Send answer", c).getBoundingClientRect(); return { font: parseFloat(getComputedStyle(c.querySelector("input")).fontSize), inCard: i.left >= cr.left && i.right <= cr.right && s.right <= cr.right, under: s.top >= i.bottom, field: Math.round(i.height), button: Math.round(s.height) }; })()`);
      check(P("a typed answer: the field on its own line at 16 px, the button under it, inside the card"), typed?.font >= 16 && typed.inCard && typed.under && typed.field >= 44 && typed.button >= 44, typed);
      await pShot(`${phone.tag}-04-needs-typed-dark`);
      await tap(`${typedCard}.querySelector("input")`);
      await type("Weekly onboarding report");
      await tap(`btn("Send answer", ${typedCard})`);
      const answered = await until(`window.pobotsMock.cardDecisions().find((d) => d.cardId === "c-typed")?.decision`, 3000);
      check(P("Send answer sends what was typed"), answered?.type === "text" && answered.text === "Weekly onboarding report", answered);

      // ---------------- a card from Pobots itself is on Needs you, and Pobots settings is a sheet
      await openPhone("scene=empty-rail&backup=failed", { phone });
      check(P("a card from Pobots itself makes the Needs row"), (await ev(`$(".app-needs-row")?.textContent`)) === "One thing needs you");
      await tap(`$(".app-needs-row")`);
      await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      check(P("the card from Pobots is on Needs you"), !!(await ev(`$(".app-rail .pb-card-system")?.checkVisibility({ visibilityProperty: true })`)));
      await pShot(`${phone.tag}-05-needs-system-dark`);
      let len0 = (await screenNow()).len;
      await tap(`btn("Open backup settings", $(".pb-card-system"))`);
      await until(`$(".app-shell").dataset.phoneSheet === "settings"`);
      now = await screenNow();
      check(P("Open backup settings opens Pobots settings as a full-screen sheet, one entry further"), now.len === len0 + 1 && JSON.stringify(await shown()) === JSON.stringify(["app-main"]) && (await fills(".app-appsettings")), { now, shown: await shown() });
      check(P("its way back leads to Needs you"), (await backTo()) === "Back to Needs you");
      await tapBack();
      check(P("back closes the sheet and shows Needs you"), !!(await until(`$(".app-shell").dataset.phoneScreen === "needs" && !$(".app-shell").dataset.phoneSheet`)));
      await openPhone("", { phone });
      len0 = (await screenNow()).len;
      await ev(`$(".app-side").scrollTop = 99999`);
      await tap(`$(".app-side .pb-foot-settings")`);
      await until(`$(".app-shell").dataset.phoneSheet === "settings"`);
      check(P("Pobots settings opens from the foot of the Bots screen as a full-screen sheet"), (await screenNow()).len === len0 + 1 && (await fills(".app-appsettings")) && (await backTo()) === "Back to Bots");
      await phoneRules(P("Pobots settings"), { allowed: [".pb-backup *"] });
      await pShot(`${phone.tag}-06-settings-dark`);
      await ev(`history.back()`);
      check(P("the browser's back closes it to Bots"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bots" && !$(".app-shell").dataset.phoneSheet && !$(".app-appsettings")`)));

      // ---------------- the bot's page as a sheet
      await openPhone("", { phone });
      await tap(rowOf("Kaja"));
      await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
      len0 = (await screenNow()).len;
      await startFrames({ head: ".app-main .app-phone-head .app-phone-back" });
      await tap(`btn("Page", $(".app-main .app-phone-head"))`);
      await until(`$(".app-shell").dataset.phoneSheet === "page" && $(".app-tabpanel").dataset.tab === "job"`);
      await settle();
      f = await stopFrames();
      now = await screenNow();
      const tabs = await ev(`(() => { const t = $(".app-main .pb-tabs"); return { back: $(".app-main .app-phone-back").getAttribute("aria-label"), n: t.querySelectorAll(".pb-tab").length, scrolls: t.scrollWidth > t.clientWidth, h: Math.round(t.querySelector(".pb-tab").getBoundingClientRect().height), page: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(P("Page opens the bot's page as a sheet on its Job, one entry further"), now.len === len0 + 1 && now.view?.tab === "job", now);
      check(P("the page's head: the way back reads Chat; seven tabs in a row that scrolls inside itself, never the page"), tabs?.back === "Back to Chat" && tabs.n === 7 && tabs.page <= 0 && tabs.h >= 40, tabs);
      check(P("the way back stays where it is as the page opens"), moved(f, "head").top === 0, moved(f, "head"));
      await pShot(`${phone.tag}-07-page-job-dark`);
      await tap(`$('.app-main .pb-tab[data-tab="files"]')`);
      await until(`$(".app-tabpanel").dataset.tab === "files"`);
      check(P("another tab is the same entry"), (await screenNow()).len === len0 + 1 && (await screenNow()).view?.tab === "files");
      await tapBack();
      check(P("back from the page goes to the chat"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bot" && !$(".app-shell").dataset.phoneSheet && $(".app-tabpanel").dataset.tab === "chat"`)));
      await tap(`btn("Page", $(".app-main .app-phone-head"))`);
      await until(`$(".app-shell").dataset.phoneSheet === "page"`);
      check(P("Page opens again on the tab shown last"), (await ev(`$(".app-tabpanel").dataset.tab`)) === "files");
      await ev(`history.back()`);
      check(P("the browser's back from the page goes to the chat too"), !!(await until(`!$(".app-shell").dataset.phoneSheet && $(".app-tabpanel").dataset.tab === "chat"`)));

      // ---------------- an artifact as a sheet
      await openPhone("scene=artifacts", { phone });
      await tap(rowOf("Kaja"));
      await until(`$(".app-shell").dataset.phoneScreen === "bot" && $$(".app-main .pb-thread .pb-artifact").length > 0`);
      const artRow = `$$(".app-main .pb-thread .pb-artifact").filter((r) => r.getAttribute("aria-disabled") !== "true").pop()`;
      await ev(`(() => { const r = ${artRow}; const s = r.closest(".pb-main-scroll"); s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top - 200; return true; })()`);
      await settle();
      const artTop = await ev(`Math.round(${artRow}.getBoundingClientRect().top)`);
      len0 = (await screenNow()).len;
      await tap(artRow);
      await until(`$(".app-shell").dataset.phoneSheet === "artifact" && !!$(".app-artifact")`);
      await sleep(500);
      check(P("an artifact opens as a full-screen sheet, one entry further"), (await screenNow()).len === len0 + 1 && (await fills(".app-artifact")) && JSON.stringify(await shown()) === JSON.stringify(["app-artifact"]), await shown());
      const bar = await ev(`(() => { const t = $(".pb-artifact-bar-title"); return { title: t.scrollWidth <= t.clientWidth + 1, back: $(".pb-artifact-back")?.getAttribute("aria-label") }; })()`);
      check(P("its title is not cut, and the way back leads to the bot"), bar?.title && bar.back === "Back to Kaja", bar);
      await phoneRules(P("an artifact"));
      await pShot(`${phone.tag}-08-artifact-dark`);
      await tapBack();
      await until(`!$(".app-artifact") && $(".app-shell").dataset.phoneScreen === "bot"`);
      await settle();
      check(P("back closes it, and the artifact's row is where it was"), (await ev(`Math.round(${artRow}.getBoundingClientRect().top)`)) === artTop, { was: artTop, now: await ev(`Math.round(${artRow}.getBoundingClientRect().top)`) });

      // ---------------- the bots' browser: watch only
      await openPhone("scene=browser", { phone });
      await ev(`$(".app-side").scrollTop = 99999`);
      await tap(`$(".pb-browser-line")`);
      await until(`$(".app-shell").dataset.phoneSheet === "browser" && !!$(".pb-browser-panel")`);
      await sleep(900);
      const watch = await ev(`({ take: !!$(".pb-browser-take"), address: !!$(".pb-browser-address"), line: $(".pb-browser-stateline")?.textContent.trim(), close: $$(".pb-browser-tab-close").map((c) => getComputedStyle(c).opacity), back: $(".pb-artifact-back")?.getAttribute("aria-label") })`);
      check(P("the browser is a sheet over Bots, watch only: no Take control, one quiet line"), (await fills(".app-artifact")) && !watch?.take && !watch.address && watch.line === "Take control from a computer." && watch.back === "Back to Bots", watch);
      check(P("each page's close is shown without hover"), Array.isArray(watch?.close) && watch.close.every((o) => o === "1"), watch?.close);
      await phoneRules(P("the browser"));
      await pShot(`${phone.tag}-09-browser-dark`);
      await ev(`history.back()`);
      check(P("back closes the browser to Bots"), !!(await until(`!$(".app-artifact") && $(".app-shell").dataset.phoneScreen === "bots"`)));

      // ---------------- helper threads on a phone
      await openPhone("scene=helpers", { phone });
      await tap(rowOf("Kaja"));
      await until(`$(".app-shell").dataset.phoneScreen === "bot" && !!$(".app-main .pb-worked")`);
      await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
      await until(`$$(".app-main .pb-thread .pb-helper").length > 0`);
      len0 = (await screenNow()).len;
      await ev(`$(".app-main .pb-thread .pb-helper").click()`);
      await until(`!!$(".pb-helper-bar")`);
      const hb = await ev(`({ len: history.length, headBack: getComputedStyle($(".app-main .app-phone-back")).visibility, view: history.state?.pobotsPhone?.screen, helpers: Object.keys(history.state?.pobotsHelpers ?? {}).length })`);
      check(P("a helper's thread is one entry further, its bar leads back and the head's way back steps aside"), hb?.len === len0 + 1 && hb.headBack === "hidden" && hb.view === "bot" && hb.helpers === 1, hb);
      await ev(`history.back()`);
      check(P("back from the helper's thread goes to the chat, still the bot's screen"), !!(await until(`!$(".pb-helper-bar") && $(".app-shell").dataset.phoneScreen === "bot"`)));
      await ev(`history.back()`);
      check(P("and back again to Bots"), !!(await until(`$(".app-shell").dataset.phoneScreen === "bots"`)));

      // ---------------- the keyboard: the head stays at the top, the message box above it
      for (const ios of [true, false]) {
        const K = (s) => P(`keyboard as ${ios ? "iOS Safari" : "Chrome for Android"}: ${s}`);
        await openPhone("scene=long", { phone });
        await tap(rowOf("Kaja"));
        await until(`$(".app-shell").dataset.phoneScreen === "bot" && !!$(".app-main .pb-composer textarea")`);
        await settle();
        const pinned = `(() => { const s = $(".app-main .pb-main-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()`;
        const wasPinned = !!(await until(pinned, 3000));
        await ev(`$(".app-main .pb-composer textarea").focus()`);
        await ev(`(() => { window.__vvWrites = 0; window.__vvObs = new MutationObserver(() => window.__vvWrites++); window.__vvObs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] }); return true; })()`);
        const pan = ios ? 120 : 0;
        await phoneKeyboard(KEYBOARD, { ios, pan });
        await sleep(200);
        const k = await ev(`(() => { const r = (s) => $(s).getBoundingClientRect(); const vv = visualViewport; return { writes: window.__vvWrites, marks: { vvh: document.documentElement.style.getPropertyValue("--vvh"), vvtop: document.documentElement.style.getPropertyValue("--vvtop"), keyboard: document.documentElement.hasAttribute("data-keyboard") }, visible: Math.round(vv.height), top: Math.round(vv.offsetTop), head: Math.round(r(".app-main .app-phone-head").top), box: Math.round(r(".app-main .pb-composer").bottom) }; })()`);
        check(K("the visible height is written once, with the keyboard mark"), k?.writes === 1 && k.marks.vvh === `${k.visible}px` && k.marks.keyboard && k.marks.vvtop === `${pan}px`, k);
        check(K("the head stays at the top of what is visible"), k?.head === k.top, k);
        check(K("the message box stands above the keyboard"), k?.box <= k.top + k.visible && k.box > k.top + k.visible - 120, k);
        check(K("a chat that was at the bottom is still at the bottom"), wasPinned && (await ev(pinned)), { wasPinned });
        if (phone.tag === "390") await pShot(`${phone.tag}-10-keyboard-${ios ? "ios" : "android"}-dark`);
        await ev(`window.__vvWrites = 0`);
        await phoneKeyboard(0, { ios });
        await sleep(200);
        const k2 = await ev(`({ writes: window.__vvWrites, vvh: document.documentElement.style.getPropertyValue("--vvh"), keyboard: document.documentElement.hasAttribute("data-keyboard"), head: Math.round($(".app-main .app-phone-head").getBoundingClientRect().top), box: Math.round($(".app-main .pb-composer").getBoundingClientRect().bottom) })`);
        check(K("closed again: the full height, no mark, the box back at the bottom"), k2?.vvh === `${phone.height}px` && !k2.keyboard && k2.head === 0 && k2.box > phone.height - 120 && k2.box <= phone.height, k2);
        await ev(`(window.__vvObs.disconnect(), true)`);
      }

      // ---------------- a phone on its side
      await openPhone("", { phone, size: { width: phone.height, height: phone.width } });
      check(P("on its side (touch, under 500 px tall) it is still the phone layout"), !!(await ev(`!!$(".app-shell[data-phone]") && getComputedStyle($(".app-shell")).position === "fixed"`)));
      await houseRules(P("on its side"));
      if (phone.tag === "390") await pShot(`${phone.tag}-11-side-dark`);

      // ---------------- the notch and the home bar
      const safe = await b.cmd("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
      if (safe.error) console.log(`  (the safe areas could not be emulated in this browser: ${safe.error.message}; not checked)`);
      else {
        await openPhone("", { phone });
        const pads = await ev(`(() => { const side = $(".app-side").getBoundingClientRect(); const top = $(".app-side .pb-wordmark").getBoundingClientRect().top; return { top: Math.round(top), padBottom: parseFloat(getComputedStyle($(".app-side")).paddingBottom) }; })()`);
        await tap(rowOf("Kaja"));
        await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
        await settle();
        const botPads = await ev(`({ back: Math.round($(".app-main .app-phone-back").getBoundingClientRect().top), foot: parseFloat(getComputedStyle($(".app-main .pb-main-foot")).paddingBottom) })`);
        check(P("the notch: the Bots screen and a bot's head start below it; the home bar: their feet stay above it"), pads?.top >= 47 && pads.padBottom >= 34 && botPads?.back >= 47 && botPads.foot >= 34, { pads, botPads });
        if (phone.tag === "390") await pShot(`${phone.tag}-12-notch-dark`);
        await b.cmd("Emulation.setSafeAreaInsetsOverride", { insets: {} });
      }
    }

    // ---------------- where the phone starts: the CSS and usePhone() agree
    await leavePhone();
    for (const [w, on] of [[700, false], [699, true]]) {
      await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&fresh=${++phoneOpens}` });
      await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
      await open("", { width: w, height: 900 });
      const at = await ev(`({ js: !!$(".app-shell[data-phone]"), css: getComputedStyle($(".app-shell")).position === "fixed", cols: getComputedStyle($(".app-shell")).gridTemplateColumns.split(" ").length, history: history.state?.pobotsPhone ?? null })`);
      check(`at ${w} x 900 with a mouse the phone layout is ${on ? "on, both the rules and usePhone()" : "off, neither the rules nor usePhone()"}`, at?.js === on && at.css === on && (on ? at.cols === 1 : at.cols === 3 && at.history === null), at);
    }

    // ---------------- the home screen: the head of the page, the icons, the manifest
    await openPhone("", { phone: PHONES[0] });
    const headLines = await ev(`(() => { const m = (n) => $('meta[name="' + n + '"]')?.content; const icon = $('link[rel="apple-touch-icon"]');
      return { viewport: m("viewport"), title: m("apple-mobile-web-app-title"), bar: m("apple-mobile-web-app-status-bar-style"), capable: m("apple-mobile-web-app-capable"), themes: $$('meta[name="theme-color"]').map((t) => [t.content, t.media]), icon: icon?.getAttribute("href"), sizes: icon?.getAttribute("sizes") }; })()`);
    // The files themselves, read from the build: a PNG's size and colour type (2 is RGB without a see-through channel), and the manifest.
    const pngFacts = (file) => {
      const d = readFileSync(join(dirname(page), file));
      return { w: d.readUInt32BE(16), h: d.readUInt32BE(20), type: d[25], tRNS: d.includes(Buffer.from("tRNS")) };
    };
    headLines.img = pngFacts("apple-touch-icon.png");
    headLines.maskable = JSON.parse(readFileSync(join(dirname(page), "manifest.webmanifest"), "utf8")).icons.find((x) => x.purpose === "maskable") ?? null;
    if (headLines.maskable) headLines.maskable.png = pngFacts(headLines.maskable.src);
    check("the viewport line lets the page run under the notch and above the keyboard, zoom allowed", headLines?.viewport === "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content", headLines?.viewport);
    check("the home screen lines: the Apple title, the status bar, standalone", headLines?.title === "Pobots" && headLines.bar === "black-translucent" && headLines.capable === "yes", headLines);
    check("the Apple icon is 180 px with no see-through part", headLines?.icon === "apple-touch-icon.png" && headLines.sizes === "180x180" && headLines.img?.w === 180 && headLines.img.h === 180 && headLines.img.type === 2 && !headLines.img.tRNS, { icon: headLines?.icon, img: headLines?.img });
    check("the manifest has a maskable 512 px icon", headLines?.maskable?.sizes === "512x512" && headLines.maskable.src === "icon-maskable-512.png" && headLines.maskable.png.w === 512 && headLines.maskable.png.type === 2, headLines?.maskable);
    check("the top bar's colour: light for a phone in the light theme, the dark ground otherwise", headLines?.themes?.length === 2 && /prefers-color-scheme: light/.test(headLines.themes[0][1]) && /max-width: 699.98px/.test(headLines.themes[0][1]) && headLines.themes[1][1] === "", headLines?.themes);

    // ---------------- pictures in the light theme
    if (phoneShots) {
      for (const phone of PHONES) {
        await openPhone("typed=1", { phone, theme: "light" });
        await pShot(`${phone.tag}-01-bots-light`);
        await tap(rowOf("Kaja"));
        await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
        await pShot(`${phone.tag}-02-bot-light`);
        await tap(`$(".app-main .app-phone-needs")`);
        await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
        await pShot(`${phone.tag}-03-needs-light`);
        await tapBack();
        await until(`$(".app-shell").dataset.phoneScreen === "bot"`);
        await tap(`btn("Page", $(".app-main .app-phone-head"))`);
        await until(`$(".app-shell").dataset.phoneSheet === "page"`);
        await pShot(`${phone.tag}-07-page-job-light`);
      }
    }
  }
  // <<<< phone, block A <<<<

  // >>>> phone, block B: the chat and typing >>>>
  phoneB: {
    if (phoneBlock) break phoneB;
    // Builder B: the message box, the keyboard, attaching a photo, a picture opened large, the model
    // picker, dialogs, the bot's page tabs and the Backup part of Pobots settings (docs/build/notes-phone-chat.md).
    const B = (phone, s) => `phone ${phone.tag} (${phone.ios ? "iPhone" : "Android"}): ${s}`;
    const settleB = async () => { await frames2(); await sleep(200); };
    const visibleIn = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]"))`;
    const scroller = `$(".app-main .pb-main-scroll")`;
    const composer = `$(".app-main .pb-composer")`;
    const field = `$(".app-main .pb-composer textarea")`;
    const chatPlace = () => ev(`(() => { const s = ${scroller}; const t = lineTop(s); const c = ${composer}.getBoundingClientRect(); const vv = visualViewport; return { atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 2, line: t ? t.el.textContent.slice(0, 30) : null, lineAt: t ? Math.round(t.top * 10) / 10 : null, composerBottom: Math.round(c.bottom), visibleBottom: Math.round(vv.offsetTop + vv.height), headTop: Math.round(($(".app-main .app-head")?.getBoundingClientRect().top ?? 0) - vv.offsetTop) }; })()`);
    /** Small controls and small fields inside one part of the screen only. */
    const smallIn = (within, allowed = []) => ev(`(() => {
      const allowed = ${JSON.stringify(allowed)};
      const root = ${within};
      if (!root) return ["nothing at " + ${JSON.stringify(within)}];
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true }) && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !el.closest("[inert]"); };
      const hit = (el) => { const r = el.getBoundingClientRect(); const a = getComputedStyle(el, "::after"); let w = r.width, h = r.height; if (a.content !== "none" && a.position === "absolute") { const aw = parseFloat(a.width), ah = parseFloat(a.height); if (aw > w) w = aw; if (ah > h) h = ah; } return { w, h }; };
      const small = $$("button, a[href], input:not([type=hidden]):not([type=file]), textarea, select, [role=tab], [role=radio], [role=option], [role=switch]", root).filter(vis).filter((el) => !allowed.some((s) => el.matches(s)))
        .map((el) => { const { w, h } = hit(el); return { what: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.className).trim().slice(0, 40), w: Math.round(w), h: Math.round(h) }; })
        .filter((x) => x.w < 43.5 || x.h < 43.5);
      const fields = $$("input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select", root).filter(vis).map((el) => ({ what: el.getAttribute("aria-label") || el.placeholder || el.className, font: parseFloat(getComputedStyle(el).fontSize) })).filter((x) => x.font < 16);
      const wide = $$("*", root).filter(vis).filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && !el.closest(".pb-tray-chips, .pb-tabs, .pb-diff, pre, .app-md table")).map((el) => String(el.className || el.tagName).slice(0, 40)).slice(0, 4);
      return { small: small.slice(0, 6), fields, wide, sideways: document.scrollingElement.scrollWidth - innerWidth };
    })()`);
    const tidy = (r) => !!r && !r.error && !Array.isArray(r) && r.small.length === 0 && r.fields.length === 0 && r.wide.length === 0 && r.sideways <= 0;
    /** Opens a bot from the Bots screen (going back to it first when needed) and waits for its chat. */
    const openBot = async (name) => {
      for (let i = 0; i < 5 && !(await ev(`!!${visibleIn(".app-row")}`)); i++) {
        await ev(`(history.back(), true)`);
        await sleep(250);
      }
      await tap(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)})`);
      return until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)} && !!${visibleIn(".app-main .pb-composer")}`);
    };
    /** Opens the bot's page on a tab through "Page". */
    const openTab = async (tab) => {
      if (!(await ev(`!!${visibleIn(`.pb-tab[data-tab="${tab}"]`)}`))) await tap(visibleIn(".app-phone-page"));
      await until(`!!${visibleIn(`.pb-tab[data-tab="${tab}"]`)}`);
      await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
      return until(`$(".app-tabpanel")?.dataset.tab === "${tab}"`);
    };
    /** Real touches: a pinch from `from` px apart to `to` px apart around (x, y). */
    const pinch = async (x, y, from, to, steps = 8) => {
      const pts = (d) => [{ x: x - d / 2, y, id: 0 }, { x: x + d / 2, y, id: 1 }];
      await b.cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from) });
      for (let i = 1; i <= steps; i++) {
        await b.cmd("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(from + ((to - from) * i) / steps) });
        await sleep(16);
      }
      await b.cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(60);
    };
    const touchAt = async (x, y) => {
      await b.cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await b.cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const zoomNow = () => ev(`(() => { const z = $(".pb-picture-zoom"); const m = z ? new DOMMatrix(getComputedStyle(z).transform === "none" ? "" : getComputedStyle(z).transform) : null; return { scale: m ? Math.round(m.a * 100) / 100 : null, page: visualViewport.scale }; })()`);
    // Pictures made in the page and handed to the box the way a paste does.
    await b.cmd("Page.enable");
    await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__phoneFiles = {
        picture: (name, w, h) => new Promise((r) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#4f5ae8"; g.fillRect(0, 0, w, h); g.fillStyle = "#e8b04f"; g.fillRect(w / 4, h / 4, w / 2, h / 2); c.toBlob((b) => r(new File([b], name, { type: "image/png" })), "image/png"); }),
        paste: (files) => { const t = document.querySelector(".app-main .pb-composer textarea"); const dt = new DataTransfer(); for (const f of files) dt.items.add(f); const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; },
        // Records every chip's words and the tray's height on every change and every frame, until stopped.
        watch: () => { const L = () => { const t = document.querySelector(".app-main .pb-tray"); return { tray: t ? Math.round(t.getBoundingClientRect().height * 10) / 10 : 0, metas: [...document.querySelectorAll(".app-main .pb-chip-meta")].map((m) => m.textContent), chips: [...document.querySelectorAll(".app-main .pb-chip-file")].map((c) => Math.round(c.getBoundingClientRect().height)) }; };
          window.__pw = [L()]; window.__pwOn = true; const o = new MutationObserver(() => window.__pw.push(L())); o.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); window.__pwObs = o; const tick = () => { if (!window.__pwOn) return; window.__pw.push(L()); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; },
        stop: () => { window.__pwOn = false; window.__pwObs?.disconnect(); return window.__pw; },
      };`,
    });

    for (const phone of PHONES) {
      const T = (s) => B(phone, s);

      // ---------------- the message box
      await openPhone("scene=long", { phone });
      check(T("Kaja's chat opens from the Bots screen"), !!(await openBot("Kaja")));
      await settleB();
      const box = await ev(`(() => { const t = ${field}; const i = $(".app-main .pb-attach-input"); const s = getComputedStyle(t); return { font: parseFloat(s.fontSize), hint: t.getAttribute("enterkeyhint"), capture: i?.hasAttribute("capture"), accept: i?.hasAttribute("accept"), multiple: i?.multiple, attach: Math.round($(".app-main .pb-attach").getBoundingClientRect().height), send: Math.round($(".app-main .pb-send").getBoundingClientRect().width) }; })()`);
      check(T("the message box is set at 16 px (iOS does not zoom in) and its keyboard's Enter key says enter"), box?.font >= 16 && box.hint === "enter", box);
      check(T("the one file input has no capture and no accept, so photos, the camera and files are all offered"), box?.capture === false && box.accept === false && box.multiple === true, box);
      check(T("the add button and the send button are 44 px to tap"), box?.attach >= 44 && box.send >= 44, box);
      const foot = await smallIn(`$(".app-main .pb-main-foot")`);
      check(T("the message box: every control 44 px to tap, nothing wider than the screen"), tidy(foot), foot);
      check(T("the chat starts at the bottom"), (await chatPlace())?.atBottom === true);
      // Enter adds a line on a phone; the send button sends.
      await tap(field);
      await type("First line");
      await key("Enter");
      await type("second line");
      const sentBefore = await ev(`window.pobotsState().threads["kaja-main"]?.items.filter((i) => i.kind === "user" && i.from.type === "you").length`);
      const afterEnter = await ev(`({ value: ${field}.value, h: Math.round(${field}.getBoundingClientRect().height) })`);
      check(T("Enter adds a line on a phone and does not send"), afterEnter?.value === "First line\nsecond line", afterEnter);
      // The box grows calmly, a line at a time, up to five lines, and the chat stays at the bottom.
      const heights = [afterEnter?.h];
      for (let i = 3; i <= 7; i++) {
        await key("Enter");
        await type(`line ${i}`);
        await settleB();
        heights.push(await ev(`Math.round(${field}.getBoundingClientRect().height)`));
      }
      const grown = await chatPlace();
      const steps = heights.slice(1).map((h, i) => h - heights[i]);
      check(T("the box grows by one line per line up to five lines, then scrolls; the chat stays at the bottom"), steps.every((d) => d === 0 || d === 24) && heights.at(-1) === heights.at(-2) && heights.at(-1) - heights[0] === 24 * 3 && grown?.atBottom, { heights, grown });
      await pShot(`${phone.tag}-B01-composer-lines-dark`);
      await tap(`$(".app-main .pb-send")`);
      const sent = await until(`(() => { const n = window.pobotsState().threads["kaja-main"]?.items.filter((i) => i.kind === "user" && i.from.type === "you").length; return n === ${Number(sentBefore) + 1} && ${field}.value === "" && n; })()`, 4000);
      check(T("the send button sends what was typed, lines and all"), !!sent, { sentBefore, sent });
      await settleB();
      check(T("after sending, the chat is at the bottom"), (await chatPlace())?.atBottom === true);

      // ---------------- the keyboard: the box above it, the chat where it was
      await tap(field);
      const pinnedBefore = await chatPlace();
      await phoneKeyboard(KEYBOARD);
      const pinnedOpen = await chatPlace();
      check(T("keyboard open: the message box stands above it, the head at the top, the chat still at the bottom"),
        pinnedOpen?.composerBottom <= pinnedOpen.visibleBottom && pinnedOpen.headTop === 0 && pinnedOpen.atBottom && pinnedBefore?.atBottom, { pinnedBefore, pinnedOpen });
      check(T("keyboard open: the foot gives up the home bar's room"), (await ev(`document.documentElement.hasAttribute("data-keyboard")`)) === true);
      await pShot(`${phone.tag}-B02-keyboard-open-dark`);
      await phoneKeyboard(0);
      const pinnedClosed = await chatPlace();
      check(T("keyboard closed again: the chat is still at the bottom, the box at the foot"), pinnedClosed?.atBottom && pinnedClosed.composerBottom <= pinnedClosed.visibleBottom, pinnedClosed);
      // Scrolled up: the line at the top stays the line at the top.
      await ev(`(() => { const s = ${scroller}; s.scrollTop = Math.max(0, s.scrollHeight / 2 - s.clientHeight / 2); s.dispatchEvent(new Event("scroll")); return true; })()`);
      await settleB();
      const upBefore = await chatPlace();
      await phoneKeyboard(KEYBOARD);
      const upOpen = await chatPlace();
      await phoneKeyboard(0);
      const upClosed = await chatPlace();
      check(T("scrolled up, the keyboard opening and closing keeps the line at the top where it was"),
        !!upBefore?.line && !upBefore.atBottom && upOpen?.line === upBefore.line && Math.abs(upOpen.lineAt - upBefore.lineAt) <= 1 && upClosed?.line === upBefore.line && Math.abs(upClosed.lineAt - upBefore.lineAt) <= 1, { upBefore, upOpen, upClosed });
      await ev(`(document.activeElement?.blur?.(), true)`);

      // ---------------- the tray: fits the width, scrolls inside itself
      await ev(`Promise.all(["Team photo.png", "Screenshot one.png", "A long name for a photo from the phone.png", "Receipt.png"].map((n) => window.__phoneFiles.picture(n, 400, 300))).then((fs) => window.__phoneFiles.paste(fs))`);
      await until(`$$(".app-main .pb-chip-file[data-status=done]").length === 4`, 5000);
      await settleB();
      const tray = await ev(`(() => { const c = ${composer}.getBoundingClientRect(); const row = $(".app-main .pb-tray-chips"); const r = row.getBoundingClientRect(); return { inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5, scrolls: row.scrollWidth > row.clientWidth, sideways: document.scrollingElement.scrollWidth - innerWidth, panel: $(".app-main").scrollWidth - $(".app-main").clientWidth }; })()`);
      check(T("the tray fits the width of the box: the chips scroll inside their row, never the page"), tray?.inside && tray.scrolls && tray.sideways <= 0 && tray.panel <= 1, tray);
      const trayTargets = await smallIn(`$(".app-main .pb-composer")`);
      check(T("a chip's remove has a 44 px hit area, and so does everything else in the box"), tidy(trayTargets), trayTargets);
      const removeHit = await ev(`(() => { const x = $(".app-main .pb-chip-remove"); const r = x.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; return [[0, -20], [0, 20], [-20, 0], [20, 0]].map(([dx, dy]) => { const h = document.elementFromPoint(cx + dx, cy + dy); return !!h && (h === x || x.contains(h)); }); })()`);
      check(T("a tap 20 px from the middle of a chip's remove still hits it"), Array.isArray(removeHit) && removeHit.every(Boolean), removeHit);
      await pShot(`${phone.tag}-B03-tray-dark`);
      for (let i = 0; i < 6 && (await ev(`$$(".app-main .pb-chip-remove").length`)); i++) await tap(`$(".app-main .pb-chip-remove")`);
      check(T("removing the last chip does not put the focus in the text (the keyboard would open)"), !!(await until(`!$(".app-main .pb-tray")`)) && (await ev(`document.activeElement !== ${field}`)) === true);

      // ---------------- a large photo is made smaller before it uploads
      await ev(`window.__phoneFiles.watch()`);
      await ev(`window.__phoneFiles.picture("IMG_2041.png", 4000, 3000).then((f) => window.__phoneFiles.paste([f]))`);
      const shrunk = await until(`(() => { const c = $(".app-main .pb-chip-file[data-status=done]"); if (!c) return null; const a = window.pobotsState && null; return { name: c.querySelector(".pb-chip-name").dataset.name }; })()`, 8000);
      await sleep(200);
      const watched = await ev(`window.__phoneFiles.stop()`);
      const att = await ev(`(async () => { const ids = window.pobotsMock.uploadsWaiting(); return ids.length; })()`);
      const metas = [...new Set((watched ?? []).flatMap((x) => x.metas))];
      const trays = [...new Set((watched ?? []).filter((x) => x.tray > 0).map((x) => x.tray))];
      check(T("a 4000 x 3000 photo says Preparing in its chip, then Uploading, and arrives as a JPEG with its name kept"), shrunk?.name === "IMG_2041.jpg" && metas.includes("Preparing") && metas.includes("Uploading") && metas.indexOf("Preparing") < metas.indexOf("Uploading"), { shrunk, metas });
      check(T("the tray keeps its height through Preparing and Uploading"), trays.length === 1, { trays });
      // The engine's record of the upload: at most 2048 px on its long side and under 4 MB.
      await tap(`$(".app-main .pb-send")`);
      const record = await until(`(() => { const items = window.pobotsState().threads["kaja-main"]?.items ?? []; const last = items.filter((i) => i.kind === "user" && i.from.type === "you").at(-1); const a = last?.attachments?.[0]; return a && a.name === "IMG_2041.jpg" && { w: a.width, h: a.height, size: a.size, type: a.type }; })()`, 5000);
      check(T("the photo the bot gets is 2048 x 1536, under 4 MB"), record?.w === 2048 && record.h === 1536 && record.size < 4 * 1024 * 1024, { record, att });
      // What the browser cannot decode goes as it is, and is never lost.
      await ev(`window.__phoneFiles.paste([new File([new Uint8Array(4096).fill(7)], "IMG_2042.heic", { type: "image/heic" })])`);
      const heic = await until(`(() => { const c = $(".app-main .pb-chip-file"); if (!c || c.dataset.status === "preparing" || c.dataset.status === "uploading") return null; return { name: c.querySelector(".pb-chip-name").dataset.name, status: c.dataset.status }; })()`, 5000);
      check(T("a photo the browser cannot decode goes as it is: its name kept, the engine decides"), heic?.name === "IMG_2042.heic" && (heic.status === "done" || heic.status === "refused"), heic);
      for (let i = 0; i < 3 && (await ev(`$$(".app-main .pb-chip-remove").length`)); i++) await tap(`$(".app-main .pb-chip-remove")`);

      // ---------------- the model picker: a sheet from the bottom
      await tap(`$(".app-main .pb-composer-bar .pb-btn-sm")`);
      // Measured once it has arrived (it rises 6 px as it fades in).
      await until(`!!$(".app-picker")`);
      await sleep(450);
      const sheet = await until(`(() => { const p = $(".app-picker"); if (!p) return null; const r = p.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top), keys: $$(".app-picker .pb-key").length, focusField: document.activeElement?.tagName === "INPUT", rows: $$(".app-picker .pb-picker-col:first-child .pb-option").map((o) => Math.round(o.getBoundingClientRect().height)), layers: (history.state?.pobotsLayers ?? []).length }; })()`);
      check(T("the model picker is a sheet from the bottom at the full width, one model per line at 44 px, no key hints"),
        sheet?.left === 0 && sheet.right === phone.width && Math.abs(sheet.bottom - phone.height) <= 1 && sheet.top > 0 && sheet.keys === 0 && sheet.rows.length >= 4 && sheet.rows.every((h) => h >= 44), sheet);
      check(T("the picker does not open the keyboard by itself, and it is a history entry"), sheet?.focusField === false && sheet.layers === 1, sheet);
      const pickerTargets = await smallIn(`$(".app-picker")`);
      check(T("the picker: every control 44 px to tap, fields at 16 px, nothing wider than the screen"), tidy(pickerTargets), pickerTargets);
      await pShot(`${phone.tag}-B04-picker-dark`);
      const scrollBeforePicker = await ev(`${scroller}.scrollTop`);
      await ev(`(history.back(), true)`);
      const pickerGone = await until(`!$(".app-picker") && { layers: (history.state?.pobotsLayers ?? []).length, bot: $(".app-main")?.getAttribute("aria-label"), scroll: ${scroller}.scrollTop }`);
      check(T("back closes the picker and stays in the chat, which has not moved"), pickerGone?.layers === 0 && pickerGone.bot === "Kaja" && pickerGone.scroll === scrollBeforePicker, pickerGone);
      // An effort chosen in the row closes it, and the entry goes with it.
      await tap(`$(".app-main .pb-composer-bar .pb-btn-sm")`);
      await until(`!!$(".app-picker")`);
      const lenPicker = await ev(`history.length`);
      await tap(`$$(".app-picker .pb-picker-side .pb-option").find((o) => o.getAttribute("aria-selected") !== "true")`);
      const effortPicked = await until(`!$(".app-picker") && { layers: (history.state?.pobotsLayers ?? []).length, bot: $(".app-main")?.getAttribute("aria-label") }`, 3000);
      check(T("choosing an effort closes the sheet through history: back from here does not reopen it"), effortPicked?.layers === 0 && effortPicked.bot === "Kaja", { effortPicked, lenPicker });

      // ---------------- a picture opened large: full screen, pinch, back
      await openPhone("files=fresh", { phone });
      await openBot("HubSpot tickets");
      await until(`$$(".app-main .pb-picture").length >= 2`);
      await ev(`inPanel($$(".app-main .pb-picture")[0])`);
      await settleB();
      const chatBefore = await ev(`({ scroll: ${scroller}.scrollTop, len: history.length })`);
      await tap(`$$(".app-main .pb-picture")[0]`);
      const large = await until(`(() => { const v = $(".pb-picture-view"); if (!v || !$(".pb-picture-view [data-full]")) return null; const s = $(".pb-picture-scrim").getBoundingClientRect(); const p = $(".pb-picture-large").getBoundingClientRect(); const c = $(".pb-picture-view-close").getBoundingClientRect(); return { fills: Math.round(s.width) === innerWidth && Math.round(s.height) === innerHeight, w: Math.round(p.width), h: Math.round(p.height), close: Math.round(Math.min(c.width, c.height)), len: history.length, touch: getComputedStyle($(".pb-picture-large")).touchAction, bodyTouch: getComputedStyle(document.body).touchAction, scrimTouch: getComputedStyle($(".pb-picture-scrim")).touchAction }; })()`, 5000);
      check(T("a picture opens large over the whole screen, as wide as the screen, Close 44 px"), large?.fills && large.w === phone.width && Math.abs(large.h - Math.round((phone.width * 1080) / 1920)) <= 1 && large.close >= 44, large);
      check(T("only the picture takes the fingers: the page's own zoom is blocked nowhere else"), large?.touch === "none" && large.bodyTouch !== "none" && large.scrimTouch !== "none", large);
      check(T("opening it is a history entry"), large?.len === chatBefore?.len + 1, { large, chatBefore });
      await pShot(`${phone.tag}-B05-picture-large-dark`);
      const mid = await ev(`(() => { const r = $(".pb-picture-large").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      await pinch(mid.x, mid.y, 60, 180);
      const pinched = await zoomNow();
      check(T("a pinch zooms the picture itself, not the page"), pinched?.scale > 2 && pinched.page === 1, pinched);
      await pShot(`${phone.tag}-B06-picture-pinched-dark`);
      await touchAt(mid.x, mid.y);
      await sleep(80);
      await touchAt(mid.x, mid.y);
      await sleep(500);
      const unzoomed = await zoomNow();
      await touchAt(mid.x, mid.y);
      await sleep(80);
      await touchAt(mid.x, mid.y);
      await sleep(500);
      const doubled = await zoomNow();
      check(T("a double tap goes back to the whole picture, another zooms to 2x"), unzoomed?.scale === null || unzoomed?.scale === 1, unzoomed);
      check(T("double tap zooms to 2x around the tap, the page not at all"), doubled?.scale === 2 && doubled.page === 1, doubled);
      await ev(`(history.back(), true)`);
      const closedLarge = await until(`!$(".pb-picture-view") && { scroll: ${scroller}.scrollTop, len: history.length, bot: $(".app-main")?.getAttribute("aria-label") }`);
      check(T("back closes the large picture, the chat underneath has not moved, the bot is still open"), closedLarge?.scroll === chatBefore?.scroll && closedLarge.bot === "HubSpot tickets", { closedLarge, chatBefore });
      await tap(`$$(".app-main .pb-picture")[0]`);
      await until(`!!$(".pb-picture-view")`);
      await tap(`$(".pb-picture-view-close")`);
      const closedByButton = await until(`!$(".pb-picture-view") && { layers: (history.state?.pobotsLayers ?? []).length, scroll: ${scroller}.scrollTop }`);
      check(T("Close closes it through history too: no layer is left behind, the chat has not moved"), closedByButton?.layers === 0 && closedByButton.scroll === chatBefore?.scroll, closedByButton);

      // ---------------- a dialog: fits, no keyboard by itself, back closes it
      await openPhone("", { phone });
      await tap(visibleIn(".app-add-bot"));
      const dialog = await until(`(() => { const d = $('.pb-dialog[role="dialog"]'); if (!d) return null; const r = d.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), scrolls: d.scrollHeight > d.clientHeight, field: ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName), inside: d.contains(document.activeElement), layers: (history.state?.pobotsLayers ?? []).length }; })()`);
      check(T("Add a bot fits the screen, scrolls inside itself, and gets the focus without opening the keyboard"),
        dialog?.top >= 0 && dialog.bottom <= phone.height && dialog.left >= 0 && dialog.right <= phone.width && dialog.scrolls && dialog.field === false && dialog.inside && dialog.layers === 1, dialog);
      const dialogTargets = await smallIn(`$(".pb-dialog")`);
      check(T("the dialog: controls 44 px to tap, fields at 16 px"), tidy(dialogTargets), dialogTargets);
      await ev(`(() => { const d = $(".pb-dialog"); d.scrollTop = d.scrollHeight; return true; })()`);
      const dialogFoot = await ev(`(() => { const b = btn("Create bot"); const r = b.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: Math.round(r.height) }; })()`);
      check(T("its foot (Create bot) is reached by scrolling inside it"), dialogFoot?.bottom <= phone.height && dialogFoot.h >= 44, dialogFoot);
      await pShot(`${phone.tag}-B07-dialog-dark`);
      await tap(`$("#add-name")`);
      await phoneKeyboard(KEYBOARD);
      const typing = await ev(`(() => { const d = $(".pb-dialog").getBoundingClientRect(); const vv = visualViewport; return { top: Math.round(d.top - vv.offsetTop), bottom: Math.round(d.bottom), visible: Math.round(vv.offsetTop + vv.height) }; })()`);
      check(T("with the keyboard open the dialog stands in the visible part"), typing?.top >= 0 && typing.bottom <= typing.visible, typing);
      await phoneKeyboard(0);
      await ev(`(history.back(), true)`);
      const dialogGone = await until(`!$(".pb-dialog") && { screen: $(".app-shell")?.dataset.phoneScreen, layers: (history.state?.pobotsLayers ?? []).length }`);
      check(T("back closes the dialog and stays on the Bots screen"), dialogGone?.screen === "bots" && dialogGone.layers === 0, dialogGone);

      // ---------------- the bot's page: each tab fits, touch sizes, fields at 16 px
      await openPhone("", { phone });
      await openBot("Kaja");
      for (const tab of ["job", "files", "artifacts", "triggers", "history", "settings"]) {
        await openTab(tab);
        await settleB();
        if (tab === "files") {
          await ev(`click($$(".pb-file")[1])`);
          await until(`!!$(".pb-editor-text")`);
        }
        if (tab === "history") {
          await ev(`click($$(".pb-change")[2])`);
          await until(`!!$(".pb-diff")`);
        }
        const r = await smallIn(`$(".app-main .app-tabpanel")`, [".app-md a"]);
        check(T(`the page's ${tab} tab: controls 44 px to tap, fields at 16 px, nothing wider than the screen`), tidy(r), r);
        if (tab === "settings") {
          await ev(`(() => { const s = $(".app-settings"); s.scrollTop = s.scrollHeight; return true; })()`);
          await settleB();
          const bottom = await smallIn(`$(".app-main .app-tabpanel")`);
          check(T("the settings tab, scrolled to its foot: the same"), tidy(bottom), bottom);
        }
        if (tab === "triggers") {
          await tap(`$(".app-new-trigger")`);
          await until(`!!$(".pb-dialog")`);
          await settleB();
          const form = await smallIn(`$(".pb-dialog")`);
          check(T("New trigger, a sheet: controls 44 px to tap, fields at 16 px, nothing wider than the screen"), tidy(form), form);
          await pShot(`${phone.tag}-B08-new-trigger-dark`);
          await ev(`(history.back(), true)`);
          check(T("back closes New trigger and stays on the Triggers tab"), !!(await until(`!$(".pb-dialog") && $(".app-tabpanel")?.dataset.tab === "triggers"`)));
        }
        await pShot(`${phone.tag}-B09-tab-${tab}-dark`);
      }
      const tabRow = await ev(`(() => { const t = ${visibleIn(".app-head .pb-tabs")}; const tabs = $$(".pb-tab", t); return { scrolls: t.scrollWidth > t.clientWidth, overflowX: getComputedStyle(t).overflowX, tall: tabs.every((x) => x.getBoundingClientRect().height >= 44), sideways: document.scrollingElement.scrollWidth - innerWidth }; })()`);
      check(T("the row of tabs scrolls sideways inside itself, never the page; each tab 44 px tall"), (tabRow?.overflowX === "auto" || tabRow?.overflowX === "scroll") && tabRow.tall && tabRow.sideways <= 0, tabRow);

      // ---------------- Pobots settings, the Backup part
      await openPhone("", { phone });
      await tap(visibleIn(".pb-foot-settings"));
      await until(`!!${visibleIn(".pb-backup")}`);
      await settleB();
      const backup = await smallIn(`${visibleIn(".pb-backup")}`);
      check(T("Pobots settings, Backup: controls 44 px to tap, fields at 16 px, nothing wider than the screen"), tidy(backup), backup);
      await pShot(`${phone.tag}-B10-backup-dark`);
    }

    // ---------------- the laptop keeps what it had
    await leavePhone();
    await open("scene=long");
    await goTo("Kaja");
    const laptop = await ev(`(() => { const t = $(".app-main .pb-composer textarea"); return { hint: t.getAttribute("enterkeyhint"), font: getComputedStyle(t).fontSize, phone: document.documentElement.style.getPropertyValue("--vvh") }; })()`);
    check("phone, laptop at 1280: the message box has no Enter hint, its own size, and no visible height is written", laptop?.hint === null && laptop.font !== "16px" && laptop.phone === "", laptop);
    await ev(`$(".app-main .pb-composer textarea").focus()`);
    await type("Sent with Enter");
    await key("Enter");
    const enterSends = await until(`$(".app-main .pb-composer textarea").value === "" && window.pobotsState().threads["kaja-main"].items.some((i) => i.kind === "user" && i.text === "Sent with Enter")`);
    check("phone, laptop at 1280: Enter still sends", !!enterSends);
    await ev(`Promise.all([window.__phoneFiles.picture("IMG_2043.png", 4000, 3000)]).then((fs) => window.__phoneFiles.paste(fs))`);
    const kept = await until(`(() => { const c = $(".app-main .pb-chip-file"); return c && c.dataset.status === "done" && c.querySelector(".pb-chip-name").dataset.name; })()`, 8000);
    check("phone, laptop at 1280: a large picture is uploaded as it is, never made smaller", kept === "IMG_2043.png", kept);
    for (let i = 0; i < 3 && (await ev(`$$(".app-main .pb-chip-remove").length`)); i++) await ev(`click($(".app-main .pb-chip-remove"))`);
    await ev(`click($(".app-main .pb-composer-bar .pb-btn-sm"))`);
    const laptopPicker = await until(`(() => { const p = $(".app-picker"); return p && { keys: $$(".app-picker .pb-key").length, focus: document.activeElement?.classList.contains("pb-search"), width: Math.round(p.getBoundingClientRect().width), layers: (history.state?.pobotsLayers ?? []).length }; })()`);
    check("phone, laptop at 1280: the model picker is as before (key hints, the search has the focus, 580 px, no history entry)", laptopPicker?.keys === 4 && laptopPicker.focus && laptopPicker.width === 580 && laptopPicker.layers === 0, laptopPicker);
    await key("Escape");
  }
  // <<<< phone, block B <<<<

  // >>>> phone, review fixes (docs/build/notes-phone-review-fixes.md) >>>>
  phoneFixes: {
    if (phoneBlock) break phoneFixes;
    // The eight points of the review of the phone layout. Each check here failed on the code before
    // its fix. The window crosses between the layouts by its size, as a narrowed window or a turned
    // tablet does: 390 x 844 with touch is a phone, 1280 x 820 with a mouse is the laptop.
    const F = (s) => `phone, review fixes: ${s}`;
    const phone = PHONES[0];
    const seen = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]"))`;
    const row = (name) => `$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)})`;
    const settle = async () => { await frames2(); await sleep(250); };
    /** The window becomes the laptop: 1280 x 820, a mouse. */
    const widen = async () => {
      await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
      await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
      await until(`!$(".app-shell[data-phone]") && !!$(".app-shell")`);
      await settle();
    };
    /** The window becomes a phone again: 390 x 844, touch. */
    const narrow = async () => {
      await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
      await until(`!!$(".app-shell[data-phone]")`);
      await settle();
    };
    const reload = async () => {
      await b.cmd("Page.reload");
      await sleep(300);
      await until(`!!document.querySelector(".pb-shell")`, 6000);
      await settle();
    };
    const openKaja = async () => {
      await tap(row("Kaja"));
      return until(`$(".app-main")?.getAttribute("aria-label") === "Kaja" && $(".app-shell").dataset.phoneScreen === "bot"`);
    };
    /** On a phone: the bot's page on a tab. */
    const pageTab = async (tab) => {
      await tap(seen(".app-phone-page"));
      await until(`!!${seen(`.pb-tab[data-tab="${tab}"]`)}`);
      await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
      return until(`$(".app-tabpanel")?.dataset.tab === "${tab}"`);
    };
    const editorNow = () => ev(`(() => { const t = $(".app-main .pb-editor-text"); if (!t || !t.checkVisibility({ visibilityProperty: true })) return null; return { value: t.value, state: $(".app-main .pb-editor-state").textContent, unsaved: window.pobotsState().unsaved?.what ?? null }; })()`);
    // Photos: made in the page; the browser's decoding of each waits at a gate the check opens, so a
    // photo stays "Preparing" for as long as the check wants.
    await b.cmd("Page.enable");
    await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__fix = {
        picture: (name, w, h) => new Promise((r) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#4f5ae8"; g.fillRect(0, 0, w, h); c.toBlob((b) => r(new File([b], name, { type: "image/png" })), "image/png"); }),
        paste: (files) => { const t = document.querySelector(".app-main .pb-composer textarea"); const dt = new DataTransfer(); for (const f of files) dt.items.add(f); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; },
        gate: () => { const own = window.createImageBitmap; const f = window.__fix; f.started = []; f.open = 0; f.most = 0; f.gates = [];
          // Only the box's own decoding of a photo (it asks for the photo upright); the mock engine's reading of an upload goes on.
          window.createImageBitmap = async (...a) => { if (!a[1]?.imageOrientation) return own.apply(window, a); f.started.push(a[0]?.name ?? "?"); f.open++; f.most = Math.max(f.most, f.open); try { await new Promise((r) => f.gates.push(r)); return await own.apply(window, a); } finally { f.open--; } };
          return true; },
        release: () => { const r = window.__fix.gates.shift(); if (r) r(); return !!r; },
      };`,
    });
    const chipsNow = () => ev(`$$(".app-main .pb-chip-file").map((c) => ({ name: c.querySelector(".pb-chip-name").dataset.name, status: c.dataset.status, meta: c.querySelector(".pb-chip-meta")?.textContent ?? "" }))`);
    const youSaid = (botThread, text) => `(window.pobotsState().threads[${JSON.stringify(botThread)}]?.items ?? []).filter((i) => i.kind === "user" && i.from.type === "you" && i.text === ${JSON.stringify(text)})`;

    // ---------------- 1. unsaved text survives the window crossing between the layouts
    await openPhone("", { phone });
    await openKaja();
    await pageTab("job");
    await until(`!!$(".app-main .pb-editor-text") && !$(".app-main .pb-editor-text").disabled`);
    const jobSaved = await ev(`$(".app-main .pb-editor-text").value`);
    await ev(`(() => { const t = $(".app-main .pb-editor-text"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
    await type("\nA line not saved yet.");
    const jobTyped = await editorNow();
    await widen();
    const jobWide = await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && { value: t.value, state: $(".app-main .pb-editor-state").textContent, unsaved: window.pobotsState().unsaved?.what ?? null }; })()`);
    check(F("1. Job: unsaved text, its Not saved and the question before leaving are the same after the window widens"), !!jobTyped && jobTyped.value.endsWith("A line not saved yet.") && JSON.stringify(jobWide) === JSON.stringify(jobTyped) && jobWide.state === "Not saved" && jobWide.unsaved === "the job", { jobTyped, jobWide });
    await ev(`click($('.pb-tab[data-tab="chat"]'))`);
    const asks = await until(`!!btn("Keep editing")`, 2000);
    check(F("1. Job, on the laptop: leaving still asks first"), !!asks);
    if (asks) await ev(`click(btn("Keep editing"))`);
    await narrow();
    const jobNarrow = await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && t.checkVisibility({ visibilityProperty: true }) && { value: t.value, state: $(".app-main .pb-editor-state").textContent, unsaved: window.pobotsState().unsaved?.what ?? null }; })()`);
    check(F("1. Job: and the same again when it becomes a phone again"), JSON.stringify(jobNarrow) === JSON.stringify(jobTyped), { jobNarrow, jobTyped });
    // Left without saving on purpose: the text is gone, and does not come back.
    await tap(seen(".app-phone-back"));
    await until(`!!btn("Leave without saving")`, 2000);
    await ev(`click(btn("Leave without saving"))`);
    await until(`$(".app-tabpanel")?.dataset.tab === "chat"`);
    await pageTab("job");
    const jobAgain = await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && { value: t.value, state: $(".app-main .pb-editor-state").textContent }; })()`);
    check(F("1. Job: text left without saving on purpose does not come back"), jobAgain?.value === jobSaved && jobAgain.state === "", { jobAgain, jobSaved });

    // A file of the Files tab.
    await openPhone("", { phone });
    await openKaja();
    await pageTab("files");
    await until(`$$(".pb-file").length > 1`);
    await ev(`click($$(".pb-file")[1])`);
    await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && t.checkVisibility({ visibilityProperty: true }); })()`);
    await ev(`(() => { const t = $(".app-main .pb-editor-text"); t.focus(); t.setSelectionRange(0, 0); return true; })()`);
    await type("A note not saved yet.\n");
    const fileTyped = await editorNow();
    await widen();
    const fileWide = await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && { value: t.value, state: $(".app-main .pb-editor-state").textContent, unsaved: window.pobotsState().unsaved?.what ?? null }; })()`);
    check(F("1. Files: unsaved text in a file is the same after the window widens"), !!fileTyped && fileTyped.value.startsWith("A note not saved yet.") && JSON.stringify(fileWide) === JSON.stringify(fileTyped), { fileTyped, fileWide });
    await narrow();
    const fileNarrow = await until(`(() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && t.checkVisibility({ visibilityProperty: true }) && { value: t.value, state: $(".app-main .pb-editor-state").textContent, unsaved: window.pobotsState().unsaved?.what ?? null }; })()`);
    check(F("1. Files: and on the phone again it shows the file with the text, not the list"), JSON.stringify(fileNarrow) === JSON.stringify(fileTyped), { fileNarrow, fileTyped });
    // Left without saving, so the page can be left without the browser asking.
    // (Since release 0.14 a file that is open is a step of its own: back leads to the list of files
    // first, then to the chat. See "phone, release fixes" below.)
    await tap(seen(".app-phone-back"));
    await until(`!!btn("Leave without saving")`, 2000);
    await ev(`click(btn("Leave without saving"))`);
    await until(`$(".app-files")?.dataset.show === "list" && !(history.state?.pobotsLayers ?? []).length`, 3000);
    await tap(seen(".app-phone-back"));
    check(F("1. Files: leaving without saving still works after the crossings"), !!(await until(`$(".app-tabpanel")?.dataset.tab === "chat" && !window.pobotsState().unsaved`)));

    // A typed answer on a card.
    await openPhone("typed=1", { phone });
    await tap(`$(".app-needs-row")`);
    await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
    const typedCard = `$$(".app-rail .pb-card").find((c) => c.querySelector(".app-card-answer"))`;
    await ev(`(() => { const c = ${typedCard}; c.scrollIntoView({ block: "center" }); c.querySelector("input").focus(); return true; })()`);
    await type("An answer not sent yet");
    await widen();
    const answerWide = await ev(`${typedCard}?.querySelector("input").value`);
    check(F("1. a typed answer on a card is the same after the window widens"), answerWide === "An answer not sent yet", answerWide);

    // Add a bot.
    await openPhone("", { phone });
    await tap(seen(".app-add-bot"));
    await until(`!!$("#add-name")`);
    await ev(`$("#add-name").focus()`);
    await type("Reports");
    await widen();
    const addWide = await until(`$("#add-name")?.value`, 2000);
    check(F("1. Add a bot: the name typed is still there after the window widens"), addWide === "Reports", addWide);
    await key("Escape");

    // A bot's settings: a field that saves when it is left saves when the window crosses too.
    await openPhone("", { phone });
    await openKaja();
    await pageTab("settings");
    const purpose = `$('.app-tabpanel input[id$="-purpose"]')`;
    await until(`!!${purpose}`);
    await ev(`(() => { const i = ${purpose}; i.focus(); i.select(); return true; })()`);
    await type("Keeps the onboarding notes");
    await widen();
    const purposeSaved = await until(`window.pobotsState().bots.find((x) => x.name === "Kaja")?.purpose === "Keeps the onboarding notes" && $('.app-tabpanel input[id$="-purpose"]')?.value`, 3000);
    check(F("1. a bot's settings: a field being typed in is saved when the window widens"), purposeSaved === "Keeps the onboarding notes", purposeSaved);

    // ---------------- 2. a send that was promised still happens, once, in that bot's chat
    for (const way of ["phone to laptop", "laptop to phone"]) {
      const words = `Sent once, ${way}`;
      await openPhone("", { phone });
      await openKaja();
      await ev(`window.__fix.gate()`);
      await ev(`window.__fix.picture("IMG_3001.png", 3000, 2000).then((f) => window.__fix.paste([f]))`);
      await until(`$(".app-main .pb-chip-file")?.dataset.status === "preparing"`);
      await ev(`$(".app-main .pb-composer textarea").focus()`);
      await type(words);
      if (way === "phone to laptop") {
        await tap(`$(".app-main .pb-send")`);
        await until(`!!$(".app-main .pb-send[data-waiting]")`, 2000);
        await widen();
      } else {
        await widen();
        await ev(`click($(".app-main .pb-send"))`);
        await until(`!!$(".app-main .pb-send[data-waiting]")`, 2000);
        await narrow();
      }
      const stillWaiting = await ev(`({ waiting: !!$(".app-main .pb-send[data-waiting]"), bot: $(".app-main")?.getAttribute("aria-label"), text: $(".app-main .pb-composer textarea")?.value })`);
      await ev(`window.__fix.release()`);
      const went = await until(`${youSaid("kaja-main", words)}.length === 1 && ${youSaid("kaja-main", words)}[0].attachments?.length === 1`, 8000);
      await sleep(800);
      const count = await ev(`${youSaid("kaja-main", words)}.length`);
      const elsewhere = await ev(`Object.entries(window.pobotsState().threads).filter(([id]) => id !== "kaja-main").some(([, t]) => t.items.some((i) => i.kind === "user" && i.text === ${JSON.stringify(words)}))`);
      check(F(`2. ${way}: Send pressed while a photo was prepared still waits after the window crossed, and sends once in Kaja's chat when it is done`), stillWaiting?.waiting && stillWaiting.bot === "Kaja" && !!went && count === 1 && elsewhere === false, { stillWaiting, went, count, elsewhere });
    }

    // ---------------- 3. Back after the window stopped being a phone
    await openPhone("", { phone });
    await openKaja();
    await pageTab("job");
    await widen();
    const leftState = await ev(`({ phone: history.state?.pobotsPhone ?? null, depth: history.state?.pobotsPhoneDepth ?? null })`);
    await ev(`(window.__stillHere = true)`);
    await ev(`(history.back(), true)`);
    await sleep(900);
    const afterBack = await ev(`window.__stillHere === true`);
    check(F("3. a phone widened: the phone's entries are gone from under it, so Back goes somewhere (here: the page before) instead of a dead step"), leftState?.phone === null && leftState.depth === null && afterBack !== true, { leftState, afterBack });
    // A helper's thread stays as it shows; the laptop's Back closes it, as it does on the laptop.
    await openPhone("scene=helpers", { phone });
    await openKaja();
    await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
    await until(`$$(".app-main .pb-thread .pb-helper").length > 0`);
    await ev(`$(".app-main .pb-thread .pb-helper").click()`);
    await until(`!!$(".pb-helper-bar")`);
    await pageTab("job");
    await widen();
    const helperWide = await ev(`({ open: (window.pobotsState().helpers.kaja ?? []).length, tab: $(".app-tabpanel")?.dataset.tab, entry: (history.state?.pobotsHelpers?.kaja ?? []).length, before: history.state?.pobotsHelpersBefore ? Object.keys(history.state.pobotsHelpersBefore).length : null })`);
    await ev(`(history.back(), true)`);
    const helperBack = await until(`(window.pobotsState().helpers.kaja ?? []).length === 0 && { tab: $(".app-tabpanel")?.dataset.tab, phone: history.state?.pobotsPhone ?? null }`, 2000);
    check(F("3. a phone with a helper's thread widened: the thread stays open; one Back closes it, as the laptop's own entry"), helperWide?.open === 1 && helperWide.tab === "job" && helperWide.entry === 1 && helperWide.before === 0 && helperBack?.phone === null, { helperWide, helperBack });
    // A laptop that never was a phone makes the entries it always made.
    await leavePhone();
    await open("scene=helpers");
    const lap0 = await ev(`history.length`);
    await goTo("Kaja");
    await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
    await until(`$$(".app-main .pb-thread .pb-helper").length > 0`);
    await ev(`$(".app-main .pb-thread .pb-helper").click()`);
    await until(`!!$(".pb-helper-bar")`);
    const lap1 = await ev(`({ len: history.length, keys: Object.keys(history.state ?? {}).sort().join(",") })`);
    await ev(`click($(".app-side .pb-foot-settings"))`);
    await until(`!!$(".app-appsettings")`);
    const lap2 = await ev(`({ len: history.length, keys: Object.keys(history.state ?? {}).sort().join(",") })`);
    check(F("3. a laptop that never was a phone: a helper's thread is one entry, Pobots settings none, and no phone marks"), lap1?.len === lap0 + 1 && lap1.keys === "pobotsHelpers,pobotsHelpersBefore" && lap2?.len === lap1.len && lap2.keys === "pobotsAppSettings,pobotsHelpers,pobotsHelpersBefore", { lap0, lap1, lap2 });

    // ---------------- 4. Pobots settings across a crossing: what shows is what a reload keeps
    await leavePhone();
    await until(`!!$(".app-side .pb-foot-settings")`, 6000);
    await ev(`click($(".app-side .pb-foot-settings"))`);
    await until(`!!$(".app-appsettings")`);
    await narrow();
    const narrowed = await ev(`$(".app-shell")?.dataset.phoneSheet`);
    await reload();
    const narrowReload = await ev(`$(".app-shell")?.dataset.phoneSheet`);
    await tap(seen(".app-phone-back"));
    await until(`!$(".app-appsettings")`);
    await widen();
    const closedWide = await ev(`!!$(".app-appsettings")`);
    await reload();
    const closedReload = await ev(`!!$(".app-appsettings")`);
    check(F("4. settings opened on the laptop, then a phone (and a reload there), closed on the phone: widened and reloaded they stay closed"), narrowed === "settings" && narrowReload === "settings" && closedWide === false && closedReload === false, { narrowed, narrowReload, closedWide, closedReload });
    await openPhone("", { phone });
    await ev(`$(".app-side").scrollTop = 99999`);
    await tap(`$(".app-side .pb-foot-settings")`);
    await until(`$(".app-shell").dataset.phoneSheet === "settings"`);
    await widen();
    const openWide = await ev(`!!$(".app-appsettings")`);
    await reload();
    const openReload = await ev(`!!$(".app-appsettings")`);
    check(F("4. settings opened on a phone, then widened: a reload keeps them open"), openWide === true && openReload === true, { openWide, openReload });

    // ---------------- 5. a reload with the large picture or a dialog open leaves no dead Back step
    await openPhone("files=fresh", { phone });
    await tap(row("HubSpot tickets"));
    await until(`$$(".app-main .pb-picture").length >= 2`);
    await ev(`inPanel($$(".app-main .pb-picture")[0])`);
    await settle();
    await tap(`$$(".app-main .pb-picture")[0]`);
    await until(`!!$(".pb-picture-view")`);
    await reload();
    const afterPictureReload = await ev(`({ picture: !!$(".pb-picture-view"), screen: $(".app-shell")?.dataset.phoneScreen })`);
    await ev(`(history.back(), true)`);
    const pictureBack = await until(`$(".app-shell")?.dataset.phoneScreen === "bots"`, 2500);
    check(F("5. a reload with a picture open large: it shows the chat, and one Back goes to Bots"), afterPictureReload?.picture === false && afterPictureReload.screen === "bot" && !!pictureBack, { afterPictureReload, pictureBack });
    await openPhone("", { phone });
    await openKaja();
    await pageTab("triggers");
    await tap(`$(".app-new-trigger")`);
    await until(`!!$(".pb-dialog")`);
    await reload();
    const afterDialogReload = await ev(`({ dialog: !!$(".pb-dialog"), sheet: $(".app-shell")?.dataset.phoneSheet ?? null, tab: $(".app-tabpanel")?.dataset.tab })`);
    await ev(`(history.back(), true)`);
    const dialogBack = await until(`!$(".app-shell")?.dataset.phoneSheet && $(".app-tabpanel")?.dataset.tab === "chat"`, 2500);
    check(F("5. a reload with a dialog open: it shows the page, and one Back goes to the chat"), afterDialogReload?.dialog === false && afterDialogReload.sheet === "page" && afterDialogReload.tab === "triggers" && !!dialogBack, { afterDialogReload, dialogBack });

    // ---------------- 6. photos are prepared one at a time, in the order chosen
    await openPhone("", { phone });
    await openKaja();
    await ev(`window.__fix.gate()`);
    await ev(`Promise.all(["P1.png", "P2.png", "P3.png", "P4.png"].map((n) => window.__fix.picture(n, 3000, 2000))).then((fs) => window.__fix.paste(fs))`);
    await until(`$$(".app-main .pb-chip-file").length === 4`);
    await sleep(400);
    const queued = { started: await ev(`[...window.__fix.started]`), chips: await chipsNow() };
    check(F("6. four photos chosen: one is prepared, the others wait their turn, all four say Preparing in their order"), JSON.stringify(queued.started) === JSON.stringify(["P1.png"]) && queued.chips?.map((c) => c.name).join() === "P1.png,P2.png,P3.png,P4.png" && queued.chips.every((c) => c.status === "preparing" && c.meta === "Preparing"), queued);
    // One that waits is taken out; the first finishes and the next in order starts.
    await ev(`click($('.app-main .pb-chip-file[data-chip] .pb-chip-remove[aria-label="Remove P3.png"]'))`);
    await ev(`window.__fix.release()`);
    await until(`window.__fix.started.length === 2`, 4000);
    await sleep(200);
    const second = await ev(`[...window.__fix.started]`);
    // The one being prepared is taken out: the next one does not wait for it.
    await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove P2.png"]'))`);
    const third = await until(`window.__fix.started.length === 3 && [...window.__fix.started]`, 3000);
    check(F("6. the next starts when one is done, a removed one is skipped, and removing the one being prepared does not hold the next up"), JSON.stringify(second) === JSON.stringify(["P1.png", "P2.png"]) && JSON.stringify(third) === JSON.stringify(["P1.png", "P2.png", "P4.png"]), { second, third });
    await ev(`$(".app-main .pb-composer textarea").focus()`);
    await type("Two photos");
    await tap(`$(".app-main .pb-send")`);
    await sleep(500);
    const heldBack = await ev(`${youSaid("kaja-main", "Two photos")}.length`);
    while (await ev(`window.__fix.release()`)) await sleep(50);
    const twoSent = await until(`(() => { const m = ${youSaid("kaja-main", "Two photos")}; return m.length === 1 && m[0].attachments?.map((a) => a.name).join(); })()`, 8000);
    check(F("6. Send waits for every photo still waiting, then sends them in their order"), heldBack === 0 && twoSent === "P1.jpg,P4.jpg" && (await ev(`window.__fix.most`)) <= 2, { heldBack, twoSent, most: await ev(`window.__fix.most`) });

    // ---------------- 7. the model sheet keeps Tab inside and gives the focus back
    await openPhone("", { phone });
    await openKaja();
    const modelButton = `$(".app-main .pb-composer-bar .pb-btn-sm")`;
    await ev(`${modelButton}.focus()`);
    await tap(modelButton);
    await until(`!!$(".app-picker") && document.activeElement === $(".app-picker")`);
    await key("Tab", 8);
    const shiftFromSheet = await ev(`$(".app-picker").contains(document.activeElement) && document.activeElement !== $(".app-picker")`);
    const outside = [];
    for (let i = 0; i < 24; i++) {
      await key("Tab");
      const inside = await ev(`$(".app-picker").contains(document.activeElement)`);
      if (!inside) outside.push(await ev(`document.activeElement?.className || document.activeElement?.tagName`));
    }
    await key("Escape");
    const back = await until(`!$(".app-picker") && document.activeElement === ${modelButton}`, 2000);
    check(F("7. on a phone Tab and Shift+Tab stay inside the model sheet, and closing it gives the focus back to the model button"), shiftFromSheet === true && outside.length === 0 && !!back, { shiftFromSheet, outside: outside.slice(0, 4), back });

    // ---------------- 8. a photo chip keeps its width from Preparing to Uploading to its size
    await openPhone("", { phone });
    await openKaja();
    await ev(`window.__fix.gate()`);
    await ev(`Promise.all(["a.png", "b.png", "c.png"].map((n) => window.__fix.picture(n, 3000, 2000))).then((fs) => window.__fix.paste(fs))`);
    await until(`$$(".app-main .pb-chip-file").length === 3`);
    await settle();
    await ev(`(() => { window.__cw = []; window.__cwOn = true; const step = () => { if (!window.__cwOn) return; window.__cw.push($$(".app-main .pb-chip-file").map((c) => { const r = c.getBoundingClientRect(); return { name: c.dataset.chip, meta: c.querySelector(".pb-chip-meta")?.textContent, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 }; })); requestAnimationFrame(step); }; requestAnimationFrame(step); return true; })()`);
    for (let i = 0; i < 3; i++) {
      await ev(`window.__fix.release()`);
      await sleep(400);
    }
    await until(`$$(".app-main .pb-chip-file").every((c) => c.dataset.status === "done")`, 6000);
    await sleep(200);
    const chipFrames = await ev(`(() => { window.__cwOn = false; return window.__cw; })()`);
    const chipSpread = {};
    for (const f of chipFrames ?? []) for (const c of f) {
      const s = (chipSpread[c.name] ??= { lefts: new Set(), widths: new Set(), metas: new Set() });
      s.lefts.add(c.left);
      s.widths.add(c.width);
      s.metas.add(c.meta);
    }
    const chipsSteady = Object.entries(chipSpread).map(([name, s]) => ({ name, lefts: [...s.lefts], widths: [...s.widths], metas: [...s.metas] }));
    check(F("8. on a phone each chip keeps its width and place while it goes from Preparing to Uploading to its size"), chipsSteady.length === 3 && chipsSteady.every((c) => c.lefts.length === 1 && c.widths.length === 1 && c.metas.includes("Preparing") && c.metas.includes("Uploading") && c.metas.some((m) => /KB|MB/.test(m))), chipsSteady);
    await leavePhone();
    await open("");
    await goTo("Kaja");
    await ev(`window.__fix.picture("a.png", 300, 200).then((f) => window.__fix.paste([f]))`);
    await until(`$(".app-main .pb-chip-file")?.dataset.status === "done"`, 4000);
    const laptopChip = await ev(`getComputedStyle($(".app-main .pb-chip-meta"), "::before").content`);
    check(F("8. the laptop's chips are untouched (no room held for Preparing)"), laptopChip === "none", laptopChip);

    // ================ second round: five more points, all about a window crossing between the layouts
    const R = (s) => F(`second round, ${s}`);
    /** Where the tab stands in its history: the entry it is on, and how many entries there are. */
    const navNow = async () => {
      const r = (await b.cmd("Page.getNavigationHistory")).result;
      return { at: r.currentIndex, count: r.entries.length };
    };
    const phoneKeys = `Object.keys(history.state ?? {}).filter((k) => ["pobotsPhone", "pobotsPhoneBefore", "pobotsPhoneDepth", "pobotsLayers"].includes(k)).sort().join(",")`;

    // ---------------- 1. a trigger's form keeps what was typed, and its sheet stays open, across a crossing
    await openPhone("", { phone });
    await openKaja();
    await pageTab("triggers");
    await tap(`$(".app-new-trigger")`);
    await until(`!!$("#new-trigger-name")`);
    await ev(`$("#new-trigger-name").focus()`);
    await type("Plan for the day");
    await ev(`$("#new-trigger-prompt").focus()`);
    await type("Read the calendar.\nWrite a short plan for today.");
    await ev(`click($$(".pb-dialog .pb-sched > .pb-seg button").find((x) => x.textContent.trim() === "Every"))`);
    await until(`!!$("#new-trigger-every")`);
    await ev(`(() => { const i = $("#new-trigger-every"); i.focus(); i.select(); return true; })()`);
    await type("45");
    const sheetNow = `(() => { if (!$(".pb-dialog") || !$("#new-trigger-name")) return null; return { name: $("#new-trigger-name").value, prompt: $("#new-trigger-prompt").value, every: $("#new-trigger-every")?.value ?? null, mode: $$(".pb-dialog .pb-sched > .pb-seg button").find((x) => x.getAttribute("aria-pressed") === "true")?.textContent.trim() ?? null }; })()`;
    const sheetTyped = await ev(sheetNow);
    await widen();
    const sheetWide = await until(sheetNow, 2000);
    await narrow();
    const sheetNarrow = await until(sheetNow, 2000);
    check(R("1. New trigger: the sheet is open again with the name, what the bot is told and the times, after the window widens and after it narrows again"), sheetTyped?.name === "Plan for the day" && sheetTyped.every === "45" && sheetTyped.mode === "Every" && JSON.stringify(sheetWide) === JSON.stringify(sheetTyped) && JSON.stringify(sheetNarrow) === JSON.stringify(sheetTyped), { sheetTyped, sheetWide, sheetNarrow });
    await ev(`click(btn("Create trigger"))`);
    const created = await until(`!$(".pb-dialog") && $(".pb-trigger-head-name")?.textContent === "Plan for the day" && (window.pobotsState().triggers.kaja ?? []).find((t) => t.name === "Plan for the day")?.schedule?.minutes`, 3000);
    check(R("1. New trigger: and creating it from there works as before"), created === 45, created ?? (await ev(`({ dialog: !!$(".pb-dialog"), head: $(".pb-trigger-head-name")?.textContent, triggers: (window.pobotsState().triggers.kaja ?? []).map((t) => [t.name, t.schedule]) })`)));
    // The trigger's own form: a change not saved yet.
    const pagePrompt = `$('.pb-trigger-page textarea[id$="-prompt"]')`;
    await ev(`(() => { const t = ${pagePrompt}; t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
    await type("\nThen list the meetings.");
    const pageNow = `(() => { const t = ${pagePrompt}; return t && t.checkVisibility({ visibilityProperty: true }) && { prompt: t.value, putBack: !!btn("Put back"), name: $(".pb-trigger-head-name")?.textContent }; })()`;
    const pageTyped = await ev(pageNow);
    await widen();
    const pageWide = await until(pageNow, 2000);
    await ev(`click(btn("Save"))`);
    const pageSaved = (await until(`(window.pobotsState().triggers.kaja ?? []).find((t) => t.name === "Plan for the day")?.prompt.endsWith("Then list the meetings.") && !btn("Put back")`, 3000)) ?? (await ev(`({ putBack: !!btn("Put back"), save: btn("Save")?.disabled, prompts: (window.pobotsState().triggers.kaja ?? []).map((t) => t.prompt) })`));
    check(R("1. a trigger's own form: a change not saved yet is the same after the window widens, and saving it there works"), !!pageTyped?.putBack && pageTyped.prompt.endsWith("Then list the meetings.") && JSON.stringify(pageWide) === JSON.stringify(pageTyped) && pageSaved === true, { pageTyped, pageWide, pageSaved });
    // A sheet closed after a crossing stays closed.
    await ev(`click(btn("All triggers"))`);
    await until(`!!$(".app-new-trigger")`);
    await ev(`click($(".app-new-trigger"))`);
    await until(`!!$("#new-trigger-name")`);
    await ev(`$("#new-trigger-name").focus()`);
    await type("Evening note");
    await narrow();
    const sheetOnPhone = await until(`$("#new-trigger-name")?.value`, 2000);
    const sheetsOnPhone = await ev(`$$(".pb-dialog").length`);
    await ev(`(btn("Cancel", $(".pb-dialog")).scrollIntoView({ block: "center" }), true)`);
    await settle();
    const cancelTapped = await tap(`btn("Cancel", $(".pb-dialog"))`);
    const cancelled = !!(await until(`!$(".pb-dialog")`, 2000));
    await widen();
    await narrow();
    const sheetGone = await ev(`({ dialog: $(".pb-dialog .pb-dialog-title")?.textContent ?? null, tab: $(".app-tabpanel")?.dataset.tab })`);
    check(R("1. New trigger: carried from the laptop to the phone, then cancelled there, it does not come back on the next crossings"), sheetOnPhone === "Evening note" && sheetsOnPhone === 1 && cancelTapped && cancelled && sheetGone?.dialog === null && sheetGone.tab === "triggers", { sheetOnPhone, sheetsOnPhone, cancelTapped, cancelled, sheetGone });

    // ---------------- 2. a name or purpose whose save failed as the window crossed is not lost
    await openPhone("", { phone });
    await openKaja();
    await pageTab("settings");
    const purposeField = `$('.app-tabpanel input[id$="-purpose"]')`;
    const purposeNow = `(() => { const i = ${purposeField}; if (!i) return null; const w = i.closest(".pb-field").querySelector(".pb-saved"); return { value: i.value, problem: w?.classList.contains("app-hint-error") ? w.textContent : null, saved: w?.dataset.show === "true" }; })()`;
    await until(`!!${purposeField}`);
    await ev(`(() => { const i = ${purposeField}; i.focus(); i.select(); return true; })()`);
    await type("Keeps the onboarding notes tidy");
    await ev(`window.pobotsMock.dropConnection()`);
    await widen();
    const failedWide = await until(`(() => { const p = ${purposeNow}; return p?.problem && p; })()`, 3000);
    await ev(`window.pobotsMock.restoreConnection()`);
    await sleep(700);
    const afterReconnect = await ev(purposeNow);
    check(R("2. a purpose typed on the phone, the window widened while the connection is down: the field shows the text and that it was not saved, also after the connection is back"), failedWide?.value === "Keeps the onboarding notes tidy" && /not reachable/.test(failedWide.problem) && afterReconnect?.value === "Keeps the onboarding notes tidy" && !!afterReconnect.problem, { failedWide, afterReconnect });
    await ev(`(() => { const i = ${purposeField}; i.focus(); i.blur(); return true; })()`);
    const triedAgain = await until(`window.pobotsState().bots.find((x) => x.name === "Kaja")?.purpose === "Keeps the onboarding notes tidy" && (() => { const p = ${purposeNow}; return !p.problem && p; })()`, 3000);
    check(R("2. and leaving the field tries again, which saves it"), triedAgain?.value === "Keeps the onboarding notes tidy", triedAgain);
    // A save that works as the window crosses: the other layout shows the text, then Saved.
    await ev(`(() => { const i = ${purposeField}; i.focus(); i.select(); return true; })()`);
    await type("Keeps the notes");
    await narrow();
    const savedNarrow = await until(`window.pobotsState().bots.find((x) => x.name === "Kaja")?.purpose === "Keeps the notes" && (() => { const p = ${purposeNow}; return p?.saved && p; })()`, 3000);
    check(R("2. a save that works as the window narrows: the phone's field shows the text and Saved"), savedNarrow?.value === "Keeps the notes" && !savedNarrow.problem, savedNarrow);

    // ---------------- 3. Keep editing after Back in an editor, then widened: every phone entry is stepped over
    await openPhone("", { phone });
    const start3 = await navNow();
    await openKaja();
    await pageTab("job");
    await until(`!!$(".app-main .pb-editor-text") && !$(".app-main .pb-editor-text").disabled`);
    const saved3 = await ev(`$(".app-main .pb-editor-text").value`);
    await ev(`(() => { const t = $(".app-main .pb-editor-text"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
    await type("\nA line kept.");
    await ev(`(history.back(), true)`);
    const askedKeep = await until(`!!btn("Keep editing")`, 2000);
    if (askedKeep) await ev(`click(btn("Keep editing"))`);
    await until(`!btn("Keep editing")`, 2000);
    await settle();
    const kept3 = { depth: await ev(`history.state?.pobotsPhoneDepth ?? 0`), tab: await ev(`$(".app-tabpanel")?.dataset.tab`) };
    await widen();
    const wide3 = { ...(await navNow()), keys: await ev(phoneKeys) };
    check(R("3. Back in an editor with unsaved text, Keep editing, then the window widens: it steps back over exactly the phone's entries"), !!askedKeep && kept3.depth === 2 && kept3.tab === "job" && wide3.at === start3.at && wide3.keys === "", { start3, kept3, wide3 });
    // The text as it was saved, so nothing is left unsaved for the next page.
    await ev(`(() => { const t = $(".app-main .pb-editor-text"); t.focus(); t.select(); return true; })()`);
    await type(saved3);
    await until(`!window.pobotsState().unsaved`, 2000);

    // ---------------- 4. a fast crossing closes nothing
    // The window is widened and narrowed again before the step back over the phone's entries has
    // landed. Here the step back is held for a moment, as a slow phone or tablet may hold it.
    await openPhone("", { phone });
    const start4 = await navNow();
    await openKaja();
    await pageTab("triggers");
    await tap(`$(".app-new-trigger")`);
    await until(`!!$("#new-trigger-name")`);
    await ev(`$("#new-trigger-name").focus()`);
    await type("Noon check");
    await ev(`(() => { const go = history.go.bind(history); history.go = (n) => { setTimeout(() => go(n), 900); }; return true; })()`);
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await until(`!$(".app-shell[data-phone]") && !!$(".app-shell")`);
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
    await until(`!!$(".app-shell[data-phone]")`);
    await sleep(1600);
    await settle();
    const fast4 = { ...(await navNow()), name: await ev(`$("#new-trigger-name")?.value ?? null`), layers: await ev(`(history.state?.pobotsLayers ?? []).length`), depth: await ev(`history.state?.pobotsPhoneDepth ?? 0`), sheet: await ev(`$(".app-shell")?.dataset.phoneSheet ?? null`) };
    await ev(`(history.back(), true)`);
    const back4 = await until(`!$(".pb-dialog") && { sheet: $(".app-shell")?.dataset.phoneSheet ?? null, tab: $(".app-tabpanel")?.dataset.tab, depth: history.state?.pobotsPhoneDepth ?? 0, layers: (history.state?.pobotsLayers ?? []).length }`, 2000);
    const nav4 = await navNow();
    check(R("4. widened and narrowed again before the history move landed: the sheet open stays open, one phone entry over the screen, and Back closes it"), fast4.name === "Noon check" && fast4.layers === 1 && fast4.depth === 1 && fast4.sheet === "page" && fast4.at === start4.at + 1 && fast4.count === start4.at + 2 && back4?.sheet === "page" && back4.tab === "triggers" && back4.depth === 0 && back4.layers === 0 && nav4.at === start4.at, { start4, fast4, back4, nav4 });

    // ---------------- 5. a reload at laptop width on an entry a phone made with a layer open
    await openPhone("", { phone });
    const made5 = [await ev(`history.state`)];
    await openKaja();
    made5.push(await ev(`history.state`));
    await pageTab("triggers");
    made5.push(await ev(`history.state`));
    await tap(`$(".app-new-trigger")`);
    await until(`!!$(".pb-dialog")`);
    made5.push(await ev(`history.state`));
    // The same entries in a window that is the laptop when it loads (a tablet turned while the page slept, say).
    await leavePhone();
    await ev(`(() => { const s = ${JSON.stringify(made5)}; history.replaceState(s[0], ""); for (const x of s.slice(1)) history.pushState(x, ""); return true; })()`);
    const top5 = await navNow();
    const url5 = await ev(`location.href`);
    await b.cmd("Page.reload");
    await sleep(300);
    await until(`!!document.querySelector(".pb-shell")`, 6000);
    await sleep(900);
    const after5 = { ...(await navNow()), url: await ev(`location.href`), keys: await ev(phoneKeys), phone: await ev(`!!$(".app-shell[data-phone]")`) };
    check(R("5. a reload at laptop width on an entry a phone made with a dialog open: it lands where the phone started, once, with no phone entry left behind"), made5[3]?.pobotsLayers?.length === 1 && made5[3].pobotsPhoneDepth === 3 && after5.at === top5.at - 3 && after5.url === url5 && after5.keys === "" && after5.phone === false, { top5, after5, layer: made5[3]?.pobotsLayers, depth: made5[3]?.pobotsPhoneDepth });
    // A laptop that never was a phone makes the history calls at load it always made.
    await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
      source: `if (location.search.includes("histcount=1")) { window.__hist = []; for (const m of ["go", "back", "forward", "pushState", "replaceState"]) { const own = History.prototype[m]; History.prototype[m] = function (...a) { window.__hist.push(m); return own.apply(this, a); }; } }`,
    });
    await open("histcount=1");
    await sleep(500);
    const laptopCalls = await ev(`(window.__hist ?? ["not counted"]).join(",")`);
    check(R("5. a laptop that never was a phone: no history call at load"), laptopCalls === "", laptopCalls);
  }
  // <<<< phone, review fixes <<<<

  // >>>> phone, release fixes (docs/build/step-phone-result.md, what the tester found) >>>>
  phoneRelease: {
    // Three things a tester found at phone size on the test copy. Each check here failed on the code
    // before its fix.
    const row = (name) => `$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)})`;
    const seen = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]"))`;
    const settle = async () => { await frames2(); await sleep(250); };
    const scroller = `$(".app-main .pb-main-scroll")`;
    /** Where the window is: the screen, the page's tab, list or file in Files, the layers, where back leads. */
    const place = () => ev(`({ screen: $(".app-shell")?.dataset.phoneScreen ?? null, tab: $(".app-tabpanel")?.dataset.tab ?? null, show: $(".app-files")?.dataset.show ?? null, layers: (history.state?.pobotsLayers ?? []).length, back: ${seen(".app-phone-back")}?.getAttribute("aria-label") ?? null, ask: !!btn("Keep editing") })`);
    const at = (p, want) => !!p && Object.entries(want).every(([k, v]) => p[k] === v);
    const navAt = async () => (await b.cmd("Page.getNavigationHistory")).result.currentIndex;
    const openKaja = async () => {
      await tap(row("Kaja"));
      return until(`$(".app-main")?.getAttribute("aria-label") === "Kaja" && $(".app-shell").dataset.phoneScreen === "bot"`);
    };
    const filesTab = async () => {
      await tap(seen(".app-phone-page"));
      await until(`!!${seen('.pb-tab[data-tab="files"]')}`);
      await ev(`click($('.pb-tab[data-tab="files"]'))`);
      await until(`$(".app-tabpanel")?.dataset.tab === "files" && $$(".pb-file").length > 1`);
      await settle();
    };
    const openFile = async () => {
      await tap(`$$(".pb-file")[1]`);
      await until(`$(".app-files")?.dataset.show === "file" && (() => { const t = $(".app-main .pb-editor-text"); return t && !t.disabled && t.checkVisibility({ visibilityProperty: true }); })()`);
      await settle();
    };
    const browserBack = async () => { await ev(`(history.back(), true)`); await settle(); };

    for (const phone of PHONES) {
      const P = (s) => `phone ${phone.tag}, release fixes: ${s}`;

      // ---------------- a. back from an open file goes one screen at a time
      await openPhone("", { phone });
      const start = await navAt();
      await openKaja();
      await filesTab();
      const listAt = await navAt();
      let p = await place();
      check(P("a. Files shows its list, and the way back says Chat"), at(p, { tab: "files", show: "list", layers: 0, back: "Back to Chat" }), p);
      await openFile();
      p = await place();
      check(P("a. a file that is open is a step of its own, and the way back says Files"), at(p, { show: "file", layers: 1, back: "Back to Files" }) && (await navAt()) === listAt + 1, { p, at: await navAt(), listAt });
      await tap(seen(".app-phone-back"));
      await settle();
      p = await place();
      check(P("a. the back control goes from the file to the list of files, not to the chat"), at(p, { screen: "bot", tab: "files", show: "list", layers: 0, back: "Back to Chat" }) && (await navAt()) === listAt, { p, at: await navAt(), listAt });
      await tap(seen(".app-phone-back"));
      await settle();
      p = await place();
      check(P("a. and from the list to the chat"), at(p, { screen: "bot", tab: "chat" }) && (await navAt()) === listAt - 1, p);
      // The same with the browser's back (Android's back, the iOS swipe).
      await filesTab();
      await openFile();
      await browserBack();
      p = await place();
      check(P("a. the browser's back goes from the file to the list of files"), at(p, { screen: "bot", tab: "files", show: "list", layers: 0 }), p);
      await browserBack();
      p = await place();
      check(P("a. then to the chat"), at(p, { screen: "bot", tab: "chat" }), p);
      await browserBack();
      p = await place();
      check(P("a. then to Bots, with no step that shows the same screen twice"), at(p, { screen: "bots" }) && (await navAt()) === start, { p, at: await navAt(), start });
      // The file's own "Files" control takes the same step.
      await openKaja();
      await filesTab();
      const listAt2 = await navAt();
      await openFile();
      await tap(seen(".app-files-back"));
      await settle();
      p = await place();
      check(P("a. the file's own Files control takes the same step back"), at(p, { tab: "files", show: "list", layers: 0 }) && (await navAt()) === listAt2, { p, at: await navAt(), listAt2 });
      // Unsaved text: every way back asks first, and Keep editing keeps the file and its step.
      await openFile();
      await ev(`(() => { const t = $(".app-main .pb-editor-text"); t.focus(); t.setSelectionRange(0, 0); return true; })()`);
      await type("Not saved. ");
      await until(`!!window.pobotsState().unsaved`);
      await browserBack();
      p = await place();
      check(P("a. with unsaved text the browser's back asks first and the file stays"), at(p, { show: "file", ask: true }), p);
      await ev(`click(btn("Keep editing"))`);
      await until(`!btn("Keep editing")`, 2000);
      await settle();
      p = await place();
      const keptText = await ev(`$(".app-main .pb-editor-text").value.startsWith("Not saved. ")`);
      check(P("a. Keep editing: the file shows with its text, still one step above the list"), at(p, { show: "file", layers: 1, back: "Back to Files", ask: false }) && keptText === true && (await navAt()) === listAt2 + 1, { p, keptText, at: await navAt(), listAt2 });
      await tap(seen(".app-phone-back"));
      await until(`!!btn("Leave without saving")`, 2000);
      await ev(`click(btn("Leave without saving"))`);
      await until(`$(".app-files")?.dataset.show === "list"`, 3000);
      await settle();
      p = await place();
      check(P("a. Leave without saving from the back control: the list of files, one step back"), at(p, { tab: "files", show: "list", layers: 0, ask: false }) && (await navAt()) === listAt2, { p, at: await navAt(), listAt2 });
      await browserBack();
      p = await place();
      check(P("a. and one more back is the chat"), at(p, { screen: "bot", tab: "chat" }), p);
      // Another tab chosen while a file is open: the file's step is gone first, so back from the new tab is the chat, as its control says.
      await filesTab();
      const listAt3 = await navAt();
      await openFile();
      await ev(`click($('.pb-tab[data-tab="history"]'))`);
      await until(`$(".app-tabpanel")?.dataset.tab === "history"`, 3000);
      await settle();
      p = await place();
      check(P("a. another tab chosen while a file is open: it shows in the page's own step, and the way back says Chat"), at(p, { tab: "history", layers: 0, back: "Back to Chat" }) && (await navAt()) === listAt3, { p, at: await navAt(), listAt3 });
      await browserBack();
      p = await place();
      check(P("a. and back from that tab is the chat"), at(p, { screen: "bot", tab: "chat" }), p);
      // A reload with a file open shows the list; back from it is the chat.
      await filesTab();
      await openFile();
      await b.cmd("Page.reload");
      await sleep(300);
      await until(`!!document.querySelector(".pb-shell") && $(".app-tabpanel")?.dataset.tab === "files"`, 6000);
      await settle();
      p = await place();
      check(P("a. a reload with a file open shows the list of files"), at(p, { tab: "files", show: "list", layers: 0 }), p);
      await browserBack();
      p = await place();
      check(P("a. and back from there is the chat"), at(p, { screen: "bot", tab: "chat" }), p);

      // ---------------- b and c. the chat keeps its place across the page, and nothing fades in again
      await openPhone("", { phone });
      await openKaja();
      await until(`${scroller}.scrollHeight > ${scroller}.clientHeight + 200`);
      await settle();
      await ev(`(() => { const s = ${scroller}; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 3); return true; })()`);
      await settle();
      const was = await ev(`(() => { const s = ${scroller}; const l = lineTop(s); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, line: l?.el.textContent.slice(0, 40), lineTop: Math.round(l?.top ?? -1) }; })()`);
      // Every frame from before the way back until the chat stands: where it is, and whether any
      // line is fading or rising. The first look is taken the moment the chat is in the page again,
      // before it is painted.
      const watch = `(() => { window.__rf = []; window.__rfOn = true;
        const look = (why) => { const s = document.querySelector(".app-main .pb-main-scroll"); if (!s) return; const lines = [...s.querySelectorAll(".pb-thread *")];
          window.__rf.push({ why, top: Math.round(s.scrollTop), dim: lines.filter((x) => +getComputedStyle(x).opacity < 1 && !x.closest("[aria-hidden]")).length, moving: s.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().endTime !== Infinity && a.playState === "running").length }); };
        window.__rfObs = new MutationObserver(() => look("change")); window.__rfObs.observe(document.querySelector(".app-shell"), { subtree: true, childList: true });
        const step = () => { if (!window.__rfOn) return; look("frame"); requestAnimationFrame(step); }; requestAnimationFrame(step); return true; })()`;
      const watched = `(() => { window.__rfOn = false; window.__rfObs.disconnect(); return window.__rf; })()`;
      for (const way of ["the back control", "the browser's back"]) {
        await tap(seen(".app-phone-page"));
        await until(`$(".app-tabpanel")?.dataset.tab !== "chat"`);
        await settle();
        await ev(watch);
        if (way === "the back control") await tap(seen(".app-phone-back"));
        else await ev(`(history.back(), true)`);
        await until(`$(".app-tabpanel")?.dataset.tab === "chat"`);
        await sleep(600);
        const f = await ev(watched);
        const now = await ev(`(() => { const s = ${scroller}; const l = lineTop(s); return { top: s.scrollTop, line: l?.el.textContent.slice(0, 40), lineTop: Math.round(l?.top ?? -1) }; })()`);
        check(P(`b. a chat scrolled up, the page opened, ${way}: the chat is exactly where it was`), was?.top > 0 && was.top < was.max - 100 && now?.top === was.top && now.line === was.line && now.lineTop === was.lineTop, { was, now });
        check(P(`b. ${way}: it is there from the first moment, never at the newest messages first`), Array.isArray(f) && f.length > 5 && f.every((x) => x.top === was.top), { was: was?.top, tops: [...new Set((f ?? []).map((x) => x.top))] });
        check(P(`c. ${way}: no line of the chat fades in or rises again, in any frame`), Array.isArray(f) && f.length > 5 && f.every((x) => x.dim === 0 && x.moving === 0), (f ?? []).filter((x) => x.dim || x.moving).slice(0, 3));
      }
      // A picture in view is simply there again: it does not fade in a second time.
      await openPhone("files=fresh", { phone });
      await tap(row("HubSpot tickets"));
      await until(`$(".app-main")?.getAttribute("aria-label") === "HubSpot tickets" && $$(".app-main .pb-picture").length >= 2 && $$(".app-main .pb-picture").every((p) => p.hasAttribute("data-shown"))`, 6000);
      await settle();
      const picsInView = `$$(".app-main .pb-picture").filter((p) => { const r = p.getBoundingClientRect(); const v = ${scroller}.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; }).length`;
      const inViewBefore = await ev(picsInView);
      await tap(seen(".app-phone-page"));
      await until(`$(".app-tabpanel")?.dataset.tab !== "chat"`);
      await settle();
      await ev(watch);
      await tap(seen(".app-phone-back"));
      await until(`$(".app-tabpanel")?.dataset.tab === "chat"`);
      await sleep(600);
      const pf = await ev(watched);
      check(P("c. pictures in view when the page opened are simply there on the way back: none fades in again"), inViewBefore >= 1 && (await ev(picsInView)) === inViewBefore && Array.isArray(pf) && pf.length > 5 && pf.every((x) => x.dim === 0 && x.moving === 0), { inViewBefore, bad: (pf ?? []).filter((x) => x.dim || x.moving).slice(0, 3) });
      await openPhone("", { phone });
      await openKaja();
      await until(`${scroller}.scrollHeight > ${scroller}.clientHeight + 200`);
      await settle();
      // A chat at its newest message stays there.
      await ev(`(() => { const s = ${scroller}; s.scrollTop = s.scrollHeight; return true; })()`);
      await settle();
      await tap(seen(".app-phone-page"));
      await until(`$(".app-tabpanel")?.dataset.tab !== "chat"`);
      await settle();
      await tap(seen(".app-phone-back"));
      await until(`$(".app-tabpanel")?.dataset.tab === "chat"`);
      await settle();
      const bottom = await ev(`(() => { const s = ${scroller}; return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); })()`);
      check(P("b. a chat at its newest message is at its newest message after the page"), bottom === 0, bottom);
    }
  }
  // <<<< phone, release fixes <<<<

  // The checks after this section open the page as a laptop again.
  await leavePhone();
  if (phoneShots) console.log(`Phone pictures in ${phoneShots}`);
  }
}
