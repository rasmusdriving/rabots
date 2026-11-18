// The pictures and files waiting in a bot's message box, before they are sent. Kept per bot while
// the window is open, like the draft text, so going to another bot and back keeps them, and an
// upload carries on while the box is out of sight. Each file starts uploading the moment it is
// added, so pressing Send has nothing left to wait for.
import { useSyncExternalStore } from "react";
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, type Attachment } from "../../shared/protocol";
import { EngineError } from "../engine/types";
import { ATTACH_WORDS } from "../lib/words";
import { isPhone } from "../lib/phone";
import { discardAttachment, uploadFile } from "./actions";

/** "preparing": on a phone, a large photo is being redrawn smaller before its upload starts. */
export type ChipStatus = "preparing" | "uploading" | "done" | "failed" | "refused";

/** One attachment in the box. */
export interface Chip {
  key: string;
  botId: string;
  name: string;
  size: number;
  /** Whether the page can draw it as a picture (by the browser's word; the engine decides for real). */
  picture: boolean;
  /** A small picture made in the page, for the thumbnail. Revoked when the chip goes. */
  thumb?: string;
  status: ChipStatus;
  /** 0 to 1 while uploading. */
  progress: number;
  /** The sentence for a chip that failed or was refused. */
  problem?: string;
  /** The engine's record, once uploaded. */
  attachment?: Attachment;
}

interface Inner extends Chip {
  file: Blob;
  controller?: AbortController;
}

export interface Tray {
  chips: Chip[];
  /** A sentence about the box as a whole: "You can attach up to 10 files to one message." */
  notice?: string;
}

const EMPTY: Tray = { chips: [] };
const trays = new Map<string, Tray>();
const inner = new Map<string, Inner>();
const listeners = new Set<() => void>();
let nextKey = 1;

const notify = () => {
  for (const l of listeners) l();
};

function put(botId: string, next: Tray): void {
  if (next.chips.length === 0 && !next.notice) trays.delete(botId);
  else trays.set(botId, next);
  notify();
}

const trayOf = (botId: string): Tray => trays.get(botId) ?? EMPTY;

/** Changes one chip, if it is still in its box. */
function patch(key: string, change: Partial<Inner>): void {
  const now = inner.get(key);
  if (!now) return;
  const next = { ...now, ...change };
  inner.set(key, next);
  const tray = trayOf(now.botId);
  put(now.botId, { ...tray, chips: tray.chips.map((c) => (c.key === key ? publicChip(next) : c)) });
}

function publicChip(c: Inner): Chip {
  const { file: _file, controller: _controller, ...chip } = c;
  return chip;
}

/** Pictures the page itself can draw for a thumbnail. SVG is a text file to Pobots, never a picture. */
const drawable = (file: Blob) => /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(file.type);

/**
 * Adds files to a bot's box and starts their uploads. Files past the tenth are not added, and the
 * box says why. A file that is too big is shown with the reason and not sent. Its kind is never
 * judged here, by its name or the browser's word: the engine decides by its bytes and its refusal
 * shows on the chip in the engine's own words.
 */
export function addFiles(botId: string, files: { file: Blob; name: string }[]): void {
  if (files.length === 0) return;
  const tray = trayOf(botId);
  const room = ATTACHMENTS_PER_MESSAGE - tray.chips.length;
  const taken = files.slice(0, Math.max(0, room));
  const added: Chip[] = [];
  // On a phone a photo the browser can decode may be redrawn smaller first, so its size is judged after.
  const phone = isPhone();
  for (const { file, name } of taken) {
    const key = `c${nextKey++}`;
    const picture = drawable(file);
    const chip: Inner = { key, botId, name, size: file.size, picture, status: "uploading", progress: 0, file };
    if (picture) chip.thumb = URL.createObjectURL(file);
    if (phone && shrinkable(file, name)) chip.status = "preparing";
    else if (file.size > ATTACHMENT_MAX_BYTES) Object.assign(chip, { status: "refused", problem: ATTACH_WORDS.tooBig(name) });
    inner.set(key, chip);
    added.push(publicChip(chip));
  }
  put(botId, { chips: [...tray.chips, ...added], notice: files.length > taken.length ? ATTACH_WORDS.tooMany : undefined });
  for (const c of added) {
    if (c.status === "uploading") start(c.key);
    else if (c.status === "preparing") waitingToPrepare.push(c.key);
  }
  nextToPrepare();
}

