// Channels: saved channels, posts that arrive, the bot's reply at the end of its turn, and follow-ups after a helper.
import type { ChannelOutcome, Engine } from "../engine.js";
import type { ChannelRow } from "../store.js";
import type { Channel, ChannelMessage, Methods } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { CHANNEL_DEDUPE_MS, cleanChannelName, cleanContextCount, cleanReplyUrl, cleanRoutes, cleanSenders, CONTEXT_COUNT_DEFAULT, cutContext, cutMessage, isNoReply, matchRoute, MAX_CHANNELS, parseChannelBody, replyBody } from "../channels.js";
import { randomUUID } from "node:crypto";
import { firstWords, hookPath, newSecret } from "../triggers.js";
import { iso, now } from "./words.js";
import { log } from "../log.js";
import type { BotRuntime, Turn } from "./runtime.js";
import { address } from "./triggers.js";
import { cleanMayPost, postAsContext } from "./channel-posts.js";

export function toChannel(eng: Engine, row: ChannelRow): Channel {
  const last = eng.store.lastChannelMessage(row.id);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    allowedSenders: [...row.allowedSenders],
    routes: row.routes.filter((r) => eng.bots.has(r.botId)).map((r) => ({ tag: r.tag, botId: r.botId })),
    contextCount: row.contextCount,
    hasReplyUrl: !!row.replyUrl,
    mayPost: row.mayPost.filter((id) => eng.bots.has(id)),
    ...(last ? { lastMessage: last } : {}),
  };
}

export function channelOf(eng: Engine, channelId: string): ChannelRow {
  const row = eng.store.getChannel(channelId);
  if (!row) throw new EngineError("not_found", "There is no channel with that id.");
  return row;
}

export function emitChannel(eng: Engine, row: ChannelRow): void {
  eng.opts.emit("channel.changed", { channel: toChannel(eng, row) });
}

export function getChannel(eng: Engine, channelId: string): Channel {
  return toChannel(eng, channelOf(eng, channelId));
}

/** Creates a channel (no id) or changes the fields given. `replyUrl` is write-only: a new one replaces it, "" removes it. */
export function saveChannel(eng: Engine, params: Methods["channel.save"]["params"]): Channel {
  const c = params.channel;
  const exists = (id: string) => eng.bots.has(id);
  let row: ChannelRow;
  if (c.id === undefined) {
    if (eng.store.listChannels().length >= MAX_CHANNELS) throw new EngineError("bad_request", `There can be at most ${MAX_CHANNELS} channels. Remove one first.`);
    if (c.name === undefined) throw new EngineError("bad_request", "A channel needs a name.");
    const replyUrl = c.replyUrl ? cleanReplyUrl(c.replyUrl) : undefined;
    row = {
      id: randomUUID(),
      kind: "teams",
      name: cleanChannelName(c.name),
      enabled: c.enabled ?? true,
      allowedSenders: cleanSenders(c.allowedSenders ?? []),
      routes: cleanRoutes(c.routes ?? [], exists),
      contextCount: c.contextCount === undefined ? CONTEXT_COUNT_DEFAULT : cleanContextCount(c.contextCount),
      secret: newSecret(),
      ...(replyUrl ? { replyUrl } : {}),
      mayPost: cleanMayPost(c.mayPost ?? [], exists),
      createdAt: now(),
    };
    eng.store.addChannel(row);
    log.info(`Made the channel ${row.id}`);
  } else {
    const old = channelOf(eng, c.id);
    row = { ...old, routes: old.routes.filter((r) => exists(r.botId)), mayPost: old.mayPost.filter(exists) };
    if (c.name !== undefined) row.name = cleanChannelName(c.name);
    if (c.enabled !== undefined) row.enabled = c.enabled;
    if (c.allowedSenders !== undefined) row.allowedSenders = cleanSenders(c.allowedSenders);
    if (c.routes !== undefined) row.routes = cleanRoutes(c.routes, exists);
    if (c.contextCount !== undefined) row.contextCount = cleanContextCount(c.contextCount);
    if (c.mayPost !== undefined) row.mayPost = cleanMayPost(c.mayPost, exists);
    if (c.replyUrl !== undefined) {
      if (c.replyUrl.trim() === "") delete row.replyUrl;
      else row.replyUrl = cleanReplyUrl(c.replyUrl);
    }
    eng.store.updateChannel(row);
    log.info(`Changed the channel ${row.id}`);
  }
  emitChannel(eng, row);
  return toChannel(eng, row);
}

