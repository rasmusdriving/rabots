// The mock engine's browser (step 2g): workspaces with pages, a live picture of a made-up page drawn
// by the mock itself and handed out as JPEG data, input that shows on the page (a click leaves a
// mark, typed text appears, a wheel scrolls, a move to an address changes the title and host), the
// person's own page, and the rules of the protocol: one watch per connection, control needed for
// input and moves, only http and https addresses. Round two: two drop-down lists whose choices come
// as "browser.prompt" (as on the Mac, where the browser draws an open list outside the page), and
// two buttons where the page asks a question (a confirm and a prompt), answered with "browser.answer".
// Round three: "browser.view" (pictures at the size the window draws them: light JPEG while the page
// changes, never above its own size; one sharp PNG half a second after it stood still, up to twice
// its size), "browser.page.show", and in the person's own page "browser.page.open" and ".close".
import type { BrowserInput, BrowserPage, BrowserPrompt, BrowserSpace, BrowserState, Events, Methods } from "../../shared/protocol";
import { EngineError } from "./types";

interface MockPage {
  id: string;
  url: string;
  title: string;
  width: number;
  height: number;
  clicks: { x: number; y: number }[];
  text: string;
  scroll: number;
  selected: string;
  history: { url: string; title: string }[];
  at: number;
  /** The chosen option of each drop-down list, by index. */
  lists: number[];
  /** The drop-down list with the focus, if any. */
  focusList: number | null;
  /** The page's own question while it waits, and the last answer it heard. */
  dialog: Extract<BrowserPrompt, { kind: "dialog" }> | null;
  heard: string;
}

interface MockSpace {
  id: string;
  name: string;
  owner: BrowserSpace["owner"];
  botId?: string;
  pages: MockPage[];
  activeId: string;
  busy: boolean;
  controlled: boolean;
}

interface Watch {
  id: string;
  spaceId: string;
  /** Left out: follows the front page. */
  pageId?: string;
  seq: number;
  timer: ReturnType<typeof setInterval>;
  /** What the last picture showed, so a picture is sent only when something changed. */
  last: string;
  /** Screen pixels per page pixel where the window draws the picture. */
  ratio: number;
  /** The sharp picture that follows half a second after the last change. */
  crisp?: ReturnType<typeof setTimeout>;
}

const NOT_INSTALLED = "The browser is not set up on this Mac. Install it there to watch the bots work in it.";
const REFUSED = "Only addresses that start with http or https can be opened.";
const LINK = { x: 48, y: 360, w: 220, h: 44 };
const FIELD = { x: 48, y: 440, w: 520, h: 44 };
/** The buttons where the page asks: a confirm and a prompt. */
const ASK = { x: 960, y: 420, w: 120, h: 44 };
const NAME = { x: 1100, y: 420, w: 120, h: 44 };
type ListOption = { label: string; disabled?: boolean; group?: string };
/** Two drop-down lists: a short one with a disabled option and group headings, and a long one. */
const LISTS: { x: number; y: number; w: number; h: number; label: string; options: ListOption[] }[] = [
  {
    x: 960,
    y: 260,
    w: 260,
    h: 44,
    label: "Repeats",
    options: [
      { label: "Every week" },
      { label: "Every month" },
      { label: "Only once", disabled: true },
      { label: "Every quarter", group: "Less often" },
      { label: "Every half year", group: "Less often" },
      { label: "Every year", group: "Less often" },
    ],
  },
  { x: 960, y: 340, w: 260, h: 44, label: "Day", options: Array.from({ length: 31 }, (_, i) => ({ label: `Day ${i + 1} of the month` })) },
];
const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** A title for an address the person moved to: a made-up one for the example hosts. */
function titleFor(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)example\.(com|org|net)$/.test(u.hostname)) return "Example Domain";
    if (u.hostname === "claude.ai") return "Claude";
    return u.hostname;
  } catch {
    return url;
  }
}

