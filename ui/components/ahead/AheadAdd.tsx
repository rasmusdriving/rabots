import { useId, useState, type FormEvent } from "react";
import { AHEAD_TITLE_MAX } from "../../../shared/protocol";
import { messageOf } from "../../engine/types";
import { Dialog } from "../Dialog";
import { useAheadPage } from "./ahead-context";

export function AheadAdd() {
  const { today, model, setOnly, setLabel } = useAheadPage();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !title.trim() || !day || day < today) return;
    setBusy(true);
    setError("");
    try {
      await model.add(title.trim(), day);
      setOnly(null);
      setLabel("");
      setOpen(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="pb-btn pb-btn-sm" aria-haspopup="dialog" data-ahead-add="" disabled={!today} onClick={() => {
        setTitle(""); setDay(today); setError(""); setOpen(true);
      }}>Add</button>
      {open && (
        <Dialog title="Add to Ahead" size="sheet" onClose={() => setOpen(false)}>
          <form className="pb-ahead-sheet" data-ahead-add-form="" onSubmit={(e) => void add(e)}>
            <label className="pb-ahead-field" htmlFor={`${id}-title`}>
              <span className="label">What</span>
              <input id={`${id}-title`} className="pb-input" value={title} maxLength={AHEAD_TITLE_MAX} required data-autofocus onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="pb-ahead-field" htmlFor={`${id}-date`}>
              <span className="label">Day</span>
              <input id={`${id}-date`} className="pb-input pb-ahead-day-input" type="date" min={today} value={day} required onChange={(e) => setDay(e.target.value)} />
            </label>
            {error && <p className="pb-hint app-hint-error" role="alert">{error}</p>}
            <div className="pb-dialog-actions">
              <button type="button" className="pb-btn pb-btn-quiet" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="pb-btn pb-btn-primary" disabled={busy || !day || !title.trim()}>Add to Ahead</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
