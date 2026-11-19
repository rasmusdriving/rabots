import type { IncomingMessage, ServerResponse } from "node:http";
import type { Links } from "./links.js";
import { LINK_BODY_MAX } from "./link-wire.js";

const LINK_READ_MS = 3_000;
const LINK_CONTENT_TYPE = "application/octet-stream";

/** All input that does not authenticate uses the webhook's existing wrong-address response. */
export function linkHook(links: Links, req: IncomingMessage, res: ServerResponse, id: string, wrong: () => void): void {
  const header = req.headers["x-pobots-link"];
  const lengthHeader = req.headers["content-length"];
  const length = typeof lengthHeader === "string" && /^\d{1,6}$/.test(lengthHeader) ? Number(lengthHeader) : 0;
  const proof = req.method === "POST" && typeof header === "string" ? links.preflight(id, header) : undefined;
  if (!proof || length <= 92 || length > LINK_BODY_MAX || req.headers["content-type"] !== LINK_CONTENT_TYPE) return wrong();
  const body = Buffer.allocUnsafe(length);
  let size = 0;
  let finished = false;
  const close = () => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    return true;
  };
  const fail = () => {
    if (!close()) return;
    wrong();
  };
  const timer = setTimeout(fail, LINK_READ_MS);
  req.on("aborted", close);
  req.on("error", close);
  req.on("data", (chunk: Buffer) => {
    if (finished) return;
    if (size + chunk.length > length) return fail();
    chunk.copy(body, size);
    size += chunk.length;
  });
  req.on("end", () => {
    if (!close()) return;
    if (size !== length) return wrong();
    let answer;
    try {
      answer = links.receive(proof, body);
    } catch {
      // No error thrown on this route may log request fields or connection material.
      return wrong();
    }
    if (!answer) return wrong();
    if (answer.status === 429) res.setHeader("Retry-After", "60");
    res.writeHead(answer.status, { "Content-Type": LINK_CONTENT_TYPE, "Content-Length": answer.body.length });
    res.end(answer.body);
  });
}
