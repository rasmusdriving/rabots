// The browser in the panel beside the chat: the live picture of one workspace in the browser the bots
// use on the engine's machine, in the same panel an artifact opens in (one panel, two kinds of
// content). The person watches; with "Take control" their pointer and keys go to the page. Pictures
// come as "browser.frame" events straight from the store's feed and are drawn on a canvas once
// decoded, so a picture that replaces another never leaves the panel empty.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { Bot, BrowserInput, BrowserPage, BrowserPrompt, BrowserSpace, Events } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { answerBrowser, browserGo, browserSelection, closeBrowserPage, closeOwnPage, controlBrowser, lookAtBrowser, openBrowserPage, openOwnPage, sendBrowserInput, showBrowserPage, unwatchBrowser, viewBrowser, watchBrowser } from "../state/actions";
import { onBrowserFeed, shareOf, store, useAppState, type BrowserPanel } from "../state/store";
import { BackIcon, BrowserIcon, CheckIcon, CloseIcon, Face, FillIcon, Mark, NarrowerIcon, OutIcon, PageBackIcon, PageForwardIcon, PlusIcon, ReloadIcon, SpacesIcon, UnfillIcon, WiderIcon } from "./bits";
import { closePanel, showNeedsOnPhone, Tool, type PanelLayout, type PanelMode } from "./ArtifactPane";
import { isPhone, usePhone } from "../lib/phone";
import { openOutside } from "../lib/outside";

/** Input is sent at most this often (about 30 times a second); what happens in between goes in one batch, in order. */
const SEND_MS = 33;
/** Escape pressed twice within this long leaves the picture; once goes to the page. */
const ESC_TWICE_MS = 600;
/** A wheel step in lines or pages, in pixels. */
const LINE_PX = 16;
/** "browser.view" is sent at most this often while the panel's size changes (a few times a second). */
const VIEW_MS = 250;

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

type Picture = Pick<Events["browser.frame"], "width" | "height" | "url" | "title" | "pageId">;

/** The screen's own pixel ratio (1 where the window does not know it). */
const screenRatio = (): number => (typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
type Choices = Extract<BrowserPrompt, { kind: "choices" }>;
type Asked = Extract<BrowserPrompt, { kind: "dialog" }>;

/** The state line when the laptop's browser refused the clipboard: a copy is kept here for the next paste. */
export const COPIED_INSIDE = "Copied inside this page only. Your browser did not allow the clipboard.";

/** A web address. A new page's own address (chrome://newtab/, about:blank) is not one: it is never shown. */
export const isWebAddress = (url: string | undefined): boolean => !!url && /^https?:\/\//i.test(url);

/** "Title · host", the page in one muted line. A new page with no address yet says nothing. */
export function pageLine(title: string | undefined, url: string | undefined): string {
  if (url && !isWebAddress(url)) return "";
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    host = "";
  }
  const t = (title ?? "").trim();
  return [t, host].filter(Boolean).join(" · ");
}

/**
 * Keys that would leave the page on the laptop (close or open a tab, go to the address bar, load the
 * Pobots page again, the developer tools). They are not caught and not passed on.
 */
function leavesThePage(e: KeyboardEvent): boolean {
  if (/^F(5|11|12)$/.test(e.key)) return true;
  const c = e.ctrlKey || e.metaKey;
  if (e.altKey && !c && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  if (!c) return false;
  const k = e.key.toLowerCase();
  if (["w", "t", "n", "l", "r", "q", "tab", "pageup", "pagedown"].includes(k)) return true;
  if (/^[1-9]$/.test(k)) return true;
  return e.shiftKey && e.ctrlKey && (k === "i" || k === "j");
}

const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0);

/** What a key types, when it types something: a letter, a space, Enter. Not with Ctrl or the command key. */
function typed(e: KeyboardEvent): string | undefined {
  if (e.ctrlKey || e.metaKey) return undefined;
  if (e.key === "Enter") return "\r";
  return e.key.length === 1 ? e.key : undefined;
}

const editable = (el: Element | null): boolean => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

/** An address the person typed: http and https only, a bare host gets https (the engine adds it). Null when refused. */
export function addressOf(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme && !/^https?$/i.test(scheme[1]!) && !/^[^/]+:\d+(\/|$)/.test(v)) return null;
  return v;
}

