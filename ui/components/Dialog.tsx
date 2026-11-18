// A dialog that floats over the app on a dimmed layer: the sheet for adding a bot and the small
// confirms ("Retire Inbox?", "Leave without saving?"). Focus stays inside while it is open,
// Escape and a click on the dimmed layer close it, and focus goes back where it was.
//
// On a phone (phone-chat.css) it fits the visible height with its foot reachable by scrolling inside,
// it does not put the focus in a text field by itself (the keyboard would cover half of it at once:
// the dialog takes the focus and the first tap on a field opens the keyboard), and it is a history
// entry, so back closes it.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isPhone, usePhone } from "../lib/phone";
import { useBackLayer } from "../lib/phone-back";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What opens the keyboard on a phone when it gets the focus. */
const TEXT_FIELD = 'textarea, select, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="range"], [type="file"])';

/**
 * Keeps Tab inside a dialog or a sheet: from the last control it goes round to the first, and Shift+Tab
 * from the first (or from the sheet itself, which holds the focus on a phone) to the last. The
 * dialogs here and the model picker's sheet on a phone use it.
 */
export function keepTabInside(e: KeyboardEvent, box: HTMLElement): void {
  if (e.key !== "Tab") return;
  const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (all.length === 0) return;
  const first = all[0]!;
  const last = all[all.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

interface DialogProps {
  title: string;
  /** "sheet" is wider, for a form. "confirm" is a short question with two answers. */
  size?: "sheet" | "confirm";
  onClose(): void;
  children: ReactNode;
  /** Text under the title. */
  text?: ReactNode;
}

export function Dialog({ title, size = "confirm", onClose, children, text }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const textId = useId();
  const phone = usePhone();
  const layer = useBackLayer(() => onCloseNow.current());
  const onCloseNow = useRef(onClose);
  onCloseNow.current = onClose;
  const close = useRef(() => layer.close());
  close.current = () => layer.close();

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    if (isPhone() && first?.matches(TEXT_FIELD)) el?.focus({ preventScroll: true });
    else first?.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close.current();
      return;
    }
    if (box.current) keepTabInside(e, box.current);
  };

  return createPortal(
    <div
      className="pb-scrim app-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={box}
        className={`pb-dialog pb-arrive${size === "sheet" ? " pb-dialog-sheet" : ""}`}
        role={size === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={text ? textId : undefined}
        tabIndex={phone ? -1 : undefined}
        onKeyDown={onKeyDown}
      >
        <h2 className="pb-dialog-title" id={titleId}>
          {title}
        </h2>
        {text && (
          <p className="pb-dialog-text" id={textId}>
            {text}
          </p>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  title: string;
  text: ReactNode;
  /** What the confirming button does, in words: "Retire Inbox", "Remove file". */
  yes: string;
  /** What the other button does: "Keep it", "Keep editing". */
  no: string;
  /** "danger" for something that removes; "primary" otherwise. */
  tone?: "danger" | "primary";
  busy?: boolean;
  error?: string;
  onYes(): void;
  onNo(): void;
}

/** A short question with two answers. The safe answer has focus first. */
export function Confirm({ title, text, yes, no, tone = "primary", busy, error, onYes, onNo }: ConfirmProps) {
  return (
    <Dialog title={title} text={text} onClose={onNo}>
      {error && (
        <p className="pb-hint app-hint-error" role="alert">
          {error}
        </p>
      )}
      <div className="pb-dialog-actions">
        <button className="pb-btn pb-btn-quiet" type="button" data-autofocus onClick={onNo}>
          {no}
        </button>
        <button className={`pb-btn ${tone === "danger" ? "pb-btn-danger pb-btn-danger-strong" : "pb-btn-primary"}`} type="button" disabled={busy} onClick={onYes}>
          {yes}
        </button>
      </div>
    </Dialog>
  );
}
