// Pictures and files in the chat. In the message box: the tray of chips above the text, one per
// attachment, with its upload, its removal and its problem. In a message: each picture in a box of
// its final size before it loads (from the stored width and height), so no line moves when it
// arrives; each file as a chip that downloads. A picture opens large in a dialog over the chat.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../shared/protocol";
import { DownloadButton } from "./FileDownload";
import { attachmentUrl } from "../state/actions";
import { removeChip, retry, trayLine, type Chip, type Tray } from "../state/tray";
import { ATTACH_WORDS, fileSize } from "../lib/words";
import { isPhone, usePhone } from "../lib/phone";
import { useBackLayer } from "../lib/phone-back";
import { CloseIcon, FileIcon, PictureIcon } from "./bits";

// ------------------------------------------------------------ the tray in the message box

/**
 * A long name shortened in the middle, so its end stays: two screenshots differ by their time,
 * "Screenshot 20…08.12.png" and "Screenshot 20…08.14.png", not by a cut-off start. The whole name
 * is in the title and read out.
 */
export function middleName(name: string, max = 24): string {
  if (name.length <= max) return name;
  const tail = 9;
  return `${name.slice(0, max - tail - 1).trimEnd()}\u2026${name.slice(-tail)}`;
}

/**
 * The chips above the text, in one row of a fixed height that scrolls sideways when full, and one
 * quiet line under them. Both keep their height whatever the chips do: upload, fail, finish. When
 * the row hides chips, its edge fades softly on the side where more are (a mask, so nothing moves)
 * and the line says how many are attached.
 */
export function AttachTray({ tray, nudge = 0, waiting = false, onEmpty }: { tray: Tray; nudge?: number; waiting?: boolean; onEmpty(): void }) {
  const list = useRef<HTMLUListElement>(null);
  const lineEl = useRef<HTMLParagraphElement>(null);
  // Which chip the pointer is on and which one holds the focus: the line explains that one's problem.
  const [hovered, setHovered] = useState<string | undefined>();
  const [focused, setFocused] = useState<string | undefined>();
  // Whether the row hides chips, and on which side.
  const [edges, setEdges] = useState({ overflow: false, start: false, end: false });
  // The line with the count before it, when it was measured and did not fit.
  const [tooLong, setTooLong] = useState<string | undefined>();
  const line = trayLine(tray, { waiting, lit: hovered ?? focused, overflow: edges.overflow });
  const text = line.text !== tooLong ? line.text : line.short;

  // A chip that was just added is brought into sight at the end of the row, at once, never by a slide.
  const count = useRef(tray.chips.length);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && tray.chips.length > count.current) el.scrollLeft = el.scrollWidth;
    count.current = tray.chips.length;
  }, [tray.chips.length]);

  // Measure the row: on every change of its chips, its width and its scroll.
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    const start = overflow && el.scrollLeft > 1;
    const end = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((now) => (now.overflow === overflow && now.start === start && now.end === end ? now : { overflow, start, end }));
  };
  useLayoutEffect(measure, [tray.chips]);
  useEffect(() => {
    const el = list.current;
    const p = lineEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = p?.clientWidth ?? 0;
    const observer = new ResizeObserver(() => {
      measure();
      // A wider or narrower line may fit the count again, or no longer.
      if (p && p.clientWidth !== width) {
        width = p.clientWidth;
        setTooLong(undefined);
      }
    });
    observer.observe(el);
    if (p) observer.observe(p);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The count goes before the message only when both fit in the one line; else the message alone.
  useLayoutEffect(() => {
    const p = lineEl.current;
    if (p && text === line.text && line.text !== line.short && p.scrollWidth > p.clientWidth + 0.5) setTooLong(line.text);
  });

  // A removed chip hands the focus on to its neighbour, or to the text when it was the last one.
  const remove = (key: string) => {
    const at = tray.chips.findIndex((c) => c.key === key);
    const next = tray.chips[at + 1] ?? tray.chips[at - 1];
    const hadFocus = !!list.current?.contains(document.activeElement);
    removeChip(key);
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      const el = next && list.current?.querySelector<HTMLElement>(`[data-chip="${next.key}"] .pb-chip-remove`);
      if (el) el.focus({ preventScroll: true });
      else onEmpty();
    });
  };

  return (
    <div className="pb-tray" role="group" aria-label={edges.overflow ? `Attached to this message, ${tray.chips.length}` : "Attached to this message"}>
      <ul className="pb-tray-chips" ref={list} onScroll={measure} data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
        {tray.chips.map((chip) => (
          <li
            key={chip.key}
            className="pb-fade-in"
            onPointerEnter={() => setHovered(chip.key)}
            onPointerLeave={() => setHovered((k) => (k === chip.key ? undefined : k))}
            onFocus={() => setFocused(chip.key)}
            onBlur={() => setFocused((k) => (k === chip.key ? undefined : k))}
          >
            <TrayChip chip={chip} onRemove={() => remove(chip.key)} />
          </li>
        ))}
      </ul>
      {/* A new key when Send was pressed with a problem in the box: the same words, read out again. */}
      <p key={nudge} ref={lineEl} className="pb-tray-line" data-problem={line.problem || undefined} role="status" aria-live="polite" title={text || undefined}>
        {text}
      </p>
    </div>
  );
}

