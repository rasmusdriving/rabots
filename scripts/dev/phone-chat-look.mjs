// Pictures of the chat and typing at phone width, against the mock (builder B of the phone layout,
// docs/build/step-phone.md). Light: one headless browser, no engine, no model. Opens the built page
// as a phone (mobile viewport, touch, a phone's user agent) and writes pictures and measures.json.
//
// Until the phone shell is in, the chat is a thin strip at phone width: --widen injects a style from
// this script only (never in the app's files) that lays the chat out at full width.
//
// Run: npm run build:ui && node scripts/dev/phone-chat-look.mjs --out=DIR [--widen] [--only=name,name] [--theme=light]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "../browser.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("out");
if (!out) throw new Error("--out=DIR is needed");
mkdirSync(out, { recursive: true });
const widen = process.argv.includes("--widen");
const only = arg("only")?.split(",");
const theme = arg("theme") ?? "dark";
const page = join(root, "dist", "ui", "index.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "pobots-phone-chat-look-"));
const b = await launch({ profile: join(work, "browser"), width: 390, height: 844 });

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const WIDEN = `.pb-shell.app-shell { grid-template-columns: minmax(0, 1fr) !important; gap: 0 !important; padding: 0 !important; } .app-shell > .app-side, .app-shell > .app-rail { display: none !important; } .app-shell > .app-main { grid-column: 1 !important; border-radius: 0 !important; }`;

const HELPERS = `
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const btn = (text, r = document) => $$("button", r).find((x) => x.textContent.trim() === text);
  const click = (el) => { if (!el) throw new Error("nothing to click"); el.click(); return true; };
`;
async function ev(expression) {
  const r = await b.cmd("Runtime.evaluate", { expression: `(async () => { ${HELPERS}; return (${expression}); })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
async function until(expression, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(expression);
    if (v && !v.error) return v;
    await sleep(60);
  }
  return undefined;
}

await b.cmd("Page.enable");
await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); } catch {}" });
if (widen) await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(WIDEN)}; document.head.append(s); });` });
await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__files = { picture: (name = "image.png", w = 400, h = 240, color = "#4f5ae8") => new Promise((r) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.fillRect(w / 4, h / 4, w / 2, h / 2); c.toBlob((b) => r(new File([b], name, { type: "image/png" })), "image/png"); }) };`,
});

async function open(query, { width = 390, height = 844, ua = IPHONE_UA } = {}) {
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua, platform: ua.includes("iPhone") ? "iPhone" : "Linux armv8l" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}${query ? `&${query}` : ""}` });
  await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
  await sleep(400);
}

const measures = {};
async function measure(name) {
  measures[name] = await ev(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !el.closest(".app-side, .app-rail"); };
    const small = $$("button, a[href], input, textarea, select, [role=tab]").filter(vis).map((el) => { const r = el.getBoundingClientRect(); return { what: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.className).trim().slice(0, 32), cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 44 || x.h < 44);
    const wide = $$("body *").filter(vis).filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && !el.closest(".pb-tray-chips, .pb-tabs, .pb-diff, pre")).map((el) => String(el.className || el.tagName).slice(0, 40)).slice(0, 12);
    const fonts = $$("input:not([type=checkbox]), textarea, select").filter(vis).map((el) => ({ what: el.getAttribute("aria-label") || el.placeholder || el.className, font: getComputedStyle(el).fontSize }));
    return { innerWidth, sideways: document.scrollingElement.scrollWidth - innerWidth, wide, fields: fonts, smallCount: small.length, small: small.slice(0, 40) };
  })()`);
}
async function shot(name) {
  if (only && !only.some((o) => name.includes(o))) return;
  await sleep(450);
  await measure(name);
  const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
  console.log("shot", name);
}
async function goTo(botName, tab = "chat") {
  // The phone shell: Bots first, then the bot; its page (the tabs) through "Page".
  for (let i = 0; i < 4 && !(await ev(`!!$$(".app-row").find((r) => r.checkVisibility() && r.querySelector(".pb-row-name").textContent === ${JSON.stringify(botName)})`)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(botName)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(botName)}`);
  if (tab !== "chat") {
    if (!(await ev(`!!$('.pb-tab[data-tab="${tab}"]')?.checkVisibility()`))) await ev(`click($(".app-phone-page"))`);
    await until(`!!$('.pb-tab[data-tab="${tab}"]')?.checkVisibility()`);
    await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
  }
  await sleep(350);
}

