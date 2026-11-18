// The Artifacts tab: the pages a bot made for the person, newest change first. Each says where it
// lives ("In Pobots", "On Claude", or both) and when it changed, and opens beside the chat or in a
// window of its own. "Show in chat" goes to its newest row; "Remove from the list" asks first.
import { useEffect, useState } from "react";
import type { Artifact, Bot } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { useNow } from "../lib/hooks";
import { whenWord } from "../lib/words";
import { ensureArtifacts, loadArtifacts, openArtifact, removeArtifact } from "../state/actions";
import { store, useAppState } from "../state/store";
import { ArtifactIcon, ArtifactLinkIcon } from "./bits";
import { Confirm } from "./Dialog";

/** Where an artifact lives, in a word or two. */
export function whereWord(a: Artifact): string {
  if (a.kind === "link") return "On Claude";
  return a.url ? "In Pobots · On Claude" : "In Pobots";
}

export function ArtifactsView({ bot }: { bot: Bot }) {
  const list = useAppState((s) => s.artifacts[bot.id]);
  const open = useAppState((s) => (s.panel?.kind === "artifact" && s.panel.botId === bot.id ? s.panel.artifactId : null));
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<Artifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const now = useNow(30_000);

  useEffect(() => {
    if (store.get().artifacts[bot.id]) return;
    // Read here (not only through ensureArtifacts) so a failure can be said.
    loadArtifacts(bot.id).catch((e: unknown) => setError(messageOf(e)));
  }, [bot.id]);
  useEffect(() => ensureArtifacts(bot.id), [bot.id]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setRemoveError(undefined);
    try {
      await removeArtifact(bot.id, removing.id);
      setRemoving(null);
    } catch (e) {
      setRemoveError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-view pb-main-scroll app-artifacts">
      <div className="app-artifacts-inner">
        {error && !list && <p className="pb-hint app-hint-error">{error}</p>}
        {list && list.length === 0 && <p className="pb-files-empty pb-artifacts-empty">{`No artifacts yet. Ask ${bot.name} to make one, for example a status page or a mock-up.`}</p>}
        {list && list.length > 0 && (
          <ul className="pb-artifact-list" aria-label={`${bot.name}'s artifacts`}>
            {list.map((a) => {
              const gone = a.kind === "page" && !a.available;
              const can = a.kind === "link" ? !!a.url : !gone;
              // "Updated just now", "Updated 12 min ago", "Updated 09:25".
              const ago = whenWord(a.updatedAt, new Date(now));
              const when = `${a.rev > 1 && a.updatedAt !== a.createdAt ? "Updated" : "Made"} ${ago === "Just now" ? "just now" : ago}`;
              const line = gone ? `${whereWord(a)} · The file is gone` : `${whereWord(a)} · ${when}`;
              return (
                <li key={a.id} className="pb-artifact-item" data-artifact-id={a.id} data-kind={a.kind} data-state={gone ? "gone" : "ready"} data-open={open === a.id || undefined}>
                  <button
                    type="button"
                    className="pb-artifact-open"
                    aria-disabled={!can || undefined}
                    aria-label={`${a.title}. ${line}.${!can ? "" : a.kind === "link" ? " Opens on Claude in its own window." : " Opens beside the chat."}`}
                    onClick={() => can && openArtifact(a)}
                  >
                    <span className="pb-artifact-mark" aria-hidden="true">
                      {a.kind === "link" ? <ArtifactLinkIcon /> : <ArtifactIcon />}
                    </span>
                    <span className="pb-artifact-text" aria-hidden="true">
                      <span className="pb-artifact-title">{a.title.trim() || "Artifact"}</span>
                      <span className="pb-artifact-line">{line}</span>
                    </span>
                  </button>
                  <span className="pb-artifact-actions">
                    <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet" onClick={() => store.focusArtifactInChat(bot.id, a.id)}>
                      Show in chat
                    </button>
                    <button
                      type="button"
                      className="pb-btn pb-btn-sm pb-btn-quiet"
                      onClick={() => {
                        setRemoveError(undefined);
                        setRemoving(a);
                      }}
                    >
                      Remove from the list
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {removing && (
        <Confirm
          title="Remove this artifact from the list?"
          text={`The file stays in ${bot.name}'s folder, and anything on Claude stays on Claude. Its lines in the chat stay too.`}
          yes="Remove from the list"
          no="Keep it"
          tone="danger"
          busy={busy}
          error={removeError}
          onYes={() => void remove()}
          onNo={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
