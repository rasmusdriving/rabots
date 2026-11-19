// The mark of a row that belongs to a bot: its small face. The person's own items get a plain disc.
import type { Bot } from "../../../../shared/protocol";
import { Face } from "../../bits";

export function BotMark({ bot }: { bot: Bot | undefined }) {
  return bot ? <Face look={bot.look} size="sm" /> : <span className="pb-ahead-you" />;
}
