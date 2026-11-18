// Channels: the bots' own tools (list), and the main bot's changes: tags, settings, a new channel, a
// new address. They happen at once and the person gets a quiet line (docs/build/step-main-bot-tools.md). No
// address ever passes through a tool: the person finds it on the channel's page in the window.
import type { Engine } from "../engine.js";
import type { ChannelRow } from "../store.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem, type UpdateChannelArgs } from "../team.js";
import type { BotRuntime } from "./runtime.js";
import { cleanChannelName, cleanContextCount, cleanRoutes, cleanSenders, cleanTag, tagKey } from "../channels.js";
import type { ChannelRoute, Methods } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { noteChange } from "./notes.js";
import { mayPostIds, postWordsFor } from "./channel-posts.js";

/** A channel by id or by name (any case). */
export function findChannel(eng: Engine, ref: string): ChannelRow | undefined {
  const r = ref.trim();
  const all = eng.store.listChannels();
  return all.find((c) => c.id === r) ?? all.find((c) => c.name.toLowerCase() === r.toLowerCase());
}

export function noChannel(eng: Engine, ref: string): ToolResult {
  return problem(`There is no channel called ${ref}. Use list_channels to see them, or update_channel with create to make one.`);
}

/** Where the person finds a channel's address in the window. */
const ADDRESS_PLACE = (name: string) => `The person finds its address in Pobots: Channels in the list on the left, ${name}, under Address. It never comes to you.`;

export function listChannelsFor(eng: Engine, rt: BotRuntime): string {
  const rows = eng.store.listChannels();
  if (rt.folder.file.role !== "main") {
    const mine = rows
      .map((ch) => ({ ch, tags: ch.routes.filter((r) => r.botId === rt.folder.id).map((r) => r.tag) }))
      .filter((x) => x.tags.length);
    const posts = postWordsFor(eng, rt);
    if (!mine.length) return `You cannot be reached in any channel yet. The main bot or the person can give you a tag in one.\n${posts}`;
    return [
      "You can be reached in these channels. A message there that tags you, from someone allowed to write there, is an instruction to you.",
      ...mine.map(
        ({ ch, tags }) =>
          `- ${ch.name} (Teams channel, ${ch.enabled ? "on" : "off"}). Your ${tags.length === 1 ? "tag" : "tags"} here: ${tags.join(", ")}.${ch.replyUrl ? " Your answers are posted back there." : " Answers cannot be posted back there yet."}`,
      ),
      posts,
    ].join("\n");
  }
  if (!rows.length) return "There are no channels yet. Make one with update_channel and create, or the person does in the app.";
  return rows
    .map((ch) => {
      const routes = ch.routes.filter((r) => eng.bots.has(r.botId));
      const tags = routes.length ? routes.map((r) => `${r.tag} reaches ${eng.nameOf(r.botId)}`).join("; ") : "none yet";
      const writers = ch.allowedSenders.length ? ch.allowedSenders.join(", ") : "nobody yet, so every message is refused";
      return [
        `- ${ch.name} (id ${ch.id}, Teams channel, ${ch.enabled ? "on" : "off"}).`,
        `Who may write: ${writers}.`,
        `Tags: ${tags}.`,
        `Background: up to ${ch.contextCount} earlier message${ch.contextCount === 1 ? "" : "s"}.`,
        `Answers: ${ch.replyUrl ? "posted back in the channel" : "no address for answers is set, so nothing is posted back"}.`,
        `May post on their own: ${mayPostIds(eng, ch).map((id) => eng.nameOf(id)).join(", ") || "no bot"}.`,
      ].join(" ");
    })
    .join("\n");
}

const noteTitle = (ch: { name: string }) => `Channel ${ch.name}`;

