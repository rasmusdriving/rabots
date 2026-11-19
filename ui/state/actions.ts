// Everything the window asks of the engine goes through here. Each action sends one request and
// puts what comes back into the store; events from the engine do the rest.
import type { ActivityDay, Artifact, Attachment, Bot, BotSees, BrowserInput, BrowserSpace, CardDecision, Channel, FollowUp, HelperItem, Methods, NotifyKind, NotifyState, SettingsPatch, Snapshot, Trigger, TriggerRun, UserItem } from "../../shared/protocol";
import { EngineError, type EngineClient, type EngineEvent, type UploadRequest } from "../engine/types";
import { rememberOpener } from "../lib/opener";
import { openOutside } from "../lib/outside";
import { forgetUpdateReload } from "../lib/update";
import { reloadForNewVersion } from "../lib/pobots-update";
import { isPhone } from "../lib/phone";
import { deeper } from "./phone-view";
import { phoneEntriesLeaving, startScreens } from "./screens";
import { emptyThread, helperStacksBefore, helperStacksOf, historyStateWith, mergeItems, store, type HelperFrame, type HelperStacks } from "./store";

const PAGE = 50;

let client: EngineClient | undefined;

export function connect(engine: EngineClient): void {
  client = engine;
  engine.start({
    ready: (snapshot: Snapshot) => {
      // A public install that updated itself: a page in a browser loads the new build once (engine 0.34.0).
      const was = store.get();
      if (reloadForNewVersion({ version: was.status?.engineVersion, pobots: !!was.providers?.pobots }, snapshot)) return;
      forgetUpdateReload();
      store.snapshot(snapshot);
      // After a reconnect, read again the newest page of every chat the window has open, so
      // anything missed while the connection was down is filled in.
      for (const threadId of Object.keys(store.get().threads)) {
        if (store.thread(threadId).loaded) void readNewest(threadId);
      }
      // What is open in the browser, kept current by "browser.changed" while this connection lives.
      // Looking never opens the browser app.
      void lookAtBrowser();
    },
    event: (e: EngineEvent) => store.event(e),
    connection: (info) => store.connection(info),
  });
  // The browser's back and forward buttons move between helper threads like the back control does.
  // Not while the window steps back over a phone's own entries after it stopped being a phone: what
  // shows stays as it is (state/screens.ts).
  window.addEventListener("popstate", (e) => {
    if (phoneEntriesLeaving(e.state)) return;
    store.setHelperStacks(helperStacksOf(e.state));
  });
  // On a phone each screen is a history entry too (state/screens.ts); on the laptop this only listens.
  startScreens();
}

const engine = (): EngineClient => {
  if (!client) throw new Error("The engine client is not started.");
  return client;
};

export async function readNewest(threadId: string): Promise<void> {
  const t = store.thread(threadId);
  store.putThread(threadId, { ...t, loading: true, error: undefined });
  try {
    const [{ items, hasMore }, queued] = await Promise.all([
      engine().request("thread.read", { threadId, limit: PAGE }),
      // Waiting messages, also older than this page (step 7a).
      engine()
        .request("thread.queued", { threadId })
        .catch(() => ({ items: [] as UserItem[] })),
    ]);
    const now = store.thread(threadId);
    // Keep older pages that were loaded before; only say "more" if this page did not reach them.
    const merged = mergeItems(now.items, items);
    const reachesKnown = now.items.length > 0 && items.length > 0 && now.items[0]!.seq < items[0]!.seq;
    const waiting = queued.items.filter((q) => !merged.some((i) => i.id === q.id));
    store.putThread(threadId, { items: merged, hasMore: reachesKnown ? now.hasMore : hasMore, loading: false, loaded: true, waiting });
  } catch (error) {
    store.putThread(threadId, { ...store.thread(threadId), loading: false, error: (error as Error).message });
  }
}

export async function readOlder(threadId: string): Promise<void> {
  const t = store.thread(threadId);
  if (t.loading || !t.hasMore || t.items.length === 0) return;
  store.putThread(threadId, { ...t, loading: true });
  try {
    const before = t.items[0]!.seq;
    const { items, hasMore } = await engine().request("thread.read", { threadId, before, limit: PAGE });
    const now = store.thread(threadId);
    store.putThread(threadId, { ...now, items: mergeItems(now.items, items), hasMore, loading: false });
  } catch (error) {
    store.putThread(threadId, { ...store.thread(threadId), loading: false, error: (error as Error).message });
  }
}

