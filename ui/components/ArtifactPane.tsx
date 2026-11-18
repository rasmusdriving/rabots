// The artifact panel: a page a bot made, shown beside its chat in the place of the "Needs you" rail,
// the way Claude shows an artifact beside the conversation. The page runs in a sealed frame: a
// sandbox without allow-same-origin, so it has an origin of its own and can reach neither Pobots nor
// the page around it. Nothing in the window reads from the frame or writes into it.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { Artifact, ArtifactItem, Bot, Item } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { takeOpener } from "../lib/opener";
import { isPhone } from "../lib/phone";
import { phoneBack, phoneGo } from "../state/screens";
import { clockTime } from "../lib/words";
import { artifactSource, ensureArtifacts, openOnClaude, publishMessage, sendMessage } from "../state/actions";
import { panelRows, shareOf, store, useAppState, type ArtifactPanel, type Panel } from "../state/store";
import { BrowserView } from "./BrowserPane";
import { ArtifactLinkIcon, BackIcon, CloseIcon, FillIcon, Mark, NarrowerIcon, OutIcon, PublishIcon, ReloadIcon, UnfillIcon, WiderIcon } from "./bits";
import { Confirm } from "./Dialog";
import { rosterWidth } from "../lib/rail-width";

/** The sandbox of every artifact's frame. Never allow-same-origin, never allow-top-navigation. */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals";

/** The chat never gets narrower than this beside the panel. */
export const MIN_CHAT = 400;
/** The panel's column (its divider, the panel and the gap to the window's edge) never gets narrower than this. */
export const MIN_PANE = 380;
/** One step of the divider with the arrow keys, and of Wider and Narrower, as a share of the space. */
const KEY_STEP = 0.05;
const BUTTON_STEP = 0.1;
/** A page that has not loaded after this long counts as not loaded. */
const LOAD_TIMEOUT_MS = 20_000;

export type PanelMode = "side" | "full" | "narrow";

export interface PanelLayout {
  /** The space beside the roster, in pixels. */
  avail: number;
  /** Too narrow for the chat and the panel side by side: the panel takes the place of the chat. */
  narrow: boolean;
  /** The panel's column width beside the chat, in pixels. */
  px: number;
  /** The smallest and largest share the panel may take. */
  min: number;
  max: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));


/** Where the panel stands at the window's current width, for the share the person chose. */
export function usePanelLayout(share: number): PanelLayout {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const avail = Math.max(1, w - rosterWidth(w));
  const narrow = avail < MIN_CHAT + MIN_PANE;
  const lo = Math.min(MIN_PANE, avail);
  const hi = Math.max(lo, avail - MIN_CHAT);
  return { avail, narrow, px: narrow ? 0 : Math.round(clamp(share * avail, lo, hi)), min: lo / avail, max: hi / avail };
}

/** The newest copy of an artifact the chat holds, for before the bot's list is read. */
function lastInThread(items: Item[] | undefined, artifactId: string): Artifact | undefined {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "artifact" && it.artifact.id === artifactId) return (it as ArtifactItem).artifact;
  }
  return undefined;
}

/** On a phone, "Needs you" in a panel's top line: the sheet closes and the Needs you screen takes its place, one step of history. */
export function showNeedsOnPhone(): void {
  phoneGo(() => {
    store.setPanel(null);
    store.setPhoneScreen("needs");
  });
}

/** Closes the panel. The focus goes back to the row it was opened from, or the newest row of what it showed. */
export function closePanel(focusBack = true): void {
  // On a phone the panel is a sheet and a history entry: closing it is the browser's back.
  if (isPhone()) return phoneBack();
  // Where the focus goes is settled now, from what is there now; it is given a frame later, once
  // the chat can take it, and only if nothing else has taken the focus meanwhile.
  const now = store.get().panel;
  const rows = now ? document.querySelectorAll<HTMLElement>(`.app-main ${panelRows(now)}`) : [];
  const back = takeOpener() ?? rows[rows.length - 1];
  const had = document.activeElement;
  store.setPanel(null);
  if (!focusBack || !back) return;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now && now !== document.body && now !== had && now.isConnected) return;
    if (back.isConnected) back.focus({ preventScroll: true });
  });
}

