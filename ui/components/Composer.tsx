// The composer: a text line, the add button, the model as quiet text and the round send button.
// Enter sends, Shift+Enter adds a line, it grows to six lines. On a phone Enter adds a line and the
// send button sends: a phone keyboard has no Shift, and a stray send is worse than a stray line. While the bot works, sending
// steers the message into what it does or queues it, by the setting in Pobots settings (protocol 14); Ctrl+Enter (⌘+Enter
// on a Mac), a Ctrl-click, or holding the send button on a phone does the other for one message, as in T3 Code. With an
// empty box the send button becomes stop.
//
// Pictures and files: pasted (a screenshot from the clipboard), dropped anywhere on the chat, or
// picked with the add button. They stand as chips in a tray above the text and upload at once, so
// Send is instant. A message may be pictures and files alone, with no text.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Bot, FollowUp, Item } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { canUpload, interrupt, sendMessage, sentAfterAll } from "../state/actions";
import { useAppState } from "../state/store";
import { addFiles, clearSent, setArmed as armTray, trayNow, useArmed, useTray } from "../state/tray";
import { effortWords } from "../lib/models";
import { usePhone } from "../lib/phone";
import { useOnCross } from "../lib/carry";
import { other, sendHint, sendName } from "../lib/steer";
import { PlusIcon, QueueIcon, SendIcon, StopIcon } from "./bits";
import { AttachTray } from "./Attachments";
import { ModelPicker } from "./ModelPicker";

const LINE = 24;
const MAX_LINES = 6;
/** On a phone the keyboard takes half the screen: the box grows to five lines, then scrolls. */
const MAX_LINES_PHONE = 5;

/**
 * The bot is in a turn of its own, so a message waits until it is done. A bot that only waits for
 * helpers it left working in the background is "working" too, but is not in a turn: a message then
 * starts one at once (step 2e, A3). Its own turn shows as work still running in its chat (a step, an
 * answer being written, or a helper it waits for); without that, "working" with helpers is helpers only.
 */
function inTurn(bot: Bot, items: Item[]): boolean {
  // Engine 0.31.1: a bot that reads "waiting" only for a card that came back after a restart is at rest.
  if (bot.state === "thinking" || (bot.state === "waiting" && !bot.atRest)) return true;
  if (bot.state !== "working") return false;
  if (!bot.helpers) return true;
  return items.some((i) => (i.kind === "bot" && i.streaming) || (i.kind === "activity" && i.status === "running") || (i.kind === "helper" && i.status === "running" && !i.background));
}
/**
 * The bot is actively at work and can be stopped. A waiting bot is stopped by answering its card.
 * "Stop" also stops its helpers, and works when only helpers are working.
 */
const canStop = (bot: Bot) => bot.state === "thinking" || bot.state === "working";
const NO_ITEMS: Item[] = [];

const drafts = new Map<string, string>();