/** Removes a channel. Its address stops working at once; what came in on it stays in the database. */
export function removeChannel(eng: Engine, channelId: string): void {
  const row = channelOf(eng, channelId);
  eng.store.removeChannel(row.id);
  eng.opts.emit("channel.changed", { removedId: row.id });
  log.info(`Removed the channel ${row.id}`);
}

/** A channel's address. Works like a password: only on request, never in an event, never logged. */
export function channelAddress(eng: Engine, channelId: string): Methods["channel.address"]["result"] {
  const row = channelOf(eng, channelId);
  return address(eng, hookPath(row.id, row.secret));
}

/** A new secret for a channel. The old address stops working at once. */
export function channelNewAddress(eng: Engine, channelId: string): Methods["channel.newAddress"]["result"] {
  const row = channelOf(eng, channelId);
  row.secret = newSecret();
  eng.store.updateChannel(row);
  log.info(`The channel ${row.id} has a new address`);
  return address(eng, hookPath(row.id, row.secret));
}

export function channelMessages(eng: Engine, params: Methods["channel.messages"]["params"]): Methods["channel.messages"]["result"] {
  const row = channelOf(eng, params.channelId);
  const res = eng.store.listChannelMessages(row.id, params.before, params.limit ?? 30);
  if (!res) throw new EngineError("not_found", "There is no such message on this channel.");
  return res;
}

export function emitChannelMessage(eng: Engine, message: ChannelMessage): void {
  eng.opts.emit("channel.message", { message });
  const row = eng.store.getChannel(message.channelId);
  if (row) emitChannel(eng, row);
}

export function saveChannelMessage(eng: Engine, rid: string, message: ChannelMessage): void {
  if (!eng.store.isOpen) return;
  eng.store.updateChannelMessage(rid, message);
  emitChannelMessage(eng, message);
}

/** The message a user item came from ends without an answer, if it is still waiting for one. */
export function endChannelOfItem(eng: Engine, itemId: string, note: string): void {
  const row = eng.store.channelMessageByItem(itemId);
  if (row && row.message.status === "delivered") saveChannelMessage(eng, row.rid, { ...row.message, status: "reply-failed", note });
}

/**
 * A message posted to a channel's address, after the address and the limits were checked. A writer
 * not on the list is refused, a message seen before is a duplicate, one without a matching tag is
 * ignored. Otherwise it goes to the bot's main chat like any message. Never waits for the bot.
 */
