// Pictures of the built window at phone width, against the mock (groundwork for the phone layout).
// Light: one headless browser, no engine, no model. Opens dist/ui/index.html?mock=1 the way
// scripts/ui-check.mjs does, as a phone would (mobile viewport, touch, a phone's user agent), and
// writes pictures and a JSON of measurements into the folder given.
//
// Run: npm run build:ui && node scripts/dev/phone-look.mjs --out=DIR [--page=path/to/index.html]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { launch } from "../browser.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("out");
if (!out) throw new Error("--out=DIR is needed");
mkdirSync(out, { recursive: true });
const page = arg("page") ?? join(root, "dist", "ui", "index.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "pobots-phone-look-"));
const b = await launch({ profile: join(work, "browser"), width: 390, height: 844 });

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

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

let size = { width: 390, height: 844 };
async function open(query, { width = 390, height = 844, ua = IPHONE_UA } = {}) {
  size = { width, height };
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua, platform: ua.includes("iPhone") ? "iPhone" : "Linux armv8l" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const url = `${pathToFileURL(page).href}?mock=1&theme=dark${query ? `&${query}` : ""}`;
  await b.cmd("Page.navigate", { url });
  await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
  await sleep(400);
}

const measures = {};
/** Controls on screen smaller than 44 x 44, and what is cut off or overflowing. */
async function measure(name) {
  measures[name] = await ev(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; };
    const small = $$("button, a[href], input, textarea, [role=tab], [role=radio], [role=option]").filter(vis).map((el) => { const r = el.getBoundingClientRect(); return { what: (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.className).trim().slice(0, 32), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 44 || x.h < 44);
    const cols = getComputedStyle($(".pb-shell") ?? document.body).gridTemplateColumns;
    const main = $(".app-main")?.getBoundingClientRect();
    const fonts = $$("input, textarea").filter(vis).map((el) => ({ what: el.getAttribute("aria-label") || el.placeholder || el.className, font: getComputedStyle(el).fontSize }));
    return { innerWidth, innerHeight, cols, mainWidth: main ? Math.round(main.width) : null, sideways: document.scrollingElement.scrollWidth - innerWidth,
      coarse: matchMedia("(pointer: coarse)").matches, hoverNone: matchMedia("(hover: none)").matches, fields: fonts, smallCount: small.length, small: small.slice(0, 40) };
  })()`);
}

async function shot(name, { overlayKeyboard = 0 } = {}) {
  if (overlayKeyboard) {
    await ev(`(() => { const d = document.createElement("div"); d.id = "__kb"; d.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:${overlayKeyboard}px;background:rgba(120,120,130,.92);z-index:99999;display:grid;place-items:center;color:#111;font:600 15px system-ui"; d.textContent = "on-screen keyboard (about ${overlayKeyboard} px)"; document.body.append(d); return true; })()`);
  }
  await sleep(450);
  await measure(name);
  const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, "base64"));
  if (overlayKeyboard) await ev(`(document.getElementById("__kb")?.remove(), true)`);
  console.log("shot", name);
}

