// The Job tab (the bot's AGENTS.md in the editor) and the Files tab: a short list on the left,
// grouped as Memory, Skills and Other, and the same editor on the right. Add a file by naming it
// (it goes under memory/ by default); remove one with a confirm.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bot, BotFile, BotFileKind } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { usePhone } from "../lib/phone";
import { innerBack, useBackLayer, useInnerBack } from "../lib/phone-back";
import { deleteFile, listFiles, writeFile } from "../state/actions";
import { store, useAppState } from "../state/store";
import { BackIcon, PlusIcon } from "./bits";
import { Confirm } from "./Dialog";
import { carriedFileDraft, FileEditor } from "./FileEditor";

export function JobView({ bot }: { bot: Bot }) {
  return (
    <div className="app-view app-view-job">
      <FileEditor bot={bot} path="AGENTS.md" title="Job" what="the job" />
    </div>
  );
}

const GROUPS: { kind: Exclude<BotFileKind, "job">; title: string }[] = [
  { kind: "memory", title: "Memory" },
  { kind: "skill", title: "Skills" },
  { kind: "other", title: "Other" },
];

/** "customers" becomes memory/customers.md; "skills/report/SKILL.md" stays as it is. */
export function pathFromName(name: string): string {
  let p = name.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\s+/g, "-");
  if (!p.includes("/")) p = `memory/${p}`;
  if (!/\.[a-z0-9]+$/i.test(p)) p = `${p}.md`;
  return p;
}

