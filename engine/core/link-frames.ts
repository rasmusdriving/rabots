import { LINK_ID, readLinkMessage, type LinkMessage } from "./link-wire.js";

export interface LinkRequest {
  remove?: true;
  ready?: true;
  paused?: true;
  ack?: string;
  refused?: string;
  message?: LinkMessage;
}
export interface LinkResponse {
  state: "ok" | "paused" | "limited" | "unavailable" | "removed";
  accepted?: string;
  message?: LinkMessage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && LINK_ID.test(value);
}

export function readLinkRequest(value: unknown, now: number): LinkRequest | undefined {
  const v = record(value);
  if (!v || Object.keys(v).some(k => !["remove", "ready", "paused", "ack", "refused", "message"].includes(k))) return;
  if (v.remove !== undefined) return v.remove === true && Object.keys(v).length === 1 ? { remove: true } : undefined;
  const m = v.message === undefined ? undefined : readLinkMessage(v.message, now);
  if ((v.ready !== undefined && v.ready !== true) ||
      (v.paused !== undefined && (v.paused !== true || v.ready || m)) || (v.ack !== undefined && !id(v.ack)) || (v.refused !== undefined && !id(v.refused)) || (v.message !== undefined && !m)) return;
  return { ...(v.ready ? { ready: true } : {}), ...(v.paused ? { paused: true } : {}), ...(id(v.ack) ? { ack: v.ack } : {}), ...(id(v.refused) ? { refused: v.refused } : {}), ...(m ? { message: m } : {}) };
}

export function readLinkResponse(value: unknown, now: number): LinkResponse | undefined {
  const v = record(value);
  if (!v || Object.keys(v).some(k => !["state", "accepted", "message"].includes(k))) return;
  const state = v.state;
  if (state !== "ok" && state !== "paused" && state !== "limited" && state !== "unavailable" && state !== "removed") return;
  if (state !== "ok" && (v.accepted !== undefined || v.message !== undefined)) return;
  const m = v.message === undefined ? undefined : readLinkMessage(v.message, now);
  if ((v.accepted !== undefined && !id(v.accepted)) || (v.message !== undefined && !m)) return;
  return { state, ...(id(v.accepted) ? { accepted: v.accepted } : {}), ...(m ? { message: m } : {}) };
}
