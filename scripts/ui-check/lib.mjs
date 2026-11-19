// What every section of the window check shares: the arguments, the browser, the page helpers and
// the count of checks. Loaded once per run; see ../ui-check.mjs for how to run the check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "../browser.mjs";
import { killOrphanBrowsers, onStop, stopWithParent, sweepOld } from "../temp-cleanup.mjs";

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
export const shots = arg("shots");
export const keep = process.argv.includes("--keep");
// --only=<section> runs one section by itself, in a browser of its own. "base" is the first step
// (a bot's page and the rail); "2b" to "2g" are the steps that followed it (2b holds 2c too, 2e its addition, 2g its two later rounds). scripts/ui-check-all.mjs runs them all side by side; a new
// section gets a name here, a block `if (skip("<name>")) break ...;` below, and nothing else.
export const SECTIONS = ["base", "2b", "2d", "2e", "2f", "2g", "3a", "3b", "files", "backup", "phone", "push", "steer", "settings7", "chat7", "todo", "anyfile", "downloads", "sees", "changes", "mdtable", "foldsteer", "botreach", "posts", "helpersrail", "calendar", "taskmanagers", "smallfixes", "cards-after-restart", "activity", "railresize", "rail-fade", "card-questions", "failedwords", "restored-waiting", "lost-reply", "firststart", "gpttitles", "selfupdate", "usage-page", "connections", "codex-limits", "vacation", "ahead", "ahead-screen", "ahead-time"];
export const only = arg("only");
if (only && !SECTIONS.includes(only)) {
  console.error(`No section "${only}". The sections: ${SECTIONS.join(", ")}`);
  process.exit(2);
}
export const skip = (name) => !!only && only !== name;
if (process.argv.includes("--sections")) {
  console.log(SECTIONS.join("\n"));
  process.exit(0);
}
export const page = join(root, "dist", "ui", "index.html");
if (!existsSync(page)) {
  console.error("The window is not built. Run: npm run build:ui");
  process.exit(1);
}
if (shots) mkdirSync(shots, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Leftovers of checks and tests that crashed or were stopped more than a day ago go first (../temp-cleanup.mjs).
sweepOld();
// Browsers left running by earlier runs that were killed outright, and a stop when check-all is killed (fix 0.26.1).
await killOrphanBrowsers(["pobots-ui-check-"]);
stopWithParent();
// Only the browser profile lives here; it goes at the end, also when the run is stopped (Ctrl-C, SIGTERM).
export const work = mkdtempSync(join(tmpdir(), "pobots-ui-check-"));
onStop(async () => {
  try {
    await b.close();
  } catch {
    // Stopped before the browser was up.
  }
  if (!keep) rmSync(work, { recursive: true, force: true });
});
export const b = await launch({ profile: join(work, "browser"), width: 1280, height: 820 });
// The page's clock at another time of day, for proving that no check depends on it.
export const clock = /^(\d{1,2}):(\d{2})$/.exec(process.env.UI_CHECK_CLOCK ?? "");
if (clock) {
  const source = `(() => { const R = Date; const t = new R(); t.setHours(${Number(clock[1])}, ${Number(clock[2])}, 0, 0); const off = t.getTime() - R.now();
    class D extends R { constructor(...a) { if (a.length === 0) super(R.now() + off); else super(...a); } static now() { return R.now() + off; } }
    globalThis.Date = D; })();`;
  await b.cmd("Page.enable");
  await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source });
  console.log(`The page's clock reads ${clock[1]}:${clock[2]} today.`);
}

/**
 * Sets the page's clock to a fixed time of day for the pages opened from now on, for a section whose
 * checks need something of the mock's day (fix 0.26.3: "Later today" is empty in the evening). It
 * ticks on from there. Returns what takes it away again; call it at the end of the section.
 */
export async function fixClock(hours, minutes = 0) {
  const source = `(() => { const R = Date; const t = new R(); t.setHours(${hours}, ${minutes}, 0, 0); const off = t.getTime() - R.now();
    class D extends R { constructor(...a) { if (a.length === 0) super(R.now() + off); else super(...a); } static now() { return R.now() + off; } }
    globalThis.Date = D; })();`;
  await b.cmd("Page.enable");
  const { identifier } = await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source });
  return async () => {
    await b.cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  };
}

