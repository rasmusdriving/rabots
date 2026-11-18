// The names of the bots' own Pobots tools, and the two shapes of a tool's answer. Its own file so
// that team.ts and main-tools.ts can both use them without importing each other's values.
import type { ToolResult } from "./claude/session.js";

/** Engine 0.31.0: what every bot is told about the person's questions on its cards (docs/build/step-card-follow-ups.md). */
export const FOLLOW_UP_RULE = "The person may ask about a card before acting; answer plainly, and change the card with update_todo if the answer changes what it should say.";


export const TOOL_NAMES = {
  listBots: "list_bots",
  messageBot: "message_bot",
  askHuman: "ask_human",
  notifyHuman: "notify_human",
  createBot: "create_bot",
  updateBot: "update_bot",
  retireBot: "retire_bot",
  listTriggers: "list_triggers",
  setSchedule: "set_schedule",
  setWebhook: "set_webhook",
  webhookAddress: "webhook_address",
  removeTrigger: "remove_trigger",
  listChannels: "list_channels",
  setChannelRoute: "set_channel_route",
  removeChannelRoute: "remove_channel_route",
  updateChannel: "update_channel",
  // 15 Nov 2026: a bot writes a post of its own in a channel.
  postToChannel: "post_to_channel",
  searchChat: "search_chat",
  readChat: "read_chat",
  showArtifact: "show_artifact",
  startHelper: "start_helper",
  // 15 Nov 2026: a bot follows and controls its helpers.
  readHelper: "read_helper",
  steerHelper: "steer_helper",
  stopHelper: "stop_helper",
  // Step 7b: the main bot reads and changes Pobots' settings.
  getSettings: "get_settings",
  changeSettings: "change_settings",
  // step 7c: to-dos for the person
  addTodo: "add_todo",
  updateTodo: "update_todo",
  removeTodo: "remove_todo",
  listTodos: "list_todos",
  // The main bot can change and set up anything (docs/build/step-main-bot-tools.md).
  getBot: "get_bot",
  botFiles: "bot_files",
  runPobotsTask: "run_pobots_task",
  // A bot on a Claude model changes what it sees itself.
  changeWhatISee: "change_what_i_see",
  // Engine 0.26.0: task managers.
  startTaskManager: "start_task_manager",
  endTaskManager: "end_task_manager",
  // Engine 0.28.0: a day's activity, for the person's time reporting.
  activityLog: "activity_log",
} as const;

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function problem(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