export function ensureThread(threadId: string): void {
  const t = store.get().threads[threadId] ?? emptyThread;
  if (!t.loaded && !t.loading) void readNewest(threadId);
}

/** `attachments`: ids of uploads made for this bot, in the order they stand in the box. */
/**
 * Sends a message. `mode` is the person's choice for this one message while the bot works (steer it
 * into the turn, or let it wait); left out, the engine uses the setting.
 */
export async function sendMessage(botId: string, text: string, attachments: string[] = [], mode?: FollowUp): Promise<void> {
  const { item } = await engine().request("message.send", { botId, text, ...(attachments.length ? { attachments } : {}), ...(mode ? { mode } : {}) });
  const t = store.thread(item.threadId);
  // The engine sent the message as an event before it answered, and a turn it started at once has
  // already given it its turn id: the answer is the older copy, so the one here stays (engine 0.31.2).
  if (t.items.some((i) => i.id === item.id)) return;
  store.putThread(item.threadId, { ...t, items: mergeItems(t.items, [item]) });
}

/** How long a send whose answer was lost waits for the connection to come back before it is given back. */
const SEND_LOST_WAIT_MS = 20_000;

/** Resolves true once the connection is ready, or false after `ms`. */
function connectionReady(ms: number): Promise<boolean> {
  if (store.get().connection.phase === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      off();
      resolve(ok);
    };
    const off = store.subscribe(() => {
      if (store.get().connection.phase === "ready") done(true);
    });
    const timer = setTimeout(() => done(false), ms);
  });
}

/**
 * A send whose answer never came (the connection dropped, or no answer in time) may still have been
 * stored by the engine. Once the connection is back, the chat's newest page is read again: true when
 * a message from the person there holds every one of these attachments, so the window can treat the
 * message as sent instead of offering a retry the engine would refuse (the uploads are not waiting
 * any more). False when it is not there, or the connection did not come back in time.
 */
export async function sentAfterAll(threadId: string, attachmentIds: string[]): Promise<boolean> {
  if (attachmentIds.length === 0) return false;
  if (!(await connectionReady(SEND_LOST_WAIT_MS))) return false;
  await readNewest(threadId);
  return store.thread(threadId).items.some((i) => i.kind === "user" && i.from.type === "you" && attachmentIds.every((id) => i.attachments?.some((a) => a.id === id)));
}

// ------------------------------------------------------------ pictures and files

/** Whether this window can send pictures and files. */
export const canUpload = (): boolean => !!client?.upload;

/** Sends one file's bytes to the engine, ahead of the message that will carry it. */
export function uploadFile(request: UploadRequest): Promise<Attachment> {
  const c = engine();
  if (!c.upload) return Promise.reject(new Error("This window cannot upload files."));
  return c.upload(request);
}

/** Throws away an upload that will not be sent. Quiet: an upload that is already gone is fine. */
export async function discardAttachment(id: string): Promise<void> {
  try {
    await engine().request("attachment.discard", { id });
  } catch {
    // Unsent uploads older than a day are removed by the engine anyway.
  }
}

/** The address of a sent picture's preview, or of the file itself. */
export const attachmentUrl = (id: string, which: "preview" | "full" | "download"): string | undefined => client?.attachmentUrl(id, which);

export async function interrupt(botId: string): Promise<void> {
  await engine().request("turn.interrupt", { botId });
}

/** Stops one helper. Its row turns "Stopped" when the engine says so, by an "item.upsert". */
export async function stopHelper(botId: string, itemId: string): Promise<void> {
  await engine().request("helper.stop", { botId, itemId });
}

/** Task managers (protocol 21): the person writes to one in its thread, stops what it does, or ends it. */
export async function sendToManager(botId: string, managerId: string, text: string): Promise<void> {
  await engine().request("taskManager.send", { botId, managerId, text });
}
export async function stopManager(botId: string, managerId: string): Promise<void> {
  await engine().request("taskManager.stop", { botId, managerId });
}
export async function endManager(botId: string, managerId: string): Promise<void> {
  await engine().request("taskManager.end", { botId, managerId });
}

// ------------------------------------------------------------ helper threads
// A helper's thread opens in the place of the bot's chat. Each opening is a history entry, so the
// browser's back button goes one level up, and a reload keeps the thread open (history.state survives it).