export class MockBrowser {
  private spaces: MockSpace[] = [];
  private watch: Watch | null = null;
  private nextId = 1;
  available: boolean;
  problem: string | undefined;
  /** How long the first picture of a watch takes, in ms. */
  firstDelay = 40;
  /** Every batch of input that reached a page, in order. */
  readonly inputs: BrowserInput[][] = [];
  framesSent = 0;
  /** Every ratio the window asked for, in order (with "browser.watch" and "browser.view"). */
  readonly ratios: number[] = [];
  /** Every "browser.page.show" the window asked for, in order (undefined: follow the front page). */
  readonly shows: (string | undefined)[] = [];
  /** How long a page stands still before its sharp picture, in ms. */
  stillMs = 500;
  /** Pictures as before round three (JPEG at the page's own size, no sharp one), for comparing. */
  before = false;
  private canvas: HTMLCanvasElement | null = null;

  constructor(
    private readonly emit: (
      e:
        | { event: "browser.changed"; data: Events["browser.changed"] }
        | { event: "browser.frame"; data: Events["browser.frame"] }
        | { event: "browser.ended"; data: Events["browser.ended"] }
        | { event: "browser.prompt"; data: Events["browser.prompt"] },
    ) => void,
    /** Roster order, so the bots' workspaces come first in it. */
    private readonly botOrder: () => string[],
    on: boolean,
  ) {
    this.available = on;
    this.problem = on ? undefined : NOT_INSTALLED;
  }

  // ------------------------------------------------------------ seeding and levers

  page(url: string, title: string, size: { width: number; height: number } = { width: 1280, height: 800 }): MockPage {
    return { id: `p${this.nextId++}`, url, title, ...size, clicks: [], text: "", scroll: 0, selected: "", history: [{ url, title }], at: 0, lists: LISTS.map(() => 0), focusList: null, dialog: null, heard: "" };
  }

  addSpace(s: Omit<MockSpace, "activeId" | "busy" | "controlled"> & { busy?: boolean }): MockSpace {
    const space: MockSpace = { busy: false, controlled: false, ...s, activeId: s.pages[0]!.id };
    this.spaces.push(space);
    this.changed();
    return space;
  }

  space(id: string): MockSpace {
    const s = this.spaces.find((x) => x.id === id);
    if (!s) throw new EngineError({ code: "not_found", message: "That work in the browser is closed." });
    return s;
  }

  has(id: string): boolean {
    return this.spaces.some((x) => x.id === id);
  }

  setBusy(id: string, busy: boolean): void {
    const s = this.spaces.find((x) => x.id === id);
    if (!s || s.busy === busy) return;
    s.busy = busy;
    this.changed();
  }

  /** The page in front moves somewhere else, as when a bot clicks a link. */
  navigate(id: string, url: string, title: string): void {
    const s = this.space(id);
    const p = s.pages.find((x) => x.id === s.activeId)!;
    p.url = url;
    p.title = title;
    p.history.push({ url, title });
    p.at = p.history.length - 1;
    p.clicks = [];
    p.scroll = 0;
    const asked = !!p.dialog || this.choices?.pageId === p.id;
    p.dialog = null;
    if (asked) this.prompted(s, p, null);
    this.changed();
    this.picture(true);
  }

  /** The workspace is closed in the browser: anyone watching it gets "closed". */
  close(id: string): void {
    if (!this.spaces.some((x) => x.id === id)) return;
    this.spaces = this.spaces.filter((x) => x.id !== id);
    if (this.watch?.spaceId === id) this.end("closed");
    this.changed();
  }

  setAvailable(on: boolean, problem?: string): void {
    this.available = on;
    this.problem = on ? undefined : (problem ?? NOT_INSTALLED);
    if (!on && this.watch) this.end("gone");
    this.changed();
  }

  /** The connection went away: its watch and control end with it. */
  connectionEnded(): void {
    if (!this.watch) return;
    clearInterval(this.watch.timer);
    clearTimeout(this.watch.crisp);
    const s = this.spaces.find((x) => x.id === this.watch!.spaceId);
    this.watch = null;
    if (s?.controlled) s.controlled = false;
  }

  /** A new page opens in front, as when a bot opens one (or a link opens a new page). */
  openPage(spaceId: string, url: string, title: string): string {
    const s = this.space(spaceId);
    const p = this.page(url, title, this.sizeOf(s));
    s.pages.push(p);
    s.activeId = p.id;
    this.changed();
    if (this.watch?.spaceId === s.id && !this.watch.pageId) this.picture(true);
    return p.id;
  }

