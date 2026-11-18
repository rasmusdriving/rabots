// What the person does over the live picture, turned into steps for the page (docs/build/step-2g.md,
// A4). The person's laptop is Windows and the browser runs on a Mac:
//
// - The editing shortcuts work from Ctrl and from the command key alike. On the Mac a raw key event
//   with the command key does nothing by itself; the editing command must be named (`commands`).
//   Select all, undo and redo run in the page. Copy and paste never touch the Mac's clipboard: the
//   app pastes the laptop's clipboard as a text event, and asks for the selection to copy. Cut keeps
//   the selection for that question, then deletes it.
// - Home, End, Ctrl+Home/End, Ctrl+arrows, Ctrl+Backspace/Delete do what they do on Windows: in a
//   field they move the caret (or delete a word), elsewhere Home and End scroll the page.
// - AltGr (Ctrl and Alt together, with a character) types the character.
// - While a page's dialog is open nothing reaches the page but the answer: Enter accepts (a prompt
//   with what was typed since it opened), Escape dismisses.
// - A left press on a drop-down list, and Space, Enter, Up, Down or Alt+Down while one has the focus,
//   open its choices in the app (see InputStep).
import type { BrowserInput } from "../shared/protocol.js";

export interface CdpStep {
  method: string;
  params: Record<string, unknown>;
}

/**
 * One step for the watcher script: a CDP call, a choice by whether a field has the focus, saving the
 * selection (before a cut), or a step that first looks for a drop-down list: a left press over one
 * (`pick`), or a key that opens the one with the focus (`keyPick`). When there is one, the script
 * sends its choices to the app instead of passing the step on, because the browser on the Mac draws
 * the open list outside the page, where the picture cannot show it.
 */
export type InputStep =
  | CdpStep
  | { focus: { editable: CdpStep[]; plain: CdpStep[] } }
  | { save: true }
  | { pick: { x: number; y: number; step: CdpStep } }
  | { keyPick: CdpStep };

export type InputAction = { kind: "steps"; steps: InputStep[] } | { kind: "dialog"; accept: boolean; text?: string };

export interface PointerState {
  /** Buttons held now, as a mask: 1 left, 2 right, 4 middle. */
  buttons: number;
}

export interface DialogState {
  type: string;
  defaultPrompt: string;
  /** What the person typed since it opened. */
  typed: string;
}

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 };

const NAMED_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
  Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, ContextMenu: 93, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
};
const NAMED_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, AltGraph: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91,
};

/** The Windows key code a browser would report for this key. */
export function keyCodeOf(key: string, code: string): number {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!.charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);
  if (m) return 48 + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return 96 + Number(m[1]);
  m = /^F([0-9]{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 111 + Number(m[1]);
  if (NAMED_CODES[code] !== undefined) return NAMED_CODES[code]!;
  if (NAMED_KEYS[key] !== undefined) return NAMED_KEYS[key]!;
  if (key.length === 1) {
    const up = key.toUpperCase();
    if (/[A-Z0-9]/.test(up)) return up.charCodeAt(0);
  }
  return 0;
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(-100000, Math.min(100000, n)) : 0);

function mods(e: { mods?: number }): number {
  const m = Math.floor(e.mods ?? 0);
  return m >= 0 && m <= 15 ? m : 0;
}

function keyEvent(type: "keyDown" | "rawKeyDown" | "keyUp", e: Extract<BrowserInput, { type: "key" }>, modifiers: number, extra: Record<string, unknown> = {}): CdpStep {
  const kc = keyCodeOf(e.key, e.code);
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: kc,
      nativeVirtualKeyCode: kc,
      modifiers,
      ...(e.repeat ? { autoRepeat: true } : {}),
      ...extra,
    },
  };
}

/** The editing command for a shortcut with Ctrl or the command key, when it is one. */
function shortcut(e: Extract<BrowserInput, { type: "key" }>, m: number): { commands: string[]; save?: boolean } | undefined {
  if (!(m & (CTRL | META)) || m & ALT) return undefined;
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? (e.key.length === 1 ? e.key.toLowerCase() : "");
  switch (letter) {
    case "a":
      return { commands: ["selectAll"] };
    case "c":
    case "v":
      return { commands: [] };
    case "x":
      return { commands: ["deleteBackward"], save: true };
    case "z":
      return { commands: [m & SHIFT ? "redo" : "undo"] };
    case "y":
      return { commands: ["redo"] };
  }
  return undefined;
}

/** Keys whose Windows meaning needs a named command on the Mac, by whether a field has the focus. */
function navigation(e: Extract<BrowserInput, { type: "key" }>, m: number): { editable: string[]; plain: string[] } | undefined {
  const shift = m & SHIFT ? "AndModifySelection" : "";
  const ctrl = !!(m & CTRL) && !(m & (META | ALT));
  switch (e.key) {
    case "Home":
      return ctrl ? { editable: [`moveToBeginningOfDocument${shift}`], plain: ["scrollToBeginningOfDocument"] } : { editable: [`moveToBeginningOfLine${shift}`], plain: ["scrollToBeginningOfDocument"] };
    case "End":
      return ctrl ? { editable: [`moveToEndOfDocument${shift}`], plain: ["scrollToEndOfDocument"] } : { editable: [`moveToEndOfLine${shift}`], plain: ["scrollToEndOfDocument"] };
    case "ArrowLeft":
      return ctrl ? { editable: [`moveWordLeft${shift}`], plain: [] } : undefined;
    case "ArrowRight":
      return ctrl ? { editable: [`moveWordRight${shift}`], plain: [] } : undefined;
    case "Backspace":
      return ctrl ? { editable: ["deleteWordBackward"], plain: [] } : undefined;
    case "Delete":
      return ctrl ? { editable: ["deleteWordForward"], plain: [] } : { editable: ["deleteForward"], plain: [] };
  }
  return undefined;
}