const sameStacks = (a: HelperStacks | null, b: HelperStacks) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** Opens the thread of a helper whose row stands in `threadId`, one level further in its bot's chat. */
export function openHelper(item: Pick<HelperItem, "id" | "botId" | "threadId" | "helperThreadId" | "title" | "status">): void {
  const botId = item.botId;
  const now = store.get().helpers;
  const stack = now[botId] ?? [];
  const toChat = () => {
    if ((store.get().tabs[botId] ?? "chat") !== "chat") store.setTab(botId, "chat");
  };
  // Already open (from "Helpers at work", say, while another of the bot's tabs shows): only back to the chat tab.
  if (stack.at(-1)?.itemId === item.id) return toChat();
  const frame: HelperFrame = { botId, itemId: item.id, threadId: item.threadId, helperThreadId: item.helperThreadId, title: item.title, status: item.status };
  // A row inside an open helper's thread goes one level deeper; any other row starts from the chat.
  const at = stack.findIndex((f) => f.helperThreadId === item.threadId);
  const next: HelperStacks = { ...now, [botId]: [...(at >= 0 ? stack.slice(0, at + 1) : []), frame] };
  try {
    // On a phone the entry also counts how deep it stands (state/phone-view.ts).
    history.pushState(isPhone() ? deeper(historyStateWith(next, now), history.state) : historyStateWith(next, now), "");
  } catch {
    // Without history the back control still works; only the browser's own button does not.
  }
  store.setHelperStacks(next);
  toChat();
}

/** Goes one level up from the open helper thread of this bot: to the helper above it, or to the chat. */
export function helperBack(botId: string): void {
  const now = store.get().helpers;
  const stack = now[botId] ?? [];
  if (stack.length === 0) return;
  const next: HelperStacks = { ...now, [botId]: stack.slice(0, -1) };
  if (next[botId]!.length === 0) delete next[botId];
  let entry: unknown = null;
  try {
    entry = history.state;
  } catch {
    entry = null;
  }
  // When this history entry was pushed by opening exactly this thread, going back is the browser's
  // back, so the two never disagree. Otherwise (another bot's thread opened since, say) the entry is
  // rewritten in place.
  if (sameStacks(helperStacksOf(entry), now) && sameStacks(helperStacksBefore(entry), next)) {
    store.setHelperStacks(next);
    try {
      history.back();
    } catch {
      // The store already holds the right thing.
    }
    return;
  }
  try {
    history.replaceState(historyStateWith(next), "");
  } catch {
    // As above.
  }
  store.setHelperStacks(next);
}

/**
 * Asks for a fresh session now: the bot first writes down what matters, then its next turn starts
 * fresh. `started` is false when there is nothing to tidy yet. The rest arrives as events.
 */
export async function startFresh(botId: string): Promise<boolean> {
  const { started } = await engine().request("bot.startFresh", { botId });
  return started;
}

export async function updateBot(botId: string, patch: Methods["bot.update"]["params"]["patch"]): Promise<Bot> {
  const { bot } = await engine().request("bot.update", { botId, patch });
  store.putBot(bot);
  return bot;
}

export async function createBot(params: Methods["bot.create"]["params"]): Promise<Bot> {
  const { bot } = await engine().request("bot.create", params);
  store.event({ event: "bot.added", data: { bot } });
  store.openBot(bot.id);
  store.setTab(bot.id, "chat");
  return bot;
}

export async function setBotVacation(botId: string, vacation: boolean, stop?: boolean): Promise<void> {
  const { bot } = await engine().request("bot.vacation", { botId, vacation, ...(stop ? { stop } : {}) });
  store.putBot(bot);
}

export async function retireBot(botId: string): Promise<void> {
  await engine().request("bot.retire", { botId });
  // The engine also sends "bot.removed"; applying it here keeps the window quick.
  store.event({ event: "bot.removed", data: { botId } });
}

// ------------------------------------------------------------ a bot's files, history and rules
// These are read on demand by the views that show them and are not kept in the store.

export const listFiles = (botId: string) => engine().request("bot.files", { botId }).then((r) => r.files);
export const readFile = (botId: string, path: string) => engine().request("bot.file.read", { botId, path });
export const writeFile = (botId: string, path: string, text: string, baseRev?: string) =>
  engine().request("bot.file.write", baseRev === undefined ? { botId, path, text } : { botId, path, text, baseRev });
