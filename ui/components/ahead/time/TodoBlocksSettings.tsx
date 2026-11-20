// Settings, Ahead, "To-dos in your calendar" (protocol 32, docs/build/step-todo-blocks.md): the switch
// that gives every new to-do a block of time on Ahead and in Outlook (shown only while the calendar is
// connected), and "How to schedule me", the text every bot is told. Shown while Ahead is on. The main
// bot changes the same with change_settings ahead_todo_blocks and ahead_scheduling. A change from the
// main bot shows at once, unless the box holds an edit not saved yet.
import { useState } from "react";
import { AHEAD_SCHEDULING_DEFAULT, AHEAD_SCHEDULING_MAX, type AheadSettings } from "../../../../shared/protocol";
import { useSaver } from "../../../lib/hooks";
import { engineRequest } from "../../../state/actions";
import { store, useAppState } from "../../../state/store";
import { SectionHead } from "../../SettingsView";

const count = (n: number) => `${n} of ${AHEAD_SCHEDULING_MAX} characters`;

export function TodoBlocksSettings() {
  const [state, save] = useSaver();
  const ahead = useAppState((s) => s.ahead);
  const connected = useAppState((s) => !!s.calendar?.connected);
  /** The person's edit, while it differs from what is kept; null when the box shows what is kept. */
  const [draft, setDraft] = useState<string | null>(null);
  if (!ahead?.enabled) return null;

  const kept = ahead.scheduling?.trim() || AHEAD_SCHEDULING_DEFAULT;
  const shown = draft ?? kept;
  const dirty = draft !== null && draft.trim() !== kept;
  const tooLong = shown.trim().length > AHEAD_SCHEDULING_MAX;
  const problem = state.phase === "error" ? state.message : tooLong ? `Keep it under ${AHEAD_SCHEDULING_MAX} characters.` : "";
  const put = (patch: Partial<Pick<AheadSettings, "todoBlocks" | "scheduling">>) =>
    save(async () => {
      const r = await engineRequest("ahead.settings.set", patch);
      store.event({ event: "ahead.changed", data: r });
    });
  const submit = () => {
    if (!dirty || tooLong || state.phase === "saving") return;
    void put({ scheduling: draft!.trim() }).then((ok) => {
      if (ok) setDraft(null);
    });
  };
  const hintId = "set-ahead-todo-blocks-hint";

  return (
    <section className="pb-section" aria-labelledby="set-ahead-todos" data-todo-blocks-settings="">
      <SectionHead id="set-ahead-todos" title="To-dos in your calendar" state={state} />
      {connected ? (
        <div className="pb-steer">
          <span className="pb-peer-text">
            <span className="pb-peer-name">Put to-dos in my calendar</span>
            <span className="pb-hint" id={hintId}>
              Each new to-do from a bot gets a block of time, on Ahead and in your Outlook calendar, shown as busy.
            </span>
          </span>
          <input
            className="pb-switch"
            type="checkbox"
            role="switch"
            data-todo-blocks-switch=""
            checked={!!ahead.todoBlocks}
            aria-label="Put to-dos in my calendar"
            aria-describedby={hintId}
            onChange={(e) => void put({ todoBlocks: e.target.checked })}
          />
        </div>
      ) : (
        <p className="pb-section-text" data-todo-blocks-no-calendar="">
          Connect your calendar in Settings, Calendar, and each new to-do from a bot can get a block of time in it.
        </p>
      )}
      <form
        className="pb-field pb-field-wide"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="pb-label" htmlFor="ahead-scheduling">
          How to schedule me
        </label>
        <span className="pb-hint" id="ahead-scheduling-intro">
          Every bot is told this when it gives you a to-do or asks for your time. Your main bot keeps it up to date when you tell it what worked.
        </span>
        <textarea
          id="ahead-scheduling"
          className="pb-input pb-textarea pb-about-input"
          rows={4}
          value={shown}
          data-ahead-scheduling=""
          aria-describedby="ahead-scheduling-intro ahead-scheduling-note"
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setDraft(e.target.value.trim() === kept ? null : e.target.value)}
        />
        <div className="pb-about-foot">
          {/* One line that keeps its room: the count, or what is wrong. */}
          <span className={problem ? "pb-hint pb-about-note app-hint-error" : "pb-hint pb-about-note"} id="ahead-scheduling-note" role={problem ? "alert" : undefined}>
            {problem || count(shown.trim().length)}
          </span>
          <span className="pb-ahead-scheduling-acts">
            <button
              className="pb-btn pb-btn-sm pb-btn-quiet"
              type="button"
              data-ahead-scheduling-default=""
              disabled={(!ahead.scheduling && draft === null) || state.phase === "saving"}
              onClick={() =>
                void put({ scheduling: "" }).then((ok) => {
                  if (ok) setDraft(null);
                })
              }
            >
              Use the default
            </button>
            <button className="pb-btn pb-btn-sm" type="submit" data-ahead-scheduling-save="" disabled={!dirty || tooLong || state.phase === "saving"}>
              Save
            </button>
          </span>
        </div>
      </form>
    </section>
  );
}
