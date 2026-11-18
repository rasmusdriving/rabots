// Pictures and files for the mock engine: the upload acted out without HTTP, the addresses of
// previews and files (data and object addresses made in the page), and the sample pictures.
//
// What it does, so the checks can lean on it:
//   - an upload reports progress over about half a second;
//   - over 100 MB is refused ("too_large") with the engine's own words (the page itself judges only
//     size and count); since step 7c any kind is taken: a picture the page cannot draw and a name of
//     no known kind become a plain file, as the engine keeps them;
//   - a file whose name holds "fail" fails the first time it is sent, and goes through when tried again;
//   - a picture's width and height are read in the page, and its preview is a JPEG of at most 1024 px.
// With &files=1 the sent messages with attachments are kept in sessionStorage, so a reload shows
// them again (with &files=fresh the kept ones are forgotten first). With &picturesFrom=<address>
// the sample pictures come from that address (a small server of the check on 127.0.0.1), so a
// check can hold them back and see that nothing moves when they arrive.
import { ATTACHMENT_MAX_BYTES, type Attachment, type UserItem } from "../../shared/protocol";
import { EngineError, type UploadRequest } from "./types";


const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PICTURE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const FILE_TYPES: [RegExp, string][] = [
  [/\.pdf$/i, "application/pdf"],
  [/\.docx$/i, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [/\.doc$/i, "application/msword"],
  [/\.xlsx$/i, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [/\.xls$/i, "application/vnd.ms-excel"],
  [/\.pptx$/i, "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [/\.ppt$/i, "application/vnd.ms-powerpoint"],
  [/\.rtf$/i, "application/rtf"],
  [/\.odt$/i, "application/vnd.oasis.opendocument.text"],
  [/\.ods$/i, "application/vnd.oasis.opendocument.spreadsheet"],
  [/\.(txt|md|csv|tsv|json|xml|ya?ml|html?|log|svg|js|ts|tsx|py|css|sh|ini|toml)$/i, "text/plain"],
];

/** What the mock keeps for one attachment: its record and where its picture and file are. */
interface Held {
  botId: string;
  attachment: Attachment;
  preview?: string;
  full?: string;
  sent: boolean;
}

const STORE_KEY = "pobots-mock-files";

export class MockFiles {
  private held = new Map<string, Held>();
  private failedOnce = new Set<string>();
  private next = 1;
  private readonly picturesFrom: string | null;
  private readonly keep: boolean;

  constructor(flags: URLSearchParams) {
    this.picturesFrom = flags.get("picturesFrom");
    const files = flags.get("files");
    this.keep = files === "1" || files === "fresh";
    if (files === "fresh") this.forgetKept();
  }

  private newId(): string {
    const letters = Math.random().toString(36).slice(2, 10);
    return `att_${letters}${this.next++}`;
  }

  /** The address of a preview or file, or undefined for an id the mock does not know. */
  url(id: string, which: "preview" | "full"): string | undefined {
    const h = this.held.get(id);
    if (!h) return undefined;
    return which === "preview" ? (h.preview ?? h.full) : (h.full ?? h.preview);
  }

  async upload(r: UploadRequest): Promise<Attachment> {
    const steps = 6;
    const fail = /fail/i.test(r.name) && !this.failedOnce.has(r.name);
    for (let i = 1; i <= steps; i++) {
      await later(80);
      if (r.signal.aborted) throw new DOMException("The upload was stopped.", "AbortError");
      if (fail && i === 3) {
        this.failedOnce.add(r.name);
        throw new Error("The upload did not reach the engine.");
      }
      if (r.file.size > ATTACHMENT_MAX_BYTES && i === 2) throw new EngineError({ code: "too_large", message: `${r.name} is too big. A file can be up to 100 MB.` });
      r.progress(i / steps);
    }
    const id = this.newId();
    const isPicture = PICTURE_NAME.test(r.name) || /^image\/(png|jpeg|gif|webp)$/.test(r.file.type);
    const drawn = isPicture ? await drawPicture(r.file) : undefined;
    if (drawn) {
      const attachment: Attachment = { id, name: r.name, kind: "picture", type: drawn.type, size: r.file.size, width: drawn.width, height: drawn.height, path: "" };
      this.held.set(id, { botId: r.botId, attachment, preview: drawn.preview, full: drawn.full, sent: false });
      return structuredClone(attachment);
    }
    // Step 7c: any other file is kept as it is.
    const type = FILE_TYPES.find(([re]) => re.test(r.name))?.[1] ?? (/\.zip$/i.test(r.name) ? "application/zip" : "application/octet-stream");
    const attachment: Attachment = { id, name: r.name, kind: "file", type, size: r.file.size, path: "" };
    this.held.set(id, { botId: r.botId, attachment, full: r.file.size < 512 * 1024 ? await dataUrl(r.file) : URL.createObjectURL(r.file), sent: false });
    return structuredClone(attachment);
  }

  discard(id: string): void {
    const h = this.held.get(id);
    if (h && !h.sent) this.held.delete(id);
  }

  /** The unsent uploads of a bot for these ids, in order, moved into the bot's folder. Throws as the engine would. */
  take(botId: string, ids: string[]): Attachment[] {
    const found = ids.map((id) => {
      const h = this.held.get(id);
      if (!h || h.sent || h.botId !== botId) throw new EngineError({ code: "not_found", message: "A file is no longer waiting to be sent. Attach it again." });
      return h;
    });
    const month = new Date().toISOString().slice(0, 7);
    return found.map((h) => {
      h.sent = true;
      h.attachment = { ...h.attachment, path: `.attachments/${month}/${h.attachment.id}/${h.attachment.name}` };
      return structuredClone(h.attachment);
    });
  }

  /** Ids of uploads not sent yet, for the checks. */
  waiting(): string[] {
    return [...this.held.values()].filter((h) => !h.sent).map((h) => h.attachment.id);
  }

  // ------------------------------------------------------------ kept across a reload (&files=1)

  /** Keeps a sent message with attachments, so a reload shows it again. */
  remember(item: UserItem): void {
    if (!this.keep || !item.attachments?.length) return;
    try {
      const all = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as { item: UserItem; places: Record<string, { preview?: string; full?: string }> }[];
      const places: Record<string, { preview?: string; full?: string }> = {};
      for (const a of item.attachments) {
        const h = this.held.get(a.id);
        // Object addresses die with the page; a large file is kept by name only.
        places[a.id] = { preview: h?.preview, full: h?.full?.startsWith("data:") ? h.full : undefined };
      }
      all.push({ item, places });
      sessionStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // Without storage a reload simply starts over.
    }
  }

  /** The messages kept before a reload, with their addresses known again. */
  kept(): UserItem[] {
    if (!this.keep) return [];
    try {
      const all = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as { item: UserItem; places: Record<string, { preview?: string; full?: string }> }[];
      for (const { item, places } of all) {
        for (const a of item.attachments ?? []) this.held.set(a.id, { botId: "", attachment: a, preview: places[a.id]?.preview, full: places[a.id]?.full, sent: true });
      }
      return all.map((x) => x.item);
    } catch {
      return [];
    }
  }

  private forgetKept(): void {
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch {
      // Nothing kept.
    }
  }

  // ------------------------------------------------------------ sample pictures and files

  /** A sample picture drawn in the page: a made-up screen with a few quiet blocks and a caption. */
  samplePicture(name: string, width: number, height: number, tone: number): Attachment {
    const id = this.newId();
    const attachment: Attachment = { id, name, kind: "picture", type: "image/png", size: Math.round(width * height * 0.9), width, height, path: `.attachments/2026-11/${id}/${name}` };
    if (this.picturesFrom) {
      const base = this.picturesFrom.replace(/\/$/, "");
      this.held.set(id, { botId: "", attachment, preview: `${base}/${id}/preview?w=${width}&h=${height}`, full: `${base}/${id}/full?w=${width}&h=${height}`, sent: true });
    } else {
      const preview = sketch(width, height, tone, name);
      this.held.set(id, { botId: "", attachment, preview, full: preview, sent: true });
    }
    return attachment;
  }

  /** A sample file: a small text file stands in for its contents. */
  sampleFile(name: string, type: string, size: number, missing = false): Attachment {
    const id = this.newId();
    const attachment: Attachment = { id, name, kind: "file", type, size, path: `.attachments/2026-11/${id}/${name}`, ...(missing ? { missing: true } : {}) };
    this.held.set(id, { botId: "", attachment, full: missing ? undefined : `data:application/octet-stream;base64,${btoa(`A sample of ${name}.\n`)}`, sent: true });
    return attachment;
  }
}

function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Reads a picture in the page: its size, a preview of at most 1024 px, and the picture itself. Null when it cannot be drawn. */
async function drawPicture(file: Blob): Promise<{ width: number; height: number; preview: string; full: string; type: string } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const s = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * s));
  canvas.height = Math.max(1, Math.round(height * s));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const preview = canvas.toDataURL("image/jpeg", 0.85);
  const full = file.size < 2 * 1024 * 1024 ? await dataUrl(file) : preview;
  const type = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? file.type : "image/png";
  return { width, height, preview, full, type };
}

/** A made-up screen, drawn small: the preview of a sample picture. */
export function sketch(width: number, height: number, tone: number, caption: string): string {
  const s = Math.min(1, 640 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.fillStyle = `hsl(${tone} 18% 92%)`;
  g.fillRect(0, 0, w, h);
  g.fillStyle = `hsl(${tone} 22% 30%)`;
  g.fillRect(0, 0, w, Math.round(h * 0.09));
  g.fillStyle = `hsl(${tone} 30% 80%)`;
  g.fillRect(Math.round(w * 0.05), Math.round(h * 0.16), Math.round(w * 0.26), Math.round(h * 0.76));
  g.fillStyle = "#ffffff";
  for (let i = 0; i < 4; i++) g.fillRect(Math.round(w * 0.36), Math.round(h * (0.16 + i * 0.19)), Math.round(w * 0.58), Math.round(h * 0.15));
  g.fillStyle = `hsl(${tone} 22% 30%)`;
  g.font = `${Math.max(10, Math.round(h * 0.05))}px sans-serif`;
  g.fillText(caption.replace(/\.\w+$/, ""), Math.round(w * 0.38), Math.round(h * 0.25));
  return canvas.toDataURL("image/png");
}
