// Attachments: uploads as they arrive, their clean-up, and the files the page asks for (docs/build/step-files.md).
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { attachmentDir, beginUpload as attachmentsBeginUpload, cleanName as cleanFileName, cleanOldAttachments, cleanOldUploads, isAttachmentId, prepareUpload, readUpload, removeUpload, servedFile, type ServedFile, uploadDir, uploadsSize as attachmentsUploadsSize } from "../attachments.js";
import { type Attachment, ATTACHMENT_KEEP_DAYS } from "../../shared/protocol.js";
import { iso } from "./words.js";
import { log } from "../log.js";

/** Where a sent attachment is found by its id: the bot and the path on the message. */
/** Step 7c: the engine value with the time of the last daily clean-up of attachments. */
export const ATTACH_CLEAN_KEY = "attachments.cleanedAt";

export function attachmentKey(id: string): string {
  return `attachment:${id}`;
}

/** A new upload for a bot: its id and the file its bytes are written to. Throws not_found for an unknown bot. */
export function beginUpload(eng: Engine, botId: string): { id: string; part: string } {
  eng.bot(botId);
  if (eng.stopping) throw new EngineError("internal", "The engine is stopping.");
  const { id, part } = attachmentsBeginUpload(eng.opts.config.dataDir);
  return { id, part };
}

/** The bytes of an upload are all there: check them and make it an attachment, or throw with plain words (and the upload is gone). */
export async function finishUpload(eng: Engine, id: string, botId: string, rawName: string): Promise<Attachment> {
  try {
    eng.bot(botId);
    const attachment = await prepareUpload(eng.opts.config.dataDir, id, botId, rawName, iso(eng.clock()));
    log.info(`Bot ${botId}: received an attachment (${attachment.kind}, ${attachment.type}, ${attachment.size} bytes)`);
    return attachment;
  } catch (err) {
    removeUpload(eng.opts.config.dataDir, id);
    if (err instanceof EngineError) throw err;
    log.error(`Bot ${botId}: an upload could not be prepared`, err);
    throw new EngineError("internal", `${cleanFileName(rawName)} didn't upload. Try again.`);
  }
}

/** Removes unsent uploads older than a day. At start and every hour. Never throws. */
export function tidyUploads(eng: Engine): number {
  try {
    const gone = cleanOldUploads(eng.opts.config.dataDir, eng.clock());
    if (gone) log.info(`Removed ${gone} unsent upload${gone === 1 ? "" : "s"} older than a day`);
    return gone;
  } catch (err) {
    log.warn("Could not tidy the unsent uploads", err);
    return 0;
  }
}

/**
 * Step 7c: the calm daily pass that removes attachments sent more than 14 days ago from every bot's
 * `.attachments` (cleanOldAttachments; nothing else is touched). Looked at every hour; it runs when
 * the last pass is a day old, never while a backup is being made, and never in the first ten
 * minutes after a start. `force` runs it now (tests). Never throws. Returns how many went.
 */
export function tidyAttachments(eng: Engine, force = false): number {
  try {
    const nowMs = eng.clock();
    if (!force) {
      if (nowMs - eng.startedAtMs < 10 * 60 * 1000) return 0;
      if (eng.backup.state().running) return 0;
      const last = Date.parse(eng.store.getValue(ATTACH_CLEAN_KEY) ?? "");
      if (Number.isFinite(last) && nowMs - last < 23 * 60 * 60 * 1000) return 0;
    }
    eng.store.setValue(ATTACH_CLEAN_KEY, new Date(nowMs).toISOString());
    let gone = 0;
    for (const rt of eng.bots.values()) gone += cleanOldAttachments(rt.folder.dir, nowMs);
    // To-dos that left the list long ago are forgotten in the same calm pass.
    eng.store.forgetOldTodos(nowMs);
    eng.store.ahead.forgetClosedBefore(new Date(nowMs - 90 * 24 * 60 * 60 * 1000).toISOString());
    if (gone) log.info(`Removed ${gone} attachment${gone === 1 ? "" : "s"} sent more than ${ATTACHMENT_KEEP_DAYS} days ago`);
    return gone;
  } catch (err) {
    log.warn("Could not tidy the old attachments", err);
    return 0;
  }
}

/** The bytes all unsent uploads take on disk now (uploads still arriving included). */
export function uploadsSize(eng: Engine): number {
  return attachmentsUploadsSize(eng.opts.config.dataDir);
}

/** An upload that did not arrive whole goes. */
export function abortUpload(eng: Engine, id: string): void {
  try {
    removeUpload(eng.opts.config.dataDir, id);
  } catch (err) {
    log.warn("Could not remove an upload that broke off", err);
  }
}

/** attachment.discard: an unsent upload goes. A sent attachment is never touched. No error when it is gone. */
export function discardAttachment(eng: Engine, id: string): void {
  if (!isAttachmentId(id)) return;
  if (!readUpload(eng.opts.config.dataDir, id) && eng.store.getValue(attachmentKey(id))) return;
  removeUpload(eng.opts.config.dataDir, id);
}

export function attachmentFile(eng: Engine, id: string, which: "preview" | "full"): ServedFile | undefined {
  if (!isAttachmentId(id)) return undefined;
  const raw = eng.store.getValue(attachmentKey(id));
  if (raw) {
    try {
      const v = JSON.parse(raw) as { botId?: unknown; path?: unknown };
      const rt = typeof v.botId === "string" ? eng.bots.get(v.botId) : undefined;
      const dir = rt && typeof v.path === "string" ? attachmentDir(rt.folder.dir, v.path) : undefined;
      return rt && dir ? servedFile(dir, which, rt.folder.dir) : undefined;
    } catch {
      return undefined;
    }
  }
  // Not sent yet: the upload itself (a page may show its preview before sending).
  if (!readUpload(eng.opts.config.dataDir, id)) return undefined;
  const dir = uploadDir(eng.opts.config.dataDir, id);
  return servedFile(dir, which, dir);
}
