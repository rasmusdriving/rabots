// Bots post in channels on their own (engine 0.23.0, docs/build/step-channel-posts.md): the right per
// channel and bot, post_to_channel's refusals and limits, the body sent to a local stand-in flow, the
// record and the line in the chat, a reply to the post with the post as background, and the main
// bot's may_post. Stand-in harness, no model, nothing sent outside this computer.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import type { ChannelMessage, Events, NoticeItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { EngineError } from "../errors.js";
import { EngineServer } from "../server.js";
import { parseParams } from "../schemas.js";
import { changeLines, type Ev, type FakeSession, settle, setup, upserts } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

/** A stand-in for the answer flow: answers each call in turn with the given replies, then 200 with a post id. */
async function flowStandIn(replies: { status: number; body?: string; delayMs?: number }[] = []) {
  const got: Record<string, unknown>[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let t = "";
    req.on("data", (c) => (t += c));
    req.on("end", () => {
      const body = JSON.parse(t) as Record<string, unknown>;
      got.push(body);
      const r = replies.shift() ?? { status: 200, body: body.kind === "post" ? JSON.stringify({ ok: true, messageId: `post-${++n}` }) : '{"ok":true}' };
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body ?? "");
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/reply?sig=s3cret-flow`,
    got,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const sessionOf = (sessions: FakeSession[], botId: string) => {
  const s = sessions.filter((x) => x.settings.botId === botId).at(-1);
  assert.ok(s, `no session for ${botId}`);
  return s;
};
const notices = (events: Ev[]) => upserts(events).filter((i): i is NoticeItem => i.kind === "notice");
const messages = (events: Ev[]) => events.filter((e) => e.event === "channel.message").map((e) => (e.data as Events["channel.message"]).message);

async function world(o: { replies?: { status: number; body?: string; delayMs?: number }[]; reply?: boolean; mayPost?: boolean } = {}) {
  const w = setup(undefined, () => true, { replyRetryMs: 30, replyTimeoutMs: 400 });
  const server = new EngineServer("tok-0123456789abcdef");
  server.attach(w.engine);
  const port = await server.listen(0);
  const flow = await flowStandIn(o.replies);
  const po = w.engine.createBot("Po");
  const kaja = w.engine.createBot("Kaja");
  await settle();
  const ch = w.engine.saveChannel({
    channel: {
      name: "Ops - Internal",
      allowedSenders: ["ada@example.com"],
      routes: [
        { tag: "Po", botId: po.id },
        { tag: "Kaja", botId: kaja.id },
      ],
      contextCount: 5,
      ...(o.reply === false ? {} : { replyUrl: flow.url }),
      ...(o.mayPost === false ? {} : { mayPost: [kaja.id] }),
    },
  });
  w.engine.sendMessage({ botId: po.id, text: "Go" });
  w.engine.sendMessage({ botId: kaja.id, text: "Go" });
  await settle();
  const close = async () => {
    await w.engine.repliesSent();
    w.engine.shutdown();
    await server.close();
    await flow.close();
    w.store.close();
  };
  const incoming = (b: Record<string, unknown>) => post(port, w.engine.channelAddress(ch.id).hookPath, b);
  return { ...w, flow, po, kaja, ch, close, incoming, ps: sessionOf(w.sessions, po.id), ks: sessionOf(w.sessions, kaja.id) };
}

describe("channel posts: the right", () => {
  test("off by default, saved per bot, checked, and a retired bot drops out", async () => {
    const w = await world({ mayPost: false });
    assert.deepEqual(w.engine.getChannel(w.ch.id).mayPost, []);
    // Over the socket the right passes the method's check (the window and the app check send it there).
    assert.deepEqual(parseParams("channel.save", { channel: { id: w.ch.id, mayPost: [w.kaja.id] } })?.channel.mayPost, [w.kaja.id]);
    assert.throws(() => w.engine.saveChannel({ channel: { id: w.ch.id, mayPost: ["nobody"] } }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
    const saved = w.engine.saveChannel({ channel: { id: w.ch.id, mayPost: [w.kaja.id, w.po.id, w.kaja.id] } });
    assert.deepEqual(saved.mayPost, [w.kaja.id, w.po.id]);
    const changed = w.events.filter((e) => e.event === "channel.changed").map((e) => (e.data as Events["channel.changed"]).channel);
    assert.deepEqual(changed.at(-1)?.mayPost, [w.kaja.id, w.po.id]);
    w.engine.retireBot(w.kaja.id);
    await settle();
    assert.deepEqual(w.engine.getChannel(w.ch.id).mayPost, [w.po.id]);
    await w.close();
  });
});

describe("channel posts: post_to_channel", () => {
  test("every bot has it; it refuses plainly with the next step", async () => {
    const w = await world({ reply: false });
    assert.ok(w.ks.toolNames().includes("post_to_channel") && w.ps.toolNames().includes("post_to_channel"));
    assert.match(text(await w.ks.tool("post_to_channel", { channel: "Nope", text: "Hi" })), /no channel called Nope/);
    const noRight = await w.ps.tool("post_to_channel", { channel: "Ops - Internal", text: "Hi" });
    assert.equal(noRight.isError, true);
    assert.match(text(noRight), /You may not post on your own in Ops - Internal\. The person switches it on .*Posts, May post.*or the main bot does/);
    assert.match(text(await w.ks.tool("post_to_channel", { channel: "ops - internal", text: "Hi" })), /No address for answers is set for Ops - Internal, so posts cannot go out yet/);
    w.engine.saveChannel({ channel: { id: w.ch.id, replyUrl: w.flow.url, enabled: false } });
    assert.match(text(await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Hi" })), /switched off/);
    w.engine.saveChannel({ channel: { id: w.ch.id, enabled: true } });
    assert.match(text(await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "   " })), /The post is empty/);
    const long = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "x".repeat(4001) });
    assert.equal(text(long), "The post is 4,001 characters long. A post can be at most 4,000 characters: shorten it, or split it into a few posts.");
    assert.equal(w.flow.got.length, 0, "a refused post reached the flow");
    assert.equal(w.store.posts.triesSince(w.ch.id, w.kaja.id, "2000-01-01T00:00:00.000Z").length, 0, "a refusal counted as a try");
    await w.close();
  });

  test("a post: the body the flow gets, the post's id kept, and a quiet line with the post when the turn ends", async () => {
    const w = await world();
    const r = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "  **Ops status**\n\n- Nordvik on Thursday  " });
    assert.equal(r.isError, undefined);
    assert.equal(text(r), "Posted in Ops - Internal. A tagged reply to it reaches the bot the tag points to, with your post as background. You can post 5 more times there in this hour.");
    assert.deepEqual(w.flow.got, [
      { kind: "post", channelId: w.ch.id, bot: "Kaja", text: "**Ops status**\n\n- Nordvik on Thursday", html: "<p><strong>Ops status</strong></p>\n<ul><li>Nordvik on Thursday</li></ul>" },
    ]);
    const rows = w.store.posts.triesSince(w.ch.id, w.kaja.id, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(
      rows.map((p) => [p.status, p.outsideId, p.note]),
      [["posted", "post-1", undefined]],
    );
    // The line waits for the end of the turn, as the main bot's notes do.
    assert.equal(notices(w.events).filter((n) => n.mark === "posted").length, 0);
    w.ks.reply("Done.");
    await settle();
    const line = notices(w.events).filter((n) => n.mark === "posted").at(-1)!;
    assert.equal(line.text, "Posted in Ops - Internal");
    assert.equal(line.tone, "info");
    assert.equal(line.detail, "**Ops status**\n\n- Nordvik on Thursday");
    assert.equal(line.threadId, w.kaja.mainThreadId);
    assert.deepEqual(changeLines(w.events, w.kaja.mainThreadId), [], "the posted line is not a change line");
    await w.close();
  });

  test("six tries an hour per bot and channel, failed ones too; the answer says when the next can go", async () => {
    const w = await world();
    const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
    const add = (minsAgo: number, status: "posted" | "failed", botId = w.kaja.id) =>
      w.store.posts.add({ id: `p${minsAgo}-${status}-${botId}`, channelId: w.ch.id, botId, at: at(minsAgo), text: "x", status });
    add(70, "posted"); // older than an hour: does not count
    add(50, "failed");
    add(40, "posted");
    add(30, "failed");
    add(20, "posted");
    add(10, "posted");
    add(5, "posted", w.po.id); // another bot's: does not count
    const fifth = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Sixth" });
    assert.match(text(fifth), /You can post 0 more times there in this hour\./);
    const refused = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Seventh" });
    assert.equal(refused.isError, true);
    assert.equal(text(refused), "You have posted 6 times in Ops - Internal in the last hour, which is the most a bot may (tries that failed count too). The next one can go in about 10 minutes.");
    assert.equal(w.flow.got.length, 1);
    await w.close();
  });

  test("a 400, a 500, an address nobody answers and a flow that is late: never tried again, a plain reason and an error line", async () => {
    const w = await world({ replies: [{ status: 400 }, { status: 502 }, { status: 200, delayMs: 1_000 }, { status: 200, body: "not json" }] });
    const r400 = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "One" });
    assert.equal(r400.isError, true);
    assert.match(text(r400), /refused the post \(status 400\)\. It likely has no branch for new posts yet.*Nothing was posted\. The guide for setting up the Teams channel flows, to go through with the person, is \/.*\/teams-channel-flows\.md\. You can try 5 more times in this hour\./);
    const r500 = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Two" });
    assert.match(text(r500), /could not post it in Teams \(status 502\)\. Ask the person to look at the flow's run history/);
    assert.equal(w.flow.got.length, 2, "a failed post was tried again");
    const late = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Three" });
    assert.match(text(late), /did not answer within 1 second\. The post may still appear in the channel, so do not post it again before the person has checked there\./);
    const noId = await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Four" });
    assert.match(text(noId), /^Posted in Ops - Internal\. The flow did not send back the post's id, so a reply to it will not get your post as background\./);
    const rows = w.store.posts.triesSince(w.ch.id, w.kaja.id, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(
      rows.map((p) => p.status),
      ["failed", "failed", "failed", "posted"],
    );
    w.ks.reply("Done.");
    await settle();
    const lines = notices(w.events).filter((n) => n.threadId === w.kaja.mainThreadId && (n.mark === "posted" || /^Could not post/.test(n.text)));
    assert.deepEqual(
      lines.map((n) => [n.tone, n.text, n.detail]),
      [
        ["error", "Could not post in Ops - Internal: the flow needs its branch for new posts", "One"],
        ["error", "Could not post in Ops - Internal: the flow failed. See its run history", "Two"],
        ["error", "Could not post in Ops - Internal: no answer in time. Check the channel before posting again", "Three"],
        ["info", "Posted in Ops - Internal", "Four"],
      ],
    );
    assert.ok(!JSON.stringify(w.events).includes("s3cret-flow"), "the address for answers reached an event");
    await w.close();
  });

  test("a tagged reply to the post reaches the tagged bot with the post first in its background, and the answer goes into that thread", async () => {
    const w = await world();
    await w.ks.tool("post_to_channel", { channel: "Ops - Internal", text: "Ops status for week 46" });
    w.ks.reply("Posted.");
    w.ps.reply("Ready.");
    await settle();
    // Ada answers in the post's thread and tags Po; the incoming flow leaves the bot's post out of the context.
    const reply = {
      messageId: "m-reply-1",
      threadId: "post-1",
      from: { name: "Ada Example", email: "ada@example.com" },
      text: "Po can you add the Aalto date",
      mentions: ["Po"],
      context: [{ from: "Bo Example", text: "Good summary.", at: "2026-11-15T09:00:00Z" }],
    };
    assert.equal((await w.incoming(reply)).status, 202);
    await settle();
    const sent = w.ps.sent.at(-1)!.text;
    const json = JSON.parse(sent.split("```json\n")[1]!.split("\n```")[0]!) as { from: string; text: string }[];
    assert.deepEqual(
      json.map((c) => [c.from, c.text]),
      [
        ["Kaja, a bot in Pobots (the post that started this thread)", "Ops status for week 46"],
        ["Bo Example", "Good summary."],
      ],
    );
    w.ps.reply("Added: Aalto on Friday.");
    await w.engine.repliesSent();
    const answer = w.flow.got.at(-1)!;
    assert.equal(answer.threadId, "post-1");
    assert.equal(answer.messageId, "m-reply-1");
    assert.equal(answer.kind, undefined, "an answer is not a post");
    // The same bot tagged: the post is its own.
    await w.incoming({ ...reply, messageId: "m-reply-2", mentions: ["Kaja"], text: "Kaja thanks" });
    await settle();
    assert.match(w.ks.sent.at(-1)!.text, /"from": "You \(the post that started this thread\)"/);
    w.ks.reply("Glad it helps.");
    await w.engine.repliesSent();
    // A thread a bot did not start gets nothing extra.
    await w.incoming({ ...reply, messageId: "m-reply-3", threadId: "someone-else", mentions: ["Kaja"] });
    await settle();
    assert.doesNotMatch(w.ks.sent.at(-1)!.text, /the post that started this thread/);
    assert.ok(messages(w.events).every((m: ChannelMessage) => m.status !== "refused"));
    await w.close();
  });
});

describe("channel posts: the main bot and the words", () => {
  test("update_channel may_post: at once with a quiet line, by name or id; list_channels says who may post", async () => {
    const w = await world({ mayPost: false });
    assert.match(text(await w.ps.tool("update_channel", { channel: "Ops - Internal", may_post: ["Nobody"] })), /no bot called Nobody/);
    assert.equal(text(await w.ps.tool("update_channel", { channel: "Ops - Internal", may_post: ["kaja"] })), "Changed the channel Ops - Internal. The person has a note about it.");
    assert.deepEqual(w.engine.getChannel(w.ch.id).mayPost, [w.kaja.id]);
    assert.match(text(await w.ps.tool("update_channel", { channel: "Ops - Internal", may_post: [w.kaja.id] })), /Nothing would change/);
    assert.match(text(await w.ps.tool("list_channels")), /May post on their own: Kaja\./);
    assert.match(text(await w.ks.tool("list_channels")), /You may write posts of your own with post_to_channel in: Ops - Internal\. At most 6 an hour in each, up to 4,000 characters each\./);
    await w.ps.tool("update_channel", { channel: "Ops - Internal", may_post: [] });
    assert.deepEqual(w.engine.getChannel(w.ch.id).mayPost, []);
    assert.match(text(await w.ps.tool("list_channels")), /May post on their own: no bot\./);
    assert.match(text(await w.ks.tool("list_channels")), /You may not write posts of your own in any channel/);
    assert.match(text(await w.ps.tool("update_channel", { channel: "New one", create: true, may_post: ["Kaja"] })), /Make the channel first/);
    w.ps.reply("Done.");
    await settle();
    assert.deepEqual(changeLines(w.events, w.po.mainThreadId), ["Channel Ops - Internal: Kaja may post on its own now; Kaja may no longer post on its own"]);
    assert.match(w.ps.settings.team, /which bots may post on their own/);
    assert.match(w.ks.settings.team, /where you may write a post of your own with post_to_channel/);
    const words = (w.engine as unknown as { toolWords(n: string, i: Record<string, unknown>): { done: string; running: string; detail?: string } }).toolWords("mcp__pobots__post_to_channel", {
      channel: w.ch.id,
      text: "Status",
    });
    assert.deepEqual(words, { done: "Posted in Ops - Internal", running: "Posting in Ops - Internal", failed: "Could not post in Ops - Internal", detail: "Status", whyOnFail: true });
    await w.close();
  });
});
