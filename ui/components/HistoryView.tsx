// The History tab: the saved changes to a bot's folder, newest first. Who made each (you, the
// bot's face, the app), what in plain words, and when. Opening one shows the diff, set quietly in
// mono with added and removed lines told apart by tint. Each change can be undone, with a confirm.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { Bot, BotChange, ChatTitle } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { loadChatTitles, readChange, readHistory, undoChange } from "../state/actions";
import { useAppState } from "../state/store";
import { useNow } from "../lib/hooks";
import { whenWord } from "../lib/words";
import { Face } from "./bits";
import { Confirm } from "./Dialog";

/** Start loading the next page this close to the bottom. */
const LOAD_SLACK = 160;

export function HistoryView({ bot }: { bot: Bot }) {
  const [changes, setChanges] = useState<BotChange[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<BotChange | null>(null);
  const [undoError, setUndoError] = useState<string>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const tick = useAppState((s) => s.filesTicks[bot.id]?.n);
  const scroller = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const now = useNow(30_000);

  /** Reads the newest page and puts new changes on top, keeping older pages already loaded. */
  const readNewest = useCallback(async () => {
    try {
      const r = await readHistory(bot.id);
      setChanges((old) => {
        if (old.length === 0) {
          setHasMore(r.hasMore);
          return r.changes;
        }
        const known = new Set(old.map((c) => c.id));
        return [...r.changes.filter((c) => !known.has(c.id)), ...old];
      });
      setError(undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    void readNewest();
  }, [readNewest, tick]);

  const loadMore = async () => {
    const last = changes[changes.length - 1];
    if (busy.current || !hasMore || !last) return;
    busy.current = true;
    setLoading(true);
    try {
      const r = await readHistory(bot.id, last.id);
      setChanges((old) => {
        const known = new Set(old.map((c) => c.id));
        return [...old, ...r.changes.filter((c) => !known.has(c.id))];
      });
      setHasMore(r.hasMore);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_SLACK) void loadMore();
  };

  // A first page that does not fill the panel: fetch more so scrolling can work.
  useEffect(() => {
    const el = scroller.current;
    if (el && hasMore && !loading && el.scrollHeight <= el.clientHeight) void loadMore();
  });

  const undo = async () => {
    if (!undoing) return;
    setUndoBusy(true);
    setUndoError(undefined);
    try {
      const r = await undoChange(bot.id, undoing.id);
      setUndoing(null);
      setDone(`Undone. Saved as a new change: ${r.change.summary}`);
      setOpenId(null);
      await readNewest();
    } catch (e) {
      setUndoError(e instanceof EngineError && e.code === "conflict" ? `${e.message} Nothing was changed.` : messageOf(e));
    } finally {
      setUndoBusy(false);
    }
  };

  return (
    <div className="app-view app-history pb-main-scroll" ref={scroller} onScroll={onScroll}>
      <div className="app-history-inner">
        {done && (
          <p className="app-line app-history-done" role="status">
            {done}
          </p>
        )}
        <EarlierChats bot={bot} now={now} />
        <h2 className="pb-section-title pb-history-title" id={`changes-${bot.id}`}>
          Changes to the folder
        </h2>
        {error && <p className="pb-hint app-hint-error">{error}</p>}
        {!loading && changes.length === 0 && !error && <p className="pb-files-empty">No changes yet.</p>}
        <ol className="pb-changes" aria-label={`Changes to ${bot.name}'s folder`}>
          {changes.map((c) => (
            <li key={c.id} className="pb-change-item">
              <button
                className="pb-change"
                type="button"
                aria-expanded={openId === c.id}
                aria-controls={`change-${c.id}`}
                onClick={() => {
                  setDone(undefined);
                  setOpenId(openId === c.id ? null : c.id);
                }}
              >
                <Who by={c.by} bot={bot} />
                <span className="pb-change-text">
                  <span className="pb-change-summary">{c.summary}</span>
                  <span className="pb-change-files">{c.files.join(" · ")}</span>
                </span>
                <time className="pb-time" dateTime={c.at}>
                  {whenWord(c.at, new Date(now))}
                </time>
              </button>
              {openId === c.id && (
                <ChangeDetail
                  bot={bot}
                  change={c}
                  onUndo={() => {
                    setUndoError(undefined);
                    setUndoing(c);
                  }}
                />
              )}
            </li>
          ))}
        </ol>
        {hasMore && <div className="app-thread-more">{loading ? "Loading earlier changes" : "Scroll for earlier changes"}</div>}
      </div>
      {undoing && (
        <Confirm
          title="Undo this change?"
          text={`This saves a new change that reverses "${undoing.summary}". You can undo that too.`}
          yes="Undo change"
          no="Keep it"
          busy={undoBusy}
          error={undoError}
          onYes={() => void undo()}
          onNo={() => setUndoing(null)}
        />
      )}
    </div>
  );
}

/** How many earlier chats show before "Show more". */
const CHATS_SHOWN = 5;
const CHAT_KIND: Record<ChatTitle["kind"], string> = { main: "Chat", run: "Run", helper: "Helper" };

/**
 * Step 7b: the bot's earlier chats by their titles, newest first: each session of its chat with you
 * (between two fresh starts), its fresh runs and its helpers' work. The same titles the bot's
 * search_chat finds. Five, then "Show more".
 */
function EarlierChats({ bot, now }: { bot: Bot; now: number }) {
  const page = useAppState((s) => s.chatTitles[bot.id]);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadChatTitles(bot.id).catch((e: unknown) => setError(messageOf(e)));
  }, [bot.id]);
  const chats = page?.chats ?? [];
  const shown = all ? chats : chats.slice(0, CHATS_SHOWN);
  return (
    <section className="pb-history-chats" aria-labelledby={`chats-${bot.id}`}>
      <h2 className="pb-section-title pb-history-title" id={`chats-${bot.id}`}>
        Earlier chats
      </h2>
      {error && <p className="pb-hint app-hint-error">{error}</p>}
      {page?.loaded && chats.length === 0 && !error && <p className="pb-files-empty">{`No titles yet. Each chat gets one when it ends or ${bot.name} has been quiet for a while.`}</p>}
      <ol className="pb-chat-titles" aria-labelledby={`chats-${bot.id}`}>
        {shown.map((c) => (
          <li key={`${c.threadId}:${c.fromSeq}`} className="pb-chat-title" data-kind={c.kind}>
            <span className="pb-chat-title-kind">{CHAT_KIND[c.kind]}</span>
            <span className="pb-chat-title-text">{c.title}</span>
            <time className="pb-time" dateTime={c.startedAt}>
              {whenWord(c.startedAt, new Date(now))}
            </time>
          </li>
        ))}
      </ol>
      {((!all && (chats.length > CHATS_SHOWN || page?.hasMore)) || (all && page?.hasMore)) && (
        <button
          type="button"
          className="pb-btn pb-btn-sm pb-btn-quiet pb-chat-titles-more"
          onClick={() => {
            if (!all) setAll(true);
            if (all || chats.length <= CHATS_SHOWN) loadChatTitles(bot.id, true).catch((e: unknown) => setError(messageOf(e)));
          }}
        >
          Show more
        </button>
      )}
    </section>
  );
}

const WHO_WORD: Record<BotChange["by"], string> = { you: "You", bot: "", app: "App" };

function Who({ by, bot }: { by: BotChange["by"]; bot: Bot }) {
  if (by === "bot")
    return (
      <span className="pb-who" title={bot.name}>
        <Face look={bot.look} size="sm" />
        <span className="app-sr">{bot.name}</span>
      </span>
    );
  return (
    <span className="pb-who pb-who-word" data-by={by}>
      {WHO_WORD[by]}
    </span>
  );
}

function ChangeDetail({ bot, change, onUndo }: { bot: Bot; change: BotChange; onUndo(): void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    readChange(bot.id, change.id).then(
      (r) => setDiff(r.diff),
      (e: unknown) => setError(messageOf(e)),
    );
  }, [bot.id, change.id]);
  return (
    <div className="pb-change-open pb-arrive" id={`change-${change.id}`}>
      {error && <p className="pb-hint app-hint-error">{error}</p>}
      {diff !== null && <Diff text={diff} />}
      {/* A change the engine would always refuse, such as the one that made the bot, has no undo. */}
      {change.canUndo !== false && (
        <div className="pb-card-actions">
          <button className="pb-btn pb-btn-sm" type="button" onClick={onUndo}>
            Undo this change
          </button>
        </div>
      )}
    </div>
  );
}

