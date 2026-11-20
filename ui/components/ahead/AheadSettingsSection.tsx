// Settings, Ahead (protocol 31): the switch. Off by default: no Ahead row or screen, no Ahead tool
// for any bot. Items already there are kept. Part B adds working hours, days and minutes per day here.
import type { ComponentType } from "react";
import { useSaver } from "../../lib/hooks";
import { engineRequest } from "../../state/actions";
import { store, useAppState } from "../../state/store";
import { SectionHead } from "../SettingsView";
import { AheadTimeSettings } from "./time/AheadTimeSettings";
import { TodoBlocksSettings } from "./time/TodoBlocksSettings";

function AheadSwitch() {
  const [state, save] = useSaver();
  const ahead = useAppState((s) => s.ahead);
  const hintId = "set-ahead-hint";
  return (
    <section className="pb-section" aria-labelledby="set-ahead">
      <SectionHead id="set-ahead" title="Ahead" state={state} />
      <p className="pb-section-text">A screen of what is coming over the next 14 days: what bots promised, deadlines, what they wait for, to-dos with a date, one-off schedules and meetings.</p>
      <div className="pb-steer">
        <span className="pb-peer-text">
          <span className="pb-peer-name">Show Ahead</span>
          <span className="pb-hint" id={hintId}>
            Off: no screen, and no bot gets the Ahead tool. Each bot's permission is in its Settings.
          </span>
        </span>
        <input
          className="pb-switch"
          type="checkbox"
          role="switch"
          data-ahead-switch=""
          checked={!!ahead?.enabled}
          disabled={!ahead}
          aria-label="Show Ahead"
          aria-describedby={hintId}
          onChange={(e) => {
            const enabled = e.target.checked;
            void save(async () => {
              const r = await engineRequest("ahead.settings.set", { enabled });
              store.event({ event: "ahead.changed", data: r });
            });
          }}
        />
      </div>
    </section>
  );
}

/** The parts of the section, in order. Part B adds its working hours here. */
export const AHEAD_SETTINGS: ComponentType[] = [AheadSwitch, AheadTimeSettings, TodoBlocksSettings];

export function AheadSettingsSection() {
  return (
    <>
      {AHEAD_SETTINGS.map((S, i) => (
        <S key={i} />
      ))}
    </>
  );
}