try {
  for (const [w, h, tag, ua] of [[390, 844, "390", IPHONE_UA], [360, 780, "360", ANDROID_UA]]) {
    await open("scene=long", { width: w, height: h, ua });
    await goTo("Kaja");
    await shot(`${tag}-chat`);
    await ev(`(() => { const t = $(".app-main .pb-composer textarea"); t.focus(); return true; })()`);
    await b.cmd("Input.insertText", { text: "A first line\nA second line\nA third" });
    await shot(`${tag}-composer-lines`);
    await ev(`window.__files.picture("Team photo.png").then((f) => { const t = $(".app-main .pb-composer textarea"); const dt = new DataTransfer(); dt.items.add(f); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })`);
    await ev(`Promise.all([window.__files.picture("Screenshot one.png"), window.__files.picture("A long name for a photo from the phone.png")]).then((fs) => { const t = $(".app-main .pb-composer textarea"); const dt = new DataTransfer(); for (const f of fs) dt.items.add(f); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })`);
    await until(`$$(".app-main .pb-chip-file[data-status=done]").length === 3`);
    await shot(`${tag}-tray`);
    await ev(`click($(".app-main .pb-composer .pb-push"))`);
    await until(`!!$(".app-picker")`);
    await shot(`${tag}-picker`);
    await ev(`(document.activeElement?.blur?.(), true)`);
    await open("files=fresh", { width: w, height: h, ua });
    await goTo("HubSpot tickets");
    await until(`$$(".app-main .pb-picture").length >= 2`);
    await ev(`(() => { const p = $$(".app-main .pb-picture")[0]; const s = p.closest(".pb-main-scroll"); s.scrollTop += p.getBoundingClientRect().top - s.getBoundingClientRect().top - 80; return true; })()`);
    await shot(`${tag}-pictures`);
    await ev(`click($$(".app-main .pb-picture")[0])`);
    await until(`!!$(".pb-picture-view [data-full]")`);
    await shot(`${tag}-picture-large`);
    await ev(`(history.back(), true)`);
    await sleep(300);
    for (const tab of ["job", "files", "triggers", "history", "artifacts", "settings"]) {
      await goTo("Kaja", tab);
      await shot(`${tag}-tab-${tab}`);
    }
    await goTo("Kaja", "settings");
    await ev(`(() => { const s = $(".app-settings"); s.scrollTop = 99999; return true; })()`);
    await shot(`${tag}-tab-settings-bottom`);
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    await shot(`${tag}-dialog-add-bot`);
    await ev(`(() => { const d = $(".pb-dialog"); d.scrollTop = 99999; return true; })()`);
    await shot(`${tag}-dialog-add-bot-foot`);
    await open("", { width: w, height: h, ua });
    await ev(`click($(".pb-settings-line") ?? btn("Pobots settings"))`);
    await sleep(500);
    await shot(`${tag}-appsettings`);
    await ev(`(() => { const s = $(".app-appsettings-scroll") ?? $(".app-appsettings .pb-main-scroll"); if (s) s.scrollTop = 99999; return true; })()`);
    await shot(`${tag}-appsettings-bottom`);
  }
} finally {
  writeFileSync(join(out, "measures.json"), JSON.stringify(measures, null, 2));
  await b.close();
  rmSync(work, { recursive: true, force: true });
}

process.exit(0);