export const deleteFile = (botId: string, path: string) => engine().request("bot.file.delete", { botId, path });
export const readHistory = (botId: string, before?: string) =>
  engine().request("bot.history", before === undefined ? { botId, limit: 20 } : { botId, before, limit: 20 });
export const readChange = (botId: string, changeId: string) => engine().request("bot.history.read", { botId, changeId });
export const undoChange = (botId: string, changeId: string) => engine().request("bot.history.undo", { botId, changeId });
export const listRules = (botId: string) => engine().request("rule.list", { botId }).then((r) => r.rules);
export const forgetRule = (ruleId: string) => engine().request("rule.remove", { ruleId });

// ------------------------------------------------------------ triggers and their runs
// Kept in the store, so the Triggers tab, the chat and the rail agree and events keep them current.

const RUNS_PAGE = 20;

export async function loadTriggers(botId: string): Promise<void> {
  const { triggers } = await engine().request("trigger.list", { botId });
  store.setTriggers(botId, triggers);
}

/** Reads a bot's triggers once; events keep them current after that. */
export function ensureTriggers(botId: string): void {
  if (!store.get().triggers[botId]) void loadTriggers(botId).catch(() => undefined);
}

export async function saveTrigger(botId: string, trigger: Methods["trigger.save"]["params"]["trigger"]): Promise<Trigger> {
  const r = await engine().request("trigger.save", { botId, trigger });
  store.putTrigger(r.trigger);
  return r.trigger;
}

/** Switches a trigger on or off without touching anything else about it. */
export async function setTriggerOn(t: Trigger, enabled: boolean): Promise<Trigger> {
  const r = await engine().request("trigger.enable", { triggerId: t.id, enabled });
  store.putTrigger(r.trigger);
  return r.trigger;
}

export async function removeTrigger(t: Trigger): Promise<void> {
  await engine().request("trigger.remove", { triggerId: t.id });
  store.event({ event: "trigger.changed", data: { botId: t.botId, removedId: t.id } });
}

export async function runTriggerNow(triggerId: string): Promise<TriggerRun> {
  const { run } = await engine().request("trigger.run", { triggerId });
  store.putRun(run);
  return run;
}

/** An address as the engine hands it out. Works like a password: asked for only when shown, never kept in the store. */
export type HookAddress = Methods["trigger.address"]["result"];

export const hookAddress = (triggerId: string): Promise<HookAddress> => engine().request("trigger.address", { triggerId });
export const newHookAddress = (triggerId: string): Promise<HookAddress> => engine().request("trigger.newAddress", { triggerId });

export async function loadRuns(triggerId: string): Promise<void> {
  const r = await engine().request("trigger.runs", { triggerId, limit: RUNS_PAGE });
  const now = store.get().runs[triggerId];
  // Runs that arrived by event while reading stay; the page fills in the rest.
  const byId = new Map((now?.runs ?? []).map((x) => [x.id, x]));
  for (const run of r.runs) if (!byId.has(run.id)) byId.set(run.id, run);
  store.setRuns(triggerId, { runs: [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)), hasMore: r.hasMore, loaded: true });
}

export async function loadOlderRuns(triggerId: string): Promise<void> {
  const now = store.get().runs[triggerId];
  const last = now?.runs[now.runs.length - 1];
  if (!now || !last || !now.hasMore) return;
  const r = await engine().request("trigger.runs", { triggerId, before: last.id, limit: RUNS_PAGE });
  const fresh = store.get().runs[triggerId] ?? now;
  const known = new Set(fresh.runs.map((x) => x.id));
  store.setRuns(triggerId, { runs: [...fresh.runs, ...r.runs.filter((x) => !known.has(x.id))], hasMore: r.hasMore, loaded: true });
}

// ------------------------------------------------------------ channels
// The channels come with the snapshot and "channel.changed" keeps them current. What came in on a
// channel is read when its page opens and kept current by "channel.message".

const CHANNEL_PAGE = 20;

export async function saveChannel(channel: Methods["channel.save"]["params"]["channel"]): Promise<Channel> {
  const r = await engine().request("channel.save", { channel });
  store.putChannel(r.channel);
  return r.channel;
}

/** Makes a channel and opens its page. */
export async function createChannel(name: string): Promise<Channel> {
  const channel = await saveChannel({ name });
  store.openChannel(channel.id);
  return channel;
}

