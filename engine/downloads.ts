import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { downloadFileName } from "../shared/downloads.js";
import type { ServedFile } from "./attachments.js";

export const DOWNLOAD_TYPE = "application/octet-stream";

export type FolderFile = { rel: string; full: string; size: number; realRel: string };

/** Locate a regular file inside the bot's folder, including after resolving links. */
export function fileInFolder(botDir: string, path: string): FolderFile | "outside" | "linked-outside" | "missing" | "not-file" {
  if (!path || path.includes("\0")) return "missing";
  try {
    const root = resolve(botDir);
    const realRoot = realpathSync(root);
    const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const base = full.startsWith(root + sep) ? root : isAbsolute(path) && full.startsWith(realRoot + sep) ? realRoot : undefined;
    if (!base) return "outside";
    const real = realpathSync(full);
    if (!real.startsWith(realRoot + sep)) return "linked-outside";
    const st = statSync(real);
    if (!st.isFile()) return "not-file";
    return { rel: relative(base, full).split(sep).join("/"), full: real, size: st.size, realRel: relative(realRoot, real).split(sep).join("/") };
  } catch {
    return "missing";
  }
}

/** Match the Files tab's exclusions, including through a link under a different name. */
export function isPublicBotFile(path: string): boolean {
  return !!path && !path.split("/").some((part) => part.startsWith(".")) && !path.startsWith("bot.json") && path !== "CLAUDE.md";
}

export function folderDownload(botDir: string, path: string): ServedFile | undefined {
  // Deferred Markdown checks and the final download go through the same permission and path checks.
  if (path.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(path) || /(?:^|\/)\.\.(?:\/|$)/.test(path)) return undefined;
  const f = fileInFolder(botDir, path);
  if (typeof f === "string" || !isPublicBotFile(f.rel) || !isPublicBotFile(f.realRel)) return undefined;
  return asDownload(f, downloadFileName(f.rel));
}

export function asDownload(file: Pick<ServedFile, "full" | "size">, name: string): ServedFile {
  return { full: file.full, size: file.size, type: DOWNLOAD_TYPE, inline: false, name };
}

/** Both filename forms; browsers that understand UTF-8 get the exact stored name. */
export function fileDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_") || "file";
  const utf8 = encodeURIComponent(Buffer.from(name).toString("utf8")).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