async function goTo(botName, tab = "chat") {
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(botName)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(botName)}`);
  await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
  await sleep(250);
}

// A small PNG on disk for the file picker.
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const fdir = join(work, "files");
mkdirSync(fdir, { recursive: true });
writeFileSync(join(fdir, "IMG_0412.png"), png(400, 300, [200, 120, 90]));
// Every picture starts from a clean page: no bot, panel or share kept from the one before.
await b.cmd("Page.enable");
await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); } catch {}" });
const onlyExtra = arg("only") === "extra";

try {
  for (const [w, h, tag] of onlyExtra ? [] : [[390, 844, "390"], [360, 780, "360"]]) {
    const ua = tag === "390" ? IPHONE_UA : ANDROID_UA;
    // 1. First screen.
    await open("", { width: w, height: h, ua });
    await shot(`${tag}-01-first-screen`);
    // The page scrolled by hand (body has overflow hidden, so nothing should move).
    // 2. A long thread.
    await open("scene=long", { width: w, height: h, ua });
    await shot(`${tag}-02-long-thread`);
    if (tag !== "390") continue;
    // 3. The message box with the keyboard's space: the field focused, and the keyboard drawn over
    //    the bottom (a phone's keyboard covers about 300 to 340 px and the layout does not shrink by default).
    await ev(`($(".app-main .pb-composer textarea").focus(), true)`);
    await shot(`${tag}-03-composer-keyboard-over`, { overlayKeyboard: 336 });
    // The same if the page did shrink to the space above the keyboard (Android with resizes-content).
    await open("scene=long", { width: w, height: h - 336, ua });
    await ev(`($(".app-main .pb-composer textarea").focus(), true)`);
    await shot(`${tag}-04-composer-page-shrunk`);
    // 5. The rail with cards: the rail column as it lands at phone width.
    await open("", { width: w, height: h, ua });
    await ev(`(() => { const r = $(".app-rail"); r.scrollIntoView(); return true; })()`);
    await shot(`${tag}-05-rail`);
    // 6. A bot's page and its tabs.
    await open("", { width: w, height: h, ua });
    await goTo("Kaja", "job");
    await shot(`${tag}-06-bot-page-job`);
    await goTo("Kaja", "settings");
    await shot(`${tag}-07-bot-page-settings`);
    await goTo("Kaja", "files");
    await shot(`${tag}-08-bot-page-files`);
    // 9. A dialog: Add a bot.
    await open("", { width: w, height: h, ua });
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$('.pb-dialog[role="dialog"]')`);
    await shot(`${tag}-09-dialog-add-bot`);
    // 10. The model picker.
    await open("scene=picker", { width: w, height: h, ua });
    await until(`!!$(".app-picker")`);
    await shot(`${tag}-10-model-picker`);
    // 11. The attach tray and 12. a picture opened large.
    await open("files=fresh", { width: w, height: h, ua });
    await goTo("HubSpot tickets");
    await until(`$$(".app-main .pb-picture").length >= 2`);
    const input = await b.cmd("Runtime.evaluate", { expression: `document.querySelector(".app-main .pb-attach-input")` });
    if (input.result?.result?.objectId) {
      await b.cmd("DOM.setFileInputFiles", { objectId: input.result.result.objectId, files: [join(fdir, "IMG_0412.png")] });
      await until(`!!$(".app-main .pb-tray")`);
    }
    measures.attachInput = await ev(`(() => { const i = $(".app-main .pb-attach-input"); return i && { accept: i.getAttribute("accept"), capture: i.getAttribute("capture"), multiple: i.multiple }; })()`);
    await shot(`${tag}-11-attach-tray`);
    await ev(`click($$(".app-main .pb-picture")[0])`);
    await until(`!!$(".pb-picture-view")`);
    await shot(`${tag}-12-picture-large`);
    // 13. The artifact panel.
    await open("scene=artifacts", { width: w, height: h, ua });
    const art = await until(`$$(".app-main .pb-thread .pb-artifact").length > 0`);
    if (art) {
      await ev(`click($$(".app-main .pb-thread .pb-artifact:not([aria-disabled])").pop())`);
      await until(`!!$(".app-artifact")`);
      await sleep(600);
    }
    await shot(`${tag}-13-artifact-panel`);
    // 14. The browser panel.
    await open("scene=browser", { width: w, height: h, ua });
    await ev(`click($(".pb-browser-line"))`);
    await until(`!!$(".app-artifact")`);
    await sleep(900);
    await shot(`${tag}-14-browser-panel`);
  }
  if (onlyExtra) {
    await open("scene=artifacts");
    const rows = await until(`$$(".app-main .pb-thread .pb-artifact").length`);
    measures.artifactRows = rows;
    await ev(`click($$(".app-main .pb-thread .pb-artifact").find((r) => r.getAttribute("aria-disabled") !== "true"))`);
    measures.artifactOpened = !!(await until(`!!$(".app-artifact")`, 5000));
    await sleep(900);
    await shot(`390-13-artifact-panel`);
  }
  // A typed-answer card: a copy of the built page with allowText switched on in the mock (see --textpage).
  const textPage = arg("textpage");
  if (textPage) {
    const url = `${pathToFileURL(textPage).href}?mock=1&theme=dark`;
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await b.cmd("Page.navigate", { url });
    await until(`!!document.querySelector(".pb-shell")`, 6000);
    await sleep(400);
    await ev(`($(".app-rail .app-card-answer input")?.focus(), true)`);
    await shot(`390-15-rail-typed-answer`);
  }
  // The meta viewport and the manifest as the page has them.
  measures.head = await ev(`({ viewport: $('meta[name=viewport]')?.content, theme: $('meta[name=theme-color]')?.content, appleIcon: $('link[rel=apple-touch-icon]')?.getAttribute("href"), appleCapable: $('meta[name=apple-mobile-web-app-capable], meta[name=mobile-web-app-capable]')?.content ?? null, statusBar: $('meta[name=apple-mobile-web-app-status-bar-style]')?.content ?? null })`);
  writeFileSync(join(out, "measures.json"), JSON.stringify(measures, null, 2));
  console.log("done");
} finally {
  await b.close();
  rmSync(work, { recursive: true, force: true });
}