export async function removeChannel(channelId: string): Promise<void> {
  await engine().request("channel.remove", { channelId });
  store.event({ event: "channel.changed", data: { removedId: channelId } });
}

export const channelAddress = (channelId: string): Promise<HookAddress> => engine().request("channel.address", { channelId });
export const newChannelAddress = (channelId: string): Promise<HookAddress> => engine().request("channel.newAddress", { channelId });

export async function loadChannelMessages(channelId: string): Promise<void> {
  const r = await engine().request("channel.messages", { channelId, limit: CHANNEL_PAGE });
  const now = store.get().channelMessages[channelId];
  // Messages that arrived by event while reading are newer than the page; keep them.
  const byId = new Map((now?.messages ?? []).map((m) => [m.id, m]));
  for (const m of r.messages) if (!byId.has(m.id)) byId.set(m.id, m);
  store.setChannelMessages(channelId, { messages: [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)), hasMore: r.hasMore, loaded: true });
}

export async function loadOlderChannelMessages(channelId: string): Promise<void> {
  const now = store.get().channelMessages[channelId];
  const last = now?.messages[now.messages.length - 1];
  if (!now || !last || !now.hasMore) return;
  const r = await engine().request("channel.messages", { channelId, before: last.id, limit: CHANNEL_PAGE });
  const fresh = store.get().channelMessages[channelId] ?? now;
  const known = new Set(fresh.messages.map((m) => m.id));
  store.setChannelMessages(channelId, { messages: [...fresh.messages, ...r.messages.filter((m) => !known.has(m.id))], hasMore: r.hasMore, loaded: true });
}

// ------------------------------------------------------------ artifacts
// A bot's artifacts are read when its chat or its Artifacts tab first needs them; "artifact.changed"
// keeps them current. Where a page can be shown is asked for each time it is loaded, never kept.

const artifactReads = new Set<string>();

export async function loadArtifacts(botId: string): Promise<void> {
  const { artifacts } = await engine().request("artifact.list", { botId });
  store.setArtifacts(botId, artifacts);
}

/** Reads a bot's artifacts once; events keep them current after that. */
export function ensureArtifacts(botId: string): void {
  if (store.get().artifacts[botId] || artifactReads.has(botId)) return;
  artifactReads.add(botId);
  void loadArtifacts(botId).catch(() => artifactReads.delete(botId));
}

/**
 * Where a page can be shown right now, as the engine hands it out (a path on its own origin, or a
 * full address for the desktop window). An artifact the engine no longer knows is forgotten, so its
 * rows stay as lines.
 */
export async function artifactSource(botId: string, artifactId: string): Promise<Methods["artifact.open"]["result"]> {
  try {
    return await engine().request("artifact.open", { botId, artifactId });
  } catch (e) {
    if (e instanceof EngineError && e.code === "not_found") store.forgetArtifact(botId, artifactId);
    throw e;
  }
}

/** Takes an artifact off its bot's list. The file stays in the bot's folder, a page on Claude stays on Claude. */
export async function removeArtifact(botId: string, artifactId: string): Promise<void> {
  await engine().request("artifact.remove", { botId, artifactId });
  store.event({ event: "artifact.changed", data: { botId, removedId: artifactId } });
}

/** Opens a "page" in the panel beside the chat, swapping what the panel showed. */
export function openArtifactPanel(a: Artifact): void {
  rememberOpener();
  const now = store.get().panel;
  store.setPanel({ kind: "artifact", botId: a.botId, artifactId: a.id, full: now?.kind === "artifact" && now.botId === a.botId ? now.full : now?.kind === "browser" ? now.full : false });
}

/** Opens an artifact that lives on Claude in a window of its own beside Pobots, or offers its link when the browser blocks the window. */
export function openOnClaude(url: string, title: string): void {
  if (!openOutside(url)) store.setBlockedLink({ url, title });
}

/**
 * Opens an artifact from its row or the list: a "page" beside the chat, a "link" on Claude in a window
 * of its own (step 2g, third round: never in the browser panel by itself; the person may still type
 * any address in "Your page").
 */
export function openArtifact(a: Artifact): void {
  if (a.kind === "link") {
    if (a.url) openOnClaude(a.url, a.title);
    return;
  }
  if (a.available) openArtifactPanel(a);
}

// ------------------------------------------------------------ the browser (step 2g)
// The bots' browser on the engine's machine. The state comes with the snapshot and "browser.changed";
// pictures come as "browser.frame" events, straight to the panel (see onBrowserFeed in the store).

