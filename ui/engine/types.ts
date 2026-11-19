// The one interface the app uses to talk to an engine. The real WebSocket client and the mock
// engine both implement it, so the rest of the UI cannot tell them apart.
import type { Attachment, ErrorBody, EventName, Events, MethodName, Methods, Snapshot } from "../../shared/protocol";

/** An event frame with its name and data tied together, so a switch on `event` narrows `data`. */
export type EngineEvent = { [E in EventName]: { event: E; data: Events[E] } }[EventName];

export type ConnectionPhase =
  /** First attempt, nothing received yet. */
  | "connecting"
  /** hello and snapshot done; requests flow. */
  | "ready"
  /** The connection dropped and the client is trying again on its own. */
  | "reconnecting"
  /**
   * The engine refused this app: another protocol version (the client stops trying), or this
   * device is not let in (the client keeps trying slowly). `message` says which, in plain words.
   */
  | "refused";

export interface ConnectionInfo {
  phase: ConnectionPhase;
  /** When this phase started (ms since epoch). The UI waits a moment before it mentions a drop. */
  since: number;
  /** A plain sentence for "refused". */
  message?: string;
}

export interface EngineListener {
  /** Called after every successful hello and snapshot, also after a reconnect. */
  ready(snapshot: Snapshot): void;
  event(event: EngineEvent): void;
  connection(info: ConnectionInfo): void;
}

/** One file on its way to the engine. `progress` is called with 0 to 1 as the bytes go out. */
export interface UploadRequest {
  botId: string;
  file: Blob;
  /** The name the file is stored under: the file's own, or "Screenshot ..." for a pasted picture. */
  name: string;
  progress(fraction: number): void;
  signal: AbortSignal;
}

export interface EngineClient {
  start(listener: EngineListener): void;
  request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  stop(): void;
  /**
   * Sends a picture or a file to the engine before the message that carries it (over HTTP, not the
   * socket). Rejects with an EngineError ("too_large", "unsupported", ...) or a plain Error when the
   * bytes did not get there. Absent where a window cannot upload.
   */
  upload?(request: UploadRequest): Promise<Attachment>;
  /** The address of a stored picture's preview or of the file itself, for an <img> or a download. */
  attachmentUrl(id: string, which: "preview" | "full" | "download"): string | undefined;
  /** Step 7c: the address of the file of block `index` of a to-do; `version` (its updatedAt) makes a changed file load again. */
  todoFileUrl?(todoId: string, index: number, version: string, download?: boolean): string | undefined;
  botDownloadUrl?(botId: string, path?: string): string | undefined;
}

/** What a failed request rejects with. `message` is one plain sentence for the person. */
export class EngineError extends Error {
  readonly code: string;
  constructor(body: ErrorBody) {
    super(body.message);
    this.code = body.code;
  }
}

export const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
