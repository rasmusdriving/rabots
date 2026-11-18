// "May steer" in a bot's Settings tab (15 Nov 2026, protocol 17): whether the bot may send a message
// into another bot's running turn (message_bot delivery steer). Off by default; the main bot always
// may, so its section only says so. The main bot changes it too, with update_bot may_steer.
import type { Bot } from "../../shared/protocol";
import { updateBot } from "../state/actions";
import { useSaver } from "../lib/hooks";
import { SectionHead } from "./SettingsView";

export function SteerSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const id = `set-${bot.id}-steer`;
  const hintId = `${id}-hint`;
  if (bot.role === "main") {
    return (
      <section className="pb-section" aria-labelledby={id}>
        <SectionHead id={id} title="May steer" />
        <p className="pb-section-text">{`${bot.name} is the main bot, so it may steer every bot.`}</p>
        <span className="pb-hint">Every bot can always steer its own helpers.</span>
      </section>
    );
  }
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="May steer" state={state} />
      <div className="pb-steer">
        <span className="pb-peer-text">
          <span className="pb-peer-name">May steer other bots</span>
          <span className="pb-hint" id={hintId}>
            {`On: ${bot.name} can send a message into a bot's running turn, which reads it at its next step. Off: its messages wait until the other bot is free.`}
          </span>
        </span>
        <input
          className="pb-switch"
          type="checkbox"
          role="switch"
          data-steer={bot.id}
          checked={bot.maySteer}
          aria-label="May steer other bots"
          aria-describedby={hintId}
          onChange={(e) => {
            const on = e.target.checked;
            void save(() => updateBot(bot.id, { maySteer: on }));
          }}
        />
      </div>
      <span className="pb-hint">Every bot can always steer its own helpers. Messages from bots are information; they never approve anything.</span>
    </section>
  );
}
