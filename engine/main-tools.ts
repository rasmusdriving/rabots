// The main bot's own tools: what it alone may do, which is everything the person can change or set up
// in the window but what stays with the person (docs/build/step-main-bot-tools.md, docs/main-bot.md).
// Changes inside Pobots happen at once and the person is told; raising a bot's access goes on a card.
// This file only says what each tool is; the engine does the work behind them (engine/core/).
import { z } from "zod";
import type { BotColor } from "../shared/protocol.js";
import { BOT_COLORS } from "../shared/protocol.js";
import type { BotTool } from "./claude/session.js";
import { ok, TOOL_NAMES } from "./tool-names.js";
import type { ActivityLogArgs } from "./core/activity-log.js";
import type { BotFilesArgs, ChangeSettingsArgs, CreateBotArgs, GetBotArgs, PobotsTaskArgs, TeamHost, UpdateBotArgs, UpdateChannelArgs } from "./team.js";

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const access = z.enum(["asks-first", "edits-freely", "decides-itself", "full-access"]);
const botRef = z.string().min(1).max(200);
const names = z.array(z.string().max(200)).max(50);
const fast = z
  .boolean()
  .optional()
  .describe("Fast mode, for a GPT model that has it (marked has fast mode in the list): quicker answers, on some models for more usage. On unless switched off. Leave out for models without it.");
const color = z
  .enum(BOT_COLORS as [BotColor, ...BotColor[]])
  .optional()
  .describe(`The colour of the bot's face: ${BOT_COLORS.join(", ")}.`);
const channelRef = z.string().min(1).max(200).describe("The channel's name or id, from list_channels.");

/** What a bot sees, as moves a model gets right (docs/sees.md). Names come from get_bot. */
const seesMoves = {
  switch_on: names.optional().describe("Services or plugins."),
  switch_off: names.optional().describe("Services or plugins."),
  skills_in_full: names.optional(),
  skills_by_name: names.optional().describe("Listed by name only; still usable."),
};

const createShape = {
  name: z.string().min(1).max(60).describe("The new bot's name."),
  purpose: z.string().max(200).describe("One line about what the bot is for."),
  job: z.string().max(20000).describe("A few plain sentences: what the bot does. Becomes the 'Your job' part of its AGENTS.md."),
  model: z.string().max(100).optional().describe("Model id, a Claude model such as claude-sonnet-5-5 or a GPT model such as gpt-6.1-terra. Leave out for the default."),
  effort: effort.optional(),
  fast,
  access: access.optional().describe("asks-first (the default), edits-freely, decides-itself or full-access. More than asks-first is asked on a card."),
  may_message: z.array(z.string()).max(50).optional().describe("Ids or names of the bots it may message. It can always message the main bot."),
  color: color.describe(`The colour of the bot's face: ${BOT_COLORS.join(", ")}. Leave out to have one picked that no other bot has.`),
};

const updateShape = {
  bot: botRef.describe("Id or name of the bot. Your own changes your own settings."),
  name: z.string().min(1).max(60).optional().describe("A new name. The id stays."),
  purpose: z.string().max(200).optional(),
  model: z.string().max(100).optional().describe("Model id, a Claude model or a GPT model. A change between the two starts the bot in a fresh session with its memory and the end of its chat."),
  effort: effort.optional(),
  fast,
  access: access.optional().describe("Raising it is asked on a card; lowering happens at once."),
  may_message: z.array(z.string()).max(50).optional().describe("The whole new list of bots it may message, as ids or names."),
  may_steer: z.boolean().optional().describe("Whether it may steer other bots (message_bot delivery steer). Off by default; only when the person asks."),
  calendar: z
    .boolean()
    .optional()
    .describe("Whether it has the calendar tools for the person's Outlook calendar. Off by default, on for the main bot; only when the person asks. Meetings with others always go on the person's card."),
  job: z.string().max(20000).optional().describe("New text for the 'Your job' part of its AGENTS.md. Other files: bot_files."),
  color,
  eyes: z.enum(["round", "tall", "wide", "square"]).optional().describe("The eyes of its face."),
  eye_gap: z.enum(["near", "mid", "far"]).optional().describe("The gap between the eyes."),
  sees: z
    .object({
      start_from: z.string().max(40).optional().describe("A ready-made set: everything, coding."),
      ...seesMoves,
    })
    .optional()
    .describe("What it sees of the person's services, plugins and skills (Claude bots), by the names get_bot shows."),
  forget_rules: z.array(z.string().max(100)).max(100).optional().describe('Ids of its Always allowed rules to forget (get_bot), or ["all"].'),
  start_fresh: z.boolean().optional().describe("true: a fresh session now, after it writes down what matters. Not while it works."),
};

const getBotShape = {
  bot: botRef.describe("Id or name of the bot."),
  parts: z
    .array(z.enum(["settings", "sees", "rules", "files", "history", "artifacts"]))
    .max(6)
    .optional()
    .describe("What to show. Leave out for settings and sees."),
};

