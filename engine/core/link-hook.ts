import type { IncomingMessage, ServerResponse } from "node:http";
import type { Links } from "./links.js";
import { linkBodyMax, type LinkWire } from "./link-wire.js";

const LINK_READ_MS = 3_000;
/** Wire 2 bodies carry a piece of a file (up to 1 MB). */
const LINK_READ_MS_2 = 20_000;
const LINK_CONTENT_TYPE = "application/octet-stream";

/** All input that does not authenticate uses the webhook's existing wrong-address response. */
export function linkHook(links: Links, req: IncomingMessage, res: ServerResponse, id: string, wrong: () => void, wire: LinkWire = 1): void {
  const header = req.headers["x-pobots-link"];
  const lengthHeader = req.headers["content-length"];
  const length = typeof lengthHeader === "string" && /^\d{1,7}$/.test(lengthHeader) ? Number(lengthHeader) : 0;
  const proof = req.method === "POST" && typeof header === "string" ? links.preflight(id, header, wire) : undefined;
  if (!proof || length <= 92 || length > linkBodyMax(wire) || req.headers["content-type"] !== LINK_CONTENT_TYPE) return wrong();
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
  const timer = setTimeout(fail, wire === 2 ? LINK_READ_MS_2 : LINK_READ_MS);
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
    // No error thrown on this route may log request fields or connection material.
    links.receive(proof, body).then(answer => {
      if (!answer) return wrong();
      if (answer.status === 429) res.setHeader("Retry-After", "60");
      res.writeHead(answer.status, { "Content-Type": LINK_CONTENT_TYPE, "Content-Length": answer.body.length });
      res.end(answer.body);
    }, () => wrong());
  });
}
