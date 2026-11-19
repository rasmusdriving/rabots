import { useState } from "react";
import type { Bot } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { setBotVacation } from "../state/actions";
import { Confirm } from "./Dialog";

function useVacationAction(bot: Bot) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = async (away: boolean, stop?: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await setBotVacation(bot.id, away, stop);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, change };
}

export function VacationSetting({ bot }: { bot: Bot }) {
  const [asking, setAsking] = useState(false);
  const { busy, error, change } = useVacationAction(bot);
  const id = `set-${bot.id}-vacation`;
  const main = bot.role === "main";
  const away = !!bot.vacationSince;
  const stop = !!bot.vacationNeedsStop || ["thinking", "working"].includes(bot.state) || (bot.state === "waiting" && !bot.atRest);
  return (
    <section className="pb-section" aria-labelledby={id}>
      <h2 className="pb-section-title" id={id}>{away ? "On vacation" : "Send on vacation"}</h2>
      <p className="pb-section-text">
        {main ? "The main bot stays available to bring other bots back." : away ? "Bring this bot back to take messages and run its schedules again." : "The bot leaves the list and takes no new work. Its chat, files and settings stay."}
      </p>
      <div>
        <button className="pb-btn pb-btn-sm" type="button" disabled={main || busy} onClick={() => away ? void change(false) : setAsking(true)}>
          {away ? "Bring back" : "Send on vacation"}
        </button>
      </div>
      {away && error && <p className="pb-hint app-hint-error" role="alert">{error}</p>}
      {asking && !away && (
        <Confirm
          title={`Send ${bot.name} on vacation?`}
          text={stop ? "This bot is working or has messages waiting. Its work will stop and its chat, files and settings will stay." : "Its schedules will rest and it will stop taking messages until you bring it back."}
          yes={stop ? "Stop it and send on vacation" : "Send on vacation"}
          no="Cancel"
          busy={busy}
          error={error}
          onYes={() => void change(true, stop)}
          onNo={() => setAsking(false)}
        />
      )}
    </section>
  );
}

export function VacationChat({ bot }: { bot: Bot }) {
  const { busy, error, change } = useVacationAction(bot);
  return (
    <div className="pb-vacation-chat">
      <p className="pb-section-text">This bot is on vacation. You can read its chat.</p>
      <button className="pb-btn pb-btn-sm" type="button" disabled={busy} onClick={() => void change(false)}>Bring back</button>
      {error && <p className="pb-hint app-hint-error" role="alert">{error}</p>}
    </div>
  );
}