export function BrowserView({ panel, mode, layout, backName }: { panel: BrowserPanel; mode: PanelMode; layout: PanelLayout; backName: string }) {
  const browser = useAppState((s) => s.browser);
  const bots = useAppState((s) => s.bots);
  const cards = useAppState((s) => s.cards.length);
  const share = useAppState(shareOf);
  /** On a phone the browser is watch only for now: no Take control, no address line. */
  const phone = usePhone();
  const connected = useAppState((s) => s.connection.phase === "ready");
  const live = browser.spaces.find((x) => x.id === panel.spaceId);
  /** The workspace as last seen, so its name stays when it closes. */
  const lastSpace = useRef<BrowserSpace | undefined>(live);
  if (live) lastSpace.current = live;
  const space = live ?? lastSpace.current;
  const owner = space?.owner;
  const bot = space?.botId ? bots.find((b) => b.id === space.botId) : undefined;
  const botName = bot?.name ?? "The bot";

  const [watch, setWatch] = useState<{ watchId: string; pageId: string; width: number; height: number } | null>(null);
  const watchRef = useRef<string | null>(null);
  /** The page just picked in the row of pages, until its first picture comes. */
  const [chosen, setChosen] = useState<string | null>(null);
  const chosenRef = useRef<string | null>(null);
  chosenRef.current = chosen;
  /** Pages whose own question waits (heard while they were shown): their page in the row gets a quiet mark. */
  const [asking, setAsking] = useState<ReadonlySet<string>>(new Set());
  /** How sharp the pictures need to be: screen pixels per page pixel, as drawn. */
  const ratioRef = useRef(screenRatio());
  /** The screen's own pixel ratio. */
  const [dpr, setDpr] = useState(screenRatio);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [ended, setEnded] = useState<"closed" | "gone" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [controlled, setControlled] = useState(false);
  const controlRef = useRef(false);
  controlRef.current = controlled;
  const [hint, setHint] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [menu, setMenu] = useState<"spaces" | null>(null);
  /** What the page shows outside its picture now: its question, or the choices of a drop-down list. */
  const [prompt, setPrompt] = useState<BrowserPrompt | null>(null);
  const promptRef = useRef<BrowserPrompt | null>(null);
  promptRef.current = prompt;
  /** The page the picture shows now (or the one just picked). */
  const shownRef = useRef<string | undefined>(undefined);
  /** What the page said before the answer to "browser.watch" told which watch it is. */
  const earlyPrompt = useRef<Events["browser.prompt"] | null>(null);
  /** The last text copied or cut from the page, and whether the laptop's clipboard refused it. */
  const kept = useRef<{ text: string; refused: boolean } | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const take = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const drawnSeq = useRef(0);
  /** A picture that came before the answer to "browser.watch" told which watch it is. */
  const early = useRef<Events["browser.frame"] | null>(null);

  // The workspace is gone from the browser while it is shown: it stays, dimmed, until the person picks another or closes.
  const goneFromState = connected && browser.available && !live && !!lastSpace.current;
  useEffect(() => {
    if (goneFromState) setEnded((e) => e ?? "closed");
  }, [goneFromState]);

  // Another workspace: a fresh start, but the picture of the last one stays until the new one comes.
  useEffect(() => {
    setEnded(null);
    setChosen(null);
    setAsking(new Set());
    setHint(false);
    setNote(null);
    setMenu(null);
  }, [panel.spaceId]);

  // ------------------------------------------------------------ pictures

  const draw = useCallback(async (f: Events["browser.frame"]) => {
    if (f.watchId !== watchRef.current || f.seq <= drawnSeq.current) return;
    const img = new Image();
    // A JPEG while the page changes; once it stands still, a sharp PNG or WebP of the size it is drawn at.
    img.src = `data:${/^image\/(jpeg|png|webp)$/.test(f.type ?? "") ? f.type : "image/jpeg"};base64,${f.data}`;
    try {
      await img.decode();
    } catch {
      return;
    }
    // A newer one may have been drawn while this one was decoding.
    if (f.watchId !== watchRef.current || f.seq <= drawnSeq.current) return;
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    drawnSeq.current = f.seq;
    // The canvas is the picture's own size, drawn pixel for pixel; its drawn size is set apart (the
    // page's size scaled to the panel). A new size clears it; it is drawn again in the same moment,
    // before anything is painted.
    if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
    }
    ctx.drawImage(img, 0, 0);
    if (chosenRef.current === f.pageId) setChosen(null);
    // The screen's pixel ratio is looked at with every picture too (not every browser says when it changes).
    setDpr(screenRatio());
    setPicture((p) =>
      p && p.width === f.width && p.height === f.height && p.url === f.url && p.title === f.title && p.pageId === f.pageId
        ? p
        : { width: f.width, height: f.height, url: f.url, title: f.title, pageId: f.pageId },
    );
  }, []);

  useEffect(
    () =>
      onBrowserFeed((e) => {
        if (e.event === "browser.frame") {
          if (!watchRef.current) early.current = e.data;
          else void draw(e.data);
          return;
        }
        if (e.event === "browser.prompt") {
          if (!watchRef.current) earlyPrompt.current = e.data;
          else if (e.data.watchId === watchRef.current) {
            setPrompt(e.data.prompt ?? null);
            // A page's question belongs to its page: remembered for the row of pages.
            const on = chosenRef.current ?? shownRef.current;
            if (on) setAsking((a) => withAsk(a, on, e.data.prompt?.kind === "dialog"));
          }
          return;
        }
        if (e.data.watchId !== watchRef.current) return;
        watchRef.current = null;
        setWatch(null);
        setControlled(false);
        setPrompt(null);
        if (e.data.reason === "closed") setEnded("closed");
        else if (e.data.reason === "gone") setEnded("gone");
      }),
    [draw],
  );

  // ------------------------------------------------------------ watching
  // Asked again by itself when the connection comes back; the last picture stays meanwhile.

  useEffect(() => {
    if (!connected || !browser.available || ended) return;
    let stopped = false;
    let mine: string | null = null;
    // The watch follows the page in front in the browser (see the row of pages below).
    const startRatio = ratioRef.current;
    watchBrowser(panel.spaceId, undefined, startRatio).then(
      (r) => {
        if (stopped) {
          void unwatchBrowser(r.watchId).catch(() => undefined);
          return;
        }
        mine = r.watchId;
        watchRef.current = r.watchId;
        sentRatio.current = { watchId: r.watchId, ratio: startRatio, at: performance.now() };
        drawnSeq.current = 0;
        setWatch(r);
        setControlled(false);
        setProblem(null);
        const first = early.current;
        early.current = null;
        if (first?.watchId === r.watchId) void draw(first);
        const asked = earlyPrompt.current;
        earlyPrompt.current = null;
        setPrompt(asked?.watchId === r.watchId ? (asked.prompt ?? null) : null);
      },
      (e) => {
        if (stopped) return;
        if (e instanceof EngineError && e.code === "not_found") setEnded("closed");
        else setProblem(messageOf(e));
      },
    );
    return () => {
      stopped = true;
      if (mine) void unwatchBrowser(mine).catch(() => undefined);
      if (watchRef.current === mine) watchRef.current = null;
      setWatch(null);
      setControlled(false);
      setPrompt(null);
    };
  }, [connected, browser.available, ended, panel.spaceId, retry, draw]);

  // ------------------------------------------------------------ the picture's size
  // Fits the panel with its proportions kept, never larger than the page's own size, centred at the top.

  const [shown, setShown] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !picture) return;
    const fit = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      if (!bw || !bh) return;
      const scale = Math.min(bw / picture.width, bh / picture.height, 1);
      const w = Math.floor(picture.width * scale);
      const h = Math.floor(picture.height * scale);
      setShown((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [picture]);

  // ------------------------------------------------------------ how sharp
  // The engine takes each picture at the size it is drawn on the person's screen: the screen's own
  // pixel ratio times how much the panel scales the page. Sent when the panel's size or the screen's
  // pixel ratio changes, at most a few times a second while the divider is dragged.

  useEffect(() => {
    // A change of the screen's pixel ratio (the window moved to another screen, the zoom changed)
    // fires the resolution query, and a resize; either is enough.
    const changed = () => setDpr(screenRatio());
    const mq = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    mq?.addEventListener("change", changed);
    window.addEventListener("resize", changed);
    return () => {
      mq?.removeEventListener("change", changed);
      window.removeEventListener("resize", changed);
    };
  }, [dpr]);
  const sentRatio = useRef<{ watchId: string; ratio: number; at: number } | null>(null);
  const viewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!shown || !picture?.width) return;
    const ratio = Math.round(dpr * (shown.w / picture.width) * 1000) / 1000;
    const pageW = picture.width;
    ratioRef.current = ratio;
    const id = watch?.watchId;
    if (!id) return;
    const send = () => {
      viewTimer.current = undefined;
      const r = ratioRef.current;
      const last = sentRatio.current;
      if (watchRef.current !== id) return;
      // Sent again when the picture would come out about two pixels or more off the drawn size.
      if (last && last.watchId === id && Math.abs(last.ratio - r) * pageW < 2) return;
      sentRatio.current = { watchId: id, ratio: r, at: performance.now() };
      void viewBrowser(id, r).catch(() => undefined);
    };
    if (viewTimer.current) return;
    const wait = Math.max(0, VIEW_MS - (performance.now() - (sentRatio.current?.at ?? 0)));
    viewTimer.current = setTimeout(send, wait);
  }, [shown, picture?.width, dpr, watch?.watchId]);
  useEffect(() => () => clearTimeout(viewTimer.current), []);

  // ------------------------------------------------------------ input

  const queue = useRef<BrowserInput[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSend = useRef(0);
  const inside = useRef(false);
  const lastEsc = useRef(0);
  /** Keys whose press went to the page: only their release follows (not one whose press a menu or the page's question took). */
  const downKeys = useRef(new Set<string>());

  /** A batch on its way: the next one waits for its answer, so the page gets everything in order. */
  const sending = useRef(false);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (sending.current) return;
    const events = queue.current.splice(0);
    const id = watchRef.current;
    if (!events.length || !id || !controlRef.current) return;
    lastSend.current = performance.now();
    sending.current = true;
    void sendBrowserInput(id, events)
      .catch((e) => {
        if (e instanceof EngineError && e.code === "conflict") setControlled(false);
      })
      .finally(() => {
        sending.current = false;
        // What came meanwhile goes next, keeping the pace.
        if (queue.current.length && !timer.current) timer.current = setTimeout(flushRef.current, Math.max(0, SEND_MS - (performance.now() - lastSend.current)));
      });
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const push = useCallback(
    (ev: BrowserInput) => {
      if (!controlRef.current || !watchRef.current) return;
      const q = queue.current;
      const last = q[q.length - 1];
      // Between two sends only the newest position of a move counts, and wheel steps add up.
      if (ev.type === "move" && last?.type === "move" && last.mods === ev.mods) q[q.length - 1] = ev;
      else if (ev.type === "wheel" && last?.type === "wheel") q[q.length - 1] = { ...ev, dx: last.dx + ev.dx, dy: last.dy + ev.dy };
      else q.push(ev);
      if (timer.current) return;
      timer.current = setTimeout(flush, Math.max(0, SEND_MS - (performance.now() - lastSend.current)));
    },
    [flush],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  // Control ends: what waited is dropped.
  useEffect(() => {
    if (!controlled) {
      queue.current = [];
      downKeys.current.clear();
    }
  }, [controlled]);

  /** A position over the picture, in the page's own pixels. */
  const at = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const c = canvas.current;
    if (!c || !picture) return null;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.round(Math.min(Math.max(((clientX - r.left) / r.width) * picture.width, 0), picture.width - 1));
    const y = Math.round(Math.min(Math.max(((clientY - r.top) / r.height) * picture.height, 0), picture.height - 1));
    return { x, y };
  };
  const BUTTONS = ["left", "middle", "right"] as const;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    stage.current?.focus({ preventScroll: true });
    // Open choices close on a press elsewhere, as a list does; the press does not reach the page.
    if (promptRef.current?.kind === "choices") {
      if (controlRef.current) void answer({ kind: "choices" });
      return;
    }
    if (!controlRef.current) {
      if (e.button === 0) setHint(true);
      return;
    }
    // No preventDefault here: it would also hold back the mouse events that carry the click count.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience: a drag that leaves the picture still ends.
    }
  };
  /** While the page asks or a list's choices are open, nothing else goes to the page. */
  const held = () => !!promptRef.current;
  const onMouse = (type: "down" | "up") => (e: MouseEvent<HTMLDivElement>) => {
    if (!controlRef.current || held()) return;
    const p = at(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    push({ type, ...p, button: BUTTONS[e.button] ?? "left", clicks: Math.max(1, e.detail), mods: modsOf(e) || undefined });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!controlRef.current || held()) return;
    const p = at(e.clientX, e.clientY);
    if (p) push({ type: "move", ...p, mods: modsOf(e) || undefined });
  };

  // The wheel needs a listener that may hold the panel still while the page scrolls.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!controlRef.current || held()) return;
      const p = at(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? el.clientHeight : 1;
      push({ type: "wheel", ...p, dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit), mods: modsOf(e) || undefined });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const copySelection = () => {
    // After the keys have reached the page, ask it what is selected, for the laptop's clipboard. The
    // text is kept here too: when the laptop's browser refuses the clipboard, the next paste in the
    // panel uses it.
    setTimeout(() => {
      flush();
      const id = watchRef.current;
      if (!id) return;
      void browserSelection(id)
        .then(async (text) => {
          if (!text) return;
          kept.current = { text, refused: false };
          try {
            if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
            await navigator.clipboard.writeText(text);
          } catch {
            if (kept.current?.text === text) kept.current = { text, refused: true };
            setNote(COPIED_INSIDE);
          }
        })
        .catch(() => undefined);
    }, SEND_MS);
  };
  // A copy somewhere else in Pobots, or the window losing the focus (the person may copy in another
  // program), makes the laptop's clipboard the one to trust again.
  useEffect(() => {
    const forget = (e: Event) => {
      if (e.type !== "blur" && stage.current?.contains(e.target as Node)) return;
      if (kept.current?.refused) kept.current = null;
    };
    document.addEventListener("copy", forget, true);
    document.addEventListener("cut", forget, true);
    window.addEventListener("blur", forget);
    return () => {
      document.removeEventListener("copy", forget, true);
      document.removeEventListener("cut", forget, true);
      window.removeEventListener("blur", forget);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (!controlRef.current) return;
    if (leavesThePage(e)) return;
    // Open choices take every key (their menu normally has the focus); Escape closes them.
    if (promptRef.current?.kind === "choices") {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") void answer({ kind: "choices" });
      return;
    }
    if (e.key === "Escape") {
      const now = performance.now();
      // The page needs Escape too: once goes to the page. Twice quickly, or with the pointer away
      // from the picture, leaves it for the panel's controls, so a keyboard is never kept in.
      if (!inside.current || now - lastEsc.current < ESC_TWICE_MS) {
        lastEsc.current = 0;
        e.preventDefault();
        e.stopPropagation();
        take.current?.focus();
        return;
      }
      lastEsc.current = now;
    }
    const cmd = (e.ctrlKey || e.metaKey) && !e.altKey;
    const k = e.key.toLowerCase();
    // A paste is sent as text from the laptop's own clipboard, by the paste event that follows.
    if (cmd && k === "v") return;
    e.preventDefault();
    e.stopPropagation();
    downKeys.current.add(e.code || e.key);
    push({ type: "key", down: true, key: e.key, code: e.code, text: typed(e), repeat: e.repeat || undefined, mods: modsOf(e) || undefined });
    if (cmd && (k === "c" || k === "x") && !e.shiftKey) copySelection();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !controlRef.current || leavesThePage(e)) return;
    if (promptRef.current?.kind === "choices") return;
    const cmd = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (cmd && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    if (!downKeys.current.delete(e.code || e.key)) return;
    push({ type: "key", down: false, key: e.key, code: e.code, mods: modsOf(e) || undefined });
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!controlRef.current || held()) return;
    e.preventDefault();
    // When the laptop's clipboard refused the last copy from the page, that copy is what the person
    // means to paste: the clipboard holds something older, or nothing.
    const k = kept.current;
    const text = k?.refused ? k.text : e.clipboardData.getData("text/plain") || (k?.text ?? "");
    if (text) push({ type: "text", text });
  };

  // ------------------------------------------------------------ control and moving the page

  const setControl = async (want: boolean): Promise<boolean> => {
    const id = watchRef.current;
    if (!id) return false;
    try {
      const r = await controlBrowser(id, want);
      setControlled(r.controlled);
      setNote(null);
      // Open choices close when control is handed back (the engine says so too).
      if (!r.controlled) setPrompt((p) => (p?.kind === "choices" ? null : p));
      if (r.controlled) {
        setHint(false);
        stage.current?.focus({ preventScroll: true });
      }
      return r.controlled;
    } catch (e) {
      setNote(messageOf(e));
      return false;
    }
  };

  /** Answers what the page shows outside its picture. The focus goes back to the picture. */
  const answer = async (a: Parameters<typeof answerBrowser>[1]) => {
    const id = watchRef.current;
    const before = promptRef.current;
    if (!id || !before) return;
    // It closes at once; the engine says so too. Should the answer fail, it comes back.
    setPrompt(null);
    const inMenu = !!document.activeElement?.closest(".pb-browser-over");
    if (inMenu) stage.current?.focus({ preventScroll: true });
    try {
      await answerBrowser(id, a);
    } catch (e) {
      if (!(e instanceof EngineError && e.code === "conflict")) {
        setPrompt((p) => p ?? before);
        setNote(messageOf(e));
      }
    }
  };

  const go = async (to: Parameters<typeof browserGo>[1]) => {
    const id = watchRef.current;
    if (!id) return;
    try {
      await browserGo(id, to);
      setNote(null);
    } catch (e) {
      setNote(messageOf(e));
    }
  };

  // ------------------------------------------------------------ the row of pages
  // One page of the workspace per place in the row, in the browser's order. Choosing one shows it
  // ("browser.page.show"): the watch goes on and control is kept. The page comes to the front in the
  // browser, as a click on a real tab does, with or without control: in the bots' browser any look
  // at a page (even a picture of it) makes it the page in front, so a page cannot be shown and left
  // behind. The watch follows the front page, so a bot that goes to another page is followed there.

  const shownId = chosen ?? picture?.pageId ?? watch?.pageId;
  shownRef.current = shownId;

  const showPage = async (p: BrowserPage) => {
    const id = watchRef.current;
    if (!id || off || p.id === shownId) return;
    const before = shownId;
    // What the page left behind showed belongs to it; the engine says what the new one shows.
    if (before && promptRef.current?.kind === "dialog") setAsking((a) => withAsk(a, before, true));
    setPrompt(null);
    setChosen(p.id);
    try {
      // Always named: a quick second choice must not be read against a front page that is about to change.
      await showBrowserPage(id, p.id);
      setNote(null);
    } catch (e) {
      setChosen(null);
      setNote(messageOf(e));
    }
  };

  /** Your own page: a new page, in front, with the focus in the address line. Takes control by itself. */
  const openPage = async () => {
    const id = watchRef.current;
    if (!id || off) return;
    if (!controlRef.current && !(await setControl(true))) return;
    try {
      const r = await openBrowserPage(id);
      setChosen(r.pageId);
      setPrompt(null);
      setTypedUrl("");
      setNote(null);
      requestAnimationFrame(() => address.current?.focus({ preventScroll: true }));
    } catch (e) {
      setNote(messageOf(e));
    }
  };

  /** Your own page: closes one of its pages, never the last. Takes control by itself. */
  const closePage = async (p: BrowserPage) => {
    const id = watchRef.current;
    if (!id || off || pages.length < 2) return;
    if (!controlRef.current && !(await setControl(true))) return;
    try {
      await closeBrowserPage(id, p.id);
      if (chosenRef.current === p.id) setChosen(null);
      setAsking((a) => withAsk(a, p.id, false));
      setNote(null);
    } catch (e) {
      setNote(messageOf(e));
    }
  };

  // ------------------------------------------------------------ what is shown

  const front = space?.pages.find((p) => p.id === shownId) ?? space?.pages.find((p) => p.active);
  const where = pageLine(picture?.title ?? front?.title, picture?.url ?? front?.url);
  // A new page with no address yet shows an empty address line with its placeholder.
  const rawUrl = picture?.url ?? front?.url ?? "";
  const url = isWebAddress(rawUrl) ? rawUrl : "";
  const mine = owner === "you";
  const title = space ? (mine ? "Your page" : space.name.trim() || "Work in the browser") : "The browser";
  const busy = !ended && !!live?.busy;
  const off = !!ended;
  const unavailable = !browser.available || ended === "gone" || !!problem;
  // The engine's own sentence first: it says what is wrong and what to do.
  const reason = !browser.available
    ? (browser.problem ?? "The browser cannot be reached right now.")
    : ended === "gone"
      ? "The browser went away. Try again in a moment."
      : (problem ?? "The browser cannot be reached right now.");

  const stateLine = ended === "closed"
    ? owner === "bot"
      ? `${botName} closed this`
      : mine
        ? "Your page was closed"
        : "This was closed"
    : note
      ? note
      : controlled
        ? busy
          ? `You are in control. ${botName} is not stopped.`
          : "You are in control."
        : busy
          ? `${botName} is working here`
          : phone
            ? "Take control from a computer."
            : hint
              ? "Take control to click and type"
              : "";

  // The address line in the person's own page: what they type is kept until they leave it.
  const [typedUrl, setTypedUrl] = useState<string | null>(null);
  const address = useRef<HTMLInputElement>(null);
  const goTo = async () => {
    const to = addressOf(typedUrl ?? "");
    if (!to) {
      setNote("Only addresses that start with http or https can be opened here.");
      return;
    }
    if (!controlRef.current && !(await setControl(true))) return;
    await go({ url: to });
    setTypedUrl(null);
    stage.current?.focus({ preventScroll: true });
  };

  // In a narrow window the panel takes the place of the chat: the focus goes to the way back.
  useEffect(() => {
    if (mode !== "narrow") return;
    const el = document.activeElement;
    if (!el || el === document.body || el.closest(".app-main")) back.current?.focus({ preventScroll: true });
  }, [mode]);

  const setShare = (n: number) => store.setPanelShare(Math.round(Math.min(layout.max, Math.max(layout.min, n)) * 1000) / 1000);
  // The width shown, as a share: the browser's starts at "as wide as the divider allows", stored as 1.
  const shownShare = Math.min(layout.max, Math.max(layout.min, share));
  const atMin = layout.px <= Math.round(layout.min * layout.avail) + 1;
  const atMax = layout.px >= Math.round(layout.max * layout.avail) - 1;

  const showRail = () => {
    if (isPhone()) return showNeedsOnPhone();
    closePanel(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".app-rail button")?.focus({ preventScroll: true }));
  };

  const pickSpace = async (id: string | "you") => {
    setMenu(null);
    if (id === "you") {
      const own = browser.spaces.find((x) => x.owner === "you");
      if (own) store.setPanel({ kind: "browser", spaceId: own.id, full: panel.full });
      else await openOwnPage().catch((e) => setNote(messageOf(e)));
      return;
    }
    store.setPanel({ kind: "browser", spaceId: id, full: panel.full });
  };

  const closeMine = async () => {
    setMenu(null);
    if (!space) return;
    try {
      await closeOwnPage(space.id);
    } catch (e) {
      setNote(messageOf(e));
    }
  };

  const pages = live?.pages ?? [];
  const stageId = `pb-browser-page-${panel.spaceId}`;
  // Pages that closed are forgotten.
  useEffect(() => {
    setAsking((a) => {
      const keep = [...a].filter((id) => pages.some((p) => p.id === id));
      return keep.length === a.size ? a : new Set(keep);
    });
  }, [pages]);
  const label = controlled ? "The page. You are in control: your pointer and keys go to it. Press Escape twice to leave it." : "The page. Take control to click and type.";

  return (
    <div
      className="pb-artifact-panel pb-browser-panel"
      data-space-id={panel.spaceId}
      data-owner={owner}
      data-controlled={controlled || undefined}
      data-ended={ended || undefined}
      data-asked={(!ended && prompt?.kind === "dialog") || undefined}
    >
      <div className="pb-artifact-bar pb-browser-bar">
        {mode === "narrow" && (
          <button ref={back} type="button" className="pb-helper-back pb-artifact-back" aria-label={`Back to ${backName}`} onClick={() => closePanel()}>
            <BackIcon />
            <span className="pb-helper-back-name">{backName}</span>
          </button>
        )}
        <div className="pb-artifact-bar-text">
          <h2 className="pb-artifact-bar-title pb-browser-bar-title" title={title}>
            {title}
          </h2>
          {mine && !off && !phone ? (
            <input
              ref={address}
              className="pb-browser-address"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              aria-label="Address"
              placeholder="Type an address"
              value={typedUrl ?? url}
              onChange={(e) => setTypedUrl(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => setTypedUrl(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void goTo();
                } else if (e.key === "Escape" && typedUrl !== null) {
                  e.preventDefault();
                  e.stopPropagation();
                  setTypedUrl(null);
                }
              }}
            />
          ) : (
            <span className="pb-artifact-when pb-browser-where pb-fade-in" key={where}>
              {where || " "}
            </span>
          )}
        </div>
        {cards > 0 && (
          <button type="button" className="pb-artifact-needs" aria-label={`Needs you, ${cards}. Close the browser and show what needs you`} onClick={showRail}>
            <Mark state="waiting" />
            <span className="pb-artifact-needs-word">Needs you</span>
            <span className="pb-artifact-needs-n pb-fade-in" key={cards}>
              {cards}
            </span>
          </button>
        )}
        {!phone && (
        <button
          ref={take}
          type="button"
          className="pb-btn pb-btn-sm pb-browser-take"
          data-controlled={controlled || undefined}
          aria-pressed={controlled}
          aria-disabled={off || !watch || undefined}
          onClick={() => !off && watch && void setControl(!controlled)}
        >
          {controlled ? "Hand back" : "Take control"}
        </button>
        )}
        <div className="pb-artifact-tools pb-browser-tools" role="toolbar" aria-label="Browser">
          {controlled && !off && (
            <>
              <Tool label="Back" onClick={() => void go("back")}>
                <PageBackIcon />
              </Tool>
              <Tool label="Forward" onClick={() => void go("forward")}>
                <PageForwardIcon />
              </Tool>
              <Tool label="Load again" onClick={() => void go("reload")}>
                <ReloadIcon />
              </Tool>
            </>
          )}
          <span className="pb-browser-pick">
            <Tool label="Other work in the browser" onClick={() => setMenu(menu === "spaces" ? null : "spaces")} expanded={menu === "spaces"}>
              <SpacesIcon />
            </Tool>
            {menu === "spaces" && (
              <Menu label="The browser" onClose={() => setMenu(null)}>
                {browser.spaces
                  .filter((x) => x.owner === "bot")
                  .map((x) => {
                    const b = bots.find((y) => y.id === x.botId);
                    return (
                      <button key={x.id} type="button" className="pb-option" role="menuitemradio" aria-checked={x.id === panel.spaceId} onClick={() => void pickSpace(x.id)}>
                        {b ? <Face look={b.look} size="sm" /> : <span className="pb-browser-menu-mark"><BrowserIcon /></span>}
                        <span className="pb-pick-name">{x.name.trim() || "Work in the browser"}</span>
                        {x.id === panel.spaceId ? <CheckIcon className="pb-push" /> : b && <span className="pb-option-note">{b.name}</span>}
                      </button>
                    );
                  })}
                <button type="button" className="pb-option" role="menuitemradio" aria-checked={mine && !!live} onClick={() => void pickSpace("you")}>
                  <span className="pb-browser-menu-mark">
                    <BrowserIcon />
                  </span>
                  <span className="pb-pick-name">Your page</span>
                  {mine && live && <CheckIcon className="pb-push" />}
                </button>
                {browser.spaces.some((x) => x.owner === "other") && (
                  <>
                    <div className="pb-browser-menu-title" role="presentation">
                      Other work in the browser
                    </div>
                    {browser.spaces
                      .filter((x) => x.owner === "other")
                      .map((x) => (
                        <button key={x.id} type="button" className="pb-option" role="menuitemradio" aria-checked={x.id === panel.spaceId} onClick={() => void pickSpace(x.id)}>
                          <span className="pb-browser-menu-mark">
                            <BrowserIcon />
                          </span>
                          <span className="pb-pick-name">{x.name.trim() || "Work in the browser"}</span>
                          {x.id === panel.spaceId && <CheckIcon className="pb-push" />}
                        </button>
                      ))}
                  </>
                )}
                {mine && live && (
                  <>
                    <div className="pb-browser-menu-rule" role="presentation" />
                    <button type="button" className="pb-option" role="menuitem" onClick={() => void closeMine()}>
                      <span className="pb-pick-name">Close your page</span>
                    </button>
                  </>
                )}
              </Menu>
            )}
          </span>
          {mine && /^https?:\/\//i.test(url) && (
            <Tool label="Open in a new tab" off={off} onClick={() => openNewTab(url)}>
              <OutIcon />
            </Tool>
          )}
          {mode === "side" && (
            <>
              <Tool label="Narrower" className="pb-tool-width" onClick={() => setShare(shownShare - 0.1)} disabled={atMin}>
                <NarrowerIcon />
              </Tool>
              <Tool label="Wider" className="pb-tool-width" onClick={() => setShare(shownShare + 0.1)} disabled={atMax}>
                <WiderIcon />
              </Tool>
            </>
          )}
          {mode !== "narrow" && (
            <Tool label={panel.full ? "Show the chat beside it" : "Fill the main area"} onClick={() => store.setPanel({ ...panel, full: !panel.full })}>
              {panel.full ? <UnfillIcon /> : <FillIcon />}
            </Tool>
          )}
          <Tool label="Close" onClick={() => closePanel()}>
            <CloseIcon />
          </Tool>
        </div>
      </div>
      <PageRow
        pages={pages.length ? pages : (space?.pages ?? [])}
        shownId={shownId}
        mine={mine}
        off={off}
        asking={asking}
        stageId={stageId}
        onShow={(p) => void showPage(p)}
        onOpen={() => void openPage()}
        onClose={(p) => void closePage(p)}
      />
      <p className="pb-browser-stateline" role="status" data-tone={controlled && !off ? "control" : undefined}>
        <span className="pb-fade-in" key={stateLine}>
          {stateLine || " "}
        </span>
      </p>
      <div className="pb-artifact-body pb-browser-body" ref={body} data-shown={!!picture || undefined}>
        <div
          ref={stage}
          id={stageId}
          className="pb-browser-picture"
          role="application"
          aria-label={label}
          aria-roledescription="page"
          tabIndex={0}
          data-controlled={controlled || undefined}
          style={shown ? { width: shown.w, height: shown.h } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerEnter={() => {
            inside.current = true;
            // Not while the page's question or a list's choices have the focus.
            if (controlRef.current && !editable(document.activeElement) && !document.activeElement?.closest(".pb-browser-over")) stage.current?.focus({ preventScroll: true });
          }}
          onPointerLeave={() => {
            inside.current = false;
          }}
          onMouseDown={onMouse("down")}
          onMouseUp={onMouse("up")}
          onContextMenu={(e) => controlRef.current && e.preventDefault()}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
        >
          <canvas ref={canvas} className="pb-browser-canvas" width={0} height={0} aria-hidden="true" />
        </div>
        {prompt && picture && shown && !ended && (
          <Over stage={stage} body={body} shown={shown}>
            {(room) =>
              prompt.kind === "dialog" ? (
                <AskCard key={`${prompt.type}|${prompt.message}`} ask={prompt} canAnswer={controlled} onAnswer={(accept, text) => void answer({ kind: "dialog", accept, ...(text !== undefined ? { text } : {}) })} />
              ) : (
                <ChoicesMenu
                  key={`${prompt.x},${prompt.y}`}
                  choices={prompt}
                  scale={shown.w / picture.width}
                  room={room}
                  canAnswer={controlled}
                  onChoose={(index) => void answer(index === undefined ? { kind: "choices" } : { kind: "choices", index })}
                />
              )
            }
          </Over>
        )}
        {!picture && !unavailable && !ended && (
          <p className="pb-artifact-status pb-browser-status" role="status" data-wait="">
            Opening the browser
          </p>
        )}
        {unavailable && !(ended === "closed") && (
          <div className="pb-artifact-status pb-browser-status" role="alert" data-over={picture ? "" : undefined}>
            <p>{reason}</p>
            <button
              type="button"
              className="pb-btn pb-btn-sm"
              onClick={() => {
                setProblem(null);
                setEnded(null);
                void lookAtBrowser().then(() => setRetry((n) => n + 1));
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function withAsk(a: ReadonlySet<string>, pageId: string, asks: boolean): ReadonlySet<string> {
  if (a.has(pageId) === asks) return a;
  const next = new Set(a);
  if (asks) next.add(pageId);
  else next.delete(pageId);
  return next;
}

/** A page's name in the row: its title, else its host, else "A new page". */
function pageName(p: BrowserPage): string {
  if (p.url && !isWebAddress(p.url)) return "A new page";
  const t = p.title.trim();
  if (t) return t;
  try {
    return new URL(p.url).host || "A new page";
  } catch {
    return "A new page";
  }
}

/**
 * The row of pages between the top line and the state line: one place per page of the workspace, in
 * the browser's order, the one shown marked by its surface and weight. Always there, with one page
 * too, at one fixed height: a page that opens or closes changes the row in place and never moves the
 * picture. Many pages shrink to a smallest width, then the row scrolls sideways; nothing wraps.
 * A screen reader hears a tab list; the row is one stop (the page shown), Left and Right move, Home
 * and End, Enter or Space shows. In your own page: a quiet add control at the end, and each page a
 * close control on hover and focus (Delete closes the focused one), never on the last page.
 */
function PageRow({
  pages,
  shownId,
  mine,
  off,
  asking,
  stageId,
  onShow,
  onOpen,
  onClose,
}: {
  pages: BrowserPage[];
  shownId: string | undefined;
  mine: boolean;
  off: boolean;
  asking: ReadonlySet<string>;
  stageId: string;
  onShow(p: BrowserPage): void;
  onOpen(): void;
  onClose(p: BrowserPage): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const shown = pages.find((p) => p.id === shownId) ?? pages.find((p) => p.active) ?? pages[0];
  const canClose = mine && !off && pages.length > 1;

  // The page shown stays in view inside the row (the row scrolls, nothing else does).
  useLayoutEffect(() => {
    const row = list.current;
    const el = shown ? row?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(shown.id)}"]`) : null;
    if (!row || !el) return;
    const left = el.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (left + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + el.offsetWidth - row.clientWidth;
  }, [shown?.id, pages.length]);

  const tabs = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = tabs();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const to = e.key === "ArrowRight" ? Math.min(i + 1, all.length - 1) : e.key === "ArrowLeft" ? Math.max(i - 1, 0) : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      all[to]?.focus();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && canClose) {
      const p = pages[i];
      if (!p) return;
      e.preventDefault();
      // The focus goes to the page beside it.
      (all[i + 1] ?? all[i - 1])?.focus();
      onClose(p);
    }
  };

  return (
    <div className="pb-browser-tabs" data-off={off || undefined}>
      <div
        className="pb-browser-tablist"
        role="tablist"
        aria-label="Pages"
        ref={list}
        onKeyDown={onKey}
        onWheel={(e) => {
          // A wheel that turns up and down moves a long row sideways.
          const el = list.current;
          if (el && el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
      >
        {pages.map((p) => {
          const on = p.id === shown?.id;
          const name = pageName(p);
          const host = isWebAddress(p.url) ? pageLine("", p.url) : "";
          const asks = asking.has(p.id) && !on;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              className="pb-browser-tab pb-fade-in"
              data-page-id={p.id}
              data-asks={asks || undefined}
              aria-selected={on}
              aria-controls={stageId}
              aria-disabled={off || undefined}
              aria-keyshortcuts={canClose ? "Delete" : undefined}
              aria-label={`${name}${host ? `, ${host}` : ""}${asks ? ", the page asks something" : ""}`}
              title={host ? `${name}\n${host}` : name}
              tabIndex={on ? 0 : -1}
              onClick={() => !on && onShow(p)}
            >
              <span className="pb-browser-tab-name">{name}</span>
              {asks ? (
                <span className="pb-browser-tab-mark" aria-hidden="true">
                  <Mark state="waiting" />
                </span>
              ) : null}
              {canClose && (
                <span
                  className="pb-browser-tab-close"
                  aria-hidden="true"
                  title="Close this page"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(p);
                  }}
                >
                  <CloseIcon />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {mine && (
        <button type="button" className="pb-tool pb-browser-tab-add" aria-label="Open a new page" title="Open a new page" aria-disabled={off || undefined} onClick={() => !off && onOpen()}>
          <PlusIcon />
        </button>
      )}
    </div>
  );
}

/** Opens the page in a new tab of the laptop's own browser: a page on Claude in its named window beside Pobots. */
function openNewTab(url: string): void {
  if (/^https:\/\/claude\.ai\//i.test(url)) {
    if (!openOutside(url)) store.setBlockedLink({ url, title: "the page on Claude" });
    return;
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // Nothing more to do.
  }
}

/** A small floating list under a control in the top line. Arrow keys move, Enter chooses, Escape closes. */
function Menu({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    (items.find((i) => i.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const away = (e: globalThis.PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (i + 1) % items.length : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      items[to]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const opener = ref.current?.parentElement?.querySelector<HTMLElement>(".pb-tool");
      onClose();
      opener?.focus();
    } else if (e.key === "Tab") onClose();
  };
  return (
    <div className="pb-pop pb-pick-menu pb-browser-menu pb-arrive" role="menu" aria-label={label} ref={ref} onKeyDown={onKey}>
      {children}
    </div>
  );
}

/** The room over the picture, in its own box's pixels: where the panel's body begins and ends around it. */
interface Room {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A layer exactly over the picture, for what the page shows outside it. It stays inside the panel's
 * body, which clips anything that would reach past the panel.
 */
function Over({ stage, body, shown, children }: { stage: React.RefObject<HTMLDivElement | null>; body: React.RefObject<HTMLDivElement | null>; shown: { w: number; h: number }; children: (room: Room) => ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number; bw: number; bh: number } | null>(null);
  useLayoutEffect(() => {
    const s = stage.current;
    const b = body.current;
    if (!s || !b) return;
    const measure = () => setAt((p) => (p && p.x === s.offsetLeft && p.y === s.offsetTop && p.bw === b.clientWidth && p.bh === b.clientHeight ? p : { x: s.offsetLeft, y: s.offsetTop, bw: b.clientWidth, bh: b.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, [stage, body, shown.w, shown.h]);
  if (!at) return null;
  const room: Room = { left: -at.x, top: -at.y, right: at.bw - at.x, bottom: at.bh - at.y };
  return (
    <div className="pb-browser-over" style={{ left: at.x, top: at.y, width: shown.w, height: shown.h }}>
      {children(room)}
    </div>
  );
}

/**
 * A question of the page itself (alert, confirm, prompt), drawn over the picture at the top in the
 * middle as a small raised card. Only the person in control can answer; it takes the focus only then.
 */
function AskCard({ ask, canAnswer, onAnswer }: { ask: Asked; canAnswer: boolean; onAnswer(accept: boolean, text?: string): void }) {
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(ask.defaultText ?? "");
  useEffect(() => {
    if (!canAnswer) return;
    if (field.current) {
      field.current.focus({ preventScroll: true });
      field.current.select();
    } else ok.current?.focus({ preventScroll: true });
  }, [canAnswer]);
  const yes = () => onAnswer(true, ask.type === "prompt" ? text : undefined);
  // An alert has only OK: closing it any way is the same answer.
  const no = () => onAnswer(ask.type === "alert");
  return (
    <div
      ref={card}
      className="pb-card pb-browser-ask pb-arrive"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="pb-browser-ask-head"
      aria-describedby="pb-browser-ask-message"
      onKeyDown={(e) => {
        if (e.key === "Escape" && canAnswer) {
          e.preventDefault();
          e.stopPropagation();
          no();
        }
      }}
    >
      <p className="pb-browser-ask-head" id="pb-browser-ask-head">
        The page asks
      </p>
      <p className="pb-browser-ask-message" id="pb-browser-ask-message" tabIndex={-1}>
        {ask.message}
      </p>
      {ask.type === "prompt" && (
        <input
          ref={field}
          className="pb-input pb-browser-ask-input"
          type="text"
          aria-label="Your answer"
          value={text}
          disabled={!canAnswer}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAnswer) {
              e.preventDefault();
              yes();
            }
          }}
        />
      )}
      <div className="pb-card-actions">
        <button ref={ok} type="button" className="pb-btn pb-btn-sm pb-btn-primary" disabled={!canAnswer} onClick={yes}>
          OK
        </button>
        {ask.type !== "alert" && (
          <button type="button" className="pb-btn pb-btn-sm" disabled={!canAnswer} onClick={no}>
            Cancel
          </button>
        )}
      </div>
      {!canAnswer && <p className="pb-card-foot pb-browser-ask-foot">Take control to answer</p>}
    </div>
  );
}

/** Space between the list's box and its choices, and between the choices and the panel's edge, in pixels (space-1, space-2). */
const MENU_GAP = 4;
const MENU_EDGE = 8;
/** The choices are never narrower than this, and never taller than this, in pixels. */
const MENU_MIN_W = 200;
const MENU_MAX_H = 360;

/**
 * The choices of a drop-down list the person opened in the page, as one of the app's own menus:
 * placed under the list's box (above it when there is more room there), scaled with the picture,
 * never outside the panel, scrolling inside when long. Up, Down, Home, End and the first letters
 * move; Enter or a click chooses; Escape or Tab closes without choosing.
 */
function ChoicesMenu({ choices, scale, room, canAnswer, onChoose }: { choices: Choices; scale: number; room: Room; canAnswer: boolean; onChoose(index?: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opts = choices.options;
  const usable = (i: number) => i >= 0 && i < opts.length && !opts[i]!.disabled;
  const first = opts.findIndex((o) => o.selected && !o.disabled);
  const [active, setActive] = useState(first >= 0 ? first : opts.findIndex((o) => !o.disabled));
  const typedRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  // The list's box over the picture, and where the choices go.
  const box = { x: choices.x * scale, y: choices.y * scale, w: choices.width * scale, h: choices.height * scale };
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const natural = Math.min(el.scrollHeight, MENU_MAX_H);
    const width = Math.min(Math.max(box.w, MENU_MIN_W), room.right - room.left - 2 * MENU_EDGE);
    const left = Math.min(Math.max(box.x, room.left + MENU_EDGE), room.right - MENU_EDGE - width);
    const below = room.bottom - MENU_EDGE - (box.y + box.h + MENU_GAP);
    const above = box.y - MENU_GAP - (room.top + MENU_EDGE);
    const under = below >= natural || below >= above;
    const maxHeight = Math.max(0, Math.min(natural, under ? below : above));
    const top = under ? box.y + box.h + MENU_GAP : box.y - MENU_GAP - maxHeight;
    setPlace((p) => (p && p.left === left && p.top === top && p.width === width && p.maxHeight === maxHeight ? p : { left, top, width, maxHeight }));
  }, [box.x, box.y, box.w, box.h, room.left, room.top, room.right, room.bottom]);

  // The chosen one in view and focused, once placed; only for the person in control.
  useLayoutEffect(() => {
    if (!place || !canAnswer) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [place, active, canAnswer]);

  // A press anywhere else closes the choices without choosing (the picture's own press does too).
  useEffect(() => {
    if (!canAnswer) return;
    const away = (e: globalThis.PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.(".pb-browser-picture")) return;
      onChoose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [canAnswer, onChoose]);

  const step = (from: number, by: number): number => {
    for (let i = from + by; i >= 0 && i < opts.length; i += by) if (usable(i)) return i;
    return from;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!canAnswer) return;
    let to = -1;
    if (e.key === "ArrowDown") to = step(active, 1);
    else if (e.key === "ArrowUp") to = step(active, -1);
    else if (e.key === "Home") to = step(-1, 1);
    else if (e.key === "End") to = step(opts.length, -1);
    else if (e.key === "PageDown") to = [...Array(8)].reduce((i: number) => step(i, 1), active);
    else if (e.key === "PageUp") to = [...Array(8)].reduce((i: number) => step(i, -1), active);
    else if (e.key === "Enter" || (e.key === " " && performance.now() - typedRef.current.at >= 700)) {
      // Space chooses, except while the person is typing the first letters of an option.
      e.preventDefault();
      e.stopPropagation();
      if (usable(active)) onChoose(active);
      return;
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onChoose();
      return;
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // The first letters of an option go to it, as in a list in a page.
      const now = performance.now();
      const t = typedRef.current;
      t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const start = t.text.length === 1 ? active + 1 : active;
      for (let k = 0; k < opts.length; k++) {
        const i = (start + k) % opts.length;
        if (usable(i) && opts[i]!.label.toLowerCase().startsWith(t.text)) {
          to = i;
          break;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      if (to >= 0) setActive(to);
      return;
    }
    if (to >= 0) {
      e.preventDefault();
      e.stopPropagation();
      setActive(to);
    }
  };

  const rows: ReactNode[] = [];
  let group: string | undefined;
  opts.forEach((o, i) => {
    if (o.group !== group) {
      group = o.group;
      if (group !== undefined)
        rows.push(
          <div key={`g${i}`} className="pb-browser-menu-title" role="presentation">
            {group}
          </div>,
        );
    }
    rows.push(
      <button
        key={i}
        type="button"
        className="pb-option pb-browser-choice"
        role="option"
        data-index={i}
        data-grouped={o.group !== undefined || undefined}
        aria-selected={o.selected}
        aria-disabled={o.disabled || !canAnswer || undefined}
        tabIndex={canAnswer && i === active ? 0 : -1}
        onMouseEnter={() => canAnswer && usable(i) && setActive(i)}
        onClick={() => canAnswer && usable(i) && onChoose(i)}
      >
        <span className="pb-pick-name">{o.label || " "}</span>
        {o.selected && <CheckIcon className="pb-push" />}
      </button>,
    );
  });
  return (
    <div
      ref={ref}
      className="pb-pop pb-browser-choices pb-arrive"
      role="listbox"
      aria-label="Choices"
      aria-disabled={!canAnswer || undefined}
      style={place ? { left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight } : { left: box.x, top: box.y + box.h, visibility: "hidden" }}
      onKeyDown={onKey}
    >
      {rows}
    </div>
  );
}