  /** Another page comes to the front, as when a bot works in it. */
  front(spaceId: string, pageId: string): void {
    const s = this.space(spaceId);
    if (!s.pages.some((x) => x.id === pageId) || s.activeId === pageId) return;
    s.activeId = pageId;
    this.changed();
    const w = this.watch;
    if (w?.spaceId === s.id && !w.pageId) {
      const now = this.shownPage(s, w);
      this.emit({ event: "browser.prompt", data: { watchId: w.id, ...(now.dialog ? { prompt: now.dialog } : {}) } });
      this.picture(true);
    }
  }

  /** A page closes, as when its bot closes it. A watch on it goes on with the page in front. */
  closePage(spaceId: string, pageId: string): void {
    const s = this.space(spaceId);
    const i = s.pages.findIndex((x) => x.id === pageId);
    if (i < 0 || s.pages.length < 2) return;
    s.pages.splice(i, 1);
    if (s.activeId === pageId) s.activeId = (s.pages[i] ?? s.pages[i - 1])!.id;
    if (this.choices?.pageId === pageId) this.choices = null;
    const w = this.watch;
    if (w?.spaceId === s.id && w.pageId === pageId) w.pageId = undefined;
    this.changed();
    if (w?.spaceId === s.id) {
      const now = this.shownPage(s, w);
      this.emit({ event: "browser.prompt", data: { watchId: w.id, ...(now.dialog ? { prompt: now.dialog } : {}) } });
      this.picture(true);
    }
  }

  private sizeOf(s: MockSpace): { width: number; height: number } {
    const p = s.pages[0];
    return p ? { width: p.width, height: p.height } : { width: 1280, height: 800 };
  }

  private shownPage(s: MockSpace, w: Watch): MockPage {
    return s.pages.find((x) => x.id === (w.pageId ?? s.activeId)) ?? s.pages.find((x) => x.id === s.activeId)!;
  }

  /** A page asks a question by itself (the page in front, or the one named); with null, the bot answered it. */
  ask(spaceId: string, dialog: Extract<BrowserPrompt, { kind: "dialog" }> | null, pageId?: string): void {
    const s = this.space(spaceId);
    const p = s.pages.find((x) => x.id === (pageId ?? s.activeId))!;
    p.dialog = dialog;
    if (!dialog) p.heard = "Answered elsewhere";
    this.prompted(s, p);
  }

  /** What the page shows outside its picture, to the watch on it. */
  private prompted(s: MockSpace, p: MockPage, choices?: Extract<BrowserPrompt, { kind: "choices" }> | null): void {
    if (choices !== undefined) this.choices = choices ? { pageId: p.id, prompt: choices } : null;
    const w = this.watch;
    if (!w || w.spaceId !== s.id || (w.pageId ?? s.activeId) !== p.id) return;
    const prompt = p.dialog ?? (this.choices?.pageId === p.id ? this.choices.prompt : undefined);
    this.emit({ event: "browser.prompt", data: { watchId: w.id, ...(prompt ? { prompt } : {}) } });
    if (!prompt) this.picture(true);
  }

  /** The open choices of a drop-down list, when there are some. */
  private choices: { pageId: string; prompt: Extract<BrowserPrompt, { kind: "choices" }> } | null = null;

  private openChoices(s: MockSpace, p: MockPage, list: number): void {
    const l = LISTS[list]!;
    p.focusList = list;
    this.prompted(s, p, {
      kind: "choices",
      x: l.x,
      y: l.y - p.scroll,
      width: l.w,
      height: l.h,
      options: l.options.map((o, i) => ({ label: o.label, selected: i === p.lists[list], disabled: !!o.disabled, ...(o.group ? { group: o.group } : {}) })),
    });
  }

  watching(): { spaceId: string; pageId?: string; shown?: string; ratio?: number } | null {
    const w = this.watch;
    if (!w) return null;
    const s = this.spaces.find((x) => x.id === w.spaceId);
    return { spaceId: w.spaceId, pageId: w.pageId, ...(s ? { shown: this.shownPage(s, w).id } : {}), ratio: w.ratio };
  }