/** A character key typed with AltGr on Windows arrives with Ctrl and Alt both held. */
function typesText(e: Extract<BrowserInput, { type: "key" }>, m: number): boolean {
  if (!e.text || e.text === "\r" || e.text === "\n" || e.text === "\t") return false;
  if ([...e.text].length !== 1 && e.key.length !== 1) return false;
  const altGr = (m & (CTRL | ALT)) === (CTRL | ALT);
  return !(m & (CTRL | META)) || altGr;
}

/** Space, Enter, Up, Down and Alt+Down open a drop-down list that has the focus. */
function opensChoices(e: Extract<BrowserInput, { type: "key" }>, m: number): boolean {
  if (m & (CTRL | META | SHIFT)) return false;
  if (e.key === "ArrowDown") return true;
  if (m & ALT) return false;
  return e.key === "ArrowUp" || e.key === " " || e.code === "Space" || e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
}

/**
 * Turns the person's events into actions, in order. `pointer` is kept between calls (which buttons
 * are held). `dialog` is the page's open dialog, when there is one; it is changed in place.
 */
export function toActions(events: BrowserInput[], pointer: PointerState, dialog?: DialogState): InputAction[] {
  const out: InputAction[] = [];
  let steps: InputStep[] = [];
  const flush = () => {
    if (steps.length) out.push({ kind: "steps", steps });
    steps = [];
  };
  for (const e of events) {
    if (dialog) {
      // Only the answer reaches a page with a dialog open.
      if (e.type === "key" && e.down && (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter")) {
        flush();
        const text = dialog.type === "prompt" ? dialog.typed || dialog.defaultPrompt : undefined;
        out.push({ kind: "dialog", accept: true, ...(text !== undefined ? { text } : {}) });
        dialog = undefined;
      } else if (e.type === "key" && e.down && e.key === "Escape") {
        flush();
        out.push({ kind: "dialog", accept: false });
        dialog = undefined;
      } else if (dialog.type === "prompt" && e.type === "text") {
        dialog.typed += e.text;
      } else if (dialog.type === "prompt" && e.type === "key" && e.down) {
        if (e.key === "Backspace") dialog.typed = [...dialog.typed].slice(0, -1).join("");
        else if (typesText(e, mods(e))) dialog.typed += e.text;
      }
      continue;
    }
    switch (e.type) {
      case "move":
      case "down":
      case "up": {
        const m = mods(e);
        const button = e.button ?? "left";
        const mask = BUTTON_MASK[button] ?? 1;
        if (e.type === "down") pointer.buttons |= mask;
        const held = pointer.buttons;
        if (e.type === "up") pointer.buttons &= ~mask;
        const heldButton = held & 1 ? "left" : held & 2 ? "right" : held & 4 ? "middle" : "none";
        const step: CdpStep = {
          method: "Input.dispatchMouseEvent",
          params: {
            type: e.type === "move" ? "mouseMoved" : e.type === "down" ? "mousePressed" : "mouseReleased",
            x: clamp(e.x),
            y: clamp(e.y),
            button: e.type === "move" ? heldButton : button,
            buttons: e.type === "up" ? pointer.buttons : held,
            clickCount: e.type === "move" ? 0 : Math.max(1, Math.min(3, Math.floor(e.clicks ?? 1))),
            modifiers: m,
          },
        };
        steps.push(e.type === "down" && button === "left" ? { pick: { x: clamp(e.x), y: clamp(e.y), step } } : step);
        break;
      }
      case "wheel":
        steps.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: clamp(e.x), y: clamp(e.y), deltaX: clamp(e.dx), deltaY: clamp(e.dy), modifiers: mods(e) } });
        break;
      case "text":
        if (e.text) steps.push({ method: "Input.insertText", params: { text: e.text } });
        break;
      case "key": {
        const m = mods(e);
        if (!e.down) {
          const sc = shortcut(e, m);
          steps.push(keyEvent("keyUp", e, sc ? (m & ~CTRL) | META : m));
          break;
        }
        const sc = shortcut(e, m);
        if (sc) {
          if (sc.save) steps.push({ save: true });
          steps.push(keyEvent("rawKeyDown", e, (m & ~CTRL) | META, sc.commands.length ? { commands: sc.commands } : {}));
          break;
        }
        const nav = navigation(e, m);
        if (nav) {
          const editable = keyEvent("rawKeyDown", e, m, nav.editable.length ? { commands: nav.editable } : {});
          const plain = keyEvent("rawKeyDown", e, m, nav.plain.length ? { commands: nav.plain } : {});
          steps.push({ focus: { editable: [editable], plain: [plain] } });
          break;
        }
        const opens = opensChoices(e, m);
        const put = (st: CdpStep) => steps.push(opens ? { keyPick: st } : st);
        if (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") {
          put(keyEvent("keyDown", e, m, { text: "\r", unmodifiedText: "\r" }));
          break;
        }
        if (typesText(e, m)) {
          const altGr = (m & (CTRL | ALT)) === (CTRL | ALT);
          put(keyEvent("keyDown", e, altGr ? m & ~(CTRL | ALT) : m, { text: e.text, unmodifiedText: e.text }));
          break;
        }
        put(keyEvent("rawKeyDown", e, m));
        break;
      }
    }
  }
  flush();
  return out;
}
