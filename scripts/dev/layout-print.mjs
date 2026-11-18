// A layout fingerprint of the built window at laptop widths, to prove that a change for the phone
// moved nothing on the laptop (docs/build/step-phone.md, "Done means"). One headless browser, the
// mock engine, no model. Opens about a dozen screens at 1280 x 820, 1024 x 768, 800 x 700 and
// 700 x 700, reduced motion on and the page's clock fixed, and writes every element's box, font
// size, padding, height and visibility as JSON. Two prints of the same build must be the same; a
// print before a change and one after must be the same too.
//
// Run: npm run build:ui && node scripts/dev/layout-print.mjs --out=FILE.json
//      node scripts/dev/layout-print.mjs --compare=BEFORE.json,AFTER.json
// Keep the prints outside the repository.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// ------------------------------------------------------------ comparing two prints
const compare = arg("compare");
if (compare) {
  const [a, b] = compare.split(",").map((p) => JSON.parse(readFileSync(p, "utf8")));
  let differences = 0;
  const keys = [...new Set([...Object.keys(a.screens), ...Object.keys(b.screens)])];
  for (const key of keys) {
    const x = a.screens[key];
    const y = b.screens[key];
    if (!x || !y) {
      console.log(`${key}: only in ${x ? "the first" : "the second"} print`);
      differences++;
      continue;
    }
    const mx = new Map(x.map((e) => [e[0], e]));
    const my = new Map(y.map((e) => [e[0], e]));
    const lines = [];
    for (const [path, e] of mx) {
      const f = my.get(path);
      if (!f) lines.push(`  gone: ${path}`);
      else if (JSON.stringify(e) !== JSON.stringify(f)) lines.push(`  changed: ${path}\n    ${JSON.stringify(e.slice(1))}\n    ${JSON.stringify(f.slice(1))}`);
    }
    for (const path of my.keys()) if (!mx.has(path)) lines.push(`  new: ${path}`);
    if (lines.length) {
      differences += lines.length;
      console.log(`${key}: ${lines.length} difference(s)`);
      for (const l of lines.slice(0, 20)) console.log(l);
      if (lines.length > 20) console.log(`  ... and ${lines.length - 20} more`);
    }
  }
  const count = (p) => Object.values(p.screens).reduce((n, s) => n + s.length, 0);
  console.log(`\n${keys.length} screens, ${count(a)} and ${count(b)} elements: ${differences === 0 ? "the same" : `${differences} difference(s)`}`);
  process.exit(differences === 0 ? 0 : 1);
}

