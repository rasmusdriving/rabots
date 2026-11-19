import { useEffect, useState } from "react";
import type { BackupRun, BackupState } from "../../shared/protocol";
import { cleanPasswordRef, PASSWORD_MISSING, REF_PROBLEM, RESTIC_MISSING } from "../../shared/backup-settings";
import { messageOf } from "../engine/types";
import { backupLine, runNote, runWords } from "../lib/backup";
import { useNow } from "../lib/hooks";
import { clockTime, fileSize } from "../lib/words";
import { runBackup, setBackupPasswordRef } from "../state/actions";
import { useAppState } from "../state/store";
import { Mark } from "./bits";
import { Swap } from "./Swap";

const marker = (status?: BackupRun["status"]) => status === "saved" ? "check" : status === "failed" ? "blocked" : "idle";

export function BackupSection() {
  const backup = useAppState((s) => s.backup);
  const now = new Date(useNow(30_000));
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState("");
  if (!backup) return (
    <section className="pb-section" aria-labelledby="set-backup">
      <h2 className="pb-section-title" id="set-backup">Backup</h2>
      <p className="pb-section-text">Waiting for backup settings.</p>
    </section>
  );
  const last = backup.history[0];
  const running = asking || backup.running;
  const line = backupLine({ ...backup, running }, now);
  const next = backup.nextAt ? `Next backup ${clockTime(backup.nextAt, now)}.` : "No backup scheduled yet.";
  const count = backup.snapshots ?? 0;
  const title = backup.folder.iCloud ? "iCloud Drive" : "Local folder";
  const folder = backup.folder.path.split("/").filter(Boolean).at(-1) ?? "Not set";
  const size = backup.repositoryBytes === undefined ? "No backups yet" : fileSize(backup.repositoryBytes);
  async function start() {
    setAsking(true);
    setProblem("");
    try { await runBackup(); } catch (err) { setProblem(messageOf(err)); } finally { setAsking(false); }
  }
  return (
    <section className="pb-section pb-backup" aria-labelledby="set-backup">
      <h2 className="pb-section-title" id="set-backup">Backup</h2>
      <p className="pb-section-text">Every night at {backup.time}, Pobots backs up all chats, bot folders and settings. Restic encrypts the backup and stores only what changed. The last {backup.keep} nights are kept.</p>
      <div className="pb-backup-state">
        <p className="pb-backup-line" role="status">
          <Mark state={running ? "idle" : marker(last?.status)} />
          <Swap lines={[RESTIC_MISSING, PASSWORD_MISSING, "Backing up now.", "Made, upload not confirmed · Today at 03:00"]} shown={line} />
        </p>
        <p className="pb-backup-next">{next}</p>
        <div className="pb-backup-act">
          <button type="button" className="pb-btn pb-btn-sm pb-backup-now"
            disabled={running || !backup.passwordRef || !backup.resticInstalled}
            onClick={() => void start()}>
            <Swap lines={["Back up now", "Backing up"]} shown={running ? "Backing up" : "Back up now"} />
          </button>
        </div>
        <p className="pb-hint pb-backup-feedback" role={problem ? "alert" : undefined}>
          {problem || (last?.bytes !== undefined ? `${fileSize(last.bytes)} added in the last run.` : "")}
        </p>
      </div>
      <Reference backup={backup} />
      <div className="pb-backup-part">
        <h3 className="pb-backup-part-title small">Where it goes</h3>
        <p className="pb-backup-folder" title={backup.folder.path}>{title} · {folder}</p>
        <p className="pb-hint pb-backup-path">{backup.folder.path}</p>
        <p className="pb-hint">{size} · {count} {count === 1 ? "snapshot" : "snapshots"}</p>
        {backup.folder.problem && <p className="pb-hint app-hint-error">{backup.folder.problem}</p>}
      </div>
      <div className="pb-backup-part">
        <h3 className="pb-backup-part-title small">Recent backups</h3>
        <Runs history={backup.history} now={now} />
      </div>
    </section>
  );
}

function Reference({ backup }: { backup: BackupState }) {
  const [ref, setRef] = useState(backup.passwordRef ?? "");
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRef(backup.passwordRef ?? ""); }, [backup.passwordRef]);
  const hint = "Use a password item in a 1Password vault the Mac can read. Paste its reference here.";
  function edit(value: string) {
    setSaved(false);
    const trimmed = value.trimStart();
    if (!"op://".startsWith(trimmed) && !trimmed.startsWith("op://")) {
      setProblem(REF_PROBLEM);
      return;
    }
    setProblem("");
    setRef(trimmed);
  }
  async function save() {
    const text = ref.trim();
    if (text && !cleanPasswordRef(text)) {
      setProblem(REF_PROBLEM);
      return;
    }
    setBusy(true);
    setProblem("");
    try { await setBackupPasswordRef(text); setSaved(true); } catch (err) { setProblem(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <form className="pb-backup-part" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="pb-backup-part-title small" htmlFor="backup-password-ref">1Password reference</label>
      <p className="pb-section-text" id="backup-reference-hint">{hint}</p>
      <div className="pb-backup-paste">
        <input className="pb-input pb-backup-reference" id="backup-password-ref" value={ref}
          placeholder="op://vault/item/password" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={512}
          aria-describedby="backup-reference-hint backup-reference-result"
          onPaste={(event) => {
            event.preventDefault();
            const text = cleanPasswordRef(event.clipboardData.getData("text"));
            if (text) edit(text);
            else { setSaved(false); setProblem(REF_PROBLEM); }
          }}
          onChange={(event) => edit(event.currentTarget.value)} />
        <button type="submit" className="pb-btn pb-btn-sm pb-backup-save" disabled={busy || backup.running}>
          Save reference
        </button>
      </div>
      <p className="pb-hint pb-backup-feedback" id="backup-reference-result" role={problem ? "alert" : "status"}>
        <Swap lines={[REF_PROBLEM, "Saved", ""]} shown={problem || (saved ? "Saved" : "")} lineClass={problem ? "app-hint-error" : ""} />
      </p>
    </form>
  );
}

function Runs({ history, now }: { history: BackupRun[]; now: Date }) {
  // Keep older rows while the window is open, even when the engine's recent list rolls over.
  const [earlier, setEarlier] = useState<BackupRun[]>([]);
  const merge = (previous: BackupRun[], latest: BackupRun[]) => [...new Map(
    [...previous, ...latest].map((run) => [run.at, run]),
  ).values()].sort((a, b) => b.at.localeCompare(a.at));
  useEffect(() => { setEarlier((previous) => merge(previous, history)); }, [history]);
  const rows = merge(earlier, history);
  if (!rows.length) return <p className="pb-section-text">No backups yet.</p>;
  return (
    <ul className="pb-runs pb-backup-runs">
      {rows.map((run) => (
        <li key={run.at} className="pb-run" data-status={run.status}>
          <div className="pb-run-row">
            <Mark state={marker(run.status)} />
            <span className="pb-run-text">
              <span className="pb-run-word">{runWords[run.status]}</span>
              <span className="pb-run-note">{runNote(run)}</span>
              {run.problem && <span className="pb-run-note pb-run-note-full">{run.problem}</span>}
              {!!run.leftOut?.length && (
                <details className="pb-run-note pb-run-note-full">
                  <summary>Files left out</summary>
                  <ul>{run.leftOut.map((path) => <li key={path}>{path}</li>)}</ul>
                </details>
              )}
            </span>
            <time className="pb-time" dateTime={run.at}>{clockTime(run.at, now)}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}