  pageOf(spaceId: string): { url: string; title: string; text: string; scroll: number; clicks: { x: number; y: number }[]; selected: string; lists: string[]; heard: string; asking: boolean } | null {
    const s = this.spaces.find((x) => x.id === spaceId);
    const p = s?.pages.find((x) => x.id === s.activeId);
    return p
      ? { url: p.url, title: p.title, text: p.text, scroll: p.scroll, clicks: [...p.clicks], selected: p.selected, lists: p.lists.map((i, n) => LISTS[n]!.options[i]!.label), heard: p.heard, asking: !!p.dialog }
      : null;
  }

  /** Where the lists and the asking buttons are on the made-up page, in its own pixels. */
  static places() {
    return { lists: LISTS.map(({ x, y, w, h }) => ({ x, y, w, h })), ask: ASK, name: NAME, link: LINK, field: FIELD };
  }

  // ------------------------------------------------------------ the state

  state(): BrowserState {
    if (!this.available) return { available: false, problem: this.problem, spaces: [] };
    const order = this.botOrder();
    const rank = (s: MockSpace) => (s.owner === "bot" ? 0 : s.owner === "you" ? 1 : 2);
    const spaces = [...this.spaces].sort((a, b) => rank(a) - rank(b) || (a.owner === "bot" && b.owner === "bot" ? order.indexOf(a.botId!) - order.indexOf(b.botId!) : 0));
    return {
      available: true,
      spaces: spaces.map((s) => ({
        id: s.id,
        name: s.owner === "you" ? "Your page" : s.name,
        owner: s.owner,
        ...(s.botId ? { botId: s.botId } : {}),
        pages: s.pages.map((p): BrowserPage => ({ id: p.id, title: p.title, url: p.url, active: p.id === s.activeId })),
        busy: s.busy,
        controlled: s.controlled,
      })),
    };
  }

  private changed(): void {
    this.emit({ event: "browser.changed", data: { state: this.state() } });
  }

  private need(): void {
    if (!this.available) throw new EngineError({ code: "unavailable", message: this.problem ?? NOT_INSTALLED });
  }

  private watched(watchId: string): { w: Watch; s: MockSpace; p: MockPage } {
    const w = this.watch;
    if (!w || w.id !== watchId) throw new EngineError({ code: "not_found", message: "That picture has ended." });
    const s = this.space(w.spaceId);
    const p = s.pages.find((x) => x.id === (w.pageId ?? s.activeId)) ?? s.pages.find((x) => x.id === s.activeId)!;
    return { w, s, p };
  }

  private needControl(watchId: string): { w: Watch; s: MockSpace; p: MockPage } {
    const got = this.watched(watchId);
    if (!got.s.controlled) throw new EngineError({ code: "conflict", message: "Take control first." });
    return got;
  }

  // ------------------------------------------------------------ requests

