import type { AheadItem } from "../../../shared/protocol";
import { sendMessage } from "../../state/actions";
import { longDate } from "./ahead-words";

/** Ask in the bot's chat, using the normal message queue. Keep the person's question first. */
export function aheadAsk(botId: string, item: AheadItem, text: string) {
  const context = [`Ahead item: ${JSON.stringify(item.title)}`, `Day: ${longDate(item.day)}${item.time ? ` ${item.time}` : ""}`, `Item ID: ${item.id}`].join("\n");
  return sendMessage(botId, `${text}\n\n${context}`, [], "queue");
}
