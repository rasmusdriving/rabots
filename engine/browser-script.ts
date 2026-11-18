// The script the engine's helper processes run inside the bots' browser (docs/build/step-2g.md, A1;
// docs/build/notes-engine-2g.md). It is handed to `ego-browser nodejs` on stdin, never on the command
// line, with the engine's port and a one-time token written into its first line. The script runs in
// the browser's own Node helper, not in a process of ours: it ends itself when its link to the engine
// closes, and that is how the engine stops it.
//
// Three roles:
//   lister   long-lived. Lists the workspaces (never attaches to a bot's), and makes, moves and
//            closes the person's own workspace.
//   watcher  one per watched workspace. Attaches to it, reports its pages, takes pictures of the
//            pages someone watches, and passes the person's input on. Ends when nobody watches.
//            In this browser any look at a page (a picture, reading its size, page.evaluate) makes
//            it the page in front, so a watcher only ever takes pictures of the page in front.
//   peek     attaches for a moment to read a workspace's pages, then ends.
// A second live script that holds a bot's workspace makes the bot's `waitForEvent("popup")` miss the
// popup, so only a watcher (while the person watches) and a peek (while no command of the bot runs
// there) ever attach to one. `page.events()` is never read: its buffer is shared with the bot.
//
// The wire: one JSON object per line, both ways. The script's first line is
// {"t":"hello","token":...,"role":...}; the engine drops a link whose first line is anything else.

export type HelperRole = "lister" | "watcher" | "peek";

export interface HelperScriptOptions {
  port: number;
  token: string;
  role: HelperRole;
  /** watcher and peek: the workspace. */
  spaceId?: number;
  /** lister: the name of the person's own workspace in the browser's list. */
  ownName?: string;
  /** lister: how often to list at first, in ms. */
  rate?: number;
  /** Largest picture, in the page's own pixels. */
  maxWidth?: number;
  maxHeight?: number;
  /** watcher: how often it looks at the pages, and takes pictures while a page changes and while it is still (ms). */
  tabsMs?: number;
  fastShotMs?: number;
  slowShotMs?: number;
  /** watcher: how long a page stands still before one picture of the best quality is sent (ms). */
  stillMs?: number;
  /** watcher: the sharp picture's scale stays between these (screen pixels per page pixel). */
  minScale?: number;
  maxScale?: number;
  /** watcher: the sharp picture is never larger than this, in pixels. */
  crispMaxWidth?: number;
  crispMaxHeight?: number;
  /** watcher: a sharp picture as PNG larger than this is taken as WebP instead (bytes). */
  pngMaxBytes?: number;
}

export function helperScript(o: HelperScriptOptions): string {
  const config = { maxWidth: 1600, maxHeight: 1200, rate: 5000, tabsMs: 500, fastShotMs: 80, slowShotMs: 400, stillMs: 500, minScale: 0.25, maxScale: 2, crispMaxWidth: 3200, crispMaxHeight: 2400, pngMaxBytes: 600 * 1024, ...o };
  return `const CONFIG = ${JSON.stringify(config)};\n${BODY}`;
}

