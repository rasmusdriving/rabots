// The rows inside an answer: helpers, files, browser pages, lines of work and notices.
import { useEffect, useState, type ReactNode } from "react";
import type { ActivityItem, ArtifactItem, BrowserItem, HelperItem, NoticeItem } from "../../shared/protocol";
import { openArtifact, openBrowserPanel, openHelper } from "../state/actions";
import { store, useAppState } from "../state/store";
import { helperModelLabel } from "../lib/models";
import { ARTIFACT_WHAT, clockTime, duration, HELPER_WORD, plural } from "../lib/words";
import { PROVIDERS, helperHarness } from "../lib/providers";
import { managerRowWord } from "../lib/task-managers";
import { ArtifactIcon, ArtifactLinkIcon, BesideIcon, BrowserIcon, ForwardIcon, HelperIcon, Mark, OutIcon } from "./bits";
import { MarkdownText } from "./ThreadMarkdown";

/** While a helper works, how long it has worked, from one minute on; read again every 15 seconds. */
export const WORKED_TICK_MS = 15_000;

/**
 * One helper, as one row where the bot started it: a small drawn mark on a soft disc (never a face),
 * the title in the ink of a name, one muted line about now or about the end, and at the right the
 * state in a word, the time and an arrow. One fixed height in every state; the line and the words
 * change in place. The whole row opens the helper's thread.
 */
export function HelperRow({ item }: { item: HelperItem }) {
  const [, wake] = useState(0);
  const models = useAppState((s) => s.models);
  // The model the bot chose for it, as a quiet label after the title (step 3a). The title gives way.
  const modelLabel = helperModelLabel(models, item);
  // The provider's mark in place of the plain arrow, when it is known (step 7a).
  const harness = helperHarness(item, models);
  const provider = harness ? PROVIDERS[harness] : undefined;
  const running = item.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => wake((n) => n + 1), WORKED_TICK_MS);
    return () => clearInterval(t);
  }, [running]);
  // A task manager's row says its own state: working, waits for you, resting, ended (protocol 21).
  const word = managerRowWord(item) ?? HELPER_WORD[item.status];
  const worked = running ? Date.now() - new Date(item.at).getTime() : 0;
  const when = running ? (worked >= 60_000 ? duration(worked) : "") : clockTime(item.endedAt ?? item.at);
  const line = item.last?.trim() || (running ? "Starting" : item.steps > 0 ? plural(item.steps, "step") : "");
  const title = item.title.trim() || "Helper";
  return (
    <button
      type="button"
      className="pb-helper pb-arrive"
      data-status={item.status}
      data-helper-id={item.id}
      data-turn={item.turnId}
      data-task-manager={item.taskManager?.state}
      aria-label={`${title}. ${item.taskManager ? "Task manager" : "Helper"}${modelLabel ? ` on ${modelLabel}` : provider ? ` on ${provider.name}` : ""}, ${word.toLowerCase()}${when ? `, ${running ? when : `at ${when}`}` : ""}. ${line ? `${line}. ` : ""}Open its thread`}
      onClick={() => openHelper(item)}
    >
      <span className="pb-helper-mark" aria-hidden="true" data-provider={harness && provider ? harness : undefined} title={provider ? `A helper on ${provider.name}` : undefined}>
        {provider ? <provider.Mark /> : <HelperIcon />}
      </span>
      <span className="pb-helper-text" aria-hidden="true">
        <span className="pb-helper-head">
          <span className="pb-helper-title">{title}</span>
          {/* In a narrow chat a long label is cut; the whole label shows on hover and is in the row's name. */}
          {modelLabel && (
            <span className="pb-helper-model" title={modelLabel}>
              {modelLabel}
            </span>
          )}
        </span>
        <span className="pb-helper-last">{line || " "}</span>
      </span>
      <span className="pb-helper-state" aria-hidden="true">
        {running && <Mark state="thinking" />}
        <span className="pb-helper-word pb-fade-in" key={word}>
          {word}
        </span>
        {when && (
          <>
            <span className="pb-helper-dot">·</span>
            <time className="pb-time" dateTime={running ? undefined : (item.endedAt ?? item.at)}>
              {when}
            </time>
          </>
        )}
      </span>
      <span className="pb-helper-go" aria-hidden="true">
        <ForwardIcon />
      </span>
    </button>
  );
}

