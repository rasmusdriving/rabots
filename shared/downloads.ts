import type { BotFile } from "./protocol.js";

/** The Files tab can list downloads as well as files the editor knows how to open. */
export type DownloadEntry = BotFile & { downloadOnly?: true };

/** A stored path (always with forward slashes) supplies the name; labels never do. */
export function downloadFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A Markdown file target: undefined for a web/fragment link, null for an unsupported local path. */
export function markdownFilePath(href: string): string | null | undefined {
  if (!href || href.startsWith("#")) return undefined;
  if (/^[a-z]:[\\/]/i.test(href) || /^(?:~|\/\/|\\|sandbox:)/i.test(href)) return null;
  try {
    if (/^file:/i.test(href)) {
      const file = /^file:\/\/(?:localhost)?(\/[^/][^?#]*)/i.exec(href);
      if (!file || /%(?:2f|5c)/i.test(file[1]!)) return null;
      return decodeURIComponent(file[1]!);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
    const path = href.split(/[?#]/, 1)[0]!;
    if (!path || /%(?:2f|5c)/i.test(path)) return null;
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
