// The mock engine's channels: Teams channels a bot answers in, what comes in on them, the answers and
// the main bot's cards about tags and writers. Free functions of the mock: `mock` is the MockEngine,
// and each keeps a one-line method there. Moved out of mock.ts unchanged on 15 Nov 2026
// (docs/build/step-split.md).
import type { ChannelMessage, ChannelRoute, Methods, NoticeItem, UserItem } from "../../shared/protocol";
import { EngineError } from "./types";
import {
  ADA,
  BO,
  CY,
  OPS,
  AGENDA_ASK,
  NO_REPLY,
  isEmail,
  cleanTag,
  at,
  today,
  minutesAgo,
  later,
  type MockChannel,
  type ChannelPost,
  type PostOutcome,
  secret,
  firstWords,
  publicChannel,
} from "./mock-data";
import type { MockEngine } from "./mock";

export function seedChannels(mock: MockEngine): void {
  const ops: MockChannel = {
    id: "ch-ops",
    kind: "teams",
    name: OPS,
    enabled: true,
    allowedSenders: [ADA.email, BO.email],
    routes: [
      { tag: "Kaja", botId: "kaja" },
      { tag: "Inbox", botId: "inbox" },
    ],
    contextCount: 10,
    hasReplyUrl: true,
    secret: secret(),
    replyUrl: "https://flows.example.com/answer/ops-internal",
    mayPost: [],
  };
  const pilots: MockChannel = {
    id: "ch-pilots",
    kind: "teams",
    name: "Customer pilots",
    enabled: false,
    allowedSenders: [],
    routes: [],
    contextCount: 10,
    hasReplyUrl: false,
    secret: secret(),
    mayPost: [],
  };
  mock.channels = [ops, pilots];
  const m = (id: string, at: string, sender: string, status: ChannelMessage["status"], extra: Partial<ChannelMessage> = {}): ChannelMessage => ({ id, channelId: ops.id, at, sender, status, ...extra });
  // One in every status, newest first.
  const list: ChannelMessage[] = [
    m("1794391590001", minutesAgo(2), BO.name, "delivered", { tag: "Inbox", botId: "inbox", note: "Inbox has Nordvik written back about the import date" }),
    m("1794391578003", today(8, 40), ADA.name, "answered", { tag: "Kaja", botId: "kaja", note: firstWords(AGENDA_ASK), turnId: "tk-ch" }),
    m("1794391402000", at(1, 15, 20), ADA.name, "reply-failed", { tag: "Kaja", botId: "kaja", note: "The answer could not be posted. The flow answered 502." }),
    m("1794391377000", at(1, 11, 2), ADA.name, "unanswered", { tag: "Kaja", botId: "kaja", note: "Kaja ended without anything to post" }),
    m("1794391300000", at(2, 14, 45), BO.name, "ignored", { note: "No tag in the message matched a bot here" }),
    m("1794391250000", at(2, 9, 12), CY.name, "refused", { note: "The writer is not on the list for this channel" }),
  ];
  // Older ones, so the list has a second page.
  for (let n = 0; n < 18; n++)
    list.push(m(`17943910${String(n).padStart(5, "0")}`, at(3 + Math.floor(n / 3), 15 - (n % 3) * 3, 0), n % 2 ? BO.name : ADA.name, "answered", { tag: "Kaja", botId: "kaja", note: `Earlier question number ${18 - n}` }));
  list.sort((a, b) => b.at.localeCompare(a.at));
  mock.channelMessages.set(ops.id, list);
  mock.channelMessages.set(pilots.id, []);
  ops.lastMessage = list[0];
}

export function channel(mock: MockEngine, id: string): MockChannel {
  const c = mock.channels.find((x) => x.id === id);
  if (!c) throw new EngineError({ code: "not_found", message: "That channel is gone." });
  return c;
}

export function channelChanged(mock: MockEngine, c: MockChannel): void {
  mock.emit({ event: "channel.changed", data: { channel: publicChannel(c) } });
}