// Plain JavaScript, run by the browser's Node. No backticks and no dollar-brace inside: this is a template.
const BODY = String.raw`
const net = await import("node:net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BACKLOG = 4 * 1024 * 1024;
const short = (e) => String((e && e.message) || e).slice(0, 300);
let closed = false;
const waiters = new Set();
function wakeAll() { for (const w of [...waiters]) w(); }
const sock = net.createConnection({ host: "127.0.0.1", port: CONFIG.port });
let connected = false;
try {
  await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  connected = true;
} catch (e) {
  closed = true;
}
if (connected) await main();

function send(o) {
  if (closed) return false;
  if (o.t === "frame" && sock.writableLength > MAX_BACKLOG) return false;
  try { sock.write(JSON.stringify(o) + "\n"); } catch (e) { return false; }
  return true;
}

async function main() {
  sock.setNoDelay(true);
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  const ended = new Promise((r) => sock.on("close", () => { closed = true; wakeAll(); r(); }));
  const handlers = {};
  let buf = "";
  let chain = Promise.resolve();
  sock.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > 16 * 1024 * 1024) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let cmd;
      try { cmd = JSON.parse(line); } catch (e) { continue; }
      if (!cmd || cmd.t !== "cmd") continue;
      // A page's dialog must be answerable while a click that opened it still waits.
      const quick = cmd.op === "want" || cmd.op === "rate" || cmd.op === "dialog" || cmd.op === "force";
      const job = async () => {
        const h = handlers[cmd.op];
        if (!h) { send({ t: "res", id: cmd.id, ok: false, error: "unknown" }); return; }
        try { const result = await h(cmd); send({ t: "res", id: cmd.id, ok: true, result: result === undefined ? null : result }); }
        catch (e) { send({ t: "res", id: cmd.id, ok: false, error: short(e) }); }
      };
      // Input, moves and dialogs run strictly in order; settings that only change a loop run at once.
      if (quick) job(); else chain = chain.then(job);
    }
  });
  send({ t: "hello", token: CONFIG.token, role: CONFIG.role });
  try {
    if (CONFIG.role === "lister") await lister(handlers, ended);
    else if (CONFIG.role === "watcher") await watcher(handlers, ended);
    else if (CONFIG.role === "peek") await peek();
  } catch (e) {
    send({ t: "problem", text: short(e) });
  }
  await sleep(50);
  try { sock.end(); } catch (e) {}
}

function wait(ms) {
  return new Promise((r) => {
    const done = () => { clearTimeout(t); waiters.delete(done); r(); };
    const t = setTimeout(done, ms);
    waiters.add(done);
    if (closed) done();
  });
}

function cleanList(spaces) {
  // Workspace 0 and the person's own windows (ownership "user") never leave the browser.
  return spaces
    .filter((s) => s && s.id !== 0 && s.ownership !== "user")
    .map((s) => ({ id: Number(s.id), name: String(s.name == null ? "" : s.name), ownership: String(s.ownership || ""), recent: Array.isArray(s.recentTabTitles) ? s.recentTabTitles.slice(0, 20).map((x) => String(x)) : [] }));
}

async function findSpace(id) {
  const spaces = await listTaskSpaces();
  return spaces.find((s) => s.id === id);
}

function tabList(tabs) {
  return tabs.map((t) => ({ id: String(t.targetId || ""), label: t.label || null, title: String(t.title || ""), url: String(t.url || ""), active: !!t.active })).filter((t) => t.id);
}

// ---------------------------------------------------------------- lister

async function lister(handlers, ended) {
  let rate = CONFIG.rate;
  let own = null;
  let last = "";
  async function listOnce(force) {
    const out = cleanList(await listTaskSpaces());
    const text = JSON.stringify(out);
    if (force || text !== last) { last = text; send({ t: "list", spaces: out }); }
  }
  async function ownTask(create) {
    const s = (await listTaskSpaces()).find((x) => x.name === CONFIG.ownName && x.ownership === "agent");
    if (!s && !create) return null;
    if (!own || !s || own.spaceId !== s.id) own = await taskSpace(CONFIG.ownName);
    return own;
  }
  handlers.rate = async (c) => { rate = Math.max(250, Number(c.ms) || 5000); wakeAll(); };
  handlers.list = async () => { await listOnce(true); };
  handlers.own = async (c) => {
    const t = await ownTask(true);
    if (c.url) {
      const tabs = await t.tabs();
      const front = tabs.find((x) => x.active && x.label) || tabs.find((x) => x.label);
      const page = front ? t.page(front.label) : t.page("p1");
      await page.goto(c.url, { waitUntil: "commit", timeout: 20000 });
    }
    await listOnce(true);
    return { spaceId: t.spaceId };
  };
  handlers.close = async (c) => {
    const t = await ownTask(false);
    if (!t || t.spaceId !== c.spaceId) return { closed: false };
    try { for (const tab of await t.tabs()) if (!tab.label && tab.targetId) await t.cdp("Target.closeTarget", { targetId: tab.targetId }); } catch (e) {}
    await t.finish({ keep: [] });
    own = null;
    await listOnce(true);
    return { closed: true };
  };
  while (!closed) {
    try { await listOnce(false); } catch (e) { send({ t: "problem", text: short(e) }); }
    await wait(rate);
  }
}

// ---------------------------------------------------------------- peek

async function peek() {
  const s = await findSpace(CONFIG.spaceId);
  if (!s || CONFIG.spaceId === 0) { send({ t: "gone", reason: "closed" }); return; }
  if (s.ownership !== "agent") { send({ t: "gone", reason: s.ownership === "agentDelegatedToUser" ? "handed" : "closed" }); return; }
  const task = await taskSpace(CONFIG.spaceId);
  send({ t: "tabs", pages: tabList(await task.tabs()) });
}

// ---------------------------------------------------------------- watcher

async function watcher(handlers, ended) {
  const SPACE = CONFIG.spaceId;
  const s = await findSpace(SPACE);
  if (!s || SPACE === 0) { send({ t: "gone", reason: "closed" }); return; }
  if (s.ownership !== "agent") { send({ t: "gone", reason: s.ownership === "agentDelegatedToUser" ? "handed" : "closed" }); return; }
  const task = await taskSpace(SPACE);
  let tabs = [];
  let lastTabs = "";
  let gone = false;
  const wanted = new Set();
  // How sharp each watched key needs its pictures (screen pixels per page pixel); the largest asked wins.
  const ratios = new Map();
  const forced = new Set();
  // Pages whose sharp still picture went out since they last changed.
  const crispDone = new Set();
  const lastData = new Map();
  const lastChange = new Map();
  const dialogs = new Map();
  const cut = new Map();
  // The open choices of a drop-down list, by page: where the list is, and the address it was opened on.
  const choices = new Map();
  // A press that opened the choices: its release does not reach the page either.
  const swallow = new Set();
  function openChoices(id, c) {
    const tab = tabs.find((t) => String(t.targetId) === id);
    choices.set(id, { path: c.path, url: tab ? String(tab.url || "") : "" });
    send({ t: "prompt", pageId: id, prompt: { kind: "choices", x: c.box.x, y: c.box.y, width: c.box.width, height: c.box.height, options: c.options } });
  }
  function closeChoices(id) {
    swallow.delete(id);
    if (choices.delete(id)) send({ t: "prompt", pageId: id, prompt: null });
  }

  function handle(tab) {
    if (tab.label) return task.page(tab.label);
    if (tab.page) return tab.page;
    return null;
  }
  function tabOf(key) {
    if (key === "front") return tabs.find((t) => t.active) || tabs[0];
    return tabs.find((t) => String(t.targetId) === key);
  }
  async function refreshTabs() {
    tabs = await task.tabs();
    // Choices close when their page moves elsewhere or closes.
    for (const [id, c] of [...choices]) {
      const tab = tabs.find((t) => String(t.targetId) === id);
      if (!tab || String(tab.url || "") !== c.url) closeChoices(id);
    }
    const list = tabList(tabs);
    const text = JSON.stringify(list);
    if (text !== lastTabs) { lastTabs = text; send({ t: "tabs", pages: list }); }
  }
  async function metrics(page) {
    const m = await page.cdp("Page.getLayoutMetrics");
    const css = m.cssVisualViewport || m.cssLayoutViewport;
    return { x: css.pageX || 0, y: css.pageY || 0, w: Math.max(1, Math.round(css.clientWidth)), h: Math.max(1, Math.round(css.clientHeight)) };
  }
  async function checkDialog(id, page) {
    let d = null;
    try { const info = await page.info(); d = info && info.dialog ? { type: String(info.dialog.type || "alert"), message: String(info.dialog.message || "").slice(0, 2000), defaultPrompt: String(info.dialog.defaultPrompt || "").slice(0, 2000) } : null; } catch (e) {}
    const before = JSON.stringify(dialogs.get(id) || null);
    if (d) dialogs.set(id, d); else dialogs.delete(id);
    if (JSON.stringify(d) !== before) send({ t: "dialog", pageId: id, dialog: d });
    return d;
  }
  function ratioOf(id) {
    let r = 0;
    for (const key of wanted) { const tab = tabOf(key); if (tab && String(tab.targetId) === id) r = Math.max(r, ratios.get(key) || 1); }
    return Math.min(CONFIG.maxScale, Math.max(CONFIG.minScale, r || 1));
  }
  // A picture of what the page shows now. "move": light and quick, while the page changes (JPEG at
  // quality 60, never above the page's own size). "crisp": once the page stands still, at the size
  // the viewer draws it (up to twice the page's size), as PNG, or WebP when a PNG would be large.
  // Taking a picture at a scale other than 1 does not touch the page: no resize, no change of
  // devicePixelRatio or of a resolution query, no layout (docs/build/notes-2g-tabs.md).
  async function capture(tab, kind) {
    const id = String(tab.targetId);
    const page = handle(tab);
    if (!page) return null;
    if (dialogs.has(id)) { const d = await checkDialog(id, page); if (d) return null; }
    try {
      const m = await metrics(page);
      const ratio = ratioOf(id);
      const clip = (scale) => ({ x: m.x, y: m.y, width: m.w, height: m.h, scale });
      if (kind === "crisp") {
        const scale = Math.min(ratio, CONFIG.crispMaxWidth / m.w, CONFIG.crispMaxHeight / m.h);
        let r = await page.cdp("Page.captureScreenshot", { format: "png", clip: clip(scale) });
        let type = "image/png";
        if (r.data.length * 0.75 > CONFIG.pngMaxBytes) {
          r = await page.cdp("Page.captureScreenshot", { format: "webp", quality: 90, clip: clip(scale) });
          type = "image/webp";
        }
        return { id, data: r.data, type, width: m.w, height: m.h };
      }
      const scale = Math.min(1, ratio, CONFIG.maxWidth / m.w, CONFIG.maxHeight / m.h);
      const r = await page.cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: clip(scale) });
      return { id, data: r.data, type: "image/jpeg", width: m.w, height: m.h };
    } catch (e) {
      if (/dialog/i.test(short(e))) await checkDialog(id, page);
      return null;
    }
  }
  const keyPage = new Map();
  async function pictures() {
    while (!closed && !gone) {
      // Any look at a page makes it the page in front in this browser. A picture of a front page
      // that is no longer in front (the bot just went to another page) would pull it back, so the
      // list is read again right before the pictures of a watch that follows the front.
      if (wanted.has("front")) { try { await refreshTabs(); } catch (e) {} }
      const done = new Set();
      for (const key of [...wanted]) {
        const tab = tabOf(key);
        if (!tab || done.has(String(tab.targetId))) continue;
        done.add(String(tab.targetId));
        // A watch that follows the front page shows a page it switched to at once, changed or not.
        if (keyPage.get(key) !== String(tab.targetId)) { keyPage.set(key, String(tab.targetId)); forced.add(String(tab.targetId)); }
        const shot = await capture(tab, "move");
        if (!shot) continue;
        const force = forced.has(shot.id);
        // A picture goes again when the page's address or title changed, also when it looks the same:
        // the list of pages, where the address comes from, is read a moment after the picture.
        const url = String(tab.url || "");
        const title = String(tab.title || "");
        const sig = url + "\n" + title + "\n" + shot.data;
        if (force || sig !== lastData.get(shot.id)) {
          forced.delete(shot.id);
          if (send({ t: "frame", pageId: shot.id, data: shot.data, type: shot.type, width: shot.width, height: shot.height, url, title })) {
            lastData.set(shot.id, sig);
            lastChange.set(shot.id, Date.now());
            crispDone.delete(shot.id);
          }
        } else if (!crispDone.has(shot.id) && Date.now() - (lastChange.get(shot.id) || 0) >= CONFIG.stillMs) {
          // The page stood still for a moment: one more picture, of the best quality.
          const crisp = await capture(tab, "crisp");
          if (crisp && !forced.has(crisp.id) && send({ t: "frame", pageId: crisp.id, data: crisp.data, type: crisp.type, width: crisp.width, height: crisp.height, url, title })) crispDone.add(crisp.id);
        }
      }
      const now = Date.now();
      const busy = forced.size > 0 || [...lastChange.values()].some((t) => now - t < 2000);
      // A still page that has not had its sharp picture yet is looked at again soon.
      await wait(wanted.size === 0 ? CONFIG.slowShotMs * 2 : busy ? CONFIG.fastShotMs : CONFIG.slowShotMs);
    }
  }
  async function watchList() {
    let n = 0;
    while (!closed && !gone) {
      try {
        await refreshTabs();
        if (n++ % 2 === 0) {
          const now = await findSpace(SPACE);
          if (!now) { gone = true; send({ t: "gone", reason: "closed" }); break; }
          if (now.ownership !== "agent") { gone = true; send({ t: "gone", reason: now.ownership === "agentDelegatedToUser" ? "handed" : "closed" }); break; }
        }
      } catch (e) {
        if (/hard stop|control of this task space/i.test(short(e))) { gone = true; send({ t: "gone", reason: "handed" }); break; }
      }
      await wait(CONFIG.tabsMs);
    }
  }
  function pageFor(id) {
    const tab = tabs.find((t) => String(t.targetId) === id);
    const page = tab ? handle(tab) : null;
    if (!page) throw new Error("page gone");
    return page;
  }
  handlers.want = async (c) => {
    const before = new Map(ratios);
    wanted.clear();
    ratios.clear();
    for (const k of c.keys || []) wanted.add(String(k));
    for (const [k, r] of Object.entries(c.ratios || {})) if (Number(r) > 0) ratios.set(String(k), Number(r));
    // A watch that asks for another size gets a sharp picture of that size again.
    for (const k of wanted) if ((before.get(k) || 1) !== (ratios.get(k) || 1)) { const tab = tabOf(k); if (tab) { crispDone.delete(String(tab.targetId)); forced.add(String(tab.targetId)); } }
    wakeAll();
  };
  handlers.first = async (c) => {
    await refreshTabs();
    const tab = tabOf(String(c.key));
    if (!tab) return { missing: true };
    const id = String(tab.targetId);
    const page = handle(tab);
    let m = { w: 0, h: 0 };
    try { m = await metrics(page); } catch (e) {}
    return { pageId: id, width: m.w, height: m.h, url: String(tab.url || ""), title: String(tab.title || "") };
  };
  handlers.force = async (c) => {
    const id = String(c.pageId);
    forced.add(id);
    lastData.delete(id);
    crispDone.delete(id);
    wakeAll();
  };
  // Shows a page of the workspace. With front, it also comes to the front in the browser, as a click
  // on its tab would: Target.activateTarget switches the tab without raising the browser's window or
  // taking the Mac's focus (Page.bringToFront also gives the page the focus; not used).
  handlers.show = async (c) => {
    await refreshTabs();
    const tab = tabs.find((t) => String(t.targetId) === String(c.pageId));
    if (!tab) throw new Error("page gone");
    if (c.front && !tab.active) {
      await task.cdp("Target.activateTarget", { targetId: String(tab.targetId) });
      await refreshTabs();
    }
    const now = tabs.find((t) => String(t.targetId) === String(c.pageId));
    return { active: !!(now && now.active) };
  };
  // A new page in the workspace, in front, at an address when given.
  handlers.open = async (c) => {
    const page = await task.newPage();
    const id = String(page.targetId || "");
    if (c.url) { try { await page.goto(String(c.url), { waitUntil: "commit", timeout: 20000 }); } catch (e) {} }
    try { if (id) await task.cdp("Target.activateTarget", { targetId: id }); } catch (e) {}
    await refreshTabs();
    const tab = tabs.find((t) => String(t.targetId) === id) || tabs.find((t) => t.active);
    return { pageId: tab ? String(tab.targetId) : id };
  };
  // Closes one page of the workspace (never the last one: the engine checks).
  handlers.closePage = async (c) => {
    await refreshTabs();
    const tab = tabs.find((t) => String(t.targetId) === String(c.pageId));
    if (!tab) throw new Error("page gone");
    if (tab.label) await task.page(tab.label).close();
    else await task.cdp("Target.closeTarget", { targetId: String(tab.targetId) });
    closeChoices(String(tab.targetId));
    dialogs.delete(String(tab.targetId));
    await refreshTabs();
  };
  // A step that opens a dialog (a click on a button that calls confirm) does not come back until the
  // dialog is answered. After a moment the rest waits: the dialog is reported and answered first.
  async function step(page, id, method, params) {
    let done = false;
    const call = page.cdp(method, params).then(() => { done = true; }, () => { done = true; });
    await Promise.race([call, sleep(1500)]);
    if (done) return true;
    const d = await checkDialog(id, page);
    if (d) return false;
    await call;
    return true;
  }
  handlers.input = async (c) => {
    const id = String(c.pageId);
    const page = pageFor(id);
    for (const s of c.steps || []) {
      if (dialogs.has(id)) break;
      // While the choices of a drop-down list are open, nothing else reaches the page.
      if (choices.has(id)) continue;
      if (s.method === "Input.dispatchMouseEvent" && s.params && s.params.type === "mouseReleased" && swallow.has(id)) {
        swallow.delete(id);
        continue;
      }
      if (s.pick || s.keyPick) {
        // A press on a drop-down list, or a key that opens one with the focus: the browser would draw
        // its choices outside the page, where nobody sees them. The choices go to the app instead.
        let found = null;
        try { found = await page.evaluate(dropDownAt, s.pick ? { x: s.pick.x, y: s.pick.y } : { focused: true }); } catch (e) {}
        if (found && Array.isArray(found.options)) {
          openChoices(id, found);
          if (s.pick) swallow.add(id);
          continue;
        }
        const st = s.pick ? s.pick.step : s.keyPick;
        if (!(await step(page, id, st.method, st.params))) break;
        continue;
      }
      if (s.save) {
        cut.set(id, String(await page.evaluate(selectionText) || ""));
        continue;
      }
      if (s.focus) {
        const editable = !!(await page.evaluate(focusEditable));
        const pick = editable ? s.focus.editable : s.focus.plain;
        for (const p of pick || []) if (!(await step(page, id, p.method, p.params))) break;
        continue;
      }
      if (!(await step(page, id, s.method, s.params))) break;
    }
    lastChange.set(id, Date.now());
    wakeAll();
  };
  handlers.go = async (c) => {
    const page = pageFor(String(c.pageId));
    if (c.url) { await page.goto(String(c.url), { waitUntil: "commit", timeout: 20000 }); return; }
    if (c.to === "reload") { await page.cdp("Page.reload", {}); return; }
    const h = await page.cdp("Page.getNavigationHistory");
    const next = h.currentIndex + (c.to === "back" ? -1 : 1);
    if (next < 0 || next >= h.entries.length) return { moved: false };
    await page.cdp("Page.navigateToHistoryEntry", { entryId: h.entries[next].id });
    return { moved: true };
  };
  handlers.selection = async (c) => {
    const id = String(c.pageId);
    const page = pageFor(id);
    const text = String(await page.evaluate(selectionText) || "");
    const saved = cut.get(id) || "";
    cut.delete(id);
    return { text: text || saved };
  };
  handlers.choose = async (c) => {
    const id = String(c.pageId);
    const open = choices.get(id);
    if (!open) return { open: false };
    let chosen = false;
    if (typeof c.index === "number") {
      try { chosen = !!(await pageFor(id).evaluate(chooseOption, { path: open.path, index: c.index })); } catch (e) {}
    }
    closeChoices(id);
    lastChange.set(id, Date.now());
    wakeAll();
    return { open: true, chosen };
  };
  handlers.dialog = async (c) => {
    const page = pageFor(String(c.pageId));
    await page.cdp("Page.handleJavaScriptDialog", { accept: !!c.accept, ...(typeof c.text === "string" ? { promptText: c.text } : {}) });
    await checkDialog(String(c.pageId), page);
    lastChange.set(String(c.pageId), Date.now());
    wakeAll();
  };
  await refreshTabs();
  send({ t: "ready" });
  await Promise.race([Promise.all([pictures(), watchList()]), ended]);
}

function selectionText() {
  const el = document.activeElement;
  if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|tel|email|password|number)?$/i.test(el.type || ""))) && typeof el.selectionStart === "number") {
    if (el.type === "password") return "";
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  const s = window.getSelection();
  return s ? s.toString() : "";
}

// A drop-down list (a select that is not multiple and shows one line) under a point of the top page,
// or the one that has the focus, also inside a frame of the same site. Its box is in the top page's
// pixels; path finds it again (the frames' places, then its place among the frame's lists).
function dropDownAt(a) {
  function isDrop(el) { return !!el && el.tagName === "SELECT" && !el.multiple && !(el.size > 1) && !el.disabled; }
  function frameIn(doc, el) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner) return null;
    const r = el.getBoundingClientRect();
    return { inner: inner, x: r.left + el.clientLeft, y: r.top + el.clientTop, index: Array.prototype.indexOf.call(doc.querySelectorAll("iframe,frame"), el) };
  }
  let doc = document, ox = 0, oy = 0, el = null;
  const path = [];
  if (a && a.focused) {
    el = doc.activeElement;
    for (let d = 0; d < 10 && el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); d++) {
      const f = frameIn(doc, el);
      if (!f) return null;
      ox += f.x; oy += f.y; path.push(f.index); doc = f.inner; el = doc.activeElement;
    }
  } else {
    let x = Number(a.x), y = Number(a.y);
    el = doc.elementFromPoint(x, y);
    for (let d = 0; d < 10 && el && (el.tagName === "IFRAME" || el.tagName === "FRAME"); d++) {
      const f = frameIn(doc, el);
      if (!f) return null;
      ox += f.x; oy += f.y; x -= f.x; y -= f.y; path.push(f.index); doc = f.inner; el = doc.elementFromPoint(x, y);
    }
    if (el && el.tagName !== "SELECT" && el.closest) el = el.closest("select");
  }
  if (!isDrop(el)) return null;
  path.push(Array.prototype.indexOf.call(doc.querySelectorAll("select"), el));
  const options = [];
  for (let i = 0; i < el.options.length && i < 2000; i++) {
    const o = el.options[i];
    const g = o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement : null;
    const item = { label: String(o.label || o.text || "").replace(/\s+/g, " ").trim().slice(0, 300), selected: !!o.selected, disabled: !!(o.disabled || (g && g.disabled)) };
    if (g) item.group = String(g.label || "").replace(/\s+/g, " ").trim().slice(0, 300);
    options.push(item);
  }
  if (!a || !a.focused) { try { el.focus({ preventScroll: true }); } catch (e) {} }
  const b = el.getBoundingClientRect();
  return { path: path, box: { x: Math.round(ox + b.left), y: Math.round(oy + b.top), width: Math.round(b.width), height: Math.round(b.height) }, options: options };
}

// Chooses an option the way a person would: the list's value changes and the page hears input and change.
function chooseOption(a) {
  let doc = document;
  const path = a.path || [];
  for (let i = 0; i < path.length - 1; i++) {
    const fr = doc.querySelectorAll("iframe,frame")[path[i]];
    let inner = null;
    try { inner = fr && fr.contentDocument; } catch (e) { inner = null; }
    if (!inner) return false;
    doc = inner;
  }
  const el = doc.querySelectorAll("select")[path[path.length - 1]];
  if (!el || el.tagName !== "SELECT" || el.disabled) return false;
  const o = el.options[a.index];
  if (!o || o.disabled || (o.parentElement && o.parentElement.tagName === "OPTGROUP" && o.parentElement.disabled)) return false;
  try { el.focus({ preventScroll: true }); } catch (e) {}
  if (el.selectedIndex !== a.index) {
    el.selectedIndex = a.index;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

function focusEditable() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(el.type || "");
}
`;
