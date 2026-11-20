// "Calendar" in a bot's Settings tab (16 Nov 2026, protocol 20): whether the bot gets the calendar
// tools (look at the person's calendar, find free times, book, move and cancel meetings, answer
// invitations). On for the main bot and off for the others until switched on. A meeting with other
// people always waits on a card first. The main bot changes it too, with update_bot calendar.
import type { Bot } from "../../shared/protocol";
import { updateBot } from "../state/actions";
import { store, useAppState } from "../state/store";
import { useSaver } from "../lib/hooks";
import { SectionHead } from "./SettingsView";

export function CalendarSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const calendar = useAppState((s) => s.calendar);
  const id = `set-${bot.id}-calendar`;
  const hintId = `${id}-hint`;
  // The connection comes with the snapshot, so this line is right from the first moment.
  const notSet = calendar !== null && !calendar.connected;
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Calendar" state={state} />
      <div className="pb-steer">
        <span className="pb-peer-text">
          <span className="pb-peer-name">Calendar tools</span>
          <span className="pb-hint" id={hintId}>
            {`On: ${bot.name} can look at your calendar, find free times, book and move meetings and answer invitations. A meeting with other people waits for your approval first.`}
          </span>
        </span>
        <input
          className="pb-switch"
          type="checkbox"
          role="switch"
          data-calendar={bot.id}
          checked={bot.calendar}
          aria-label="Calendar tools"
          aria-describedby={hintId}
          onChange={(e) => {
            const on = e.target.checked;
            void save(() => updateBot(bot.id, { calendar: on }));
          }}
        />
      </div>
      {notSet ? (
        <div className="pb-calendar-note" data-calendar-note="not-set">
          <span className="pb-hint">The calendar is not set up yet, so the tools wait until it is.</span>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" onClick={() => store.openAppSettings("calendar")}>
            Set up the calendar
          </button>
        </div>
      ) : (
        <span className="pb-hint">Every meeting gets a {calendar?.service === "google" ? "Google Meet" : "Teams"} link. Free times are checked for people inside the company.</span>
      )}
    </section>
  );
}