/** set_channel_route: a tag reaches a bot in a channel, at once. */
export function setRouteFor(eng: Engine, rt: BotRuntime, args: { channel: string; tag: string; bot: string }): ToolResult {
  const ch = findChannel(eng, args.channel);
  if (!ch) return noChannel(eng, args.channel);
  const tag = cleanTag(args.tag);
  if (!tag) return problem("The tag is empty.");
  const target = eng.findBot(args.bot);
  if (!target) return problem(`There is no bot called ${args.bot}. Use list_bots to see the others.`);
  const name = target.folder.file.name;
  const live = ch.routes.filter((r) => eng.bots.has(r.botId));
  const existing = live.find((r) => tagKey(r.tag) === tagKey(tag));
  if (existing?.botId === target.folder.id) return problem(`The tag ${existing.tag} already reaches ${name} in ${ch.name}, so nothing would change.`);
  const i = live.findIndex((r) => tagKey(r.tag) === tagKey(tag));
  const route: ChannelRoute = { tag, botId: target.folder.id };
  const routes = i < 0 ? [...live, route] : live.map((r, j) => (j === i ? route : r));
  try {
    cleanRoutes(routes, (id) => eng.bots.has(id));
    const saved = eng.saveChannel({ channel: { id: ch.id, routes } });
    noteChange(eng, rt, `channel:${ch.id}`, noteTitle(ch), [`the tag ${tag} reaches ${name}${existing ? ` (was ${eng.nameOf(existing.botId)})` : " (was no bot)"}`]);
    return ok(`Done. In ${saved.name}, the tag ${tag} now reaches ${name}. The person has a note about it.`);
  } catch (err) {
    return problem(err instanceof Error ? err.message : "The change could not be made.");
  }
}

/** remove_channel_route: a tag reaches no bot any more, at once. */
export function removeRouteFor(eng: Engine, rt: BotRuntime, args: { channel: string; tag: string }): ToolResult {
  const ch = findChannel(eng, args.channel);
  if (!ch) return noChannel(eng, args.channel);
  const tag = cleanTag(args.tag);
  const existing = ch.routes.find((r) => eng.bots.has(r.botId) && tagKey(r.tag) === tagKey(tag));
  if (!existing) return problem(`There is no tag ${tag || args.tag} in ${ch.name}. Use list_channels to see the tags.`);
  const routes = ch.routes.filter((r) => eng.bots.has(r.botId) && tagKey(r.tag) !== tagKey(existing.tag));
  const saved = eng.saveChannel({ channel: { id: ch.id, routes } });
  noteChange(eng, rt, `channel:${ch.id}`, noteTitle(ch), [`the tag ${existing.tag} reaches no bot (was ${eng.nameOf(existing.botId)})`]);
  return ok(`Done. The tag ${existing.tag} reaches no bot in ${saved.name} any more. The person has a note about it.`);
}

