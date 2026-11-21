// Pobots itself in Providers, on a public install only (engine 0.34.0, docs/build/step-self-update.md):
// the running version, whether a newer one is out, and its Update button, which opens the same
// dialog as Claude Code's and Codex's. Built like their cards, so it sits calmly at the end of the list.
// Protocol 36: what the new version brings under its line (three bullets, then Show all), and after an
// update "What's new in 0.45.0", which opens in place.
import type { PobotsUpdateState } from "../../shared/protocol";
import { clockTime } from "../lib/words";
import { Mark } from "./bits";
import { ReleaseNotes, ThisVersionNotes } from "./ReleaseNotes";

export function PobotsUpdateCard({ s, running, onUpdate }: { s: PobotsUpdateState; running: boolean; onUpdate(): void }) {
  const can = s.available && s.canRestart;
  const latest = s.available
    ? s.canRestart
      ? `Pobots ${s.latest} is available.`
      : `Pobots ${s.latest} is available. Pobots cannot restart itself here: quit it, then run git pull and npm start in its folder.`
    : s.checkedAt
      ? "Up to date."
      : "Not looked for a new version yet.";
  const going = !!s.run && !s.run.endedAt;
  return (
    <div className="pb-set7-provider pb-set7-pobots" data-provider="pobots" data-on>
      <div className="pb-set7-provider-head">
        <Mark state={going ? "working" : "check"} />
        <span className="pb-set7-provider-name">Pobots</span>
      </div>
      <p className="pb-set7-provider-facts">{`Version ${s.current} · Updates from the public repository`}</p>
      {s.problem && <p className="pb-set7-provider-latest pb-set7-pobots-note">{s.problem}</p>}
      <div className="pb-set7-provider-update">
        <span className="pb-set7-provider-latest">{latest}</span>
        <button type="button" className="pb-btn pb-btn-sm pb-set7-update" data-hide={!can || undefined} aria-hidden={!can || undefined} tabIndex={can ? 0 : -1} aria-disabled={running || undefined} onClick={() => can && !running && onUpdate()}>
          Update
        </button>
      </div>
      {s.available && s.whatsNew?.length ? (
        <div className="pb-set7-pobots-notes">
          <p className="pb-relnotes-head">What's new</p>
          <ReleaseNotes notes={s.whatsNew} older={s.olderNotes ?? 0} limit={3} label={`What's new in Pobots ${s.latest ?? ""}`.trim()} />
        </div>
      ) : !s.available && s.thisVersion ? (
        <ThisVersionNotes note={s.thisVersion} />
      ) : null}
    </div>
  );
}

/** The Pobots update as it goes, and its last result (also the one from before the restart). */
export function PobotsRunLine({ s }: { s: PobotsUpdateState | undefined }) {
  const run = s?.run;
  if (!run) return null;
  return (
    <p className="pb-set7-run pb-set7-pobots-run" data-phase={run.phase} role="status">
      <Mark state={run.phase === "done" ? "check" : run.phase === "failed" ? "blocked" : "working"} />
      <span>{run.endedAt ? `Last update of Pobots, ${clockTime(run.endedAt)}: ${run.line}` : run.line}</span>
    </p>
  );
}