function TrayChip({ chip, onRemove }: { chip: Chip; onRemove(): void }) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const meta =
    chip.status === "preparing" ? "Preparing" : chip.status === "uploading" ? "Uploading" : chip.status === "refused" ? (chip.problem?.includes("too big") ? "Too big" : "Can't attach") : chip.status === "failed" ? "" : fileSize(chip.size);
  // A chip with a problem carries its own whole reason, as its name and its tooltip, so each one can
  // be read when several are refused at once.
  return (
    <div
      className="pb-chip-file"
      data-chip={chip.key}
      data-status={chip.status}
      title={chip.problem ?? chip.name}
      role={chip.problem ? "group" : undefined}
      aria-label={chip.problem}
    >
      <span className="pb-chip-thumb" aria-hidden="true">
        {chip.thumb && !thumbBroken ? <img src={chip.thumb} alt="" draggable={false} onError={() => setThumbBroken(true)} /> : chip.picture ? <PictureIcon /> : <FileIcon />}
      </span>
      <span className="pb-chip-text">
        <span className="pb-chip-name" data-name={chip.name}>
          <span aria-hidden="true">{middleName(chip.name)}</span>
          <span className="app-sr">{chip.name}</span>
        </span>
        {chip.status === "failed" ? (
          <button type="button" className="pb-chip-retry" aria-label={`Try again to upload ${chip.name}`} onClick={() => retry(chip.key)}>
            Try again
          </button>
        ) : (
          <span className="pb-chip-meta">{meta}</span>
        )}
      </span>
      <button type="button" className="pb-chip-remove" aria-label={`Remove ${chip.name}`} title="Remove" onClick={onRemove}>
        <CloseIcon />
      </button>
      {/* How far the upload is: a quiet line along the foot that only moves forward. */}
      <span className="pb-chip-progress" aria-hidden="true" data-on={chip.status === "uploading" || undefined} style={{ transform: `scaleX(${chip.status === "uploading" || chip.status === "preparing" ? chip.progress : 1})` }} />
    </div>
  );
}

// ------------------------------------------------------------ in a message

/** Longest side of a picture in a message, and the least either side may be, in px. */
const PICTURE_MAX = 320;
const PICTURE_MIN = 48;
/** The box for a picture whose size is not known: never drawn from the picture itself. */
const PICTURE_UNKNOWN = { w: 240, h: 180, clamped: true };

/** The box a picture stands in, from its stored size alone, so it is the same before and after it loads. */
export function pictureBox(a: Pick<Attachment, "width" | "height">): { w: number; h: number; clamped: boolean } {
  if (!a.width || !a.height) return PICTURE_UNKNOWN;
  const s = Math.min(1, PICTURE_MAX / Math.max(a.width, a.height));
  const w = Math.round(a.width * s);
  const h = Math.round(a.height * s);
  return { w: Math.max(PICTURE_MIN, w), h: Math.max(PICTURE_MIN, h), clamped: w < PICTURE_MIN || h < PICTURE_MIN };
}

/** The pictures and files of one message, above its text. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const pictures = attachments.filter((a) => a.kind === "picture" && !a.missing);
  const files = attachments.filter((a) => a.kind !== "picture" || a.missing);
  return (
    <>
      {pictures.length > 0 && (
        <div className="pb-msg-pictures">
          {pictures.map((a) => (
            <MessagePicture
              key={a.id}
              attachment={a}
              onOpen={(el) => {
                opener.current = el;
                setOpen(a);
              }}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="pb-msg-files">
          {files.map((a) => (
            <MessageFile key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {open && (
        <PictureView
          attachment={open}
          onClose={() => {
            setOpen(null);
            // Back to the picture it came from, without moving the chat.
            opener.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/**
 * Pictures this window has shown before, by address. On a phone the chat is taken away while the
 * bot's page shows and put back afterwards: a picture it showed before is then simply there, drawn
 * with the chat's first frame, and does not fade in a second time.
 */