export function saveChannel(mock: MockEngine, p: Methods["channel.save"]["params"]["channel"]): MockChannel {
  const bad = (message: string) => new EngineError({ code: "bad_request", message });
  const name = p.name?.trim();
  if (p.name !== undefined && !name) throw bad("A channel needs a name.");
  if (name && name.length > 60) throw bad("Keep the name to 60 characters.");
  let senders: string[] | undefined;
  if (p.allowedSenders) {
    senders = [];
    for (const raw of p.allowedSenders) {
      const email = raw.trim().toLowerCase();
      if (!isEmail(email)) throw bad(`That is not an email address: ${raw.trim()}`);
      if (!senders.includes(email)) senders.push(email);
    }
  }
  let routes: ChannelRoute[] | undefined;
  if (p.routes) {
    routes = [];
    for (const r of p.routes) {
      const tag = cleanTag(r.tag);
      if (!tag) throw bad("A tag needs at least one letter.");
      if (tag.length > 40) throw bad("Keep a tag to 40 characters.");
      if (!mock.bots.some((b) => b.id === r.botId)) throw bad("A tag can only reach a bot that exists.");
      if (routes.some((x) => x.tag.toLowerCase() === tag.toLowerCase())) throw bad(`The tag ${tag} is there twice. Each tag reaches one bot.`);
      routes.push({ tag, botId: r.botId });
    }
  }
  let mayPost: string[] | undefined;
  if (p.mayPost) {
    mayPost = [];
    for (const id of p.mayPost) {
      if (!mock.bots.some((b) => b.id === id)) throw bad("A bot that may post does not exist.");
      if (!mayPost.includes(id)) mayPost.push(id);
    }
  }
  if (p.contextCount !== undefined && !(Number.isInteger(p.contextCount) && p.contextCount >= 0 && p.contextCount <= 30)) throw bad("Give a bot between 0 and 30 earlier messages.");
  if (p.replyUrl !== undefined && p.replyUrl !== "" && !/^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/\S*)?$/.test(p.replyUrl.trim()))
    throw bad("Use an address that starts with https://.");
  const apply = (c: MockChannel) => {
    if (name !== undefined) c.name = name;
    if (p.enabled !== undefined) c.enabled = p.enabled;
    if (senders) c.allowedSenders = senders;
    if (routes) c.routes = routes;
    if (mayPost) c.mayPost = mayPost;
    if (p.contextCount !== undefined) c.contextCount = p.contextCount;
    if (p.replyUrl !== undefined) {
      c.replyUrl = p.replyUrl.trim() || undefined;
      c.hasReplyUrl = !!c.replyUrl;
    }
  };
  if (p.id) {
    const c = mock.channel(p.id);
    apply(c);
    mock.channelChanged(c);
    return c;
  }
  if (!name) throw bad("A channel needs a name.");
  const c: MockChannel = { id: `ch${mock.nextId++}`, kind: "teams", name, enabled: true, allowedSenders: [], routes: [], contextCount: 10, hasReplyUrl: false, secret: secret(), mayPost: [] };
  apply(c);
  mock.channels.push(c);
  mock.channelMessages.set(c.id, []);
  mock.channelChanged(c);
  return c;
}

/** Records a channel message (new or changed), keeps the channel's last message current and says so. */
export function putChannelMessage(mock: MockEngine, message: ChannelMessage): void {
  const list = mock.channelMessages.get(message.channelId) ?? [];
  const i = list.findIndex((m) => m.id === message.id);
  if (i >= 0) list[i] = message;
  else list.unshift(message);
  mock.channelMessages.set(message.channelId, list);
  const c = mock.channels.find((x) => x.id === message.channelId);
  if (c && (!c.lastMessage || c.lastMessage.id === message.id || c.lastMessage.at <= message.at)) {
    c.lastMessage = message;
    mock.channelChanged(c);
  }
  mock.emit({ event: "channel.message", data: { message } });
}