// ------------------------------------------------------------ taking a print
const out = arg("out");
if (!out) throw new Error("--out=FILE.json or --compare=A.json,B.json is needed");
const { launch } = await import("../browser.mjs");
const page = arg("page") ?? join(root, "dist", "ui", "index.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "pobots-layout-print-"));
const b = await launch({ profile: join(work, "browser"), width: 1280, height: 820 });

const HELPERS = `
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const click = (el) => { if (!el) throw new Error("nothing to click"); el.click(); return true; };
`;
async function ev(expression) {
  const r = await b.cmd("Runtime.evaluate", { expression: `(async () => { ${HELPERS}; return (${expression}); })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
async function until(expression, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(expression);
    if (v && !v.error) return v;
    await sleep(60);
  }
  return undefined;
}

// A fixed clock: 13 Nov 2026 at 10:00 when the page opens, running from there, so times read the same.
const CLOCK = `(() => { const R = Date; const start = new R(2026, 10, 13, 10, 0, 0, 0).getTime(); const off = start - R.now();
  class D extends R { constructor(...a) { if (a.length === 0) super(R.now() + off); else super(...a); } static now() { return R.now() + off; } }
  globalThis.Date = D; })();`;
await b.cmd("Page.enable");
await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.clear(); sessionStorage.clear(); } catch {}" });
await b.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

async function open(query, width, height) {
  await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark${query ? `&${query}` : ""}` });
  await until(`!!document.querySelector(".pb-shell, .app-first-body")`, 8000);
  await sleep(300);
}
const goTo = async (name, tab) => {
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
  if (tab) {
    await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
    await until(`$(".app-tabpanel")?.dataset.tab === "${tab}"`);
  }
};

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
const picture = join(work, "IMG_0412.png");
writeFileSync(picture, png(400, 300, [200, 120, 90]));

/** Every element in the body: its path, box, font size, padding, height and visibility. */
const PRINT = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const out = [];
  const walk = (el, path) => {
    const kids = [...el.children];
    const seen = {};
    for (const k of kids) {
      if (k.tagName === "SCRIPT" || k.tagName === "STYLE") continue;
      // A face's eyes blink and drift by themselves; they are not layout.
      if (k.parentElement?.classList.contains("pb-eyes")) continue;
      const cls = typeof k.className === "string" ? k.className.trim().split(/\\s+/).filter(Boolean).sort().join(".") : "";
      const name = k.tagName.toLowerCase() + (cls ? "." + cls : "");
      seen[name] = (seen[name] ?? 0) + 1;
      const p = path + ">" + name + "[" + seen[name] + "]";
      const r = k.getBoundingClientRect();
      const s = getComputedStyle(k);
      out.push([p, r1(r.left), r1(r.top), r1(r.width), r1(r.height), s.fontSize, s.padding, s.height, s.visibility, s.display === "none" ? "none" : "", r1(k.scrollTop), r1(k.scrollLeft)]);
      walk(k, p);
    }
  };
  walk(document.body, "body");
  return out;
})()`;

const screens = {};
/** Prints the screen once it stands still: two prints in a row, 500 ms apart, that are the same. */
async function take(key) {
  await sleep(700);
  let last = await ev(PRINT);
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const next = await ev(PRINT);
    if (JSON.stringify(next) === JSON.stringify(last)) break;
    last = next;
    if (i === 11) console.log(`${key}: still moving after 6 seconds`);
  }
  screens[key] = last;
  if (!Array.isArray(screens[key])) throw new Error(`${key}: ${JSON.stringify(screens[key])}`);
  console.log(`${key}: ${screens[key].length} elements`);
}

const SIZES = [
  [1280, 820],
  [1024, 768],
  [800, 700],
  [700, 700],
];
try {
  for (const [w, h] of SIZES) {
    const at = `${w}x${h}`;
    await open("", w, h);
    await take(`${at} chat`);
    for (const tab of ["job", "files", "artifacts", "triggers", "history", "settings"]) {
      await goTo("Kaja", tab);
      if (tab === "job") await until(`!$(".pb-editor-text")?.disabled`);
      if (tab === "files") await until(`!!$(".pb-file")`);
      if (tab === "history") await until(`!!$(".pb-change")`);
      await take(`${at} ${tab}`);
    }
    await open("scene=long", w, h);
    await take(`${at} long chat`);
    await open("scene=picker", w, h);
    await until(`!!$(".app-picker")`);
    await take(`${at} picker`);
    await open("", w, h);
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$('.pb-dialog[role="dialog"]')`);
    await take(`${at} add bot`);
    await open("", w, h);
    await ev(`click($(".pb-settings-line"))`);
    await until(`!!$(".app-appsettings")`);
    await take(`${at} pobots settings`);
    await open("files=fresh", w, h);
    await goTo("HubSpot tickets");
    await until(`$$(".app-main .pb-picture").length >= 2`);
    const input = await b.cmd("Runtime.evaluate", { expression: `document.querySelector(".app-main .pb-attach-input")` });
    if (input.result?.result?.objectId) {
      await b.cmd("DOM.setFileInputFiles", { objectId: input.result.result.objectId, files: [picture] });
      await until(`!!$(".app-main .pb-tray")`);
      await sleep(900);
    }
    await take(`${at} tray`);
    await ev(`click($$(".app-main .pb-picture")[0])`);
    await until(`!!$(".pb-picture-view")`);
    await take(`${at} picture large`);
    await open("scene=artifacts", w, h);
    await until(`$$(".app-main .pb-thread .pb-artifact").length > 0`);
    await ev(`click($$(".app-main .pb-thread .pb-artifact").filter((r) => r.getAttribute("aria-disabled") !== "true").pop())`);
    await until(`!!$(".app-artifact")`);
    await sleep(600);
    await take(`${at} artifact`);
    await open("scene=browser", w, h);
    await ev(`click($(".pb-browser-line"))`);
    await until(`!!$(".app-artifact")`);
    await sleep(900);
    await take(`${at} browser`);
    await open("scene=helpers", w, h);
    await until(`!!$(".app-main .pb-worked")`);
    await ev(`(() => { for (const x of $$('.app-main .pb-worked[aria-expanded="false"]')) x.click(); return true; })()`);
    await until(`$$(".app-main .pb-thread .pb-helper").length > 0`);
    await ev(`click($(".app-main .pb-thread .pb-helper"))`);
    await until(`!!$(".pb-helper-bar")`);
    await take(`${at} helper thread`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ page, at: new Date().toISOString(), screens }));
  console.log(`Wrote ${out}`);
} finally {
  await b.close();
  rmSync(work, { recursive: true, force: true });
}
