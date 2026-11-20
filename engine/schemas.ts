// Checks the params of every request before the engine acts on them.
import { z } from "zod";
import type { MethodName, Methods } from "../shared/protocol.js";
import { AHEAD_SCHEDULING_MAX, BOT_COLORS, EYE_GAPS, EYE_SHAPES, USAGE_RANGES } from "../shared/protocol.js";

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const access = z.enum(["asks-first", "edits-freely", "decides-itself", "full-access"]);
const look = z.object({ eyes: z.enum(EYE_SHAPES as [string, ...string[]]), gap: z.enum(EYE_GAPS as [string, ...string[]]), color: z.enum(BOT_COLORS as [string, ...string[]]).optional() });
const id = z.string().min(1).max(200);
const botIds = z.array(id).max(200);
const path = z.string().min(1).max(400);
const changeId = z.string().regex(/^[0-9a-f]{7,64}$/i);

const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const hhmm = z.string().max(20);
// Shapes only: the engine checks the values and refuses with plain words (at least 5 minutes apart, a real time).
const schedule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily"), time: hhmm, days: z.array(weekday).max(7) }),
  z.object({ type: z.literal("every"), minutes: z.number(), days: z.array(weekday).max(7), from: hhmm.optional(), to: hhmm.optional() }),
  z.object({ type: z.literal("once"), at: z.string().max(60) }),
]);
const triggerId = z.string().min(1).max(100);
const channelId = z.string().min(1).max(100);
const decision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allow-once") }),
  z.object({ type: z.literal("always-allow") }),
  z.object({ type: z.literal("deny") }),
  z.object({ type: z.literal("choice"), choiceId: z.string().min(1) }),
  z.object({ type: z.literal("text"), text: z.string().max(20000) }),
  z.object({ type: z.literal("dismiss") }),
  z.object({ type: z.literal("later") }),
]);

const num = z.number().finite();
const mods = z.number().int().min(0).max(15).optional();
const browserInput = z.union([
  z.object({ type: z.enum(["move", "down", "up"]), x: num, y: num, button: z.enum(["left", "middle", "right"]).optional(), clicks: z.number().int().min(0).max(10).optional(), mods }),
  z.object({ type: z.literal("wheel"), x: num, y: num, dx: num, dy: num, mods }),
  z.object({ type: z.literal("key"), down: z.boolean(), key: z.string().min(1).max(40), code: z.string().max(40), text: z.string().max(16).optional(), repeat: z.boolean().optional(), mods }),
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
]);
const watchId = z.string().min(1).max(100);
const spaceId = z.string().min(1).max(40);

// Step 7b: a change to the settings window's settings.
const timingValue = z.union([z.number().finite(), z.boolean(), z.null()]);
const timingPatch = z
  .object({ enabled: timingValue, minTokens: timingValue, fullFraction: timingValue, fullTokens: timingValue, warmMarginMinutes: timingValue, coldHours: timingValue, compactTokens: timingValue })
  .partial()
  .strict();
const settingsPatch = z
  .object({
    timing: z.object({ claude: timingPatch, codex: timingPatch }).partial().strict(),
    healthCheckSeconds: z.number().finite(),
    titleModel: z.string().min(1).max(200),
    providers: z.object({ claude: z.object({ enabled: z.boolean() }), codex: z.object({ enabled: z.boolean() }) }).partial().strict(),
  })
  .partial()
  .strict();

const seesNames = z.array(z.string().max(1000)).max(2000);
const botSees = z.object({
  services: z.object({ rest: z.enum(["on", "off"]), except: seesNames }).optional(),
  plugins: z.object({ rest: z.enum(["on", "off"]), except: seesNames }).optional(),
  skills: z.object({ rest: z.enum(["full", "name"]), except: seesNames }).optional(),
});

