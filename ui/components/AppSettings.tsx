// The settings page for Pobots as a whole, reached from the foot of the roster. It stands in the
// reading panel over the open bot's or channel's page, which stays where it was underneath, so going
// back shows it unchanged. Sections in the same language as a bot's Settings tab: "Notifications"
// first (job 4), then "When a bot is working" (steering, protocol 14), then "Backup" (job 5), whose
// list of runs stays the last thing on the page.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BackupRun, BackupState, FollowUp, NotifyDevice, NotifyKind, NotifyState } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import {
  backupLine,
  backupLines,
  FOLDER_PROBLEMS,
  folderWords,
  hasOlderKeyBackups,
  keyFacts,
  looksPrivate,
  nextLine,
  NO_KEY_NEXT,
  OLD_KEY_LINE,
  PRIVATE_KEY_REFUSAL,
  RUN_REFUSALS,
  RUN_WORD,
  runNote,
} from "../lib/backup";
import { useNow, useSaver, type SaveState } from "../lib/hooks";
import { clockTime } from "../lib/words";
import {
  allowSteps,
  ASKS_ONCE,
  deviceLine,
  HERE_LINE,
  HOW_TO_ALLOW,
  INTRO,
  IOS_STEPS,
  KINDS,
  KINDS_NOTE,
  LIVE_STATES,
  RESULT_ROOM,
  SEND_TEST,
  SENDING,
  TURN_OFF,
  TURN_ON,
  type Here,
} from "../lib/notify";
import { preparePush, sendTest, turnOff, turnOn, usePush, type PushView } from "../lib/push";
import { forgetNotifyDevice, runBackup, setBackupKey, setFollowUp, setNotifyKinds } from "../state/actions";
import { FOLLOW_UP_INTRO, FOLLOW_UP_OTHER, FOLLOW_UP_TITLE, FOLLOW_UPS } from "../lib/steer";
import { radioKeys } from "./SettingsView";
import { usePhone } from "../lib/phone";
import { phoneBack } from "../state/screens";
import { store, useAppState, type SettingsSection } from "../state/store";
import { CheckIcon, CloseIcon, GearIcon, Mark } from "./bits";
import { keepTabInside } from "./Dialog";
import { ChatsSection, ProvidersSection } from "./SettingsWindow";
import { UsageSection } from "./usage/UsageSection";
import { PhoneBack } from "./PhoneBack";
import { CalendarSection } from "./CalendarSection";
import { ActivityView } from "./ActivityView";
import { AboutYouSection } from "./AboutYouSection";

/** The parts of the General section, in order. A new part is one more entry here. */
const SECTIONS: { id: string; render: () => ReactNode }[] = [
  // Engine 0.33.0: the note about the person every bot gets, first.
  { id: "about", render: () => <AboutYouSection /> },
  { id: "notify", render: () => <NotifySection /> },
  { id: "chat", render: () => <FollowUpSection /> },
  { id: "backup", render: () => <BackupSection /> },
];

/** Step 7b: the window's sections, as T3 Code's settings list them on the left. */
const WINDOW_SECTIONS: { id: SettingsSection; label: string; render: () => ReactNode }[] = [
  {
    id: "general",
    label: "General",
    render: () => (
      <div className="pb-settings">
        {SECTIONS.map((s) => (
          <div key={s.id} className="pb-appsettings-section" data-section={s.id}>
            {s.render()}
          </div>
        ))}
      </div>
    ),
  },
  { id: "chats", label: "Chats", render: () => <div className="pb-settings"><ChatsSection /></div> },
  { id: "providers", label: "Providers", render: () => <div className="pb-settings"><ProvidersSection /></div> },
  { id: "calendar", label: "Calendar", render: () => <div className="pb-settings"><CalendarSection /></div> },
  { id: "usage", label: "Usage", render: () => <UsageSection /> },
  // Protocol 22: a day's activity, read only, as T3 Code lists its Diagnostics page among its settings.
  { id: "activity", label: "Activity", render: () => <div className="pb-settings"><ActivityView /></div> },
];

/**
 * The settings window (step 7b): on a computer a window over the app, with the sections on the left
 * (T3 Code's settings); on a phone a full-screen sheet, the sections as a row of tabs at the top. The
 * bot's or channel's page stays where it is underneath. Its General section holds what "Pobots
 * settings" held before.
 */