let passed = 0;
const failed = [];
export function check(name, ok, detail) {
  if (ok) passed++;
  else failed.push(detail === undefined ? name : `${name} (${typeof detail === "string" ? detail : JSON.stringify(detail)})`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

// ------------------------------------------------------------ page helpers

/** Evaluates in the page and returns the value; a thrown error comes back as { error }. */
export async function ev(expression) {
  const r = await b.cmd("Runtime.evaluate", { expression: `(async () => { ${HELPERS}; return (${expression}); })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

export const HELPERS = `
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const btn = (text, r = document) => $$("button", r).find((x) => x.textContent.trim() === text);
  const click = (el) => { if (!el) throw new Error("nothing to click"); el.click(); return true; };
  const text = (s) => ($(s)?.textContent ?? "").trim();
  const tabOpen = () => $(".app-tabpanel")?.dataset.tab;
  // Brings an element to the top of the panel's own scroller. scrollIntoView would also move the window.
  const inPanel = (el) => { const s = el.closest(".pb-main-scroll"); s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 16; return true; };
  // The line at the top of the chat's view (as ui/lib/place.ts reads it), and its top in the view.
  const LINES_AT_TOP = ".pb-msg-body > :not(ul, ol), .pb-msg-body li, .pb-msg-body:not(.app-md), .pb-msg-head, .pb-step, .pb-worked, .pb-helper, .pb-artifact, .pb-msg-you, .app-you-note, .app-notice, .pb-fold, .pb-fresh, .pb-pending, .app-thread-more";
  const lineTop = (s = $(".app-main .pb-main-scroll")) => { const v = s.getBoundingClientRect().top; for (const el of s.querySelectorAll(LINES_AT_TOP)) { const r = el.getBoundingClientRect(); if (r.height === 0) continue; if (r.top >= v - 0.5) return { el, top: r.top - v }; } return null; };
`;

export async function until(expression, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(expression);
    if (v && !v.error) return v;
    await sleep(60);
  }
  return undefined;
}

export async function open(query, { width = 1280, height = 820, theme = "dark" } = {}) {
  await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const url = `${pathToFileURL(page).href}?mock=1&theme=${theme}${query ? `&${query}` : ""}`;
  await b.cmd("Page.navigate", { url });
  const ok = await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
  await sleep(250);
  return ok;
}

export async function key(name, modifiers = 0) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
  const base = { key: name, code: name, windowsVirtualKeyCode: codes[name], modifiers };
  await b.cmd("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(name === "Enter" ? { text: "\r" } : {}) });
  await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(40);
}

export async function type(text) {
  await b.cmd("Input.insertText", { text });
  await sleep(40);
}

export async function shot(name) {
  if (!shots) return;
  await sleep(450);
  const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(result.data, "base64"));
}

/** Opens a bot by name in the roster, then a tab. */
export async function goTo(botName, tab = "chat") {
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(botName)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(botName)}`);
  await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
  return until(`tabOpen() === "${tab}"`);
}

/** The house rules, checked on whatever is on screen. */
export async function houseRules(where) {
  const borders = await ev(`$$("body *").filter((el) => {
      if (el.closest(".pb-mark, svg")) return false;
      const s = getComputedStyle(el);
      return ["Top", "Right", "Bottom", "Left"].some((side) => s["border" + side + "Style"] !== "none" && parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Color"] !== "rgba(0, 0, 0, 0)");
    }).map((el) => el.className || el.tagName).slice(0, 5)`);
  check(`${where}: no borders`, Array.isArray(borders) && borders.length === 0, borders);
  const copy = await ev(`(() => {
      const all = document.body.innerText + " " + $$("[placeholder],[aria-label],[title]").map((e) => [e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("title")].join(" ")).join(" ");
      return [...new Set((all.match(/[!\\u2013\\u2014]|\\p{Extended_Pictographic}/gu) ?? []))];
    })()`);
  check(`${where}: plain copy (no ! or long dashes or emoji)`, Array.isArray(copy) && copy.length === 0, copy);
  const overflow = await ev(`(() => {
      const doc = document.scrollingElement;
      const main = $(".app-main");
      // The rail too (17 Nov 2026): its overflow-x is hidden as the last guard, so its content is measured.
      const rail = $(".app-rail");
      return { page: doc.scrollWidth - innerWidth, panel: main ? main.scrollWidth - main.clientWidth : 0, rail: rail ? rail.scrollWidth - rail.clientWidth : 0 };
    })()`);
  check(`${where}: nothing scrolls sideways`, overflow && overflow.page <= 0 && overflow.panel <= 1 && overflow.rail <= 0, overflow);
}

/** Presses Tab `n` times and checks every control that gets focus shows the 2px focus ring. */
export async function focusRings(where, n) {
  const seen = new Set();
  const missing = [];
  for (let i = 0; i < n; i++) {
    await key("Tab");
    const r = await ev(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const own = getComputedStyle(el);
        const ring = (s) => s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2;
        // A text area inside the editor well rings the whole well.
        const well = el.closest(".pb-editor, .pb-composer");
        const ok = ring(own) || (well && ring(getComputedStyle(well)));
        return { id: (el.id || el.className || el.tagName) + ":" + (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24), ok };
      })()`);
    if (!r) continue;
    seen.add(r.id);
    if (!r.ok) missing.push(r.id);
  }
  check(`${where}: focus ring on every control reached by Tab (${seen.size} controls)`, seen.size > 3 && missing.length === 0, missing.slice(0, 5));
}

/** The line under a bot's name in the rail (used by several sections, so it lives here). */
export const rowLine = (name) => `${`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)})`}.querySelector(".pb-row-line").textContent`;

/** Used by more than one section, so it lives here. */
export const memory = `$$(".pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Working memory")`;

/** The count so far and the checks that failed, for the runner's last lines. */
export const totals = () => ({ passed, failed });
/** Counts a failure that is not a check: the run itself stopped. */
export function stopped(error) {
  failed.push(`the run stopped: ${error?.stack ?? error}`);
  console.log(`FAIL the run stopped: ${error?.stack ?? error}`);
}
