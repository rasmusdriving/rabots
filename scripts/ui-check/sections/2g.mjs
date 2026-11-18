// The window check, section "2g". Run it alone: node scripts/ui-check.mjs --only=2g
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 2g: the browser beside the chat
export default async function section() {
  part2g: {
  // The mock's "browser" scene: Kaja's chat holds the "artifacts" scene's rows, a finished turn whose
  // workspace is closed (folded away) and one whose workspace Kaja left open ("Check the survey
  // settings", two pages, its row in sight); the person's own page and one workspace of another
  // program are open too. Pictures are a made-up page the mock draws as JPEG. Real pointer and keys
  // are sent with the DevTools protocol, so the window gets them as a person's. `window.open` and the
  // clipboard are stubbed: nothing is opened, nothing is read from the machine.
  {
  const BS = "scene=browser";
  const bRows = `$$(".app-main .pb-thread .pb-browser")`;
  const bRow = (space) => `${bRows}.filter((r) => r.dataset.spaceId === ${JSON.stringify(space)}).pop()`;
  const bPane = `$('.app-artifact[data-content="browser"]')`;
  const bTool = (label) => `$$(".pb-browser-tools .pb-tool").find((t) => t.getAttribute("aria-label").startsWith(${JSON.stringify(label)}))`;
  const bTools = `$$(".pb-browser-tools .pb-tool").map((t) => t.getAttribute("aria-label"))`;
  const stateLine = `text(".pb-browser-stateline")`;
  const shown = `!!$(".pb-browser-body[data-shown]")`;
  const take = `$(".pb-browser-take")`;
  const inputs = `window.pobotsMock.browserInputs()`;
  const flat = `${inputs}.flat()`;
  const reqs = (m) => `(window.pobotsMock.requests()[${JSON.stringify(m)}] ?? 0)`;
  const mode = `$(".app-shell").dataset.artifact`;
  const rowTopOf = (sel) => `(() => { const r = (${sel})?.getBoundingClientRect(); return r ? Math.round(r.top * 10) / 10 : null; })()`;
  const kept = (a, b2) => a !== null && b2 !== null && Math.abs(a - b2) <= 1;
  const readAt = (sel, offset = 60) => `(() => { const s = $(".app-main .pb-main-scroll"), el = ${sel}; s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - ${offset}; s.dispatchEvent(new Event("scroll")); return true; })()`;
  /** A point over the picture at a fraction of its drawn size, in the window's pixels. */
  const picAt = async (fx, fy) => ev(`(() => { const r = $(".pb-browser-canvas").getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy}, w: r.width, h: r.height }; })()`);
  const mouse = (type, x, y, extra = {}) => b.cmd("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1, ...extra });
  async function clickAt(x, y, clicks = 1) {
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y, { clickCount: clicks });
    await mouse("mouseReleased", x, y, { clickCount: clicks });
    await sleep(60);
  }
  /** One key down and up as a keyboard sends it. `mods` as the protocol's: 1 alt, 2 ctrl, 4 meta, 8 shift. */
  async function press(k, { code = k, text, mods = 0, vk } = {}) {
    const base = { key: k, code, modifiers: mods, ...(vk ? { windowsVirtualKeyCode: vk } : {}) };
    await b.cmd("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(30);
  }
  /** Samples the picture on every frame for a while: is anything ever empty? */
  const watchPicture = (ms) => `(async () => {
    const c = $(".pb-browser-canvas"), g = c.getContext("2d"), seen = { samples: 0, empty: 0, zero: 0, changes: 0 };
    let last = "";
    const end = performance.now() + ${ms};
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.samples++;
      if (!c.width || !c.height) { seen.zero++; continue; }
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 5), 1, 1).data;
      if (d[3] === 0) seen.empty++;
      const k = g.getImageData(0, 0, Math.min(400, c.width), Math.min(260, c.height)).data.filter((_, i) => i % 97 === 0).join();
      if (k !== last) { seen.changes++; last = k; }
    }
    return seen;
  })()`;
  const browserShots = arg("browser-shots") ?? (shots ? join(shots, "browser") : undefined);
  if (browserShots) mkdirSync(browserShots, { recursive: true });
  async function bShot(name, selector) {
    if (!browserShots) return;
    await sleep(500);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(browserShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const stubOutside = () =>
    ev(`(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return { opener: {}, focus() {} }; }; window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); return true; })()`);

  // ---------------- B3 before anything: no browser line where the browser cannot be reached
  await open("");
  check("the roster has no Browser line when the browser cannot be reached", (await ev(`!$(".pb-browser-line") && window.pobotsState().browser.available === false`)) === true);

  // ---------------- B1: the rows in the chat
  await open(BS);
  await stubOutside();
  await goTo("Kaja", "chat");
  check("Kaja's chat shows the row of the workspace Kaja left open", !!(await until(`!!${bRow("s-kaja")}`)));
  const open1 = await ev(`(() => { const r = ${bRow("s-kaja")}; return { name: r.querySelector(".pb-browser-name").textContent, last: r.querySelector(".pb-browser-last").textContent, word: r.querySelector(".pb-browser-word").textContent, status: r.dataset.status, folded: !!r.closest(".pb-answer[data-folded]"), inWork: !!r.closest(".pb-work"), height: Math.round(r.getBoundingClientRect().height * 10) / 10 }; })()`);
  check("the row: the workspace's name, the page in front as its muted line, Open at the right", open1?.name === "Check the survey settings" && open1.last === "Surveys · app.example.com" && open1.word === "Open" && open1.status === "open", open1);
  check("its turn is folded, and the row stays in sight with the answer while the workspace is open", open1?.folded && !open1.inWork, open1);
  check("the closed workspace's row folded away with its turn's work", (await ev(`!${bRow("s-aalto")}`)) === true);
  const bLook = await ev(`(() => {
    const r = ${bRow("s-kaja")}, s = getComputedStyle(r), mark = r.querySelector(".pb-browser-mark"), flow = r.closest(".pb-answer-flow");
    const helperLike = document.createElement("button"); helperLike.className = "pb-helper"; flow.append(helperLike); const hh = helperLike.getBoundingClientRect().height; helperLike.remove();
    return { face: !!r.querySelector(".pb-avatar"), drawn: !!mark.querySelector("svg rect") && !!mark.querySelector("svg path"), disc: parseFloat(getComputedStyle(mark).borderTopLeftRadius) >= 14 && getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)",
      flat: s.boxShadow === "none", wide: Math.abs(r.getBoundingClientRect().width - flow.getBoundingClientRect().width) <= 1, height: r.getBoundingClientRect().height, helper: hh, go: !!r.querySelector(".pb-browser-go svg") };
  })()`);
  check("the row has its own drawn window on a soft disc, never a face", bLook && !bLook.face && bLook.drawn && bLook.disc && bLook.go, bLook);
  check("the row is flat and as wide as the answer, at the helper row's height: it is work", bLook?.flat && bLook.wide && Math.abs(bLook.height - bLook.helper) <= 0.5, bLook);
  await ev(`click($$(".app-main .pb-answer").find((a) => a.textContent.includes("Aalto report uses")).querySelector(".pb-worked"))`);
  const closed1 = await ev(`(() => { const r = ${bRow("s-aalto")}; return r ? { inWork: !!r.closest(".pb-work"), state: r.querySelector(".pb-browser-state").textContent, disabled: r.getAttribute("aria-disabled"), height: Math.round(r.getBoundingClientRect().height * 10) / 10, go: !!r.querySelector(".pb-browser-go svg") } : null; })()`);
  check("opened, the fold shows the closed row in the work: Closed and the time, quiet", closed1?.inWork && /^Closed·\d\d:\d\d$/.test(closed1.state.replace(/\s/g, "")) && closed1.disabled === "true" && !closed1.go, closed1);
  check("the closed row has the open row's height", closed1?.height === open1?.height, { closed1, open1 });
  await ev(`click(${bRow("s-aalto")})`);
  await sleep(250);
  check("a closed row does nothing", (await ev(`!${bPane}`)) === true);
  await ev(`click($$(".app-main .pb-answer").find((a) => a.textContent.includes("Aalto report uses")).querySelector(".pb-worked"))`);
  await houseRules("chat with browser rows");
  await ev(readAt(bRow("s-kaja"), 200));
  await bShot("row-open-dark-1280", bRow("s-kaja"));

  // ---------------- B2: the panel
  const beforeOpen = await ev(rowTopOf(bRow("s-kaja")));
  await ev(`click(${bRow("s-kaja")})`);
  check("the row opens the browser in the panel beside the chat, in the place of the rail", !!(await until(`${mode} === "side" && !!${bPane}`)));
  await sleep(150);
  check("opening keeps the row the person opened where it is", kept(beforeOpen, await ev(rowTopOf(bRow("s-kaja")))), { beforeOpen, after: await ev(rowTopOf(bRow("s-kaja"))) });
  const railGone = await ev(`(() => { const r = $(".app-rail"); return { hidden: !r.checkVisibility({ visibilityProperty: true }), inert: r.inert }; })()`);
  check("the rail is not shown and cannot be reached", railGone?.hidden && railGone.inert, railGone);
  check("the first picture comes", !!(await until(shown, 3000)));
  const top = await ev(`({ title: text(".pb-browser-bar-title"), where: text(".pb-browser-where"), needs: $(".pb-artifact-needs")?.getAttribute("aria-label"), take: ${take}.textContent, tools: ${bTools}, titles: $$(".pb-browser-tools .pb-tool").every((t) => t.title === t.getAttribute("aria-label")), address: !!$(".pb-browser-address") })`);
  check("the top line: the workspace's name over the page's title and host", top?.title === "Check the survey settings" && top.where === "Surveys · app.example.com", top);
  check("the top line says Needs you 2, as the artifact panel does", top?.needs?.startsWith("Needs you, 2."), top);
  check("Take control is a word", top?.take === "Take control", top);
  check(
    "small controls with their words on hover and for screen readers: other work, Narrower, Wider, Fill, Close; no Back, Forward or Load again without control (round three: the pages are in their own row, no page menu)",
    JSON.stringify(top?.tools) === JSON.stringify(["Other work in the browser", "Narrower", "Wider", "Fill the main area", "Close"]) && top.titles,
    top?.tools,
  );
  check("in a bot's workspace the address is only shown, not typed in", top?.address === false, top);
  check("the open row is marked", (await ev(`${bRow("s-kaja")}.hasAttribute("data-open") && ${bRow("s-kaja")}.getAttribute("aria-label").endsWith("Open beside the chat.")`)) === true);
  const geo = await ev(`(() => {
    const body = $(".pb-browser-body").getBoundingClientRect(), p = $(".pb-browser-picture").getBoundingClientRect();
    const g = document.createElement("span"); g.style.color = "var(--frame-ground)"; document.body.append(g); const ground = getComputedStyle(g).color; g.remove();
    return { bw: body.width, bh: body.height, w: p.width, h: p.height, left: p.left - body.left, right: body.right - p.right, top: p.top - body.top, ground: getComputedStyle($(".pb-browser-picture")).backgroundColor === ground };
  })()`);
  check("the picture fits the panel with its proportions kept, centred at the top, on frame-ground", geo && geo.w <= geo.bw + 0.5 && geo.h <= geo.bh + 0.5 && Math.abs(geo.w / geo.h - 1280 / 800) < 0.01 && Math.abs(geo.left - geo.right) <= 1 && Math.abs(geo.top) <= 0.5 && geo.ground, geo);
  const rowH = await ev(`Math.round($(".pb-browser-stateline").getBoundingClientRect().height * 10) / 10`);
  check("the state line is there and empty while only watching", (await ev(stateLine)) === "" && rowH > 0, rowH);
  await ev(`window.pobotsMock.browserBusy("s-kaja", true)`);
  check("while a bot's command runs there: Kaja is working here, in the same height", !!(await until(`${stateLine} === "Kaja is working here"`)) && (await ev(`Math.round($(".pb-browser-stateline").getBoundingClientRect().height * 10) / 10`)) === rowH);
  check("and the row shows the working mark beside Open, in its box", !!(await until(`!!${bRow("s-kaja")}.querySelector(".pb-browser-state .pb-mark-thinking") && ${bRow("s-kaja")}.dataset.busy === "true"`)) && (await ev(`Math.round(${bRow("s-kaja")}.getBoundingClientRect().height * 10) / 10`)) === open1?.height);
  await houseRules("the browser panel, watching");
  await bShot("panel-watching-dark-1280");
  await bShot("row-open-working-dark-1280", bRow("s-kaja"));
  await bShot("top-line-dark-1280", `$(".pb-browser-bar")`);

  // Pictures replace each other with no empty moment.
  const pics = await ev(watchPicture(2600));
  check("pictures replace each other on the canvas with no empty moment", pics && pics.samples > 20 && pics.empty === 0 && pics.zero === 0 && pics.changes >= 2, pics);

  // Not in control: nothing goes to the page.
  const inputsBefore = await ev(`${reqs("browser.input")}`);
  let p = await picAt(0.3, 0.6);
  await clickAt(p.x, p.y);
  await press("a", { code: "KeyA", text: "a" });
  await mouse("mouseWheel", p.x, p.y, { deltaX: 0, deltaY: 120 });
  await sleep(200);
  check("without control a click, a key and a wheel send nothing", (await ev(`${reqs("browser.input")}`)) === inputsBefore && (await ev(`${flat}.length`)) === 0);
  check("a click on the picture only takes the focus", (await ev(`document.activeElement === $(".pb-browser-picture")`)) === true);
  await ev(`window.pobotsMock.browserBusy("s-kaja", false)`);
  check("the hint: Take control to click and type", !!(await until(`${stateLine} === "Take control to click and type"`)));
  await bShot("panel-hint-dark-1280");

  // Taking control.
  await ev(`click(${take})`);
  check("Take control: the word becomes Hand back, pressed", !!(await until(`${take}.textContent === "Hand back" && ${take}.getAttribute("aria-pressed") === "true"`)));
  check("You are in control. in the state line, and Back, Forward, Load again appear", !!(await until(`${stateLine} === "You are in control." && ["Back", "Forward", "Load again"].every((l) => ${bTools}.includes(l))`)));
  await ev(`window.pobotsMock.browserBusy("s-kaja", true)`);
  check("with a bot working there: You are in control. Kaja is not stopped.", !!(await until(`${stateLine} === "You are in control. Kaja is not stopped."`)));
  await ev(`window.pobotsMock.browserBusy("s-kaja", false)`);
  check("the picture has the focus with a visible ring", (await ev(`document.activeElement === $(".pb-browser-picture") && getComputedStyle($(".pb-browser-picture")).outlineStyle === "solid" && parseFloat(getComputedStyle($(".pb-browser-picture")).outlineWidth) === 2`)) === true);

  // Positions in the page's own pixels, at two panel widths.
  p = await picAt(0.25, 0.5);
  await clickAt(p.x, p.y);
  check("a click is sent as down and up in the page's own pixels", !!(await until(`(() => { const d = ${flat}.filter((e) => e.type === "down").at(-1); return !!d && Math.abs(d.x - 320) <= 2 && Math.abs(d.y - 400) <= 2 && d.button === "left" && d.clicks === 1; })()`)), await ev(`${flat}.slice(-3)`));
  check("and the page shows it (the mock's page took the click there)", !!(await until(`window.pobotsMock.browserPage("s-kaja").clicks.some((c) => Math.abs(c.x - 320) <= 2 && Math.abs(c.y - 400) <= 2)`)));
  const w1 = p.w;
  await ev(`(() => { const d = $(".pb-artifact-divider"); d.focus(); return true; })()`);
  // Round two: the browser starts as wide as the divider allows, so the other width is the narrowest.
  await key("End");
  await sleep(250);
  p = await picAt(0.75, 0.25);
  await clickAt(p.x, p.y);
  check("at another panel width the positions are still the page's own", p.w !== w1 && !!(await until(`(() => { const d = ${flat}.filter((e) => e.type === "down").at(-1); return !!d && Math.abs(d.x - 960) <= 2 && Math.abs(d.y - 200) <= 2; })()`)), { w1, w2: p.w, last: await ev(`${flat}.filter((e) => e.type === "down").at(-1)`) });
  await key("End");
  await ev(`(() => { const d = $(".pb-artifact-divider"); d.focus(); return true; })()`);
  for (let i = 0; i < 10; i++) await key("ArrowLeft");
  await ev(`$(".pb-browser-picture").focus()`);
  await sleep(200);
  p = await picAt(0.5, 0.5);
  await clickAt(p.x, p.y, 1);
  await clickAt(p.x, p.y, 2);
  check("a double click is sent with its click count", !!(await until(`${flat}.some((e) => e.type === "down" && e.clicks === 2)`)));

  // Batching: many moves, few sends, in order.
  const sendsBefore = await ev(`${reqs("browser.input")}`);
  const batchesBefore = await ev(`${inputs}.length`);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await mouse("mouseMoved", p.x + (i % 30) * 3, p.y + Math.floor(i / 30) * 3);
  await mouse("mousePressed", p.x, p.y);
  await mouse("mouseReleased", p.x, p.y);
  const spent = Date.now() - t0;
  await sleep(300);
  const batches = await ev(`${inputs}.slice(${batchesBefore})`);
  const sends = (await ev(`${reqs("browser.input")}`)) - sendsBefore;
  const allMoves = (batches ?? []).flat().filter((e) => e.type === "move").length;
  check(
    "moves are sent at most about 30 times a second, what happens in between in one batch",
    Array.isArray(batches) && sends <= Math.ceil(spent / 33) + 2 && sends < 60 && allMoves < 60 && batches.every((bt) => bt.every((e, i) => !(e.type === "move" && bt[i + 1]?.type === "move"))),
    { sends, spent, allMoves, batches: batches?.map((bt) => bt.map((e) => e.type).join(",")) },
  );
  const ordered = (batches ?? []).flat().map((e) => e.type).filter((t) => t === "down" || t === "up").join(",");
  check("in order: down before up", ordered.endsWith("down,up"), ordered);

  // Keys and text.
  await ev(`$(".pb-browser-picture").focus()`);
  await press("H", { code: "KeyH", text: "H", mods: 8 });
  await press("e", { code: "KeyE", text: "e" });
  await press("j", { code: "KeyJ", text: "j" });
  await press(" ", { code: "Space", text: " " });
  await press("å", { code: "BracketLeft", text: "å" });
  await press("ä", { code: "Quote", text: "ä" });
  await press("ö", { code: "Semicolon", text: "ö" });
  check("typed keys reach the page with their text, Swedish letters too", !!(await until(`window.pobotsMock.browserPage("s-kaja").text.endsWith("Hej åäö")`)), await ev(`window.pobotsMock.browserPage("s-kaja")?.text`));
  const kd = await ev(`${flat}.filter((e) => e.type === "key" && e.key === "H" && e.down).at(-1)`);
  check("a key carries key, code, text and Shift as a modifier", kd?.code === "KeyH" && kd.text === "H" && kd.mods === 8 && kd.down === true, kd);
  check("and goes up again", (await ev(`${flat}.some((e) => e.type === "key" && e.key === "H" && e.down === false)`)) === true);
  await press("Backspace", { vk: 8 });
  await press("Tab", { vk: 9 });
  await press("Tab", { vk: 9, mods: 8 });
  await press("Enter", { vk: 13, text: "\r" });
  for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete"]) await press(k);
  await until(`${flat}.some((e) => e.type === "key" && e.key === "Delete" && !e.down)`);
  const nav = await ev(`${flat}.filter((e) => e.type === "key" && e.down).map((e) => e.key + (e.mods ? "+" + e.mods : "")).slice(-13)`);
  check(
    "Backspace, Tab, Shift+Tab, Enter, the arrows, Home, End, Page Up, Page Down and Delete go to the page",
    JSON.stringify(nav) === JSON.stringify(["Backspace", "Tab", "Tab+8", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete"]),
    nav,
  );
  check("Tab stays in the page: the focus does not move", (await ev(`document.activeElement === $(".pb-browser-picture")`)) === true);
  check("Enter is sent with its text", (await ev(`${flat}.some((e) => e.type === "key" && e.key === "Enter" && e.text === "\\r")`)) === true);
  for (const [k, code] of [["a", "KeyA"], ["z", "KeyZ"], ["y", "KeyY"]]) await press(k, { code, mods: 2 });
  await press("z", { code: "KeyZ", mods: 2 | 8 });
  for (const [k, code] of [["a", "KeyA"], ["z", "KeyZ"]]) await press(k, { code, mods: 4 });
  await until(`${flat}.filter((e) => e.type === "key" && e.key === "z" && e.mods === 4).length === 2`);
  const edits = await ev(`${flat}.filter((e) => e.type === "key" && e.down && e.mods).map((e) => e.key + "+" + e.mods).slice(-6)`);
  check("select all, undo and redo go on with Ctrl and with the command key", JSON.stringify(edits) === JSON.stringify(["a+2", "z+2", "y+2", "Z+10", "a+4", "z+4"]) || JSON.stringify(edits) === JSON.stringify(["a+2", "z+2", "y+2", "z+10", "a+4", "z+4"]), edits);

  // Copy, cut and paste with the laptop's clipboard.
  await ev(`window.__copied = []`);
  const selBefore = await ev(`${reqs("browser.selection")}`);
  await press("a", { code: "KeyA", mods: 2 });
  await press("c", { code: "KeyC", mods: 2 });
  check("Ctrl+C passes the keys on, then asks the page what is selected and puts it on the laptop's clipboard", !!(await until(`${reqs("browser.selection")} === ${selBefore + 1} && window.__copied.length === 1 && window.__copied[0] === window.pobotsMock.browserPage("s-kaja").selected && ${flat}.some((e) => e.type === "key" && e.key === "c" && e.mods === 2)`)), await ev(`window.__copied`));
  await press("x", { code: "KeyX", mods: 4 });
  check("the command key's cut does the same", !!(await until(`${reqs("browser.selection")} === ${selBefore + 2} && window.__copied.length === 2`)));
  const keysBefore = await ev(`${flat}.length`);
  await press("v", { code: "KeyV", mods: 2 });
  await ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "Klistrat från datorn"); $(".pb-browser-picture").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  check("a paste sends the laptop's clipboard text as one text event, and Ctrl+V itself is not sent", !!(await until(`${flat}.slice(${keysBefore}).some((e) => e.type === "text" && e.text === "Klistrat från datorn") && !${flat}.slice(${keysBefore}).some((e) => e.type === "key" && e.key === "v")`)));

  // The laptop's own shortcuts that would leave the page are not caught.
  await ev(`(() => { window.__prevented = []; window.addEventListener("keydown", (e) => window.__prevented.push(e.key + ":" + e.defaultPrevented)); return true; })()`);
  const beforeShort = await ev(`${flat}.length`);
  await press("w", { code: "KeyW", mods: 2 });
  await press("t", { code: "KeyT", mods: 2 });
  await press("l", { code: "KeyL", mods: 2 });
  await press("F5", { vk: 116 });
  await sleep(120);
  const shortcuts = await ev(`({ prevented: window.__prevented, sent: ${flat}.slice(${beforeShort}).filter((e) => e.type === "key").map((e) => e.key) })`);
  check("Ctrl+W, Ctrl+T, Ctrl+L and F5 are left to the laptop's browser: not caught, not sent", JSON.stringify(shortcuts?.prevented) === JSON.stringify(["w:false", "t:false", "l:false", "F5:false"]) && shortcuts.sent.length === 0, shortcuts);

  // The wheel.
  p = await picAt(0.5, 0.6);
  await mouse("mouseMoved", p.x, p.y);
  await mouse("mouseWheel", p.x, p.y, { deltaX: 0, deltaY: 200 });
  check("the wheel scrolls the page, not the panel", !!(await until(`${flat}.some((e) => e.type === "wheel" && e.dy > 0) && window.pobotsMock.browserPage("s-kaja").scroll > 0`)));

  // Escape: the page needs it too.
  await ev(`$(".pb-browser-picture").focus()`);
  await mouse("mouseMoved", p.x, p.y);
  const escBefore = await ev(`${flat}.filter((e) => e.type === "key" && e.key === "Escape" && e.down).length`);
  await press("Escape", { vk: 27 });
  await sleep(700);
  check(
    "Escape once, with the pointer over the picture, goes to the page and stays there",
    !!(await until(`${flat}.filter((e) => e.type === "key" && e.key === "Escape" && e.down).length === ${escBefore + 1}`)) && (await ev(`document.activeElement === $(".pb-browser-picture") && !!${bPane}`)) === true,
    await ev(`({ esc: ${flat}.filter((e) => e.type === "key" && e.key === "Escape").length, before: ${escBefore}, active: document.activeElement?.className, hover: $(".pb-browser-picture").matches(":hover") })`),
  );
  await press("Escape", { vk: 27 });
  await press("Escape", { vk: 27 });
  check("Escape twice quickly leaves the picture for Hand back; the panel stays", !!(await until(`document.activeElement === ${take} && !!${bPane}`)));
  await ev(`$(".pb-browser-picture").focus()`);
  await mouse("mouseMoved", 5, 5);
  await press("Escape", { vk: 27 });
  check("with the pointer away from the picture, one Escape leaves it", !!(await until(`document.activeElement === ${take} && !!${bPane}`)));
  await houseRules("the browser panel, in control");
  await bShot("panel-in-control-dark-1280");

  // Back, forward and load again, in control.
  const goBefore = await ev(`${reqs("browser.go")}`);
  for (const l of ["Back", "Forward", "Load again"]) await ev(`click(${bTool(l)})`);
  check("Back, Forward and Load again move the page", !!(await until(`${reqs("browser.go")} === ${goBefore + 3}`)));

  // Handing back.
  await ev(`click(${take})`);
  check("Hand back: Take control again, nothing more goes to the page", !!(await until(`${take}.textContent === "Hand back" ? false : ${take}.textContent === "Take control" && ${stateLine} === ""`)), await ev(`({ take: ${take}.textContent, state: ${stateLine} })`));
  const afterHand = await ev(`${reqs("browser.input")}`);
  p = await picAt(0.4, 0.4);
  await clickAt(p.x, p.y);
  await press("q", { code: "KeyQ", text: "q" });
  await sleep(200);
  check("after Hand back a click and a key send nothing", (await ev(`${reqs("browser.input")}`)) === afterHand);

  // Another page of the same workspace (round three: from the row of pages, not a menu).
  const pages = await ev(`$$(".pb-browser-tab").map((o) => o.textContent + ":" + o.getAttribute("aria-selected"))`);
  check("the row of pages lists the workspace's pages, the one shown chosen", JSON.stringify(pages) === JSON.stringify(["Surveys:true", "Survey settings:false"]), pages);
  await ev(`click($$(".pb-browser-tab")[1])`);
  check("picking a page shows that page", !!(await until(`window.pobotsMock.browserWatching()?.shown === window.pobotsMock.browserState().spaces.find((s) => s.id === "s-kaja").pages[1].id && text(".pb-browser-where") === "Survey settings · app.example.com"`)), await ev(`({ w: window.pobotsMock.browserWatching(), where: text(".pb-browser-where"), state: ${stateLine} })`));

  // Another workspace, or the person's own page.
  await ev(`click(${bTool("Other work in the browser")})`);
  const spaces = await ev(`$$(".pb-browser-menu > *").map((o) => (o.querySelector(".pb-avatar") ? "face " : "") + o.textContent)`);
  check(
    "the workspace menu: the bots' workspaces with the bot's small face, Your page, and other work under its own heading",
    Array.isArray(spaces) && spaces[0]?.startsWith("face Check the survey settings") && spaces[1] === "Your page" && spaces[2] === "Other work in the browser" && spaces[3] === "Inventory sync",
    spaces,
  );
  await houseRules("the workspace menu");
  await bShot("pickers-spaces-dark-1280");
  await key("Escape");
  check("Escape closes the menu, not the panel, and the focus goes back to its control", !!(await until(`!$(".pb-browser-menu") && !!${bPane} && document.activeElement === ${bTool("Other work in the browser")}`)));

  // Swapping with an artifact, in the same panel.
  const paneEl = `window.__pane`;
  await ev(`(() => { window.__pane = $(".app-artifact"); window.__divider = $(".pb-artifact-divider"); return true; })()`);
  const widthBefore = await ev(`Math.round($(".app-artifact").getBoundingClientRect().width)`);
  await ev(readAt(`$$(".app-main .pb-artifact").find((r) => r.dataset.artifactId === "onboarding-status")`));
  await ev(`click($$(".app-main .pb-artifact").filter((r) => r.dataset.artifactId === "onboarding-status").pop())`);
  check("opening an artifact while the browser is open swaps the content of the same panel", !!(await until(`$(".app-artifact")?.dataset.content === "artifact" && $(".app-artifact") === ${paneEl} && $(".pb-artifact-divider") === window.__divider && text(".pb-artifact-bar-title") === "Onboarding status"`)));
  // Round two: the browser and an artifact each keep their own width (step-2g-fixes.md, 4).
  const artifactPx = await ev(`(() => { const raw = localStorage.getItem("pobots.artifactShare"); const n = raw === null ? 0.5 : Number(raw); const avail = 1280 - 264; return \`\${Math.round(Math.min(avail - 400, Math.max(380, n * avail)))}px\`; })()`);
  check("at the artifact's own width", (await ev(`$(".app-shell").style.getPropertyValue("--artifact-w")`)) === artifactPx, { before: widthBefore, artifactPx, now: await ev(`$(".app-shell").style.getPropertyValue("--artifact-w")`) });
  check("and the browser stops being watched", !!(await until(`window.pobotsMock.browserWatching() === null`)));
  await ev(readAt(bRow("s-kaja"), 200));
  await ev(`click(${bRow("s-kaja")})`);
  check("and the other way round", !!(await until(`$(".app-artifact")?.dataset.content === "browser" && $(".app-artifact") === ${paneEl} && ${shown}`, 3000)));

  // Escape closes; the focus goes back to the row; the chat keeps the row's place.
  const beforeClose = await ev(rowTopOf(bRow("s-kaja")));
  await ev(`$(".pb-browser-take").focus()`);
  await key("Escape");
  check("Escape from the panel's controls closes it, the focus back on the row", !!(await until(`!$(".app-artifact") && document.activeElement === ${bRow("s-kaja")}`)));
  // The row stands near the end of the chat here: widened, the text below it is shorter, and the chat
  // cannot scroll past its end, so then it stays at its end instead.
  const atEnd = await ev(`(() => { const c = $(".app-main .pb-main-scroll"); return c.scrollHeight - c.scrollTop - c.clientHeight < 2; })()`);
  check("closing keeps the row where it was, or the chat at its end when the row stands at the end", kept(beforeClose, await ev(rowTopOf(bRow("s-kaja")))) || atEnd, { beforeClose, after: await ev(rowTopOf(bRow("s-kaja"))), atEnd });
  check("closing ends the watch", !!(await until(`window.pobotsMock.browserWatching() === null`)));
  await key("Enter");
  check("Enter on the row opens it again", !!(await until(`!!${bPane}`)));
  await key("Escape");
  check("Escape on the row of the open workspace closes it", !!(await until(`!$(".app-artifact")`)));
  const stops = await ev(`$$(".app-main :is(.app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked, .pb-artifact, .pb-browser)").filter((x) => x.tabIndex === 0).length`);
  check("the row is one of the chat's line buttons: one Tab stop for them all", stops === 1, stops);

  // The panel stays across bots, tabs and a reload.
  await ev(`click(${bRow("s-kaja")})`);
  await until(`!!${bPane} && ${shown}`);
  await goTo("Inbox", "chat");
  check("the browser stays open when another bot is chosen", (await ev(`!!${bPane} && text(".pb-browser-bar-title") === "Check the survey settings"`)) === true);
  await ev(`click($('.pb-tab[data-tab="files"]'))`);
  check("and across the bot's tabs", (await ev(`!!${bPane}`)) === true);
  await ev(`click($$(".pb-channel-row")[0])`);
  check("and beside a channel's page", !!(await until(`!!$(".app-channel") && !!${bPane}`)));
  await b.cmd("Page.reload");
  await until(`!!$(".pb-shell")`, 6000);
  check("a reload keeps it open on the same workspace, and a picture comes", !!(await until(`!!${bPane} && text(".pb-browser-bar-title") === "Check the survey settings" && ${shown}`, 4000)));
  await stubOutside();
  await goTo("Kaja", "chat");

  // Fill.
  const sideW = await ev(`$(".pb-browser-picture").getBoundingClientRect().width`);
  await ev(`click(${bTool("Fill the main area")})`);
  check("Fill: the browser fills the main area, the chat hidden behind it", !!(await until(`${mode} === "full" && !$(".app-main").checkVisibility({ visibilityProperty: true }) && $(".app-main").inert`)));
  await sleep(200);
  const fullW = await ev(`$(".pb-browser-picture").getBoundingClientRect().width`);
  check("the picture grows with the panel, never past the page's own size", fullW > sideW && fullW <= 1280, { sideW, fullW });
  await houseRules("the browser filling the main area");
  await bShot("panel-full-dark-1280");
  await ev(`click(${bTool("Show the chat beside it")})`);
  await until(`${mode} === "side"`);

  // The connection going away and coming back.
  const watchesBefore = await ev(`${reqs("browser.watch")}`);
  await ev(`window.pobotsMock.dropConnection()`);
  await sleep(400);
  check("when the connection goes, the last picture stays", (await ev(`${shown} && $(".pb-browser-canvas").width > 0`)) === true);
  await ev(`window.pobotsMock.restoreConnection()`);
  check("when it comes back, the panel asks to watch again by itself", !!(await until(`${reqs("browser.watch")} > ${watchesBefore} && !!window.pobotsMock.browserWatching()`, 4000)));
  const framesNow = await ev(`window.pobotsMock.browserFrames()`);
  const pics2 = await ev(watchPicture(1500));
  check("and pictures go on, never empty", pics2 && pics2.empty === 0 && pics2.zero === 0 && (await ev(`window.pobotsMock.browserFrames()`)) > framesNow, pics2);

  // The workspace closes while it is open.
  await ev(readAt(bRow("s-kaja"), 200));
  const rowBefore = await ev(rowTopOf(bRow("s-kaja")));
  await ev(`window.pobotsMock.closeBrowserSpace("s-kaja")`);
  check("the workspace closed while open: Kaja closed this", !!(await until(`${stateLine} === "Kaja closed this" && $(".pb-browser-panel").dataset.ended === "closed"`)));
  await until(`parseFloat(getComputedStyle($(".pb-browser-canvas")).opacity) < 0.5`, 2000);
  const endedFacts = await ev(`({ shown: ${shown}, dim: parseFloat(getComputedStyle($(".pb-browser-canvas")).opacity) < 1, take: ${take}.getAttribute("aria-disabled"), tools: ${bTools}, title: text(".pb-browser-bar-title") })`);
  check("the last picture stays, dimmed; Take control is off; the pickers and Close stay", endedFacts?.shown && endedFacts.dim && endedFacts.take === "true" && endedFacts.tools.includes("Other work in the browser") && endedFacts.tools.includes("Close") && endedFacts.title === "Check the survey settings", endedFacts);
  check("its row turns Closed in its box and stays where it is", !!(await until(`${bRow("s-kaja")}?.dataset.status === "closed"`)) && kept(rowBefore, await ev(rowTopOf(bRow("s-kaja")))) && (await ev(`Math.round(${bRow("s-kaja")}.getBoundingClientRect().height * 10) / 10`)) === open1?.height);
  check("and stays in sight until the chat is drawn again", (await ev(`!${bRow("s-kaja")}.closest(".pb-work")`)) === true);
  await houseRules("the closed workspace");
  await bShot("panel-closed-dark-1280");
  await bShot("row-closed-dark-1280", bRow("s-kaja"));
  const controlsBefore = await ev(`${reqs("browser.control")}`);
  await ev(`click(${take})`);
  await sleep(200);
  check("Take control does nothing then", (await ev(`${take}.textContent === "Take control" && ${reqs("browser.control")} === ${controlsBefore}`)) === true);

  // The person's own page, with the address line.
  await ev(`click(${bTool("Other work in the browser")})`);
  await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Your page"))`);
  check("Your page opens from the workspace menu, with an address line", !!(await until(`text(".pb-browser-bar-title") === "Your page" && $(".pb-browser-address")?.value === "https://example.com/" && ${shown}`, 3000)));
  check("the state line is empty again", (await ev(stateLine)) === "");
  check("Open in a new tab is there for the person's own page", (await ev(`${bTools}.includes("Open in a new tab")`)) === true);
  await houseRules("your own page");
  await bShot("own-page-dark-1280");
  await ev(`(() => { const a = $(".pb-browser-address"); a.focus(); a.select(); return true; })()`);
  await type("example.org");
  await key("Enter");
  check("Enter on the address takes control by itself and goes there (a bare host gets https)", !!(await until(`${take}.textContent === "Hand back" && window.pobotsMock.browserPage(window.pobotsMock.browserWatching().spaceId).url === "https://example.org" && $(".pb-browser-address").value === "https://example.org"`, 3000)));
  const goCount = await ev(`${reqs("browser.go")}`);
  await ev(`(() => { const a = $(".pb-browser-address"); a.focus(); a.select(); return true; })()`);
  await type("file:///etc/hosts");
  await key("Enter");
  check("an address that is not http or https is refused with one plain sentence, and not sent", !!(await until(`${stateLine} === "Only addresses that start with http or https can be opened here."`)) && (await ev(`${reqs("browser.go")}`)) === goCount);
  await key("Escape");
  check("Escape in the address puts the page's address back, the panel stays", !!(await until(`$(".pb-browser-address").value === "https://example.org" && !!${bPane}`)));
  await bShot("own-page-in-control-dark-1280");
  await ev(`click(${bTool("Open in a new tab")})`);
  check("Open in a new tab opens the page in the laptop's own browser", (await ev(`JSON.stringify(window.__opened.at(-1)?.slice(0, 1))`)) === JSON.stringify(["https://example.org"]));

  // B4, taken back in round three: a page on Claude opens in its own window again, also when the
  // browser can be reached; nothing opens a Claude link in the browser panel by itself.
  await ev(`click(${bTool("Close")})`);
  await until(`!$(".app-artifact")`);
  const kick = `$$(".app-main .pb-artifact").filter((r) => r.dataset.artifactId === "kickoff-agenda").pop()`;
  check("3: a link's row reads On Claude, opens in its own window, also when the browser can be reached", /^Made \d\d:\d\d · On Claude, opens in its own window$/.test((await ev(`${kick}.querySelector(".pb-artifact-line").textContent`)) ?? ""), await ev(`${kick}.querySelector(".pb-artifact-line").textContent`));
  const opensBefore = await ev(`window.__opened.length`);
  const ownBefore = await ev(`${reqs("browser.own")}`);
  await ev(readAt(kick));
  await ev(`click(${kick})`);
  await sleep(300);
  check("3: it opens the link in the window beside Pobots, and not in the browser panel", (await ev(`window.__opened.at(-1)?.slice(0, 2).join(" ")`)) === "https://claude.ai/artifact/mock-kickoff-agenda pobots-claude" && (await ev(`window.__opened.length`)) === opensBefore + 1 && (await ev(`${reqs("browser.own")}`)) === ownBefore && (await ev(`!$(".app-artifact")`)) === true);
  const report = `$$(".app-main .pb-artifact").filter((r) => r.dataset.artifactId === "customer-report").pop()`;
  await ev(readAt(report));
  await ev(`click(${report})`);
  await until(`$(".app-artifact")?.dataset.content === "artifact"`);
  await ev(`click($$(".pb-artifact-tools .pb-tool").find((t) => t.getAttribute("aria-label") === "Open on Claude"))`);
  await sleep(300);
  check("3: Open on Claude in the artifact panel opens it in its own window; the artifact stays in the panel", (await ev(`window.__opened.at(-1)?.slice(0, 2).join(" ")`)) === "https://claude.ai/artifact/mock-customer-report pobots-claude" && (await ev(`$(".app-artifact")?.dataset.content`)) === "artifact" && (await ev(`${reqs("browser.own")}`)) === ownBefore);
  await ev(`click($$(".pb-artifact-tools .pb-tool").find((t) => t.getAttribute("aria-label") === "Close"))`);
  await until(`!$(".app-artifact")`);
  await ev(`click($(".pb-browser-line"))`);
  await until(`$(".app-artifact")?.dataset.content === "browser"`);

  // B3: the roster's way in.
  const line = await ev(`({ name: text(".pb-browser-line-name"), word: text(".pb-browser-line-word"), label: $(".pb-browser-line").getAttribute("aria-label") })`);
  check("the roster has one quiet Browser line saying how much is open", line?.name === "Browser" && /^\d+ open$/.test(line.word) && line.word === `${await ev(`window.pobotsMock.browserState().spaces.length`)} open`, line);
  check("it is marked while the browser is open beside the chat", (await ev(`$(".pb-browser-line").getAttribute("aria-current")`)) === "true");
  await bShot("roster-line-dark-1280", `$(".app-browser")`);
  await ev(`click(${bTool("Close")})`);
  await until(`!$(".app-artifact")`);
  await ev(`(() => { $(".pb-composer textarea").focus(); return true; })()`);
  await type("Look it up in the browser and leave it open for me.");
  await key("Enter");
  check("a bot's turn that leaves its workspace open: the row stays in sight after the fold", !!(await until(`(() => { const r = ${bRows}.find((x) => x.querySelector(".pb-browser-name").textContent === "Look up the Nordvik import"); return !!r && r.dataset.status === "open" && !!r.closest(".pb-answer[data-folded]") && !r.closest(".pb-work"); })()`, 8000)));
  await goTo("Inbox", "chat");
  await ev(`click($(".pb-browser-line"))`);
  check("from another bot's page the Browser line opens the newest bot workspace", !!(await until(`text(".pb-browser-bar-title") === "Look up the Nordvik import"`)));
  await ev(`click(${bTool("Close")})`);
  await goTo("Kaja", "chat");
  for (const id of await ev(`window.pobotsMock.browserState().spaces.map((s) => s.id)`)) await ev(`window.pobotsMock.closeBrowserSpace(${JSON.stringify(id)})`);
  check("nothing open: the line says nothing more than Browser", !!(await until(`text(".pb-browser-line-word") === ""`)));
  const ownCalls = await ev(`${reqs("browser.own")}`);
  await ev(`click($(".pb-browser-line"))`);
  check("and opens the person's own page, made on demand", !!(await until(`${reqs("browser.own")} === ${ownCalls + 1} && text(".pb-browser-bar-title") === "Your page" && ${shown}`, 3000)));
  await ev(`click(${bTool("Other work in the browser")})`);
  await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Close your page"))`);
  check("Close your page closes it in the browser; the panel says so", !!(await until(`${stateLine} === "Your page was closed" && window.pobotsMock.browserState().spaces.length === 0`)));
  await ev(`click(${bTool("Close")})`);

  // B1 live: a bot's turn in the browser, held at every moment.
  await ev(`window.pobotsMock.holdSteps(true)`);
  await ev(`(() => { $(".pb-composer textarea").focus(); return true; })()`);
  await type("Check the import in the browser.");
  await key("Enter");
  const live = `${bRows}.filter((x) => x.querySelector(".pb-browser-name").textContent === "Look up the Nordvik import").pop()`;
  for (let i = 0; i < 40 && (await ev(`window.pobotsMock.stepPhase()`)) !== "working in the browser"; i++) {
    await ev(`window.pobotsMock.stepOn()`);
    await sleep(200);
  }
  check("in a running turn, the row arrives where the bot works, busy: the working mark beside Open", !!(await until(`(() => { const r = ${live}; return !!r && r.dataset.status === "open" && r.dataset.busy === "true" && !!r.closest(".pb-answer[data-current]") && !!r.querySelector(".pb-mark-thinking") && r.querySelector(".pb-browser-last").textContent === "Imports · app.example.com"; })()`, 4000)));
  check("and the line of work for the command reads Working in the browser", (await ev(`$$(".app-main .pb-answer[data-current] .pb-step").some((s) => s.textContent.includes("Working in the browser"))`)) === true);
  await ev(`(() => { window.__liveRow = ${live}; return true; })()`);
  const liveTop = await ev(rowTopOf(`window.__liveRow`));
  await bShot("row-running-dark-1280", `$$(".app-main .pb-answer").pop()`);
  await ev(`window.pobotsMock.stepOn()`);
  check("its muted line follows the page, in the same box", !!(await until(`window.__liveRow.isConnected && window.__liveRow.querySelector(".pb-browser-last").textContent === "Nordvik import · app.example.com"`, 3000)) && kept(liveTop, await ev(rowTopOf(`window.__liveRow`))) && (await ev(`Math.round(window.__liveRow.getBoundingClientRect().height * 10) / 10`)) === open1?.height);
  await ev(`window.pobotsMock.holdSteps(false)`);
  check("the bot closes it at the end: the row folds away with the work", !!(await until(`!${bRows}.some((x) => x.dataset.status === "open" && x.querySelector(".pb-browser-name").textContent === "Look up the Nordvik import" && !x.closest(".pb-work")) && !!$$(".app-main .pb-answer").pop().dataset.folded`, 8000)));

  // The browser cannot be reached; and a slow first picture.
  await open(BS);
  await stubOutside();
  await goTo("Kaja", "chat");
  await ev(`window.pobotsMock.browserFirstPicture(1600)`);
  await ev(`click(${bRow("s-kaja")})`);
  check("until the first picture: Opening the browser, only after a moment", !!(await until(`text(".pb-browser-status") === "Opening the browser" && $(".pb-browser-status").hasAttribute("data-wait")`)) && (await ev(`parseFloat(getComputedStyle($(".pb-browser-status")).animationDelay) > 0`)) === true);
  check("then the picture", !!(await until(shown, 4000)));
  await ev(`window.pobotsMock.browserFirstPicture(40)`);
  await ev(`window.pobotsMock.browserAvailable(false, "The browser on the Mac cannot be reached. Open it there and try again.")`);
  check("the browser cannot be reached: the engine's sentence with Try again", !!(await until(`$(".pb-browser-status[role=alert]")?.innerText.includes("The browser on the Mac cannot be reached. Open it there and try again.") && !!btn("Try again")`)));
  check("and the roster's Browser line goes", (await ev(`!$(".pb-browser-line")`)) === true);
  await houseRules("the browser cannot be reached");
  await bShot("panel-unavailable-dark-1280");
  await ev(`window.pobotsMock.browserAvailable(true)`);
  await ev(`click(btn("Try again"))`);
  check("Try again brings it back", !!(await until(`!$(".pb-browser-status[role=alert]") && ${shown} && !!window.pobotsMock.browserWatching()`, 4000)));

  // 800 px: the panel takes the place of the chat.
  await open(BS, { width: 800 });
  await stubOutside();
  await goTo("Kaja", "chat");
  await ev(`click(${bRow("s-kaja")})`);
  const n800 = await ev(`(async () => { for (let i = 0; i < 40 && !$(".pb-browser-body[data-shown]"); i++) await new Promise((r) => setTimeout(r, 60)); return { mode: $(".app-shell").dataset.artifact, back: document.activeElement?.getAttribute("aria-label"), divider: !!$(".pb-artifact-divider"), fill: $$(".pb-browser-tools .pb-tool").some((t) => t.getAttribute("aria-label") === "Fill the main area"), chatHidden: !$(".app-main").checkVisibility({ visibilityProperty: true }) }; })()`);
  check("800 px: the browser takes the place of the chat, with Back to Kaja focused, no divider or Fill", n800?.mode === "narrow" && n800.back === "Back to Kaja" && !n800.divider && !n800.fill && n800.chatHidden, n800);
  await houseRules("800 px, the browser");
  check("800 px: the roster's Browser line is a drawn window with its words read out", (await ev(`(() => { const l = $(".pb-browser-line"); return getComputedStyle(l.querySelector(".pb-browser-line-mark")).display !== "none" && l.querySelector(".pb-browser-line-name").getBoundingClientRect().width <= 1 && l.getAttribute("aria-label").startsWith("Browser, 3 open"); })()`)) === true);
  await ev(`click($(".pb-artifact-back"))`);
  check("800 px: back shows the chat, the focus on the row", !!(await until(`!$(".app-artifact") && document.activeElement?.dataset.spaceId === "s-kaja"`)));

  // 1280 and 800 px, light and dark.
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      const tag = `${theme}-${width}`;
      await open(BS, { width, theme });
      await stubOutside();
      await goTo("Kaja", "chat");
      await until(`!!${bRow("s-kaja")}`);
      await houseRules(`${tag}, chat with a browser row`);
      if (width === 1280) await bShot(`roster-line-${tag}`, `$(".app-browser")`);
      else await bShot(`roster-line-${tag}`, `$(".app-side-foot")`);
      await ev(`${bRow("s-kaja")}.focus()`);
      await key("Enter");
      check(`${tag}: Enter on the row opens the browser`, !!(await until(`!!${bPane} && ${shown}`, 3000)), await ev(`({ pane: !!${bPane}, shown: ${shown}, active: document.activeElement?.className, mode: $(".app-shell").dataset.artifact })`));
      const hs = await ev(`Math.round(${bRow("s-kaja")}.getBoundingClientRect().height * 10) / 10`);
      check(`${tag}: the row keeps its height with the panel open`, hs === open1?.height, hs);
      await houseRules(`${tag}, the browser panel`);
      if (width === 1280) {
        await bShot(`panel-watching-${tag}`);
        await bShot(`row-open-${tag}`, bRow("s-kaja"));
        await ev(`$(".pb-artifact-divider").focus()`);
        await focusRings(`${tag}, the browser panel's controls`, 8);
        await ev(`click(${take})`);
        await until(`${take}.textContent === "Hand back"`);
        // In control the picture keeps Tab for the page, so the walk starts at the divider and ends on it.
        await ev(`$(".pb-artifact-divider").focus()`);
        await focusRings(`${tag}, the browser panel's controls in control`, 10);
        await bShot(`panel-in-control-${tag}`);
        await ev(`click(${bTool("Other work in the browser")})`);
        await houseRules(`${tag}, the workspace menu`);
        await bShot(`pickers-spaces-${tag}`);
        await key("Escape");
        await ev(`click(${bTool("Fill the main area")})`);
        await until(`${mode} === "full"`);
        await bShot(`panel-full-${tag}`);
        await ev(`click(${bTool("Show the chat beside it")})`);
        await ev(`window.pobotsMock.closeBrowserSpace("s-kaja")`);
        await until(`${stateLine} === "Kaja closed this"`);
        await houseRules(`${tag}, the closed workspace`);
        await bShot(`panel-closed-${tag}`);
        await ev(`click(${bTool("Other work in the browser")})`);
        await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Your page"))`);
        await until(`!!$(".pb-browser-address") && ${shown}`, 3000);
        await houseRules(`${tag}, your own page`);
        await bShot(`own-page-${tag}`);
        // The panel is remembered for this tab: closed here, so the next round starts without it.
        await ev(`click(${bTool("Close")})`);
        await until(`!$(".app-artifact")`);
        if (theme === "light") await bShot(`row-closed-${tag}`, bRow("s-kaja"));
      } else {
        await bShot(`panel-800-${theme}`);
        await ev(`$(".pb-artifact-back").focus()`);
        await focusRings(`${tag}, the browser panel's controls`, 5);
        await ev(`click($(".pb-artifact-back"))`);
        await until(`!$(".app-artifact")`);
      }
    }
  }
  if (browserShots) console.log(`Browser pictures in ${browserShots}`);


  // ================================================================ step 2g, round two: what the tester found (in section 2g)
  // docs/build/step-2g-fixes.md. The mock's made-up page has two drop-down lists (a short one with a
  // disabled option and group headings, a long one) whose choices come as "browser.prompt", and two
  // buttons where the page asks (Leave: a confirm; Copy: a prompt). Pictures go to --fixes-shots.
  {
  const fixesShots = arg("fixes-shots") ?? (shots ? join(shots, "fixes") : undefined);
  if (fixesShots) mkdirSync(fixesShots, { recursive: true });
  async function fShot(name, selector) {
    if (!fixesShots) return;
    await sleep(500);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(fixesShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const places = await (async () => {
    await open(BS);
    return ev(`window.pobotsMock.browserPlaces()`);
  })();
  /** A point of the made-up page (its own pixels, 1280 by 800) in the window's pixels. */
  const pageAt = (px, py) => ev(`(() => { const r = $(".pb-browser-canvas").getBoundingClientRect(); return { x: r.left + ${px} / 1280 * r.width, y: r.top + ${py} / 800 * r.height, scale: r.width / 1280, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  const choices = `$(".pb-browser-choices")`;
  const ask = `$(".pb-browser-ask")`;
  const pageNow = (space = "s-kaja") => `window.pobotsMock.browserPage(${JSON.stringify(space)})`;
  const shareVar = `$(".app-shell").style.getPropertyValue("--artifact-w")`;
  async function openKaja(opts) {
    await open(BS, opts);
    await stubOutside();
    await goTo("Kaja", "chat");
    await until(`!!${bRow("s-kaja")}`);
    await ev(readAt(bRow("s-kaja"), 200));
    await ev(`click(${bRow("s-kaja")})`);
    await until(`!!${bPane} && ${shown}`, 3000);
  }
  async function control() {
    if ((await ev(`${take}.textContent`)) !== "Hand back") await ev(`click(${take})`);
    await until(`${take}.textContent === "Hand back"`);
  }
  const inputCount = `${inputs}.length`;

  // ---------------- 4: the browser's own width, widest at first
  await open(BS);
  await ev(`(() => { localStorage.removeItem("pobots.browserShare"); localStorage.removeItem("pobots.artifactShare"); sessionStorage.clear(); return true; })()`);
  await openKaja();
  // 1280 wide: 264 for the roster, so 1016 beside it; the chat keeps its readable 400.
  check("4: the browser starts as wide as the divider allows: the chat at its readable minimum", (await ev(shareVar)) === "616px", await ev(shareVar));
  const chatW = await ev(`Math.round($(".app-main").getBoundingClientRect().width)`);
  check("4: and the chat beside it still has its room", chatW >= 380, chatW);
  await ev(`(() => { window.__pane = $(".app-artifact"); return true; })()`);
  const aRowSel = `$$(".app-main .pb-artifact").filter((r) => r.dataset.artifactId === "onboarding-status").pop()`;
  await ev(readAt(aRowSel, 200));
  const beforeSwap = await ev(rowTopOf(aRowSel));
  // Sample the panel's width on every frame through the swap: one step, never a slide.
  await ev(`(() => { window.__widths = []; const f = () => { window.__widths.push(Math.round($(".app-artifact")?.getBoundingClientRect().width ?? 0)); if (window.__widths.length < 40) requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
  await ev(`click(${aRowSel})`);
  await until(`$(".app-artifact")?.dataset.content === "artifact"`, 3000);
  await sleep(800);
  const widths = await ev(`[...new Set(window.__widths)]`);
  check("4: an artifact keeps its own width (about half): the swap changes the width in one step", (await ev(shareVar)) === "508px" && widths.length <= 2, { share: await ev(shareVar), widths });
  check("4: and the row the person opened stays where it was", kept(beforeSwap, await ev(rowTopOf(aRowSel))), { beforeSwap, after: await ev(rowTopOf(aRowSel)) });
  await ev(readAt(bRow("s-kaja"), 200));
  const beforeBack = await ev(rowTopOf(bRow("s-kaja")));
  await ev(`click(${bRow("s-kaja")})`);
  await until(`$(".app-artifact")?.dataset.content === "browser" && ${shown}`, 3000);
  await sleep(300);
  check("4: back to the browser: its own width again, the row kept in place", (await ev(shareVar)) === "616px" && kept(beforeBack, await ev(rowTopOf(bRow("s-kaja")))), { share: await ev(shareVar), beforeBack, after: await ev(rowTopOf(bRow("s-kaja"))) });
  await ev(`click(${bTool("Narrower")})`);
  const narrower = await ev(shareVar);
  check("4: Narrower in the browser changes only the browser's width", narrower !== "616px" && (await ev(`localStorage.getItem("pobots.browserShare") !== null && localStorage.getItem("pobots.artifactShare") === null`)) === true, narrower);
  await open(BS);
  await stubOutside();
  await goTo("Kaja", "chat");
  await until(`!!${bPane} && ${shown}`, 3000);
  check("4: the browser's width is remembered across a reload", (await ev(shareVar)) === narrower, await ev(shareVar));
  await ev(`(() => { localStorage.removeItem("pobots.browserShare"); return true; })()`);
  await ev(`click(${bTool("Close")})`);
  await until(`!$(".app-artifact")`);

  // ---------------- 1: the address follows the page
  await openKaja();
  await ev(`window.pobotsMock.browserNavigate("s-kaja", "https://app.example.com/surveys/nordvik", "Nordvik survey")`);
  check("1: in a bot's workspace the muted line follows a navigation within a moment", !!(await until(`text(".pb-browser-where") === "Nordvik survey · app.example.com"`, 1500)));
  // Your own page, made new: no address yet.
  await ev(`click(${bTool("Other work in the browser")})`);
  await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Your page"))`);
  await until(`!!$(".pb-browser-address") && ${shown}`, 3000);
  await ev(`click(${bTool("Other work in the browser")})`);
  await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Close your page"))`);
  await until(`${stateLine} === "Your page was closed"`, 3000);
  await ev(`click(${bTool("Other work in the browser")})`);
  await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent === "Your page"))`);
  check("1: a new page of your own (the browser's own new page) shows an empty address line with its placeholder", !!(await until(`${shown} && $(".pb-browser-address")?.value === "" && $(".pb-browser-address").placeholder === "Type an address" && window.pobotsMock.browserPage(window.pobotsMock.browserWatching().spaceId).url === "chrome://newtab/"`, 3000)), await ev(`({ value: $(".pb-browser-address")?.value, shown: ${shown} })`));
  check("1: and nothing of the browser's own words (no tab, no internal address) anywhere in the panel", (await ev(`!/chrome:|new tab|newtab|about:blank/i.test($(".pb-browser-panel").innerText + " " + $(".pb-browser-address").value)`)) === true);
  await ev(`(() => { const a = $(".pb-browser-address"); a.focus(); a.select(); return true; })()`);
  await type("example.com");
  await key("Enter");
  check("1: typed example.com and Enter: the address line shows the page's address within a moment", !!(await until(`$(".pb-browser-address").value === "https://example.com" && document.activeElement !== $(".pb-browser-address")`, 1500)), await ev(`$(".pb-browser-address").value`));
  let p2 = await pageAt(places.link.x + 40, places.link.y + 20);
  await clickAt(p2.x, p2.y);
  check("1: after a link: the new address", !!(await until(`$(".pb-browser-address").value === "https://example.com/next"`, 1500)), await ev(`$(".pb-browser-address").value`));
  await ev(`click(${bTool("Back")})`);
  check("1: after Back: the address before", !!(await until(`$(".pb-browser-address").value === "https://example.com"`, 1500)));
  await ev(`click(${bTool("Forward")})`);
  check("1: after Forward: the address after", !!(await until(`$(".pb-browser-address").value === "https://example.com/next"`, 1500)));
  await ev(`click(${bTool("Close")})`);
  await until(`!$(".app-artifact")`);

  // ---------------- 2: drop-down lists, as one of the app's own menus
  await openKaja();
  await control();
  const list0 = places.lists[0];
  let p = await pageAt(list0.x + 100, list0.y + 20);
  await clickAt(p.x, p.y);
  check("2: a press on a drop-down list shows its choices over the picture", !!(await until(`!!${choices} && ${choices}.getAttribute("role") === "listbox"`, 2000)));
  const menu = await ev(`(() => { const m = ${choices}, r = m.getBoundingClientRect(), c = $(".pb-browser-canvas").getBoundingClientRect(), body = $(".pb-browser-body").getBoundingClientRect(), opts = $$(".pb-browser-choice");
    return { n: opts.length, labels: opts.map((o) => o.textContent), disabled: opts.filter((o) => o.getAttribute("aria-disabled") === "true").map((o) => o.textContent), selected: opts.filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.textContent),
      heads: $$(".pb-browser-choices .pb-browser-menu-title").map((h) => h.textContent), focus: document.activeElement?.textContent, top: r.top, left: r.left, right: r.right, bottom: r.bottom, body: { top: body.top, left: body.left, right: body.right, bottom: body.bottom }, c: { left: c.left, top: c.top, w: c.width },
      surface: getComputedStyle(m).backgroundColor, shadow: getComputedStyle(m).boxShadow !== "none", radius: parseFloat(getComputedStyle(m).borderTopLeftRadius), anim: getComputedStyle(m).animationName }; })()`);
  const scale = menu ? menu.c.w / 1280 : 1;
  const boxBottom = menu ? menu.c.top + (list0.y + list0.h) * scale : 0;
  const boxLeft = menu ? menu.c.left + list0.x * scale : 0;
  check("2: the choices: every option, the disabled one marked, the group heading, the chosen one checked", menu?.n === 6 && JSON.stringify(menu.disabled) === JSON.stringify(["Only once"]) && JSON.stringify(menu.heads) === JSON.stringify(["Less often"]) && JSON.stringify(menu.selected) === JSON.stringify(["Every week"]), menu);
  check("2: placed under the list's box, scaled like the picture, inside the panel", !!menu && menu.top >= boxBottom - 1 && menu.top <= boxBottom + 12 && Math.abs(menu.left - Math.min(boxLeft, menu.body.right - 8 - (menu.right - menu.left))) <= 2 && menu.right <= menu.body.right && menu.bottom <= menu.body.bottom && menu.left >= menu.body.left, { menu, boxBottom, boxLeft });
  check("2: in the look of the app's menus (overlay, shadow, rounded), arriving calmly", !!menu && menu.shadow && menu.radius >= 8 && menu.anim === "pb-arrive", menu);
  check("2: the chosen option has the focus", menu?.focus === "Every week", menu?.focus);
  await houseRules("2: the choices of a drop-down list");
  await sleep(200);
  const inBefore = await ev(inputCount);
  p = await pageAt(200, 600);
  await mouse("mouseMoved", p.x, p.y);
  await sleep(150);
  check("2: while they are open nothing else goes to the page", (await ev(inputCount)) === inBefore, { before: inBefore, after: await ev(inputCount) });
  await key("ArrowDown");
  check("2: Down moves to the next option", (await ev(`document.activeElement?.textContent`)) === "Every month");
  await key("ArrowDown");
  check("2: Down skips the disabled option", (await ev(`document.activeElement?.textContent`)) === "Every quarter");
  await key("End");
  check("2: End goes to the last", (await ev(`document.activeElement?.textContent`)) === "Every year");
  await key("Home");
  check("2: Home goes to the first", (await ev(`document.activeElement?.textContent`)) === "Every week");
  for (const ch of "every h") await press(ch, { code: ch === " " ? "Space" : `Key${ch.toUpperCase()}`, text: ch });
  check("2: typing the first letters goes to that option", (await ev(`document.activeElement?.textContent`)) === "Every half year", await ev(`document.activeElement?.textContent`));
  await key("Enter");
  check("2: Enter chooses: the list's value changes on the page, the choices close, the focus goes back to the picture", !!(await until(`!${choices} && ${pageNow()}.lists[0] === "Every half year" && document.activeElement === $(".pb-browser-picture")`, 2000)), await ev(`${pageNow()}.lists`));
  check("2: and no input went to the page while they were open", (await ev(inputCount)) === inBefore);
  // The keyboard opens it too (the list has the focus), and Escape closes without choosing and stays out of the page.
  await key("ArrowDown");
  check("2: Down on a list with the focus opens the choices", !!(await until(`!!${choices}`, 2000)));
  await sleep(200);
  const inEsc = await ev(inputCount);
  await key("Escape");
  check("2: Escape closes them, the value stays, Escape is not passed to the page, the panel stays", !!(await until(`!${choices}`, 1500)) && (await ev(`${pageNow()}.lists[0]`)) === "Every half year" && (await ev(`${flat}.slice(-3).some((e) => e.type === "key" && e.key === "Escape")`)) === false && (await ev(inputCount)) === inEsc && (await ev(`!!${bPane}`)) === true);
  // The pointer: a click on an option chooses it; a press elsewhere closes without choosing.
  p = await pageAt(list0.x + 100, list0.y + 20);
  await clickAt(p.x, p.y);
  await until(`!!${choices}`, 2000);
  const opt = await ev(`(() => { const r = $$(".pb-browser-choice").find((o) => o.textContent === "Every month").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await clickAt(opt.x, opt.y);
  check("2: a click on an option chooses it", !!(await until(`!${choices} && ${pageNow()}.lists[0] === "Every month"`, 2000)));
  await clickAt(p.x, p.y);
  await until(`!!${choices}`, 2000);
  await sleep(200);
  const inAway = await ev(inputCount);
  const away = await pageAt(200, 700);
  await clickAt(away.x, away.y);
  check("2: a press elsewhere on the picture closes them without choosing, and does not reach the page", !!(await until(`!${choices}`, 1500)) && (await ev(`${pageNow()}.lists[0]`)) === "Every month" && (await ev(inputCount)) === inAway);
  // A long list scrolls inside, and stays inside the panel.
  const list1 = places.lists[1];
  p = await pageAt(list1.x + 100, list1.y + 20);
  await clickAt(p.x, p.y);
  const long = await until(`(() => { const m = ${choices}; if (!m) return null; const r = m.getBoundingClientRect(), body = $(".pb-browser-body").getBoundingClientRect(); return { n: m.querySelectorAll(".pb-browser-choice").length, scrolls: m.scrollHeight > m.clientHeight + 4, inside: r.top >= body.top - 0.5 && r.bottom <= body.bottom + 0.5 && r.left >= body.left - 0.5 && r.right <= body.right + 0.5 }; })()`, 2000);
  check("2: a long list scrolls inside its menu, which stays inside the panel", long?.n === 31 && long.scrolls && long.inside, long);
  await key("End");
  check("2: End brings the last option into view", (await ev(`(() => { const a = document.activeElement, m = ${choices}; const r = a.getBoundingClientRect(), mr = m.getBoundingClientRect(); return a.textContent === "Day 31 of the month" && r.bottom <= mr.bottom + 1 && r.top >= mr.top - 1; })()`)) === true);
  await fShot("choices-long-dark-1280");
  await key("Escape");
  await until(`!${choices}`, 1500);
  // Handing back closes them.
  p = await pageAt(list0.x + 100, list0.y + 20);
  await clickAt(p.x, p.y);
  await until(`!!${choices}`, 2000);
  await ev(`click(${take})`);
  check("2: handing control back closes the choices", !!(await until(`!${choices} && ${take}.textContent === "Take control"`, 2000)));
  await control();
  await clickAt(p.x, p.y);
  await until(`!!${choices}`, 2000);
  await ev(`window.pobotsMock.browserNavigate("s-kaja", "https://app.example.com/surveys/other", "Other survey")`);
  check("2: the engine saying they are gone closes them (the page moved on)", !!(await until(`!${choices}`, 2000)));
  await clickAt(p.x, p.y);
  await until(`!!${choices}`, 2000);
  await ev(`click(${bTool("Close")})`);
  check("2: closing the panel (the watch ends) closes them", !!(await until(`!$(".app-artifact") && !${choices}`, 2000)));

  // ---------------- 3: the page's own question, over the picture
  await openKaja();
  await control();
  p = await pageAt(places.ask.x + 40, places.ask.y + 20);
  await clickAt(p.x, p.y);
  check("3: a question of the page shows over the picture as a small raised card", !!(await until(`!!${ask}`, 2000)));
  const card = await ev(`(() => { const a = ${ask}, r = a.getBoundingClientRect(), c = $(".pb-browser-canvas").getBoundingClientRect();
    return { role: a.getAttribute("role"), label: document.getElementById(a.getAttribute("aria-labelledby"))?.textContent, said: document.getElementById(a.getAttribute("aria-describedby"))?.textContent, head: text(".pb-browser-ask-head"), headColour: getComputedStyle($(".pb-browser-ask-head")).color,
      buttons: $$(".pb-browser-ask button").map((x) => x.textContent), focus: document.activeElement?.textContent, centre: Math.abs((r.left + r.right) / 2 - (c.left + c.right) / 2), top: r.top - c.top, anim: getComputedStyle(a).animationName, shadow: getComputedStyle(a).boxShadow !== "none", dim: $(".pb-browser-panel").hasAttribute("data-asked") }; })()`);
  check("3: it reads The page asks, the page's message, OK and Cancel; a screen reader hears it as an alert dialog", card?.role === "alertdialog" && card.label === "The page asks" && card.said === "Leave this page? The changes you made are not saved yet." && JSON.stringify(card.buttons) === JSON.stringify(["OK", "Cancel"]), card);
  check("3: at the top in the middle of the picture, raised, arriving with the calm fade", !!card && card.centre <= 2 && card.top >= 0 && card.top <= 40 && card.shadow && card.anim === "pb-arrive", card);
  check("3: in control it takes the focus", card?.focus === "OK", card?.focus);
  check("3: the picture under it is dimmed a little", card?.dim && !!(await until(`(() => { const o = parseFloat(getComputedStyle($(".pb-browser-canvas")).opacity); return o > 0.5 && o < 0.9; })()`, 1500)));
  await houseRules("3: the page's question");
  await fShot("question-dark-1280");
  await ev(`click($$(".pb-browser-ask button").find((x) => x.textContent === "Cancel"))`);
  check("3: Cancel answers it: the page hears Cancel, the card goes, the focus back on the picture", !!(await until(`!${ask} && ${pageNow()}.heard === "Cancel" && document.activeElement === $(".pb-browser-picture") && !$(".pb-browser-panel").hasAttribute("data-asked")`, 2000)));
  p = await pageAt(places.name.x + 40, places.name.y + 20);
  await clickAt(p.x, p.y);
  check("3: a prompt has a text field with the page's default text, selected and focused", !!(await until(`(() => { const f = $(".pb-browser-ask-input"); return !!f && f.value === "Survey copy" && document.activeElement === f && f.selectionStart === 0 && f.selectionEnd === 11; })()`, 2000)));
  const inAsk = await ev(inputCount);
  await type("Final copy");
  await key("Enter");
  const answered3 = !!(await until(`!${ask} && ${pageNow()}.heard === "OK: Final copy"`, 2000));
  // (The release of the click that opened the question may leave before the question arrives; the page ignores it while it asks.)
  const typedSent = await ev(`${inputs}.slice(${inAsk}).flat().filter((e) => e.type === "key" || e.type === "text")`);
  check("3: Enter in the field answers OK with the text; what was typed never went to the page as input", answered3 && Array.isArray(typedSent) && typedSent.length === 0, { answered3, heard: await ev(`${pageNow()}.heard`), typedSent });
  p = await pageAt(places.ask.x + 40, places.ask.y + 20);
  await clickAt(p.x, p.y);
  await until(`!!${ask}`, 2000);
  await key("Escape");
  check("3: Escape cancels it, and the panel stays", !!(await until(`!${ask} && ${pageNow()}.heard === "Cancel" && !!${bPane}`, 2000)));
  // Without control: the buttons are off and one quiet line says so; it does not take the focus.
  await ev(`click(${take})`);
  await until(`${take}.textContent === "Take control"`);
  await ev(`$(".pb-browser-picture").focus()`);
  await ev(`window.pobotsMock.browserAsk("s-kaja", { type: "alert", message: "The survey was saved." })`);
  const off = await until(`(() => { const a = ${ask}; if (!a) return null; return { buttons: $$(".pb-browser-ask button").map((x) => [x.textContent, x.disabled]), foot: text(".pb-browser-ask-foot"), focusIn: a.contains(document.activeElement) }; })()`, 2000);
  check("3: an alert has only OK; without control it is off, with Take control to answer, and the focus stays where it was", JSON.stringify(off?.buttons) === JSON.stringify([["OK", true]]) && off.foot === "Take control to answer" && !off.focusIn, off);
  await fShot("question-no-control-dark-1280");
  await ev(`click(${take})`);
  check("3: taking control lets the person answer, and then it takes the focus", !!(await until(`${take}.textContent === "Hand back" && document.activeElement?.textContent === "OK" && !$$(".pb-browser-ask button")[0].disabled`, 2000)));
  await key("Enter");
  check("3: answered (OK on an alert)", !!(await until(`!${ask} && ${pageNow()}.heard === "OK"`, 2000)));
  // A long message is kept to a few lines, the rest scrolling.
  await ev(`window.pobotsMock.browserAsk("s-kaja", { type: "confirm", message: ${JSON.stringify("This page has a long question. ".repeat(30))} })`);
  const longMsg = await until(`(() => { const m = $(".pb-browser-ask-message"); return m ? { h: m.getBoundingClientRect().height, scrolls: m.scrollHeight > m.clientHeight } : null; })()`, 2000);
  check("3: a long message is kept to a few lines, the rest scrolling", !!longMsg && longMsg.h <= 90 && longMsg.scrolls, longMsg);
  // Answered somewhere else (the bot, or the page): it goes.
  await ev(`window.pobotsMock.browserAsk("s-kaja", null)`);
  check("3: answered elsewhere: the card goes", !!(await until(`!${ask}`, 2000)));
  // A watch that starts while the page asks hears it.
  await ev(`window.pobotsMock.browserAsk("s-kaja", { type: "confirm", message: "Still there?" })`);
  await until(`!!${ask}`, 2000);
  await ev(`click(${bTool("Close")})`);
  await until(`!$(".app-artifact")`);
  await ev(`click(${bRow("s-kaja")})`);
  check("3: opened again while the page still asks: the question is there again", !!(await until(`!!${ask} && $(".pb-browser-ask-message").textContent === "Still there?"`, 3000)));
  await control();
  await ev(`click($$(".pb-browser-ask button").find((x) => x.textContent === "OK"))`);
  await until(`!${ask}`, 2000);

  // ---------------- 5: copy and paste when the laptop's browser refuses the clipboard
  await ev(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("not allowed"); } } }); return true; })()`);
  await ev(`$(".pb-browser-picture").focus()`);
  await press("a", { code: "KeyA", mods: 2 });
  await press("c", { code: "KeyC", mods: 2 });
  check("5: a refused clipboard: one quiet line in the state line", !!(await until(`${stateLine} === "Copied inside this page only. Your browser did not allow the clipboard."`, 2000)), await ev(stateLine));
  const kept5 = await ev(`${pageNow()}.selected`);
  const before5 = await ev(`${flat}.length`);
  // A real keyboard path: Ctrl+V and the browser's own paste command, as the laptop's keyboard does it.
  await b.cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86, commands: ["paste"] });
  await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86 });
  await sleep(200);
  const realPaste = await ev(`${flat}.slice(${before5})`);
  const viaKeys = Array.isArray(realPaste) && realPaste.some((e) => e.type === "text" && e.text === kept5);
  if (!viaKeys) {
    // The headless browser fires no paste event for the command: the same event a browser sends, with no text.
    await ev(`(() => { const dt = new DataTransfer(); $(".pb-browser-picture").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  }
  check(`5: the next paste with no text in it uses the text kept from the page (${viaKeys ? "a real Ctrl+V" : "a paste event, as Ctrl+V gives"})`, !!(await until(`${flat}.slice(${before5}).some((e) => e.type === "text" && e.text === ${JSON.stringify(kept5)})`, 1500)) && !(await ev(`${flat}.slice(${before5}).some((e) => e.type === "key" && e.key === "v")`)), { kept5, sent: await ev(`${flat}.slice(${before5})`) });
  const before5b = await ev(`${flat}.length`);
  await ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "older clipboard text"); $(".pb-browser-picture").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  check("5: a paste whose text is older than that copy also uses the kept text (the clipboard was refused)", !!(await until(`${flat}.slice(${before5b}).some((e) => e.type === "text" && e.text === ${JSON.stringify(kept5)})`, 1500)));
  await ev(`(() => { window.dispatchEvent(new Event("blur")); return true; })()`);
  const before5c = await ev(`${flat}.length`);
  await ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "from another program"); $(".pb-browser-picture").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  check("5: after the window lost the focus (a copy elsewhere is possible), the laptop's clipboard counts again", !!(await until(`${flat}.slice(${before5c}).some((e) => e.type === "text" && e.text === "from another program")`, 1500)));
  await fShot("clipboard-refused-dark-1280", `$(".pb-browser-bar").parentElement`);

  // ---------------- 6: does anything in the chat move when the browser row changes state? A long chat, every frame.
  await open(BS);
  await stubOutside();
  await goTo("Kaja", "chat");
  await until(`!!${bRow("s-kaja")}`);
  await ev(`window.pobotsMock.holdSteps(true)`);
  await ev(`(() => { $(".pb-composer textarea").focus(); return true; })()`);
  await type("Check the import in the browser and leave it open.");
  await key("Enter");
  const liveRow = `${bRows}.filter((x) => x.querySelector(".pb-browser-name").textContent === "Look up the Nordvik import").pop()`;
  for (let i = 0; i < 40 && (await ev(`window.pobotsMock.stepPhase()`)) !== "working in the browser"; i++) {
    await ev(`window.pobotsMock.stepOn()`);
    await sleep(200);
  }
  await until(`!!${liveRow}`, 3000);
  // Read with the row in view and lines above it: the line at the top and the row stay put through every change of the row.
  const spaceOfLive = `window.pobotsMock.browserState().spaces.find((x) => x.name === "Look up the Nordvik import").id`;
  const watchJumps = () => ev(`(() => { window.__jumps = { frames: 0, moves: [] }; const s = $(".app-main .pb-main-scroll"); const row = ${liveRow}; const first = lineTop(s); const r0 = row.getBoundingClientRect();
    window.__jumpWatch = true; const f = () => { if (!window.__jumpWatch) return; window.__jumps.frames++; const t = first.el.getBoundingClientRect().top - s.getBoundingClientRect().top; const r = row.getBoundingClientRect();
      if (Math.abs(t - first.top) > 0.5 || Math.abs(r.top - r0.top) > 0.5 || Math.abs(r.height - r0.height) > 0.5) window.__jumps.moves.push({ t: Math.round(t - first.top), row: Math.round(r.top - r0.top), h: Math.round(r.height - r0.height), at: window.__jumps.frames }); requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
  const stopJumps = () => ev(`(() => { window.__jumpWatch = false; return window.__jumps; })()`);
  await ev(readAt(liveRow, 300));
  await sleep(300);
  await watchJumps();
  const live6 = await ev(spaceOfLive);
  await ev(`window.pobotsMock.browserBusy(${JSON.stringify(live6)}, false)`);
  await sleep(400);
  await ev(`window.pobotsMock.browserBusy(${JSON.stringify(live6)}, true)`);
  await sleep(400);
  await ev(`window.pobotsMock.browserNavigate(${JSON.stringify(live6)}, "https://app.example.com/imports/done", "Import done")`);
  await sleep(1500);
  const jumps = await stopJumps();
  check("6: in a long chat, while the row goes from working to open and back and its line changes, nothing above or at it moves (every frame)", !!jumps && jumps.frames > 60 && jumps.moves.length === 0, jumps);
  await ev(`window.pobotsMock.holdSteps(false)`);
  await until(`!!$$(".app-main .pb-answer").pop().dataset.folded`, 8000);
  await ev(readAt(liveRow, 300));
  await sleep(300);
  await watchJumps();
  await ev(`window.pobotsMock.closeBrowserSpace(${JSON.stringify(live6)})`);
  await sleep(1500);
  const jumps2 = await stopJumps();
  check("6: and when its workspace closes after the turn (Closed in its box), nothing moves either", !!jumps2 && jumps2.frames > 30 && jumps2.moves.length === 0 && (await ev(`${liveRow}.dataset.status`)) === "closed", jumps2);

  // ---------------- pictures: the choices and the page's question, light and dark; the wider default
  for (const theme of ["dark", "light"]) {
    await ev(`(() => { localStorage.removeItem("pobots.browserShare"); sessionStorage.clear(); return true; })()`);
    await openKaja({ theme });
    await fShot(`wider-default-${theme}-1280`);
    await control();
    p = await pageAt(list0.x + 100, list0.y + 20);
    await clickAt(p.x, p.y);
    await until(`!!${choices}`, 2000);
    await key("ArrowDown");
    await houseRules(`${theme}: the choices`);
    await fShot(`choices-${theme}-1280`);
    await key("Escape");
    await until(`!${choices}`, 1500);
    p = await pageAt(places.name.x + 40, places.name.y + 20);
    await clickAt(p.x, p.y);
    await until(`!!${ask}`, 2000);
    await houseRules(`${theme}: the page's question`);
    await fShot(`question-prompt-${theme}-1280`);
    await key("Escape");
    await until(`!${ask}`, 1500);
    await ev(`click(${bTool("Fill the main area")})`);
    await until(`${mode} === "full"`);
    p = await pageAt(list1.x + 100, list1.y + 20);
    await clickAt(p.x, p.y);
    await until(`!!${choices}`, 2000);
    await fShot(`choices-long-full-${theme}-1280`);
    await key("Escape");
    await ev(`click(${bTool("Show the chat beside it")})`);
    await ev(`click(${bTool("Close")})`);
    await until(`!$(".app-artifact")`);
  }
  // 800 px: the choices and the question in the narrow panel.
  await openKaja({ width: 800 });
  await control();
  p = await pageAt(list0.x + 100, list0.y + 20);
  await clickAt(p.x, p.y);
  const narrowMenu = await until(`(() => { const m = ${choices}; if (!m) return null; const r = m.getBoundingClientRect(), body = $(".pb-browser-body").getBoundingClientRect(); return r.left >= body.left - 0.5 && r.right <= body.right + 0.5 && r.bottom <= body.bottom + 0.5 && r.top >= body.top - 0.5; })()`, 2000);
  check("2: at 800 px the choices stay inside the panel", narrowMenu === true);
  await houseRules("800 px, the choices");
  await fShot("choices-dark-800");
  await key("Escape");
  if (fixesShots) console.log(`Round two pictures in ${fixesShots}`);
  }


  // ================================================================ step 2g, round three: the row of pages and a sharper picture (in section 2g)
  // docs/build/step-2g-tabs.md. The row of pages between the top line and the state line (one fixed
  // height, always there), choosing a page ("browser.page.show") with and without control, pages
  // opening and closing while watched, many pages, the person's own page with its add and close
  // controls, the keyboard, a page's question marked on its page, and the pictures at the size they
  // are drawn ("browser.view", a sharp PNG once the page stands still). Pictures go to --tabs-shots.
  {
  const tabsShots = arg("tabs-shots") ?? (shots ? join(shots, "tabs") : undefined);
  if (tabsShots) mkdirSync(tabsShots, { recursive: true });
  async function tShot(name, selector, scale = 2) {
    if (!tabsShots) return;
    await sleep(500);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 12;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(tabsShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const tabs = `$$(".pb-browser-tab")`;
  const tabNames = `${tabs}.map((t) => t.querySelector(".pb-browser-tab-name").textContent)`;
  const chosenTab = `${tabs}.find((t) => t.getAttribute("aria-selected") === "true")`;
  const tabRow = `$(".pb-browser-tabs")`;
  const watching = `window.pobotsMock.browserWatching()`;
  const spaceNow = (id) => `window.pobotsMock.browserState().spaces.find((s) => s.id === ${JSON.stringify(id)})`;
  /** Where the picture and the row are, and the row's height, to prove nothing moves. */
  const geometry = `(() => { const c = $(".pb-browser-picture").getBoundingClientRect(), r = ${tabRow}.getBoundingClientRect(), s = $(".pb-browser-stateline").getBoundingClientRect(); return { pic: Math.round(c.top * 10) / 10, picLeft: Math.round(c.left * 10) / 10, row: Math.round(r.height * 10) / 10, rowTop: Math.round(r.top * 10) / 10, state: Math.round(s.top * 10) / 10 }; })()`;
  /** Samples the geometry on every frame for a while; returns the distinct values seen. */
  const sampleGeometry = (ms) => `(async () => { const seen = new Set(); const end = performance.now() + ${ms}; while (performance.now() < end) { await new Promise((r) => requestAnimationFrame(r)); const g = ${geometry}; seen.add(JSON.stringify([g.pic, g.picLeft, g.row, g.rowTop, g.state])); } return [...seen]; })()`;
  async function openOn(space = "s-kaja", opts) {
    await open(BS, opts);
    await stubOutside();
    await goTo("Kaja", "chat");
    if (space === "s-kaja") {
      await until(`!!${bRow("s-kaja")}`);
      await ev(readAt(bRow("s-kaja"), 200));
      await ev(`click(${bRow("s-kaja")})`);
    } else {
      await ev(`click($(".pb-browser-line"))`);
      await until(`!!${bPane}`);
      await ev(`click(${bTool("Other work in the browser")})`);
      await ev(`click($$(".pb-browser-menu .pb-option").find((o) => o.textContent.trim() === ${JSON.stringify(space === "s-you" ? "Your page" : "Inventory sync")}))`);
      await until(`$(".pb-browser-panel")?.dataset.spaceId === ${JSON.stringify(space)}`);
    }
    await until(`!!${bPane} && ${shown}`, 3000);
    await sleep(150);
  }
  async function takeControl() {
    if ((await ev(`${take}.textContent`)) !== "Hand back") await ev(`click(${take})`);
    await until(`${take}.textContent === "Hand back"`);
  }
  async function handBack() {
    if ((await ev(`${take}.textContent`)) === "Hand back") await ev(`click(${take})`);
    await until(`${take}.textContent === "Take control"`);
  }

  // ---------------- the row: where it is, what it says, one fixed height
  await openOn("s-kaja");
  const order = await ev(`[...$(".pb-browser-panel").children].map((c) => c.className.split(" ").find((n) => n.startsWith("pb-browser-")) || c.className)`);
  check("t1: the row of pages stands between the top line and the state line", JSON.stringify(order?.slice(0, 3)) === JSON.stringify(["pb-browser-bar", "pb-browser-tabs", "pb-browser-stateline"]), order);
  const roleInfo = await ev(`({ list: $('.pb-browser-tabs [role="tablist"]')?.getAttribute("aria-label"), roles: ${tabs}.map((t) => t.getAttribute("role")), names: ${tabNames}, chosen: ${tabs}.map((t) => t.getAttribute("aria-selected")), stops: ${tabs}.map((t) => t.tabIndex), controls: ${chosenTab}.getAttribute("aria-controls") === $(".pb-browser-picture").id, title: ${tabs}[0].title })`);
  check("t1: a screen reader hears a tab list named Pages, one tab per page, in the browser's order", roleInfo?.list === "Pages" && JSON.stringify(roleInfo.roles) === JSON.stringify(["tab", "tab"]) && JSON.stringify(roleInfo.names) === JSON.stringify(["Surveys", "Survey settings"]), roleInfo);
  check("t1: the page shown is chosen, and the row is one stop (the page shown)", JSON.stringify(roleInfo?.chosen) === JSON.stringify(["true", "false"]) && JSON.stringify(roleInfo.stops) === JSON.stringify([0, -1]) && roleInfo.controls, roleInfo);
  check("t1: the full title and the host on hover", roleInfo?.title === "Surveys\napp.example.com", roleInfo?.title);
  const look = await ev(`(() => { const on = getComputedStyle(${chosenTab}), off = getComputedStyle(${tabs}[1]); return { onBg: on.backgroundColor, offBg: off.backgroundColor, onWeight: on.fontWeight, offWeight: off.fontWeight, shadow: on.boxShadow, border: on.borderTopStyle + on.borderLeftStyle, h: ${tabRow}.getBoundingClientRect().height }; })()`);
  check("t1: the page shown is marked by its surface and weight, no border, no stripe", look && look.onBg !== look.offBg && Number(look.onWeight) > Number(look.offWeight) && look.border === "nonenone" && look.shadow === "none", look);
  check("t1: the row has one fixed height (36 px)", look?.h === 36, look?.h);
  check("t1: in a bot's workspace there is no add control and no close control", (await ev(`!$(".pb-browser-tab-add") && !$(".pb-browser-tab-close")`)) === true);
  check("t1: the old page menu is gone; the workspace menu stays", (await ev(`!${bTool("Another page")} && !!${bTool("Other work in the browser")}`)) === true);
  await houseRules("t1: the row of pages");

  // ---------------- a page opening and closing while watched: the row changes in place, nothing moves
  const g0 = await ev(geometry);
  await ev(`(() => { window.__geo = ${sampleGeometry(1600)}; return true; })()`);
  const third = await ev(`window.pobotsMock.browserOpenPage("s-kaja", "https://app.example.com/surveys/nordvik", "Nordvik survey")`);
  check("t2: a page that opens while watched joins the row in place", !!(await until(`JSON.stringify(${tabNames}) === JSON.stringify(["Surveys", "Survey settings", "Nordvik survey"])`, 2000)));
  check("t2: the watch follows the page in front, so the new page is shown", !!(await until(`${chosenTab}?.dataset.pageId === ${JSON.stringify(third)} && $(".pb-browser-where").textContent === "Nordvik survey · app.example.com"`, 2000)));
  const geoOpen = await ev(`window.__geo`);
  check("t2: the picture, the row and the state line never moved by a pixel while the page opened (every frame)", Array.isArray(geoOpen) && geoOpen.length === 1 && JSON.parse(geoOpen[0])[0] === g0.pic, { g0, geoOpen });
  await tShot("tabs-three-dark-1280");
  await tShot("tabs-three-row-dark-1280", `$(".pb-browser-bar").parentElement.querySelector(".pb-browser-tabs")`);
  await ev(`(() => { window.__geo = ${sampleGeometry(1600)}; return true; })()`);
  await ev(`window.pobotsMock.browserClosePage("s-kaja", ${JSON.stringify(third)})`);
  check("t2: a page that closes leaves the row in place, and the page in front is shown", !!(await until(`JSON.stringify(${tabNames}) === JSON.stringify(["Surveys", "Survey settings"]) && ${chosenTab}?.dataset.pageId === ${spaceNow("s-kaja")}.pages.find((p) => p.active).id`, 2000)));
  const geoClose = await ev(`window.__geo`);
  check("t2: nothing moved while it closed either, and the panel does not say closed", Array.isArray(geoClose) && geoClose.length === 1 && (await ev(`!$(".pb-browser-panel").dataset.ended && !/closed/i.test(${stateLine})`)) === true, geoClose);

  // ---------------- choosing a page without control: it comes to the front, the watch follows the front
  // (in the bots' browser any look at a page brings it to the front, so a page cannot be shown and left behind)
  const kajaPages = await ev(`${spaceNow("s-kaja")}.pages.map((p) => p.id)`);
  const showsBefore = await ev(`window.pobotsMock.browserShows().length`);
  const frontBefore = await ev(`${spaceNow("s-kaja")}.pages.find((p) => p.active).id`);
  const other = kajaPages.find((id) => id !== frontBefore);
  await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(other)}))`);
  check("t3: choosing a page shows it (browser.page.show with that page)", !!(await until(`${watching}?.shown === ${JSON.stringify(other)} && ${chosenTab}?.dataset.pageId === ${JSON.stringify(other)}`, 2000)) && JSON.stringify(await ev(`window.pobotsMock.browserShows().slice(${showsBefore})`)) === JSON.stringify([other]));
  check("t3: it comes to the front in the browser, and control is not taken", (await ev(`${spaceNow("s-kaja")}.pages.find((p) => p.active).id`)) === other && (await ev(`${take}.textContent`)) === "Take control");
  check("t3: the watch goes on (no new browser.watch), follows the front page, and the picture is of the chosen page", (await ev(`${reqs("browser.watch")}`)) === 1 && (await ev(`${watching}.pageId`)) === undefined && !!(await until(`$(".pb-browser-where").textContent.startsWith(${JSON.stringify(await ev(`${spaceNow("s-kaja")}.pages.find((p) => p.id === ${JSON.stringify(other)}).title`))})`, 2000)));
  await tShot("tabs-chosen-dark-1280", tabRow);
  // The bot goes back to its page: the view follows it there.
  await ev(`window.pobotsMock.browserFront("s-kaja", ${JSON.stringify(frontBefore)})`);
  check("t3: a bot that goes to another page is followed there, and the row marks it", !!(await until(`${watching}.shown === ${JSON.stringify(frontBefore)} && ${chosenTab}?.dataset.pageId === ${JSON.stringify(frontBefore)}`, 2000)));
  const fresh = await ev(`window.pobotsMock.browserOpenPage("s-kaja", "https://app.example.com/report", "Report")`);
  check("t3: and a page the bot opens is followed", !!(await until(`${chosenTab}?.dataset.pageId === ${JSON.stringify(fresh)} && ${watching}.shown === ${JSON.stringify(fresh)}`, 2000)));

  // ---------------- choosing a page with control: it comes to the front in the browser, control is kept
  await takeControl();
  const target = kajaPages[0];
  await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(target)}))`);
  check("t4: with control the chosen page comes to the front in the browser", !!(await until(`${spaceNow("s-kaja")}.pages.find((p) => p.active).id === ${JSON.stringify(target)} && ${watching}.shown === ${JSON.stringify(target)}`, 2000)));
  check("t4: control is kept, and the watch follows the front page from then on", (await ev(`${take}.textContent`)) === "Hand back" && (await ev(`${watching}.pageId`)) === undefined);
  await handBack();
  await ev(`window.pobotsMock.browserClosePage("s-kaja", ${JSON.stringify(fresh)})`);
  await until(`${tabs}.length === 2`);

  // ---------------- the keyboard: one stop, Left and Right move, Enter or Space chooses, Home and End
  await ev(`${chosenTab}.focus()`);
  await key("ArrowRight");
  const moved = await ev(`({ focus: document.activeElement?.dataset.pageId, chosen: ${chosenTab}.dataset.pageId, ids: ${tabs}.map((t) => t.dataset.pageId) })`);
  check("t5: Right moves the focus to the next page, without choosing it", moved && moved.focus === moved.ids[1] && moved.chosen === moved.ids[0], moved);
  await key("Enter");
  check("t5: Enter chooses the focused page", !!(await until(`${chosenTab}?.dataset.pageId === ${JSON.stringify(moved?.ids[1])}`, 2000)));
  await key("Home");
  check("t5: Home goes to the first page", (await ev(`document.activeElement?.dataset.pageId`)) === moved?.ids[0]);
  await press(" ", { code: "Space", text: " ", vk: 32 });
  check("t5: Space chooses too", !!(await until(`${chosenTab}?.dataset.pageId === ${JSON.stringify(moved?.ids[0])}`, 2000)));
  await key("End");
  check("t5: End goes to the last page", (await ev(`document.activeElement?.dataset.pageId`)) === moved?.ids.at(-1));
  await key("ArrowLeft");
  check("t5: Left moves back", (await ev(`document.activeElement?.dataset.pageId`)) === moved?.ids[0]);
  await press("Delete", { vk: 46 });
  check("t5: Delete does nothing in a bot's workspace", (await ev(`${tabs}.length`)) === 2 && (await ev(`${reqs("browser.page.close")}`)) === 0);
  check("t5: the focused page has the focus ring", (await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.getAttribute("role") === "tab" && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`)) === true);
  await ev(`${chosenTab}.focus()`);
  await key("Tab");
  check("t5: Tab leaves the row in one step (the row is one stop)", (await ev(`document.activeElement?.getAttribute("role") !== "tab"`)) === true);

  // ---------------- a page's question belongs to its page
  const asker = kajaPages[1];
  await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(asker)}))`);
  await until(`${watching}?.shown === ${JSON.stringify(asker)}`);
  await ev(`window.pobotsMock.browserAsk("s-kaja", { type: "confirm", message: "Leave this page? The changes you made are not saved yet." }, ${JSON.stringify(asker)})`);
  check("t6: the question of the page shown is drawn over the picture", !!(await until(`!!$(".pb-browser-ask")`, 2000)));
  await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(kajaPages[0])}))`);
  check("t6: choosing another page: the question goes with its page", !!(await until(`!$(".pb-browser-ask") && ${watching}.shown === ${JSON.stringify(kajaPages[0])}`, 2000)));
  const askMark = await ev(`(() => { const t = ${tabs}.find((x) => x.dataset.pageId === ${JSON.stringify(asker)}); return { asks: t.hasAttribute("data-asks"), mark: !!t.querySelector(".pb-browser-tab-mark .pb-mark-waiting"), label: t.getAttribute("aria-label") }; })()`);
  check("t6: and its page in the row gets a small quiet mark, also said to a screen reader", askMark?.asks && askMark.mark && askMark.label.endsWith("the page asks something"), askMark);
  await houseRules("t6: a page with a question waiting");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") {
      await openOn("s-kaja", { theme });
      await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(asker)}))`);
      await until(`${watching}?.shown === ${JSON.stringify(asker)}`);
      await ev(`window.pobotsMock.browserAsk("s-kaja", { type: "confirm", message: "Leave this page? The changes you made are not saved yet." }, ${JSON.stringify(asker)})`);
      await until(`!!$(".pb-browser-ask")`, 2000);
      await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(kajaPages[0])}))`);
      await until(`!$(".pb-browser-ask") && ${watching}.shown === ${JSON.stringify(kajaPages[0])}`, 2000);
    }
    await tShot(`tabs-question-waiting-${theme}-1280`);
    await tShot(`tabs-question-waiting-row-${theme}-1280`, tabRow);
  }
  await ev(`click(${tabs}.find((t) => t.dataset.pageId === ${JSON.stringify(asker)}))`);
  check("t6: back on its page the question is there again, and the mark is gone", !!(await until(`!!$(".pb-browser-ask") && !${tabs}.some((t) => t.hasAttribute("data-asks"))`, 2000)), await ev(`({ ask: !!$(".pb-browser-ask"), asks: ${tabs}.map((t) => t.hasAttribute("data-asks")), sel: ${tabs}.map((t) => t.dataset.pageId + ":" + t.getAttribute("aria-selected")), w: ${watching}, shows: window.pobotsMock.browserShows().slice(-4), asker: ${JSON.stringify(asker)} })`));
  await ev(`window.pobotsMock.browserAsk("s-kaja", null, ${JSON.stringify(asker)})`);
  await until(`!$(".pb-browser-ask")`, 2000);

  // ---------------- many pages: they shrink to a smallest width, then the row scrolls sideways
  const many = [];
  for (let i = 1; i <= 14; i++) many.push(await ev(`window.pobotsMock.browserOpenPage("s-kaja", "https://app.example.com/survey/${i}", "Survey number ${i} with a long title for Nordvik")`));
  await until(`${tabs}.length === 16`, 3000);
  await sleep(300);
  const crowd = await ev(`(() => { const list = $('.pb-browser-tabs [role="tablist"]'), r = list.getBoundingClientRect(), on = ${chosenTab}.getBoundingClientRect(); const ws = ${tabs}.map((t) => Math.round(t.getBoundingClientRect().width)); const tops = new Set(${tabs}.map((t) => Math.round(t.getBoundingClientRect().top))); return { min: Math.min(...ws), max: Math.max(...ws), tops: tops.size, scrolls: list.scrollWidth > list.clientWidth, inView: on.left >= r.left - 0.5 && on.right <= r.right + 0.5, rowH: ${tabRow}.getBoundingClientRect().height, ellipsis: getComputedStyle(${tabs}[0].querySelector(".pb-browser-tab-name")).textOverflow }; })()`);
  check("t7: many pages shrink to a smallest width (96 px) and never wrap", crowd && crowd.min >= 96 && crowd.tops === 1 && crowd.rowH === 36, crowd);
  check("t7: then the row scrolls sideways inside itself, the page shown in view, titles cut with an ellipsis", crowd?.scrolls && crowd.inView && crowd.ellipsis === "ellipsis", crowd);
  await houseRules("t7: many pages");
  await ev(`$('.pb-browser-tabs [role="tablist"]').scrollLeft = 0`);
  await tShot("tabs-many-dark-1280");
  await tShot("tabs-many-row-dark-1280", tabRow);
  await ev(`${tabs}[0].focus()`);
  await key("End");
  check("t7: End reaches the last page, scrolled into view", (await ev(`(() => { const list = $('.pb-browser-tabs [role="tablist"]').getBoundingClientRect(), t = document.activeElement.getBoundingClientRect(); return document.activeElement.dataset.pageId === ${JSON.stringify(many.at(-1))} && t.right <= list.right + 0.5; })()`)) === true);
  for (const id of many) await ev(`window.pobotsMock.browserClosePage("s-kaja", ${JSON.stringify(id)})`);
  await until(`${tabs}.length === 2`, 3000);

  // ---------------- one page: the row is still there, same height
  await openOn("s-other");
  check("t8: with one page the row is there too, at the same height", (await ev(`${tabs}.length === 1 && ${tabRow}.getBoundingClientRect().height === 36 && !$(".pb-browser-tab-add")`)) === true);
  await tShot("tabs-one-dark-1280");

  // ---------------- your own page: add and close
  await openOn("s-you");
  const own0 = await ev(`({ add: $(".pb-browser-tab-add")?.getAttribute("aria-label"), title: $(".pb-browser-tab-add")?.title, close: $$(".pb-browser-tab-close").length, tabs: ${tabs}.length })`);
  check("t9: in your own page a quiet add control ends the row; one page has no close control", own0?.add === "Open a new page" && own0.title === "Open a new page" && own0.close === 0 && own0.tabs === 1, own0);
  check("t9: not in control yet", (await ev(`${take}.textContent`)) === "Take control");
  await ev(`click($(".pb-browser-tab-add"))`);
  check("t9: the add control takes control by itself and opens a new page in front (browser.page.open)", !!(await until(`${take}.textContent === "Hand back" && ${tabs}.length === 2 && ${reqs("browser.page.open")} === 1`, 2000)));
  check("t9: the new page is shown, named A new page, and the focus is in the address line", !!(await until(`${chosenTab}?.textContent === "A new page" && document.activeElement === $(".pb-browser-address") && $(".pb-browser-address").value === ""`, 2000)), await ev(`({ chosen: ${chosenTab}?.textContent, focus: document.activeElement?.className, value: $(".pb-browser-address")?.value })`));
  await type("example.org");
  await key("Enter");
  check("t9: an address typed there goes to the new page", !!(await until(`${chosenTab}?.textContent === "Example Domain" && ${spaceNow("s-you")}.pages.length === 2`, 2000)));
  // The close control shows on hover and on focus, not otherwise.
  await ev(`(() => { window.__mx = 5; return true; })()`);
  await mouse("mouseMoved", 5, 5);
  const hidden = await ev(`$$(".pb-browser-tab-close").map((x) => getComputedStyle(x).opacity)`);
  const t0 = await ev(`(() => { const r = ${tabs}[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse("mouseMoved", t0.x, t0.y);
  await sleep(250);
  const hovered = await ev(`$$(".pb-browser-tab-close").map((x) => getComputedStyle(x).opacity)`);
  check("t9: each page has a close control that shows on hover", JSON.stringify(hidden) === JSON.stringify(["0", "0"]) && JSON.stringify(hovered) === JSON.stringify(["1", "0"]), { hidden, hovered });
  await houseRules("t9: your own page with add and close");
  for (const theme of ["dark", "light"]) {
    if (theme === "light") {
      await openOn("s-you", { theme });
      await ev(`window.pobotsMock.browserOpenPage("s-you", "https://example.org/", "Example Domain")`);
      await until(`${tabs}.length === 2`, 2000);
      await mouse("mouseMoved", 5, 5);
      await mouse("mouseMoved", t0.x, t0.y);
    }
    await tShot(`tabs-own-add-close-${theme}-1280`);
    await tShot(`tabs-own-add-close-row-${theme}-1280`, tabRow);
  }
  await mouse("mouseMoved", 5, 5);
  await sleep(200);
  await ev(`${chosenTab}.focus()`);
  await key("ArrowLeft");
  await key("ArrowRight");
  await sleep(250);
  check("t9: and on focus", (await ev(`getComputedStyle(document.activeElement.querySelector(".pb-browser-tab-close")).opacity`)) === "1", await ev(`({ el: document.activeElement?.className, fv: document.activeElement?.matches(":focus-visible"), close: !!document.activeElement?.querySelector(".pb-browser-tab-close"), op: document.activeElement?.querySelector(".pb-browser-tab-close") ? getComputedStyle(document.activeElement.querySelector(".pb-browser-tab-close")).opacity : null, tabs: ${tabs}.length, closes: $$(".pb-browser-tab-close").length })`));
  const ownBefore2 = await ev(`${spaceNow("s-you")}.pages.length`);
  const shownBeforeDelete = await ev(`document.activeElement.dataset.pageId`);
  await press("Delete", { vk: 46 });
  check("t9: Delete closes the page that has the focus (browser.page.close), taking control by itself", !!(await until(`${spaceNow("s-you")}.pages.length === ${ownBefore2 - 1} && !${tabs}.some((t) => t.dataset.pageId === ${JSON.stringify(shownBeforeDelete)})`, 2000)) && (await ev(`${take}.textContent`)) === "Hand back");
  check("t9: the last page has no close control, and Delete does not close it", (await ev(`$$(".pb-browser-tab-close").length`)) === 0);
  await ev(`${chosenTab}.focus()`);
  await press("Delete", { vk: 46 });
  await sleep(200);
  check("t9: (the page stays)", (await ev(`${spaceNow("s-you")}.pages.length`)) === 1);
  // Close with the pointer, without control first.
  await handBack();
  await ev(`window.pobotsMock.browserOpenPage("s-you", "https://example.net/", "Example Net")`);
  await until(`${tabs}.length === 2`, 2000);
  const second = await ev(`(() => { const r = ${tabs}[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse("mouseMoved", second.x, second.y);
  await sleep(250);
  const closeAt = await ev(`(() => { const r = ${tabs}[1].querySelector(".pb-browser-tab-close").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await clickAt(closeAt.x, closeAt.y);
  check("t9: the close control closes its page with the pointer, taking control by itself", !!(await until(`${tabs}.length === 1 && ${spaceNow("s-you")}.pages.length === 1 && ${take}.textContent === "Hand back"`, 2000)));
  // In control, Tab inside the picture goes to the page (Escape twice leaves it): the walk is made without control.
  await handBack();
  await ev(`$(".pb-browser-address").focus()`);
  await focusRings("t9: your own page with its row of pages", 10);

  // ---------------- 800 px, light and dark: one page, three pages, many pages
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      await openOn("s-kaja", { theme, width });
      const added = [await ev(`window.pobotsMock.browserOpenPage("s-kaja", "https://app.example.com/surveys/nordvik", "Nordvik survey")`)];
      await until(`${tabs}.length === 3`, 2000);
      check(`t10: ${theme} ${width}: three pages fit the row at one height`, (await ev(`${tabRow}.getBoundingClientRect().height === 36 && new Set(${tabs}.map((t) => Math.round(t.getBoundingClientRect().top))).size === 1`)) === true);
      await houseRules(`t10: ${theme} ${width}: three pages`);
      if (!(theme === "dark" && width === 1280)) await tShot(`tabs-three-${theme}-${width}`);
      for (let i = 0; i < 10; i++) added.push(await ev(`window.pobotsMock.browserOpenPage("s-kaja", "https://app.example.com/s/${i}", "Survey ${i} of the long list")`));
      await until(`${tabs}.length === 13`, 3000);
      await ev(`$('.pb-browser-tabs [role="tablist"]').scrollLeft = 0`);
      check(`t10: ${theme} ${width}: many pages scroll inside the row, the window does not`, (await ev(`(() => { const l = $('.pb-browser-tabs [role="tablist"]'); return l.scrollWidth > l.clientWidth && document.scrollingElement.scrollWidth <= innerWidth; })()`)) === true);
      if (!(theme === "dark" && width === 1280)) await tShot(`tabs-many-${theme}-${width}`);
      for (const id of added) await ev(`window.pobotsMock.browserClosePage("s-kaja", ${JSON.stringify(id)})`);
      await openOn("s-other", { theme, width });
      if (!(theme === "dark" && width === 1280)) await tShot(`tabs-one-${theme}-${width}`);
      if (width === 800) {
        await openOn("s-you", { theme, width });
        await ev(`window.pobotsMock.browserOpenPage("s-you", "https://example.net/", "Example Net")`);
        await until(`${tabs}.length === 2`, 2000);
        const r = await ev(`(() => { const x = ${tabs}[0].getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; })()`);
        await mouse("mouseMoved", r.x, r.y);
        await tShot(`tabs-own-add-close-${theme}-800`);
        await ev(`window.pobotsMock.browserClosePage("s-you", ${spaceNow("s-you")}.pages[1].id)`);
      }
    }
  }

  // ---------------- a sharper picture: drawn pixel for pixel at the size it is shown
  await openOn("s-kaja");
  const r1 = await until(`(() => { const c = $(".pb-browser-canvas"), r = c.getBoundingClientRect(); const want = Math.round(devicePixelRatio * r.width / 1280 * 100) / 100; const w = ${watching}; return w && Math.abs(w.ratio - want) <= 0.02 ? { w: r.width, want, ratio: w.ratio, sent: window.pobotsMock.browserRatios() } : null; })()`, 3000);
  check("t11: the window tells the engine how sharp: the ratio (screen pixels per page pixel as drawn), with browser.watch and browser.view", !!r1 && r1.sent.length >= 1, r1 ?? (await ev(`({ w: ${watching}, sent: window.pobotsMock.browserRatios(), cw: $(".pb-browser-canvas").getBoundingClientRect().width })`)));
  const sharp1 = await until(`(() => { const c = $(".pb-browser-canvas"), r = c.getBoundingClientRect(); return Math.abs(c.width - r.width * devicePixelRatio) <= 2 ? { cw: c.width, w: r.width } : null; })()`, 3000);
  check("t11: the canvas's own size is the picture's size, which is the drawn size in screen pixels (pixel for pixel)", !!sharp1, await ev(`({ cw: $(".pb-browser-canvas").width, w: $(".pb-browser-canvas").getBoundingClientRect().width })`));
  // A screen with a pixel ratio of 1.5: browser.view with the new ratio, and a sharp picture at that size.
  const views0 = await ev(`${reqs("browser.view")}`);
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1.5, mobile: false });
  const r15 = await until(`(() => { const c = $(".pb-browser-canvas"), r = c.getBoundingClientRect(); return devicePixelRatio === 1.5 && Math.abs(c.width - r.width * 1.5) <= 2 ? { cw: c.width, w: r.width, ratio: ${watching}.ratio } : null; })()`, 4000);
  check("t11: at a screen pixel ratio of 1.5 the window sends browser.view and the picture comes at 1.5 times the drawn size", !!r15 && (await ev(`${reqs("browser.view")}`)) > views0 && Math.abs(r15.ratio - Math.round((1.5 * r15.w) / 1280 * 100) / 100) <= 0.02, r15 ?? (await ev(`({ dpr: devicePixelRatio, cw: $(".pb-browser-canvas").width, w: $(".pb-browser-canvas").getBoundingClientRect().width, views: ${reqs("browser.view")}, views0: ${views0}, ratios: window.pobotsMock.browserRatios().slice(-4), watch: ${watching} })`)));
  await takeControl();
  const pt = await picAt(0.25, 0.5);
  const inputsAt = await ev(`${inputs}.length`);
  await clickAt(pt.x, pt.y);
  const down = await until(`${inputs}.slice(${inputsAt}).flat().find((e) => e.type === "down")`, 2000);
  check("t11: positions for input stay in the page's own pixels, whatever the picture's size", down && Math.abs(down.x - 320) <= 2 && Math.abs(down.y - 400) <= 2, { down, canvas: await ev(`$(".pb-browser-canvas").width`) });
  await handBack();
  // Dragging the divider: browser.view a few times a second at most.
  const viewsBefore = await ev(`${reqs("browser.view")}`);
  const dragT0 = Date.now();
  for (let i = 0; i < 24; i++) {
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280 - (i % 2 ? 0 : 1) * (40 + i * 6), height: 820, deviceScaleFactor: 1.5, mobile: false });
    await sleep(40);
  }
  const dragMs = Date.now() - dragT0;
  await sleep(400);
  const viewsDuring = (await ev(`${reqs("browser.view")}`)) - viewsBefore;
  check("t11: while the size changes, browser.view goes at most a few times a second", viewsDuring >= 1 && viewsDuring <= Math.ceil(dragMs / 250) + 1, { viewsDuring, dragMs });
  // Before and after: the same page, the same panel width, at a pixel ratio of 1.5. The panel fills
  // the main area, as wide as on the person's laptop, where the page is drawn a little larger than
  // its own size.
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1.5, mobile: false });
  await ev(`click(${bTool("Fill the main area")})`);
  await until(`${mode} === "full"`);
  await sleep(800);
  const smallText = await ev(`(() => { const r = $(".pb-browser-canvas").getBoundingClientRect(); return { x: r.left + 690 / 1280 * r.width, y: r.top + 116 / 800 * r.height, width: 330 / 1280 * r.width, height: 84 / 800 * r.height }; })()`);
  async function closeUp(name) {
    if (!tabsShots) return;
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", clip: { ...smallText, scale: 3 } });
    writeFileSync(join(tabsShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  await ev(`window.pobotsMock.browserBefore(true)`);
  await ev(`window.pobotsMock.browserNavigate("s-kaja", "https://app.example.com/surveys", "Surveys")`);
  await until(`$(".pb-browser-canvas").width === 1280`, 3000);
  await sleep(300);
  await closeUp("text-before-ratio-1.5");
  await ev(`window.pobotsMock.browserBefore(false)`);
  await ev(`window.pobotsMock.browserNavigate("s-kaja", "https://app.example.com/surveys", "Surveys")`);
  const after = await until(`(() => { const c = $(".pb-browser-canvas"), r = c.getBoundingClientRect(); return Math.abs(c.width - r.width * 1.5) <= 2 ? { cw: c.width, w: r.width } : null; })()`, 3000);
  await closeUp("text-after-ratio-1.5");
  check("t11: before: a JPEG of the page's own size (1280 wide) stretched by the screen; after: a sharp picture of the drawn size at 1.5", !!after && after.cw > 1280, after);
  await ev(`click(${bTool("Show the chat beside it")})`);
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  if (tabsShots) console.log(`Round three pictures in ${tabsShots}`);
  }
  }

  }
}