// ------------------------------------------------------------ a photo made smaller on a phone
// docs/build/step-phone.md, decided 8. A photo from a phone is often 12 to 48 megapixels and 5 to
// 15 MB over mobile data, while the models work at about 1600 px. A picture larger than 2048 px on
// its long side or over 4 MB that the browser can decode is redrawn to 2048 px as a JPEG before it
// is uploaded, keeping its name with ".jpg"; redrawing also drops the photo's location. What the
// browser cannot decode (a HEIC photo in Chrome on Android) goes as it is, and the engine decides.
// A shrink that fails never loses the file: the original goes instead.

/** The long side a photo is redrawn to, and the size above which it is redrawn whatever its sides (px, bytes). */
export const PHOTO_LONG_SIDE = 2048;
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTO_QUALITY = 0.85;

/**
 * Photos worth trying to redraw: a picture by its type or name. Not a GIF (it may move), not an SVG
 * (a text file to Pobots).
 */
function shrinkable(file: Blob, name: string): boolean {
  if (/^image\/(gif|svg\+xml)$/i.test(file.type)) return false;
  return /^image\//i.test(file.type) || /\.(jpe?g|png|webp|heic|heif|avif|bmp|tiff?)$/i.test(name);
}

/** The photo decoded, upright as it was taken, or null when the browser cannot decode it. */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done(): void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
    } catch {
      // An older Safari may refuse the option or the kind; the picture element below may still read it.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("no picture");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** The photo redrawn to at most 2048 px as a JPEG, or null when it is fine as it is or cannot be redrawn. */
export async function shrinkPhoto(file: Blob, name: string): Promise<{ file: Blob; name: string } | null> {
  const picture = await decode(file);
  if (!picture) return null;
  try {
    const long = Math.max(picture.width, picture.height);
    if (long <= PHOTO_LONG_SIDE && file.size <= PHOTO_MAX_BYTES) return null;
    const s = Math.min(1, PHOTO_LONG_SIDE / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(picture.width * s));
    canvas.height = Math.max(1, Math.round(picture.height * s));
    const g = canvas.getContext("2d");
    if (!g) return null;
    // A JPEG has no see-through parts: a PNG with them is drawn on white, as a viewer would show it.
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    // Drop the canvas's memory at once; a phone has little of it.
    canvas.width = canvas.height = 0;
    if (!blob || blob.size === 0) return null;
    const jpg = `${name.replace(/\.[^./\\]+$/, "") || name}.jpg`;
    return { file: new File([blob], jpg, { type: "image/jpeg" }), name: jpg };
  } catch {
    return null;
  } finally {
    picture.done();
  }
}

// One photo is prepared at a time, in the order they were chosen: each is decoded at its full size
// before it is drawn smaller, and several 48 megapixel photos decoded at once can be more than a
// phone's memory (docs/build/notes-phone-review-fixes.md, point 6). The others say "Preparing" while
// they wait their turn. A chip removed while it waits is skipped; one removed while it is being
// prepared lets the next one start at once (its own decode cannot be stopped and ends by itself), so
// a removal never holds the others up.
const waitingToPrepare: string[] = [];
let preparing: string | null = null;

function nextToPrepare(): void {
  while (!preparing && waitingToPrepare.length) {
    const key = waitingToPrepare.shift()!;
    if (inner.get(key)?.status !== "preparing") continue;
    preparing = key;
    void prepare(key).finally(() => {
      if (preparing === key) preparing = null;
      nextToPrepare();
    });
  }
}

/** Redraws a chip's photo smaller if it needs it, then starts its upload (or refuses it as too big). */
async function prepare(key: string): Promise<void> {
  const chip = inner.get(key);
  if (!chip) return;
  let smaller: { file: Blob; name: string } | null = null;
  try {
    smaller = await shrinkPhoto(chip.file, chip.name);
  } catch {
    smaller = null;
  }
  const now = inner.get(key);
  // Removed while it was being prepared.
  if (!now || now.status !== "preparing") return;
  const file = smaller?.file ?? now.file;
  const name = smaller?.name ?? now.name;
  if (file.size > ATTACHMENT_MAX_BYTES) {
    patch(key, { file, name, size: file.size, status: "refused", problem: ATTACH_WORDS.tooBig(name) });
    return;
  }
  patch(key, { file, name, size: file.size, status: "uploading", progress: 0 });
  start(key);
}

function start(key: string): void {
  const chip = inner.get(key);
  if (!chip) return;
  const controller = new AbortController();
  patch(key, { status: "uploading", progress: 0, problem: undefined, controller });
  uploadFile({
    botId: chip.botId,
    file: chip.file,
    name: chip.name,
    signal: controller.signal,
    progress: (fraction) => {
      // Only forward, and only when it shows: the line moves in calm steps, never back.
      const now = inner.get(key);
      if (now?.controller === controller && fraction - now.progress >= 0.02) patch(key, { progress: fraction });
    },
  }).then(
    (attachment) => {
      const now = inner.get(key);
      // Removed while it was on its way: the engine's copy is thrown away too.
      if (!now || now.controller !== controller) return void discardAttachment(attachment.id);
      // The engine's name and size from here on: it may have cleaned the name, or turned a HEIC into a JPEG.
      patch(key, { status: "done", progress: 1, attachment, name: attachment.name, size: attachment.size, controller: undefined });
    },
    (error: unknown) => {
      const now = inner.get(key);
      if (!now || now.controller !== controller || controller.signal.aborted) return;
      const code = error instanceof EngineError ? error.code : "";
      if (code === "too_large") patch(key, { status: "refused", problem: refusal(error, now.name, "tooBig"), controller: undefined });
      else if (code === "unsupported") patch(key, { status: "refused", problem: refusal(error, now.name, "kind"), controller: undefined });
      else patch(key, { status: "failed", problem: ATTACH_WORDS.failed(now.name), controller: undefined });
    },
  );
}

/**
 * The words on a refused chip: the engine's own sentence (it names the file as the engine keeps it),
 * or the same sentence made here when the answer carried none.
 */
function refusal(error: unknown, name: string, which: "tooBig" | "kind"): string {
  const own = ATTACH_WORDS[which](name);
  const tail = own.slice(own.indexOf(name) + name.length);
  const said = error instanceof Error ? error.message : "";
  return said.endsWith(tail) && said.length > tail.length ? said : own;
}

/** Tries a failed upload again. */
export function retry(key: string): void {
  if (inner.get(key)?.status === "failed") start(key);
}

/** Takes a chip out of the box: stops its upload, or asks the engine to throw the upload away. */
export function removeChip(key: string): void {
  const chip = inner.get(key);
  if (!chip) return;
  chip.controller?.abort();
  if (chip.attachment) void discardAttachment(chip.attachment.id);
  if (chip.thumb) URL.revokeObjectURL(chip.thumb);
  inner.delete(key);
  const tray = trayOf(chip.botId);
  put(chip.botId, { chips: tray.chips.filter((c) => c.key !== key) });
  // The photo being prepared was taken out: the next one waiting does not wait for it.
  if (preparing === key) {
    preparing = null;
    nextToPrepare();
  }
}

/** The box after its message was sent: empty again. The engine keeps the uploads with the message. */
export function clearSent(botId: string, keys: string[]): void {
  for (const key of keys) {
    const chip = inner.get(key);
    if (chip?.thumb) URL.revokeObjectURL(chip.thumb);
    inner.delete(key);
  }
  const tray = trayOf(botId);
  put(botId, { chips: tray.chips.filter((c) => !keys.includes(c.key)) });
}

/** Forgets the sentence about the box as a whole. */
export function clearNotice(botId: string): void {
  const tray = trayOf(botId);
  if (tray.notice) put(botId, { chips: tray.chips });
}

export function useTray(botId: string): Tray {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => trayOf(botId),
  );
}

