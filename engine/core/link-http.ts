// The only outbound network path for links. Pin a public DNS result, keep TLS verification on,
// and never follow a redirect or inherit a proxy that might reach a private service.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { LINK_BODY_MAX } from "./link-wire.js";

const blocked = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, bits);
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [address, bits] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, bits, "ipv6");

export function linkPublicIP(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address);
  return family === 6 && !address.includes("%") && global6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export type LinkFetch = (base: string, id: string, proof: string, body: Buffer, signal: AbortSignal) => Promise<{ status: number; body: Buffer }>;

export function linkFetch(loopback?: string): LinkFetch {
  return (base, id, proof, body, cancelled) => {
    const url = new URL(`/hook/link/${id}`, base);
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(4_500)]);
    const local = url.protocol === "http:" && url.origin === loopback && url.hostname === "127.0.0.1";
    if (!local && url.protocol !== "https:") return Promise.reject(new Error("Public address is not HTTPS"));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!local && isIP(hostname) && !linkPublicIP(hostname)) return Promise.reject(new Error("Public address is not public"));
    return new Promise((resolve, reject) => {
      const req = (local ? httpRequest : httpsRequest)(url, {
        method: "POST", signal, agent: false,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": body.length, "X-Pobots-Link": proof },
        lookup: (host, opts, cb) => {
          void lookup(host, { all: true }).then(records => {
            const chosen = records.find(r => linkPublicIP(r.address));
            if (!chosen) return cb(new Error("Public address is not public"), "", 0);
            if (opts.all) cb(null, [chosen]);
            else cb(null, chosen.address, chosen.family);
          }, () => cb(new Error("Public address could not be found"), "", 0));
        },
      }, res => {
        const status = res.statusCode ?? 0;
        if (status !== 200 && status !== 409 && status !== 429 && status !== 503) {
          res.destroy();
          reject(new Error("Public address did not answer"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > LINK_BODY_MAX) {
            res.destroy(new Error("Answer too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
}