/** update_channel: changes a channel, makes one (create), or gives one a new address. At once, with a quiet line. */
export function changeChannelFor(eng: Engine, rt: BotRuntime, args: UpdateChannelArgs): ToolResult {
  if (args.create) return createChannelFor(eng, rt, args);
  const ch = findChannel(eng, args.channel);
  if (!ch) return noChannel(eng, args.channel);
  const patch: Methods["channel.save"]["params"]["channel"] = { id: ch.id };
  const lines: string[] = [];
  const onOff = (b: boolean) => (b ? "on" : "off");
  try {
    if (args.name !== undefined) {
      const n = cleanChannelName(args.name);
      if (n !== ch.name) {
        patch.name = n;
        lines.push(`name ${n} (was ${ch.name})`);
      }
    }
    if (args.allowed_senders !== undefined) {
      const list = cleanSenders(args.allowed_senders);
      const added = list.filter((e) => !ch.allowedSenders.includes(e));
      const removed = ch.allowedSenders.filter((e) => !list.includes(e));
      if (added.length || removed.length) {
        patch.allowedSenders = list;
        if (added.length) lines.push(`${added.join(", ")} may write now`);
        if (removed.length) lines.push(`${removed.join(", ")} may no longer write`);
      }
    }
    if (args.context_count !== undefined) {
      const n = cleanContextCount(args.context_count);
      if (n !== ch.contextCount) {
        patch.contextCount = n;
        lines.push(`background ${n} earlier message${n === 1 ? "" : "s"} (was ${ch.contextCount})`);
      }
    }
    if (args.enabled !== undefined && args.enabled !== ch.enabled) {
      patch.enabled = args.enabled;
      lines.push(`switched ${onOff(args.enabled)} (was ${onOff(ch.enabled)})`);
    }
    if (args.may_post !== undefined) {
      const ids: string[] = [];
      for (const ref of args.may_post) {
        const b = eng.findBot(ref);
        if (!b) return problem(`There is no bot called ${ref}. Use list_bots to see the bots.`);
        if (!ids.includes(b.folder.id)) ids.push(b.folder.id);
      }
      const had = mayPostIds(eng, ch);
      const added = ids.filter((id) => !had.includes(id));
      const removed = had.filter((id) => !ids.includes(id));
      if (added.length || removed.length) {
        patch.mayPost = ids;
        const names = (list: string[]) => list.map((id) => eng.nameOf(id)).join(", ");
        if (added.length) lines.push(`${names(added)} may post on ${added.length === 1 ? "its" : "their"} own now`);
        if (removed.length) lines.push(`${names(removed)} may no longer post on ${removed.length === 1 ? "its" : "their"} own`);
      }
    }
  } catch (err) {
    return problem(err instanceof Error ? err.message : String(err));
  }
  if (!lines.length && !args.new_address) return problem("Nothing would change.");
  try {
    const saved = Object.keys(patch).length > 1 ? eng.saveChannel({ channel: patch }) : eng.getChannel(ch.id);
    let renewed = "";
    if (args.new_address) {
      eng.channelNewAddress(ch.id); // the new address itself is never kept here, nor told
      lines.push("a new address, the old one stopped working");
      renewed = ` It has a new address now; the old one stopped working, so the Power Automate flow needs the new one. ${ADDRESS_PLACE(saved.name)}`;
    }
    noteChange(eng, rt, `channel:${ch.id}`, noteTitle(ch), lines);
    return ok(`Changed the channel ${saved.name}. The person has a note about it.${renewed}`);
  } catch (err) {
    return problem(err instanceof EngineError ? err.message : "The change could not be made.");
  }
}

function createChannelFor(eng: Engine, rt: BotRuntime, args: UpdateChannelArgs): ToolResult {
  if (args.new_address) return problem("A new channel gets its address by itself; leave out new_address.");
  if (args.may_post?.length) return problem("Make the channel first, then say who may post there with may_post: a new channel has no address for answers yet.");
  try {
    const name = cleanChannelName(args.name ?? args.channel);
    if (findChannel(eng, name)) return problem(`There is a channel called ${name} already.`);
    const saved = eng.saveChannel({
      channel: {
        name,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.allowed_senders !== undefined ? { allowedSenders: args.allowed_senders } : {}),
        ...(args.context_count !== undefined ? { contextCount: args.context_count } : {}),
      },
    });
    const writers = saved.allowedSenders.length ? saved.allowedSenders.join(", ") : "nobody yet";
    noteChange(eng, rt, `channel:${saved.id}`, `New channel ${saved.name}`, [`may write: ${writers}`, `background ${saved.contextCount} earlier messages`, saved.enabled ? "on" : "off"]);
    return ok(
      `Made the channel ${saved.name} (id ${saved.id}), ${saved.enabled ? "on" : "off"}. Who may write: ${writers}. The person has a note about it. ${ADDRESS_PLACE(saved.name)} The Power Automate flow posts to it; the address for answers is set there by the person.`,
    );
  } catch (err) {
    return problem(err instanceof Error ? err.message : "The channel could not be made.");
  }
}
