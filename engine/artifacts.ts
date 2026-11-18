// Artifacts (docs/build/step-2f.md): pages a bot makes for the person, as HTML files in its own
// folder, shown in a sealed frame beside the chat; and links to what was published on Claude.
//
// This file holds the parts that need no engine: which file a bot may show, its title, whether its
// files changed, which file under /page/<key>/ an address names, the headers that seal every answer
// there, and how to tell from a tool call that something was published on Claude. The engine keeps
// the list and the keys (engine.ts); the server answers /page/ (server.ts).
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/** The largest HTML file a bot may show. */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
/** The largest supporting file served under /page/. */
export const PAGE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** How long a key under /page/ works, and how much of that must be left for it to be handed out again. */
export const PAGE_KEY_MS = 6 * 60 * 60 * 1000;
export const PAGE_KEY_REUSE_MS = 60 * 60 * 1000;
/** A folder walked for changes is cut off at this many files and this depth. */
const WALK_MAX_FILES = 2000;
const WALK_MAX_DEPTH = 8;
/** A title is one line of at most this many characters. */
export const TITLE_MAX = 120;

/** The places a Claude artifact may load scripts from (docs/build/step-2f.md, A1 and A3). */
export const SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com", "https://cdn.tailwindcss.com", "https://code.jquery.com"];

/** What a sealed page may do. Never allow-same-origin, never allow-top-navigation. */
export const PAGE_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals";

/** The file kinds served under /page/, by ending. Anything else is refused. */
export const PAGE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// ------------------------------------------------------------ the seal

/**
 * The page's own folder as sources for its policy: `/page/<key>/` on the address the browser used,
 * for both schemes (behind `tailscale serve` the engine sees plain HTTP while the browser uses
 * HTTPS). Nothing when the Host header is missing or odd; the page then loads no files of its own.
 */
export function ownSources(host: string | undefined, key: string): string[] {
  if (!host || !/^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) return [];
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return [];
  return [`http://${host}/page/${key}/`, `https://${host}/page/${key}/`];
}

/**
 * The content security policy of every answer under /page/. The page runs as a sandboxed document
 * with an opaque origin; it may run inline scripts and load scripts from the five hosts, styles from
 * Google Fonts, fonts from Google's font host, images and media from data: and blob:, and files of
 * its own folder (`own`). It can open no connection (fetch, XHR, sockets, beacons, event streams),
 * send no form, frame nothing, and only be framed by the engine's own page and the desktop window's
 * file page.
 */