type DiffLine = { kind: "file" | "hunk" | "add" | "del" | "same"; text: string };

/** Turns a unified diff into lines to show. Headers become the file name; @@ lines a quiet gap. */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let pendingOld: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("\\ ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) continue;
    if (line.startsWith("--- ")) {
      pendingOld = line.slice(4).replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const next = line.slice(4).replace(/^b\//, "");
      const name = next === "/dev/null" ? `${pendingOld ?? ""} (removed)` : pendingOld === "/dev/null" ? `${next} (new)` : next;
      out.push({ kind: "file", text: name });
      pendingOld = null;
      continue;
    }
    if (line.startsWith("@@")) out.push({ kind: "hunk", text: "" });
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "same", text: line.slice(1) });
  }
  // The first gap after a file name says nothing.
  return out.filter((l, i) => !(l.kind === "hunk" && out[i - 1]?.kind === "file"));
}

const SIGN: Record<DiffLine["kind"], string> = { file: "", hunk: "", add: "+", del: "-", same: " " };

function Diff({ text }: { text: string }) {
  const lines = parseDiff(text);
  if (lines.length === 0) return <p className="pb-hint">Nothing to show for this change.</p>;
  return (
    <div className="pb-diff" role="group" aria-label="What changed">
      {lines.map((l, i) => (
        <Fragment key={i}>
          {l.kind === "file" ? (
            <div className="pb-diff-file">{l.text}</div>
          ) : l.kind === "hunk" ? (
            <div className="pb-diff-gap" aria-hidden="true" />
          ) : (
            <div className="pb-diff-line" data-kind={l.kind}>
              <span className="pb-diff-sign" aria-label={l.kind === "add" ? "Added" : l.kind === "del" ? "Removed" : undefined}>
                {SIGN[l.kind]}
              </span>
              <span>{l.text || " "}</span>
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