/** Asks what is open in the browser now, and to be told of changes while this connection lives. */
export async function lookAtBrowser(): Promise<void> {
  try {
    store.setBrowser(await engine().request("browser.state", {}));
  } catch {
    // The snapshot's copy stays; "browser.changed" brings the next one.
  }
}

/** Opens the browser panel on a workspace, swapping what the panel showed. Remembers what had the focus. */
export function openBrowserPanel(spaceId: string): void {
  rememberOpener();
  const now = store.get().panel;
  store.setPanel({ kind: "browser", spaceId, full: now?.full ?? false });
}

/** The person's own workspace ("Your page"), made when missing; with a url its front page goes there. Opens it in the panel. */
export async function openOwnPage(url?: string): Promise<BrowserSpace> {
  const { space } = await engine().request("browser.own", url ? { url } : {});
  store.putBrowserSpace(space);
  const now = store.get().panel;
  store.setPanel({ kind: "browser", spaceId: space.id, full: now?.full ?? false });
  return space;
}

/**
 * Where the roster's "Browser" line opens: the workspace of the open bot when it has one, else the
 * newest bot workspace, else the person's own (made on demand).
 */
export function openBrowserFromRoster(): void {
  const s = store.get();
  const spaces = s.browser.spaces;
  const open = s.openChannelId ? undefined : s.openBotId;
  const mine = open ? spaces.filter((x) => x.owner === "bot" && x.botId === open) : [];
  const bots = spaces.filter((x) => x.owner === "bot");
  const pick = mine.at(-1) ?? bots.at(-1) ?? spaces.find((x) => x.owner === "you");
  if (pick) return openBrowserPanel(pick.id);
  rememberOpener();
  void openOwnPage().catch(() => undefined);
}

export const watchBrowser = (spaceId: string, pageId?: string, ratio?: number) => engine().request("browser.watch", { spaceId, ...(pageId ? { pageId } : {}), ...(ratio ? { ratio } : {}) });
/** How sharp the pictures need to be: screen pixels per page pixel where the panel draws them. */
export const viewBrowser = (watchId: string, ratio: number) => engine().request("browser.view", { watchId, ratio });
/** Shows a page of the watched workspace (none: the page in front in the browser). */
export const showBrowserPage = (watchId: string, pageId?: string) => engine().request("browser.page.show", pageId ? { watchId, pageId } : { watchId });
export const openBrowserPage = (watchId: string, url?: string) => engine().request("browser.page.open", url ? { watchId, url } : { watchId });
export const closeBrowserPage = (watchId: string, pageId: string) => engine().request("browser.page.close", { watchId, pageId });
export const unwatchBrowser = (watchId: string) => engine().request("browser.unwatch", { watchId });
export const controlBrowser = (watchId: string, take: boolean) => engine().request("browser.control", { watchId, take });
export const sendBrowserInput = (watchId: string, events: BrowserInput[]) => engine().request("browser.input", { watchId, events });
export const browserGo = (watchId: string, to: Methods["browser.go"]["params"]["to"]) => engine().request("browser.go", { watchId, to });
export const browserSelection = (watchId: string) => engine().request("browser.selection", { watchId }).then((r) => r.text);
export const answerBrowser = (watchId: string, answer: Methods["browser.answer"]["params"]["answer"]) => engine().request("browser.answer", { watchId, answer });
export const closeOwnPage = (spaceId: string) => engine().request("browser.close", { spaceId });

/** The message that asks the bot to publish an artifact. The bot does it in its chat, as asked. */
export const publishMessage = (title: string): string => `Publish the artifact "${title}" to Claude and give me the link.`;

export async function resolveCard(cardId: string, decision: CardDecision): Promise<void> {
  await engine().request("card.resolve", { cardId, decision });
  // The engine also sends "card.removed"; removing it here as well keeps the rail quick.
  store.event({ event: "card.removed", data: { cardId, reason: "resolved" } });
}

// ------------------------------------------------------------ the nightly backup

/** Saves the 1Password reference, never the password. */
export function setConnection(change: Methods["connection.set"]["params"]) {
  return engine().request("connection.set", change);
}

export async function setBackupPasswordRef(passwordRef: string): Promise<void> {
  const seen = store.backupEvents;
  const { backup } = await engine().request("backup.setPasswordRef", { passwordRef });
  // A "backup.changed" that came meanwhile is at least as new as this answer.
  if (store.backupEvents === seen) store.setBackup(backup);
}

