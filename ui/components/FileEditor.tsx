// The in-app editor for one file in a bot's folder: the job, a memory file, a skill.
// Plain text in a well that fills the space. "Save" is the one accent button and only lights up
// when something changed. When the file changed underneath (a conflict on save, or the bot
// changing it while you type), it says so and offers to load the new version or keep editing.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Bot } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { carried, carriedAny, useCarry } from "../lib/carry";
import { readFile, writeFile } from "../state/actions";
import { store, useAppState } from "../state/store";
import { Mark } from "./bits";

interface Loaded {
  /** The text as last read or saved: what "changed" is measured against. */
  text: string;
  rev: string;
}

type Note =
  /** A save found a newer version. */
  | { kind: "conflict" }
  /** The file changed in the folder while there was unsaved text. `who` names who changed it. */
  | { kind: "changed"; who?: string }
  /** "Keep editing" was chosen: the next save replaces the newer version. */
  | { kind: "kept" };

interface Props {
  bot: Bot;
  path: string;
  /** A name for people: "Job", "customers". */
  title: string;
  /** How the unsaved-text question names this file: "the job", "memory/topics/customers.md". */
  what: string;
  /** More buttons for the bar, such as "Remove". */
  actions?: ReactNode;
  /** Shown when the file cannot be read, for example after it was removed. */
  onGone?(): void;
}

/** Unsaved text carried across the window changing between the laptop and the phone layout (lib/carry.ts). */
interface Carried {
  draft: string;
  loaded: Loaded;
  note: Note | null;
}
const carryKey = (botId: string, path: string) => `editor:${botId}:${path}`;

/** Whether a file of this bot other than the job has unsaved text carried over from the other layout. */
export const carriedFileDraft = (botId: string): boolean => carriedAny((k) => k.startsWith(`editor:${botId}:`) && k !== carryKey(botId, "AGENTS.md"));

export function FileEditor({ bot, path, title, what, actions, onGone }: Props) {
  // Text that was not saved when the window crossed between the layouts comes back as it was.
  const [from] = useState(() => carried<Carried>(carryKey(bot.id, path)));
  const [loaded, setLoaded] = useState<Loaded | null>(from?.loaded ?? null);
  const [draft, setDraft] = useState(from?.draft ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<Note | null>(from?.note ?? null);
  const tick = useAppState((s) => s.filesTicks[bot.id]);
  const field = useRef<HTMLTextAreaElement>(null);
  const dirty = loaded !== null && draft !== loaded.text;
  // Read in event handlers without re-subscribing.
  const live = useRef({ dirty, saving, loaded, note });
  live.current = { dirty, saving, loaded, note };
  useCarry(carryKey(bot.id, path), dirty && loaded ? ({ draft, loaded, note } satisfies Carried) : undefined);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const r = await readFile(bot.id, path);
      setLoaded({ text: r.text, rev: r.rev });
      setDraft(r.text);
      setNote(null);
    } catch (e) {
      if (e instanceof EngineError && e.code === "not_found") onGone?.();
      setError(messageOf(e));
    }
  }, [bot.id, path, onGone]);

  const carriedFrom = useRef(from);
  useEffect(() => {
    const kept = carriedFrom.current;
    carriedFrom.current = undefined;
    if (!kept) {
      setLoaded(null);
      setSaved(false);
      void load();
      return;
    }
    // Carried over: the text stays; only say so if the file changed meanwhile.
    void (async () => {
      try {
        const r = await readFile(bot.id, path);
        if (r.rev !== kept.loaded.rev && !live.current.note && !live.current.saving) setNote({ kind: "changed" });
      } catch (e) {
        if (e instanceof EngineError && e.code === "not_found") onGone?.();
      }
    })();
    // Only when the file to show changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Tell the window about unsaved text, so leaving asks first. Forget it when this editor goes.
  useEffect(() => {
    store.setUnsaved(dirty ? { botId: bot.id, what } : null);
  }, [dirty, bot.id, what]);
  useEffect(() => () => store.setUnsaved(null), []);

  // The folder changed (the bot, an undo, another window). Read again; never replace unsaved text.
  const lastTick = useRef(tick?.n);
  useEffect(() => {
    if (!tick || tick.n === lastTick.current) return;
    lastTick.current = tick.n;
    if (!tick.paths.includes(path)) return;
    void (async () => {
      let r;
      try {
        r = await readFile(bot.id, path);
      } catch (e) {
        if (e instanceof EngineError && e.code === "not_found") onGone?.();
        return;
      }
      const now = live.current;
      if (!now.loaded || r.rev === now.loaded.rev || now.saving) return;
      if (now.dirty) setNote({ kind: "changed", who: tick.by === "bot" ? bot.name : tick.by === "you" ? "You" : tick.by === "app" ? "Pobots" : undefined });
      else {
        setLoaded({ text: r.text, rev: r.rev });
        setDraft(r.text);
      }
    })();
  }, [tick, bot.id, bot.name, path, onGone]);

  const save = async () => {
    if (!loaded || !dirty || saving) return;
    setSaving(true);
    setError(undefined);
    const text = draft;
    try {
      const r = await writeFile(bot.id, path, text, loaded.rev);
      setLoaded({ text, rev: r.rev });
      setSaved(true);
      setNote(null);
    } catch (e) {
      if (e instanceof EngineError && e.code === "conflict") setNote({ kind: "conflict" });
      else setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  /** Keep your text; the next save replaces the newer version. */
  const keepEditing = async () => {
    try {
      const r = await readFile(bot.id, path);
      setLoaded((l) => (l ? { text: r.text === draft ? r.text : l.text, rev: r.rev } : l));
      setNote({ kind: "kept" });
      field.current?.focus();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const loadNew = async () => {
    await load();
    field.current?.focus();
  };

  const stateWord = saving ? "Saving" : dirty ? "Not saved" : saved ? "Saved" : "";

  return (
    <div className="app-editor">
      <div className="pb-editor-bar">
        <div className="pb-editor-name">
          <span className="pb-editor-title">{title}</span>
          <span className="pb-editor-path">{path}</span>
        </div>
        <span className="pb-editor-state" role="status" data-state={dirty ? "dirty" : saved ? "saved" : undefined}>
          {stateWord}
        </span>
        {actions}
        <button className="pb-btn pb-btn-sm pb-btn-primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
      {note && note.kind !== "kept" && (
        <div className="pb-editor-note" role="alert">
          <span>
            <Mark state="waiting" />
            {note.kind === "conflict"
              ? "This file changed after you opened it, so it was not saved."
              : note.who === "You"
                ? "You changed this file somewhere else while you were editing here. Your text is still here."
                : note.who
                  ? `${note.who} changed this file while you were editing. Your text is still here.`
                  : "This file was changed while you were editing. Your text is still here."}
          </span>
          <span className="pb-editor-note-actions">
            <button className="pb-btn pb-btn-sm" type="button" onClick={() => void loadNew()}>
              Load the new version
            </button>
            <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" onClick={() => void keepEditing()}>
              Keep editing
            </button>
          </span>
        </div>
      )}
      {note?.kind === "kept" && dirty && <p className="pb-hint app-editor-hint">Saving now replaces the newer version. It stays in the history.</p>}
      {error && (
        <p className="pb-hint app-hint-error app-editor-hint" role="alert">
          {error}
        </p>
      )}
      <div className="pb-editor">
        <textarea
          ref={field}
          className="pb-editor-text"
          value={draft}
          spellCheck={false}
          aria-label={`${title}, ${path}`}
          disabled={!loaded}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>
    </div>
  );
}
