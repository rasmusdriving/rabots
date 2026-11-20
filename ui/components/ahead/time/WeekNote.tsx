// The main bot's week note at the top of Ahead (part B): one, replaced never stacked. It comes with
// the Ahead settings (AheadSettings.weekNote), so it shows as soon as the main bot writes it.
import { useAppState } from "../../../state/store";

export function WeekNote() {
  const note = useAppState((s) => s.ahead?.weekNote);
  const main = useAppState((s) => s.bots.find((b) => b.role === "main"));
  if (!note?.text) return null;
  return (
    <section className="pb-ahead-week-note" aria-label="Week note" data-ahead-week-note="">
      <p className="pb-ahead-week-note-text">{note.text}</p>
      <p className="pb-ahead-week-note-from">{`From ${main?.name ?? "the main bot"}`}</p>
    </section>
  );
}