/** Starts a backup now. How it goes arrives with "backup.changed". */
export async function runBackup(): Promise<void> {
  const seen = store.backupEvents;
  const { backup } = await engine().request("backup.run", {});
  if (store.backupEvents === seen) store.setBackup(backup);
}

// ------------------------------------------------------------ steering (protocol 14)

/** Steers a queued message into the bot's running turn now. False when no turn can take it now; it then stays queued. */
/** Takes a waiting message back before the bot read it (step 7a). It leaves by "item.removed". */
export async function unqueueMessage(botId: string, itemId: string): Promise<void> {
  await engine().request("message.unqueue", { botId, itemId });
}

export async function steerQueued(botId: string, itemId: string): Promise<boolean> {
  const { steered } = await engine().request("message.steer", { botId, itemId });
  return steered;
}

/** Saves what a message sent while a bot works does by default. */
export async function setFollowUp(followUp: FollowUp): Promise<void> {
  const seen = store.chatEvents;
  const { chat } = await engine().request("chat.set", { followUp });
  if (store.chatEvents === seen) store.setChat(chat);
}

/** Saves "About you" (protocol 24). Answers with the text as the engine keeps it (trimmed). */
export async function setAboutYou(text: string): Promise<string> {
  const seen = store.aboutYouEvents;
  const { aboutYou } = await engine().request("aboutYou.set", { text });
  if (store.aboutYouEvents === seen) store.setAboutYou(aboutYou);
  return aboutYou;
}

// ------------------------------------------------------------ notifications when the page is not open

/** Puts an answer's whole state into the store, unless a "notify.changed" that came meanwhile is newer. */
async function withNotify<T extends { notify: NotifyState }>(ask: () => Promise<T>): Promise<T> {
  const seen = store.notifyEvents;
  const result = await ask();
  if (store.notifyEvents === seen) store.setNotify(result.notify);
  return result;
}

/** Switches kinds of notification on or off, for all devices. */
export const setNotifyKinds = (kinds: Partial<Record<NotifyKind, boolean>>) => withNotify(() => engine().request("notify.setKinds", { kinds }));

/** Keeps this browser's push subscription (see ui/lib/push.ts). The address and keys go to the engine only. */
export const subscribeNotify = (params: Methods["notify.subscribe"]["params"]) => withNotify(() => engine().request("notify.subscribe", params));

/** Forgets a device: nothing is sent to it any more. */
export const forgetNotifyDevice = (deviceId: string) => withNotify(() => engine().request("notify.forget", { deviceId }));

/** Sends the test notification to one device now. Answers when the push service has answered. */
export const testNotify = (deviceId: string) => withNotify(() => engine().request("notify.test", { deviceId }));

/** Tells the engine whether this window is seen and used. Never fails loudly: a lost word is said again soon. */
export function sayPresence(params: Methods["notify.presence"]["params"]): void {
  if (!client) return;
  client.request("notify.presence", params).catch(() => undefined);
}

// ------------------------------------------------------------ step 7b: settings, providers, usage, chat titles

/** Changes settings of the settings window; the answer is used unless a newer "settings.changed" came meanwhile. */
export async function setSettings(patch: SettingsPatch): Promise<void> {
  const seen = store.settingsEvents;
  const { settings } = await engine().request("settings.set", { patch });
  if (store.settingsEvents === seen) store.setSettings(settings);
}

/** A bot's own choice for a message sent while it works, or null for the Pobots default. */
export async function setBotFollowUp(botId: string, followUp: FollowUp | null): Promise<void> {
  await engine().request("bot.update", { botId, patch: { followUp } });
}

/** What the bot sees of the person's Claude Code setup (docs/sees.md), or null for everything. */
export async function setBotSees(botId: string, sees: BotSees | null): Promise<void> {
  await engine().request("bot.update", { botId, patch: { sees } });
}

/** What exists for a bot's folder and what each thing costs. A failed read comes back as `problem`. */
export function readSees(botId: string, refresh = false): Promise<Methods["sees.inventory"]["result"]> {
  return engine().request("sees.inventory", { botId, ...(refresh ? { refresh } : {}) });
}

/** Looks at Claude Code and Codex now. */
export async function checkProviders(): Promise<void> {
  const { providers } = await engine().request("providers.check", {});
  store.setProviders(providers);
}

