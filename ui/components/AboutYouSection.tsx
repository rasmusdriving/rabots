// "About you" (engine 0.33.0, protocol 24): the short note about the person that every bot gets in
// its instructions. The first part of Settings > General. The main bot writes it when they first meet
// (change_settings about_you); here the person reads and changes it. A change from the main bot shows
// at once, unless the box holds an edit not saved yet: that stays until it is saved.
import { useState } from "react";
import { useSaver, type SaveState } from "../lib/hooks";
import { setAboutYou } from "../state/actions";
import { useAppState } from "../state/store";

export const ABOUT_YOU_MAX = 4000;
export const ABOUT_YOU_TITLE = "About you";
export const ABOUT_YOU_INTRO = "A short note every bot gets: who you are, what you do, what matters to you and how you like to be talked to. Your main bot writes it when you first meet. Change it here, or ask your main bot.";
const PLACEHOLDER = "Who you are, what you do, what matters to you.";

function SavedWord({ state }: { state: SaveState }) {
  const show = state.phase === "saved";
  return (
    <span className="pb-saved" role="status" data-show={show || undefined} aria-hidden={!show || undefined}>
      Saved
    </span>
  );
}

const count = (n: number) => `${n.toLocaleString("en-US")} of ${ABOUT_YOU_MAX.toLocaleString("en-US")} characters`;

export function AboutYouSection() {
  const kept = useAppState((s) => s.aboutYou);
  const [state, save] = useSaver();
  /** His edit, while it differs from what is kept; null when the box shows what is kept. */
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? kept;
  const dirty = draft !== null && draft !== kept;
  const tooLong = shown.length > ABOUT_YOU_MAX;
  const problem = state.phase === "error" ? state.message : tooLong ? `Keep it under ${ABOUT_YOU_MAX.toLocaleString("en-US")} characters.` : "";

  const submit = () => {
    if (!dirty || tooLong || state.phase === "saving") return;
    const text = draft;
    void save(() => setAboutYou(text)).then((ok) => {
      if (ok) setDraft(null);
    });
  };

  return (
    <section className="pb-section pb-about" aria-labelledby="set-about">
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set-about">
          {ABOUT_YOU_TITLE}
        </h2>
        <SavedWord state={state} />
      </div>
      <p className="pb-section-text">{ABOUT_YOU_INTRO}</p>
      <form
        className="pb-field pb-field-wide"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          id="about-you"
          className="pb-input pb-textarea pb-about-input"
          rows={6}
          value={shown}
          placeholder={PLACEHOLDER}
          aria-labelledby="set-about"
          aria-describedby="about-you-note"
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setDraft(e.target.value === kept ? null : e.target.value)}
        />
        <div className="pb-about-foot">
          {/* One line that keeps its room: the count, or what is wrong. */}
          <span className={problem ? "pb-hint pb-about-note app-hint-error" : "pb-hint pb-about-note"} id="about-you-note" role={problem ? "alert" : undefined}>
            {problem || count(shown.length)}
          </span>
          <button className="pb-btn pb-btn-sm" type="submit" disabled={!dirty || tooLong || state.phase === "saving"}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