const shownBefore = new Set<string>();

function MessagePicture({ attachment: a, onOpen }: { attachment: Attachment; onOpen(el: HTMLButtonElement): void }) {
  const box = pictureBox(a);
  // The engine has no preview when it could not make one (it answers 404): then the picture itself,
  // in the same box.
  const [noPreview, setNoPreview] = useState(false);
  const src = attachmentUrl(a.id, noPreview ? "full" : "preview");
  const img = useRef<HTMLImageElement>(null);
  // Shown before, on a phone: there from the start, read at once (not lazily, not decoded later).
  const [again] = useState(() => isPhone() && !!src && shownBefore.has(src));
  // A picture already in the browser's cache (shown again, after a reload) is simply there; only one
  // that comes in later fades in, inside its box.
  const [shown, setShownState] = useState(again);
  const setShown = () => {
    if (src) shownBefore.add(src);
    setShownState(true);
  };
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return (
    <button
      type="button"
      className="pb-picture"
      data-fit={box.clamped ? "contain" : undefined}
      data-shown={shown || undefined}
      style={{ width: box.w, aspectRatio: `${box.w} / ${box.h}` }}
      aria-haspopup="dialog"
      title={`${a.name}. Open large`}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      {src && <img ref={img} src={src} alt={a.name} width={box.w} height={box.h} loading={again ? "eager" : "lazy"} decoding={again ? "sync" : "async"} draggable={false} onLoad={() => setShown()} onError={() => setNoPreview(true)} />}
    </button>
  );
}

function MessageFile({ attachment: a }: { attachment: Attachment }) {
  const inner = (
    <>
      <span className="pb-chip-thumb" aria-hidden="true">
        {a.kind === "picture" ? <PictureIcon /> : <FileIcon />}
      </span>
      <span className="pb-chip-text">
        <span className="pb-chip-name">{a.name}</span>
        <span className="pb-chip-meta">{a.expired ? ATTACH_WORDS.notKept : a.missing ? ATTACH_WORDS.gone : fileSize(a.size)}</span>
      </span>
    </>
  );
  const href = a.missing ? undefined : attachmentUrl(a.id, "download");
  if (!href)
    return (
      <div className="pb-chip-file pb-msg-file" data-missing={a.missing || undefined} title={a.missing ? `${a.name}. ${a.expired ? ATTACH_WORDS.notKept : ATTACH_WORDS.gone}` : a.name}>
        {inner}
      </div>
    );
  return (
    <a className="pb-chip-file pb-msg-file" href={href} download={a.name} title={`${a.name}. Download`} aria-label={`${a.name}, ${fileSize(a.size)}. Download`}>
      {inner}
    </a>
  );
}

// ------------------------------------------------------------ the large view

/** Room the large view leaves around the picture: the dimmed edge, the card's padding, its head line and gap (px). */
const LARGE_EDGE_X = 2 * 24 + 2 * 12;
const LARGE_EDGE_Y = 2 * 24 + 2 * 12 + 32 + 8;