  handlers: { [M in Extract<keyof Methods, `browser.${string}`>]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "browser.state": () => this.state(),
    "browser.watch": (p) => {
      this.need();
      const s = this.space(p.spaceId);
      if (p.pageId && !s.pages.some((x) => x.id === p.pageId)) throw new EngineError({ code: "not_found", message: "That page is closed." });
      if (this.watch) this.end("replaced");
      const w: Watch = { id: `w${this.nextId++}`, spaceId: s.id, pageId: p.pageId, seq: 0, last: "", ratio: p.ratio ?? 1, timer: setInterval(() => this.picture(false), 500) };
      if (p.ratio !== undefined) this.ratios.push(p.ratio);
      this.watch = w;
      const page = s.pages.find((x) => x.id === (p.pageId ?? s.activeId))!;
      // The first picture comes at once (or as slow as the lever says), after the answer, and what
      // the page asks while it waits right after it.
      setTimeout(() => this.picture(true), this.firstDelay);
      if (page.dialog || this.choices?.pageId === page.id) setTimeout(() => this.prompted(s, page), this.firstDelay + 10);
      return { watchId: w.id, pageId: page.id, width: page.width, height: page.height };
    },
    "browser.view": (p) => {
      const { w } = this.watched(p.watchId);
      this.ratios.push(p.ratio);
      if (w.ratio !== p.ratio) {
        w.ratio = p.ratio;
        this.picture(true);
      }
      return {};
    },
    "browser.page.show": (p) => {
      const { w, s, p: before } = this.watched(p.watchId);
      if (p.pageId !== undefined && !s.pages.some((x) => x.id === p.pageId)) throw new EngineError({ code: "not_found", message: "That page is not open in the workspace any more." });
      this.shows.push(p.pageId);
      w.pageId = undefined;
      if (p.pageId !== undefined) {
        // The page comes to the front in the browser, with or without control (in the bots' browser
        // any look at a page does), and the watch follows the front.
        s.activeId = p.pageId;
        if (this.choices?.pageId === before.id) this.choices = null;
      }
      this.changed();
      const now = this.shownPage(s, w);
      if (now.id !== before.id) {
        const prompt = now.dialog ?? (this.choices?.pageId === now.id ? this.choices.prompt : undefined);
        setTimeout(() => this.watch === w && this.emit({ event: "browser.prompt", data: { watchId: w.id, ...(prompt ? { prompt } : {}) } }), 10);
      }
      setTimeout(() => this.watch === w && this.picture(true), 20);
      return { pageId: now.id, width: now.width, height: now.height };
    },
    "browser.page.open": (p) => {
      const { w, s } = this.needControl(p.watchId);
      if (s.owner !== "you") throw new EngineError({ code: "conflict", message: "Pages can only be opened and closed in Your page." });
      let url = "chrome://newtab/";
      if (p.url?.trim()) {
        const raw = p.url.trim();
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
        if (scheme && !/^https?$/i.test(scheme[1]!)) throw new EngineError({ code: "bad_request", message: REFUSED });
        url = scheme ? raw : `https://${raw}`;
      }
      const page = this.page(url, url.startsWith("chrome:") ? "New Tab" : titleFor(url), this.sizeOf(s));
      s.pages.push(page);
      s.activeId = page.id;
      w.pageId = undefined;
      this.choices = null;
      this.changed();
      setTimeout(() => this.watch === w && this.picture(true), 20);
      return { pageId: page.id };
    },
    "browser.page.close": (p) => {
      const { s } = this.needControl(p.watchId);
      if (s.owner !== "you") throw new EngineError({ code: "conflict", message: "Pages can only be opened and closed in Your page." });
      if (!s.pages.some((x) => x.id === p.pageId)) throw new EngineError({ code: "not_found", message: "That page is not open in the workspace any more." });
      if (s.pages.length < 2) throw new EngineError({ code: "conflict", message: "This is the last page. Close Your page instead." });
      this.closePage(s.id, p.pageId);
      return {};
    },
    "browser.unwatch": (p) => {
      if (this.watch?.id === p.watchId) {
        clearInterval(this.watch.timer);
        clearTimeout(this.watch.crisp);
        const s = this.spaces.find((x) => x.id === this.watch!.spaceId);
        this.watch = null;
        if (s?.controlled) {
          s.controlled = false;
          this.changed();
        }
      }
      return {};
    },
    "browser.control": (p) => {
      const { s, p: page } = this.watched(p.watchId);
      s.controlled = p.take;
      // Open choices close when control is handed back.
      if (!p.take && this.choices?.pageId === page.id) this.prompted(s, page, null);
      this.changed();
      return { controlled: s.controlled };
    },
    "browser.input": (p) => {
      const { s, p: page } = this.needControl(p.watchId);
      this.inputs.push(structuredClone(p.events));
      for (const e of p.events) this.apply(s, page, e);
      if (!page.dialog) this.picture(true);
      return {};
    },
    "browser.answer": (p) => {
      const { s, p: page } = this.needControl(p.watchId);
      const a = p.answer;
      if (a.kind === "dialog") {
        if (!page.dialog) throw new EngineError({ code: "conflict", message: "Nothing on the page waits for an answer." });
        page.heard = !a.accept ? "Cancel" : page.dialog.type === "prompt" ? `OK: ${a.text ?? page.dialog.defaultText ?? ""}` : "OK";
        page.dialog = null;
        this.prompted(s, page);
        return {};
      }
      const open = this.choices;
      if (!open || open.pageId !== page.id) throw new EngineError({ code: "conflict", message: "Nothing on the page waits for an answer." });
      const list = page.focusList ?? 0;
      if (a.index !== undefined && LISTS[list]!.options[a.index] && !LISTS[list]!.options[a.index]!.disabled) page.lists[list] = a.index;
      this.prompted(s, page, null);
      return {};
    },
    "browser.go": (p) => {
      const { s, p: page } = this.needControl(p.watchId);
      if (p.to === "back" || p.to === "forward") {
        const to = page.at + (p.to === "back" ? -1 : 1);
        if (to >= 0 && to < page.history.length) {
          page.at = to;
          page.url = page.history[to]!.url;
          page.title = page.history[to]!.title;
        }
      } else if (p.to === "reload") {
        page.clicks = [];
      } else {
        const raw = p.to.url.trim();
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
        if (scheme && !/^https?$/i.test(scheme[1]!)) throw new EngineError({ code: "bad_request", message: REFUSED });
        const url = scheme ? raw : `https://${raw}`;
        let ok = true;
        try {
          new URL(url);
        } catch {
          ok = false;
        }
        if (!ok) throw new EngineError({ code: "bad_request", message: REFUSED });
        page.history = page.history.slice(0, page.at + 1);
        page.url = url;
        page.title = titleFor(url);
        page.history.push({ url, title: page.title });
        page.at = page.history.length - 1;
        page.clicks = [];
        page.scroll = 0;
        page.text = "";
      }
      const asked = !!page.dialog || this.choices?.pageId === page.id;
      page.dialog = null;
      if (asked) this.prompted(s, page, null);
      this.changed();
      this.picture(true);
      return {};
    },
    "browser.selection": (p) => {
      const { p: page } = this.needControl(p.watchId);
      return { text: page.selected };
    },
    "browser.own": (p) => {
      this.need();
      let own = this.spaces.find((x) => x.owner === "you");
      // A new page with no address yet, as the browser's own new page is.
      if (!own) own = this.addSpace({ id: `s-you-${this.nextId++}`, name: "pobots: your page", owner: "you", pages: [p.url ? this.page(p.url, titleFor(p.url)) : this.page("chrome://newtab/", "New Tab")] });
      else if (p.url) {
        const page = own.pages.find((x) => x.id === own!.activeId)!;
        page.url = p.url;
        page.title = titleFor(p.url);
        page.history.push({ url: p.url, title: page.title });
        page.at = page.history.length - 1;
        this.changed();
        if (this.watch?.spaceId === own.id) this.picture(true);
      }
      return { space: this.state().spaces.find((x) => x.id === own!.id)! };
    },
    "browser.close": (p) => {
      const s = this.space(p.spaceId);
      if (s.owner !== "you") throw new EngineError({ code: "conflict", message: "Only your own page can be closed here." });
      this.close(s.id);
      return {};
    },
  };

