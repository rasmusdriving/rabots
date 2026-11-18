// The app check's section "posts" (docs/build/step-channel-posts.md, 15 Nov 2026): a real bot on the
// cheapest Claude model writes a post of its own in a channel with post_to_channel, through a local
// stand-in for the answer flow. Without the right it is refused and nothing reaches the flow; with
// it, the flow gets the post's body and the bot's chat has "Posted in"; with six tries in the last
// hour already in the database the next is refused; and a tagged reply in the post's thread reaches
// the bot with its post as background, and the answer goes into that thread. Nothing leaves this
// computer. Run it alone: node scripts/app-check.mjs --only=posts.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { sleep, check, sideChannel, run, dataDir } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Pobots tool named here; use no connectors or MCP servers, change no files outside your own folder.";
const NAME = "pobots test posts";
const POST = "Weekly check: the fruit of the week is PEAR.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  // The stand-in for the flow that posts in Teams: a new post gets an id back, as the real flow's branch does.
  const got = [];
  const flow = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let b;
      try {
        b = JSON.parse(body);
      } catch {
        b = { bad: true };
      }
      got.push(b);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b.kind === "post" ? { ok: true, messageId: `post-${got.length}` } : { ok: true }));
    });
  });
  await new Promise((r) => flow.listen(0, "127.0.0.1", r));
  try {
    const snap0 = await s.request("snapshot");
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const bot = (await s.request("bot.create", { name: "Poster", purpose: "For the channel posts check", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low })).bot;
    const channel = (
      await s.request("channel.save", {
        channel: { name: NAME, allowedSenders: ["ada@example.com"], routes: [{ tag: "Poster", botId: bot.id }], contextCount: 5, replyUrl: `http://127.0.0.1:${flow.address().port}/reply` },
      })
    ).channel;
    check("posts: a new channel lets no bot post on its own", Array.isArray(channel.mayPost) && channel.mayPost.length === 0, JSON.stringify(channel.mayPost));

    const rested = async (ms = 180_000) => {
      const end = Date.now() + ms;
      await sleep(1500);
      while (Date.now() < end) {
        for (const c of (await s.request("snapshot")).cards) {
          if (cardsAtStart.has(c.id)) continue;
          await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
        }
        const b = (await s.request("snapshot")).bots.find((x) => x.id === bot.id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.context?.tidying) return true;
        await sleep(1000);
      }
      return false;
    };
    const items = async () => (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 300 })).items;
    const lastSaid = async () => (await items()).filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    const postActs = async () => (await items()).filter((i) => i.kind === "activity" && /^(Post(ed|ing)|Could not post) in /.test(i.label));
    const ask = (text) => s.request("message.send", { botId: bot.id, text: `${RULES} Use your Pobots tool post_to_channel exactly once, with channel "${NAME}" and text: ${text} Then reply with the first sentence of its answer, word for word.` });

    // 1. Without the right: refused, nothing reaches the flow.
    await ask(POST);
    const r1 = await rested();
    const acts1 = await postActs();
    check("posts: without the right the bot's post_to_channel is refused, its line reads Could not post in", r1 && acts1.length === 1 && acts1[0].status === "failed" && acts1[0].label === `Could not post in ${NAME}`, JSON.stringify(acts1.map((a) => [a.label, a.status])));
    check("posts: and nothing reached the flow", got.length === 0, JSON.stringify(got).slice(0, 200));
    check("posts: the bot was told it may not post there", /(may not|not allowed|cannot|can't|permission|switch)/i.test(await lastSaid()), (await lastSaid()).slice(0, 200));

    // 2. With the right: the flow gets the post, the chat says so.
    const allowed = (await s.request("channel.save", { channel: { id: channel.id, mayPost: [bot.id] } })).channel;
    check("posts: the right is saved for the bot", allowed.mayPost.join(",") === bot.id, JSON.stringify(allowed.mayPost));
    await ask(POST);
    const r2 = await rested();
    const sent = got.find((b) => b.kind === "post");
    check(
      "posts: the flow got a new post with the bot's name, the text and html, and no thread",
      r2 && !!sent && sent.channelId === channel.id && sent.bot === "Poster" && /PEAR/.test(sent.text ?? "") && /PEAR/.test(sent.html ?? "") && sent.threadId === undefined && sent.messageId === undefined,
      JSON.stringify(sent ?? null).slice(0, 240),
    );
    const line = (await items()).filter((i) => i.kind === "notice" && i.mark === "posted").at(-1);
    check("posts: the bot's chat says Posted in the channel, with the post behind it", line?.text === `Posted in ${NAME}` && /PEAR/.test(line?.detail ?? ""), JSON.stringify(line ?? null).slice(0, 200));
    const acts2 = await postActs();
    check("posts: its activity line reads Posted in the channel", acts2.at(-1)?.label === `Posted in ${NAME}` && acts2.at(-1)?.status === "done", JSON.stringify(acts2.at(-1) ?? null).slice(0, 160));

    // 3. The limit: with six tries in the last hour in the database, the next is refused.
    const db = new DatabaseSync(join(dataDir, "pobots.db"));
    db.exec("PRAGMA busy_timeout = 3000");
    const ins = db.prepare("INSERT INTO channel_posts (id, channel_id, bot_id, at, text, status) VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 5; i++) ins.run(`check-${i}`, channel.id, bot.id, new Date(Date.now() - (i + 1) * 60_000).toISOString(), "earlier", i % 2 ? "failed" : "posted");
    db.close();
    const before = got.length;
    await ask("One more for the limit.");
    const r3 = await rested();
    const acts3 = await postActs();
    check("posts: the seventh try in an hour is refused", r3 && acts3.at(-1)?.status === "failed" && got.length === before, JSON.stringify({ status: acts3.at(-1)?.status, flow: got.length - before }));
    check("posts: the bot was told the limit", /(6|six)/i.test(await lastSaid()) && /hour/i.test(await lastSaid()), (await lastSaid()).slice(0, 200));

    // 4. A tagged reply in the post's thread reaches the bot with its post as background, and the answer goes there.
    const httpBase = endpoint.url.replace(/^ws/, "http").replace(/\/ws$/, "").replace(/\/$/, "");
    const hookPath = (await s.request("channel.address", { channelId: channel.id })).hookPath;
    const postId = sent ? `post-${got.indexOf(sent) + 1}` : "no-post";
    const reply = await fetch(`${httpBase}${hookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "m-reply-1", threadId: postId, from: { name: "Ada Example", email: "ada@example.com" }, text: "Poster which fruit did your post name? Answer with the fruit only.", mentions: ["Poster"], context: [] }),
    });
    check("posts: the tagged reply is accepted", reply.status === 202, String(reply.status));
    const r4 = await rested();
    const msg = (await items()).filter((i) => i.kind === "user" && i.from.type === "channel").at(-1);
    const bg = msg?.from.context?.[0];
    check("posts: the reply carries the bot's post first in its background", !!bg && /the post that started this thread/.test(bg.from) && /PEAR/.test(bg.text), JSON.stringify(bg ?? null).slice(0, 200));
    let answer;
    for (let i = 0; i < 40 && !answer; i++) {
      answer = got.find((b) => b.messageId === "m-reply-1");
      if (!answer) await sleep(250);
    }
    check("posts: the bot answers from its post, into the post's thread", r4 && !!sent && !!answer && answer.threadId === postId && /pear/i.test(answer.text ?? "") && answer.kind === undefined, JSON.stringify(answer ?? null).slice(0, 200));
  } finally {
    flow.close();
    s.close();
  }
}
