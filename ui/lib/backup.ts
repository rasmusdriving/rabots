// The nightly backup's words, as the brief (docs/build/step-backup.md, decision 12) sets them:
// "Last night at 03:00, 3.2 MB, saved to OneDrive.", "Next backup tonight at 03:00." Plain words,
// kind with time, no jargon: "key", "public key", "fingerprint".
import type { BackupRun, BackupState } from "../../shared/protocol";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayOffset = (d: Date, days: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
};
/** Before this hour a time counts as "night". */
const NIGHT_ENDS = 6;
/** From this hour a time counts as "night" too. */
const NIGHT_STARTS = 18;

/** When a run was: "Last night at 03:00", "Today at 14:12", "Yesterday at 14:12", "12 Nov at 03:00". */
export function whenWas(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return d.getHours() < NIGHT_ENDS && now.getHours() >= NIGHT_ENDS ? `Last night at ${hm}` : `Today at ${hm}`;
  if (sameDay(d, dayOffset(now, -1))) {
    if (d.getHours() >= NIGHT_STARTS && now.getHours() < NIGHT_STARTS) return `Last night at ${hm}`;
    return `Yesterday at ${hm}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]} at ${hm}`;
}

/** When the next run is: "tonight at 03:00", "today at 14:00", "tomorrow at 15:00", "14 Nov at 03:00". */
export function whenNext(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const tomorrow = sameDay(d, dayOffset(now, 1));
  if ((sameDay(d, now) && d.getHours() < NIGHT_ENDS) || (tomorrow && d.getHours() < NIGHT_ENDS) || (sameDay(d, now) && d.getHours() >= NIGHT_STARTS)) return `tonight at ${hm}`;
  if (sameDay(d, now)) return `today at ${hm}`;
  if (tomorrow) return `tomorrow at ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} at ${hm}`;
}

/** The phrase in the middle of a sentence: "last night at 03:00", "12 Nov at 03:00". */
const inSentence = (phrase: string) => (/^(Last night|Today|Yesterday) /.test(phrase) ? phrase[0]!.toLowerCase() + phrase.slice(1) : phrase);

/** "480 KB", "3.2 MB", "1.2 GB". Decimal units, as Finder and OneDrive show them. */
export function sizeWord(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1).replace(/\.0$/, "")} GB`;
}

export type BackupTone = "none" | "running" | "saved" | "unconfirmed" | "failed";

/** Before any key is saved. */
export const NO_KEY_LINE = "No backups yet. Add a key to start.";
export const RUNNING_LINE = "Backing up now.";
export const NO_RUN_LINE = "No backups yet.";
/** Where the next line stands when no key is set. */
export const NO_KEY_NEXT = "Backups start once a key is saved.";

/** What a run's line says about it, as one sentence. */
export function runSentence(run: BackupRun, now = new Date()): string {
  return sentenceFor(run.status, whenWas(run.at, now), sizeWord(run.bytes));
}

function sentenceFor(status: BackupRun["status"], when: string, size: string): string {
  if (status === "saved") return [when, size, "saved to OneDrive."].filter(Boolean).join(", ");
  if (status === "unconfirmed") return `Made ${inSentence(when)}, but OneDrive has not confirmed it yet.`;
  // The reason is on the run's own line under "Recent backups", where it has room: a sentence of
  // unknown length here could not keep the status line's box.
  return `The backup ${inSentence(when)} failed. The reason is under Recent backups.`;
}

/** The file is made and in the folder; the engine waits for the Mac to say OneDrive has it (about a minute). */
function checkingSentence(when: string, size: string): string {
  return `Made ${inSentence(when)}${size ? `, ${size}` : ""}. Checking that OneDrive has it.`;
}

/**
 * The run whose file is made while its arrival is checked: the engine sends it as `lastGood`,
 * unconfirmed without a problem and newer than every finished run, while `running` is true.
 */
export function checkingRun(state: BackupState): BackupRun | undefined {
  const g = state.lastGood;
  if (!state.running || !g || g.status !== "unconfirmed" || g.problem || !g.file) return undefined;
  const last = state.history[0];
  return !last || g.at > last.at ? g : undefined;
}

/** The one status line at the top of the backup section, and its tone (for the mark). */
export function backupLine(state: BackupState, now = new Date()): { tone: BackupTone; text: string } {
  if (!state.key) return { tone: "none", text: NO_KEY_LINE };
  const checking = checkingRun(state);
  if (checking) return { tone: "running", text: checkingSentence(whenWas(checking.at, now), sizeWord(checking.bytes)) };
  if (state.running) return { tone: "running", text: RUNNING_LINE };
  const last = state.history[0];
  if (!last) return { tone: "none", text: NO_RUN_LINE };
  return { tone: last.status, text: runSentence(last, now) };
}

/** The longest ways a time can read, for keeping room: every kind of "when" at its widest. */
const WIDEST_WHENS = ["Last night at 00:00", "Yesterday at 00:00", "Today at 00:00", "28 Nov at 00:00"];

/**
 * Every sentence the status line could show, so its box keeps the height of the longest one: a line
 * that changes keeps its box, also when a run of another day or size takes the last one's place.
 */
export function backupLines(state: BackupState, now = new Date()): string[] {
  const size = sizeWord(state.history[0]?.bytes ?? state.lastGood?.bytes ?? 3_200_000);
  // One more digit than now, so a slightly larger file does not need more room.
  const wider = size.replace(/^(\d)/, "8$1");
  const out = [NO_KEY_LINE, RUNNING_LINE, NO_RUN_LINE, backupLine(state, now).text];
  for (const when of WIDEST_WHENS) {
    out.push(sentenceFor("saved", when, wider), sentenceFor("unconfirmed", when, ""), sentenceFor("failed", when, ""), checkingSentence(when, wider));
  }
  return [...new Set(out)];
}

/** "Next backup tonight at 03:00." */
export function nextLine(state: BackupState, now = new Date()): string {
  if (!state.key) return NO_KEY_NEXT;
  if (!state.nextAt) return `Backups run every night at ${state.time}.`;
  return `Next backup ${whenNext(state.nextAt, now)}.`;
}

/** The word on a run's row. */
export const RUN_WORD: Record<BackupRun["status"], string> = {
  saved: "Saved to OneDrive",
  unconfirmed: "Not confirmed by OneDrive",
  failed: "Failed",
};

/** The quiet line under a run's word: "3.2 MB · Nightly", or why it failed. */
export function runNote(run: BackupRun): string {
  if (run.status === "failed") return run.problem ?? "No file was made.";
  const parts = [sizeWord(run.bytes), run.by === "you" ? "By you" : "Nightly"];
  const left = run.leftOut?.length ?? 0;
  if (left > 0) parts.push(left === 1 ? "1 large file left out" : `${left} large files left out`);
  if (run.status === "unconfirmed" && run.problem) parts.push(run.problem);
  return parts.filter(Boolean).join(" · ");
}

/** "RSA 4096 · Saved today at 09:12". */
export function keyFacts(key: NonNullable<BackupState["key"]>, now = new Date()): string {
  return `RSA ${key.bits} · Saved ${inSentence(whenWas(key.savedAt, now))}`;
}

/**
 * The sentence the engine gives for a pasted private key (docs/build/notes-backup-groundwork.md,
 * section 2). The window says it itself and never sends such a text anywhere.
 */
export const PRIVATE_KEY_REFUSAL = "That is a private key. Paste the public key instead, and keep the private key in 1Password.";
/** The same test as the engine's (engine/backup-format.ts, parsePublicKeyLine), so both refuse the same texts. */
export const looksPrivate = (text: string): boolean => /PRIVATE KEY/i.test(text) || /^-----BEGIN/.test(text.trim()) || /PuTTY-User-Key-File/i.test(text);

/** Under the key, when the list holds backups made with an earlier key. */
export const OLD_KEY_LINE = "Backups made before you changed the key still need the old key.";

/**
 * Whether the recent backups hold files locked to an earlier key. A run does not say which key it
 * used, so a file made before the saved key's time was made with another one (no run is made
 * without a key).
 */
export function hasOlderKeyBackups(state: BackupState): boolean {
  const savedAt = state.key ? Date.parse(state.key.savedAt) : Number.NaN;
  if (!Number.isFinite(savedAt)) return false;
  return state.history.some((r) => r.status !== "failed" && Date.parse(r.at) < savedAt);
}

/**
 * The folder as a person says it: "OneDrive, folder Pobot / test-copy" for a folder in the Mac's
 * OneDrive, else the folder's last two names, "Documents / Backups". The full path is the tooltip.
 */
export function folderWords(path: string): string {
  const names = path.split("/").filter(Boolean);
  const cloud = names.findIndex((n, i) => n.startsWith("OneDrive") && names[i - 1] === "CloudStorage" && names[i - 2] === "Library");
  if (cloud >= 0) {
    const inside = names.slice(cloud + 1);
    return inside.length ? `OneDrive, folder ${inside.join(" / ")}` : "OneDrive";
  }
  const last = names.slice(-2);
  return last.length ? `Folder ${last.join(" / ")}` : path;
}

/**
 * The engine's sentences for a folder it cannot use (engine/backup.ts), so the line under "Where the
 * files go" keeps the room of the longest one whether a problem is shown or not.
 */
export const FOLDER_PROBLEMS = [
  "Pobots cannot write to the backup folder. Check that OneDrive is running on the Mac and that the folder is still there.",
  "No backup folder is set for this Pobots.",
  "The backup folder is not a folder.",
  "The backup folder may not be inside Pobots' own folders.",
  "Another Pobots keeps its backups in this folder. Set a folder of its own for this Pobots.",
  "The backup folder's note of which Pobots it belongs to cannot be read, so Pobots will not use that folder.",
];

/** The engine's answers when "Back up now" is refused, so the line beside the button keeps its room. */
export const RUN_REFUSALS = ["A backup is being made right now.", "Pobots is stopping, so no backup was started.", "Add a key first. No backups are made without one.", "A backup was made a moment ago. Try again in a minute."];