  private end(reason: "closed" | "gone" | "replaced"): void {
    const w = this.watch;
    if (!w) return;
    clearInterval(w.timer);
    clearTimeout(w.crisp);
    this.watch = null;
    this.choices = null;
    const s = this.spaces.find((x) => x.id === w.spaceId);
    if (s?.controlled) s.controlled = false;
    this.emit({ event: "browser.ended", data: { watchId: w.id, reason } });
  }

  /** What one event does to the made-up page. */
  private apply(s: MockSpace, p: MockPage, e: BrowserInput): void {
    // While the page asks, only Enter and Escape answer it (as the engine does); open choices take nothing.
    if (p.dialog) {
      if (e.type === "key" && e.down && (e.key === "Enter" || e.key === "Escape")) {
        p.heard = e.key === "Enter" ? (p.dialog.type === "prompt" ? `OK: ${p.dialog.defaultText ?? ""}` : "OK") : "Cancel";
        p.dialog = null;
        this.prompted(s, p);
      }
      return;
    }
    if (this.choices?.pageId === p.id) return;
    if (e.type === "down" && (e.button ?? "left") === "left") {
      const y = e.y + p.scroll;
      const list = LISTS.findIndex((l) => inside(l, e.x, y));
      if (list >= 0) return this.openChoices(s, p, list);
      p.focusList = null;
      if (inside(ASK, e.x, y) && e.clicks === 1) {
        p.dialog = { kind: "dialog", type: "confirm", message: "Leave this page? The changes you made are not saved yet." };
        return this.prompted(s, p);
      }
      if (inside(NAME, e.x, y) && e.clicks === 1) {
        p.dialog = { kind: "dialog", type: "prompt", message: "What should the copy be called?", defaultText: "Survey copy" };
        return this.prompted(s, p);
      }
    }
    if (e.type === "key" && e.down && p.focusList !== null) {
      const m = e.mods ?? 0;
      const opens = !(m & (2 | 4 | 8)) && (e.key === "ArrowDown" || (!(m & 1) && (e.key === "ArrowUp" || e.key === " " || e.key === "Enter")));
      if (opens) return this.openChoices(s, p, p.focusList);
    }
    if (e.type === "down") {
      p.clicks = [...p.clicks, { x: e.x, y: e.y }].slice(-8);
      if (e.clicks === 2) p.selected = p.title.split(/\s+/)[0] ?? "";
      const y = e.y + p.scroll;
      if (e.x >= LINK.x && e.x <= LINK.x + LINK.w && y >= LINK.y && y <= LINK.y + LINK.h && e.clicks === 1) {
        const url = `${p.url.replace(/\/$/, "")}/next`;
        p.history = p.history.slice(0, p.at + 1);
        p.url = url;
        p.title = `Next page of ${p.title}`.slice(0, 60);
        p.history.push({ url, title: p.title });
        p.at = p.history.length - 1;
        this.changed();
      }
    } else if (e.type === "wheel") {
      p.scroll = Math.max(0, Math.min(p.height, p.scroll + e.dy));
    } else if (e.type === "text") {
      p.text += e.text;
    } else if (e.type === "key" && e.down) {
      const cmd = ((e.mods ?? 0) & (2 | 4)) !== 0;
      if (cmd && e.key.toLowerCase() === "a") p.selected = p.text || p.title;
      else if (cmd && e.key.toLowerCase() === "x") p.text = p.text.replace(p.selected, "");
      else if (e.key === "Backspace") p.text = p.text.slice(0, -1);
      else if (e.key === "Escape") p.selected = "";
      else if (e.text && e.text !== "\r") p.text += e.text;
    }
    void s;
  }