export function channelCall(eng: Engine, channelId: string, value: unknown): ChannelOutcome {
  const ch = eng.store.getChannel(channelId);
  if (!ch || !ch.enabled) return { status: 404 };
  const body = parseChannelBody(value);
  if (!body) return { status: 400 };
  const at = Date.now();
  if (eng.store.channelMessageSeen(ch.id, body.messageId, iso(at - CHANNEL_DEDUPE_MS))) {
    log.info(`Channel ${ch.id}: a message came again, nothing done`);
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  const base = { id: body.messageId, channelId: ch.id, at: iso(at), sender: body.name };
  const record = (message: ChannelMessage, itemId?: string) => {
    eng.store.addChannelMessage({ rid: randomUUID(), message, ...(body.threadId ? { outsideThreadId: body.threadId } : {}), ...(itemId ? { itemId } : {}) });
    emitChannelMessage(eng, message);
  };
  if (!ch.allowedSenders.includes(body.email)) {
    // Never who: the log says only that someone was refused.
    log.info(`Channel ${ch.id}: a writer was refused`);
    record({ ...base, status: "refused", note: "The writer is not on the list of who may write here" });
    return { status: 200, body: { ok: true, refused: true } };
  }
  const route = matchRoute(
    ch.routes.filter((r) => eng.bots.has(r.botId)),
    body.mentions,
    body.text,
  );
  if (!route) {
    log.info(`Channel ${ch.id}: no tag matched a bot`);
    record({ ...base, status: "ignored", note: "No tag in the message reaches a bot here" });
    return { status: 200, body: { ok: true, ignored: true } };
  }
  if (!eng.harnessReady(eng.bots.get(route.botId)!) || eng.stopping) {
    // Nothing is recorded, so the flow can send it again later.
    log.warn(`Channel ${ch.id}: a message came while Claude is not ready, refused it for now`);
    return { status: 503 };
  }
  const rt = eng.bots.get(route.botId)!;
  const context = cutContext(body.context, ch.contextCount);
  // A reply to a post a bot wrote: the incoming flow leaves the bot's post out, so it is put first here.
  const post = ch.contextCount > 0 ? postAsContext(eng, ch, body.threadId, route.botId) : undefined;
  if (post) context.unshift(...cutContext([post], 1));
  const itemId = randomUUID();
  record({ ...base, tag: route.tag, botId: route.botId, status: "delivered", note: firstWords(body.text) }, itemId);
  eng.enqueue(
    rt,
    cutMessage(body.text),
    { type: "channel", channelId: ch.id, label: ch.name, sender: body.name, tag: route.tag, messageId: body.messageId, ...(context.length ? { context } : {}) },
    { itemId },
  );
  log.info(`Channel ${ch.id}: a message was delivered to bot ${rt.folder.id}`);
  return { status: 202, messageId: body.messageId };
}

/** A turn that a channel message started ended: post the answer, or say why there is none. */
export function finishChannelTurn(eng: Engine, rt: BotRuntime, turn: Turn, interrupted: boolean, failed: boolean): void {
  const row = turn.channelRid ? eng.store.getChannelMessage(turn.channelRid) : undefined;
  if (!row || row.message.status !== "delivered") return;
  const ch = eng.store.getChannel(row.message.channelId);
  const label = ch?.name ?? (rt.current?.from.type === "channel" ? rt.current.from.label : "the channel");
  const m: ChannelMessage = { ...row.message, turnId: turn.id };
  const say = (text: string, tone: "info" | "error") => channelNotice(eng, rt, turn.id, text, tone);
  if (interrupted || failed) {
    const note = interrupted ? "The bot was stopped before it answered" : `The bot ran into a problem and did not answer${turn.errorText ? `: ${firstWords(turn.errorText, 100)}` : ""}`;
    saveChannelMessage(eng, row.rid, { ...m, status: "reply-failed", note });
    say(`Nothing was posted in ${label}, because the turn did not finish`, "error");
    return;
  }
  if (!ch) {
    saveChannelMessage(eng, row.rid, { ...m, status: "reply-failed", note: "The channel was removed before the answer could be posted" });
    say(`The answer could not be posted in ${label}, because the channel was removed`, "error");
    return;
  }
  const answer = turn.lastText.trim();
  if (isNoReply(answer)) {
    saveChannelMessage(eng, row.rid, { ...m, status: "unanswered" });
    say(`Nothing was posted in ${label}`, "info");
    return;
  }
  if (!ch.replyUrl) {
    saveChannelMessage(eng, row.rid, { ...m, status: "unanswered", note: "No reply address is set for this channel" });
    say(`Nothing was posted in ${label}, because no address for answers is set`, "info");
    return;
  }
  const body = replyBody({ channelId: ch.id, messageId: m.id, threadId: row.outsideThreadId, bot: rt.folder.file.name, text: answer });
  const posting = postReply(eng, ch.replyUrl, body)
    .then((why) => {
      if (!eng.store.isOpen) return;
      const name = eng.store.getChannel(ch.id)?.name ?? label;
      if (why) {
        log.warn(`Channel ${ch.id}: the answer could not be posted (${why})`);
        saveChannelMessage(eng, row.rid, { ...m, status: "reply-failed", note: why });
        say(`The answer could not be posted in ${name}`, "error");
      } else {
        log.info(`Channel ${ch.id}: the answer was posted`);
        saveChannelMessage(eng, row.rid, { ...m, status: "answered" });
        say(`Answered in ${name}`, "info");
      }
    })
    .catch((err) => log.error(`Channel ${ch.id}: could not record the answer`, err))
    .finally(() => eng.replies.delete(posting));
  eng.replies.add(posting);
}

/**
 * Posts an answer. Tries once more after 5 seconds on a network error or a 5xx. Returns a plain
 * note when it could not be posted. The address is never logged or put in a note.
 */
export async function postReply(eng: Engine, url: string, body: ReturnType<typeof replyBody>): Promise<string | undefined> {
  const once = async (): Promise<{ why?: string; again: boolean }> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(eng.replyTimeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { again: false };
      return { why: `The answer flow said no (status ${res.status}). Check that the flow that posts answers is switched on and that the address for answers is its current one`, again: res.status >= 500 };
    } catch (err) {
      const late = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const secs = Math.max(1, Math.round(eng.replyTimeoutMs / 1000));
      return { why: late ? `The address for answers did not answer within ${secs} second${secs === 1 ? "" : "s"}` : "The address for answers could not be reached", again: true };
    }
  };
  const first = await once();
  if (!first.why || !first.again || eng.stopping) return first.why;
  await new Promise((r) => setTimeout(r, eng.replyRetryMs));
  if (eng.stopping) return first.why;
  return (await once()).why;
}