/**
 * An artifact the bot showed, changed or published, as one row at its place in the answer: a drawn
 * page on a soft disc, the title in the ink of a name, one muted line saying what happened and when,
 * and a mark for where it opens. Raised like a card, so it reads as a thing to open, not as work. One
 * fixed height in every state. It shows the newest state the app knows for the artifact. A "page"
 * opens in the panel beside the chat; a "link" lives on Claude and opens in a window of its own.
 */
export function ArtifactRow({ item }: { item: ArtifactItem }) {
  const known = useAppState((s) => s.artifacts[item.botId]?.find((a) => a.id === item.artifact.id));
  const removed = useAppState((s) => !!s.removedArtifacts[item.artifact.id]);
  const open = useAppState((s) => s.panel?.kind === "artifact" && s.panel.botId === item.botId && s.panel.artifactId === item.artifact.id);
  const a = known ?? item.artifact;
  const link = a.kind === "link";
  const title = a.title.trim() || "Artifact";
  const what = `${ARTIFACT_WHAT[item.what]} ${clockTime(item.at)}`;
  const state = removed ? "removed" : link ? (a.url ? "link" : "removed") : a.available ? "ready" : "gone";
  const line = state === "removed" ? "Taken off the list" : state === "gone" ? "The file is gone" : link ? `${what} · On Claude, opens in its own window` : what;
  const can = state === "ready" || state === "link";
  const how = !can ? "" : link ? "" : open ? " Open beside the chat." : " Opens beside the chat.";
  return (
    <button
      type="button"
      className="pb-artifact pb-arrive"
      data-artifact-id={a.id}
      data-artifact-item={item.id}
      data-kind={a.kind}
      data-state={state}
      data-what={item.what}
      data-open={open || undefined}
      data-turn={item.turnId}
      aria-disabled={!can || undefined}
      aria-label={`${title}. Artifact. ${line}.${how}`}
      onClick={() => can && openArtifact(a)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          store.setPanel(null);
        }
      }}
    >
      <span className="pb-artifact-mark" aria-hidden="true">
        {link ? <ArtifactLinkIcon /> : <ArtifactIcon />}
      </span>
      <span className="pb-artifact-text" aria-hidden="true">
        <span className="pb-artifact-title">{title}</span>
        <span className="pb-artifact-line pb-fade-in" key={line}>
          {line}
        </span>
      </span>
      <span className="pb-artifact-go" aria-hidden="true">
        {can && (link ? <OutIcon /> : <BesideIcon />)}
      </span>
    </button>
  );
}

/**
 * Where a bot worked in the browser, as one row at its place in the answer: a small drawn window on a
 * soft disc, the workspace's name in the ink of a name, one muted line with the page in front
 * ("Surveys · app.example.com"), and at the right "Open" (with the working mark while a bot's command
 * runs in it) or "Closed" with the time. Flat and as wide as the answer, like a helper's row: it is
 * work. One fixed height in every state. Click or Enter opens the live picture beside the chat; a
 * closed row is quiet and does nothing.
 */