  // ------------------------------------------------------------ pictures

  /** Sends a picture of the watched page when it changed (or always, with `now`). */
  private picture(now: boolean): void {
    const w = this.watch;
    if (!w) return;
    const s = this.spaces.find((x) => x.id === w.spaceId);
    if (!s) return;
    const p = this.shownPage(s, w);
    const tick = Math.floor(Date.now() / 1000);
    // While the page asks, no new picture comes (as with the real browser).
    if (p.dialog && !now) return;
    const key = JSON.stringify([p.id, p.url, p.title, p.text, p.scroll, p.clicks, p.lists, p.heard, tick]);
    if (!now && key === w.last) return;
    w.last = key;
    // Light while the page changes: never above the page's own size.
    const data = this.draw(p, tick, s.controlled, this.before ? 1 : Math.min(1, Math.max(0.25, w.ratio)), "image/jpeg");
    w.seq += 1;
    this.framesSent += 1;
    this.emit({ event: "browser.frame", data: { watchId: w.id, seq: w.seq, data, width: p.width, height: p.height, pageId: p.id, url: p.url, title: p.title } });
    // Once it stood still for a moment: one sharp picture at the size the window draws it.
    clearTimeout(w.crisp);
    if (this.before) return;
    w.crisp = setTimeout(() => {
      if (this.watch !== w || w.last !== key || p.dialog) return;
      const sharp = this.draw(p, tick, s.controlled, Math.min(2, Math.max(0.25, w.ratio)), "image/png");
      w.seq += 1;
      this.framesSent += 1;
      this.emit({ event: "browser.frame", data: { watchId: w.id, seq: w.seq, data: sharp, type: "image/png", width: p.width, height: p.height, pageId: p.id, url: p.url, title: p.title } });
    }, this.stillMs);
  }

