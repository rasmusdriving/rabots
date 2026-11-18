// A stand-in for the Power Automate flow that posts a bot's answer in Teams. For testing a channel
// without Teams: it accepts the engine's reply posts on 127.0.0.1 and writes each one, as one line of
// JSON, to a file.
//
//   node scripts/reply-standin.mjs [--port=47790] [--out=PATH] [--fail]
//
// Set the channel's answer address to http://127.0.0.1:<port>/reply. With --fail it answers 500, to
// see what the app says when an answer cannot be posted. A bot's own new post (`kind: "post"`, 15 Nov
// 2026) is answered as the real flow does, with the new post's id: `{ "ok": true, "messageId": "post-1" }`.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(arg("port") ?? 47790);
const out = arg("out") ?? join(tmpdir(), "pobots-replies.jsonl");
const fail = process.argv.includes("--fail");
let posts = 0;

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    if (body.length < 1_000_000) body += c;
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { notJson: body.slice(0, 200) };
    }
    appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.url, body: parsed }) + "\n");
    res.writeHead(fail ? 500 : 200, { "Content-Type": "application/json" });
    const post = parsed && parsed.kind === "post";
    res.end(fail ? '{"ok":false}' : post ? JSON.stringify({ ok: true, messageId: `post-${++posts}-${Date.now()}` }) : '{"ok":true}');
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Reply stand-in on http://127.0.0.1:${port}/reply${fail ? " (answers 500)" : ""}. Writing to ${out}`);
});