export function BrowserRow({ item, work }: { item: BrowserItem; work: boolean }) {
  const space = useAppState((s) => s.browser.spaces.find((x) => x.id === item.spaceId));
  const open = useAppState((s) => s.panel?.kind === "browser" && s.panel.spaceId === item.spaceId);
  const closed = item.status === "closed";
  const busy = !closed && !!space?.busy;
  const name = item.name.trim() || space?.name.trim() || "The browser";
  const line = item.last?.trim() || "";
  const word = closed ? "Closed" : "Open";
  const when = closed && item.endedAt ? clockTime(item.endedAt) : "";
  const label = `${name}. Browser, ${closed ? `closed${when ? ` at ${when}` : ""}` : busy ? "open, working" : "open"}. ${line ? `${line}. ` : ""}${closed ? "" : open ? "Open beside the chat." : "Opens beside the chat."}`;
  return (
    <button
      type="button"
      className="pb-browser pb-arrive"
      data-space-id={item.spaceId}
      data-browser-item={item.id}
      data-status={item.status}
      data-busy={busy || undefined}
      data-open={open || undefined}
      data-turn={item.turnId}
      data-work={work || undefined}
      aria-disabled={closed || undefined}
      aria-label={label.trim()}
      onClick={() => !closed && openBrowserPanel(item.spaceId)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          store.setPanel(null);
        }
      }}
    >
      <span className="pb-browser-mark" aria-hidden="true">
        <BrowserIcon />
      </span>
      <span className="pb-browser-text" aria-hidden="true">
        <span className="pb-browser-name">{name}</span>
        <span className="pb-browser-last pb-fade-in" key={line}>
          {line || " "}
        </span>
      </span>
      <span className="pb-browser-state" aria-hidden="true">
        {busy && <Mark state="thinking" />}
        <span className="pb-browser-word pb-fade-in" key={word}>
          {word}
        </span>
        {when && (
          <>
            <span className="pb-browser-dot">·</span>
            <time className="pb-time" dateTime={item.endedAt}>
              {when}
            </time>
          </>
        )}
      </span>
      <span className="pb-browser-go" aria-hidden="true">
        {!closed && <BesideIcon />}
      </span>
    </button>
  );
}

/** A line of work. Inside an answer it is one of its pieces (`pb-step`); `work` marks it as work that folds away. */
export function Activity({ item, work = false }: { item: ActivityItem; work?: boolean }) {
  const [open, setOpen] = useState(false);
  const mark = item.status === "running" ? "working" : item.status === "failed" ? "blocked" : "check";
  const body: ReactNode = (
    <>
      <Mark state={mark} />
      <span className="app-activity-label">{item.label}</span>
      {item.status === "failed" && <span className="app-activity-failed">Failed</span>}
      {item.durationMs !== undefined && item.status !== "running" && <span className="pb-time">{duration(item.durationMs)}</span>}
    </>
  );
  if (!item.detail)
    return (
      <div className="pb-activity pb-step pb-arrive" data-work={work || undefined}>
        {body}
      </div>
    );
  return (
    <div className="pb-step pb-arrive" data-work={work || undefined}>
      <button type="button" className="pb-activity app-activity-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {body}
      </button>
      {open && <pre className="pb-draft app-activity-detail">{item.detail}</pre>}
    </div>
  );
}

/** Which posts are open in the chat, while the app is open. */
export const openPosts = new Set<string>();

export function Notice({ item }: { item: NoticeItem }) {
  // A bot's own post in a channel (15 Nov 2026), sent or not: the post itself opens below the line.
  const post = item.mark !== "fresh" ? item.detail?.trim() : undefined;
  // A calendar action (16 Nov 2026) carries the meeting's details the same way.
  const calendar = item.mark === "calendar";
  const [open, setOpen] = useState(() => openPosts.has(item.id));
  const bodyId = `post-${item.id}`;
  const line = (
    <div className={`app-notice pb-arrive${item.tone === "error" ? " app-notice-error" : ""}`} data-mark={item.mark} role={item.tone === "error" ? "alert" : undefined}>
      {item.tone === "error" && <Mark state="blocked" />}
      <span>{item.text}</span>
      <time className="pb-time" dateTime={item.at}>
        {clockTime(item.at)}
      </time>
      {post && (
        <button
          type="button"
          className="pb-notice-btn"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => {
            if (open) openPosts.delete(item.id);
            else openPosts.add(item.id);
            setOpen(!open);
          }}
        >
          {calendar ? (open ? "Hide the details" : "Show the details") : open ? "Hide the post" : "Show the post"}
        </button>
      )}
    </div>
  );
  if (!post) return line;
  return (
    <div className="pb-notice-wrap">
      {line}
      {open && (
        calendar ? (
          // The meeting's details are plain lines from the engine, never markdown.
          <div className="pb-notice-post" data-plain="" id={bodyId}>
            {post}
          </div>
        ) : (
          <div className="pb-notice-post app-md" id={bodyId}>
            <MarkdownText text={post} />
          </div>
        )
      )}
    </div>
  );
}