// ------------------------------------------------------------ a send promised while uploads run
// Send pressed while a file is still uploading (or a photo being prepared) arms the box: the message
// goes once they are done. Kept here per bot, not in the message box itself, so the promise holds
// when the window crosses between the laptop and the phone layout and the box is made anew
// (docs/build/notes-phone-review-fixes.md, point 2). Only that bot's box reads its mark, so it can
// never send in another bot's chat.
const armedBots = new Set<string>();

/** Arms or disarms the send of a bot's box. */
export function setArmed(botId: string, on: boolean): void {
  if (on === armedBots.has(botId)) return;
  if (on) armedBots.add(botId);
  else armedBots.delete(botId);
  notify();
}

/** Whether Send was pressed in this bot's box and waits for the uploads. */
export function useArmed(botId: string): boolean {
  return useSyncExternalStore(subscribeArmed, () => armedBots.has(botId));
}
const subscribeArmed = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const trayNow = (botId: string): Tray => trayOf(botId);

/** What the tray knows besides its chips, for its line. */
export interface LineContext {
  /** Send was pressed while an upload runs: the message goes by itself when it is done. */
  waiting?: boolean;
  /** The chip with the focus or the pointer on it: its problem is the one the line explains. */
  lit?: string;
  /** More chips than the row shows at once: the line says how many there are when it can. */
  overflow?: boolean;
}