export function AppSettingsPage() {
  const heading = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const section = useAppState((s) => s.appSettingsSection);
  /** What had the focus when the window opened: it gets the focus back when the window closes. */
  const opener = useRef<Element | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const navBox = useRef<HTMLElement>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    heading.current?.focus({ preventScroll: true });
  }, []);
  // Another section starts at its top. On a phone the row of tabs scrolls sideways: the chosen one is
  // brought into it, at once, so a section past the screen's edge (Activity at 360 px) is seen chosen.
  // Again once the fonts are in: a window opened straight on Settings measures the tabs a little
  // narrower before its font has loaded.
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
    let gone = false;
    const bring = () => {
      const nav = navBox.current;
      const tab = nav?.querySelector<HTMLElement>(`.pb-setwin-tab[data-section="${section}"]`);
      if (gone || !nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
      const n = nav.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      if (t.right > n.right) nav.scrollLeft += t.right - n.right + 12;
      else if (t.left < n.left) nav.scrollLeft -= n.left - t.left + 12;
    };
    bring();
    document.fonts?.ready.then(bring, () => {});
    return () => {
      gone = true;
    };
  }, [section]);

  const phone = usePhone();
  const back = () => {
    // On a phone the window is a sheet and a history entry: back is the browser's back.
    if (phone) return phoneBack();
    const to = opener.current;
    store.closeAppSettings();
    // After the window is gone: back to what opened it, or to the gear at the foot of the roster.
    requestAnimationFrame(() => {
      const target = to instanceof HTMLElement && to !== document.body && to.isConnected && !to.closest(".app-appsettings") ? to : document.querySelector<HTMLElement>(".pb-foot-settings");
      target?.focus({ preventScroll: true });
    });
  };
  const at = Math.max(0, WINDOW_SECTIONS.findIndex((x) => x.id === section));
  const pick = (i: number, focus = false) => {
    const next = WINDOW_SECTIONS[(i + WINDOW_SECTIONS.length) % WINDOW_SECTIONS.length]!;
    store.setSettingsSection(next.id);
    // The arrow keys move the focus with the choice; a click leaves it where the click put it.
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.pb-setwin-tab[data-section="${next.id}"]`)?.focus({ preventScroll: true }));
  };
  const current = WINDOW_SECTIONS[at]!;

  const body = (
    <>
      <header className="pb-main-head app-head pb-appsettings-head">
        {phone && <PhoneBack />}
        <span className="pb-who pb-who-mark pb-who-lg" aria-hidden="true">
          <GearIcon />
        </span>
        <div className="app-head-text">
          <h1 ref={heading} tabIndex={-1} className="pb-appsettings-title">
            Settings
          </h1>
          <div className="pb-row-line">For the whole app, not one bot</div>
        </div>
        {!phone && (
          <button type="button" className="pb-icon-btn pb-appsettings-back" onClick={back} aria-label="Close settings" title="Close settings">
            <CloseIcon />
          </button>
        )}
      </header>
      <div className="pb-setwin-body">
        <nav ref={navBox} className="pb-setwin-nav" aria-label="Sections">
          <div
            className="pb-setwin-tabs"
            role="tablist"
            aria-orientation={phone ? "horizontal" : "vertical"}
            onKeyDown={(e) => {
              const prev = phone ? "ArrowLeft" : "ArrowUp";
              const next = phone ? "ArrowRight" : "ArrowDown";
              if (e.key === prev || e.key === next) {
                e.preventDefault();
                pick(at + (e.key === next ? 1 : -1), true);
              }
            }}
          >
            {WINDOW_SECTIONS.map((x, i) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                className="pb-setwin-tab"
                data-section={x.id}
                id={`setwin-tab-${x.id}`}
                aria-selected={x.id === current.id}
                aria-controls="setwin-panel"
                tabIndex={x.id === current.id ? 0 : -1}
                onClick={() => pick(i)}
              >
                {x.label}
              </button>
            ))}
          </div>
        </nav>
        <div ref={scroll} className="app-view pb-main-scroll app-appsettings-scroll" role="tabpanel" id="setwin-panel" aria-labelledby={`setwin-tab-${current.id}`} data-section={current.id}>
          {current.render()}
        </div>
      </div>
    </>
  );

  // Escape also closes when the focus was lost to the page (the control that had it went away, such as a removed hub).
  const backNow = useRef(back);
  backNow.current = back;
  useEffect(() => {
    const onDoc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && (document.activeElement === document.body || !document.activeElement)) {
        e.preventDefault();
        backNow.current();
      }
    };
    document.addEventListener("keydown", onDoc);
    return () => document.removeEventListener("keydown", onDoc);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Escape closes, unless it belongs to a field.
    if (e.key === "Escape" && !e.defaultPrevented) {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      e.preventDefault();
      back();
      return;
    }
    if (!phone && box.current) keepTabInside(e, box.current);
  };

  if (phone)
    return (
      <main className="pb-main app-main app-appsettings" aria-label="Settings" onKeyDown={onKeyDown}>
        {body}
      </main>
    );
  return (
    <div
      className="pb-scrim pb-setwin-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) back();
      }}
    >
      <div ref={box} className="pb-setwin app-appsettings" role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={onKeyDown}>
        {body}
      </div>
    </div>
  );
}

/** The quiet word beside a title: "Saved" for a moment. Fades, never moves. */
function SavedWord({ state }: { state: SaveState }) {
  const show = state.phase === "saved";
  return (
    <span className="pb-saved" role="status" data-show={show || undefined} aria-hidden={!show || undefined}>
      Saved
    </span>
  );
}

/**
 * Words that take turns in one place: every one is laid out in the same cell, only the shown one is
 * seen and read out, so the box keeps the size of the longest and nothing around it moves.
 */
function Swap({ lines, shown, className = "", lineClass = "" }: { lines: string[]; shown: string; className?: string; lineClass?: string | ((line: string) => string) }) {
  const all = lines.includes(shown) ? lines : [...lines, shown];
  return (
    <span className={`pb-swap ${className}`.trim()}>
      {all.map((line) => (
        <span
          key={line}
          className={`pb-swap-line ${typeof lineClass === "function" ? lineClass(line) : lineClass}`.trim()}
          data-show={line === shown || undefined}
          aria-hidden={line !== shown || undefined}
        >
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * "When a bot is working" (steering, protocol 14): what a message sent while a bot is in a turn does
 * by default. Steer or Queue, as a choice list like a bot's access level; it saves at once. The words
 * follow T3 Code's "Follow-up behavior".
 */
function FollowUpSection() {
  const chosen = useAppState((s) => s.chat.followUp);
  const [state, save] = useSaver();
  /** What he chose while the engine has not answered yet. */
  const [want, setWant] = useState<FollowUp | null>(null);
  const shown = want ?? chosen;
  const at = Math.max(0, FOLLOW_UPS.findIndex((f) => f.id === shown));
  const pick = (i: number) => {
    const next = FOLLOW_UPS[i]!.id;
    if (next === shown) return;
    setWant(next);
    void save(() => setFollowUp(next)).then(() => setWant(null));
  };
  const problem = state.phase === "error" ? state.message : "";
  return (
    <section className="pb-section pb-followup" aria-labelledby="set-followup">
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set-followup">
          {FOLLOW_UP_TITLE}
        </h2>
        <SavedWord state={state} />
      </div>
      <p className="pb-section-text">{FOLLOW_UP_INTRO}</p>
      <div className="pb-choices" role="radiogroup" aria-labelledby="set-followup" onKeyDown={(e) => radioKeys(e, FOLLOW_UPS.length, at, pick, 1)}>
        {FOLLOW_UPS.map((f, i) => (
          <button key={f.id} className="pb-choice" type="button" role="radio" data-follow={f.id} aria-checked={f.id === shown} tabIndex={i === at ? 0 : -1} onClick={() => pick(i)}>
            <span className="pb-choice-label">{f.label}</span>
            <span className="pb-choice-hint">{f.hint}</span>
            {f.id === shown && <CheckIcon />}
          </button>
        ))}
      </div>
      <p className="pb-hint pb-followup-other">{FOLLOW_UP_OTHER}</p>
      {/* Keeps its room, so a choice that could not be saved moves nothing below. */}
      <p className="pb-hint pb-followup-problem" role={problem ? "alert" : undefined}>
        <Swap lines={[NOT_REACHED, ""]} shown={problem} lineClass="app-hint-error" />
      </p>
    </section>
  );
}

const TONE_MARK = { none: "idle", running: "idle", saved: "check", unconfirmed: "idle", failed: "blocked" } as const;

function BackupSection() {
  const stored = useAppState((s) => s.backup);
  const now = new Date(useNow(30_000));
  /** "Back up now" was pressed and the engine has not answered yet: every line says so at once. */
  const [asking, setAsking] = useState(false);
  const backup = stored && asking && stored.key && !stored.running ? { ...stored, running: true } : stored;
  if (!backup)
    return (
      <section className="pb-section" aria-labelledby="set-backup">
        <h2 className="pb-section-title" id="set-backup">
          Backup
        </h2>
        <p className="pb-section-text">Pobots has not said how the backup stands yet.</p>
      </section>
    );
  const line = backupLine(backup, now);
  return (
    <section className="pb-section pb-backup" aria-labelledby="set-backup" data-key={backup.key ? "set" : "none"}>
      <h2 className="pb-section-title" id="set-backup">
        Backup
      </h2>
      <p className="pb-section-text">{`Every night at ${backup.time} Pobots packs all chats, every bot's folder and the settings into one locked file and puts it in your OneDrive. Only your key in 1Password can open it. The last ${backup.keep} nights are kept.`}</p>
      <div className="pb-backup-state">
        <p className="pb-backup-line" data-tone={line.tone} role="status">
          <Mark state={TONE_MARK[line.tone]} />
          <Swap lines={backupLines(backup, now)} shown={line.text} className="pb-backup-line-text" />
        </p>
        <p className="pb-backup-next" id="backup-next">
          <Swap lines={[NO_KEY_NEXT, nextLine({ ...backup, key: backup.key ?? { fingerprint: "", bits: 0, savedAt: "" } }, now)]} shown={nextLine(backup, now)} />
        </p>
        <BackUpNow backup={backup} onAsking={setAsking} />
      </div>
      <KeyBlock backup={backup} />
      <div className="pb-backup-part" aria-labelledby="backup-folder">
        <h3 className="pb-backup-part-title" id="backup-folder">
          Where the files go
        </h3>
        <p className="pb-backup-folder" title={backup.folder.path} aria-describedby="backup-folder-path">
          {folderWords(backup.folder.path)}
        </p>
        <span id="backup-folder-path" hidden>
          {backup.folder.path}
        </span>
        {/* The line for a folder problem keeps its room in every state, so a run that finds the folder gone moves nothing below. */}
        <p className="pb-hint pb-backup-folder-problem" role={backup.folder.ok ? undefined : "alert"}>
          <Swap lines={[...FOLDER_PROBLEMS, ""]} shown={backup.folder.ok ? "" : (backup.folder.problem ?? FOLDER_PROBLEMS[0]!)} lineClass="app-hint-error" />
        </p>
      </div>
      <Runs history={backup.history} />
    </section>
  );
}