/** A quiet line in the bot's main chat after a channel turn, with that turn's id. */
export function channelNotice(eng: Engine, rt: BotRuntime, turnId: string, text: string, tone: "info" | "error"): void {
  if (!eng.store.isOpen) return;
  const item = eng.store.addItem(rt.threadId, { kind: "notice", at: now(), text, tone, turnId });
  eng.opts.emit("item.upsert", { item });
}

/** Waits until every answer being posted has been posted or has failed. For tests. */
export async function repliesSent(eng: Engine): Promise<void> {
  while (eng.replies.size) await Promise.all([...eng.replies]);
}

/** After a turn the harness began, the channel that started it all gets the last message too. */
export function postFollowUp(eng: Engine, rt: BotRuntime, turn: Turn): void {
  const row = turn.channelRid ? eng.store.getChannelMessage(turn.channelRid) : undefined;
  const ch = row ? eng.store.getChannel(row.message.channelId) : undefined;
  const answer = turn.lastText.trim();
  if (!row || !ch || !answer || isNoReply(answer)) return;
  const say = (text: string, tone: "info" | "error") => channelNotice(eng, rt, turn.id, text, tone);
  if (!ch.replyUrl) {
    say(`Nothing was posted in ${ch.name}, because no address for answers is set`, "info");
    return;
  }
  const body = replyBody({ channelId: ch.id, messageId: row.message.id, threadId: row.outsideThreadId, bot: rt.folder.file.name, text: answer });
  const posting = postReply(eng, ch.replyUrl, body)
    .then((why) => {
      if (!eng.store.isOpen) return;
      const name = eng.store.getChannel(ch.id)?.name ?? ch.name;
      if (why) {
        log.warn(`Channel ${ch.id}: a later answer could not be posted (${why})`);
        say(`The answer could not be posted in ${name}`, "error");
      } else {
        log.info(`Channel ${ch.id}: a later answer was posted`);
        say(`Answered in ${name}`, "info");
      }
    })
    .catch((err) => log.error(`Channel ${ch.id}: could not record a later answer`, err))
    .finally(() => eng.replies.delete(posting));
  eng.replies.add(posting);
}