// Kept with its own types (not only as z.ZodType) so engine/tests/schema-keys.spec.ts can check at
// type-check time that no method's schema drops a key its protocol params declare (engine 0.42.1).
const schemas = {
  hello: z.object({ protocol: z.number(), client: z.string().max(200) }),
  snapshot: z.object({}).optional(),
  "bot.create": z.object({
    name: z.string().max(200),
    purpose: z.string().max(1000).optional(),
    job: z.string().max(100_000).optional(),
    model: z.string().min(1).max(200).optional(),
    effort: effort.optional(),
    fast: z.boolean().optional(),
    access: access.optional(),
    look: look.optional(),
    mayMessage: botIds.optional(),
    welcome: z.boolean().optional(),
  }),
  "bot.update": z.object({
    botId: id,
    patch: z.object({
      name: z.string().max(200).optional(),
      purpose: z.string().max(1000).optional(),
      model: z.string().min(1).max(200).optional(),
      effort: effort.optional(),
      fast: z.boolean().optional(),
      access: access.optional(),
      look: look.optional(),
      mayMessage: botIds.optional(),
      maySteer: z.boolean().optional(),
      calendar: z.boolean().optional(),
      // Protocol 31: the bot's Ahead permission.
      ahead: z.enum(["off", "items", "time"]).optional(),
      followUp: z.enum(["steer", "queue"]).nullable().optional(),
      // Protocol 16: shapes and sizes only; the engine cleans the lists (engine/claude/sees.ts).
      sees: botSees.nullable().optional(),
    }),
  }),
  "bot.vacation": z.object({ botId: id, vacation: z.boolean(), stop: z.boolean().optional() }),
  "bot.retire": z.object({ botId: id }),
  "bot.startFresh": z.object({ botId: id }),
  "bot.files": z.object({ botId: id }),
  "bot.file.read": z.object({ botId: id, path }),
  "bot.file.write": z.object({ botId: id, path, text: z.string().max(2 * 1024 * 1024), baseRev: z.string().min(1).max(200).optional() }),
  "bot.file.delete": z.object({ botId: id, path }),
  "artifact.list": z.object({ botId: id }),
  "artifact.open": z.object({ botId: id, artifactId: id }),
  "artifact.remove": z.object({ botId: id, artifactId: id }),
  "browser.state": z.object({}).optional(),
  "browser.watch": z.object({ spaceId, pageId: z.string().min(1).max(200).optional(), ratio: z.number().positive().max(100).optional() }),
  "browser.view": z.object({ watchId, ratio: z.number().positive().max(100) }),
  "browser.page.show": z.object({ watchId, pageId: z.string().min(1).max(200).optional() }),
  "browser.page.open": z.object({ watchId, url: z.string().max(4000).optional() }),
  "browser.page.close": z.object({ watchId, pageId: z.string().min(1).max(200) }),
  "browser.unwatch": z.object({ watchId }),
  "browser.control": z.object({ watchId, take: z.boolean() }),
  "browser.input": z.object({ watchId, events: z.array(browserInput).max(500) }),
  "browser.go": z.object({ watchId, to: z.union([z.object({ url: z.string().max(4000) }), z.enum(["back", "forward", "reload"])]) }),
  "browser.selection": z.object({ watchId }),
  "browser.answer": z.object({
    watchId,
    answer: z.union([
      z.object({ kind: z.literal("dialog"), accept: z.boolean(), text: z.string().max(100_000).optional() }),
      z.object({ kind: z.literal("choices"), index: z.number().int().min(0).max(100_000).optional() }),
    ]),
  }),
  "browser.own": z.object({ url: z.string().max(4000).optional() }),
  "browser.close": z.object({ spaceId }),
  "bot.history": z.object({ botId: id, before: changeId.optional(), limit: z.number().int().min(1).max(200).optional() }),
  "bot.history.read": z.object({ botId: id, changeId }),
  "bot.history.undo": z.object({ botId: id, changeId }),
  "rule.list": z.object({ botId: id }),
  "rule.remove": z.object({ ruleId: id }),
  "trigger.list": z.object({ botId: id }),
  "trigger.save": z.object({
    botId: id,
    trigger: z.object({
      id: triggerId.optional(),
      kind: z.enum(["schedule", "webhook"]),
      name: z.string().max(400),
      prompt: z.string().max(100_000),
      where: z.enum(["main", "fresh"]),
      enabled: z.boolean(),
      schedule: schedule.optional(),
    }),
  }),
  "trigger.remove": z.object({ triggerId }),
  "trigger.run": z.object({ triggerId }),
  "trigger.runs": z.object({ triggerId, before: triggerId.optional(), limit: z.number().int().min(1).max(200).optional() }),
  "trigger.newAddress": z.object({ triggerId }),
  "trigger.address": z.object({ triggerId }),
  "trigger.enable": z.object({ triggerId, enabled: z.boolean() }),
  "channel.get": z.object({ channelId }),
  // Shapes and sizes only: the engine checks the values and refuses with plain words.
  "channel.save": z.object({
    channel: z.object({
      id: channelId.optional(),
      name: z.string().max(400).optional(),
      enabled: z.boolean().optional(),
      allowedSenders: z.array(z.string().max(400)).max(200).optional(),
      routes: z.array(z.object({ tag: z.string().max(200), botId: id })).max(100).optional(),
      contextCount: z.number().optional(),
      replyUrl: z.string().max(4000).optional(),
      mayPost: z.array(id).max(100).optional(),
    }),
  }),
  "channel.remove": z.object({ channelId }),
  "channel.address": z.object({ channelId }),
  "channel.newAddress": z.object({ channelId }),
  "channel.messages": z.object({ channelId, before: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(200).optional() }),
  "thread.read": z.object({
    threadId: id,
    before: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  "message.send": z.object({ botId: id, threadId: id.optional(), text: z.string().max(100000), attachments: z.array(z.string().min(1).max(64)).max(50).optional(), mode: z.enum(["steer", "queue"]).optional() }),
  "message.steer": z.object({ botId: id, itemId: id }),
  // Job 7, the chat (step 7a).
  "message.unqueue": z.object({ botId: id, itemId: id }),
  "thread.queued": z.object({ threadId: id }),
  "chat.set": z.object({ followUp: z.enum(["steer", "queue"]) }),
  // The engine says the limit (4,000) in plain words; this only stops a huge message.
  "aboutYou.set": z.object({ text: z.string().max(20_000) }),
  "attachment.discard": z.object({ id: z.string().min(1).max(64) }),
  "helper.stop": z.object({ botId: id, itemId: id }),
  "turn.interrupt": z.object({ botId: id }),
  // Protocol 21: task managers.
  "taskManager.send": z.object({ botId: id, managerId: id, text: z.string().min(1).max(100000) }),
  "taskManager.stop": z.object({ botId: id, managerId: id }),
  "taskManager.end": z.object({ botId: id, managerId: id }),
  "card.resolve": z.object({ cardId: id, decision }),
  // Only the 1Password reference crosses the protocol.
  "backup.setPasswordRef": z.object({ passwordRef: z.string().max(512) }),
  "connection.list": z.object({}).optional(),
  "connection.set": z.discriminatedUnion("action", [
    z.object({ action: z.literal("start"), name: z.string().max(60), lasts: z.enum(["24h", "30d", "never"]).optional(), owner: id.optional() }),
    z.object({ action: z.literal("connect"), id: z.string().max(36), code: z.string().max(2058) }),
    z.object({ action: z.literal("rename"), id: z.string().max(36), name: z.string().max(60) }),
    z.object({ action: z.literal("lasts"), id: z.string().max(36), lasts: z.enum(["24h", "30d", "never"]) }),
    z.object({ action: z.literal("owner"), id: z.string().max(36), owner: id }),
    z.object({ action: z.enum(["code", "pause", "resume", "remove"]), id: z.string().max(36) }),
  ]),
  "backup.run": z.object({}).optional(),
  // Notifications: shapes and sizes; the engine checks the push service and the keys and refuses in plain words.
  "notify.setKinds": z.object({ kinds: z.object({ needs: z.boolean().optional(), note: z.boolean().optional(), finished: z.boolean().optional(), yourTime: z.boolean().optional(), dayReady: z.boolean().optional() }).strict() }),
  "notify.subscribe": z.object({
    subscription: z.object({ endpoint: z.string().min(1).max(2048), keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) }),
    label: z.string().max(200),
    asked: z.boolean(),
    replaces: z.string().min(1).max(64).optional(),
  }),
  "notify.forget": z.object({ deviceId: z.string().min(1).max(64) }),
  "notify.test": z.object({ deviceId: z.string().min(1).max(64) }),
  "notify.presence": z.object({ deviceId: z.string().min(1).max(64).optional(), visible: z.boolean(), focused: z.boolean(), idleMs: z.number().nullable() }),
  // Step 7b: shapes only; the engine checks the values and refuses in plain words.
  "settings.set": z.object({ patch: settingsPatch }),
  "providers.check": z.object({}).optional(),
  "providers.update": z.object({}).optional(),
  "usage.overview": z.object({ range: z.enum(USAGE_RANGES), refresh: z.boolean().optional() }),
  "usage.read": z.object({ refresh: z.boolean().optional() }).optional(),
  "activity.day": z.object({ day: z.string().max(20).optional() }).optional(),
  "usage.hub.add": z.object({ url: z.string().max(2000), key: z.string().max(5000) }),
  "usage.hub.remove": z.object({ id: z.string().min(1).max(64) }),
  "chat.titles": z.object({ botId: id, before: z.string().max(60).optional(), limit: z.number().int().min(1).max(100).optional() }),
  // step 7c: to-dos for the person
  "todo.answer": z.object({ todoId: z.string().min(1).max(64), buttonId: z.string().min(1).max(60).optional(), values: z.record(z.string().max(60), z.string().max(40_000)).optional() }),
  "sees.inventory": z.object({ botId: id, refresh: z.boolean().optional() }),
  "todo.close": z.object({ todoId: z.string().min(1).max(64), how: z.enum(["done", "dismissed"]) }),
  // Engine 0.25.0: the calendar connection. The address is checked by the engine.
  "calendar.get": z.object({}).optional(),
  "calendar.set": z.object({ address: z.string().max(2100).optional(), internalDomains: z.array(z.string().max(200)).max(50).optional() }),
  "calendar.test": z.object({}).optional(),
  // Protocol 23: follow-up questions on cards. The engine trims the text and refuses an empty one.
  "todo.ask": z.object({ todoId: z.string().min(1).max(64), text: z.string().min(1).max(2000) }),
  "card.ask": z.object({ cardId: z.string().min(1).max(64), text: z.string().min(1).max(2000) }),
  // Protocol 31: Ahead. Days and times are checked by the engine (core/ahead-*.ts).
  "ahead.view": z.object({ from: z.string().max(10).optional(), days: z.number().int().min(1).max(62).optional() }).optional(),
  "ahead.settings.set": z.object({
    enabled: z.boolean().optional(),
    workStart: z.string().max(5).optional(),
    workEnd: z.string().max(5).optional(),
    workDays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).max(7).optional(),
    minutesPerDay: z.number().int().min(15).max(480).optional(),
    // Protocol 32: the to-do blocks switch and "How to schedule me". The engine trims the text and
    // refuses one over AHEAD_SCHEDULING_MAX with plain words; this only bounds the size. Engine 0.42.1:
    // these were missing, so zod dropped them and the window's switch and Save did nothing.
    todoBlocks: z.boolean().optional(),
    scheduling: z.string().max(AHEAD_SCHEDULING_MAX * 4).optional(),
  }),
  "ahead.act": z.object({
    itemId: z.string().min(1).max(64),
    action: z.enum(["done", "drop", "move", "reopen"]),
    day: z.string().max(10).optional(),
    time: z.string().max(5).nullable().optional(),
    place: z.enum(["today", "tomorrow", "next", "next-week"]).optional(),
  }),
  "ahead.add": z.object({
    title: z.string().min(1).max(500),
    day: z.string().max(10),
    time: z.string().max(5).optional(),
    label: z.string().max(200).optional(),
    kind: z.enum(["will-do", "deadline", "waiting", "note"]).optional(),
  }),
  "ahead.seen": z.object({ through: z.iso.datetime().optional() }).optional(),
} satisfies { [M in MethodName]: z.ZodType<unknown> };

export type ParamSchemas = typeof schemas;
export const paramSchemas: { [M in MethodName]: z.ZodType<unknown> } = schemas;

export function isMethod(name: unknown): name is MethodName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(paramSchemas, name);
}

export function parseParams<M extends MethodName>(method: M, params: unknown): Methods[M]["params"] | undefined {
  const r = paramSchemas[method].safeParse(params ?? {});
  return r.success ? ((r.data ?? {}) as Methods[M]["params"]) : undefined;
}