/** "Back up now", "Backing up" while it runs, at one size. Its error stands beside it. */
function BackUpNow({ backup, onAsking }: { backup: BackupState; onAsking: (asking: boolean) => void }) {
  const [error, setError] = useState<string>();
  const running = backup.running;
  const off = !backup.key || running;
  const press = () => {
    if (off) return;
    setError(undefined);
    onAsking(true);
    runBackup()
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => onAsking(false));
  };
  return (
    <div className="pb-backup-act">
      <button
        type="button"
        className="pb-btn pb-btn-sm pb-backup-now"
        aria-disabled={off || undefined}
        aria-describedby={!backup.key ? "backup-next" : undefined}
        data-running={running || undefined}
        onClick={press}
      >
        <Swap lines={["Back up now", "Backing up"]} shown={running ? "Backing up" : "Back up now"} />
      </button>
      {/* Beside the button, in a box that keeps the room of the engine's longest answer. */}
      <span className="pb-hint pb-backup-act-error" role={error ? "alert" : undefined}>
        <Swap lines={[...RUN_REFUSALS, ""]} shown={error ?? ""} lineClass="app-hint-error" />
      </span>
    </div>
  );
}

/** A made-up fingerprint of the real length, so the place the fingerprint takes is kept before there is one. */
const FINGERPRINT_ROOM = `SHA256:${"0".repeat(43)}`;

