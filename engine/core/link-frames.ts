import { LINK_CHUNK, LINK_FILES_MAX, LINK_FILE_MAX, LINK_ID, readLinkMessage, type LinkMessage, type LinkWire } from "./link-wire.js";

/** Where a file transfer stands: the receiver asks for this file from this byte. */
export interface LinkPos { message: string; file: number; at: number }
/** One piece of a file, base64. Wire 2 only. */
export interface LinkChunk extends LinkPos { data: string }
/** A file message the receiver will not take, with its reason in plain words. Wire 2 only. */
export interface LinkReject { message: string; reason: string }

export interface LinkRequest {
  remove?: true;
  /** Wire 2: with `remove`, the connection's time is up on the sending side. */
  ended?: true;
  ready?: true;
  paused?: true;
  ack?: string;
  refused?: string;
  message?: LinkMessage;
  chunk?: LinkChunk;
  got?: LinkPos;
  reject?: LinkReject;
}
export interface LinkResponse {
  state: "ok" | "paused" | "limited" | "unavailable" | "removed";
  ended?: true;
  accepted?: string;
  message?: LinkMessage;
  chunk?: LinkChunk;
  got?: LinkPos;
  reject?: LinkReject;
}

const REQUEST_1 = ["remove", "ready", "paused", "ack", "refused", "message"];
const REQUEST_2 = [...REQUEST_1, "ended", "chunk", "got", "reject"];
const RESPONSE_1 = ["state", "accepted", "message"];
const RESPONSE_2 = [...RESPONSE_1, "ended", "chunk", "got", "reject"];
const DATA_MAX = Math.ceil(LINK_CHUNK / 3) * 4;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && LINK_ID.test(value);
}
function readPos(value: unknown, data: boolean): LinkPos | LinkChunk | undefined {
  const v = record(value);
  if (!v || Object.keys(v).length !== (data ? 4 : 3) || !id(v.message) || !Number.isSafeInteger(v.file) || (v.file as number) < 0 ||
      (v.file as number) >= LINK_FILES_MAX || !Number.isSafeInteger(v.at) || (v.at as number) < 0 || (v.at as number) >= LINK_FILE_MAX) return;
  const pos = { message: v.message, file: v.file as number, at: v.at as number };
  if (!data) return pos;
  if (typeof v.data !== "string" || !v.data || v.data.length > DATA_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) return;
  return { ...pos, data: v.data };
}
function readReject(value: unknown): LinkReject | undefined {
  const v = record(value);
  if (!v || Object.keys(v).length !== 2 || !id(v.message) || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 300) return;
  return { message: v.message, reason: v.reason };
}
/** The wire 2 extras, checked; undefined when one is present and wrong. */
function extras(v: Record<string, unknown>): Pick<LinkRequest, "chunk" | "got" | "reject"> | undefined {
  const chunk = v.chunk === undefined ? undefined : readPos(v.chunk, true) as LinkChunk | undefined;
  const got = v.got === undefined ? undefined : readPos(v.got, false);
  const reject = v.reject === undefined ? undefined : readReject(v.reject);
  if ((v.chunk !== undefined && !chunk) || (v.got !== undefined && !got) || (v.reject !== undefined && !reject)) return;
  return { ...(chunk ? { chunk } : {}), ...(got ? { got } : {}), ...(reject ? { reject } : {}) };
}

export function readLinkRequest(value: unknown, now: number, wire: LinkWire = 1): LinkRequest | undefined {
  const v = record(value);
  const keys = wire === 2 ? REQUEST_2 : REQUEST_1;
  if (!v || Object.keys(v).some(k => !keys.includes(k))) return;
  if (v.remove !== undefined) {
    const ended = v.ended === true && Object.keys(v).length === 2;
    return v.remove === true && (Object.keys(v).length === 1 || ended) ? { remove: true, ...(ended ? { ended: true } : {}) } : undefined;
  }
  if (v.ended !== undefined) return;
  const m = v.message === undefined ? undefined : readLinkMessage(v.message, now, wire);
  const more = extras(v);
  if (!more || (more.chunk && (!m || m.id !== more.chunk.message || !m.files?.[more.chunk.file]))) return;
  if ((v.ready !== undefined && v.ready !== true) ||
      (v.paused !== undefined && (v.paused !== true || v.ready || m)) || (v.ack !== undefined && !id(v.ack)) || (v.refused !== undefined && !id(v.refused)) || (v.message !== undefined && !m)) return;
  return { ...(v.ready ? { ready: true } : {}), ...(v.paused ? { paused: true } : {}), ...(id(v.ack) ? { ack: v.ack } : {}), ...(id(v.refused) ? { refused: v.refused } : {}), ...(m ? { message: m } : {}), ...more };
}

export function readLinkResponse(value: unknown, now: number, wire: LinkWire = 1): LinkResponse | undefined {
  const v = record(value);
  const keys = wire === 2 ? RESPONSE_2 : RESPONSE_1;
  if (!v || Object.keys(v).some(k => !keys.includes(k))) return;
  const state = v.state;
  if (state !== "ok" && state !== "paused" && state !== "limited" && state !== "unavailable" && state !== "removed") return;
  if (v.ended !== undefined && (v.ended !== true || state !== "removed")) return;
  if (state !== "ok" && Object.keys(v).some(k => k !== "state" && k !== "ended")) return;
  const m = v.message === undefined ? undefined : readLinkMessage(v.message, now, wire);
  const more = extras(v);
  if (!more || (more.chunk && (!m || m.id !== more.chunk.message || !m.files?.[more.chunk.file]))) return;
  if ((v.accepted !== undefined && !id(v.accepted)) || (v.message !== undefined && !m)) return;
  return { state, ...(v.ended ? { ended: true } : {}), ...(id(v.accepted) ? { accepted: v.accepted } : {}), ...(m ? { message: m } : {}), ...more };
}