const botFilesShape = {
  bot: botRef.describe("Id or name of the bot, also yourself."),
  action: z.enum(["list", "read", "write", "delete", "history", "show_change", "undo", "remove_artifact"]),
  path: z.string().max(400).optional().describe("A file, relative to the bot's folder. For remove_artifact the page's HTML file."),
  text: z.string().max(500_000).optional().describe("The whole new text, for write."),
  base_rev: z.string().max(100).optional().describe("The rev from read: write is refused when the file changed since."),
  change: z.string().max(100).optional().describe("A change id from history, for show_change and undo."),
};

/** The main bot's own tools, after the tools every bot has. `models` names the models of the list. */
export function mainTools(host: TeamHost, models: string): BotTool[] {
  return [
    {
      name: TOOL_NAMES.getBot,
      description: "See one bot in full: its settings, what it sees with what each service, plugin and skill costs, its Always allowed rules, its files, its recent changes and its artifacts.",
      shape: getBotShape,
      handler: async (args) => host.getBot(args as GetBotArgs),
    },
    {
      name: TOOL_NAMES.createBot,
      description: `Make a new bot, on a Claude model or a GPT model. Happens at once; the person gets a note. Access above asks-first is asked on a card, and the bot starts on asks-first until they say yes. Its face is picked; change it with update_bot. Models right now: ${models}.`,
      shape: createShape,
      handler: (args, signal) => host.createBot(args as CreateBotArgs, signal),
    },
    {
      name: TOOL_NAMES.updateBot,
      description:
        `Change a bot, or yourself. Give only what changes. Happens at once and the person gets a note saying what changed, from what to what; only raising access is asked on a card. A change between a Claude model and a GPT model is refused while the bot works. What a message sent while it works does: change_settings bot_follow_up. Models right now: ${models}.`,
      shape: updateShape,
      handler: (args, signal) => host.updateBot(args as UpdateBotArgs, signal),
    },
    {
      name: TOOL_NAMES.retireBot,
      description: "Retire another bot. Happens at once; the person gets a note. Its folder is archived and its chat kept. The main bot cannot be retired.",
      shape: { bot: botRef.describe("Id or name of the bot.") },
      handler: (args, signal) => host.retireBot(args as { bot: string }, signal),
    },
    {
      name: TOOL_NAMES.botFiles,
      description:
        "Work on any bot's files as the person does in its Files and History tabs. Each change is saved in that bot's History with your name, can be undone there, and the person gets a note. bot.json and CLAUDE.md are Pobots' own; AGENTS.md cannot be deleted.",
      shape: botFilesShape,
      handler: async (args) => host.botFiles(args as BotFilesArgs),
    },
    {
      name: TOOL_NAMES.setChannelRoute,
      description:
        "Let a tag reach a bot in a channel: a tagged message from an allowed writer there becomes an instruction to that bot. Adds the tag, or moves it to another bot. Happens at once; the person gets a note.",
      shape: {
        channel: channelRef,
        tag: z.string().min(1).max(60).describe('The tag as written in the channel, for example Po. A leading "@" or "#" is ignored.'),
        bot: botRef.describe("Id or name of the bot the tag should reach."),
      },
      handler: (args, signal) => host.setChannelRoute(args as { channel: string; tag: string; bot: string }, signal),
    },
    {
      name: TOOL_NAMES.removeChannelRoute,
      description: "Remove a tag from a channel, so it reaches no bot there any more. Happens at once; the person gets a note.",
      shape: { channel: channelRef, tag: z.string().min(1).max(60).describe("The tag to remove.") },
      handler: (args, signal) => host.removeChannelRoute(args as { channel: string; tag: string }, signal),
    },
    {
      name: TOOL_NAMES.updateChannel,
      description:
        "Change a channel, or make one with create. Happens at once; the person gets a note. Addresses never come to you: the person finds them on the channel's page in the app. The address for answers, and removing a channel, stay with the person; switch one off instead.",
      shape: {
        channel: channelRef.describe("The channel's name or id, from list_channels. With create, the new channel's name."),
        create: z.boolean().optional().describe("true: make a new channel with this name."),
        name: z.string().min(1).max(80).optional().describe("A new name."),
        allowed_senders: z.array(z.string().max(320)).max(50).optional().describe("The whole new list of email addresses that may write to bots here."),
        context_count: z.number().int().min(0).max(30).optional().describe("How many earlier messages a bot is given as background."),
        enabled: z.boolean().optional().describe("Whether the channel is on."),
        new_address: z.boolean().optional().describe("true: give it a new address; the old one stops working."),
        may_post: z
          .array(z.string().min(1).max(200))
          .max(50)
          .optional()
          .describe("The whole new list of bots (names or ids) that may write posts of their own here with post_to_channel, not only answer. [] takes the right from every bot."),
      },
      handler: (args, signal) => host.updateChannel(args as UpdateChannelArgs, signal),
    },
    {
      name: TOOL_NAMES.getSettings,
      description:
        "See Pobots' own settings: what a message sent while a bot works does, when bots start fresh for each provider, how often Pobots looks at Claude Code and Codex, the providers and their versions, the model that names chats, notifications and their devices, the backup and the usage meters.",
      shape: { fresh: z.boolean().optional().describe("true: look at the providers and read usage again first.") },
      handler: async (args) => ok(await host.getSettings(args as { fresh?: boolean })),
    },
    {
      name: TOOL_NAMES.changeSettings,
      description:
        "Change Pobots' own settings when the person asks you to. No card: the person is told what you changed, from what to what. Only what you give changes. The backup key, usage hubs and turning notifications on for a device stay with the person in the app. Call get_settings first to see the values.",
      shape: {
        follow_up_default: z.enum(["steer", "queue"]).optional().describe("What a message the person sends while a bot works does for every bot without a choice of its own: steer (goes into the running turn) or queue (waits until it is done)."),
        bot_follow_up: z
          .object({ bot: botRef.describe("Id or name of the bot."), choice: z.enum(["steer", "queue", "default"]).describe("default: the Pobots default.") })
          .optional()
          .describe("One bot's own choice for a message sent while it works."),
        chats: z
          .object({
            provider: z.enum(["claude", "codex", "both"]).describe("The bots of which provider: claude (Claude Code), codex (Codex, the GPT models) or both."),
            enabled: z.boolean().optional().describe("Fresh starts on or off."),
            minTokens: z.number().int().min(0).max(10_000_000).optional().describe("A session smaller than this many tokens is not worth a fresh start before the cache goes cold or after a quiet spell."),
            fullFraction: z.number().min(0.01).max(1).optional().describe("Right after a turn, a session holding at least this share of the model's window starts fresh at once."),
            fullTokens: z.number().int().min(1000).max(10_000_000).optional().describe("The same in tokens, whichever comes first."),
            warmMarginMinutes: z.number().min(0).max(120).optional().describe("Claude only: how many minutes before the cache goes cold the fresh start begins."),
            coldHours: z.number().min(0.1).max(720).optional().describe("A session not used for this many hours starts fresh."),
            compactTokens: z
              .number()
              .int()
              .min(150_000)
              .max(1_000_000)
              .optional()
              .describe("The size in tokens at which Claude Code or Codex itself summarises a conversation in the middle of work. A helper works under it, and a bot itself in one very long task. Used by sessions started after the change."),
            reset: z.array(z.enum(["enabled", "minTokens", "fullFraction", "fullTokens", "warmMarginMinutes", "coldHours", "compactTokens"])).max(7).optional().describe("Values to put back to their default."),
          })
          .optional(),
        health_check_seconds: z.number().int().min(0).max(86_400).optional().describe("How often Pobots looks at Claude Code and Codex, in seconds: 0 never, else at least 30."),
        title_model: z.string().min(1).max(100).optional().describe("The Claude model that names chats, by id, for example claude-haiku-5-5."),
        calendar_internal_domains: z
          .array(z.string().max(200))
          .max(20)
          .optional()
          .describe("The calendar tools: the email domains of people inside the company, whose free times are checked before a meeting is booked, like example.com. An empty list goes back to the domain of the connected mailbox. Only when the person asks."),
        providers: z.object({ claude: z.boolean().optional(), codex: z.boolean().optional() }).optional().describe("Switch a provider on or off. One that a bot runs on cannot be switched off."),
        notifications: z
          .object({ needs: z.boolean().optional(), note: z.boolean().optional(), finished: z.boolean().optional() })
          .optional()
          .describe("Which notifications reach the person's devices: needs (a card waits for an answer), note (a bot sent a note), finished (a bot finished work the person asked for)."),
      },
      handler: async (args) => host.changeSettings(args as ChangeSettingsArgs),
    },
    {
      name: TOOL_NAMES.runPobotsTask,
      description:
        "Do one thing for Pobots now: back_up_now; update_providers (updates Claude Code and Codex once every bot is calm, so after your turn); test_notification (to a device from get_settings). The person gets a note for a backup or an update.",
      shape: {
        task: z.enum(["back_up_now", "update_providers", "test_notification"]),
        device: z.string().max(100).optional().describe("For test_notification: the device's label or id. Leave out when there is one."),
      },
      handler: async (args) => host.runPobotsTask(args as PobotsTaskArgs),
    },
    {
      name: TOOL_NAMES.activityLog,
      description:
        "What happened in Pobots over a day, with local times, for the person's time reporting: his own actions (messages, card answers, to-dos, Stop; from the Mac, a computer or the phone), his active blocks, each bot's turns with what started them (him, a schedule, a webhook, a channel, another bot, a helper reporting back) and the chat's title, helpers and task managers, calendar actions and channel posts. Labels only, never what was written. Leave everything out for today.",
      shape: {
        day: z.string().max(10).optional().describe("The day, YYYY-MM-DD. Leave out for today."),
        from: z.string().max(10).optional().describe("First day of a range, YYYY-MM-DD. A range gives each day's summary only."),
        to: z.string().max(10).optional().describe("Last day of a range, YYYY-MM-DD. At most 7 days."),
        bot: botRef.optional().describe("Only this bot's turns, helpers and your actions with it: its id or name."),
        gap_minutes: z.number().int().min(5).max(120).optional().describe("Your actions closer than this make one active block. Default 15."),
      },
      handler: async (args) => host.activityLog(args as ActivityLogArgs),
    },
  ];
}
