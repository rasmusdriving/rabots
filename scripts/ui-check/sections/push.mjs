// The window check, section "push". Run it alone: node scripts/ui-check.mjs --only=push
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ notifications when the page is not open (job 4)
// docs/build/step-push.md, "App builder", and the groundwork's section 9. The page is a file page
// with the mock, where no service worker can run, so the browser's side is a stand-in (pushStandIn
// below), added before every page loads and switched on only by `standin=` in the address:
// Notification, PushManager and navigator.serviceWorker, with a registration whose subscribe and
// getSubscription give a made-up subscription. Nothing reaches a push service, and no real browser
// is ever asked for the notification permission. The service worker itself (dist/ui/sw.js) is run
// in Node with a stand-in for its world.
export default async function section() {
  pushStep: {
  const pushShots = arg("push-shots") ?? (shots ? join(shots, "push") : undefined);
  if (pushShots) mkdirSync(pushShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it, or of the whole window. */
  async function nShot(name, selector) {
    if (!pushShots) return;
    await sleep(450);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      if (r && !r.error) clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(pushShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }

  /**
   * The stand-in for the browser's notifications, run in the page before its own scripts. Only with
   * `standin=<json>` in the address; the json says how the browser stands (see `cfg`). It writes what
   * the page did to window.__pushStandIn: subscribe calls (and whether each came straight from a
   * press), registrations, closed notifications, unsubscribes; and lets the check answer the
   * browser's question, deliver a message from the service worker and fire the 60 s heartbeat.
   */
  function pushStandIn() {
    const raw = new URLSearchParams(location.search).get("standin");
    if (raw === null) return;
    const cfg = Object.assign(
      { permission: "default", answer: "granted", answerMs: 150, sub: false, key: null, endpoint: "https://fcm.googleapis.com/fcm/send/check-1", secure: true, standalone: false, push: true, sw: true, notification: true, subscribeFails: false, unsubscribeFails: false, same: false, notes: [], early: null },
      JSON.parse(raw),
    );
    const st = { cfg, calls: [], registered: [], startMessages: 0, closed: [], notes: [], unsubscribed: 0, listeners: [], queued: [], inClick: false, intervals: [], permissionAsked: 0, answer: null };
    window.__pushStandIn = st;
    window.__pobotsPushStandIn = true;
    // Whether a call happens inside a press: set before the page's own handlers, cleared after them.
    addEventListener("click", () => { st.inClick = true; }, true);
    addEventListener("click", () => { st.inClick = false; }, false);
    const si = window.setInterval;
    window.setInterval = function (fn, ms, ...rest) {
      if (ms === 60000) st.intervals.push(fn);
      return si.call(window, fn, ms, ...rest);
    };
    st.beat = () => { for (const f of st.intervals) f(); return st.intervals.length; };
    Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => cfg.secure !== false });
    if (cfg.standalone) {
      Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } : mm(q));
    }
    let permission = cfg.permission;
    st.setPermission = (p) => { permission = p; return true; };
    if (cfg.notification) window.Notification = class Notification { static get permission() { return permission; } static requestPermission() { st.permissionAsked++; return Promise.resolve(permission); } };
    else delete window.Notification;
    if (cfg.push) window.PushManager = function PushManager() {};
    else delete window.PushManager;
    const toBytes = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const toText = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    let made = 0;
    let current = null;
    const makeSub = (endpoint, keyBuf) => {
      const sub = {
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: keyBuf },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BCheckPageKeyNotReal", auth: "CheckAuthNotReal" } }),
        getKey: () => null,
        // `unsubscribeFails`: the browser could not drop it (answers false, keeps it).
        unsubscribe: () => { st.unsubscribed++; if (cfg.unsubscribeFails) return Promise.resolve(false); if (current === sub) current = null; return Promise.resolve(true); },
      };
      return sub;
    };
    if (cfg.sub) {
      current = makeSub(cfg.endpoint, cfg.key ? toBytes(cfg.key).buffer : null);
      made = 1;
    }
    // Another tab of this browser dropped the subscription, or made one: the browser's own state changes under this tab.
    st.drop = () => { current = null; return true; };
    st.setSub = (endpoint) => { current = makeSub(endpoint, cfg.key ? toBytes(cfg.key).buffer : null); return true; };
    const subscribe = (opts) => {
      const key = new Uint8Array(opts.applicationServerKey.buffer ?? opts.applicationServerKey, opts.applicationServerKey.byteOffset ?? 0, opts.applicationServerKey.byteLength);
      st.calls.push({ inClick: st.inClick, permission, key: toText(key), userVisibleOnly: opts.userVisibleOnly });
      const finish = () => {
        if (permission !== "granted") return Promise.reject(new DOMException("Registration failed - permission denied", "NotAllowedError"));
        if (cfg.subscribeFails) return Promise.reject(new DOMException("Registration failed - push service error", "AbortError"));
        if (current) return Promise.resolve(current);
        // `same`: the browser hands back the same address after an unsubscribe.
        const endpoint = made === 0 || cfg.same ? cfg.endpoint : `${cfg.endpoint}-${made}`;
        made++;
        current = makeSub(endpoint, key.slice().buffer);
        return Promise.resolve(current);
      };
      if (permission !== "default") return finish();
      // The browser asks only from a press (an iPhone insists): not from a press, no question at all.
      if (!st.inClick) return Promise.reject(new DOMException("Only from a press", "NotAllowedError"));
      return new Promise((resolve, reject) => {
        st.answer = (a) => { st.answer = null; permission = a; finish().then(resolve, reject); return true; };
        if (cfg.answer !== "hold") setTimeout(() => st.answer?.(cfg.answer), cfg.answerMs);
      });
    };
    const registration = {
      scope: location.href,
      active: { state: "activated" },
      pushManager: { subscribe, getSubscription: () => { st.reads = (st.reads ?? 0) + 1; return Promise.resolve(current); }, permissionState: () => Promise.resolve(permission === "default" ? "prompt" : permission) },
      getNotifications: () => Promise.resolve(st.notes.filter((n) => !n.closed)),
      showNotification: () => Promise.resolve(),
      update: () => Promise.resolve(),
      unregister: () => Promise.resolve(true),
    };
    st.setNotes = (tags) => {
      st.notes = tags.map((tag) => ({ tag, title: tag, data: {}, closed: false, close() { if (!this.closed) { this.closed = true; st.closed.push(this.tag); } } }));
      return true;
    };
    st.setNotes(cfg.notes);
    let started = false;
    st.message = (data) => {
      if (!started) { st.queued.push(data); return 0; }
      for (const fn of st.listeners) fn(new MessageEvent("message", { data }));
      return st.listeners.length;
    };
    const container = {
      controller: null,
      ready: Promise.resolve(registration),
      register: (url, opts) => { st.registered.push({ url, scope: opts?.scope, updateViaCache: opts?.updateViaCache }); return new Promise((r) => setTimeout(() => r(registration), 30)); },
      getRegistration: () => Promise.resolve(registration),
      addEventListener: (type, fn) => { if (type === "message") st.listeners.push(fn); },
      removeEventListener: () => {},
      startMessages: () => {
        st.startMessages++;
        started = true;
        // A click on a notification that came while the page was still starting.
        if (cfg.early) st.queued.push(cfg.early);
        const q = st.queued;
        st.queued = [];
        for (const d of q) st.message(d);
      },
    };
    if (cfg.sw) Object.defineProperty(navigator, "serviceWorker", { configurable: true, get: () => container });
    else delete Navigator.prototype.serviceWorker;
  }
  await b.cmd("Page.enable");
  const standIn = await b.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(${pushStandIn.toString()})();` });

  const { createHash } = await import("node:crypto");
  const vm = await import("node:vm");
  /** The engine's device id for an address: SHA-256, base64url, the first 22 characters. */
  const idOf = (endpoint) => createHash("sha256").update(endpoint).digest("base64url").slice(0, 22);
  /** The mock engine's public key (ui/engine/mock-notify.ts), and another one nobody uses. */
  const ENGINE_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37 + 11) % 256))).toString("base64url");
  const OTHER_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 53 + 7) % 256))).toString("base64url");
  /** The addresses of the mock's two devices (made up; never called). */
  const LAPTOP = "https://wns2-db5p.notify.windows.com/w/?token=mock-laptop";
  const IPHONE = "https://web.push.apple.com/mock-iphone";
  const CHECK = "https://fcm.googleapis.com/fcm/send/check-1";
  // The words, read straight from the source.
  const words = await import(pathToFileURL(join(root, "ui/lib/notify.ts")).href);
  const LINE = words.HERE_LINE;

  let pushOpens = 0;
  const forgetDevice = () => ev(`(() => { localStorage.removeItem("pobots.notify.device"); return true; })()`);
  /** Opens the mock with the stand-in as `cfg` says (none: no stand-in, the mock in a plain browser). */
  const openN = async (cfg, query = "", opts = {}) => {
    const q = [cfg ? `standin=${encodeURIComponent(JSON.stringify(cfg))}` : "", query, `n=${++pushOpens}`].filter(Boolean).join("&");
    return open(q, opts);
  };
  const SETTINGS = ".app-appsettings";
  const openSettings = async () => {
    await ev(`click($$(".pb-foot-settings").find((x) => x.checkVisibility({ visibilityProperty: true })))`);
    const ok = await until(`!!$(".pb-notify") && !!$(".pb-backup")`);
    await sleep(350);
    return ok;
  };
  /** What the Notifications section shows, in words. */
  const nWords = `(() => { const s = $(".pb-notify"); if (!s) return null; const shown = (el) => (el ? (el.querySelector(".pb-swap-line[data-show]")?.textContent ?? "") : null); const p = $(".pb-notify-primary"); return {
      here: s.dataset.here, line: shown($(".pb-notify-line")), mark: ($(".pb-notify-line > .pb-mark")?.className ?? "").replace("pb-mark ", ""),
      primary: p ? shown(p) : null, primaryOff: p?.getAttribute("aria-disabled") === "true", off: $(".pb-notify-off")?.textContent ?? null, how: $(".pb-notify-how")?.getAttribute("aria-expanded") ?? null,
      note: shown($(".pb-notify-note")), noteError: !!$(".pb-notify-note .pb-swap-line[data-show].app-hint-error"), noteAlert: $(".pb-notify-note")?.getAttribute("role") === "alert",
      ios: $$(".pb-notify-ios li").map((li) => li.textContent), allow: $$(".pb-notify-allow li").map((li) => li.textContent), act: !!$(".pb-notify-act"),
      kinds: $$(".pb-notify-kind input").map((i) => i.dataset.kind + ":" + i.checked),
      devices: $$(".pb-notify-device").map((d) => d.querySelector(".pb-notify-device-label").textContent + (d.querySelector(".pb-notify-device-here") ? " [here]" : "") + " | " + d.querySelector(".pb-notify-device-line").textContent),
    }; })()`;
  const standin = (expr) => ev(`window.__pushStandIn ? (${expr}) : null`);
  /** Every box above "Your devices" that must never move when "This device" changes, and Backup's top. */
  const ABOVE = [".pb-appsettings-head", ".pb-notify > .pb-section-title", ".pb-notify > .pb-section-text", ".pb-notify-line", ".pb-notify-line > .pb-mark", ".pb-notify-act", ".pb-notify-note", ".pb-notify-kinds-part", "#notify-devices"];
  /** Watches boxes every frame and on every change of the page: `sels` and the first `rows` device rows. */
  const watchN = (sels, rows = 0) =>
    ev(`(() => { const sels = ${JSON.stringify(sels)}; const rows = ${rows}; const R = (x) => Math.round(x * 10) / 10;
      const L = () => sels.map((s) => document.querySelector(s)).concat([...document.querySelectorAll(".pb-notify-device")].slice(0, rows)).map((e) => { if (!e) return "none"; const b = e.getBoundingClientRect(); return [b.top, b.left, b.height, b.width].map(R).join(" "); }).join(",");
      const id = Math.random(); const samples = [L()]; window.__nw = samples; window.__nwId = id; window.__nwObs?.disconnect(); window.__nwObs = new MutationObserver(() => samples.push(L())); window.__nwObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => { if (window.__nwId !== id) return; samples.push(L()); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  const stopN = () => ev(`(() => { window.__nwId = null; window.__nwObs.disconnect(); const a = window.__nw; return { samples: a.length, first: a[0], bad: [...new Set(a.filter((x) => x !== a[0]))].slice(0, 2) }; })()`);
  const stillN = (w) => !!w && w.samples > 1 && w.bad.length === 0;
  /** Every status line shown from now on, in order (a state that lasts one frame is caught too). */
  const watchLines = () => ev(`(() => { const seen = (window.__nl = []); const read = () => { const t = $(".pb-notify-line .pb-swap-line[data-show]")?.textContent ?? ""; if (seen.at(-1) !== t) seen.push(t); }; read(); window.__nlObs?.disconnect(); window.__nlObs = new MutationObserver(read); window.__nlObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); return true; })()`);
  const stopLines = () => ev(`(() => { window.__nlObs.disconnect(); return window.__nl; })()`);
  const dayNow = () => ev(`(() => { const d = new Date(); return d.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]; })()`);
  const presence = () => ev(`window.pobotsMock.notifyPresence()`);

  await forgetDevice();

  // ---------------- the service worker, run in Node with a stand-in for its world
  const swText = readFileSync(join(root, "dist", "ui", "sw.js"), "utf8");
  check("push: sw.js has no handler for the page's requests, stores nothing and preloads nothing", !/addEventListener\(\s*["'`]fetch["'`]/.test(swText) && !/\bonfetch\b/.test(swText) && !/\bcaches\b/.test(swText) && !/navigationPreload/.test(swText) && !/importScripts/.test(swText));
  check("push: sw.js shows pushes, opens on a click and renews its subscription, nothing else", ["push", "notificationclick", "pushsubscriptionchange", "install", "activate"].every((t) => swText.includes(`addEventListener("${t}"`)) && (swText.match(/addEventListener\(/g) ?? []).length === 5);
  const runSw = ({ clients = [] } = {}) => {
    const listeners = {};
    const out = { shown: [], opened: [], posted: [], focused: 0, fetched: [], subscribed: [] };
    const self = {
      location: new URL("https://pobots.example.com/"),
      registration: {
        showNotification: (title, options) => (out.shown.push({ title, ...options }), Promise.resolve()),
        pushManager: { subscribe: async (o) => (out.subscribed.push(o), { endpoint: "https://fcm.googleapis.com/fcm/send/renewed", toJSON: () => ({ endpoint: "x", keys: { p256dh: "p", auth: "a" } }) }) },
      },
      clients: { matchAll: async () => clients.map((c) => ({ ...c, focus: async function () { out.focused++; return this; }, postMessage: (m) => out.posted.push(m) })), openWindow: async (u) => (out.opened.push(u), null), claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (t, f) => (listeners[t] ??= []).push(f),
    };
    vm.runInNewContext(swText, { self, URL, URLSearchParams, JSON, Promise, fetch: async (u, init) => (out.fetched.push({ u, init, body: JSON.parse(init.body) }), { ok: true }) });
    out.fire = async (type, e = {}) => {
      let work = Promise.resolve();
      e.waitUntil = (p) => (work = p);
      for (const f of listeners[type] ?? []) f(e);
      await work;
    };
    return out;
  };
  const pushOf = (data) => ({ data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data), text: () => String(data) } });
  {
    const msg = { v: 1, kind: "needs", title: "Po needs your answer", body: "Open Pobots to answer.", tag: "pobots-po-needs", url: "/?bot=po&open=needs", botId: "po" };
    const sw = runSw();
    await sw.fire("push", pushOf(msg));
    const n = sw.shown[0];
    check("push: the service worker shows a push exactly as the engine made it: title, body, tag, where a click leads", n?.title === msg.title && n.body === msg.body && n.tag === msg.tag && n.data?.url === msg.url && n.data?.botId === "po" && n.icon === "/icon-192.png" && n.badge === "/badge-96.png", n);
    check("push: a newer push for the same bot and kind replaces the older one and is heard again (renotify with the tag)", n?.renotify === true);
    for (const [what, data] of [["a shape it does not know", { hello: 1 }], ["no data", undefined], ["data that is not JSON", "{not json"], ["an empty title", { ...msg, title: "" }], ["another version", { ...msg, v: 2 }]]) {
      const s = runSw();
      await s.fire("push", data === undefined ? { data: null } : pushOf(data));
      const x = s.shown[0];
      check(`push: ${what} is still shown, titled Pobots, never silently dropped`, s.shown.length === 1 && x.title === "Pobots" && x.body === "Open Pobots to see what is new." && x.data.url === (data && typeof data === "object" && data.url ? data.url : "/"), x);
    }
    const FOREIGN = ["https://other.example.com/", "//other.example.com/x", "/\\other.example.com", "\\\\other.example.com/x", "/\t/other.example.com/x", "/\n/other.example.com", "\t//other.example.com", "/.//other.example.com/x", "http://pobots.example.com/", "https://pobots.example.com.other.example.com/", "javascript:alert(1)", "data:text/html,x"];
    for (const url of FOREIGN) {
      const s = runSw();
      await s.fire("push", pushOf({ ...msg, url }));
      check(`push: a click can only lead to the page's own origin (${JSON.stringify(url)} becomes /)`, s.shown[0]?.data.url === "/", s.shown[0]?.data);
    }
    {
      const s = runSw();
      await s.fire("push", pushOf({ ...msg, url: "https://pobots.example.com/?bot=po&open=chat#x" }));
      check("push: an address on the page's own origin keeps only its path, query and fragment", s.shown[0]?.data.url === "/?bot=po&open=chat#x", s.shown[0]?.data);
    }
    // A click on a notification whose data says otherwise (one shown by an older worker): the same care.
    for (const url of FOREIGN) {
      const none = runSw({ clients: [] });
      await none.fire("notificationclick", { notification: { data: { url }, close() {} } });
      const open = runSw({ clients: [{ url: "https://pobots.example.com/", visibilityState: "visible", focused: true }] });
      await open.fire("notificationclick", { notification: { data: { url: `${url}?bot=po&open=needs` }, close() {} } });
      check(
        `push: a click whose address is not the page's own (${JSON.stringify(url)}) opens / and tells an open window nothing`,
        JSON.stringify(none.opened) === JSON.stringify(["/"]) && open.opened.length === 0 && open.posted.length === 0 && open.focused === 1,
        { opened: none.opened, posted: open.posted },
      );
    }
    const noTag = runSw();
    await noTag.fire("push", pushOf({ ...msg, tag: "" }));
    check("push: without a tag there is no renotify (a browser refuses renotify without one)", noTag.shown[0] && !("renotify" in noTag.shown[0]) && !("tag" in noTag.shown[0]), noTag.shown[0]);

    const note = (url) => ({ notification: { data: { url }, close() { this.closed = true; }, closed: false } });
    const win = runSw({ clients: [{ url: "https://pobots.example.com/", visibilityState: "hidden", focused: false }, { url: "https://pobots.example.com/?x=1", visibilityState: "visible", focused: false }] });
    const clicked = note("/?bot=po&open=needs");
    await win.fire("notificationclick", clicked);
    check("push: a click with a Pobots window open brings it to the front and tells it where to go, without loading it again", clicked.notification.closed && win.focused === 1 && win.opened.length === 0 && JSON.stringify(win.posted) === JSON.stringify([{ pobots: "open", bot: "po", open: "needs" }]), win);
    const chat = runSw({ clients: [{ url: "https://pobots.example.com/", visibilityState: "visible", focused: true }] });
    await chat.fire("notificationclick", note("/?bot=po&open=chat"));
    check("push: a click on a finished one asks the window for the bot's chat", JSON.stringify(chat.posted) === JSON.stringify([{ pobots: "open", bot: "po", open: "chat" }]), chat.posted);
    const sys = runSw({ clients: [{ url: "https://pobots.example.com/", visibilityState: "visible", focused: true }] });
    await sys.fire("notificationclick", note("/?open=needs"));
    check("push: a click on a note from Pobots itself asks for Needs you, with no bot", JSON.stringify(sys.posted) === JSON.stringify([{ pobots: "open", open: "needs" }]), sys.posted);
    const none = runSw({ clients: [{ url: "https://elsewhere.example.com/", visibilityState: "visible", focused: true }] });
    await none.fire("notificationclick", note("/?bot=po&open=needs"));
    check("push: a click with no Pobots window open opens one at the message's address", JSON.stringify(none.opened) === JSON.stringify(["/?bot=po&open=needs"]) && none.posted.length === 0, none);
    const test = runSw({ clients: [{ url: "https://pobots.example.com/", visibilityState: "visible", focused: true }] });
    await test.fire("notificationclick", note("/"));
    check("push: a click on the test brings the window to the front and asks nothing of it", test.focused === 1 && test.posted.length === 0 && test.opened.length === 0, test);

    const renew = runSw();
    const key = new Uint8Array([4, 1, 2, 3]).buffer;
    await renew.fire("pushsubscriptionchange", { oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: key } }, newSubscription: null });
    const sent = renew.fetched[0];
    check(
      "push: a renewed subscription is made with the same key and sent to /api/push/renew with the old address, and nothing else",
      renew.subscribed[0]?.applicationServerKey === key && renew.subscribed[0]?.userVisibleOnly === true && sent?.u === "/api/push/renew" && sent.init.method === "POST" && sent.init.credentials === "same-origin" && sent.body.old === "https://fcm.googleapis.com/fcm/send/old" && sent.body.subscription.endpoint === "https://fcm.googleapis.com/fcm/send/renewed" && Object.keys(sent.body.subscription).join(",") === "endpoint,keys" && Object.keys(sent.body).join(",") === "old,subscription",
      sent,
    );
  }

  // ---------------- the badge picture and the page's rule for workers
  {
    const png = readFileSync(join(root, "dist", "ui", "badge-96.png"));
    const ihdr = { w: png.readUInt32BE(16), h: png.readUInt32BE(20), depth: png[24], type: png[25] };
    check("push: the badge for Android is a 96 px picture with see-through parts (only its shape counts)", ihdr.w === 96 && ihdr.h === 96 && ihdr.type === 6, ihdr);
    const html = readFileSync(join(root, "dist", "ui", "index.html"), "utf8");
    check("push: the page's policy allows a worker from its own origin only", /worker-src 'self'[;"]/.test(html));
  }

  for (const theme of ["dark", "light"]) {
    const T = (name) => `${theme}: push: ${name}`;
    const first = theme === "dark";

    // ---------------- the mock in a plain browser: the section, first, above Backup
    await openN(null, "", { theme });
    await openSettings();
    let w = await ev(nWords);
    const order = await ev(`({ sections: $$(".pb-appsettings-section").map((s) => s.dataset.section), backupBelow: $('[data-section="backup"]').getBoundingClientRect().top >= $('[data-section="notify"]').getBoundingClientRect().bottom, intro: $(".pb-notify > .pb-section-text").textContent, title: $(".pb-notify > .pb-section-title").textContent })`);
    check(T("Notifications comes after About you in Pobots settings, Backup below it (When a bot is working between them)"), order?.sections?.join(",") === "about,notify,chat,backup" && order.backupBelow && order.title === "Notifications", order);
    check(T("the section says what it does and that a notification never says what the chat says"), order?.intro === words.INTRO, order?.intro);
    check(T("where the browser cannot (the mock in a plain browser): it says so, and offers nothing to press"), w?.here === "cannot" && w.line === LINE.cannot && !w.act, w);
    check(T("the three switches: needs and notes on, finished off"), w?.kinds?.join(",") === "needs:true,note:true,finished:false", w?.kinds);
    const kindWords = await ev(`$$(".pb-notify-kind").map((k) => k.querySelector(".pb-notify-kind-name").textContent + " | " + k.querySelector(".pb-hint").textContent).concat($(".pb-notify-kinds-note").textContent)`);
    check(T("the switches' words and hints, for all devices"), JSON.stringify(kindWords) === JSON.stringify([...words.KINDS.map((k) => `${k.label} | ${k.hint}`), "For all your devices."]), kindWords);
    const day1 = (iso) => { const d = new Date(iso); return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`; };
    const seeded = await ev(`window.pobotsMock.notifyState().devices`);
    check(
      T("Your devices: oldest first, each with its name and one line, none marked as this device"),
      w?.devices?.length === 2 && w.devices[0] === `Home screen app on iPhone | Added ${day1(seeded[0].addedAt)}. Last sent yesterday at 18:40.` && w.devices[1] === `Edge on Windows | Added ${day1(seeded[1].addedAt)}. Nothing sent yet.`,
      w?.devices,
    );
    const forgetLabels = await ev(`$$(".pb-notify-forget").map((x) => x.getAttribute("aria-label") + "|" + x.textContent)`);
    check(T("each device has a quiet Forget, read out with the device's name"), forgetLabels?.join(",") === "Forget Home screen app on iPhone|Forget,Forget Edge on Windows|Forget", forgetLabels);
    const leak = await ev(`(() => { const s = JSON.stringify(window.pobotsState()); return ["web.push.apple.com", "notify.windows.com", "mock-laptop", "mock-iphone", "p256dh", "auth\\":"].filter((x) => s.includes(x)); })()`);
    check(T("the window's state holds no device address or key"), Array.isArray(leak) && leak.length === 0, leak);
    const jargon = await ev(`$(".pb-notify").innerText.match(/VAPID|endpoint|subscription|service worker|\\bpush\\b|PWA|\\bAPI\\b/gi)`);
    check(T("no technical words in the section"), jargon === null, jargon);
    await houseRules(T("the section where the browser cannot"));
    await nShot(`1280-cannot-${theme}`);

    // ---------------- the switches: each saves itself at once, nothing moves
    await watchN([...ABOVE, ".pb-notify-kinds", '[data-section="backup"]'], 2);
    const setBefore = (await ev(`window.pobotsMock.requests()["notify.setKinds"] ?? 0`)) ?? 0;
    await ev(`click($('.pb-notify-kind input[data-kind="finished"]'))`);
    const saved = await until(`$('.pb-notify-kind input[data-kind="finished"]').checked && window.pobotsMock.notifyState().kinds.finished === true && !!$(".pb-notify-kinds-part .pb-saved[data-show]")`);
    check(T("switching Finished on saves it for all devices at once and says Saved"), !!saved && ((await ev(`window.pobotsMock.requests()["notify.setKinds"]`)) ?? 0) === setBefore + 1);
    await ev(`$('.pb-notify-kind input[data-kind="needs"]').focus()`);
    await b.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    check(T("Space switches a kind off from the keyboard"), !!(await until(`!$('.pb-notify-kind input[data-kind="needs"]').checked && window.pobotsMock.notifyState().kinds.needs === false`)));
    const ring = await ev(`(() => { const s = getComputedStyle(document.activeElement); return document.activeElement.dataset.kind === "needs" && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
    check(T("a switch reached by keyboard shows the focus ring"), ring === true, ring);
    await ev(`window.pobotsMock.dropConnection()`);
    await ev(`click($('.pb-notify-kind input[data-kind="note"]'))`);
    const failed = await until(`(() => { const p = $(".pb-notify-kinds-problem .pb-swap-line[data-show]")?.textContent; return p && $('.pb-notify-kind input[data-kind="note"]').checked ? { p, alert: $(".pb-notify-kinds-problem").getAttribute("role") } : null; })()`, 3000);
    check(T("a switch that cannot be saved goes back and says so in its own kept line"), failed?.p === "The engine is not reachable right now. Try again in a moment." && failed.alert === "alert", failed);
    await ev(`window.pobotsMock.restoreConnection()`);
    await sleep(300);
    w = await stopN();
    check(T("switching, a refusal and the line for it move nothing on the page"), stillN(w), w);

    // ---------------- devices: a new one at the bottom, Forget, the lines
    await openN(null, "", { theme });
    await openSettings();
    await watchN(ABOVE, 2);
    const added = await ev(`window.pobotsMock.notifyAddDevice("Firefox on Windows")`);
    await until(`$$(".pb-notify-device").length === 3`);
    await sleep(250);
    const wAdd = await stopN();
    const rows = await ev(nWords);
    check(T("a device turned on elsewhere comes at the bottom, and nothing above it moves"), stillN(wAdd) && rows?.devices?.[2]?.startsWith("Firefox on Windows | Added "), { wAdd, rows: rows?.devices });
    await ev(`window.pobotsMock.notifySent(${JSON.stringify(added)}, "needs", "refused", "BadJwtToken")`);
    const refusedRow = await until(`(() => { const r = $$(".pb-notify-device")[2]; return r?.hasAttribute("data-problem") ? { line: r.querySelector(".pb-notify-device-line").textContent, colour: getComputedStyle(r.querySelector(".pb-notify-device-line")).color } : null; })()`);
    const clay = await ev(`(() => { const p = document.createElement("div"); p.style.color = "var(--clay)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
    check(T("a refused send reads plainly on its row, in the problem colour"), /^Last try today at \d\d:\d\d was refused: BadJwtToken\.$/.test(refusedRow?.line ?? "") && refusedRow.colour === clay, { refusedRow, clay });
    await ev(`window.pobotsMock.notifySent(${JSON.stringify(added)}, "note", "unreachable")`);
    check(T("a send that could not reach the push service reads plainly too"), !!(await until(`/^Last try today at \\d\\d:\\d\\d could not reach the push service\\.$/.test($$(".pb-notify-device")[2]?.querySelector(".pb-notify-device-line").textContent ?? "")`)));
    await ev(`window.pobotsMock.notifyGone(${JSON.stringify(added)})`);
    const goneRow = await until(`(() => { const r = $$(".pb-notify-device")[2]; return r?.hasAttribute("data-gone") ? r.querySelector(".pb-notify-device-line").textContent : null; })()`);
    check(T("a device the push service called gone keeps its row, with what to do"), goneRow === `Stopped working on ${await dayNow()}. Open Pobots on that device and turn notifications on again.`, goneRow);
    const forgetBefore = (await ev(`window.pobotsMock.requests()["notify.forget"] ?? 0`)) ?? 0;
    await ev(`click($('.pb-notify-forget[aria-label="Forget Edge on Windows"]'))`);
    const afterForget = await until(`$$(".pb-notify-device").length === 2 && document.activeElement?.classList.contains("pb-notify-forget") && { labels: $$(".pb-notify-device-label").map((x) => x.textContent), focus: document.activeElement?.getAttribute("aria-label") }`);
    check(T("Forget takes the device off at once, no dialog, and the focus goes to the next row's Forget"), afterForget?.labels?.join(",") === "Home screen app on iPhone,Firefox on Windows" && afterForget.focus === "Forget Firefox on Windows" && ((await ev(`window.pobotsMock.requests()["notify.forget"]`)) ?? 0) === forgetBefore + 1, afterForget);
    await ev(`click($('.pb-notify-forget[aria-label="Forget Firefox on Windows"]'))`);
    const lastForget = await until(`$$(".pb-notify-device").length === 1 && document.activeElement?.getAttribute("aria-label")`);
    check(T("forgetting the last row gives the focus to the one before it"), lastForget === "Forget Home screen app on iPhone", lastForget);
    await openN(null, "notify=none", { theme });
    await openSettings();
    check(T("no devices yet: it says so"), (await ev(`$(".pb-notify-none")?.textContent`)) === "No devices yet.");

    // ---------------- the desktop window: it says so, and the switches and devices still work
    await openN(null, "shell=desktop", { theme });
    await openSettings();
    w = await ev(nWords);
    check(T("the desktop window says notifications work in a browser, and offers nothing to press"), w?.here === "desktop" && w.line === LINE.desktop && !w.act && w.devices.length === 2, w);
    await ev(`click($('.pb-notify-kind input[data-kind="finished"]'))`);
    check(T("the desktop window: a switch still saves"), !!(await until(`window.pobotsMock.notifyState().kinds.finished === true`)));
    const deskPresence = await until(`(() => { const p = window.pobotsMock.notifyPresence(); return p.length ? p[0] : null; })()`, 3000);
    check(T("the desktop window says how it stands too, without a device"), !!deskPresence && !("deviceId" in deskPresence) && deskPresence.visible === true, deskPresence);
    await nShot(`1280-desktop-${theme}`, `$(".pb-notify")`);

    // ---------------- the states a browser can be in
    for (const [what, cfg, here] of [
      ["an address that is not secure", { secure: false }, "insecure"],
      ["a browser without web push", { push: false }, "cannot"],
      ["a browser without service workers", { sw: false }, "cannot"],
      ["a browser without notifications", { notification: false }, "cannot"],
    ]) {
      await openN(cfg, "", { theme });
      await openSettings();
      w = await ev(nWords);
      const reg = await standin(`window.__pushStandIn.registered.length`);
      check(T(`${what}: "${LINE[here]}", nothing to press, nothing registered`), w?.here === here && w.line === LINE[here] && !w.act && reg === 0, { w, reg });
      if (first && what.includes("secure")) await nShot(`1280-insecure-${theme}`, `$(".pb-notify")`);
    }

    // ---------------- off, the browser's question, on: the main way
    await forgetDevice();
    await openN({ answer: "hold" }, "", { theme });
    await sleep(300);
    const early = await standin(`({ reg: window.__pushStandIn.registered.length, calls: window.__pushStandIn.calls.length, asked: window.__pushStandIn.permissionAsked, messages: window.__pushStandIn.startMessages, listeners: window.__pushStandIn.listeners.length })`);
    check(T("not asked yet: nothing is registered and nothing is asked before the section is shown; messages from the service worker are listened for"), early?.reg === 0 && early.calls === 0 && early.asked === 0 && early.messages === 1 && early.listeners === 1, early);
    await openSettings();
    const reg = await until(`window.__pushStandIn.registered.length === 1 && !$(".pb-notify-primary").hasAttribute("aria-disabled") && window.__pushStandIn.registered[0]`);
    check(T("showing the section registers /sw.js for the whole page, never from the browser's store"), reg?.url === "/sw.js" && reg.scope === "/" && reg.updateViaCache === "none", reg);
    w = await ev(nWords);
    check(T("off: Off on this device, Turn on for this device, and the hint that the browser asks once"), w?.here === "off" && w.line === LINE.off && w.primary === "Turn on for this device" && !w.primaryOff && w.note === "Your browser asks once. Choose Allow." && !w.noteError && w.mark === "pb-mark-idle" && w.off === null, w);
    check(T("the page has asked nothing of the browser by itself"), (await standin(`window.__pushStandIn.calls.length + window.__pushStandIn.permissionAsked`)) === 0);
    await houseRules(T("off"));
    await nShot(`1280-off-${theme}`, `$(".pb-notify")`);
    await watchN(ABOVE, 2);
    await ev(`click($(".pb-notify-primary"))`);
    const call = await standin(`window.__pushStandIn.calls[0]`);
    check(T("Turn on asks the browser straight from the press, with nothing awaited before it, with the engine's key"), call?.inClick === true && call.key === ENGINE_KEY && call.userVisibleOnly === true && call.permission === "default", call);
    const askingW = await until(`(() => { const w = ${nWords}; return w.here === "asking" ? w : null; })()`, 1000);
    check(T("while the browser asks: Waiting for your answer in the browser, the button kept but not pressable"), askingW?.line === LINE.asking && askingW.primary === "Turn on for this device" && askingW.primaryOff && askingW.mark === "pb-mark-waiting", askingW);
    await nShot(`1280-asking-${theme}`, `$(".pb-notify")`);
    await ev(`click($(".pb-notify-primary"))`);
    check(T("a second press while the browser asks does nothing"), (await standin(`window.__pushStandIn.calls.length`)) === 1);
    await standin(`window.__pushStandIn.answer("granted")`);
    const onW = await until(`(() => { const w = ${nWords}; return w.here === "on" ? w : null; })()`, 3000);
    await sleep(250);
    const wOn = await stopN();
    const subs = await ev(`window.pobotsMock.notifySubscribes()`);
    check(T("allowed: On for this device, Send a test and a quiet Turn off for this device"), onW?.line === LINE.on && onW.primary === "Send a test" && onW.off === "Turn off for this device" && onW.mark === "pb-mark-check" && onW.note === "", onW);
    check(T("the engine is told once, as asked, with the device's own name; it comes at the bottom marked This device"), subs?.length === 1 && subs[0].asked === true && subs[0].label === "Chrome on Mac" && subs[0].service === "Google" && subs[0].deviceId === idOf(CHECK) && onW?.devices?.at(-1) === `Chrome on Mac [here] | Added ${await dayNow()}. Nothing sent yet.` && onW.devices.length === 3, { subs, devices: onW?.devices });
    check(T("from off through the question to on, nothing above Your devices moves"), stillN(wOn), wOn);
    const primaryBox = await ev(`(() => { const r = $(".pb-notify-primary").getBoundingClientRect(); return [r.width, r.height].join("x"); })()`);
    const leak2 = await ev(`(() => { const s = JSON.stringify(window.pobotsState()) + document.body.innerHTML; return ["fcm.googleapis.com", "check-1", "BCheckPageKey", "CheckAuth"].filter((x) => s.includes(x)); })()`);
    check(T("the address and keys of this device are in neither the window's state nor the page"), Array.isArray(leak2) && leak2.length === 0, leak2);
    const myPresence = await until(`(() => { const p = window.pobotsMock.notifyPresence().at(-1); return p && p.deviceId ? p : null; })()`, 2000);
    check(T("once on, the window says how it stands with this device's id"), myPresence?.deviceId === idOf(CHECK), myPresence);
    await houseRules(T("on"));
    await nShot(`1280-on-${theme}`, `$(".pb-notify")`);

    // ---------------- Send a test: through each result, every line in its box
    await ev(`window.pobotsMock.notifyTestMs(600)`);
    await watchN([...ABOVE, ".pb-notify-primary", '[data-section="backup"]'], 3);
    await ev(`click($(".pb-notify-primary"))`);
    const sending = await until(`(() => { const w = ${nWords}; return w.primary === "Sending" ? { ...w, box: (() => { const r = $(".pb-notify-primary").getBoundingClientRect(); return [r.width, r.height].join("x"); })() } : null; })()`, 1000);
    check(T("Send a test reads Sending at the same size and cannot be pressed again"), sending?.primaryOff && sending.box === primaryBox, sending);
    const sentW = await until(`(() => { const w = ${nWords}; return w.primary === "Send a test" && w.note ? w : null; })()`, 3000);
    const at2 = /^Sent at (\d\d:\d\d)\. It should arrive in a few seconds\.$/.exec(sentW?.note ?? "")?.[1];
    check(T("sent: the time and that it should arrive in a few seconds; the row says it was sent"), !!at2 && !sentW.noteError && sentW.devices.at(-1) === `Chrome on Mac [here] | Added ${await dayNow()}. Last sent today at ${at2}.`, sentW);
    await nShot(`1280-test-sent-${theme}`, `$(".pb-notify")`);
    await ev(`window.pobotsMock.notifyTestNext("refused", "BadJwtToken")`);
    await ev(`click($(".pb-notify-primary"))`);
    const refused = await until(`(() => { const w = ${nWords}; return w.primary === "Send a test" && w.noteError ? w : null; })()`, 3000);
    check(T("refused: the push service's own short reason, said as a problem"), refused?.note === "The push service refused it: BadJwtToken." && refused.noteAlert, refused);
    await nShot(`1280-test-refused-${theme}`, `$(".pb-notify")`);
    await ev(`window.pobotsMock.notifyTestNext("unreachable")`);
    await ev(`click($(".pb-notify-primary"))`);
    const unreachable = await until(`(() => { const w = ${nWords}; return w.primary === "Send a test" && w.note === "The push service could not be reached." ? w : null; })()`, 3000);
    check(T("unreachable: the push service could not be reached"), unreachable?.noteError === true, unreachable);
    await sleep(250);
    const wTest = await stopN();
    check(T("through three tests and their results nothing on the page moves, Backup neither"), stillN(wTest), wTest);
    await ev(`window.pobotsMock.notifyTestMs(0)`);

    // ---------------- Turn off, and on again with the permission given
    await ev(`click($(".pb-notify-off"))`);
    const offW = await until(`(() => { const w = ${nWords}; return w.here === "off" ? w : null; })()`, 3000);
    const unsub = await standin(`window.__pushStandIn.unsubscribed`);
    check(T("Turn off: Pobots forgets the device, the browser drops its subscription, and no hint as the browser was answered"), offW?.line === LINE.off && offW.primary === "Turn on for this device" && offW.note === "" && unsub === 1 && offW.devices.length === 2 && !offW.devices.some((d) => d.includes("[here]")), { offW, unsub });
    await watchLines();
    await ev(`click($(".pb-notify-primary"))`);
    await until(`$(".pb-notify")?.dataset.here === "on"`, 3000);
    const lines = await stopLines();
    check(T("turning on again once allowed asks nothing: from off straight to on"), JSON.stringify(lines) === JSON.stringify([LINE.off, LINE.on]), lines);
    await forgetDevice();

    // ---------------- by keyboard: the focus stays on the action that stands there
    await openN({ answer: "granted" }, "", { theme });
    await openSettings();
    await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
    await ev(`$(".pb-appsettings-title").focus()`);
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await key("Tab");
      reached = await ev(`document.activeElement?.classList.contains("pb-notify-primary")`);
    }
    const ringOn = await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
    check(T("Turn on is the first thing Tab reaches after the way back, with a focus ring"), reached && ringOn, { reached, ringOn });
    await key("Enter");
    const kbOn = await until(`$(".pb-notify")?.dataset.here === "on" && { focus: document.activeElement?.classList.contains("pb-notify-primary"), text: document.activeElement?.querySelector(".pb-swap-line[data-show]")?.textContent }`, 3000);
    check(T("Enter turns it on, and the focus stays on the same button, now Send a test"), kbOn?.focus && kbOn.text === "Send a test", kbOn);
    await key("Tab");
    check(T("Tab goes on to Turn off for this device"), !!(await ev(`document.activeElement?.classList.contains("pb-notify-off")`)));
    await key("Enter");
    const kbOff = await until(`$(".pb-notify")?.dataset.here === "off" && { focus: document.activeElement?.classList.contains("pb-notify-primary"), text: document.activeElement?.querySelector(".pb-swap-line[data-show]")?.textContent }`, 3000);
    check(T("Turn off by keyboard: the focus goes to Turn on, not to the page's start"), kbOff?.focus && kbOff.text === "Turn on for this device", kbOff);
    await ev(`$(".pb-appsettings-title").focus()`);
    await focusRings(T("the section"), 7);
    await forgetDevice();

    // ---------------- said no, closed the question, refused by the engine, failed in the browser
    await openN({ answer: "denied" }, "", { theme });
    await openSettings();
    await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
    await ev(`$(".pb-notify-primary").focus()`);
    await key("Enter");
    const blockedW = await until(`(() => { const w = ${nWords}; return w.here === "blocked" ? { ...w, focus: document.activeElement?.classList.contains("pb-notify-how") } : null; })()`, 3000);
    check(T("said no: Notifications are blocked, How to allow them in place of the button, the focus on it"), blockedW?.line === LINE.blocked && blockedW.how === "false" && blockedW.primary === null && blockedW.note === "" && blockedW.mark === "pb-mark-blocked" && blockedW.focus, blockedW);
    await watchN(ABOVE.filter((s) => s !== ".pb-notify-kinds-part" && s !== "#notify-devices"));
    await key("Enter");
    await until(`$$(".pb-notify-allow li").length > 0`);
    await sleep(350);
    const wHow = await stopN();
    const steps = await ev(`({ items: $$(".pb-notify-allow li").map((x) => x.textContent), expanded: $(".pb-notify-how").getAttribute("aria-expanded"), below: $(".pb-notify-allow").getBoundingClientRect().top >= $(".pb-notify-note").getBoundingClientRect().bottom, last: $(".pb-notify-device-part").lastElementChild === $(".pb-notify-allow") })`);
    check(T("How to allow them opens the steps for this browser (Chrome on a Mac) below everything else in This device"), steps?.expanded === "true" && steps.below && steps.last && JSON.stringify(steps.items) === JSON.stringify(words.allowSteps(words.platformOf("Mac OS X Chrome"))), steps);
    check(T("opening the steps moves nothing above them"), stillN(wHow), wHow);
    await houseRules(T("blocked, with the steps"));
    await nShot(`1280-blocked-${theme}`, `$(".pb-notify")`);
    // Blocked from the start, in Edge on Windows: the Windows line too.
    if (first) {
      await b.cmd("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0" });
      await openN({ permission: "denied" }, "", { theme });
      await openSettings();
      await ev(`click($(".pb-notify-how"))`);
      const win = await until(`$$(".pb-notify-allow li").length && $$(".pb-notify-allow li").map((x) => x.textContent)`);
      check(T("blocked in Edge on Windows: the steps for the browser, then the line about Windows' own settings"), win?.length === 2 && /^Click the icon left of the address/.test(win[0]) && /^If they are allowed but none arrive, open Windows Settings/.test(win[1]), win);
      await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    }
    await openN({ answer: "default" }, "", { theme });
    await openSettings();
    await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
    await ev(`click($(".pb-notify-primary"))`);
    await until(`$(".pb-notify")?.dataset.here === "asking"`, 1000);
    const dismissed = await until(`(() => { const w = ${nWords}; return w.here === "off" ? w : null; })()`, 3000);
    check(T("the question closed without an answer: off again, with the hint, and no problem said"), dismissed?.line === LINE.off && dismissed.note === "Your browser asks once. Choose Allow." && !dismissed.noteError, dismissed);
    await openN({ answer: "granted" }, "", { theme });
    await openSettings();
    await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
    const TOO_MANY = "Pobots sends to at most 20 devices. Forget one you no longer use first.";
    await ev(`window.pobotsMock.notifySubscribeNext("too_many", ${JSON.stringify(TOO_MANY)})`);
    await watchN(ABOVE, 2);
    await ev(`click($(".pb-notify-primary"))`);
    const notKept = await until(`(() => { const w = ${nWords}; return w.noteError ? w : null; })()`, 3000);
    await sleep(250);
    const wKept = await stopN();
    check(T("allowed, but the engine refused: said under the button with the engine's sentence, still off"), notKept?.note === `Allowed, but Pobots could not keep this device. ${TOO_MANY}` && notKept.noteAlert && notKept.here === "off" && notKept.devices.length === 2, notKept);
    check(T("a refusal under the button moves nothing (the line keeps its room)"), stillN(wKept), wKept);
    await nShot(`1280-not-kept-${theme}`, `$(".pb-notify")`);
    await openN({ permission: "granted", subscribeFails: true }, "", { theme });
    await openSettings();
    await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
    await ev(`click($(".pb-notify-primary"))`);
    const brFail = await until(`(() => { const w = ${nWords}; return w.noteError ? w : null; })()`, 3000);
    check(T("allowed, but the browser could not set it up: said plainly, still off"), brFail?.note === words.BROWSER_FAILED && brFail.here === "off", brFail);
    await forgetDevice();

    // ---------------- every start with permission: "still here"
    await openN({ permission: "granted", sub: true, endpoint: LAPTOP, key: ENGINE_KEY }, "", { theme });
    const still = await until(`(() => { const s = window.pobotsMock.notifySubscribes(); return s.length ? { s, reg: window.__pushStandIn.registered.length } : null; })()`, 3000);
    check(T("allowed before: the service worker is registered at start, and the page says still here (not asked) for its own device"), still?.reg === 1 && still.s.length === 1 && still.s[0].asked === false && still.s[0].deviceId === idOf(LAPTOP) && !("replaces" in still.s[0]), still);
    await openSettings();
    w = await ev(nWords);
    const ids = await ev(`$$(".pb-notify-device").map((d) => d.dataset.id)`);
    check(T("still here: On for this device, and its own row (Edge on Windows' place) is marked as this device"), w?.here === "on" && ids?.[1] === idOf(LAPTOP) && w.devices[1].includes(" [here] |") && !w.devices[0].includes("[here]"), { w, ids });
    check(T("still here: nothing was asked of the browser"), (await standin(`window.__pushStandIn.calls.length + window.__pushStandIn.permissionAsked`)) === 0);
    const remembered = await ev(`localStorage.getItem("pobots.notify.device")`);
    await openN({ permission: "granted", sub: true, endpoint: "https://wns2-db5p.notify.windows.com/w/?token=renewed", key: ENGINE_KEY }, "", { theme });
    const renewed = await until(`(() => { const s = window.pobotsMock.notifySubscribes(); return s.length ? s[0] : null; })()`, 3000);
    await openSettings();
    await sleep(200);
    w = await ev(nWords);
    const ids2 = await ev(`$$(".pb-notify-device").map((d) => d.dataset.id)`);
    // The second look, point 2: the page names in `replaces` only an address this tab itself held
    // before, never the id remembered in shared storage (another tab may have moved it on). A
    // subscription the browser renewed by itself reaches the engine by the service worker's renewal.
    check(T("a subscription the browser renewed by itself is not put in the remembered device's place by the page: no replaces, Off, the working row untouched"), remembered === idOf(LAPTOP) && renewed && !("replaces" in renewed) && renewed.asked === false && w?.here === "off" && w.devices.length === 2 && ids2?.[1] === idOf(LAPTOP) && !w.devices.some((d) => d.includes("[here]")), { remembered, renewed, devices: w?.devices, ids2 });
    await forgetDevice();
    await openN({ permission: "granted", sub: true, endpoint: LAPTOP, key: OTHER_KEY }, "", { theme });
    await openSettings();
    await sleep(300);
    const otherKey = await ev(`({ here: $(".pb-notify").dataset.here, unsub: window.__pushStandIn.unsubscribed, subs: window.pobotsMock.notifySubscribes().length })`);
    check(T("a subscription made with an older key is dropped, not sent: off"), otherKey?.here === "off" && otherKey.unsub === 1 && otherKey.subs === 0, otherKey);
    await openN({ permission: "granted", sub: true, endpoint: "https://fcm.googleapis.com/fcm/send/check-forgotten", key: ENGINE_KEY }, "", { theme });
    await until(`window.pobotsMock.notifySubscribes().length === 1`, 3000);
    await openSettings();
    await sleep(200);
    w = await ev(nWords);
    check(T("a device forgotten elsewhere does not come back by itself: off, the list unchanged"), w?.here === "off" && w.devices.length === 2, w);
    await openN({ permission: "granted", sub: true, endpoint: IPHONE, key: ENGINE_KEY }, "notify=gone", { theme });
    await until(`window.pobotsMock.notifySubscribes().length === 1`, 3000);
    await openSettings();
    await sleep(200);
    w = await ev(nWords);
    const gone0 = await ev(`$$(".pb-notify-device")[0]?.hasAttribute("data-gone")`);
    const stillGone = await ev(`window.pobotsMock.notifySubscribes()`);
    check(
      T("a device that stopped working is not taken back by opening Pobots on it: Off, and its own row says it stopped working"),
      w?.here === "off" && w.line === LINE.off && w.devices[0]?.startsWith("Home screen app on iPhone [here] | Stopped working on ") && w.devices[0].endsWith(". Open Pobots on that device and turn notifications on again.") && gone0 === true && stillGone?.length === 1 && stillGone[0].asked === false,
      { w, gone0, stillGone },
    );
    await watchN(ABOVE, 1);
    await ev(`click($(".pb-notify-primary"))`);
    const mended = await until(`(() => { const s = window.pobotsMock.notifySubscribes(); return s.length === 2 && $(".pb-notify")?.dataset.here === "on" ? { s, calls: window.__pushStandIn.calls, unsub: window.__pushStandIn.unsubscribed, asked: window.__pushStandIn.permissionAsked } : null; })()`, 3000);
    await sleep(250);
    const wMend = await stopN();
    w = await ev(nWords);
    const gone1 = await ev(`$$(".pb-notify-device")[0]?.hasAttribute("data-gone")`);
    check(
      T("Turn on for a device that stopped working: subscribe from the press first, then the old subscription dropped and a fresh one made, sent as asked in the gone row's place"),
      mended?.calls?.length === 2 && mended.calls[0].inClick === true && mended.unsub === 1 && mended.asked === 0 && mended.s[1].asked === true && mended.s[1].replaces === idOf(IPHONE) && mended.s[1].deviceId === idOf(`${IPHONE}-1`),
      mended,
    );
    check(T("after that: On for this device, the same row (first in the list) working again, marked this device"), w?.here === "on" && w.devices.length === 2 && w.devices[0].includes(" [here] | ") && !w.devices[0].includes("Stopped working") && gone1 === false && (await ev(`$$(".pb-notify-device")[0]?.dataset.id`)) === idOf(`${IPHONE}-1`), { w, gone1 });
    check(T("mending a device that stopped working moves nothing above the device list"), stillN(wMend), wMend);
    await forgetDevice();

    // ---------------- the second look, point 1: a dead address is never sent as on, whatever the browser does
    for (const [what, extra] of [["the browser could not drop the old subscription", { unsubscribeFails: true }], ["the browser handed back the same address", { same: true }]]) {
      await openN({ permission: "granted", sub: true, endpoint: IPHONE, key: ENGINE_KEY, ...extra }, "notify=gone", { theme });
      await until(`window.pobotsMock.notifySubscribes().length === 1`, 3000);
      await openSettings();
      await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
      await watchN(ABOVE, 1);
      await ev(`click($(".pb-notify-primary"))`);
      const stuck = await until(`(() => { const w = ${nWords}; return w.noteError ? w : null; })()`, 3000);
      await sleep(250);
      const wStuck = await stopN();
      const sent = await ev(`window.pobotsMock.notifySubscribes()`);
      const goneRow = await ev(`$$(".pb-notify-device")[0]?.hasAttribute("data-gone")`);
      check(
        T(`Turn on for a device that stopped working, when ${what}: it stops there, says so in fixed words, and never sends that address as on`),
        stuck?.note === words.BROWSER_STUCK && stuck.noteAlert && stuck.here === "off" && sent?.length === 1 && sent[0].asked === false && goneRow === true,
        { stuck, sent, goneRow },
      );
      check(T(`when ${what}: the result line keeps its box, nothing above the device list moves`), stillN(wStuck), wStuck);
      await forgetDevice();
    }

    // ---------------- the second look, point 3: every open tab of the browser shows the same truth
    // One page plays this tab; the stand-in's own state is the browser's, which another tab changes
    // (st.drop, st.setSub), and the other tab's word is the `storage` event of the remembered id.
    {
      await openN({ permission: "granted", sub: true, endpoint: LAPTOP, key: ENGINE_KEY }, "", { theme });
      await until(`window.pobotsMock.notifySubscribes().length === 1`, 3000);
      await openSettings();
      const on0 = await until(`$(".pb-notify")?.dataset.here === "on"`, 3000);
      await watchN(ABOVE);
      const otherTab = `window.dispatchEvent(new StorageEvent("storage", { key: "pobots.notify.device", oldValue: ${JSON.stringify(idOf(LAPTOP))}, newValue: null }))`;
      await standin(`window.__pushStandIn.drop()`);
      await ev(`(() => { ${otherTab}; return true; })()`);
      const offByTab = await until(`(() => { const w = ${nWords}; return w.here === "off" ? w : null; })()`, 2000);
      check(T("another tab dropped this browser's subscription and said so: this tab says Off too, and no row is This device"), !!on0 && offByTab?.line === LINE.off && !offByTab.devices.some((d) => d.includes("[here]")), offByTab ?? (await ev(nWords)));
      await standin(`window.__pushStandIn.setSub(${JSON.stringify(LAPTOP)})`);
      await ev(`(() => { ${otherTab}; return true; })()`);
      const backOn = await until(`$(".pb-notify")?.dataset.here === "on"`, 2000);
      check(T("the browser has the subscription again and the engine works with it: On again"), !!backOn);
      await standin(`window.__pushStandIn.drop()`);
      await ev(`window.pobotsMock.notifySent(${JSON.stringify(idOf(IPHONE))}, "needs", "sent")`);
      const offByEvent = await until(`$(".pb-notify")?.dataset.here === "off"`, 2000);
      check(T("the browser's subscription gone without a word from another tab: the next notify.changed reads it again, Off"), !!offByEvent, await ev(nWords));
      await standin(`window.__pushStandIn.setSub(${JSON.stringify(LAPTOP)})`);
      await ev(`(() => { ${otherTab}; return true; })()`);
      await until(`$(".pb-notify")?.dataset.here === "on"`, 2000);
      await standin(`window.__pushStandIn.drop()`);
      await ev(`(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
      const offByView = await until(`$(".pb-notify")?.dataset.here === "off"`, 2000);
      check(T("and when the tab comes into view it reads it again: Off"), !!offByView, await ev(nWords));
      await sleep(250);
      const wTabs = await stopN();
      check(T("through all of that, every line above the device list keeps its box"), stillN(wTabs), wTabs);
      const reads0 = await standin(`window.__pushStandIn.reads`);
      await sleep(1500);
      const quiet = await standin(`({ reads: window.__pushStandIn.reads, unsubscribed: window.__pushStandIn.unsubscribed })`);
      check(T("no polling: with nothing happening the browser's subscription is not read again; and this tab, only reading, dropped nothing"), quiet?.reads === reads0 && quiet.unsubscribed === 0, { reads0, quiet });
      await forgetDevice();
    }

    // ---------------- the start query: what a click on a notification opens in a new window
    await openN(null, "bot=onboardings&open=needs", { theme });
    const q1 = await until(`$(".app-main")?.getAttribute("aria-label") === "Onboardings" && location.search`, 3000);
    check(T("laptop: /?bot=onboardings&open=needs opens that bot (the rail beside it shows what needs you)"), typeof q1 === "string");
    check(T("laptop: the query is taken out of the address bar afterwards, the rest kept"), typeof q1 === "string" && !/[?&](bot|open)=/.test(q1) && q1.includes("mock=1"), q1);
    await openN(null, "bot=inbox&open=chat", { theme });
    check(T("laptop: /?bot=inbox&open=chat opens Inbox's chat"), !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Inbox" && $(".app-tabpanel")?.dataset.tab === "chat"`, 3000)));
    await openN(null, "bot=nobody&open=chat", { theme });
    const gone = await until(`!!$(".app-main") && { label: $(".app-main").getAttribute("aria-label"), q: location.search }`, 3000);
    check(T("laptop: a bot that is gone opens nothing new, and the query still leaves the address bar"), !!gone?.label && !/[?&](bot|open)=/.test(gone.q), gone);
    await openN(null, "", { theme });
    const before = await until(`$(".app-main")?.getAttribute("aria-label")`, 3000);
    await openN(null, "bot=nobody&open=needs", { theme });
    await sleep(400);
    const gone2 = await until(`!!$(".app-main") && { label: $(".app-main").getAttribute("aria-label"), q: location.search }`, 3000);
    check(T("laptop: /?bot=<a bot that is gone>&open=needs keeps the bot that was open"), !!before && gone2?.label === before && !/[?&](bot|open)=/.test(gone2.q), { before, gone2 });

    // ---------------- a message from the service worker in an open window
    await openN({}, "", { theme });
    await openSettings();
    const delivered = await standin(`window.__pushStandIn.message({ pobots: "open", bot: "inbox", open: "chat" })`);
    const msg = await until(`!$(".app-appsettings") && $(".app-main")?.getAttribute("aria-label") === "Inbox"`, 3000);
    check(T("a click on a notification with the window open: settings close and the bot opens"), delivered === 1 && !!msg, delivered);
    await standin(`window.__pushStandIn.message({ pobots: "open", bot: "kaja", open: "elsewhere" })`);
    await standin(`window.__pushStandIn.message({ pobots: "close", bot: "kaja", open: "chat" })`);
    await sleep(300);
    check(T("a message of another shape is ignored"), (await ev(`$(".app-main")?.getAttribute("aria-label")`)) === "Inbox");
    await openN({ early: { pobots: "open", bot: "hubspot-tickets", open: "chat" } }, "", { theme });
    check(T("a click that came while the page was still starting opens the bot once the bots are known"), !!(await until(`$(".app-main")?.getAttribute("aria-label") === "HubSpot tickets"`, 3000)));

    // ---------------- tidy on open
    const NOTES = ["pobots-inbox-needs", "pobots-hubspot-tickets-needs", "pobots-onboardings-note", "pobots-kaja-note", "pobots-system-note", "pobots-inbox-finished", "pobots-kaja-finished", "pobots-test", "someone-else"];
    await openN({ permission: "granted", notes: NOTES }, "bot=inbox&open=chat", { theme });
    await until(`$(".app-main")?.getAttribute("aria-label") === "Inbox"`, 3000);
    await sleep(600);
    const closed = await standin(`[...window.__pushStandIn.closed].sort()`);
    check(
      T("on opening, the notifications whose card is no longer open, and the finished ones of the bot opened, are closed; the rest stay"),
      JSON.stringify(closed) === JSON.stringify(["pobots-hubspot-tickets-needs", "pobots-inbox-finished", "pobots-kaja-note", "pobots-system-note"]),
      closed,
    );
    await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja"))`);
    check(T("opening another bot closes its finished notifications too"), !!(await until(`window.__pushStandIn.closed.includes("pobots-kaja-finished")`, 2000)));

    // ---------------- presence
    if (first) {
      await openN({}, "", { theme });
      const p0 = await until(`(() => { const p = window.pobotsMock.notifyPresence(); return p.length ? p : null; })()`, 3000);
      check("push: on connect the window says it is seen, not used yet (no time of last use), and names no device while off", p0?.length >= 1 && p0[0].visible === true && p0[0].idleMs === null && !("active" in p0[0]) && !("deviceId" in p0[0]), p0);
      await sleep(400);
      let n = (await presence()).length;
      await ev(`(() => { document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("blur")); return true; })()`);
      await sleep(500);
      let p = await presence();
      check("push: a blur is said once after a short quiet, as not in front", p.length === n + 1 && p.at(-1).focused === false && p.at(-1).visible === true, p.slice(n));
      n = p.length;
      await ev(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
      await sleep(500);
      p = await presence();
      check("push: hidden is said once, as not seen", p.length === n + 1 && p.at(-1).visible === false, p.slice(n));
      n = p.length;
      check("push: while hidden the heartbeat says nothing", (await standin(`window.__pushStandIn.beat()`)) >= 1 && (await sleep(200), (await presence()).length === n));
      await ev(`(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.hasFocus = () => true; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); return true; })()`);
      await sleep(500);
      p = await presence();
      check("push: back in view and in front is said once (visibility and focus together)", p.length === n + 1 && p.at(-1).visible === true && p.at(-1).focused === true, p.slice(n));
      n = p.length;
      for (let i = 0; i < 5; i++) await key("ArrowDown");
      await ev(`(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new PointerEvent("pointerdown")); return true; })()`);
      await sleep(500);
      p = await presence();
      check("push: use is said once, as used just now (how long ago, in ms)", p.length === n + 1 && typeof p.at(-1).idleMs === "number" && p.at(-1).idleMs >= 0 && p.at(-1).idleMs < 1000, p.slice(n));
      const usedIdle = p.at(-1).idleMs;
      n = p.length;
      for (let i = 0; i < 5; i++) await key("ArrowUp");
      await sleep(500);
      check("push: more use within the minute says nothing more", (await presence()).length === n);
      await standin(`window.__pushStandIn.beat()`);
      await sleep(200);
      p = await presence();
      check("push: the heartbeat while visible says it again (every 60 seconds), counting from the last use, not from itself", p.length === n + 1 && p.at(-1).visible === true && typeof p.at(-1).idleMs === "number" && p.at(-1).idleMs > usedIdle + 300, { usedIdle, p: p.slice(n) });
    }

    // ---------------- 800 px
    if (first) {
      for (const [name, cfg, act] of [["off", {}, null], ["on", { permission: "granted", sub: true, endpoint: LAPTOP, key: ENGINE_KEY }, null], ["blocked", { permission: "denied" }, "how"]]) {
        await openN(cfg, "", { width: 800, theme });
        await openSettings();
        await sleep(200);
        if (act === "how") await ev(`click($(".pb-notify-how"))`);
        await sleep(200);
        await houseRules(T(`800 px, ${name}`));
        await nShot(`800-${name}-${theme}`);
      }
    }
  }

  // ---------------- the phones
  {
    const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const PHONES = [
      { tag: "390", width: 390, height: 844, ua: IPHONE_UA, ios: true },
      { tag: "360", width: 360, height: 780, ua: ANDROID_UA, ios: false },
    ];
    const openPhoneN = async (cfg, query, phone, theme = "dark") => {
      await b.cmd("Emulation.setUserAgentOverride", { userAgent: phone.ua, platform: phone.ios ? "iPhone" : "Linux armv8l" });
      await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
      await b.cmd("Page.resetNavigationHistory");
      const q = [cfg ? `standin=${encodeURIComponent(JSON.stringify(cfg))}` : "", query, `n=${++pushOpens}`].filter(Boolean).join("&");
      await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&${q}` });
      const ok = await until(`!!document.querySelector(".pb-shell")`, 6000);
      await sleep(300);
      return ok;
    };
    const tapN = async (expression) => {
      const at = await ev(`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hits: !!hit && (hit === el || el.contains(hit)) }; })()`);
      if (!at || at.error) return false;
      await b.cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
      await b.cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(80);
      return at.hits;
    };
    const visible = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }) && !x.closest("[inert]"))`;
    const openSheet = async () => {
      await tapN(visible(".pb-foot-settings"));
      const ok = await until(`!!$(".pb-notify") && $(".app-shell").dataset.phoneSheet === "settings"`);
      await sleep(400);
      return ok;
    };
    /** Controls in the section under 44 x 44 px to tap (a control's own ::after may make its hit area larger), and fields under 16 px. */
    const smallN = () =>
      ev(`(() => {
        const hit = (el) => { const r = el.getBoundingClientRect(); const a = getComputedStyle(el, "::after"); let w = r.width, h = r.height; if (a.content !== "none" && a.position === "absolute") { w = Math.max(w, parseFloat(a.width)); h = Math.max(h, parseFloat(a.height)); } return { w, h }; };
        const small = $$(".pb-notify button, .pb-notify input").filter((el) => el.checkVisibility({ visibilityProperty: true })).map((el) => ({ what: (el.getAttribute("aria-label") || el.textContent).trim().slice(0, 40), ...hit(el) })).filter((x) => x.w < 43.5 || x.h < 43.5);
        const wide = Math.round($(".pb-notify").getBoundingClientRect().right) > innerWidth || document.scrollingElement.scrollWidth > innerWidth;
        return { small, wide };
      })()`);
    for (const phone of PHONES) {
      const P = (s) => `push: phone ${phone.tag} (${phone.ios ? "iPhone" : "Android"}): ${s}`;

      // The section in the settings sheet.
      if (phone.ios) {
        await openPhoneN({}, "", phone);
        await openSheet();
        let w = await ev(nWords);
        check(P("in Safari, not from the home screen: the line and the three steps to add Pobots to the home screen, nothing to press"), w?.here === "ios-browser" && w.line === LINE["ios-browser"] && JSON.stringify(w.ios) === JSON.stringify(words.IOS_STEPS) && !w.act, w);
        await houseRules(P("the steps"));
        await nShot(`${phone.tag}-ios-browser-dark`);
        await openPhoneN({ standalone: true, push: false }, "", phone);
        await openSheet();
        w = await ev(nWords);
        check(P("from the home screen on an older iPhone: it needs iOS 16.4 or later, no steps"), w?.here === "ios-old" && w.line === LINE["ios-old"] && w.ios.length === 0 && !w.act, w);
      }
      await openPhoneN({ answer: "hold", ...(phone.ios ? { standalone: true } : {}) }, "", phone);
      await openSheet();
      await until(`!$(".pb-notify-primary").hasAttribute("aria-disabled")`);
      let w = await ev(nWords);
      check(P(`${phone.ios ? "from the home screen" : "in Chrome"}: off, with Turn on for this device`), w?.here === "off" && w.primary === "Turn on for this device", w);
      let small = await smallN();
      check(P("off: every control 44 px to tap, nothing wider than the screen"), small?.small?.length === 0 && !small.wide, small);
      await nShot(`${phone.tag}-off-dark`);
      await watchN(ABOVE, 2);
      check(P("the button takes a tap"), await tapN(`$(".pb-notify-primary")`));
      const call = await standin(`window.__pushStandIn.calls[0]`);
      check(P("a tap asks the browser straight from the tap"), call?.inClick === true, call);
      await until(`$(".pb-notify")?.dataset.here === "asking"`, 1000);
      await standin(`window.__pushStandIn.answer("granted")`);
      const onW = await until(`(() => { const w = ${nWords}; return w.here === "on" ? w : null; })()`, 3000);
      await sleep(250);
      const wOn = await stopN();
      const label = phone.ios ? "Home screen app on iPhone" : "Chrome on Android";
      check(P(`on, named ${label}, at the bottom of the list`), onW?.devices?.at(-1)?.startsWith(`${label} [here] |`), onW?.devices);
      check(P("from off through the question to on nothing above Your devices moves"), stillN(wOn), wOn);
      small = await smallN();
      check(P("on: every control 44 px to tap, nothing wider than the screen"), small?.small?.length === 0 && !small.wide, small);
      await houseRules(P("on"));
      await nShot(`${phone.tag}-on-dark`);
      await ev(`window.pobotsMock.notifyTestMs(400)`);
      await watchN([...ABOVE, ".pb-notify-primary"], 3);
      await tapN(`$(".pb-notify-primary")`);
      const sent = await until(`(() => { const w = ${nWords}; return w.note && w.primary === "Send a test" ? w : null; })()`, 3000);
      await ev(`window.pobotsMock.notifyTestNext("refused", "BadJwtToken")`);
      await tapN(`$(".pb-notify-primary")`);
      await until(`(() => { const w = ${nWords}; return w.noteError && w.primary === "Send a test"; })()`, 3000);
      await sleep(250);
      const wTest = await stopN();
      check(P("Send a test through sent and refused: every line keeps its box"), /^Sent at /.test(sent?.note ?? "") && stillN(wTest), { note: sent?.note, wTest });
      await nShot(`${phone.tag}-test-refused-dark`);
      await openPhoneN({ permission: "denied", ...(phone.ios ? { standalone: true } : {}) }, "", phone);
      await openSheet();
      await tapN(`$(".pb-notify-how")`);
      w = await until(`(() => { const w = ${nWords}; return w.allow.length ? w : null; })()`);
      const want = phone.ios ? "Open the iPhone's Settings, then Notifications, choose Pobots and turn on Allow Notifications." : "Tap the icon left of the address, then Permissions, and turn Notifications on.";
      check(P("blocked: How to allow them gives the steps for this phone"), JSON.stringify(w?.allow) === JSON.stringify([want]), w?.allow);
      small = await smallN();
      check(P("blocked: every control 44 px to tap, nothing wider than the screen"), small?.small?.length === 0 && !small.wide, small);
      await nShot(`${phone.tag}-blocked-dark`);
      await openPhoneN({ answer: "granted", ...(phone.ios ? { standalone: true } : {}) }, "", phone, "light");
      await openSheet();
      await houseRules(P("light, off"));
      await nShot(`${phone.tag}-off-light`);

      // The start query and a message from the service worker, on a phone.
      await openPhoneN(null, "bot=onboardings&open=needs", phone);
      const needs = await until(`$(".app-shell")?.dataset.phoneScreen === "needs" && { q: location.search, len: history.length }`, 3000);
      check(P("/?bot=onboardings&open=needs shows Needs you, and the query leaves the address bar"), !!needs && !/[?&](bot|open)=/.test(needs.q), needs);
      await ev(`(history.back(), true)`);
      const backBot = await until(`$(".app-shell")?.dataset.phoneScreen === "bot" && $(".app-main")?.getAttribute("aria-label")`, 3000);
      check(P("back from there goes to the bot's chat"), backBot === "Onboardings", backBot);
      await ev(`(history.back(), true)`);
      check(P("and back again to Bots"), !!(await until(`$(".app-shell")?.dataset.phoneScreen === "bots"`, 3000)));
      await openPhoneN(null, "bot=inbox&open=chat", phone);
      check(P("/?bot=inbox&open=chat shows Inbox's chat"), !!(await until(`$(".app-shell")?.dataset.phoneScreen === "bot" && $(".app-main")?.getAttribute("aria-label") === "Inbox"`, 3000)));
      await openPhoneN(null, "open=needs", phone);
      check(P("/?open=needs (a note from Pobots itself) shows Needs you"), !!(await until(`$(".app-shell")?.dataset.phoneScreen === "needs"`, 3000)));
      await openPhoneN(null, "bot=nobody&open=needs", phone);
      await sleep(400);
      const goneBot = await until(`!!$(".app-shell")?.dataset.phoneScreen && { screen: $(".app-shell").dataset.phoneScreen, q: location.search }`, 3000);
      check(P("/?bot=<a bot that is gone>&open=needs shows Bots, not Needs you, and the query leaves the address bar"), goneBot?.screen === "bots" && !/[?&](bot|open)=/.test(goneBot.q), goneBot);
      await openPhoneN(phone.ios ? { standalone: true } : {}, "", phone);
      await standin(`window.__pushStandIn.message({ pobots: "open", bot: "inbox", open: "needs" })`);
      check(P("a click with the window open, on Bots: Needs you shows"), !!(await until(`$(".app-shell")?.dataset.phoneScreen === "needs"`, 3000)));
      await openPhoneN(phone.ios ? { standalone: true } : {}, "", phone);
      await standin(`window.__pushStandIn.message({ pobots: "open", bot: "nobody", open: "needs" })`);
      await sleep(400);
      check(P("a click for a bot that is gone, with the window open on Bots: it stays on Bots"), (await ev(`$(".app-shell")?.dataset.phoneScreen`)) === "bots");

      // Where the phone layout and notifications meet (release 0.14): a chat scrolled up, the bot's
      // page with a file open over it, then a click on that bot's "finished" notification. The chat
      // shows at its newest message (not the place kept for the way back), nothing fades in again,
      // and back leads on without a step that shows the same screen twice.
      await openPhoneN(phone.ios ? { standalone: true } : {}, "", phone);
      await tapN(`$$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja")`);
      await until(`$(".app-shell")?.dataset.phoneScreen === "bot" && $(".app-main")?.getAttribute("aria-label") === "Kaja"`, 3000);
      const meetSc = `$(".app-main .pb-main-scroll")`;
      await until(`${meetSc} && ${meetSc}.scrollHeight > ${meetSc}.clientHeight + 200`, 3000);
      await sleep(300);
      await ev(`(() => { const s = ${meetSc}; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 3); return true; })()`);
      await sleep(200);
      await tapN(`$(".app-main .app-phone-page")`);
      await until(`$(".app-tabpanel")?.dataset.tab !== "chat"`, 3000);
      await ev(`click($('.pb-tab[data-tab="files"]'))`);
      await until(`$(".app-tabpanel")?.dataset.tab === "files" && $$(".pb-file").length > 1`, 3000);
      await tapN(`$$(".pb-file")[1]`);
      const fileUp = await until(`$(".app-files")?.dataset.show === "file" && (history.state?.pobotsLayers ?? []).length === 1`, 3000);
      // A look the moment the page changes (is any line fading), and one after each frame is drawn
      // (where the chat stands as he sees it: the browser reports a new size just before it draws).
      await ev(`(() => { window.__mf = []; const look = (drawn) => { const s = document.querySelector(".app-main .pb-main-scroll"); if (!s) return; window.__mf.push({ gap: drawn ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : 0, dim: [...s.querySelectorAll(".pb-thread *")].filter((x) => +getComputedStyle(x).opacity < 1 && !x.closest("[aria-hidden]")).length }); };
        window.__mfObs = new MutationObserver(() => look(false)); window.__mfObs.observe(document.querySelector(".app-shell"), { subtree: true, childList: true });
        const step = () => { if (!window.__mfObs) return; setTimeout(() => look(true), 0); requestAnimationFrame(step); }; requestAnimationFrame(step); return true; })()`);
      await standin(`window.__pushStandIn.message({ pobots: "open", bot: "kaja", open: "chat" })`);
      const onChat = await until(`$(".app-tabpanel")?.dataset.tab === "chat" && $(".app-shell")?.dataset.phoneScreen === "bot"`, 3000);
      await sleep(500);
      const mf = await ev(`(() => { window.__mfObs.disconnect(); window.__mfObs = null; return window.__mf; })()`);
      check(P("a click on a finished notification while the bot's page shows a file: the chat shows at its newest message, from the first moment"), !!fileUp && !!onChat && Array.isArray(mf) && mf.length > 3 && mf.every((x) => x.gap === 0), { fileUp, onChat, gaps: [...new Set((mf ?? []).map((x) => x.gap))] });
      check(P("and no line of it fades in or rises"), Array.isArray(mf) && mf.length > 3 && mf.every((x) => x.dim === 0), (mf ?? []).filter((x) => x.dim).slice(0, 3));
      const seenScreens = [];
      for (let i = 0; i < 4; i++) {
        await ev(`(history.back(), true)`);
        await sleep(350);
        seenScreens.push(await ev(`[$(".app-shell")?.dataset.phoneScreen, $(".app-tabpanel")?.dataset.tab, $(".app-files")?.dataset.show ?? "", (history.state?.pobotsLayers ?? []).length].join("/")`));
        if (seenScreens.at(-1)?.startsWith("bots/")) break;
      }
      check(P("and back from there never shows the same screen twice, and ends on Bots"), seenScreens.at(-1)?.startsWith("bots/") && new Set(seenScreens).size === seenScreens.length && !seenScreens.some((x) => x.endsWith("/1")), seenScreens);
    }
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  }

  await forgetDevice();
  if (standIn?.result?.identifier) await b.cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier: standIn.result.identifier });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&n=${++pushOpens}` });
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  if (pushShots) console.log(`Notification pictures in ${pushShots}`);
  }
}