/**
 * The one quiet line under the chips. One thing at a time: a problem first (the reason of the chip
 * with the focus or the pointer, else the first one, and how many more), then how the uploads are
 * going, then how many are attached when they do not all show, else nothing. `text` puts the count
 * before the message when the row hides chips; `short` is the same line without the count, for
 * when the longer one does not fit.
 */
export function trayLine(tray: Tray, context: LineContext = {}): { text: string; short: string; problem: boolean } {
  const count = context.overflow ? `${tray.chips.length} attached` : "";
  const line = (message: string, problem: boolean) => ({
    text: count ? `${count}. ${/[.?]$/.test(message) ? message : `${message}.`}` : message,
    short: message,
    problem,
  });
  if (tray.notice) return line(tray.notice, true);
  const troubled = tray.chips.filter((c) => c.problem);
  const shown = troubled.find((c) => c.key === context.lit) ?? troubled[0];
  if (shown?.problem) {
    const more = troubled.length - 1;
    return line(more > 0 ? `${shown.problem.replace(/\.$/, "")}, and ${more} more can't be attached.` : shown.problem, true);
  }
  const uploading = tray.chips.filter((c) => c.status === "uploading").length;
  if (uploading) {
    const words = uploading === 1 ? "Uploading 1 file" : `Uploading ${uploading} files`;
    return line(context.waiting ? `${words}. ${uploading === 1 ? "Sends when it is done." : "Sends when they are done."}` : words, false);
  }
  // Only on a phone: a photo being made smaller before it uploads. The send waits for it too.
  const preparing = tray.chips.filter((c) => c.status === "preparing").length;
  if (preparing) {
    const words = preparing === 1 ? "Preparing 1 picture" : `Preparing ${preparing} pictures`;
    return line(context.waiting ? `${words}. ${preparing === 1 ? "Sends when it is done." : "Sends when they are done."}` : words, false);
  }
  return { text: count, short: count, problem: false };
}