/** Does the page answer? Only asked of a path on the page's own origin; the frame itself is never read. */
async function answers(src: string): Promise<boolean> {
  if (!src.startsWith("/")) return true;
  try {
    const res = await fetch(src, { method: "HEAD", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The one panel beside the chat, in the place of the rail. It shows an artifact or the browser (step
 * 2g): the same place, width, divider, fill, narrow mode, "Needs you" count and Escape for both.
 * Opening one while the other is open swaps the content; the panel and its divider stay.
 */
export function ArtifactPane({ bot, panel, mode, layout, backName }: { bot: Bot; panel: Panel; mode: PanelMode; layout: PanelLayout; backName: string }) {
  useEffect(() => ensureArtifacts(bot.id), [bot.id]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    closePanel();
  };
  return (
    <section className="pb-artifact-pane app-artifact" data-mode={mode} data-content={panel.kind} aria-label={panel.kind === "browser" ? "Browser" : "Artifact"} onKeyDown={onKeyDown}>
      {mode === "side" && <Divider layout={layout} />}
      {panel.kind === "browser" ? (
        <BrowserView key="browser" panel={panel} mode={mode} layout={layout} backName={backName} />
      ) : (
        <ArtifactView key={panel.artifactId} bot={bot} panel={panel} mode={mode} layout={layout} />
      )}
    </section>
  );
}

interface Frame {
  id: number;
  src: string;
  rev: number;
  loaded: boolean;
}

function ArtifactView({ bot, panel, mode, layout }: { bot: Bot; panel: ArtifactPanel; mode: PanelMode; layout: PanelLayout }) {
  const listed = useAppState((s) => s.artifacts[bot.id]?.find((a) => a.id === panel.artifactId));
  const fromChat = useAppState((s) => lastInThread(s.threads[bot.mainThreadId]?.items, panel.artifactId));
  const cards = useAppState((s) => s.cards.length);
  const share = useAppState(shareOf);
  const a = listed ?? fromChat;
  const title = a?.title.trim() || "Artifact";
  const busy = bot.state === "thinking" || bot.state === "working";
  const back = useRef<HTMLButtonElement>(null);

  const [frames, setFrames] = useState<Frame[]>([]);
  /** The first frame to load fades in on the panel; a frame that replaces another is swapped in at once. */
  const [fadeId, setFadeId] = useState<number>();
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const req = useRef(0);
  const nextId = useRef(1);
  /** The newest rev asked for, so a change asks once. */
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shown = frames.find((f) => f.loaded);

  /** Asks the engine where the page is now and puts a new frame under the one shown, to swap once it has loaded. */
  const load = useCallback(async () => {
    const mine = ++req.current;
    let got: { src: string; rev: number } | null = null;
    // If the first answer does not work (the key ran out, say), ask once more.
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const r = await artifactSource(bot.id, panel.artifactId);
        if (await answers(r.src)) got = r;
      } catch (e) {
        if (e instanceof EngineError && (e.code === "not_found" || e.code === "conflict")) break;
      }
    }
    if (mine !== req.current) return;
    if (!got) {
      setFrames((f) => {
        const old = f.filter((x) => x.loaded);
        setFailed(old.length === 0);
        setStale(old.length > 0);
        return old;
      });
      return;
    }
    asked.current = Math.max(asked.current, got.rev);
    const id = nextId.current++;
    const frame: Frame = { id, src: got.src, rev: got.rev, loaded: false };
    setFailed(false);
    setFrames((f) => [...f.filter((x) => x.loaded), frame]);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setFrames((f) => {
        if (!f.some((x) => x.id === id && !x.loaded)) return f;
        const old = f.filter((x) => x.loaded);
        setFailed(old.length === 0);
        setStale(old.length > 0);
        return old;
      });
    }, LOAD_TIMEOUT_MS);
  }, [bot.id, panel.artifactId]);

  useEffect(() => {
    void load();
    return () => {
      req.current++;
      clearTimeout(timer.current);
    };
  }, [load]);

  // When the bot changes the page, the frame loads again by itself. The old one stays until then.
  const rev = a?.kind === "page" && a.available ? a.rev : 0;
  useEffect(() => {
    if (rev > asked.current && asked.current > 0) {
      asked.current = rev;
      void load();
    }
  }, [rev, load]);

  /** A frame has loaded: it is shown, and every older one goes in the same moment. */
  const onLoad = (id: number) => {
    if (!frames.some((x) => x.loaded)) setFadeId(id);
    setFrames((f) => {
      const me = f.find((x) => x.id === id);
      if (!me || me.loaded) return f;
      clearTimeout(timer.current);
      return f.filter((x) => x.id >= id).map((x) => (x.id === id ? { ...x, loaded: true } : x));
    });
    setStale(false);
    setFailed(false);
  };

  const reload = () => {
    setFailed(false);
    void load();
  };

  // In a narrow window the panel takes the place of the chat: the focus goes to the way back.
  useEffect(() => {
    if (mode !== "narrow") return;
    const at = document.activeElement;
    if (!at || at === document.body || at.closest(".app-main")) back.current?.focus({ preventScroll: true });
  }, [mode]);

  const setShare = (n: number) => store.setPanelShare(Math.round(clamp(n, layout.min, layout.max) * 1000) / 1000);
  const atMin = layout.px <= Math.round(layout.min * layout.avail) + 1;
  const atMax = layout.px >= Math.round(layout.max * layout.avail) - 1;

  const gone = !!a && a.kind === "page" && !a.available;
  const stamp = gone
    ? "The file is gone"
    : stale
      ? "Could not load the newest version"
      : a
        ? `${a.rev > 1 && a.updatedAt !== a.createdAt ? "Updated" : "Made"} ${clockTime(a.updatedAt)}`
        : "";

  const publish = async () => {
    setSending(true);
    setSendError(undefined);
    try {
      await sendMessage(bot.id, publishMessage(title));
      setAsking(false);
    } catch (e) {
      setSendError(messageOf(e));
    } finally {
      setSending(false);
    }
  };

  const showRail = () => {
    if (isPhone()) return showNeedsOnPhone();
    closePanel(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".app-rail button")?.focus({ preventScroll: true }));
  };

  return (
    <div className="pb-artifact-panel" data-artifact-id={panel.artifactId}>
      <div className="pb-artifact-bar">
        {mode === "narrow" && (
          <button ref={back} type="button" className="pb-helper-back pb-artifact-back" aria-label={`Back to ${bot.name}`} onClick={() => closePanel()}>
            <BackIcon />
            <span className="pb-helper-back-name">{bot.name}</span>
          </button>
        )}
        <div className="pb-artifact-bar-text">
          <h2 className="pb-artifact-bar-title" title={title}>
            {title}
          </h2>
          <span className="pb-artifact-when pb-fade-in" key={`${stamp}-${a?.rev ?? 0}`}>
            {stamp || " "}
          </span>
        </div>
        {cards > 0 && (
          <button type="button" className="pb-artifact-needs" aria-label={`Needs you, ${cards}. Close the artifact and show what needs you`} onClick={showRail}>
            <Mark state="waiting" />
            <span>Needs you</span>
            <span className="pb-artifact-needs-n pb-fade-in" key={cards}>
              {cards}
            </span>
          </button>
        )}
        <div className="pb-artifact-tools" role="toolbar" aria-label="Artifact">
          <Tool label="Load again" onClick={reload} off={gone}>
            <ReloadIcon />
          </Tool>
          <a
            className="pb-tool"
            href={shown?.src}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
            aria-disabled={!shown || undefined}
            tabIndex={shown ? undefined : -1}
          >
            <OutIcon />
          </a>
          {a?.url ? (
            <Tool label="Open on Claude" onClick={() => openOnClaude(a.url!, title)}>
              <ArtifactLinkIcon />
            </Tool>
          ) : (
            <Tool
              label="Publish to Claude"
              off={busy || gone}
              reason={busy ? `${bot.name} is working. Try again when it is done.` : gone ? "The file is gone." : undefined}
              onClick={() => {
                setSendError(undefined);
                setAsking(true);
              }}
            >
              <PublishIcon />
            </Tool>
          )}
          {mode === "side" && (
            <>
              <Tool label="Narrower" className="pb-tool-width" onClick={() => setShare(clamp(share, layout.min, layout.max) - BUTTON_STEP)} disabled={atMin}>
                <NarrowerIcon />
              </Tool>
              <Tool label="Wider" className="pb-tool-width" onClick={() => setShare(clamp(share, layout.min, layout.max) + BUTTON_STEP)} disabled={atMax}>
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
      <div className="pb-artifact-body" data-loaded={!!shown || undefined}>
        {frames.map((f) => (
          <iframe
            key={f.id}
            className={`pb-artifact-frame${f.loaded && f.id === fadeId ? " pb-fade-in" : ""}`}
            data-state={f.loaded ? "shown" : "loading"}
            data-rev={f.rev}
            src={f.src}
            sandbox={ARTIFACT_SANDBOX}
            referrerPolicy="no-referrer"
            title={title}
            aria-hidden={f.loaded ? undefined : true}
            tabIndex={f.loaded ? undefined : -1}
            onLoad={() => onLoad(f.id)}
          />
        ))}
        {!shown && !failed && (
          <p className="pb-artifact-status" role="status" data-wait="">
            Loading the artifact
          </p>
        )}
        {!shown && failed && (
          <div className="pb-artifact-status" role="alert">
            <p>This artifact could not be loaded</p>
            <button type="button" className="pb-btn pb-btn-sm" onClick={reload}>
              Load again
            </button>
          </div>
        )}
      </div>
      {asking && (
        <Confirm
          title="Publish this to Claude?"
          text={`${bot.name} puts this artifact on Claude and gives you a link to share. It stays private there until you share it.`}
          yes="Publish"
          no="Cancel"
          busy={sending}
          error={sendError}
          onYes={() => void publish()}
          onNo={() => setAsking(false)}
        />
      )}
    </div>
  );
}

/** A small control in the panel's top line: an icon, with its words on hover and for screen readers. */
export function Tool({
  label,
  onClick,
  children,
  off,
  reason,
  disabled,
  className,
  expanded,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  /** Off for a reason, but still reachable, so the reason can be read. */
  off?: boolean;
  reason?: string;
  disabled?: boolean;
  className?: string;
  /** For a control that opens a small menu. */
  expanded?: boolean;
}) {
  const words = off && reason ? `${label}. ${reason}` : label;
  return (
    <button
      type="button"
      className={`pb-tool${className ? ` ${className}` : ""}`}
      aria-label={words}
      title={words}
      aria-disabled={off || undefined}
      disabled={disabled}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onClick={() => !off && onClick()}
    >
      {children}
    </button>
  );
}

/**
 * The line between the chat and the panel. Dragged, or moved with the arrow keys, it makes the panel
 * wider or narrower; the width is remembered on this device. The chat keeps its place meanwhile.
 */
function Divider({ layout }: { layout: PanelLayout }) {
  const share = useAppState(shareOf);
  const dragging = useRef(false);
  const set = (n: number) => store.setPanelShare(Math.round(clamp(n, layout.min, layout.max) * 1000) / 1000);
  const value = Math.round((layout.px / layout.avail) * 100);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    // Frames would take the pointer as it passes over them.
    document.documentElement.dataset.dragging = "artifact";
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const half = e.currentTarget.offsetWidth / 2;
    set((window.innerWidth - e.clientX + half) / layout.avail);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    delete document.documentElement.dataset.dragging;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // From the width shown: a stored share may be past what the window allows (the browser's starts at 1).
    const now = clamp(share, layout.min, layout.max);
    const to = e.key === "ArrowLeft" ? now + KEY_STEP : e.key === "ArrowRight" ? now - KEY_STEP : e.key === "Home" ? layout.max : e.key === "End" ? layout.min : null;
    if (to === null) return;
    e.preventDefault();
    set(to);
  };

  return (
    <div
      className="pb-artifact-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the artifact. Left arrow makes it wider, right arrow narrower"
      aria-valuemin={Math.round(layout.min * 100)}
      aria-valuemax={Math.round(layout.max * 100)}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    >
      <span className="pb-artifact-grip" aria-hidden="true" />
    </div>
  );
}