/** The engine's intake for a channel, as the flow would meet it. */
export function channelPost(mock: MockEngine, channelId: string, body: ChannelPost): PostOutcome {
  const c = mock.channels.find((x) => x.id === channelId);
  if (!c || !c.enabled) return "not-found";
  const seen = mock.channelMessages.get(c.id) ?? [];
  if (seen.some((m) => m.id === body.messageId)) return "duplicate";
  const sender = body.from.name?.trim() || body.from.email;
  const text = (body.text ?? body.html?.replace(/<[^>]*>/g, "") ?? "").trim();
  const base: ChannelMessage = { id: body.messageId, channelId: c.id, at: new Date().toISOString(), sender, status: "delivered" };
  if (!c.allowedSenders.includes(body.from.email.trim().toLowerCase())) {
    mock.putChannelMessage({ ...base, status: "refused", note: "The writer is not on the list for this channel" });
    return "refused";
  }
  const named = (body.mentions ?? []).map((x) => cleanTag(x).toLowerCase());
  const route = named.length
    ? c.routes.find((r) => named.includes(r.tag.toLowerCase()))
    : c.routes.find((r) => {
        const tag = r.tag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${tag}\\b|[@#]${tag}\\b`, "i").test(text);
      });
  if (!route) {
    mock.putChannelMessage({ ...base, status: "ignored", note: "No tag in the message matched a bot here" });
    return "ignored";
  }
  const bot = mock.bot(route.botId);
  const context = (body.context ?? []).slice(-c.contextCount);
  const busy = mock.turns.has(bot.id);
  const item = mock.add<UserItem>(bot.mainThreadId, {
    kind: "user",
    from: { type: "channel", channelId: c.id, label: c.name, sender, tag: route.tag, messageId: body.messageId, ...(context.length ? { context } : {}) },
    queued: busy,
    text,
  });
  mock.channelOfItem.set(item.id, { channelId: c.id, messageId: body.messageId });
  mock.putChannelMessage({ ...base, tag: route.tag, botId: bot.id, note: firstWords(text) });
  mock.upsert(item);
  if (!busy) void mock.runTurn(bot.id, item, {});
  return "delivered";
}

/** After a turn that answered a channel message: post the answer or not, record it, add the notice. */
export async function answerChannel(mock: MockEngine, ref: { channelId: string; messageId: string }, answer: string, turnId: string, stopped: boolean): Promise<void> {
  const c = mock.channels.find((x) => x.id === ref.channelId);
  const record = mock.channelMessages.get(ref.channelId)?.find((m) => m.id === ref.messageId);
  if (!c || !record) return;
  const threadId = mock.bots.find((b) => b.id === record.botId)?.mainThreadId;
  const notice = (text: string, tone: NoticeItem["tone"]) => threadId && mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone, text }));
  const done = { ...record, turnId };
  if (stopped) {
    mock.putChannelMessage({ ...done, status: "reply-failed", note: "The turn was stopped, so nothing was posted" });
    notice(`The answer could not be posted in ${c.name}`, "error");
    return;
  }
  if (answer.trim().replace(/\.$/, "").toLowerCase() === NO_REPLY.toLowerCase()) {
    mock.putChannelMessage({ ...done, status: "unanswered", note: `${mock.bot(record.botId!).name} had nothing to answer` });
    return;
  }
  if (!c.replyUrl) {
    mock.putChannelMessage({ ...done, status: "unanswered", note: "No reply address is set for this channel" });
    return;
  }
  await later(300);
  if (c.replyFails) {
    mock.putChannelMessage({ ...done, status: "reply-failed", note: "The answer could not be posted. The flow answered 502." });
    notice(`The answer could not be posted in ${c.name}`, "error");
    return;
  }
  mock.putChannelMessage({ ...done, status: "answered", note: firstWords(answer) });
  notice(`Answered in ${c.name}`, "info");
}

/**
 * The main bot changed a tag and the writers of a channel. Since the tester's walk of 15 Nov 2026 that
 * is done at once and told in one quiet line in its chat, never a card (it was two approval cards).
 */
export function addChannelChanges(mock: MockEngine): void {
  const main = mock.bots.find((b) => b.role === "main");
  const ops = mock.channels.find((c) => c.id === "ch-ops");
  if (!main || !ops) return;
  ops.routes = ops.routes.map((r) => (r.tag.toLowerCase() === "inbox" ? { ...r, botId: "onboardings" } : r));
  if (!ops.routes.some((r) => r.tag.toLowerCase() === "inbox")) ops.routes.push({ tag: "Inbox", botId: "onboardings" });
  ops.allowedSenders = [...ops.allowedSenders.filter((s) => s !== BO.email), ...(ops.allowedSenders.includes(CY.email) ? [] : [CY.email])];
  mock.channelChanged(ops);
  const lines = [
    `Channel ${OPS}: the tag Inbox reaches Onboardings (was Inbox); ${CY.email} may write now; ${BO.email} may no longer write`,
    'Inbox: purpose from "Reads Teams and email and tells Kaja what needs you" to "Reads Teams, email and the support inbox"; job rewritten (about 140 words); what it sees: 12 services and 6 plugins off (Notion, Claude Docs, Stripe and 15 more); 40 skills by name only (docs, pdf, xlsx and 37 more)',
  ];
  for (const text of lines) mock.upsert(mock.add<NoticeItem>(main.mainThreadId, { kind: "notice", tone: "info", text }));
}
