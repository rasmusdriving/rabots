// The window check, section "2f". Run it alone: node scripts/ui-check.mjs --only=2f
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 2f: artifacts
// Its own block, so its names do not meet the earlier steps' names.
export default async function section() {
  part2f: {
  // The mock's "artifacts" scene: Kaja's chat holds a page with a chart (made, then updated), a page
  // made and published in one turn, a document that lives only on Claude, and a page whose file is
  // gone; two cards wait in the rail. `window.open` is stubbed in every check: nothing is opened, and
  // claude.ai is never reached.
  const AS = "scene=artifacts";
  const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals";
  const aRows = `$$(".app-main .pb-thread .pb-artifact")`;
  const aRow = (id) => `${aRows}.filter((r) => r.dataset.artifactId === ${JSON.stringify(id)}).pop()`;
  const aLine = (sel) => `(${sel})?.querySelector(".pb-artifact-line")?.textContent`;
  const pane = `$(".app-artifact")`;
  const mode = `$(".app-shell").dataset.artifact`;
  const tool = (label) => `$$(".pb-artifact-tools .pb-tool").find((t) => t.getAttribute("aria-label").startsWith(${JSON.stringify(label)}))`;
  const frames = `$$(".app-artifact iframe")`;
  const shownFrame = `$$(".app-artifact iframe").find((f) => f.dataset.state === "shown")`;
  const artifactShots = arg("artifact-shots") ?? (shots ? join(shots, "artifacts") : undefined);
  if (artifactShots) mkdirSync(artifactShots, { recursive: true });
  async function aShot(name, selector) {
    if (!artifactShots) return;
    await sleep(500);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(artifactShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  /** Stubs window.open: every call is kept, and nothing opens. With `block`, it acts as a browser that blocks the window. */
  const stubWindows = (block = false) =>
    ev(`(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return ${block} ? null : { opener: {}, focus() {} }; }; return true; })()`);
  /** The line at the top of the chat's view, kept by reference, and where its top is. */
  const markTop = `(() => { const t = lineTop(); window.__topLine = t?.el; return t ? { text: t.el.textContent.slice(0, 40), top: Math.round(t.top * 10) / 10 } : null; })()`;
  const sameTop = `(() => { const t = lineTop(); return t ? { same: t.el === window.__topLine, text: t.el.textContent.slice(0, 40), top: Math.round(t.top * 10) / 10 } : null; })()`;
  /** Scrolls the chat to put this element at the top of the view, as a person scrolls. */
  const readAt = (sel, offset = 40) => `(() => { const s = $(".app-main .pb-main-scroll"), el = ${sel}; s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - ${offset}; s.dispatchEvent(new Event("scroll")); return true; })()`;
  const keptTop = (before, after) => !!before && !!after && after.same && Math.abs(after.top - before.top) <= 1;
  /** Where an artifact's row stands in the view. The row the person opens is what stays in place (tester, step 2f). */
  const rowTop = (id) => `(() => { const r = ${aRow(id)}?.getBoundingClientRect(); return r ? Math.round(r.top * 10) / 10 : null; })()`;
  const keptRow = (before, after) => before !== null && after !== null && Math.abs(after - before) <= 1;
  const paneWidth = `Math.round(${pane}.getBoundingClientRect().width)`;
  /** Holds every frame's load event until released, so a page that is loading can be watched. A frame's load event stops at the document, never at the window. */
  const holdLoads = `(() => {
    window.__held = [];
    window.__holdLoad = (e) => { if (e.target instanceof HTMLIFrameElement && window.__holding) { e.stopImmediatePropagation(); window.__held.push(e.target); } };
    window.__holding = true;
    document.addEventListener("load", window.__holdLoad, true);
    return true;
  })()`;
  const releaseLoads = `(() => { window.__holding = false; for (const f of window.__held) f.dispatchEvent(new Event("load")); window.__held = []; return true; })()`;
  /** Watches the frames: on every change, how many are shown. The panel must never be without one. */
  const watchFrames = `(() => {
    window.__fw = [];
    const body = $(".pb-artifact-body");
    const m = () => window.__fw.push($$(".pb-artifact-body iframe").filter((f) => f.dataset.state === "shown").length);
    m();
    window.__fwObs?.disconnect();
    window.__fwObs = new MutationObserver(m);
    window.__fwObs.observe(body, { subtree: true, childList: true, attributes: true });
    return true;
  })()`;

  // ---------------- B1: the rows in the chat
  await open(AS);
  await stubWindows();
  await goTo("Kaja", "chat");
  check("Kaja's chat shows five artifact rows", !!(await until(`${aRows}.length === 5`)), await ev(`${aRows}.length`));
  const lines = await ev(`${aRows}.map((r) => r.dataset.artifactId + ": " + r.querySelector(".pb-artifact-line").textContent)`);
  check("a page whose file is gone says so", (await ev(aLine(aRow("pricing-mockup")))) === "The file is gone", lines);
  check("a page made says Made and the time", /^Made \d\d:\d\d$/.test((await ev(`${aRows}.find((r) => r.dataset.artifactId === "onboarding-status")?.querySelector(".pb-artifact-line").textContent`)) ?? ""), lines);
  check("a page published says Published to Claude and the time", /^Published to Claude \d\d:\d\d$/.test((await ev(aLine(aRow("customer-report")))) ?? ""), lines);
  check("a link says where it lives: On Claude, opens in its own window", /^Made \d\d:\d\d · On Claude, opens in its own window$/.test((await ev(aLine(aRow("kickoff-agenda")))) ?? ""), lines);
  check("a page changed says Updated and the time", /^Updated \d\d:\d\d$/.test((await ev(aLine(aRow("onboarding-status")))) ?? ""), lines);
  check(
    "two lines for one artifact in one turn show as one row, the newest",
    (await ev(`${aRows}.filter((r) => r.dataset.artifactId === "customer-report").map((r) => r.dataset.what).join()`)) === "published" &&
      (await ev(`window.pobotsState().threads["kaja-main"].items.filter((i) => i.kind === "artifact" && i.artifact.id === "customer-report").length`)) === 2,
  );
  const aHeights = await ev(`${aRows}.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10)`);
  check("every artifact row has the same fixed height, in every state", Array.isArray(aHeights) && aHeights.every((h) => h === aHeights[0]) && aHeights[0] >= 44 && aHeights[0] <= 60, aHeights);
  check(
    "the finished turns are folded and the rows stay in sight with the answer, not in the work",
    (await ev(`${aRows}.every((r) => !!r.closest(".pb-answer[data-folded]") && !r.closest(".pb-work") && !!r.closest(".pb-answer-flow"))`)) === true,
  );
  check(
    "in each answer the row stands in its order, before the text that followed it",
    (await ev(`${aRows}.every((r) => { const flow = r.closest(".pb-answer-flow"); const kids = [...flow.children]; const text = kids.filter((k) => k.classList.contains("pb-msg-body")).pop(); return !!text && kids.indexOf(r) < kids.indexOf(text); })`)) === true,
  );
  const aLook = await ev(`(() => {
    const r = ${aRow("onboarding-status")}, s = getComputedStyle(r), mark = r.querySelector(".pb-artifact-mark");
    return { face: !!r.querySelector(".pb-avatar"), drawn: !!mark.querySelector("svg"), disc: parseFloat(getComputedStyle(mark).borderTopLeftRadius) >= 14 && getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)",
      raised: s.boxShadow !== "none", cardWide: r.getBoundingClientRect().width <= 480, go: !!r.querySelector(".pb-artifact-go svg"),
      title: getComputedStyle(r.querySelector(".pb-artifact-title")).fontWeight };
  })()`);
  check("the row has a drawn page on a soft disc, never a face, and a mark for where it opens", aLook && !aLook.face && aLook.drawn && aLook.disc && aLook.go, aLook);
  check("the row is raised and card wide, told apart from a helper's flat full-width row at a glance", aLook?.raised && aLook.cardWide && aLook.title === "600", aLook);
  await ev(`window.pobotsMock.artifactFile("kaja", "onboarding-status", false)`);
  check("the row shows the newest state the app knows: a file deleted later reads The file is gone in both rows", !!(await until(`${aRows}.filter((r) => r.dataset.artifactId === "onboarding-status").every((r) => r.dataset.state === "gone" && r.querySelector(".pb-artifact-line").textContent === "The file is gone")`)));
  check("and keeps its height", JSON.stringify(await ev(`${aRows}.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10)`)) === JSON.stringify(aHeights));
  await ev(`window.pobotsMock.artifactFile("kaja", "onboarding-status", true)`);
  check("when the file comes back, the rows can be opened again", !!(await until(`${aRows}.filter((r) => r.dataset.artifactId === "onboarding-status").every((r) => r.dataset.state === "ready")`)));
  await ev(`click(${aRow("pricing-mockup")})`);
  await sleep(300);
  check("a row whose file is gone cannot be opened", (await ev(`!${pane} && ${aRow("pricing-mockup")}.getAttribute("aria-disabled") === "true"`)) === true);
  await houseRules("chat with artifact rows");
  await ev(readAt(aRow("customer-report")));
  await aShot("row-published-dark-1280", aRow("customer-report"));
  await aShot("row-link-dark-1280", aRow("kickoff-agenda"));
  await aShot("row-gone-dark-1280", aRow("pricing-mockup"));
  await ev(readAt(`${aRows}.find((r) => r.dataset.artifactId === "onboarding-status")`));
  await aShot("row-made-dark-1280", `${aRows}.find((r) => r.dataset.artifactId === "onboarding-status")`);
  await aShot("row-updated-dark-1280", aRow("onboarding-status"));

  // ---------------- B3: a link opens in a window of its own beside Pobots
  await ev(`click(${aRow("kickoff-agenda")})`);
  const opened = await ev(`window.__opened`);
  check(
    "a link row opens its page in a named window of its own, at the right edge, and no panel",
    Array.isArray(opened) && opened.length === 1 && opened[0][0] === "https://claude.ai/artifact/mock-kickoff-agenda" && opened[0][1] === "pobots-claude" && /popup/.test(opened[0][2]) && /left=\d+/.test(opened[0][2]) && !(await ev(`!!${pane}`)),
    opened,
  );
  await stubWindows(true);
  await ev(`click(${aRow("kickoff-agenda")})`);
  check("when the browser blocks the window, the link is offered as a plain link", !!(await until(`text(".pb-dialog-title") === "Open on Claude" && $(".pb-dialog a[href='https://claude.ai/artifact/mock-kickoff-agenda']")?.target === "_blank" && $(".pb-dialog a").rel.includes("noopener")`)));
  await houseRules("blocked window");
  await key("Escape");
  check("Escape closes it", !!(await until(`!$(".pb-dialog")`)));
  await stubWindows();

  // ---------------- B2: the panel
  await ev(`window.pobotsMock.holdSteps(false)`);
  await ev(readAt(aRow("customer-report"), 60));
  await sleep(200);
  const beforeOpen = await ev(rowTop("onboarding-status"));
  await ev(`click(${aRow("onboarding-status")})`);
  check("a page row opens the panel beside the chat, in the place of the rail", !!(await until(`${mode} === "side" && !!${shownFrame}`)));
  await sleep(150);
  const afterOpen = await ev(rowTop("onboarding-status"));
  check("opening keeps the row the person opened where it is, though the chat is narrower now", keptRow(beforeOpen, afterOpen), { beforeOpen, afterOpen });
  const sealed = await ev(`(() => { const f = ${shownFrame}; let reach = "none"; try { reach = f.contentDocument ? "document" : "none"; f.contentWindow.document; reach = "window"; } catch { /* sealed */ } return { sandbox: f.getAttribute("sandbox"), referrer: f.getAttribute("referrerpolicy"), title: f.title, reach }; })()`);
  check("the frame's sandbox is exactly the brief's, without allow-same-origin or allow-top-navigation", sealed?.sandbox === SANDBOX && !/same-origin|top-navigation/.test(sealed.sandbox), sealed);
  check("the frame sends no referrer and has a title for screen readers", sealed?.referrer === "no-referrer" && sealed.title === "Onboarding status", sealed);
  check("the window cannot reach into the frame: its document has an origin of its own", sealed?.reach === "none", sealed);
  check("the frame stands on a plain light ground", (await ev(`(() => { const p = document.createElement("span"); p.style.color = "var(--frame-ground)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return getComputedStyle(${shownFrame}).backgroundColor === c; })()`)) === true);
  const railGone = await ev(`(() => { const r = $(".app-rail"); return { hidden: !r.checkVisibility({ visibilityProperty: true }), inert: r.inert }; })()`);
  check("the rail is not shown and cannot be reached while the panel is open", railGone?.hidden && railGone.inert, railGone);
  const top = await ev(`({ title: text(".pb-artifact-bar-title"), when: text(".pb-artifact-when"), needs: $(".pb-artifact-needs")?.innerText.replace(/\\s+/g, " ").trim(), tools: $$(".pb-artifact-tools .pb-tool").map((t) => t.getAttribute("aria-label") + "=" + t.getAttribute("title")) })`);
  check("the top line: the title and a muted Updated with the time", top?.title === "Onboarding status" && /^Updated \d\d:\d\d$/.test(top.when), top);
  check("the top line says Needs you 2, quietly", top?.needs === "Needs you 2", top);
  check(
    "small controls with their words on hover and for screen readers: Load again, Open in a new tab, Publish to Claude, Narrower, Wider, Fill the main area, Close",
    JSON.stringify(top?.tools) === JSON.stringify(["Load again", "Open in a new tab", "Publish to Claude", "Narrower", "Wider", "Fill the main area", "Close"].map((l) => `${l}=${l}`)),
    top?.tools,
  );
  check("Open in a new tab is the same sealed address, in a new tab without an opener", (await ev(`(() => { const a = ${tool("Open in a new tab")}; return a.tagName === "A" && a.getAttribute("href") === ${shownFrame}.getAttribute("src") && a.target === "_blank" && a.rel.includes("noopener"); })()`)) === true);
  check("the row of the open artifact is marked as open", (await ev(`${aRow("onboarding-status")}.hasAttribute("data-open") && ${aRow("onboarding-status")}.getAttribute("aria-label").endsWith("Open beside the chat.")`)) === true);
  const w1280 = await ev(`({ pane: ${paneWidth}, main: Math.round($(".app-main").getBoundingClientRect().width) })`);
  check("by default the panel takes about half of the space beside the roster", Math.abs(w1280.pane - Math.round((1280 - 264) / 2)) <= 2, w1280);
  await houseRules("the open panel");
  await aShot("panel-beside-chat-dark-1280");
  await aShot("top-line-needs-you-2-dark-1280", `$(".pb-artifact-bar")`);

  // Swapping, while the top line stays.
  await ev(`click(${aRow("customer-report")})`);
  check("opening another artifact swaps the panel's content", !!(await until(`text(".pb-artifact-bar-title") === "Customer report" && ${frames}.every((f) => f.title === "Customer report") && !!${shownFrame}`)));
  check("a page with a link offers Open on Claude, not Publish", !!(await ev(`!!${tool("Open on Claude")} && !${tool("Publish to Claude")}`)));
  await ev(`click(${tool("Open on Claude")})`);
  check("Open on Claude opens the link in the window beside Pobots", (await ev(`window.__opened.at(-1)?.slice(0, 2).join(" ")`)) === "https://claude.ai/artifact/mock-customer-report pobots-claude");
  await ev(`click(${aRow("onboarding-status")})`);
  await until(`text(".pb-artifact-bar-title") === "Onboarding status" && !!${shownFrame}`);

  // The width: keyboard, buttons, the pointer, remembered.
  const chatTop0 = await ev(markTop);
  await ev(`$(".pb-artifact-divider").focus()`);
  await key("ArrowLeft");
  await sleep(120);
  const wider = await ev(paneWidth);
  check("the divider moves with the keyboard: Left makes the panel wider", wider > w1280.pane + 20, { before: w1280.pane, after: wider });
  check("and the chat keeps the line at its top", keptTop(chatTop0, await ev(sameTop)), await ev(sameTop));
  await key("ArrowRight");
  await sleep(120);
  check("Right makes it narrower again", Math.abs((await ev(paneWidth)) - w1280.pane) <= 2, await ev(paneWidth));
  await key("Home");
  await sleep(120);
  check("at its widest the chat keeps a readable width", Math.round(await ev(`$(".app-main").getBoundingClientRect().width`)) >= 400 && !!(await ev(`${tool("Wider")}.disabled`)), await ev(`$(".app-main").getBoundingClientRect().width`));
  await key("End");
  await sleep(120);
  check("at its narrowest the panel keeps a readable width", (await ev(paneWidth)) >= 380 && !!(await ev(`${tool("Narrower")}.disabled`)), await ev(paneWidth));
  const focusDivider = await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.classList.contains("pb-artifact-divider") && document.activeElement.getAttribute("role") === "separator" && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
  check("the divider is a separator with a focus ring", focusDivider === true);
  await ev(`click(${tool("Wider")})`);
  await sleep(120);
  check("Wider makes it wider", (await ev(paneWidth)) > 390);
  const dv = await ev(`(() => { const r = $(".pb-artifact-divider").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const wDrag = await ev(paneWidth);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: dv.x, y: dv.y });
  await b.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: dv.x, y: dv.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 5; i++) await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: dv.x - i * 20, y: dv.y, button: "left", buttons: 1 });
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: dv.x - 100, y: dv.y, button: "left", clickCount: 1 });
  await sleep(150);
  const wDragged = await ev(paneWidth);
  check("dragging the divider makes the panel wider by as much as it was dragged", Math.abs(wDragged - wDrag - 100) <= 4, { before: wDrag, after: wDragged });
  check("the width is remembered on this device", Number(await ev(`localStorage.getItem("pobots.artifactShare")`)) > 0.5);

  // Filling the main area, and back.
  const beforeFill = await ev(markTop);
  await ev(`click(${tool("Fill the main area")})`);
  const full = await ev(`(() => { const p = ${pane}.getBoundingClientRect(), m = $(".app-main").getBoundingClientRect(); return { mode: $(".app-shell").dataset.artifact, left: Math.round(p.left - m.left), chatHidden: !$(".app-main").checkVisibility({ visibilityProperty: true }), inert: $(".app-main").inert, label: ${tool("Show the chat beside it")}?.getAttribute("aria-label") }; })()`);
  check("Fill makes the panel fill the main area, with the chat hidden behind it", full?.mode === "full" && Math.abs(full.left) <= 1 && full.chatHidden && full.inert && full.label === "Show the chat beside it", full);
  await houseRules("the panel filling the main area");
  await aShot("panel-full-dark-1280");
  await ev(`click(${tool("Show the chat beside it")})`);
  await until(`${mode} === "side"`);
  check("and back beside the chat, with the chat as it was", keptTop(beforeFill, await ev(sameTop)), await ev(sameTop));

  // Escape, and the focus going back.
  await ev(`${tool("Load again")}.focus()`);
  const beforeClose = await ev(rowTop("onboarding-status"));
  await key("Escape");
  check("Escape in the panel closes it and the rail shows again", !!(await until(`!${pane} && $(".app-rail").checkVisibility({ visibilityProperty: true }) && !$(".app-rail").inert`)));
  check("the focus goes back to the row", (await ev(`document.activeElement?.classList.contains("pb-artifact") && document.activeElement.dataset.artifactId === "onboarding-status"`)) === true);
  await sleep(150);
  check("closing keeps the open artifact's row where it is", keptRow(beforeClose, await ev(rowTop("onboarding-status"))), { beforeClose, after: await ev(rowTop("onboarding-status")) });
  await key("Enter");
  check("Enter on the row opens it again", !!(await until(`${mode} === "side" && !!${shownFrame}`)));
  await key("Escape");
  check("Escape on its row closes it, and the focus stays on the row", !!(await until(`!${pane} && document.activeElement?.dataset.artifactId === "onboarding-status"`)));
  const aStops = `$$(".app-main :is(.app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-helper, .pb-worked, .pb-artifact)")`;
  check("an artifact row is one of the chat's line buttons: one Tab stop for them all", (await ev(`${aStops}.filter((x) => x.tabIndex === 0).length === 1`)) === true);
  await key("ArrowUp");
  check("Up arrow moves from the row to the line above", (await ev(`document.activeElement?.classList.contains("pb-worked")`)) === true);
  await key("ArrowDown");

  // Opening and closing at the bottom of the chat, too.
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(150);
  const atBottom = await ev(rowTop("onboarding-status"));
  await ev(`click(${aRow("onboarding-status")})`);
  await until(`!!${shownFrame}`);
  await sleep(150);
  check("at the foot of the chat, opening keeps the opened row where it is, too", keptRow(atBottom, await ev(rowTop("onboarding-status"))), { atBottom, after: await ev(rowTop("onboarding-status")) });
  await ev(`click(${tool("Close")})`);
  await until(`!${pane}`);
  await sleep(150);
  check("and closing too", keptRow(atBottom, await ev(rowTop("onboarding-status"))), { atBottom, after: await ev(rowTop("onboarding-status")) });

  // Loading, failing, loading again.
  await ev(`window.pobotsMock.artifactOpenDelay(900)`);
  await ev(`click(${aRow("customer-report")})`);
  check("while the page is on its way, a quiet line says Loading the artifact", !!(await until(`text(".pb-artifact-status") === "Loading the artifact" && getComputedStyle($(".pb-artifact-status")).opacity === "1"`, 3000)));
  check("then the page shows and the line goes", !!(await until(`!!${shownFrame} && !$(".pb-artifact-status")`, 4000)));
  await ev(`window.pobotsMock.artifactOpenDelay(0)`);
  await ev(`window.pobotsMock.artifactOpenFails(true)`);
  const opensBefore = (await ev(`window.pobotsMock.requests()["artifact.open"]`)) ?? 0;
  await ev(`click(${aRow("onboarding-status")})`);
  check("when the page cannot be had, it says This artifact could not be loaded, with Load again", !!(await until(`$(".pb-artifact-status[role=alert] p")?.textContent === "This artifact could not be loaded" && !!btn("Load again", $(".pb-artifact-status"))`)));
  check("after asking the engine once more first", (await ev(`window.pobotsMock.requests()["artifact.open"]`)) - opensBefore === 2);
  await houseRules("an artifact that could not be loaded");
  await ev(`window.pobotsMock.artifactOpenFails(false)`);
  await ev(`click(btn("Load again", $(".pb-artifact-status")))`);
  check("Load again loads it", !!(await until(`!!${shownFrame} && !$(".pb-artifact-status")`)));

  // The page changes while it is open: the old frame stays until the new one has loaded.
  const itemsBefore = await ev(`window.pobotsState().threads["kaja-main"].items.length`);
  const oldFrame = await ev(`(() => { window.__oldFrame = ${shownFrame}; return window.__oldFrame.dataset.rev; })()`);
  await ev(holdLoads);
  await ev(watchFrames);
  const newRev = await ev(`window.pobotsMock.changeArtifact("kaja", "onboarding-status")`);
  check("a higher rev loads the page again by itself, in a new frame out of sight", !!(await until(`${frames}.some((f) => f.dataset.state === "loading" && f.dataset.rev === "${newRev}")`)), { oldFrame, newRev });
  check("meanwhile the old frame stays in place, shown", (await ev(`window.__oldFrame.isConnected && window.__oldFrame.dataset.state === "shown" && window.__oldFrame.checkVisibility({ visibilityProperty: true })`)) === true);
  check("and the loading frame is hidden", (await ev(`!${frames}.find((f) => f.dataset.state === "loading").checkVisibility({ visibilityProperty: true })`)) === true);
  await ev(releaseLoads);
  check("once loaded, the new frame takes the old one's place", !!(await until(`${frames}.length === 1 && ${shownFrame}?.dataset.rev === "${newRev}" && !window.__oldFrame.isConnected`)));
  const fw = await ev(`(() => { window.__fwObs.disconnect(); return window.__fw; })()`);
  check("the panel was never without a shown frame, on every change", Array.isArray(fw) && fw.length > 1 && fw.every((n) => n >= 1), fw);
  check("the top line says Updated, quietly", /^Updated \d\d:\d\d$/.test((await ev(`text(".pb-artifact-when")`)) ?? ""));
  check("and no new line came into the chat", (await ev(`window.pobotsState().threads["kaja-main"].items.length`)) === itemsBefore);
  await ev(`(() => { document.removeEventListener("load", window.__holdLoad, true); return true; })()`);
  await ev(`click(${tool("Load again")})`);
  await sleep(400);
  check("Load again also swaps without an empty moment", (await ev(`${frames}.length === 1 && !!${shownFrame}`)) === true);

  // A new card while the panel is open, and Needs you.
  await ev(`window.pobotsMock.addCard()`);
  check("a new card is noticed in the top line, and the panel stays open", !!(await until(`$(".pb-artifact-needs")?.innerText.replace(/\\s+/g, " ").trim() === "Needs you 3" && ${mode} === "side"`)));
  await ev(`click($(".pb-artifact-needs"))`);
  check("Needs you closes the panel and shows the rail with the cards", !!(await until(`!${pane} && $(".app-rail").checkVisibility({ visibilityProperty: true }) && $$(".app-rail .pb-card").length === 3`)));

  // Across the bot's tabs, a helper's thread, a reload; closed by another bot.
  await ev(`click(${aRow("onboarding-status")})`);
  await until(`!!${shownFrame}`);
  await ev(`click($('.pb-tab[data-tab="files"]'))`);
  check("the panel stays open across the bot's tabs", !!(await until(`tabOpen() === "files" && ${mode} === "side"`)));
  await ev(`click($('.pb-tab[data-tab="chat"]'))`);
  await until(`tabOpen() === "chat"`);
  await ev(`$(".pb-composer textarea").focus()`);
  await type("Start a helper to read the notes, please.");
  await key("Enter");
  await until(`!!$(".app-main .pb-helper")`, 5000);
  await ev(`click($$(".app-main .pb-helper").pop())`);
  check("the panel stays open when a helper's thread is opened", !!(await until(`!!$(".pb-helper-bar") && ${mode} === "side" && !!${shownFrame}`)));
  await ev(`click($(".pb-helper-back"))`);
  await until(`!$(".pb-helper-bar")`);
  await until(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").dataset.state !== "working"`, 15000);
  await b.cmd("Page.reload", {});
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  check("a reload of the page keeps the panel open on the same artifact", !!(await until(`${mode} === "side" && text(".pb-artifact-bar-title") === "Onboarding status" && !!${shownFrame}`, 6000)));
  await stubWindows();
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Inbox"))`);
  check("choosing another bot closes the panel", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Inbox" && !${pane} && !$(".app-shell").dataset.artifact`)));
  await goTo("Kaja", "chat");
  check("and coming back, it stays closed", (await ev(`!${pane}`)) === true);

  // ---------------- B4: publishing from the panel
  await until(`${aRows}.length >= 5`);
  await ev(`click(${aRow("onboarding-status")})`);
  await until(`!!${shownFrame}`);
  const sendsBefore = (await ev(`window.pobotsMock.requests()["message.send"]`)) ?? 0;
  await ev(`click(${tool("Publish to Claude")})`);
  const ask = await ev(`({ title: text(".pb-dialog-title"), text: text(".pb-dialog-text"), buttons: $$(".pb-dialog-actions button").map((x) => x.textContent), first: document.activeElement?.textContent })`);
  check(
    "Publish to Claude asks first, in the brief's words, Cancel first",
    ask?.title === "Publish this to Claude?" && ask.text === "Kaja puts this artifact on Claude and gives you a link to share. It stays private there until you share it." && ask.buttons.join("|") === "Cancel|Publish" && ask.first === "Cancel",
    ask,
  );
  await houseRules("publish question");
  await aShot("publish-question-dark-1280");
  await key("Escape");
  check("Escape cancels: nothing is sent and the panel stays open", !!(await until(`!$(".pb-dialog") && !!${pane}`)) && ((await ev(`window.pobotsMock.requests()["message.send"]`)) ?? 0) === sendsBefore);
  await ev(`click(${tool("Publish to Claude")})`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click(btn("Publish"))`);
  check("Publish sends the bot one ordinary message from the person", !!(await until(`$$(".app-main .pb-msg-you").at(-1)?.textContent === 'Publish the artifact "Onboarding status" to Claude and give me the link.'`)) && (await ev(`window.pobotsMock.requests()["message.send"]`)) === sendsBefore + 1);
  check(
    "while the bot is in its turn the control is off, with the reason",
    !!(await until(`(() => { const t = ${tool("Publish to Claude")}; return !!t && t.getAttribute("aria-disabled") === "true" && t.title === "Publish to Claude. Kaja is working. Try again when it is done."; })()`)),
  );
  await ev(`click(${tool("Publish to Claude")})`);
  check("and pressing it then asks nothing", (await ev(`!$(".pb-dialog")`)) === true);
  check("when the bot has published, the control becomes Open on Claude", !!(await until(`!!${tool("Open on Claude")} && !${tool("Publish to Claude")}`, 6000)));
  check("and its row in the chat reads Published to Claude", !!(await until(`/^Published to Claude \\d\\d:\\d\\d$/.test(${aLine(aRow("onboarding-status"))})`)));
  await ev(`click(${tool("Close")})`);
  await until(`!${pane} && document.activeElement?.classList.contains("pb-artifact")`);
  await until(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").dataset.state === "done"`, 6000);

  // ---------------- B1 live: a row in a turn that is still running
  await ev(`window.pobotsMock.holdSteps(true)`);
  await ev(`$(".pb-composer textarea").focus()`);
  await type("Make an artifact for the status check.");
  await key("Enter");
  for (let i = 0; i < 40 && (await ev(`window.pobotsMock.stepPhase()`)) !== "after the artifact"; i++) {
    await ev(`window.pobotsMock.stepOn()`);
    await sleep(250);
  }
  check("in a running turn, the row arrives where the bot showed it", !!(await until(`window.pobotsMock.stepPhase() === "after the artifact" && !!${aRows}.find((r) => r.querySelector(".pb-artifact-title").textContent === "Status check")`, 6000)));
  const live = await ev(`(() => { const r = ${aRows}.find((x) => x.querySelector(".pb-artifact-title").textContent === "Status check"); return { current: !!r.closest(".pb-answer[data-current]"), line: r.querySelector(".pb-artifact-line").textContent, height: Math.round(r.getBoundingClientRect().height * 10) / 10 }; })()`);
  check("it stands in the answer the bot is still in, Made and the time, at the same height", live?.current && /^Made \d\d:\d\d$/.test(live.line) && live.height === aHeights[0], live);
  await aShot("row-running-turn-dark-1280", `$$(".app-main .pb-answer").pop()`);
  await ev(`window.pobotsMock.holdSteps(false)`);
  check("when the turn ends and its work folds, the row stays in sight with the answer", !!(await until(`(() => { const r = ${aRows}.find((x) => x.querySelector(".pb-artifact-title").textContent === "Status check"); return !!r && !!r.closest(".pb-answer[data-folded]") && !r.closest(".pb-work"); })()`, 6000)));
  await ev(`click(${aRows}.find((x) => x.querySelector(".pb-artifact-title").textContent === "Status check"))`);
  check("and it opens beside the chat", !!(await until(`text(".pb-artifact-bar-title") === "Status check" && !!${shownFrame}`)));
  await ev(`click(${tool("Close")})`);

  // ---------------- B5: the Artifacts tab
  await goTo("Kaja", "artifacts");
  check("the bot's page has an Artifacts tab, after Files", (await ev(`$$(".pb-tab").map((t) => t.textContent).join("|")`)) === "Chat|Job|Files|Artifacts|Triggers|History|Settings");
  check("it lists the bot's artifacts, newest change first", !!(await until(`$$(".pb-artifact-item .pb-artifact-title").map((t) => t.textContent).join("|") === window.pobotsMock.artifacts("kaja").map((a) => a.title).join("|")`)), await ev(`$$(".pb-artifact-item .pb-artifact-title").map((t) => t.textContent)`));
  const where = await ev(`Object.fromEntries($$(".pb-artifact-item").map((i) => [i.dataset.artifactId, i.querySelector(".pb-artifact-line").textContent]))`);
  check("each says where it lives and when it changed: In Pobots, On Claude, or both", /^In Pobots · On Claude · Updated /.test(where?.["onboarding-status"] ?? "") && /^In Pobots · On Claude · Updated /.test(where?.["customer-report"] ?? "") && /^On Claude · Made /.test(where?.["kickoff-agenda"] ?? "") && /^In Pobots · Made /.test(Object.entries(where ?? {}).find(([k]) => k.startsWith("status-check-"))?.[1] ?? ""), where);
  check("a page whose file is gone says so", where?.["pricing-mockup"] === "In Pobots · The file is gone", where);
  await houseRules("the Artifacts tab");
  await aShot("artifacts-tab-dark-1280");
  await ev(`click($('.pb-artifact-item[data-artifact-id="customer-report"] .pb-artifact-open'))`);
  check("a page opens beside the page, and the tab stays", !!(await until(`${mode} === "side" && text(".pb-artifact-bar-title") === "Customer report" && tabOpen() === "artifacts"`)));
  check("the open one is marked in the list", (await ev(`$('.pb-artifact-item[data-artifact-id="customer-report"]').hasAttribute("data-open")`)) === true);
  await ev(`click(${tool("Close")})`);
  await until(`!${pane}`);
  await ev(`click($('.pb-artifact-item[data-artifact-id="kickoff-agenda"] .pb-artifact-open'))`);
  check("a link opens in its window", (await ev(`window.__opened.at(-1)?.[0]`)) === "https://claude.ai/artifact/mock-kickoff-agenda");
  await ev(`window.pobotsMock.artifactFile("kaja", "customer-report", false)`);
  check("the list is kept up to date by artifact.changed", !!(await until(`$('.pb-artifact-item[data-artifact-id="customer-report"] .pb-artifact-line')?.textContent === "In Pobots · On Claude · The file is gone"`)));
  await ev(`window.pobotsMock.artifactFile("kaja", "customer-report", true)`);
  await ev(`click(btn("Show in chat", $('.pb-artifact-item[data-artifact-id="kickoff-agenda"]')))`);
  const showFacts = `(() => { const row = ${aRow("kickoff-agenda")}, s = $(".app-main .pb-main-scroll"); if (!row || !s) return { tab: tabOpen(), row: !!row }; const r = row.getBoundingClientRect(), v = s.getBoundingClientRect(); return { tab: tabOpen(), focused: document.activeElement === row, active: document.activeElement?.className, inView: r.top >= v.top && r.bottom <= v.bottom, top: Math.round(r.top - v.top), height: Math.round(v.height) }; })()`;
  check(
    "Show in chat goes to the chat, to the artifact's newest row, in view and focused",
    !!(await until(`(() => { const f = ${showFacts}; return f.tab === "chat" && f.focused && f.inView; })()`, 6000)),
    await ev(showFacts),
  );
  await goTo("Kaja", "artifacts");
  await until(`!!$(".pb-artifact-item")`);
  await ev(`click(btn("Remove from the list", $('.pb-artifact-item[data-artifact-id="pricing-mockup"]')))`);
  const rm = await ev(`({ title: text(".pb-dialog-title"), text: text(".pb-dialog-text"), buttons: $$(".pb-dialog-actions button").map((x) => x.textContent) })`);
  check(
    "Remove from the list asks first, and says the file and anything on Claude stay",
    rm?.title === "Remove this artifact from the list?" && rm.text.includes("The file stays in Kaja's folder") && rm.text.includes("anything on Claude stays on Claude") && rm.buttons.join("|") === "Keep it|Remove from the list",
    rm,
  );
  await houseRules("remove question");
  await ev(`click(btn("Keep it"))`);
  check("Keep it keeps it", !!(await until(`!$(".pb-dialog") && !!$('.pb-artifact-item[data-artifact-id="pricing-mockup"]')`)));
  const removesBefore = (await ev(`window.pobotsMock.requests()["artifact.remove"]`)) ?? 0;
  await ev(`click(btn("Remove from the list", $('.pb-artifact-item[data-artifact-id="pricing-mockup"]')))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click($$(".pb-dialog-actions button").pop())`);
  check("Remove takes it off the list", !!(await until(`!$(".pb-dialog") && !$('.pb-artifact-item[data-artifact-id="pricing-mockup"]')`)) && (await ev(`window.pobotsMock.requests()["artifact.remove"]`)) === removesBefore + 1);
  await goTo("Kaja", "chat");
  check("its row in the chat stays as a line that cannot be opened", !!(await until(`${aLine(aRow("pricing-mockup"))} === "Taken off the list" && ${aRow("pricing-mockup")}.getAttribute("aria-disabled") === "true"`)));
  await goTo("Inbox", "artifacts");
  check("a bot without artifacts says so in a plain line", !!(await until(`text(".pb-artifacts-empty") === "No artifacts yet. Ask Inbox to make one, for example a status page or a mock-up."`)));
  await houseRules("an empty Artifacts tab");

  // ---------------- 800 px: the panel takes the place of the chat
  await open(AS, { width: 800 });
  await stubWindows();
  await goTo("Kaja", "chat");
  await until(`${aRows}.length === 5`);
  await ev(readAt(aRow("customer-report"), 60));
  await sleep(150);
  const before800 = await ev(markTop);
  await ev(`click(${aRow("onboarding-status")})`);
  const narrow = await ev(`(async () => { for (let i = 0; i < 40 && !$$(".app-artifact iframe").some((f) => f.dataset.state === "shown"); i++) await new Promise((r) => setTimeout(r, 60)); const p = ${pane}.getBoundingClientRect(), m = $(".app-main").getBoundingClientRect(); return { mode: $(".app-shell").dataset.artifact, left: Math.round(p.left - m.left), covers: p.right >= m.right - 1, chatHidden: !$(".app-main").checkVisibility({ visibilityProperty: true }), back: document.activeElement?.getAttribute("aria-label"), divider: !!$(".pb-artifact-divider"), fill: !!${tool("Fill the main area")} }; })()`);
  check("800 px: the panel takes the place of the chat", narrow?.mode === "narrow" && Math.abs(narrow.left) <= 1 && narrow.covers && narrow.chatHidden, narrow);
  check("800 px: with a clear way back, which has the focus, and no divider or Fill", narrow?.back === "Back to Kaja" && !narrow.divider && !narrow.fill, narrow);
  await houseRules("800 px, the panel");
  await aShot("panel-800-dark");
  await ev(`click($(".pb-artifact-back"))`);
  check("800 px: back shows the chat as it was, the focus on the row", !!(await until(`!${pane} && $(".app-main").checkVisibility({ visibilityProperty: true }) && document.activeElement?.dataset.artifactId === "onboarding-status"`)));
  check("800 px: the line at the top of the chat is the same", keptTop(before800, await ev(sameTop)), { before800, after: await ev(sameTop) });
  await ev(`click(${aRow("onboarding-status")})`);
  await until(`!!${shownFrame}`);
  await key("Escape");
  check("800 px: Escape goes back too", !!(await until(`!${pane}`)));

  // ---------------- 1280 and 800 px, light and dark: the house rules, the keyboard, the seal
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 800]) {
      const tag = `${theme}-${width}`;
      await open(AS, { width, theme });
      await stubWindows();
      await goTo("Kaja", "chat");
      await until(`${aRows}.length === 5`);
      const hs = await ev(`${aRows}.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10)`);
      check(`${tag}: every artifact row has one height`, Array.isArray(hs) && hs.every((h) => h === hs[0]), hs);
      await houseRules(`${tag}, chat with artifact rows`);
      if (theme === "light" && width === 1280) {
        await ev(readAt(aRow("customer-report")));
        await aShot("row-published-light-1280", aRow("customer-report"));
        await aShot("row-link-light-1280", aRow("kickoff-agenda"));
        await aShot("row-gone-light-1280", aRow("pricing-mockup"));
        await ev(readAt(`${aRows}.find((r) => r.dataset.artifactId === "onboarding-status")`));
        await aShot("row-made-light-1280", `${aRows}.find((r) => r.dataset.artifactId === "onboarding-status")`);
        await aShot("row-updated-light-1280", aRow("onboarding-status"));
      }
      // Opened by the keyboard: the newest row is the line buttons' one Tab stop.
      await ev(`${aStops}.find((x) => x.tabIndex === 0).focus()`);
      await key("Enter");
      check(`${tag}: Enter on the row opens the panel`, !!(await until(`!!${shownFrame}`)));
      const seal = await ev(`${frames}.map((f) => f.getAttribute("sandbox"))`);
      check(`${tag}: no frame ever has allow-same-origin`, Array.isArray(seal) && seal.length > 0 && seal.every((s) => s === SANDBOX), seal);
      await houseRules(`${tag}, the open panel`);
      if (width === 1280) {
        await ev(`$(".pb-artifact-divider").focus()`);
        await focusRings(`${tag}, the panel's controls`, 9);
      } else {
        await ev(`$(".pb-artifact-back").focus()`);
        await focusRings(`${tag}, the panel's controls`, 6);
      }
      if (width === 1280) {
        await aShot(`panel-beside-chat-${tag}`);
        await aShot(`top-line-needs-you-2-${tag}`, `$(".pb-artifact-bar")`);
        await ev(`click(${tool("Fill the main area")})`);
        await until(`${mode} === "full"`);
        await houseRules(`${tag}, the panel filling the main area`);
        await aShot(`panel-full-${tag}`);
        await ev(`click(${tool("Show the chat beside it")})`);
        await aShot(`row-open-${tag}`, aRow("onboarding-status"));
      } else await aShot(`panel-800-${theme}`);
      await ev(`click(${tool("Close")})`);
      await until(`!${pane}`);
      await goTo("Kaja", "artifacts");
      await until(`!!$(".pb-artifact-item")`);
      await houseRules(`${tag}, the Artifacts tab`);
      await aShot(`artifacts-tab-${tag}`);
    }
  }
  if (artifactShots) console.log(`Artifact pictures in ${artifactShots}`);
  }
}