/** The update button: the engine waits for the bots, updates and tells how it went with "providers.changed". */
export async function updateProviders(): Promise<void> {
  const { providers } = await engine().request("providers.update", {});
  store.setProviders(providers);
}

/** Protocol 22: a day's activity for the settings window's Activity tab; today when no day is given. */
export async function readActivityDay(day?: string): Promise<ActivityDay> {
  const { activity } = await engine().request("activity.day", day ? { day } : {});
  return activity;
}

/** Reads the usage meters (again, with `refresh`). */
export function readUsageOverview(range: Methods["usage.overview"]["params"]["range"], refresh = false) {
  return engine().request("usage.overview", { range, refresh });
}

export async function readUsage(refresh = false): Promise<void> {
  const { usage } = await engine().request("usage.read", { refresh });
  store.setUsage(usage);
}

/** Adds a usage hub. The key goes to the engine and is never sent back. */
export async function addUsageHub(url: string, key: string): Promise<void> {
  const seen = store.settingsEvents;
  const { settings } = await engine().request("usage.hub.add", { url, key });
  if (store.settingsEvents === seen) store.setSettings(settings);
}

export async function removeUsageHub(id: string): Promise<void> {
  const seen = store.settingsEvents;
  const { settings } = await engine().request("usage.hub.remove", { id });
  if (store.settingsEvents === seen) store.setSettings(settings);
}

/** A bot's titled chats: the newest page, or (`more`) the page before the oldest one read. */
export async function loadChatTitles(botId: string, more = false): Promise<void> {
  const had = store.get().chatTitles[botId];
  const before = more ? had?.chats[had.chats.length - 1]?.startedAt : undefined;
  const page = await engine().request("chat.titles", { botId, ...(before ? { before } : {}), limit: 20 });
  store.setChatTitles(botId, page, more);
}
// ------------------------------------------------------------ step 7c: to-dos for the person

/** The person presses a button of a to-do and/or sends its fields. The bot gets it as his message. */
export async function answerTodo(todoId: string, buttonId: string | undefined, values: Record<string, string>): Promise<void> {
  await engine().request("todo.answer", { todoId, ...(buttonId ? { buttonId } : {}), values });
}

/** Protocol 23: he asks the bot about a to-do before he acts. The to-do stays; the engine sends it back with the question. */
export async function askTodo(todoId: string, text: string): Promise<void> {
  await engine().request("todo.ask", { todoId, text });
}

/** Protocol 23: he asks the bot about a question card before he answers. The card stays. */
export async function askCard(cardId: string, text: string): Promise<void> {
  await engine().request("card.ask", { cardId, text });
}

/** The person marks a to-do done or dismisses it. */
export async function closeTodo(todoId: string, how: "done" | "dismissed"): Promise<void> {
  await engine().request("todo.close", { todoId, how });
  // The engine also sends "todo.removed"; removing it here as well keeps the rail quick.
  store.event({ event: "todo.removed", data: { todoId, reason: how } });
}

/** The address of a file shown in a to-do's window (block `index`), or undefined where none can be made. */
export const todoFileUrl = (todoId: string, index: number, version: string, download = false): string | undefined => client?.todoFileUrl?.(todoId, index, version, download);
export const botDownloadUrl = (botId: string, path?: string): string | undefined => client?.botDownloadUrl?.(botId, path);

// ------------------------------------------------------------ the calendar tools (16 Nov 2026)

/** Reads the calendar's connection; the answer is used unless a newer "calendar.changed" came meanwhile. */
export async function loadCalendar(): Promise<void> {
  const seen = store.calendarEvents;
  const { calendar } = await engine().request("calendar.get", {});
  if (store.calendarEvents === seen) store.setCalendar(calendar);
}

/** Sets the flow's address ("" removes it) or the internal domains (an empty list: back to the mailbox's own). */
export async function setCalendar(params: Methods["calendar.set"]["params"]): Promise<void> {
  const seen = store.calendarEvents;
  const { calendar } = await engine().request("calendar.set", params);
  if (store.calendarEvents === seen) store.setCalendar(calendar);
}

/** Asks the flow who it works for, now. */
export async function testCalendar(): Promise<void> {
  const seen = store.calendarEvents;
  const { calendar } = await engine().request("calendar.test", {});
  if (store.calendarEvents === seen) store.setCalendar(calendar);
}