  /** Draws the made-up page: a top band with its title and host, a clock that ticks, a link, a field with what was typed, and a mark where each click landed. */
  private draw(p: MockPage, tick: number, controlled: boolean, scale: number, type: "image/jpeg" | "image/png"): string {
    const c = (this.canvas ??= document.createElement("canvas"));
    c.width = Math.round(p.width * scale);
    c.height = Math.round(p.height * scale);
    const g = c.getContext("2d")!;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    // Colours of the made-up page itself, not of Pobots.
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, p.width, p.height);
    g.translate(0, -p.scroll);
    g.fillStyle = "#eef0f6";
    g.fillRect(0, 0, p.width, 96);
    g.fillStyle = "#1d2433";
    g.font = "600 32px sans-serif";
    g.fillText(p.title, 48, 60);
    let host = "";
    try {
      host = new URL(p.url).host;
    } catch {
      host = p.url;
    }
    g.font = "20px sans-serif";
    g.fillStyle = "#5b6475";
    g.fillText(host, 48, 140);
    const d = new Date(tick * 1000);
    g.fillText(`It is ${d.toTimeString().slice(0, 8)} here. Tick ${tick % 1000}.`, 48, 190);
    // Small text, to see how sharp the picture is.
    g.font = "12px sans-serif";
    g.fillStyle = "#3a4a6b";
    ["Small print: the survey closes on Friday at 17:00.", "Reminders go out on Monday and Wednesday.", "Answers are anonymous below five people.", "Questions about the import go to the team."].forEach((line, i) => g.fillText(line, 700, 132 + i * 18));
    g.fillStyle = "#2f6fdd";
    g.fillRect(48, 220, ((tick % 10) + 1) * 40, 12);
    g.fillStyle = "#3a4a6b";
    for (let i = 0; i < 4; i++) g.fillRect(48, 260 + i * 20, 600 - i * 90, 8);
    g.fillStyle = "#2f6fdd";
    g.fillRect(LINK.x, LINK.y, LINK.w, LINK.h);
    g.fillStyle = "#ffffff";
    g.font = "600 20px sans-serif";
    g.fillText("Next page", LINK.x + 20, LINK.y + 29);
    g.strokeStyle = "#8a93a6";
    g.lineWidth = 2;
    g.strokeRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h);
    g.fillStyle = "#1d2433";
    g.font = "20px sans-serif";
    g.fillText(p.text.split("\n").pop() || (controlled ? "" : " "), FIELD.x + 12, FIELD.y + 29);
    // The asking buttons and the drop-down lists, closed as the page draws them.
    for (const [r, label] of [[ASK, "Leave"], [NAME, "Copy"]] as const) {
      g.fillStyle = "#e3e7ef";
      g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = "#1d2433";
      g.font = "600 18px sans-serif";
      g.fillText(label, r.x + 16, r.y + 28);
    }
    LISTS.forEach((l, n) => {
      g.strokeStyle = "#8a93a6";
      g.strokeRect(l.x, l.y, l.w, l.h);
      g.fillStyle = "#1d2433";
      g.font = "18px sans-serif";
      g.fillText(l.options[p.lists[n]!]!.label, l.x + 12, l.y + 28);
      g.fillText("▾", l.x + l.w - 26, l.y + 28);
    });
    if (p.heard) {
      g.fillStyle = "#5b6475";
      g.font = "18px sans-serif";
      g.fillText(`The page heard: ${p.heard}`, 960, 500);
    }
    for (let i = 0; i < 12; i++) {
      g.fillStyle = i % 2 ? "#f4f5f8" : "#ffffff";
      g.fillRect(48, 520 + i * 48, p.width - 96, 48);
      g.fillStyle = "#3a4a6b";
      g.fillText(`Row ${i + 1}`, 64, 550 + i * 48);
    }
    g.translate(0, p.scroll);
    for (const k of p.clicks) {
      g.beginPath();
      g.arc(k.x, k.y, 10, 0, Math.PI * 2);
      g.fillStyle = "rgba(220, 60, 60, 0.75)";
      g.fill();
    }
    return c.toDataURL(type, 0.6).replace(/^data:image\/(jpeg|png);base64,/, "");
  }
}