export function pageCsp(own: string[] = []): string {
  const o = own.length ? ` ${own.join(" ")}` : "";
  return [
    `sandbox ${PAGE_SANDBOX}`,
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS.join(" ")}${o}`,
    `style-src 'unsafe-inline' https://fonts.googleapis.com${o}`,
    `font-src https://fonts.gstatic.com data:${o}`,
    `img-src data: blob:${o}`,
    `media-src data: blob:${o}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // 'self' is the engine's own page (a browser page on the same address); file: is the desktop window.
    "frame-ancestors 'self' file:",
  ].join("; ");
}

/**
 * The headers of every answer under /page/. `kind` "page" is the HTML file itself (a document: the
 * frame or a tab loads it, so the strictest resource policy holds); "file" is a supporting file the
 * page loads. A sandboxed page has an opaque origin, so its own scripts, styles and images are
 * cross-origin requests: with `same-site` or `same-origin` the browser refuses them (seen in
 * Chromium, docs/build/notes-engine-2f.md), hence `cross-origin` for supporting files only.
 */
export function sealHeaders(kind: "page" | "file" | "error", own: string[] = []): Record<string, string> {
  return {
    "Content-Security-Policy": pageCsp(kind === "error" ? [] : own),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": kind === "file" ? "cross-origin" : "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=()",
    "X-Robots-Tag": "noindex",
  };
}

// ------------------------------------------------------------ which file a bot may show

export type ShowCheck = { ok: true; rel: string; full: string; size: number } | { ok: false; why: string };

const EXAMPLE = "artifacts/<short-name>/index.html";

/** Splits a relative path with forward slashes into its parts. */
function parts(rel: string): string[] {
  return rel.split("/").filter((p) => p !== "");
}

/**
 * Checks a path a bot gave (relative to its folder, or absolute) for showing as an artifact: an HTML
 * file inside the folder, not in a dot folder, there, and not too large. The answer for a refusal is
 * one plain sentence the bot can act on.
 */
export function checkShowPath(botDir: string, given: string): ShowCheck {
  const raw = given.trim();
  if (!raw || raw.includes("\0")) return { ok: false, why: `Give the path of an HTML file in your folder, for example ${EXAMPLE}.` };
  let root = resolve(botDir);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  const full = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const inside = (base: string) => full === base || full.startsWith(base + sep);
  // The folder may be reached through a link (on macOS /var is /private/var): an absolute path in either form counts.
  if (!inside(root) && inside(realRoot)) root = realRoot;
  if (!inside(root)) {
    return { ok: false, why: `That file is outside your folder. Write the artifact inside your folder, for example as ${EXAMPLE}, and show it from there.` };
  }
  const rel = relative(root, full).split(sep).join("/");
  if (extname(rel).toLowerCase() !== ".html") {
    return { ok: false, why: `Only an HTML file can be shown as an artifact. Write it as an .html file, for example ${EXAMPLE}.` };
  }
  if (parts(rel).some((p) => p.startsWith("."))) {
    return { ok: false, why: `Files in folders whose names start with a dot cannot be shown. Move it to ${EXAMPLE}.` };
  }
  let real: string;
  let size: number;
  try {
    real = realpathSync(full);
    const st = statSync(real);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return { ok: false, why: `There is no file at ${rel} in your folder. Write the file first, then show it.` };
  }
  if (!real.startsWith(realRoot + sep)) {
    return { ok: false, why: `That file is a link to a place outside your folder. Write the artifact itself inside your folder, for example as ${EXAMPLE}.` };
  }
  if (size > ARTIFACT_MAX_BYTES) {
    return { ok: false, why: "That file is larger than 16 MB, which is too large to show. Make it smaller, for example by keeping large data out of it." };
  }
  return { ok: true, rel, full, size };
}

// ------------------------------------------------------------ titles

/** One plain line: tags and markdown marks out, common entities decoded, spaces folded, cut at TITLE_MAX. */
export function cleanTitle(text: unknown): string {
  if (typeof text !== "string") return "";
  let s = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const c = Number(n);
      return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : " ";
    })
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX - 3).trimEnd() + "...";
  return s;
}

/** The `<title>` of an HTML text, cleaned, or nothing. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html);
  const t = m ? cleanTitle(m[1]) : "";
  return t || undefined;
}

/** The start of a file as text (the title sits near the top). Empty when it cannot be read. */
export function readHead(full: string, bytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    fd = openSync(full, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A file's name without its ending, as a title: "status-page.html" gives "status-page". For index.html, its folder's name. */
export function titleFromName(rel: string): string {
  const name = basename(rel).replace(/\.[^.]+$/, "");
  const dir = posix.basename(posix.dirname(rel));
  const pick = name.toLowerCase() === "index" && dir && dir !== "." ? dir : name;
  return cleanTitle(pick) || "Artifact";
}

/** The title rule of A1: given, else the file's own `<title>`, else its name. */
export function pickTitle(given: unknown, full: string | undefined, rel: string): string {
  const g = cleanTitle(given);
  if (g) return g;
  const own = full ? htmlTitle(readHead(full)) : undefined;
  return own ?? titleFromName(rel);
}

// ------------------------------------------------------------ files of an artifact

/** The folder whose files are the artifact's: the HTML file's own folder ("" for the bot's folder itself). */
export function artifactDir(rel: string): string {
  const d = posix.dirname(rel);
  return d === "." ? "" : d;
}

/**
 * What the artifact's files look like now, as one short string that changes when any of them does.
 * A page directly in the bot's folder has only its own file (that folder holds the job and the
 * memory). A page in a folder of its own counts every file in that folder and below it, without
 * dot files and without following links. `exists` is false when the HTML file is gone.
 */
export function filesSignature(botDir: string, rel: string): { exists: boolean; sig: string } {
  const root = resolve(botDir);
  const html = join(root, ...parts(rel));
  let st;
  try {
    st = statSync(html);
    if (!st.isFile()) return { exists: false, sig: "" };
  } catch {
    return { exists: false, sig: "" };
  }
  const lines: string[] = [`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`];
  const dir = artifactDir(rel);
  if (dir) {
    let count = 0;
    const walk = (abs: string, at: string, depth: number) => {
      if (depth > WALK_MAX_DEPTH || count >= WALK_MAX_FILES) return;
      let names: string[];
      try {
        names = readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith(".") || count >= WALK_MAX_FILES) continue;
        const p = join(abs, name);
        const r = at ? `${at}/${name}` : name;
        let ls;
        try {
          ls = lstatSync(p);
        } catch {
          continue;
        }
        if (ls.isSymbolicLink()) continue;
        if (ls.isDirectory()) walk(p, r, depth + 1);
        else if (ls.isFile()) {
          count++;
          lines.push(`${r}:${ls.size}:${Math.floor(ls.mtimeMs)}`);
        }
      }
    };
    walk(join(root, ...parts(dir)), dir, 0);
  }
  return { exists: true, sig: createHash("sha1").update(lines.join("\n")).digest("hex") };
}

export type PageFile = { ok: true; full: string; type: string; isPage: boolean; size: number } | { ok: false };

/**
 * The file an address under /page/<key>/ names, for an artifact whose HTML file is `rel` in
 * `botDir`. `rest` is what follows the key and its slash, still percent-encoded. "" (the bare
 * folder) and the HTML file's own name give the HTML file; any other file in the same folder or
 * below it is served by its relative path. Never: anything outside the folder, a dot file or dot
 * folder, a link that leads out of the folder, a folder, a kind of file that is not served, or a
 * supporting file of a page that sits directly in the bot's folder.
 */
export function pageFile(botDir: string, rel: string, rest: string): PageFile {
  const no = { ok: false } as const;
  if (rest.includes("\\") || rest.includes("\0") || /%(?:00|2f|5c)/i.test(rest)) return no;
  let segs: string[];
  try {
    segs = rest === "" ? [] : rest.split("/").map((s) => decodeURIComponent(s));
  } catch {
    return no;
  }
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith(".") || s.includes("/") || s.includes("\\") || s.includes("\0"))) return no;
  const dir = artifactDir(rel);
  const pageName = posix.basename(rel);
  const want = segs.length === 0 ? [pageName] : segs;
  const isPage = want.length === 1 && want[0] === pageName;
  // A page directly in the bot's folder: only the page itself.
  if (!dir && !isPage) return no;
  const type = PAGE_TYPES[extname(want.at(-1)!).toLowerCase()];
  if (!type) return no;
  const root = resolve(botDir);
  const folder = dir ? join(root, ...parts(dir)) : root;
  const full = join(folder, ...want);
  if (!full.startsWith(folder + sep)) return no;
  try {
    const realFolder = realpathSync(folder);
    const realRoot = realpathSync(root);
    const real = realpathSync(full);
    if (!real.startsWith(realFolder + sep) || !real.startsWith(realRoot + sep)) return no;
    const st = statSync(real);
    if (!st.isFile()) return no;
    if (st.size > (isPage ? ARTIFACT_MAX_BYTES : PAGE_FILE_MAX_BYTES)) return no;
    return { ok: true, full: real, type, isPage, size: st.size };
  } catch {
    return no;
  }
}

// ------------------------------------------------------------ what was published on Claude

/** A claude.ai artifact link: https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<uuid>. Nothing else is ever taken. */
const CLAUDE_LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9][A-Za-z0-9_-]{2,127}(?![A-Za-z0-9_-])/;

export function claudeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return CLAUDE_LINK.exec(value)?.[0];
}

/**
 * The link a tool's result names: the structured result's `url` when it is a claude.ai artifact
 * link (the SDK's ArtifactOutput has `url` on a publish), else the first such link in its text.
 */
export function resultLink(result: unknown, text: string | undefined): string | undefined {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    const exact = claudeLink(url);
    if (exact && exact === url) return exact;
  }
  return claudeLink(text ?? "");
}

/** The title a structured result carries, when any. */
export function resultTitle(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const t = cleanTitle((result as Record<string, unknown>).title);
  return t || undefined;
}

export type ClaudeMade =
  /** The harness's Artifact tool publishing a file, or making an artifact from one of Claude's types (no file). */
  | { kind: "publish"; filePath?: string; typeUrl?: string; title?: string; url?: string }
  /** The Claude Docs connector making a new document. */
  | { kind: "document"; title?: string };

const ARTIFACT_TOOL = /(^|__)Artifact$/;
const DOCS_BATCH = /^mcp__.*Claude_Docs__batch$/i;

/**
 * Whether a tool call, by its name and input, is one that makes something on Claude: a publish by
 * the Artifact tool (a file_path or a type_url, no asset upload, action "publish" or left out), or a
 * new document by the Claude Docs connector (its batch call with `container.create`). Every other
 * call, and every other action of these tools, is nothing.
 */
export function claudeMade(name: string, input: Record<string, unknown>): ClaudeMade | undefined {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (ARTIFACT_TOOL.test(name)) {
    const action = input.action;
    if (action !== undefined && action !== "publish") return undefined;
    if (input.asset === true || input.file_paths !== undefined || input.from_url !== undefined || input.asset_ids !== undefined) return undefined;
    const filePath = str(input.file_path);
    const typeUrl = str(input.type_url);
    if (!filePath && !typeUrl) return undefined;
    const title = cleanTitle(input.title) || undefined;
    const url = claudeLink(input.url);
    return { kind: "publish", ...(filePath ? { filePath } : {}), ...(typeUrl ? { typeUrl } : {}), ...(title ? { title } : {}), ...(url ? { url } : {}) };
  }
  if (DOCS_BATCH.test(name)) {
    const container = input.container && typeof input.container === "object" ? (input.container as Record<string, unknown>) : undefined;
    const create = container?.create && typeof container.create === "object" ? (container.create as Record<string, unknown>) : undefined;
    if (!create) return undefined;
    const title = cleanTitle(create.name) || undefined;
    return { kind: "document", ...(title ? { title } : {}) };
  }
  return undefined;
}
