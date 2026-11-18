// The window check, section "files". Run it alone: node scripts/ui-check.mjs --only=files
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ pictures and files in the chat
// docs/build/step-files.md, the app builder. The mock acts the upload out in the page (progress over
// about half a second; over 100 MB refused, any kind taken (step 7c), a name with "fail" failed). With
// &files=fresh HubSpot tickets has a picture in an older page of its history and, in its newest
// message, two pictures, a PDF and a file that is gone; &files=1 also keeps what is sent across a
// reload. &picturesFrom= takes the sample pictures from a small server here on 127.0.0.1 that
// holds them back until the check lets them go, so the box of a picture can be measured before it
// has loaded and again after.
export default async function section() {
  stepFiles: {
  const botOf = (id) => `window.pobotsState().bots.find((b) => b.id === ${JSON.stringify(id)})`;
  const filesShots = arg("files-shots") ?? (shots ? join(shots, "files") : undefined);
  if (filesShots) mkdirSync(filesShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it, or of the whole window. */
  async function aShot(name, selector) {
    if (!filesShots) return;
    await sleep(450);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      if (r && !r.error) clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(filesShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }

  // ---- the picture server: PNGs of the asked size, held back until let go
  const { createServer } = await import("node:http");
  const { deflateSync, crc32 } = await import("node:zlib");
  const pngCache = new Map();
  function png(w, h, rgb) {
    const key = `${w}x${h}:${rgb}`;
    if (pngCache.has(key)) return pngCache.get(key);
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const out = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    pngCache.set(key, out);
    return out;
  }
  let holding = true;
  let held = [];
  let served = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const w = Number(u.searchParams.get("w")) || 400;
    const h = Number(u.searchParams.get("h")) || 300;
    const s = Math.min(1, 1024 / Math.max(w, h));
    const send = () => {
      served++;
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(png(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), [120, 140, 200]));
    };
    if (holding) held.push(send);
    else send();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const picturesFrom = `http://127.0.0.1:${server.address().port}`;
  const hold = () => (holding = true);
  const release = () => {
    holding = false;
    const all = held;
    held = [];
    for (const f of all) f();
  };

  // ---- files on disk for the picker
  const fdir = join(work, "files");
  mkdirSync(fdir, { recursive: true });
  writeFileSync(join(fdir, "Team photo.png"), png(400, 240, [200, 120, 90]));
  writeFileSync(join(fdir, "Onboarding plan.pdf"), "%PDF-1.4 a small stand-in");
  writeFileSync(join(fdir, "fail-report.pdf"), "%PDF-1.4 fails the first time");

  // In the page: make files and hand them over the way a paste or a drop does.
  await b.cmd("Page.enable");
  await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__files = {
      picture: (name = "image.png", w = 400, h = 240, color = "#4f5ae8") => new Promise((r) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.fillRect(w / 4, h / 4, w / 2, h / 2); c.toBlob((b) => r(new File([b], name, { type: "image/png" })), "image/png"); }),
      text: (name, body = "Hello") => new File([body], name, { type: "text/plain" }),
      big: (name) => new File([new Uint8Array(101 * 1024 * 1024)], name, { type: "image/png" }),
      paste: (files, text) => { const t = document.querySelector(".app-main .pb-composer textarea"); const dt = new DataTransfer(); for (const f of files) dt.items.add(f); if (text !== undefined) dt.setData("text/plain", text); const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; },
      drag: (type, files, target) => { const el = target || document.querySelector(".app-main .pb-main-scroll"); const dt = new DataTransfer(); for (const f of files) dt.items.add(f); const r = el.getBoundingClientRect(); const e = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); el.dispatchEvent(e); return e.defaultPrevented; },
    };`,
  });

  const chipsNow = `$$(".app-main .pb-chip-file[data-chip]").map((c) => ({ name: c.querySelector(".pb-chip-name").dataset.name, shown: c.querySelector(".pb-chip-name > [aria-hidden]").textContent, status: c.dataset.status, meta: c.querySelector(".pb-chip-meta")?.textContent ?? "", retry: !!c.querySelector(".pb-chip-retry"), thumb: !!c.querySelector(".pb-chip-thumb img"), h: Math.round(c.getBoundingClientRect().height) }))`;
  const trayLineNow = `($(".app-main .pb-tray-line")?.textContent ?? null)`;
  const composerBox = `(() => { const c = $(".app-main .pb-composer"); const t = $(".app-main .pb-tray"); const s = $(".app-main .pb-main-scroll"); return { composer: Math.round(c.getBoundingClientRect().height * 10) / 10, tray: t ? Math.round(t.getBoundingClientRect().height * 10) / 10 : 0, chips: t ? Math.round(t.querySelector(".pb-tray-chips").getBoundingClientRect().height * 10) / 10 : 0, line: t ? Math.round(t.querySelector(".pb-tray-line").getBoundingClientRect().height * 10) / 10 : 0, atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 2 }; })()`;
  /** Samples a layout function every frame and on every change, until stopped: all samples must be equal. */
  const watchStart = (fn) => `(() => { const L = ${fn}; window.__aw = [JSON.stringify(L())]; window.__awObs = new MutationObserver(() => window.__aw.push(JSON.stringify(L()))); window.__awObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); window.__awOn = true; const tick = () => { if (!window.__awOn) return; window.__aw.push(JSON.stringify(L())); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`;
  const watchStop = `(() => { window.__awOn = false; window.__awObs.disconnect(); const a = window.__aw; return { samples: a.length, first: a[0], bad: a.filter((x) => x !== a[0]).slice(0, 2) }; })()`;
  const steady = (w) => !!w && !w.error && w.samples > 1 && w.bad.length === 0;
  /** The tray's line without the count that stands before it when the row hides chips ("4 attached. "). */
  const bare = (line) => (typeof line === "string" ? line.replace(/^\d+ attached(\. |$)/, "") : line);
  /** A real press and release of the mouse at a point, as a person's click: the browser moves the focus on the press. */
  const realClick = async (x, y) => {
    await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await b.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await b.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(80);
  };
  const centerOf = (selector) => ev(`(() => { const r = (${selector}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const uploads = async () => (await ev(`window.pobotsMock.requests().upload ?? 0`)) || 0;
  const discards = async () => (await ev(`window.pobotsMock.requests()["attachment.discard"] ?? 0`)) || 0;
  const userItems = `window.pobotsState().threads["hubspot-tickets-main"].items.filter((i) => i.kind === "user" && i.from.type === "you")`;
  const removeAll = async () => {
    for (let i = 0; i < 12; i++) {
      const left = await ev(`$$(".app-main .pb-chip-remove").length`);
      if (!left) break;
      await ev(`click($(".app-main .pb-chip-remove"))`);
      await sleep(60);
    }
    return until(`!$(".app-main .pb-tray")`);
  };

  // ---------------- a sent picture stands in its final box before it loads
  hold();
  await open(`files=fresh&picturesFrom=${encodeURIComponent(picturesFrom)}`);
  await goTo("HubSpot tickets");
  await until(`$$(".app-main .pb-picture").length >= 2`);
  await sleep(300);
  const boxesBefore = await ev(`$$(".app-main .pb-picture").map((p) => { const r = p.getBoundingClientRect(); const i = p.querySelector("img"); return { alt: i.alt, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, loaded: i.complete && i.naturalWidth > 0, attrW: i.getAttribute("width"), attrH: i.getAttribute("height") }; })`);
  check("files: the pictures of a message stand in boxes sized from their stored width and height (320 x 180 and 180 x 320) before anything has loaded",
    Array.isArray(boxesBefore) && boxesBefore.length === 2 && !boxesBefore.some((x) => x.loaded) && boxesBefore[0].w === 320 && boxesBefore[0].h === 180 && boxesBefore[1].w === 180 && boxesBefore[1].h === 320, boxesBefore);
  check("files: a picture's alternative text is its name", boxesBefore?.[0]?.alt === "Screenshot 2026-11-13 08.12.png" && boxesBefore?.[1]?.alt === "Phone photo.jpg", boxesBefore);
  const threadTops = `() => { const s = document.querySelector(".app-main .pb-main-scroll"); return { tops: [...document.querySelectorAll(".app-main .pb-thread > *")].map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10), boxes: [...document.querySelectorAll(".app-main .pb-picture")].map((p) => Math.round(p.getBoundingClientRect().height * 10) / 10), scroll: s.scrollTop, height: s.scrollHeight }; }`;
  await ev(watchStart(threadTops));
  release();
  const loaded = await until(`$$(".app-main .pb-picture").every((p) => p.querySelector("img").naturalWidth > 0 && p.dataset.shown !== undefined)`, 6000);
  await sleep(400);
  let w = await ev(watchStop);
  check("files: when the pictures arrive, no line above or below moves by a pixel and the chat does not scroll", !!loaded && steady(w), { loaded, w });
  const files = await ev(`$$(".app-main .pb-msg-file").map((f) => ({ tag: f.tagName, name: f.querySelector(".pb-chip-name").textContent, meta: f.querySelector(".pb-chip-meta").textContent, download: f.getAttribute("download"), href: !!f.getAttribute("href") }))`);
  check("files: a file in a message is a chip with its name and size that downloads; a file that is gone says so and is not a link",
    Array.isArray(files) && files[0]?.tag === "A" && files[0].name === "Nordvik import report.pdf" && files[0].meta === "242 KB" && files[0].download === "Nordvik import report.pdf" && files[0].href && files[1]?.tag === "DIV" && files[1].meta === "This file is no longer on the Mac." && !files[1].href, files);
  await aShot("message-pictures-dark", `$$(".app-main .app-you").find((m) => m.querySelector(".pb-picture"))`);

  // ---------------- the large view
  const before = await ev(`$(".app-main .pb-main-scroll").scrollTop`);
  await ev(`click($$(".app-main .pb-picture")[0])`);
  const view = await until(`(() => { const d = $('.pb-picture-view[role="dialog"]'); if (!d) return null; const f = d.querySelector(".pb-picture-large").getBoundingClientRect(); return { label: d.getAttribute("aria-label"), modal: d.getAttribute("aria-modal"), focus: document.activeElement?.getAttribute("aria-label"), w: Math.round(f.width), h: Math.round(f.height), scroll: $(".app-main .pb-main-scroll").scrollTop }; })()`);
  check("files: a picture opens large in a dialog named after it, with the focus on Close, and the chat does not move",
    view?.label === "Screenshot 2026-11-13 08.12.png" && view.modal === "true" && view.focus === "Close" && view.scroll === before && Math.abs(view.w / view.h - 1920 / 1080) < 0.02 && view.w <= 1280 - 72, view);
  await aShot("large-view-dark");
  await key("Tab");
  check("files: Tab stays inside the large view", (await ev(`document.activeElement?.closest(".pb-picture-view") ? document.activeElement.getAttribute("aria-label") : null`)) === "Close");
  await key("Escape");
  const closed = await until(`!$(".pb-picture-view") && { focus: document.activeElement?.classList.contains("pb-picture") && document.activeElement.querySelector("img").alt, scroll: $(".app-main .pb-main-scroll").scrollTop }`);
  check("files: Escape closes the large view, the focus is back on the picture and the chat has not moved", closed?.focus === "Screenshot 2026-11-13 08.12.png" && closed.scroll === before, closed);
  await ev(`click($$(".app-main .pb-picture")[1])`);
  await until(`!!$(".pb-picture-view")`);
  await realClick(4, 4);
  const pictureFocus = `!$(".pb-picture-view") && { picture: document.activeElement?.classList.contains("pb-picture") ? document.activeElement.querySelector("img").alt : document.activeElement?.tagName, scroll: $(".app-main .pb-main-scroll").scrollTop }`;
  const outside = await until(pictureFocus);
  check("files: a click outside the picture closes the large view, focus back on the picture", outside?.picture === "Phone photo.jpg" && outside.scroll === before, outside);
  // Opened with the keyboard, closed with a real click outside: the focus is back on the picture, not on the page.
  await ev(`$$(".app-main .pb-picture")[1].focus()`);
  await key("Enter");
  await until(`!!$(".pb-picture-view") && document.activeElement?.getAttribute("aria-label") === "Close"`);
  await realClick(4, 4);
  const outsideKeys = await until(pictureFocus);
  check("files: opened with the keyboard and closed with a click outside, the focus is back on the picture", outsideKeys?.picture === "Phone photo.jpg" && outsideKeys.scroll === before, outsideKeys);
  await key("Enter");
  await until(`!!$(".pb-picture-view")`);
  const closeAt = await centerOf(`$(".pb-picture-view-close")`);
  await realClick(closeAt.x, closeAt.y);
  const byClose = await until(pictureFocus);
  check("files: closed with the close button, the focus is back on the picture", byClose?.picture === "Phone photo.jpg" && byClose.scroll === before, byClose);

  // ---------------- a picture in an older page, loaded while scrolling up
  hold();
  await ev(`(() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return true; })()`);
  // Older pages are read while near the top; the oldest has the picture.
  let older = null;
  for (let i = 0; i < 6 && !older; i++) {
    await sleep(300);
    older = await ev(`(() => { const p = $$(".app-main .pb-picture").find((x) => x.querySelector("img")?.alt === "Old ticket view.png"); return p ? true : (() => { const s = $(".app-main .pb-main-scroll"); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return null; })(); })()`);
  }
  await sleep(300);
  const oldBox = await ev(`(() => { const p = $$(".app-main .pb-picture").find((x) => x.querySelector("img")?.alt === "Old ticket view.png"); const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), loaded: p.querySelector("img").naturalWidth > 0 }; })()`);
  check("files: a picture in an older page stands in its final box (320 x 200) before it loads", oldBox?.w === 320 && oldBox.h === 200 && oldBox.loaded === false, oldBox);
  await ev(watchStart(threadTops));
  release();
  const oldLoaded = await until(`$$(".app-main .pb-picture").every((p) => p.querySelector("img").naturalWidth > 0)`, 6000);
  await sleep(400);
  w = await ev(watchStop);
  check("files: when the older picture arrives, nothing in the chat moves", !!oldLoaded && steady(w), { oldLoaded, w });

  // ---------------- the message box: paste, pick, drop
  await open(`files=fresh&picturesFrom=${encodeURIComponent(picturesFrom)}`);
  release();
  await goTo("HubSpot tickets");
  await until(`$$(".app-main .pb-picture").length >= 2`);
  const attachBtn = await ev(`(() => { const b = $(".app-main .pb-composer .pb-attach"); return b && { label: b.getAttribute("aria-label"), first: b.parentElement.firstElementChild === b }; })()`);
  check("files: the add button beside the box says what it does: Attach pictures or files", attachBtn?.label === "Attach pictures or files" && attachBtn.first, attachBtn);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  const pastedText = await ev(`window.__files.paste([], "plain words")`);
  check("files: pasting text works as before (the browser's own paste is not stopped, no tray)", pastedText === false && !(await ev(`!!$(".app-main .pb-tray")`)));
  const withText = await ev(`window.__files.picture().then((f) => window.__files.paste([f], "Cells from a sheet"))`);
  check("files: a paste that holds text and a picture of it (cells from Excel, a passage from Word) pastes as text", withText === false && !(await ev(`!!$(".app-main .pb-tray")`)));
  const box0 = await ev(composerBox);
  const prevented = await ev(`window.__files.picture().then((f) => window.__files.paste([f]))`);
  const tray1 = await until(`$(".app-main .pb-tray") && ${chipsNow}`);
  const name1 = tray1?.[0]?.name ?? "";
  check("files: a pasted screenshot becomes a chip with a thumbnail, named Screenshot <date> <time>.png", prevented === true && tray1?.length === 1 && /^Screenshot \d{4}-\d\d-\d\d \d\d\.\d\d\.png$/.test(name1) && tray1[0].thumb, { prevented, tray1 });
  // The chat follows the bottom in the same frame, before it is painted; a moment later it is read.
  await sleep(120);
  check("files: a long name is shortened in the middle in the chip, so the time at its end stays in sight", tray1?.[0]?.shown === `${name1.slice(0, 14)}\u2026${name1.slice(-9)}`, tray1?.[0]);
  const box1 = await ev(composerBox);
  check("files: the first attachment grows the box once and the chat keeps its place at the bottom", box1 && box0 && box1.composer > box0.composer && box1.atBottom && box0.atBottom, { box0, box1 });
  // While it uploads: the tray, the chip and the line keep their height; the line says it uploads.
  await ev(watchStart(`() => { const t = document.querySelector(".app-main .pb-tray"); const c = t ? [...t.querySelectorAll(".pb-chip-file")].map((x) => Math.round(x.getBoundingClientRect().height * 10) / 10) : []; return { tray: t ? Math.round(t.getBoundingClientRect().height * 10) / 10 : 0, composer: Math.round(document.querySelector(".app-main .pb-composer").getBoundingClientRect().height * 10) / 10, chips: c }; }`));
  const uploadingLine = await ev(trayLineNow);
  const done1 = await until(`(${chipsNow})[0]?.status === "done"`, 4000);
  await sleep(250);
  w = await ev(watchStop);
  check("files: while the picture uploads the line says so, and the tray keeps its height through to the end", uploadingLine === "Uploading 1 file" && !!done1 && steady(w), { uploadingLine, w });
  check("files: an uploaded chip shows the file's size, the line is quiet again", (await ev(`(${chipsNow})[0].meta`))?.endsWith("KB") && (await ev(trayLineNow)) === "");

  // Pick two files with the add button (the real file input).
  const trayH = (await ev(composerBox)).tray;
  const input = await b.cmd("Runtime.evaluate", { expression: `document.querySelector(".app-main .pb-attach-input")` });
  await b.cmd("DOM.setFileInputFiles", { objectId: input.result.result.objectId, files: [join(fdir, "Team photo.png"), join(fdir, "Onboarding plan.pdf")] });
  const picked = await until(`(() => { const c = ${chipsNow}; return c.length === 3 && c.every((x) => x.status === "done") && c; })()`, 4000);
  check("files: picking with the add button adds each file as a chip (a picture with its thumbnail, a file with its sheet)", picked?.[1]?.name === "Team photo.png" && picked[1].thumb && picked[2]?.name === "Onboarding plan.pdf" && !picked[2].thumb, picked);
  check("files: more chips do not change the tray's height", (await ev(composerBox)).tray === trayH);

  // Drop on the chat: the outline and the line, nothing moves; the file joins the box.
  const tops = `() => ({ tops: [...document.querySelectorAll(".app-main .pb-thread > *")].map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10), scroll: document.querySelector(".app-main .pb-main-scroll").scrollTop, composer: Math.round(document.querySelector(".app-main .pb-composer").getBoundingClientRect().top * 10) / 10 })`;
  await ev(watchStart(tops));
  await ev(`window.__files.drag("dragenter", [window.__files.text("Ticket notes.txt")])`);
  await ev(`window.__files.drag("dragover", [window.__files.text("Ticket notes.txt")])`);
  const dropOn = await until(`$(".app-main")?.dataset.drop !== undefined && $(".app-main .pb-drop-note")?.textContent`);
  await sleep(200);
  w = await ev(watchStop);
  check("files: dragging files over the chat shows a calm outline and one line, and nothing in the chat moves", dropOn === "Drop here to attach" && steady(w), { dropOn, w });
  await aShot("drop-dark");
  await ev(`window.__files.drag("drop", [window.__files.text("Ticket notes.txt")])`);
  const dropped = await until(`(() => { const c = ${chipsNow}; return !$(".app-main .pb-drop") && c.length === 4 && c[3].name === "Ticket notes.txt" && c; })()`);
  check("files: a dropped file joins the box and the outline goes", !!dropped, dropped);
  const dragText = await ev(`(() => { const el = $(".app-main .pb-main-scroll"); const dt = new DataTransfer(); dt.setData("text/plain", "words"); el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); return $(".app-main").dataset.drop === undefined; })()`);
  check("files: dragging text over the chat is left alone", dragText === true);
  await until(`(${chipsNow}).every((c) => c.status === "done")`);
  await aShot("tray-dark", `$(".app-main .pb-composer")`);

  // Remove by keyboard: the focus goes on to the next chip; the engine's copy is thrown away.
  const d0 = await discards();
  await ev(`$$(".app-main .pb-chip-remove")[2].focus()`);
  await key("Enter");
  const afterRemove = await until(`(() => { const c = ${chipsNow}; return c.length === 3 && { names: c.map((x) => x.name), focus: document.activeElement?.getAttribute("aria-label") }; })()`);
  check("files: removing a chip by keyboard takes it out and hands the focus to the next chip", afterRemove?.names?.join("|") === `${name1}|Team photo.png|Ticket notes.txt` && afterRemove.focus === "Remove Ticket notes.txt", afterRemove);
  check("files: a removed upload is thrown away on the engine too", !!(await until(`(window.pobotsMock.requests()["attachment.discard"] ?? 0) === ${d0 + 1}`)));

  // Too big, any kind (step 7c), failed and tried again.
  const u0 = await uploads();
  await ev(`window.__files.paste([window.__files.big("Huge scan.png")])`);
  const big = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "Huge scan.png"); return c && { ...c, line: ${trayLineNow} }; })()`);
  check("files: a file over 100 MB is shown as too big, with the words, and is not sent", big?.status === "refused" && big.meta === "Too big" && bare(big.line) === "Huge scan.png is too big. A file can be up to 100 MB." && (await uploads()) === u0, big);
  await ev(`window.__files.drag("drop", [window.__files.big("Huge video.mp4")])`);
  await until(`(${chipsNow}).find((x) => x.name === "Huge video.mp4")?.status === "refused"`, 4000);
  // Two refused at once: the line explains the first and counts the other; each chip holds its own reason.
  const bigWords = "Huge scan.png is too big. A file can be up to 100 MB.";
  const videoWords = "Huge video.mp4 is too big. A file can be up to 100 MB.";
  const refusedChip = (n) => `$$(".app-main .pb-chip-file[data-chip]").find((c) => c.querySelector(".pb-chip-name").dataset.name === ${JSON.stringify(n)})`;
  const twoRefused = await ev(`(() => { const one = (n) => { const c = ${refusedChip("__N__")}; return c && { role: c.getAttribute("role"), label: c.getAttribute("aria-label"), title: c.getAttribute("title") }; }; return { line: ${trayLineNow}, big: one("Huge scan.png"), video: one("Huge video.mp4") }; })()`.replace(/"__N__"/g, "n"));
  check("files: two refused at once: the line gives the first one's reason and ends with how many more", bare(twoRefused?.line) === "Huge scan.png is too big. A file can be up to 100 MB, and 1 more can't be attached.", twoRefused);
  check("files: each refused chip's own name and tooltip hold its full reason",
    twoRefused?.big?.role === "group" && twoRefused.big.label === bigWords && twoRefused.big.title === bigWords && twoRefused.video?.role === "group" && twoRefused.video.label === videoWords && twoRefused.video.title === videoWords, twoRefused);
  const trayBefore = await ev(composerBox);
  const videoAt = await centerOf(refusedChip("Huge video.mp4"));
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: videoAt.x, y: videoAt.y });
  const hoverLine = await until(`(() => { const l = ${trayLineNow}; return l && l.includes("Huge video.mp4") && l; })()`, 1500);
  check("files: with the pointer on the other refused chip, the line gives that one's reason", bare(hoverLine) === "Huge video.mp4 is too big. A file can be up to 100 MB, and 1 more can't be attached.", hoverLine);
  const chatAt = await centerOf(`$(".app-main .pb-main-scroll")`);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: chatAt.x, y: chatAt.y });
  const leftLine = await until(`(() => { const l = ${trayLineNow}; return l && l.includes("Huge scan.png") && l; })()`, 1500);
  await ev(`(${refusedChip("Huge video.mp4")}).querySelector(".pb-chip-remove").focus()`);
  const focusLine = await until(`(() => { const l = ${trayLineNow}; return l && l.includes("Huge video.mp4") && l; })()`, 1500);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  const trayAfter = await ev(composerBox);
  check("files: with the focus on a refused chip the line gives its reason, and the first one's again when both go; the tray keeps its height",
    !!leftLine && bare(focusLine) === "Huge video.mp4 is too big. A file can be up to 100 MB, and 1 more can't be attached." && trayBefore?.tray === trayAfter?.tray && trayBefore.composer === trayAfter.composer, { leftLine, focusLine, trayBefore, trayAfter });
  await aShot("tray-refused-dark", `$(".app-main .pb-composer")`);
  await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove Huge scan.png"]'))`);
  const video = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "Huge video.mp4"); const l = ${trayLineNow}; return c?.status === "refused" && !(${chipsNow}).some((x) => x.name === "Huge scan.png") && { ...c, line: l }; })()`, 4000);
  check("files: with the first gone, the line gives the other one's reason alone", bare(video?.line) === videoWords && (await uploads()) === u0, video);
  await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove Huge video.mp4"]'))`);
  // Step 7c: any kind of file is attached. An archive, a file of a kind nobody knows: both go up and are done.
  await ev(`window.__files.drag("drop", [new File(["PK"], "Old files.zip", { type: "application/zip" })])`);
  const zipEarly = await ev(`(${chipsNow}).find((x) => x.name === "Old files.zip")?.status`);
  const zip = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "Old files.zip"); return c && c.status !== "uploading" && { ...c, line: ${trayLineNow} }; })()`, 4000);
  check("files: an archive goes up and is attached, with its size (step 7c)", zipEarly === "uploading" && zip?.status === "done" && /\d/.test(zip.meta ?? "") && (await uploads()) === u0 + 1, { zipEarly, zip });
  // Windows calls a TypeScript file "video/mp2t": the page once refused it by that word; the engine reads it as text.
  await ev(`window.__files.drag("drop", [new File(["export const a = 1;\\n"], "main.ts", { type: "video/mp2t" })])`);
  const ts = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "main.ts"); return c && c.status !== "uploading" && c; })()`, 4000);
  check("files: a file the browser calls video but the engine reads (main.ts as video/mp2t) is attached", ts?.status === "done", ts);
  await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove main.ts"]'))`);
  await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove Old files.zip"]'))`);
  await ev(`window.__files.drag("drop", [new File(["??"], "Data.xyz")])`);
  const xyz = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "Data.xyz"); return c && c.status !== "uploading" && { ...c, line: ${trayLineNow} }; })()`);
  check("files: a kind nobody knows (Data.xyz) is attached too (step 7c)", xyz?.status === "done", xyz);
  for (const n of ["Data.xyz"]) await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove ${n}"]'))`);
  const input2 = await b.cmd("Runtime.evaluate", { expression: `document.querySelector(".app-main .pb-attach-input")` });
  await b.cmd("DOM.setFileInputFiles", { objectId: input2.result.result.objectId, files: [join(fdir, "fail-report.pdf")] });
  const failed = await until(`(() => { const c = (${chipsNow}).find((x) => x.name === "fail-report.pdf"); return c?.status === "failed" && { ...c, line: ${trayLineNow} }; })()`, 4000);
  check("files: a failed upload says so with the words and offers Try again", failed?.retry && bare(failed.line) === "fail-report.pdf didn't upload. Try again.", failed);
  const inView = await ev(`(() => { const row = $(".app-main .pb-tray-chips").getBoundingClientRect(); const c = [...$$(".app-main .pb-chip-file[data-chip]")].pop().getBoundingClientRect(); return c.left >= row.left - 0.5 && c.right <= row.right + 0.5; })()`);
  check("files: a chip just added at the end of a full row is brought into sight", inView === true, inView);
  await aShot("tray-failed-dark", `$(".app-main .pb-composer")`);
  const sentBefore = await ev(`${userItems}.length`);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await type("Here is the ticket");
  await key("Enter");
  await sleep(400);
  const kept = await ev(`({ sent: ${userItems}.length, text: $(".app-main .pb-composer textarea").value, chips: (${chipsNow}).length })`);
  check("files: Send with a failed upload keeps the message and every attachment", kept?.sent === sentBefore && kept.text === "Here is the ticket" && kept.chips === 4, kept);
  await ev(`click($(".app-main .pb-chip-retry"))`);
  const retried = await until(`(${chipsNow}).find((x) => x.name === "fail-report.pdf")?.status === "done"`, 4000);
  check("files: Try again uploads it, and the line is quiet again", !!retried && bare(await ev(trayLineNow)) === "");

  // Send: the message with its pictures and files; the box is empty again.
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await key("Enter");
  const sent = await until(`(() => { const items = ${userItems}; const last = items[items.length - 1]; return last && last.text === "Here is the ticket" && { names: (last.attachments ?? []).map((a) => a.name), tray: !!$(".app-main .pb-tray"), text: $(".app-main .pb-composer textarea").value }; })()`);
  check("files: Send carries the text and the four attachments in their order, and empties the box", sent?.names?.join("|") === `${name1}|Team photo.png|Ticket notes.txt|fail-report.pdf` && !sent.tray && sent.text === "", sent);
  const shown = await until(`(() => { const m = $$(".app-main .app-you").pop(); return m && { pictures: m.querySelectorAll(".pb-picture").length, files: m.querySelectorAll(".pb-msg-file").length, text: m.querySelector(".pb-msg-you")?.textContent }; })()`);
  check("files: the sent message shows two pictures and two files above its text", shown?.pictures === 2 && shown.files === 2 && shown.text === "Here is the ticket", shown);
  await until(`$(".app-main .pb-composer textarea") && ${botOf("hubspot-tickets")}.state === "done"`, 8000);

  // Too many: ten at most.
  await ev(`window.__files.paste(Array.from({ length: 11 }, (_, i) => window.__files.text("Note " + (i + 1) + ".txt")))`);
  const many = await until(`(() => { const c = ${chipsNow}; return c.length === 10 && { n: c.length, line: ${trayLineNow} }; })()`);
  check("files: an eleventh file is not added and the box says why", many?.n === 10 && bare(many.line) === "You can attach up to 10 files to one message.", many);
  await until(`(${chipsNow}).every((c) => c.status === "done")`, 4000);
  const tenWide = await ev(`(() => { const r = $(".app-main .pb-tray-chips"); return { scrolls: r.scrollWidth > r.clientWidth, page: document.scrollingElement.scrollWidth - innerWidth, main: $(".app-main").scrollWidth - $(".app-main").clientWidth, h: Math.round(r.getBoundingClientRect().height) }; })()`);
  check("files: ten chips scroll sideways inside the tray at its one height; the page does not", tenWide?.scrolls && tenWide.page <= 0 && tenWide.main <= 1 && tenWide.h === 60, tenWide);
  // How many: with more chips than the row shows, the line says the count; an upload's words keep the
  // line with the count before them; the row's edge fades where more chips are; nothing changes height.
  const trayHeights = `() => { const t = document.querySelector(".app-main .pb-tray"); return { tray: t ? Math.round(t.getBoundingClientRect().height * 10) / 10 : 0, chips: t ? Math.round(t.querySelector(".pb-tray-chips").getBoundingClientRect().height * 10) / 10 : 0, composer: Math.round(document.querySelector(".app-main .pb-composer").getBoundingClientRect().height * 10) / 10 }; }`;
  await ev(watchStart(trayHeights));
  for (const n of ["Note 9.txt", "Note 10.txt"]) await ev(`click($('.app-main .pb-chip-remove[aria-label="Remove ${n}"]'))`);
  await until(`(${chipsNow}).length === 8`);
  await ev(`window.__files.paste([window.__files.text("Note 11.txt"), window.__files.text("Note 12.txt")])`);
  const countUploading = await until(`(() => { const l = ${trayLineNow}; return (${chipsNow}).length === 10 && l?.includes("Uploading") && l; })()`, 1500);
  check("files: with more attached than the row shows, an upload keeps the line with the count before it: 10 attached. Uploading 2 files.", countUploading === "10 attached. Uploading 2 files.", countUploading);
  const countDone = await until(`(() => { const l = ${trayLineNow}; const r = $(".app-main .pb-tray-chips"); return (${chipsNow}).every((c) => c.status === "done") && { line: l, start: r.dataset.moreStart !== undefined, end: r.dataset.moreEnd !== undefined, mask: getComputedStyle(r).maskImage }; })()`, 4000);
  check("files: with nothing more urgent, the line says how many are attached: 10 attached", countDone?.line === "10 attached", countDone);
  await ev(`$(".app-main .pb-tray-chips").scrollLeft = 0`);
  const atStart = await until(`(() => { const r = $(".app-main .pb-tray-chips"); return r.dataset.moreEnd !== undefined && { start: r.dataset.moreStart !== undefined, end: true, mask: getComputedStyle(r).maskImage }; })()`, 1500);
  await sleep(150);
  w = await ev(watchStop);
  check("files: the row's edge fades softly where more chips are (at the end, scrolled to the end at the start), and nothing changes height",
    countDone?.start === true && countDone.end === false && /gradient/.test(countDone.mask) && atStart?.start === false && atStart.end === true && /gradient/.test(atStart.mask) && steady(w), { countDone, atStart, w });
  await aShot("tray-count-dark", `$(".app-main .pb-composer")`);
  await removeAll();

  // A send whose answer is lost. Not stored (the connection was down): the text comes back with the
  // chip, and the error says so. Stored but the answer lost (the socket dropped on the way back, or
  // no answer in time): once the chat is read again the message is there, and the box empties quietly.
  const errLine = `($(".app-main .app-line-error")?.textContent ?? null)`;
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await ev(`window.__files.paste([window.__files.text("Lost answer.txt")])`);
  await until(`(${chipsNow}).length === 1 && (${chipsNow})[0].status === "done"`, 4000);
  await type("Did this go");
  const lostBefore = await ev(`${userItems}.length`);
  await ev(`window.pobotsMock.dropConnection()`);
  await key("Enter");
  await sleep(500);
  await ev(`window.pobotsMock.restoreConnection()`);
  const notStored = await until(`(() => { const c = ${chipsNow}; const e = ${errLine}; return e && { text: $(".app-main .pb-composer textarea").value, chips: c.map((x) => x.status), err: e, sent: ${userItems}.length }; })()`, 6000);
  check("files: a send that never reached the engine gives the text back, keeps the chip and says why", notStored?.text === "Did this go" && notStored.chips.join() === "done" && notStored.err === "The engine is not reachable right now. Try again in a moment." && notStored.sent === lostBefore, notStored);
  await ev(`window.pobotsMock.loseSendReply("drop")`);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await key("Enter");
  await sleep(500);
  const midDrop = await ev(`({ text: $(".app-main .pb-composer textarea").value, chips: (${chipsNow}).length, err: ${errLine} })`);
  await ev(`window.pobotsMock.restoreConnection()`);
  const quietly = await until(`(() => { const items = ${userItems}; const last = items[items.length - 1]; return !$(".app-main .pb-tray") && last?.text === "Did this go" && { text: $(".app-main .pb-composer textarea").value, err: ${errLine}, n: items.filter((i) => i.text === "Did this go").length, names: (last.attachments ?? []).map((a) => a.name), waiting: window.pobotsMock.uploadsWaiting().length }; })()`, 6000);
  check("files: stored but the socket dropped before the answer: while it is down the box waits (no text given back, no error)", midDrop?.text === "" && midDrop.chips === 1 && midDrop.err === null, midDrop);
  check("files: once the chat is read again the message is there, and the box and tray are emptied quietly with no retry offered", quietly?.text === "" && quietly.err === null && quietly.n === 1 && quietly.names.join() === "Lost answer.txt" && quietly.waiting === 0, quietly);
  await ev(`window.__files.paste([window.__files.text("Slow answer.txt")])`);
  await until(`(${chipsNow}).length === 1 && (${chipsNow})[0].status === "done"`, 4000);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await type("Second note");
  await ev(`window.pobotsMock.loseSendReply("timeout")`);
  await key("Enter");
  const timedOut = await until(`(() => { const items = ${userItems}; const last = items[items.length - 1]; return !$(".app-main .pb-tray") && last?.text === "Second note" && { text: $(".app-main .pb-composer textarea").value, err: ${errLine} }; })()`, 6000);
  check("files: stored but no answer in time: the message is found and the box empties quietly", timedOut?.text === "" && timedOut.err === null, timedOut);
  await until(`${botOf("hubspot-tickets")}.state === "done"`, 15000);

  // Send while two upload: the line says the message waits for them.
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await ev(`Promise.all([window.__files.picture("image.png", 300, 200), window.__files.picture("image.png", 200, 300)]).then((f) => window.__files.paste(f))`);
  await until(`(${chipsNow}).length === 2`);
  await key("Enter");
  const waitingTwo = await until(`(() => { const l = ${trayLineNow}; return l?.includes("Sends") && l; })()`, 1500);
  const wentTwo = await until(`(() => { const items = ${userItems}; const last = items[items.length - 1]; return last?.attachments?.length === 2 && !$(".app-main .pb-tray"); })()`, 4000);
  check("files: with two uploading: Uploading 2 files. Sends when they are done.; then it goes by itself", waitingTwo === "Uploading 2 files. Sends when they are done." && !!wentTwo, { waitingTwo, wentTwo });
  await until(`${botOf("hubspot-tickets")}.state === "done"`, 15000);
  // A message of pictures alone, and the button while an upload runs.
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await ev(`window.__files.picture("image.png", 300, 300, "#2a9d8f").then((f) => window.__files.paste([f]))`);
  await until(`(${chipsNow}).length === 1`);
  const sendBox = `() => { const b = document.querySelector(".app-main .pb-send"); const r = b.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10 }; }`;
  await ev(watchStart(sendBox));
  await key("Enter");
  const waitingBtn = await ev(`(() => { const b = $(".app-main .pb-send"); return { waiting: b.dataset.waiting !== undefined, label: b.getAttribute("aria-label"), busy: b.getAttribute("aria-busy"), line: ${trayLineNow} }; })()`);
  const alone = await until(`(() => { const items = ${userItems}; const last = items[items.length - 1]; return last && last.text === "" && last.attachments?.length === 1 && !$(".app-main .pb-tray") && last; })()`, 4000);
  await sleep(200);
  w = await ev(watchStop);
  check("files: Send while the picture uploads waits on the button (same size, same place) and goes by itself when it is up", waitingBtn?.waiting && waitingBtn.label === "Sends when the upload is done" && !!alone && steady(w), { waitingBtn, w });
  check("files: while a send waits for the upload, the line says so: Uploading 1 file. Sends when it is done.", waitingBtn?.line === "Uploading 1 file. Sends when it is done.", waitingBtn);
  const noBubble = await until(`(() => { const m = $$(".app-main .app-you").pop(); return m && { pictures: m.querySelectorAll(".pb-picture").length, bubble: !!m.querySelector(".pb-msg-you") }; })()`);
  check("files: a message with a picture and no text shows the picture and no empty bubble", noBubble?.pictures === 1 && noBubble.bubble === false, noBubble);
  await aShot("sent-dark", `$$(".app-main .app-you").pop()`);

  // Keyboard and names: Tab from the text reaches the add button, then the model, then Send.
  await until(`${botOf("hubspot-tickets")}.state === "done"`, 8000);
  await ev(`window.__files.picture("image.png", 200, 120).then((f) => window.__files.paste([f]))`);
  await until(`(${chipsNow}).every((c) => c.status === "done") && (${chipsNow}).length === 1`);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  const order = [];
  for (let i = 0; i < 3; i++) {
    await key("Tab");
    order.push(await ev(`document.activeElement?.getAttribute("aria-label")?.split(":")[0] ?? document.activeElement?.tagName`));
  }
  check("files: Tab from the text reaches Attach, the model, then Send", order[0] === "Attach pictures or files" && order[1] === "Model" && order[2] === "Send", order);
  await ev(`$(".app-main .pb-composer textarea").focus()`);
  await key("Tab", 8);
  check("files: Shift+Tab from the text reaches the chip's remove button, named after the file", (await ev(`document.activeElement?.getAttribute("aria-label")`))?.startsWith("Remove Screenshot "));
  await houseRules("files: dark, 1280, with the tray and pictures");
  await focusRings("files: dark, 1280, the composer with a chip", 6);

  // ---------------- a reload keeps the pictures and files that were sent
  await open(`files=1&picturesFrom=${encodeURIComponent(picturesFrom)}`);
  await goTo("HubSpot tickets");
  const reloaded = await until(`(() => { const ms = $$(".app-main .app-you").filter((m) => m.querySelector(".pb-picture, .pb-msg-file")); const ticket = ms.filter((m) => m.querySelector(".pb-msg-you")?.textContent === "Here is the ticket").pop(); const last = [ticket, ms[ms.length - 1]]; return !!ticket && ms.length >= 2 && { a: [...last[0].querySelectorAll(".pb-picture img, .pb-msg-file .pb-chip-name")].map((x) => x.alt || x.textContent), b: [...last[1].querySelectorAll(".pb-picture img")].map((x) => x.alt), text: last[0].querySelector(".pb-msg-you")?.textContent }; })()`, 6000);
  check("files: after a reload the sent messages show their pictures and files again", reloaded?.text === "Here is the ticket" && reloaded.a.join("|") === `${name1}|Team photo.png|Ticket notes.txt|fail-report.pdf` && reloaded.b.length === 1, reloaded);
  const reloadBoxes = await ev(`$$(".app-main .app-you").filter((m) => m.querySelector(".pb-picture")).pop().querySelector(".pb-picture").getBoundingClientRect().width`);
  check("files: after a reload a picture's box is again its final size (300 x 300 drawn at 300)", reloadBoxes === 300, reloadBoxes);

  // ---------------- light and dark, 1280 and 800 px
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 800]) {
      if (theme === "dark" && width === 1280) continue;
      const T = (n) => `files: ${theme}, ${width} px: ${n}`;
      hold();
      await open(`files=fresh&picturesFrom=${encodeURIComponent(picturesFrom)}`, { width, theme });
      await goTo("HubSpot tickets");
      await until(`$$(".app-main .pb-picture").length >= 2`);
      await sleep(300);
      const pre = await ev(`$$(".app-main .pb-picture").map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; })`);
      const ratioOk = Array.isArray(pre) && pre.length === 2 && Math.abs(pre[0][0] / pre[0][1] - 16 / 9) < 0.02 && Math.abs(pre[1][0] / pre[1][1] - 9 / 16) < 0.02 && pre[0][0] <= 320 && pre[1][1] <= 320;
      await ev(watchStart(threadTops));
      release();
      const ld = await until(`$$(".app-main .pb-picture").every((p) => p.querySelector("img").naturalWidth > 0)`, 6000);
      await sleep(400);
      w = await ev(watchStop);
      check(T("the pictures keep their boxes (in their own proportions) and nothing moves when they arrive"), !!ld && ratioOk && steady(w), { ld, pre, w });
      await ev(`$(".app-main .pb-composer textarea").focus()`);
      await ev(`window.__files.picture().then((f) => window.__files.paste([f]))`);
      await ev(`window.__files.paste([window.__files.text("A rather long name for a meeting notes file.txt"), window.__files.big("Huge scan.png")])`);
      await until(`(${chipsNow}).filter((c) => c.status === "done").length === 2`, 4000);
      await houseRules(T("the tray and the pictures"));
      await aShot(`tray-${theme}-${width}`, `$(".app-main .pb-composer")`);
      await aShot(`chat-${theme}-${width}`);
      await ev(`click($$(".app-main .pb-picture")[0])`);
      await until(`$(".pb-picture-view [data-full]")`, 4000);
      await houseRules(T("the large view"));
      await aShot(`large-${theme}-${width}`);
      await key("Escape");
    }
  }
  // ---------------- a chat at its newest message stays there when a file is attached (release 0.14, fix d)
  // The live 0.12.0 sometimes left the last 92 px of the chat (the tray's height) hidden under the
  // tray. The cause was one of timing: the scroll event for a place the chat had put itself in
  // arrives a frame later; when the tray had grown in between, the chat stood the tray's height above
  // the bottom for that moment and was taken for scrolled up, so the resize no longer brought it
  // down. The check acts that order out: a scroll event that moved nothing, right after the tray
  // came, before the browser reports the new size.
  for (const width of [1280, 1024]) {
    release();
    await open("files=fresh", { width, height: width === 1280 ? 820 : 768 });
    await goTo("HubSpot tickets");
    const sc = `$(".app-main .pb-main-scroll")`;
    await until(`${sc} && ${sc}.scrollHeight > ${sc}.clientHeight + 200`);
    await sleep(400);
    const gapNow = `(() => { const s = ${sc}; return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); })()`;
    const gap0 = await ev(gapNow);
    await ev(`(() => { const s = ${sc}; window.__late = 0; const mo = new MutationObserver(() => { if (!$(".app-main .pb-tray")) return; mo.disconnect(); s.dispatchEvent(new Event("scroll")); window.__late++; }); mo.observe($(".app-main"), { subtree: true, childList: true }); return true; })()`);
    await ev(`$(".app-main .pb-composer textarea").focus()`);
    await ev(`window.__files.picture().then((f) => window.__files.paste([f]))`);
    await until(`(${chipsNow}).filter((c) => c.status === "done").length === 1`, 4000);
    await sleep(300);
    const pinnedAfter = await ev(`({ gap: ${gapNow}, tray: Math.round($(".app-main .pb-tray")?.getBoundingClientRect().height ?? 0), late: window.__late })`);
    check(`files, ${width}: a chat at its newest message stays there when a file is attached, also when a scroll event that moved nothing comes before the new size`, gap0 === 0 && pinnedAfter?.late === 1 && pinnedAfter.tray > 0 && pinnedAfter.gap === 0, { gap0, pinnedAfter });
    // And a real scroll up still lets go of the bottom: a file attached then leaves the chat where he reads.
    await removeAll();
    await ev(`(() => { const s = ${sc}; s.scrollTop = s.scrollTop - 300; return true; })()`);
    await sleep(200);
    const readingAt = await ev(`${sc}.scrollTop`);
    await ev(`window.__files.picture().then((f) => window.__files.paste([f]))`);
    await until(`(${chipsNow}).filter((c) => c.status === "done").length === 1`, 4000);
    await sleep(300);
    const readingAfter = await ev(`${sc}.scrollTop`);
    check(`files, ${width}: a chat scrolled up stays where he reads when a file is attached`, readingAt > 0 && readingAfter === readingAt, { readingAt, readingAfter });
    await removeAll();
  }

  server.close();
  if (filesShots) console.log(`Pictures and files pictures in ${filesShots}`);
  }
}
