// A bot writes a new post of its own in a channel (engine 0.23.0, docs/build/step-channel-posts.md).
// The right is per channel and per bot, off by default; the person or the main bot switches it on.
// A post goes out through the channel's address for answers with `kind: "post"`, is never retried
// (a post that timed out may be there already), leaves a row in channel_posts and a quiet line in
// the bot's chat. A tagged reply to the post gets it as the first message of its background.
import type { Engine } from "../engine.js";
import type { ChannelRow } from "../store.js";
import type { ChannelPostRow } from "../channel-posts-store.js";
import type { ToolResult } from "../claude/session.js";
import type { ChannelContextMessage } from "../../shared/protocol.js";
import { ok, problem } from "../tool-names.js";
import { EngineError } from "../errors.js";
import { markdownToHtml } from "../channels.js";
import { findChannel, noChannel } from "./channel-tools.js";
import { holdNotice } from "./notes.js";
import type { BotRuntime } from "./runtime.js";
import { iso } from "./words.js";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";

/** At most this many characters in one post. */
export const POST_TEXT_MAX = 4_000;
/** At most this many tries an hour per bot per channel, failed ones too. */
export const POSTS_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;

/** The bots that may post, checked: each must exist, each once. */
export function cleanMayPost(ids: string[], botExists: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !botExists(id)) throw new EngineError("bad_request", "A bot that may post does not exist.");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** What Pobots sends the flow for a new post: no thread, no message to answer. */
export interface PostBody {
  kind: "post";
  channelId: string;
  bot: string;
  text: string;
  html: string;
}

export function postBody(o: { channelId: string; bot: string; text: string }): PostBody {
  return { kind: "post", channelId: o.channelId, bot: o.bot, text: o.text, html: markdownToHtml(o.text) };
}

/** The live bots that may post in a channel. */
export function mayPostIds(eng: Engine, ch: ChannelRow): string[] {
  return ch.mayPost.filter((id) => eng.bots.has(id));
}

/** "in about 12 minutes": when the next try can go, from the oldest of the last hour's tries. */
function nextInWords(eng: Engine, tries: ChannelPostRow[]): string {
  const oldest = tries[tries.length - POSTS_PER_HOUR]!;
  const mins = Math.max(1, Math.ceil((Date.parse(oldest.at) + HOUR_MS - eng.clock()) / 60_000));
  return mins === 1 ? "in about a minute" : `in about ${mins} minutes`;
}

/** What went wrong in sending, for the bot (`why`) and for the chat line (`line`). */
type Sent = { outsideId?: string } | { why: string; line: string; mayBeThere?: boolean };

async function send(eng: Engine, url: string, body: PostBody): Promise<Sent> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(eng.replyTimeoutMs),
    });
    if (res.status >= 200 && res.status < 300) {
      let id: unknown;
      try {
        id = ((await res.json()) as { messageId?: unknown } | null)?.messageId;
      } catch {
        id = undefined;
      }
      return typeof id === "string" && id.trim() && id.length <= 200 ? { outsideId: id.trim() } : {};
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 400) {
      return {
        why: "The flow that posts answers refused the post (status 400). It likely has no branch for new posts yet, so the person needs to update that flow in Power Automate. Nothing was posted.",
        line: "the flow needs its branch for new posts",
      };
    }
    if (res.status >= 500) {
      return {
        why: `The flow could not post it in Teams (status ${res.status}). Ask the person to look at the flow's run history in Power Automate before you try again.`,
        line: "the flow failed. See its run history",
      };
    }
    return {
      why: `The flow said no (status ${res.status}). The flow that posts answers may be off, or the address for answers is not its current one. The person checks the channel's page in Pobots.`,
      line: "the flow said no. Check the address for answers",
    };
  } catch (err) {
    const late = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (late) {
      const secs = Math.max(1, Math.round(eng.replyTimeoutMs / 1000));
      return {
        why: `The flow did not answer within ${secs} second${secs === 1 ? "" : "s"}. The post may still appear in the channel, so do not post it again before the person has checked there.`,
        line: "no answer in time. Check the channel before posting again",
        mayBeThere: true,
      };
    }
    return {
      why: "The address for answers could not be reached, so nothing was posted. Try again later.",
      line: "the flow could not be reached",
    };
  }
}

