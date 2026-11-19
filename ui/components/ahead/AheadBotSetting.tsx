// "Ahead" in a bot's Settings tab (protocol 31): what the bot may do on Ahead. Off by default. The
// main bot always has everything, so it shows no choice. The main bot changes it with update_bot ahead.
import { useState } from "react";
import type { AheadLevel, Bot } from "../../../shared/protocol";
import { useSaver } from "../../lib/hooks";
import { updateBot } from "../../state/actions";
import { store, useAppState } from "../../state/store";
import { CheckIcon } from "../bits";
import { radioKeys, SectionHead } from "../SettingsView";

const LEVELS: { id: AheadLevel; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Nothing on Ahead from this bot." },
  { id: "items", label: "Items", hint: "Puts what it promised, deadlines and what it waits for on Ahead." },
  { id: "time", label: "Items and your time", hint: "As Items, and asks for some of your time to look at things. Pobots puts it in a free slot in your working hours." },
];

export function AheadBotSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const [want, setWant] = useState<AheadLevel | null>(null);
  const on = useAppState((s) => !!s.ahead?.enabled);
  if (bot.role === "main") return null;
  const id = `set-${bot.id}-ahead`;
  const shown = want ?? bot.ahead;
  const at = Math.max(0, LEVELS.findIndex((l) => l.id === shown));
  const pick = (i: number) => {
    const next = LEVELS[i]!.id;
    if (next === shown) return;
    setWant(next);
    void save(() => updateBot(bot.id, { ahead: next })).then(() => setWant(null));
  };
  return (
    <section className="pb-section" aria-labelledby={id} data-ahead-setting={bot.id}>
      <SectionHead id={id} title="Ahead" state={state} />
      <div className="pb-choices" role="radiogroup" aria-labelledby={id} onKeyDown={(e) => radioKeys(e, LEVELS.length, at, pick, 1)}>
        {LEVELS.map((l, i) => (
          <button key={l.id} className="pb-choice" type="button" role="radio" data-ahead-level={l.id} aria-checked={l.id === shown} tabIndex={i === at ? 0 : -1} onClick={() => pick(i)}>
            <span className="pb-choice-label">{l.label}</span>
            <span className="pb-choice-hint">{l.hint}</span>
            {l.id === shown && <CheckIcon />}
          </button>
        ))}
      </div>
      {on ? (
        <span className="pb-hint">Items stay inside Pobots and never go to your calendar.</span>
      ) : (
        <div className="pb-calendar-note" data-ahead-note="off">
          <span className="pb-hint">Ahead is off, so this waits until you switch it on.</span>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" onClick={() => store.openAppSettings("ahead")}>
            Switch on Ahead
          </button>
        </div>
      )}
    </section>
  );
}