/** The large picture's size: as large as the window allows, never larger than the picture itself, from its stored size. */
export function largeSize(a: Pick<Attachment, "width" | "height">, room: { w: number; h: number }): { w: number; h: number } {
  const w = a.width || 1200;
  const h = a.height || 900;
  const s = Math.min(1, Math.max(1, room.w - LARGE_EDGE_X) / w, Math.max(1, room.h - LARGE_EDGE_Y) / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** The large picture's size on a phone: as large as the screen below its head allows, never larger than the picture itself. */
export function largeSizePhone(a: Pick<Attachment, "width" | "height">, room: { w: number; h: number }): { w: number; h: number } {
  const w = a.width || 1200;
  const h = a.height || 900;
  const s = Math.min(1, Math.max(1, room.w) / w, Math.max(1, room.h) / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * A picture opened large: a dialog over the chat on the dimmed layer. The small preview the chat
 * already has stands in at the final size until the full picture has loaded over it. Escape, the
 * close button and a click outside the picture close it; the chat underneath does not move.
 *
 * On a phone it fills the screen on the window's ground, its name and Close at the top. Pinching and
 * a double tap zoom the picture itself (the page's own zoom is left alone everywhere else), and it is
 * a history entry: back closes it instead of leaving the bot.
 */
function PictureView({ attachment: a, onClose }: { attachment: Attachment; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  const downOutside = useRef(false);
  const outside = (target: EventTarget) => !(target as Element).closest(".pb-picture-large, .pb-picture-view-head");
  const [full, setFull] = useState(false);
  const [noPreview, setNoPreview] = useState(false);
  const preview = noPreview ? undefined : attachmentUrl(a.id, "preview");
  const src = attachmentUrl(a.id, "full");
  const download = attachmentUrl(a.id, "download");
  const [room, setRoom] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const phone = usePhone();
  const layer = useBackLayer(onClose);
  const stage = useRef<HTMLDivElement>(null);
  const [stageRoom, setStageRoom] = useState<{ w: number; h: number } | null>(null);
  const size = phone ? largeSizePhone(a, stageRoom ?? { w: room.w, h: room.h - PHONE_HEAD }) : largeSize(a, room);

  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    const onResize = () => setRoom({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // On a phone the picture fills the room under the head, measured before it is painted.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!phone || !el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setStageRoom((now) => (now && now.w === w && now.h === h ? now : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      layer.close();
    } else if (e.key === "Tab") {
      const link = e.currentTarget.querySelector<HTMLAnchorElement>("a[download]");
      e.preventDefault();
      if (link && document.activeElement === close.current) link.focus({ preventScroll: true });
      else close.current?.focus({ preventScroll: true });
    }
  };

  const pictures = (
    <>
      {preview && <img className="pb-picture-large-preview" src={preview} alt="" draggable={false} onError={() => setNoPreview(true)} />}
      {src && <img className="pb-picture-large-full" src={src} alt={a.name} decoding="async" draggable={false} onLoad={() => setFull(true)} />}
    </>
  );

  return createPortal(
    <div
      className="pb-scrim pb-picture-scrim"
      // A click outside closes it on the click, not on the press: a press would close it at once and the
      // browser would then move the focus to whatever lay under the pointer (the page itself). The press
      // outside keeps the focus where it is, so closing can hand it back to the picture.
      onPointerDown={(e) => {
        downOutside.current = outside(e.target);
      }}
      onMouseDown={(e) => {
        if (outside(e.target)) e.preventDefault();
      }}
      onClick={(e) => {
        // Through the layer: on a phone it also leaves its history entry; on the laptop it is onClose.
        if (downOutside.current && outside(e.target)) layer.close();
        downOutside.current = false;
      }}
    >
      <div className="pb-picture-view" role="dialog" aria-modal="true" aria-label={a.name} onKeyDown={onKeyDown}>
        <div className="pb-picture-view-head">
          <span className="pb-picture-view-name" title={a.name}>
            {a.name}
          </span>
          {download && <DownloadButton href={download} name={a.name} />}
          <button ref={close} type="button" className="pb-icon-btn pb-picture-view-close" aria-label="Close" title="Close" onClick={() => layer.close()}>
            <CloseIcon />
          </button>
        </div>
        {phone ? (
          <div className="pb-picture-stage" ref={stage}>
            <ZoomPicture full={full} w={size.w} h={size.h}>
              {pictures}
            </ZoomPicture>
          </div>
        ) : (
          <div className="pb-picture-large" data-full={full || undefined} style={{ width: size.w, height: size.h }}>
            {pictures}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Room the phone's large view keeps for its head before the room is measured (px). */
const PHONE_HEAD = 60;
/** How far a picture zooms in, and what a double tap zooms to. */
const ZOOM_MAX = 4;
const ZOOM_TAP = 2;
/** Two taps this close in time (ms) and place (px) are a double tap; a press that moves further is a drag. */
const TAP_MS = 300;
const TAP_SLOP = 24;

/**
 * The picture on a phone, zoomed by the fingers: pinch around the fingers, drag while zoomed, a
 * double tap toggles 2x around the tap. Only this element takes the touches (touch-action: none in
 * phone-chat.css), so the page's own zoom is blocked nowhere else. The zoom is drawn as a transform
 * on the pictures inside the box; the box itself keeps its size and place.
 */
function ZoomPicture({ full, w, h, children }: { full: boolean; w: number; h: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const zoom = useRef({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ s: number; x: number; y: number; d: number; mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);

  // A new size (the phone turned): the whole picture again.
  useEffect(() => {
    if (zoom.current.s === 1) return;
    zoom.current = { s: 1, x: 0, y: 0 };
    if (inner.current) inner.current.style.transform = "";
    setZoomed(false);
  }, [w, h]);

  // Safari's own pinch events: the page is not zoomed from the picture.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", stop);
    el.addEventListener("gesturechange", stop);
    return () => {
      el.removeEventListener("gesturestart", stop);
      el.removeEventListener("gesturechange", stop);
    };
  }, []);

  /** A point in the box, from its centre. */
  const local = (x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  const draw = (next: { s: number; x: number; y: number }, eased = false) => {
    const s = Math.min(ZOOM_MAX, Math.max(1, next.s));
    // The picture never leaves a gap at its edge: it is moved at most as far as it is larger.
    const mx = ((s - 1) * w) / 2;
    const my = ((s - 1) * h) / 2;
    const z = { s, x: s === 1 ? 0 : Math.min(mx, Math.max(-mx, next.x)), y: s === 1 ? 0 : Math.min(my, Math.max(-my, next.y)) };
    zoom.current = z;
    const el = inner.current;
    if (el) {
      if (eased) el.dataset.eased = "";
      else delete el.dataset.eased;
      el.style.transform = z.s === 1 ? "" : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    }
    setZoomed(z.s > 1);
  };

  const begin = () => {
    const pts = [...pointers.current.values()];
    const z = zoom.current;
    if (pts.length >= 2) {
      const [p, q] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const m = local((p.x + q.x) / 2, (p.y + q.y) / 2);
      gesture.current = { s: z.s, x: z.x, y: z.y, d: Math.hypot(p.x - q.x, p.y - q.y) || 1, mx: m.x, my: m.y, px: 0, py: 0, moved: true };
    } else if (pts.length === 1) {
      const p = pts[0]!;
      gesture.current = { s: z.s, x: z.x, y: z.y, d: 0, mx: 0, my: 0, px: p.x, py: p.y, moved: false };
    } else gesture.current = null;
  };

  return (
    <div
      ref={box}
      className="pb-picture-large"
      data-full={full || undefined}
      data-zoomed={zoomed || undefined}
      style={{ width: w, height: h }}
      onPointerDown={(e) => {
        box.current?.setPointerCapture?.(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        begin();
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (!g) return;
        const pts = [...pointers.current.values()];
        if (pts.length >= 2 && g.d) {
          const [p, q] = pts as [{ x: number; y: number }, { x: number; y: number }];
          const s = Math.min(ZOOM_MAX, Math.max(1, (g.s * Math.hypot(p.x - q.x, p.y - q.y)) / g.d));
          const m = local((p.x + q.x) / 2, (p.y + q.y) / 2);
          // The point of the picture that was between the fingers stays between them.
          draw({ s, x: m.x - (s * (g.mx - g.x)) / g.s, y: m.y - (s * (g.my - g.y)) / g.s });
        } else if (pts.length === 1) {
          const p = pts[0]!;
          if (!g.moved && Math.hypot(p.x - g.px, p.y - g.py) > TAP_SLOP / 2) g.moved = true;
          if (g.moved && zoom.current.s > 1) draw({ s: g.s, x: g.x + p.x - g.px, y: g.y + p.y - g.py });
        }
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        const wasOne = pointers.current.size === 1;
        pointers.current.delete(e.pointerId);
        if (wasOne && g && !g.moved && !g.d) {
          const t = performance.now();
          const last = lastTap.current;
          if (last && t - last.t < TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TAP_SLOP) {
            lastTap.current = null;
            const z = zoom.current;
            const c = local(e.clientX, e.clientY);
            // Zoom in around the tap, or back to the whole picture.
            draw(z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: ZOOM_TAP, x: -c.x * (ZOOM_TAP - 1), y: -c.y * (ZOOM_TAP - 1) }, true);
          } else lastTap.current = { t, x: e.clientX, y: e.clientY };
        } else if (g?.moved) lastTap.current = null;
        begin();
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        begin();
      }}
    >
      <div ref={inner} className="pb-picture-zoom">
        {children}
      </div>
    </div>
  );
}