const SETUP_TEXT =
  "In your private vault in 1Password, make an SSH Key of the kind RSA, 4096 bits. Copy its public key and paste it below. The private key stays in 1Password, so only you can open the backups.";
const COMPARE_TEXT = "Compare this with the fingerprint in 1Password. If they are the same, new backups are locked to this key. To use another key, paste its public key below.";
/** The steps behind "How to make a key", the same with or without a key. */
const HOW_STEPS = [
  "In 1Password, open your private vault and choose New Item, then SSH Key.",
  "Choose Add Private Key, then Generate a New Key, of the kind RSA and the size 4096. Save it.",
  "Copy its public key, paste it in the field above and press Save key.",
];
const HOW_NOTE = "The key belongs in your private vault, not in a shared one. The private key never leaves 1Password: Pobots only needs the public key, which can lock backups but not open them.";
const FIELD_HINT = "One line that starts with ssh-rsa. It can only lock backups, not open them.";

/**
 * The key: what to do when there is none, or the saved key's fingerprint to compare with 1Password;
 * then the field to paste a public key, and under it the engine's plain refusal. Every part keeps
 * its box in both states, so saving a key changes words in place.
 */
function KeyBlock({ backup }: { backup: BackupState }) {
  const [value, setValue] = useState("");
  const [refusal, setRefusal] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [state, saved] = useSaver();
  const [how, setHow] = useState(false);
  const key = backup.key;
  const older = hasOlderKeyBackups(backup);
  const now = new Date(useNow(60_000));

  const save = async () => {
    if (busy) return;
    setRefusal(undefined);
    setBusy(true);
    const ok = await saved(() => setBackupKey(value));
    setBusy(false);
    if (ok) setValue("");
  };
  // A refusal comes back from the save as its state; it is shown under the field, not by the title.
  useEffect(() => {
    if (state.phase === "error") setRefusal(state.message);
  }, [state]);

  const note = refusal ?? FIELD_HINT;
  return (
    <div className="pb-backup-part pb-backup-key" aria-labelledby="backup-key">
      <div className="pb-section-head">
        <h3 className="pb-backup-part-title" id="backup-key">
          Your key
        </h3>
        <SavedWord state={state} />
      </div>
      <p className="pb-section-text pb-backup-key-text">
        <Swap lines={[SETUP_TEXT, COMPARE_TEXT]} shown={key ? COMPARE_TEXT : SETUP_TEXT} />
      </p>
      <div className="pb-backup-print" data-set={key ? "" : undefined}>
        <span className="pb-backup-print-label">Fingerprint</span>
        {/* The fingerprint and its facts change in place, without a fade: the old one stays readable until the new one stands in its box. */}
        <span className="pb-backup-print-text">
          <span className="pb-swap-line pb-swap-room" aria-hidden="true">
            {FINGERPRINT_ROOM}
          </span>
          <span className="pb-swap-line pb-swap-still" data-show="">
            {key ? key.fingerprint : "No key yet"}
          </span>
        </span>
        <span className="pb-backup-print-facts">
          <span className="pb-swap-line pb-swap-still" data-show="">
            {key ? keyFacts(key, now) : "Add a key to see it here."}
          </span>
        </span>
        <Swap className="pb-backup-print-old" lines={[OLD_KEY_LINE, ""]} shown={older ? OLD_KEY_LINE : ""} />
      </div>
      <div className="pb-field pb-field-wide">
        <label className="pb-label" htmlFor="backup-public-key">
          {key ? "New public key" : "Public key"}
        </label>
        <div className="pb-backup-paste">
          <textarea
            id="backup-public-key"
            className="pb-input pb-textarea pb-backup-input"
            rows={3}
            value={value}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder="ssh-rsa AAAA..."
            aria-describedby="backup-key-note"
            aria-invalid={refusal ? true : undefined}
            onChange={(e) => {
              const text = e.target.value;
              // A private key is never kept, not even in the field: it is refused here and never sent.
              if (looksPrivate(text)) {
                setValue("");
                setRefusal(PRIVATE_KEY_REFUSAL);
                return;
              }
              setValue(text);
              if (text.trim()) setRefusal(undefined);
            }}
            onKeyDown={(e) => {
              // A key is one line: Enter saves it.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <button type="button" className="pb-btn pb-btn-sm pb-backup-save" aria-disabled={busy || undefined} onClick={() => void save()}>
            Save key
          </button>
        </div>
        <span className="pb-backup-note" id="backup-key-note" role={refusal ? "alert" : undefined}>
          <Swap lines={[FIELD_HINT, note]} shown={note} lineClass={(l) => (l === refusal ? "app-hint-error" : "")} />
        </span>
      </div>
      {/* Last in the key part: the steps open below it, so nothing above moves. */}
      <div className="pb-backup-how">
        <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-backup-how-toggle" aria-expanded={how} aria-controls="backup-how" onClick={() => setHow((v) => !v)}>
          How to make a key
        </button>
        {how && (
          <div className="pb-backup-how-steps pb-fade-in" id="backup-how">
            <ol className="pb-backup-how-list">
              {HOW_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="pb-section-text pb-backup-how-note">{HOW_NOTE}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The recent runs as quiet lines, oldest first and the newest at the bottom, like the chat: a new
 * run is added below everything, so no line he is reading moves. The list is the last thing on the
 * page. A run that leaves the engine's list (after 14) stays where it stands while the page is open,
 * marked "No longer kept", so the lines below it do not move up either.
 */
function Runs({ history }: { history: BackupRun[] }) {
  const now = useNow(60_000);
  // A line that came while the page is open fades in where it stands; lines shown before do not arrive again.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(history.map((r) => r.at + r.status));
  const shown = seen.current;
  useEffect(() => {
    for (const r of history) shown.add(r.at + r.status);
  }, [history, shown]);
  /** Every run shown since the page opened, by its time. */
  const kept = useRef(new Map<string, BackupRun>());
  for (const r of history) kept.current.set(r.at, r);
  const current = new Set(history.map((r) => r.at));
  const rows = [...kept.current.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <div className="pb-backup-part" aria-labelledby="backup-runs">
      <h3 className="pb-backup-part-title" id="backup-runs">
        Recent backups
      </h3>
      {rows.length === 0 ? (
        <p className="pb-section-text">No backups yet.</p>
      ) : (
        <ul className="pb-runs pb-backup-runs">
          {rows.map((run) => {
            const gone = !current.has(run.at);
            return (
              <li key={run.at} className={`pb-run${shown.has(run.at + run.status) || gone ? "" : " pb-fade-in"}`} data-status={run.status} data-gone={gone || undefined}>
                <div className="pb-run-row">
                  <Mark state={gone ? "idle" : run.status === "saved" ? "check" : run.status === "failed" ? "blocked" : "idle"} />
                  <span className="pb-run-text">
                    <span className="pb-run-word">{gone ? "No longer kept" : RUN_WORD[run.status]}</span>
                    <span className={`pb-run-note${run.status === "failed" ? " pb-run-note-full" : ""}`}>{runNote(run)}</span>
                  </span>
                  <time className="pb-time" dateTime={run.at}>
                    {clockTime(run.at, new Date(now))}
                  </time>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ================================================================ notifications (job 4)
//
// docs/build/step-push.md and the groundwork's section 5. Three parts: "This device" (a status line
// with its mark, one row of actions, one line under it that keeps its room), "What to tell you"
// (three switches, for all devices) and "Your devices" (oldest first, so a new one comes at the
// bottom). Every line that changes keeps its box; what opens does so below what he reads. The page
// never asks the browser for permission by itself: only his press on "Turn on for this device".

const HERE_MARK: Record<Here, "check" | "blocked" | "waiting" | "idle"> = {
  desktop: "idle",
  insecure: "idle",
  cannot: "idle",
  "ios-browser": "idle",
  "ios-old": "idle",
  checking: "idle",
  off: "idle",
  asking: "waiting",
  blocked: "blocked",
  on: "check",
};

function NotifySection() {
  const notify = useAppState((s) => s.notify);
  const push = usePush();
  // The service worker gets ready while he reads, so "Turn on" works from the first press.
  useEffect(() => preparePush(), []);
  return (
    <section className="pb-section pb-notify" aria-labelledby="set-notify" data-here={push.here}>
      <h2 className="pb-section-title" id="set-notify">
        Notifications
      </h2>
      <p className="pb-section-text">{INTRO}</p>
      <ThisDevice push={push} />
      {notify ? (
        <>
          <Kinds notify={notify} />
          <Devices notify={notify} own={push.ownId} />
        </>
      ) : (
        <p className="pb-section-text">Pobots has not said how notifications stand yet.</p>
      )}
    </section>
  );
}

/** "This device": what this browser can do, the action for it, and one line for how it went. */
function ThisDevice({ push }: { push: PushView }) {
  const here = push.here;
  const live = LIVE_STATES.includes(here);
  const [result, setResult] = useState<{ text: string; error: boolean }>({ text: "", error: false });
  const [busy, setBusy] = useState<"" | "on" | "off" | "test">("");
  const [how, setHow] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const howButton = useRef<HTMLButtonElement>(null);
  const was = useRef(here);
  // A button that held the focus can leave with the state (Turn off, or a "no" in the browser's
  // question): the focus goes to the action that stands there now, never to the page's start.
  useEffect(() => {
    if (was.current === here) return;
    was.current = here;
    if (here !== "blocked") setHow(false);
    if (document.activeElement && document.activeElement !== document.body) return;
    (here === "blocked" ? howButton.current : primary.current)?.focus({ preventScroll: true });
  }, [here]);

  const say = (text: string, error = false) => setResult({ text, error });
  const on = () => {
    if (busy || here === "asking" || here === "checking" || !push.ready) return;
    say("");
    setBusy("on");
    // Straight from the press, nothing awaited before it: an iPhone asks only from a tap.
    void turnOn().then((r) => {
      setBusy("");
      if (r.problem) say(r.problem, true);
    });
  };
  const off = () => {
    if (busy) return;
    say("");
    setBusy("off");
    void turnOff().then((r) => {
      setBusy("");
      if (r.problem) say(r.problem, true);
    });
  };
  const test = () => {
    if (busy) return;
    say("");
    setBusy("test");
    void sendTest().then((line) => {
      setBusy("");
      say(line, !line.startsWith("Sent at"));
    });
  };

  const isOn = here === "on";
  const shownLine = result.text || ((here === "off" || here === "asking") && push.notAsked ? ASKS_ONCE : "");
  const primaryWord = isOn ? (busy === "test" ? SENDING : SEND_TEST) : TURN_ON;
  const primaryOff = isOn ? !!busy : !!busy || here === "asking" || here === "checking" || !push.ready;
  return (
    <div className="pb-backup-part pb-notify-device-part" aria-labelledby="notify-here">
      <h3 className="pb-backup-part-title" id="notify-here">
        This device
      </h3>
      <p className="pb-notify-line" data-here={here} role="status">
        <Mark state={HERE_MARK[here]} />
        <Swap lines={live ? LIVE_STATES.map((h) => HERE_LINE[h]) : [HERE_LINE[here]]} shown={HERE_LINE[here]} className="pb-notify-line-text" />
      </p>
      {here === "ios-browser" && (
        <ol className="pb-notify-steps pb-notify-ios" aria-label="How to add Pobots to the home screen">
          {IOS_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {live && (
        <>
          <div className="pb-notify-act">
            {here === "blocked" ? (
              <button
                ref={howButton}
                type="button"
                className="pb-btn pb-btn-sm pb-btn-quiet pb-notify-how"
                aria-expanded={how}
                aria-controls="notify-allow"
                onClick={() => setHow((v) => !v)}
              >
                {HOW_TO_ALLOW}
              </button>
            ) : (
              // One button for "Turn on" and "Send a test", so the focus stays on it when the state changes.
              // "Send a test" and "Sending" take turns at one size; "Turn on" has its own, so on a phone
              // "Send a test" and "Turn off for this device" fit on one row.
              <button
                ref={primary}
                type="button"
                className={`pb-btn pb-btn-sm pb-notify-primary${isOn ? " pb-notify-test" : " pb-notify-on"}`}
                aria-disabled={primaryOff || undefined}
                aria-describedby={!isOn && shownLine === ASKS_ONCE ? "notify-note" : undefined}
                data-busy={busy || undefined}
                onClick={isOn ? test : on}
              >
                <Swap lines={isOn ? [SEND_TEST, SENDING] : [TURN_ON]} shown={primaryWord} />
              </button>
            )}
            {isOn && (
              <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-notify-off" aria-disabled={busy ? true : undefined} onClick={off}>
                {TURN_OFF}
              </button>
            )}
          </div>
          {/* One line under the actions that keeps the room of the longest it says: the hint, a test's result, or what went wrong. */}
          <p className="pb-notify-note" id="notify-note" role={result.error ? "alert" : undefined}>
            <Swap lines={[...RESULT_ROOM, ""]} shown={shownLine} lineClass={(l) => (result.error && l === result.text ? "app-hint-error" : "")} />
          </p>
          {/* Last in this part: the steps open below everything else in it. */}
          {here === "blocked" && how && (
            <ul className="pb-notify-steps pb-notify-allow pb-fade-in" id="notify-allow">
              {allowSteps(push.platform).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** "What to tell you": three switches, for all devices. Each changes at once and saves itself. */
function Kinds({ notify }: { notify: NotifyState }) {
  const [state, saved] = useSaver();
  /** What he switched to while the engine has not answered yet. */
  const [want, setWant] = useState<Partial<Record<NotifyKind, boolean>>>({});
  const toggle = (kind: NotifyKind, on: boolean) => {
    setWant((w) => ({ ...w, [kind]: on }));
    void saved(() => setNotifyKinds({ [kind]: on })).then(() =>
      setWant((w) => {
        const next = { ...w };
        delete next[kind];
        return next;
      }),
    );
  };
  const problem = state.phase === "error" ? state.message : "";
  return (
    <div className="pb-backup-part pb-notify-kinds-part" aria-labelledby="notify-kinds">
      <div className="pb-section-head">
        <h3 className="pb-backup-part-title" id="notify-kinds">
          What to tell you
        </h3>
        <SavedWord state={state} />
      </div>
      <p className="pb-notify-kinds-note">{KINDS_NOTE}</p>
      <ul className="pb-notify-kinds">
        {KINDS.map(({ kind, label, hint }) => (
          <li key={kind}>
            <label className="pb-notify-kind">
              <span className="pb-notify-kind-text">
                <span className="pb-notify-kind-name">{label}</span>
                <span className="pb-hint" id={`notify-kind-${kind}`}>
                  {hint}
                </span>
              </span>
              <input
                className="pb-switch"
                type="checkbox"
                role="switch"
                data-kind={kind}
                checked={want[kind] ?? notify.kinds[kind]}
                aria-label={label}
                aria-describedby={`notify-kind-${kind}`}
                onChange={(e) => toggle(kind, e.target.checked)}
              />
            </label>
          </li>
        ))}
      </ul>
      {/* Keeps its room, so a switch that could not be saved moves nothing below. */}
      <p className="pb-hint pb-notify-kinds-problem" role={problem ? "alert" : undefined}>
        <Swap lines={[NOT_REACHED, ""]} shown={problem} lineClass="app-hint-error" />
      </p>
    </div>
  );
}

/** The client's sentence when the engine cannot be reached (ui/engine/ws-client.ts): the room the problem line keeps. */
const NOT_REACHED = "The engine is not reachable right now. Try again in a moment.";

/** "Your devices": oldest first, so a new one comes at the bottom and nothing above it moves. */
function Devices({ notify, own }: { notify: NotifyState; own: string | null }) {
  const now = new Date(useNow(60_000));
  const [problem, setProblem] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const forget = (d: NotifyDevice, at: number) => {
    setProblem("");
    forgetNotifyDevice(d.id)
      .then(() =>
        // The row is gone: the focus goes to the next row's Forget, else the one before, else the title.
        requestAnimationFrame(() => {
          const buttons = list.current ? [...list.current.querySelectorAll<HTMLButtonElement>(".pb-notify-forget")] : [];
          (buttons[at] ?? buttons[at - 1] ?? title.current)?.focus({ preventScroll: true });
        }),
      )
      .catch((e: unknown) => setProblem(messageOf(e)));
  };
  return (
    <div className="pb-backup-part pb-notify-devices-part" aria-labelledby="notify-devices">
      <h3 ref={title} tabIndex={-1} className="pb-backup-part-title" id="notify-devices">
        Your devices
      </h3>
      {notify.devices.length === 0 ? (
        <p className="pb-section-text pb-notify-none">No devices yet.</p>
      ) : (
        <ul ref={list} className="pb-notify-devices">
          {notify.devices.map((d, i) => (
            <li key={d.id} className="pb-notify-device" data-id={d.id} data-gone={d.goneAt ? "" : undefined} data-problem={!d.goneAt && d.last && d.last.result !== "sent" ? "" : undefined}>
              <span className="pb-notify-device-name">
                <span className="pb-notify-device-label">{d.label}</span>
                {d.id === own && <span className="pb-notify-device-here">This device</span>}
              </span>
              <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-notify-forget" aria-label={`Forget ${d.label}`} onClick={() => forget(d, i)}>
                Forget
              </button>
              <span className="pb-notify-device-line">{deviceLine(d, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="pb-hint app-hint-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