export function FilesView({ bot }: { bot: Bot }) {
  const [files, setFiles] = useState<BotFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<BotFile | null>(null);
  const [removeError, setRemoveError] = useState<string>();
  const [removeBusy, setRemoveBusy] = useState(false);
  /** On a narrow panel, the list and the editor take turns. Unsaved text carried over from the other layout shows at once. */
  const [showList, setShowList] = useState(() => !carriedFileDraft(bot.id));
  const openPath = useAppState((s) => s.openFiles[bot.id]);
  const tick = useAppState((s) => s.filesTicks[bot.id]?.n);
  const listRef = useRef<HTMLDivElement>(null);
  const phone = usePhone();

  const refresh = useCallback(async () => {
    try {
      const all = await listFiles(bot.id);
      setFiles(all.filter((f) => f.kind !== "job"));
      setError(undefined);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [bot.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  // The memory index first, as the bot reads it first; the rest as the engine lists them.
  const shown = files ? GROUPS.flatMap((g) => files.filter((f) => f.kind === g.kind).sort((a, b) => Number(b.path === "memory/MEMORY.md") - Number(a.path === "memory/MEMORY.md"))) : null;
  const open = shown?.find((f) => f.path === openPath) ?? (openPath ? undefined : shown?.[0]);

  const choose = (path: string) => {
    if (path === open?.path) {
      setShowList(false);
      return;
    }
    store.leave(() => {
      store.setOpenFile(bot.id, path);
      setShowList(false);
    });
  };

  const gone = useCallback(() => {
    store.setOpenFile(bot.id, null);
    setShowList(true);
    void refresh();
  }, [bot.id, refresh]);

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(undefined);
    try {
      await deleteFile(bot.id, removing.path);
      store.setUnsaved(null);
      const rest = (files ?? []).filter((f) => f.path !== removing.path);
      store.setOpenFile(bot.id, rest[0]?.path ?? null);
      setFiles(rest);
      setRemoving(null);
      // On a phone the question's own step back lands first, then the file's (see FileOpen below).
      if (!innerBack()) setShowList(true);
      void refresh();
    } catch (e) {
      setRemoveError(messageOf(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className="app-view app-files" data-show={showList ? "list" : "file"}>
      <div className="pb-files app-files-list" ref={listRef} aria-label={`${bot.name}'s files`} role="navigation">
        {adding ? (
          <AddFile
            bot={bot}
            taken={new Set((files ?? []).map((f) => f.path))}
            onDone={(path) => {
              setAdding(false);
              if (path) {
                store.setOpenFile(bot.id, path);
                setShowList(false);
                void refresh();
              }
            }}
          />
        ) : (
          <button className="pb-btn pb-btn-sm pb-btn-quiet app-files-add" type="button" onClick={() => store.leave(() => setAdding(true))}>
            <PlusIcon />
            New file
          </button>
        )}
        {error && <p className="pb-hint app-hint-error">{error}</p>}
        {files && files.length === 0 && <p className="pb-files-empty">No files yet. The job is under Job.</p>}
        {files &&
          GROUPS.map((g) => {
            const inGroup = (shown ?? []).filter((f) => f.kind === g.kind);
            if (inGroup.length === 0) return null;
            return (
              <div className="pb-files-group" key={g.kind}>
                <div className="pb-files-title" id={`files-${bot.id}-${g.kind}`}>
                  {g.title}
                </div>
                <ul className="app-list" aria-labelledby={`files-${bot.id}-${g.kind}`}>
                  {inGroup.map((f) => (
                    <li key={f.path}>
                      <button className="pb-file" type="button" aria-current={f.path === open?.path ? "true" : undefined} onClick={() => choose(f.path)}>
                        <span className="pb-file-name">{f.title}</span>
                        <span className="pb-file-path">{f.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
      </div>
      <div className="app-files-open">
        {open ? (
          <>
            <button className="pb-btn pb-btn-sm pb-btn-quiet app-files-back" type="button" onClick={() => innerBack() || store.leave(() => setShowList(true))}>
              <BackIcon />
              Files
            </button>
            <FileEditor
              key={open.path}
              bot={bot}
              path={open.path}
              title={open.title}
              what={open.path}
              onGone={gone}
              actions={
                <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" onClick={() => {
                    setRemoveError(undefined);
                    setRemoving(open);
                  }}>
                  Remove
                </button>
              }
            />
          </>
        ) : (
          files && files.length > 0 && <p className="pb-files-empty app-files-none">Pick a file on the left.</p>
        )}
      </div>
      {phone && !showList && <FileOpen onBack={() => setShowList(true)} />}
      {removing && (
        <Confirm
          title={`Remove ${removing.path}?`}
          text={`${bot.name} will no longer find it. The change is kept in History, where you can undo it.`}
          yes="Remove file"
          no="Keep it"
          tone="danger"
          busy={removeBusy}
          error={removeError}
          onYes={() => void remove()}
          onNo={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/**
 * On a phone a file that is open is a step of its own: the back control (which then says "Files"),
 * the browser's back, Android's back and the iOS edge swipe all close the file and show the list,
 * and the next step leads to the chat. With unsaved text every one of them asks first.
 */
function FileOpen({ onBack }: { onBack(): void }) {
  const ask = () => store.leave(() => layer.closeWhenTop());
  const layer = useBackLayer(onBack, { holds: () => !!store.get().unsaved, held: ask });
  useInnerBack("Files", ask);
  return null;
}

function AddFile({ bot, taken, onDone }: { bot: Bot; taken: Set<string>; onDone(path: string | null): void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const path = name.trim() ? pathFromName(name) : "";

  const add = async () => {
    if (!path || busy) return;
    if (taken.has(path) || path === "AGENTS.md") {
      setError("There is already a file with that name.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const title = (path.split("/").pop() ?? path).replace(/\.md$/, "");
      await writeFile(bot.id, path, path.endsWith(".md") ? `# ${title}\n\n` : "");
      onDone(path);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="pb-field app-files-new"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
    >
      <label className="pb-label" htmlFor={`new-file-${bot.id}`}>
        New file
      </label>
      <input
        ref={input}
        id={`new-file-${bot.id}`}
        className="pb-input"
        type="text"
        value={name}
        placeholder="customers"
        autoComplete="off"
        disabled={busy}
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
        }}
        aria-describedby={`new-file-${bot.id}-hint`}
      />
      <span className={error ? "pb-hint app-hint-error" : "pb-hint pb-file-path"} id={`new-file-${bot.id}-hint`} role={error ? "alert" : undefined}>
        {error ?? (path || "Goes under memory/ unless you name a folder")}
      </span>
      <div className="app-files-new-actions">
        <button className="pb-btn pb-btn-sm" type="submit" disabled={!path || busy}>
          Add file
        </button>
        <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