/** A design token's duration in ms, read from the element's style. */
function tokenMs(el: Element, name: string): number {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The name for a picture pasted from the clipboard. Browsers call every pasted screenshot
 * "image.png"; the bot and the chat get "Screenshot 2026-11-13 08.12.png" instead, with " 2", " 3"
 * when that name is already in the box.
 */
export function pastedName(file: File, taken: string[], now = new Date()): string {
  const own = file.name.trim();
  if (own && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(own)) return own;
  const ext = (/\/(png|jpeg|gif|webp|bmp)$/.exec(file.type)?.[1] ?? "png").replace("jpeg", "jpg");
  const base = `Screenshot ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
  let name = `${base}.${ext}`;
  for (let n = 2; taken.includes(name); n++) name = `${base} ${n}.${ext}`;
  return name;
}

/** Files from the clipboard or a drop, named for the box. */
export function filesFor(botId: string, list: File[], pasted = false): { file: File; name: string }[] {
  const taken = trayNow(botId).chips.map((c) => c.name);
  return list.map((file) => {
    const name = pasted ? pastedName(file, taken) : file.name || pastedName(file, taken);
    taken.push(name);
    return { file, name };
  });
}

export function Composer({ bot, pickerOpenAtStart = false, onError }: { bot: Bot; pickerOpenAtStart?: boolean; onError(message: string | undefined): void }) {
  const [text, setTextState] = useState(() => drafts.get(bot.id) ?? "");
  const [pickerOpen, setPickerOpen] = useState(pickerOpenAtStart);
  const [sending, setSending] = useState(false);
  /**
   * Send was pressed while a file was still uploading: it goes once the uploads are done. Kept with
   * the bot's tray so it holds when the window crosses between the layouts; leaving the box any
   * other way forgets it, as before.
   */
  const armed = useArmed(bot.id);
  const setArmed = (on: boolean) => armTray(bot.id, on);
  useOnCross(
    () => undefined,
    () => armTray(bot.id, false),
  );
  /** Bumped when Send is pressed with a problem in the tray, so its line is read out again. */
  const [nudge, setNudge] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const models = useAppState((s) => s.models);
  const model = models.find((m) => m.id === bot.model);
  const items = useAppState((s) => s.threads[bot.mainThreadId]?.items ?? NO_ITEMS);
  const tray = useTray(bot.id);
  const attach = canUpload();
  const busy = inTurn(bot, items);
  const chips = tray.chips;
  const empty = text.trim() === "" && chips.length === 0;
  // A photo still being made smaller on a phone counts as uploading: Send waits for it.
  const uploading = chips.some((c) => c.status === "uploading" || c.status === "preparing");
  const troubled = chips.some((c) => c.status === "failed" || c.status === "refused");
  const phone = usePhone();
  const maxLines = phone ? MAX_LINES_PHONE : MAX_LINES;
  // Steering: what sending does while the bot works, by the setting; the other one for a single message.
  // Step 7b: the bot's own choice when it has one, else the Pobots default.
  const followUp = useAppState((s) => s.bots.find((b) => b.id === bot.id)?.followUp ?? s.chat.followUp);
  /** The choice for the message waiting on an upload (armed): sent with it once the upload is done. */
  const armedMode = useRef<FollowUp | undefined>(undefined);
  /** On a phone: the send button is held, to do the other for one message. */
  const hold = useRef<{ timer: number; done: boolean } | null>(null);
  /**
   * A held press has sent and the finger is not lifted yet. The send button stays (it does not turn
   * into Stop under the finger, which the lifting finger would then press) until the press is over.
   */
  const [heldSent, setHeldSent] = useState(false);
  const heldTimer = useRef<number | undefined>(undefined);

  const setText = (value: string) => {
    drafts.set(bot.id, value);
    setTextState(value);
  };

  // Grow with the text, up to six lines, then scroll.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    // On a phone the field has room above and below its line, so it is 44 px to tap (phone-chat.css); none on the laptop.
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    // On a phone the box holds its height while the field is measured: the field shrinking for a
    // moment would make the chat above it taller, and a chat at its bottom would slip up a line.
    const hold = phone ? box.current : null;
    if (hold) hold.style.minHeight = `${hold.offsetHeight}px`;
    el.style.height = `${LINE + pad}px`;
    el.style.height = `${Math.min(el.scrollHeight, LINE * maxLines + pad)}px`;
    el.style.overflowY = el.scrollHeight > LINE * maxLines + pad ? "auto" : "hidden";
    if (hold) hold.style.minHeight = "";
  }, [text, maxLines]);

  /** Sends the message. `mode`: this message's own choice while the bot works (the other one); left out, the setting. */
  const send = (mode?: FollowUp) => {
    if (empty || sending) {
      setArmed(false);
      return;
    }
    if (troubled) {
      // A file that failed or was refused keeps the message and the others; its line says what to do.
      setArmed(false);
      setNudge((n) => n + 1);
      return;
    }
    if (uploading) {
      armedMode.current = mode;
      setArmed(true);
      return;
    }
    setArmed(false);
    armedMode.current = undefined;
    const value = text;
    const sent = chips.filter((c) => c.status === "done" && c.attachment);
    const ids = sent.map((c) => c.attachment!.id);
    setSending(true);
    onError(undefined);
    setText("");
    const keys = sent.map((c) => c.key);
    sendMessage(bot.id, value, ids, busy && mode ? mode : undefined)
      .then(() => clearSent(bot.id, keys))
      .catch(async (e: unknown) => {
        // The answer may be lost while the engine did store the message (the connection dropped
        // on the way back). Then the uploads are no longer waiting and a retry would be refused:
        // once the chat is read again, a message from the person with these attachments means it
        // went, and the box is emptied quietly.
        if (await sentAfterAll(bot.mainThreadId, ids)) {
          clearSent(bot.id, keys);
          return;
        }
        // Give the text back so nothing is lost; the chips never left. Anything typed meanwhile stays after it.
        const now = drafts.get(bot.id) ?? "";
        setText(now.trim() ? `${value}\n\n${now}` : value);
        onError(messageOf(e));
      })
      .finally(() => setSending(false));
  };

  // Armed: send as soon as the last upload is done. A problem on the way disarms it.
  useEffect(() => {
    if (!armed || uploading) return;
    send(armedMode.current);
    // Only when the uploads settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, uploading]);

  const stop = () => {
    onError(undefined);
    interrupt(bot.id).catch((e: unknown) => onError(messageOf(e)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
      e.preventDefault();
      // Ctrl+Enter (⌘+Enter on a Mac) does the other for this one message while the bot works.
      send(e.ctrlKey || e.metaKey ? other(followUp) : undefined);
    }
  };

  // The send button: a Ctrl-click (⌘-click) does the other; on a phone, holding it does.
  const onSendClick = (e: MouseEvent<HTMLButtonElement>) => {
    // The press that was held has sent already; its click does nothing more.
    if (hold.current?.done) {
      hold.current = null;
      setHeldSent(false);
      if (e.detail > 0) return;
    }
    send(busy && (e.ctrlKey || e.metaKey) ? other(followUp) : undefined);
  };
  const endHold = () => {
    if (hold.current && !hold.current.done) {
      window.clearTimeout(hold.current.timer);
      hold.current = null;
    }
  };
  const onSendDown = (e: PointerEvent<HTMLButtonElement>) => {
    endHold();
    hold.current = null;
    if (!phone || !busy || empty || e.button !== 0) return;
    const el = e.currentTarget;
    const timer = window.setTimeout(() => {
      if (!hold.current) return;
      hold.current.done = true;
      setHeldSent(true);
      send(other(followUp));
    }, tokenMs(el, "--dur-hold") || tokenMs(el, "--dur-slow"));
    hold.current = { timer, done: false };
  };
  /** The finger is lifted: a held press that sent lets the button turn into Stop a moment later, should no click come. */
  const onSendUp = () => {
    endHold();
    if (!hold.current?.done) return;
    window.clearTimeout(heldTimer.current);
    heldTimer.current = window.setTimeout(() => {
      hold.current = null;
      setHeldSent(false);
    }, tokenMs(document.documentElement, "--dur-hold") || tokenMs(document.documentElement, "--dur-slow"));
  };
  useEffect(
    () => () => {
      endHold();
      window.clearTimeout(heldTimer.current);
    },
    [],
  );

  // A pasted screenshot (Win+Shift+S, then Ctrl+V) becomes a chip. Text pastes as it always did:
  // the browser's own paste is only stopped when the clipboard held files and no text. Cells copied
  // from Excel or a passage from Word also bring a picture of themselves; they paste as text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attach) return;
    const data = e.clipboardData;
    if (data?.getData("text/plain").trim()) return;
    let files = [...(data?.files ?? [])];
    if (files.length === 0) files = [...(data?.items ?? [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(bot.id, filesFor(bot.id, files, true));
  };

  const showStop = canStop(bot) && empty && !heldSent;
  const waiting = armed && uploading;

  return (
    <div className="pb-composer app-composer" ref={box} onClick={(e) => e.target === e.currentTarget && field.current?.focus()}>
      {/* On a phone the focus goes to the add button, not the text: the keyboard would open by itself. */}
      {chips.length > 0 && <AttachTray tray={tray} nudge={nudge} waiting={waiting} onEmpty={() => (phone ? attachButton.current : field.current)?.focus({ preventScroll: phone })} />}
      <textarea
        ref={field}
        rows={1}
        value={text}
        placeholder={`Message ${bot.name}`}
        aria-label={`Message ${bot.name}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        enterKeyHint={phone ? "enter" : undefined}
      />
      <div className="pb-composer-bar">
        {attach && (
          <>
            <button ref={attachButton} className="pb-icon-btn pb-attach" type="button" aria-label="Attach pictures or files" title="Attach pictures or files" onClick={() => picker.current?.click()}>
              <PlusIcon />
            </button>
            <input
              ref={picker}
              className="pb-attach-input"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const list = [...(e.target.files ?? [])];
                e.target.value = "";
                addFiles(bot.id, filesFor(bot.id, list));
                // On a phone the keyboard is not opened by itself after picking a photo.
                if (!phone) field.current?.focus({ preventScroll: true });
              }}
            />
          </>
        )}
        <button
          ref={modelButton}
          className="pb-btn pb-btn-sm pb-btn-quiet pb-push"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-label={`Model: ${model?.label ?? bot.model}, effort ${effortWords(models, bot)}. Change model`}
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          {model?.label ?? bot.model} <small>{effortWords(models, bot)}</small>
        </button>
        {showStop ? (
          <button className="pb-send" type="button" aria-label={`Stop ${bot.name}`} title={bot.helpers ? `Stop ${bot.name} and its helpers` : `Stop ${bot.name}`} onClick={stop}>
            <StopIcon />
          </button>
        ) : (
          <button
            className="pb-send"
            type="button"
            data-waiting={waiting || undefined}
            data-follow={busy ? followUp : undefined}
            aria-busy={waiting || undefined}
            aria-label={waiting ? "Sends when the upload is done" : busy ? sendName(followUp) : "Send"}
            title={waiting ? "Sends when the upload is done" : busy && !phone ? sendHint(followUp) : undefined}
            aria-disabled={empty || undefined}
            onClick={onSendClick}
            onPointerDown={onSendDown}
            onPointerUp={onSendUp}
            onPointerLeave={endHold}
            onPointerCancel={endHold}
            onContextMenu={(e) => phone && e.preventDefault()}
          >
            {busy && followUp === "queue" && !waiting ? <QueueIcon /> : <SendIcon />}
          </button>
        )}
      </div>
      {pickerOpen && <ModelPicker bot={bot} anchor={box} trigger={modelButton} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