/** post_to_channel: a new post of the bot's own in a channel, when it has the right. */
export async function postToChannelFor(eng: Engine, rt: BotRuntime, args: { channel: string; text: string }): Promise<ToolResult> {
  const ch = findChannel(eng, args.channel);
  if (!ch) return noChannel(eng, args.channel);
  const me = rt.folder.id;
  if (!ch.mayPost.includes(me))
    return problem(`You may not post on your own in ${ch.name}. The person switches it on for you on the channel's page in Pobots (Posts, May post), or the main bot does.`);
  if (!ch.enabled) return problem(`The channel ${ch.name} is switched off, so nothing can be posted there. The person switches it on in Pobots.`);
  if (!ch.replyUrl) return problem(`No address for answers is set for ${ch.name}, so posts cannot go out yet. The person sets it on the channel's page in Pobots.`);
  const text = args.text.trim();
  if (!text) return problem("The post is empty. Write what to post.");
  if (text.length > POST_TEXT_MAX)
    return problem(`The post is ${text.length.toLocaleString("en-US")} characters long. A post can be at most ${POST_TEXT_MAX.toLocaleString("en-US")} characters: shorten it, or split it into a few posts.`);
  const now = eng.clock();
  const tries = eng.store.posts.triesSince(ch.id, me, iso(now - HOUR_MS));
  if (tries.length >= POSTS_PER_HOUR)
    return problem(
      `You have posted ${POSTS_PER_HOUR} times in ${ch.name} in the last hour, which is the most a bot may (tries that failed count too). The next one can go ${nextInWords(eng, tries)}.`,
    );
  // The row is there before the post goes out, so two calls at once cannot both pass the limit.
  const row: ChannelPostRow = { id: randomUUID(), channelId: ch.id, botId: me, at: iso(now), text, status: "failed", note: "Being sent" };
  eng.store.posts.add(row);
  const sent = await send(eng, ch.replyUrl, postBody({ channelId: ch.id, bot: rt.folder.file.name, text }));
  if (!eng.store.isOpen) return problem("Pobots was closing, so the post's outcome is not known. Do not post it again before the person has checked the channel.");
  const name = eng.store.getChannel(ch.id)?.name ?? ch.name;
  const left = POSTS_PER_HOUR - tries.length - 1;
  if ("why" in sent) {
    eng.store.posts.update({ ...row, status: "failed", note: sent.why });
    log.warn(`Channel ${ch.id}: bot ${me} could not post (${sent.mayBeThere ? "no answer in time" : "refused or unreachable"})`);
    holdNotice(eng, rt, { text: `Could not post in ${name}: ${sent.line}`, tone: "error", detail: text });
    return problem(`${sent.why} You can try ${left} more time${left === 1 ? "" : "s"} in this hour.`);
  }
  eng.store.posts.update({ ...row, status: "posted", ...(sent.outsideId ? { outsideId: sent.outsideId } : {}), note: undefined });
  log.info(`Channel ${ch.id}: bot ${me} posted`);
  holdNotice(eng, rt, { text: `Posted in ${name}`, tone: "info", mark: "posted", detail: text });
  const replies = sent.outsideId
    ? "A tagged reply to it reaches the bot the tag points to, with your post as background."
    : "The flow did not send back the post's id, so a reply to it will not get your post as background.";
  return ok(`Posted in ${name}. ${replies} You can post ${left} more time${left === 1 ? "" : "s"} there in this hour.`);
}

/** The post that started a thread, as the first message of a reply's background, when a bot wrote it. */
export function postAsContext(eng: Engine, ch: ChannelRow, threadId: string | undefined, botId: string): ChannelContextMessage | undefined {
  if (!threadId) return undefined;
  const post = eng.store.posts.byOutsideId(ch.id, threadId);
  if (!post) return undefined;
  const who = post.botId === botId ? "You" : eng.bots.has(post.botId) ? `${eng.nameOf(post.botId)}, a bot in Pobots` : "A bot in Pobots";
  return { from: `${who} (the post that started this thread)`, text: post.text, at: post.at };
}

/** Where a bot that is not the main bot may post, for its own list_channels. */
export function postWordsFor(eng: Engine, rt: BotRuntime): string {
  const rows = eng.store.listChannels().filter((ch) => ch.mayPost.includes(rt.folder.id));
  if (!rows.length) return "You may not write posts of your own in any channel. The person or the main bot can allow it for a channel.";
  return `You may write posts of your own with post_to_channel in: ${rows.map((ch) => `${ch.name}${ch.replyUrl ? "" : " (no address for answers yet, so not now)"}`).join(", ")}. At most ${POSTS_PER_HOUR} an hour in each, up to ${POST_TEXT_MAX.toLocaleString("en-US")} characters each.`;
}
