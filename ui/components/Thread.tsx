// One bot's chat: bot messages as markdown, your messages as bubbles, activity lines and notices.
// Stays pinned to the bottom unless you scrolled up. Reading near the top loads older history.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { ActivityItem, Bot, BotItem, HelperItem, Item } from "../../shared/protocol";
import { ensureArtifacts, ensureThread, ensureTriggers, readOlder } from "../state/actions";
import { keepChatPlace, takeChatPlace } from "../state/chat-place";
import { emptyThread, helperReturn, store, useAppState, type HelperFrame } from "../state/store";
import { clockTime, HELPER_WORD, plural } from "../lib/words";
import { isPhone } from "../lib/phone";
import { lineAtTop, onNotePlace, PANEL_ROWS } from "../lib/place";
import { inReadOrder } from "../lib/queue";
import { Face, Mark } from "./bits";
import { Answer } from "./ThreadAnswer";
import { MarkdownText } from "./ThreadMarkdown";
import { HelperTask, YourMessage } from "./ThreadMessages";
import { Activity, ArtifactRow, HelperRow, Notice } from "./ThreadRows";
import { type AnswerBlock, type FoldBlock, InHelper, PIN_SLACK, type ThreadBlock, type TidyBlock, afterAnswerNotice, answerKey, answerLive, foldTurns, liveTidyKey, steeredLast, thinkingLine, turnOf, withAnswers } from "./thread-blocks";

/** The lines in a chat that open on a press. */
const LINE_BUTTONS = ".app-activity-btn, .pb-fold, .pb-fresh-btn, .pb-notice-btn, .pb-helper, .pb-worked, .pb-artifact, .pb-browser";

/** A helper's thread open in the place of the bot's chat: where its row is, and the row's item once loaded. */
export interface OpenHelper {
  frame: HelperFrame;
  item?: HelperItem;
  /** 1 for a helper the bot started, 2 for a helper that helper started, and so on. */
  depth: number;
  /** A task manager's own thread (protocol 21). */
  manager?: boolean;
}


/**
 * Ends every arrival animation in a thread at once, before it is painted: for lines that are shown
 * again or all at once, which must not fade in and rise as if each had just arrived.
 */
function settle(el: HTMLElement): void {
  for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
    // The marks and faces loop for ever; those keep going.
    if (a.effect?.getComputedTiming().endTime === Infinity) continue;
    try {
      a.finish();
    } catch {
      // An animation that cannot be finished is left as it is.
    }
  }
}

/** Where a chat was when a helper's thread opened over it, so going back lands in the same place. */
const kept = new Map<string, { top: number; pinned: boolean }>();

/**
 * How long the pending line of a tidy turn stays after the engine says the tidying is over, while
 * the "Started fresh" notice is on its way. Without it the line could vanish for a moment and come
 * back, which moves everything below it.
 */
const TIDY_GRACE_MS = 3000;

/**
 * How long the thinking line waits after text that was just written before it stands at the end.
 * A turn usually ends right after its last text; without the wait the line would flash up below the
 * answer and go again, and the foot of the chat would step down and up.
 */
const TEXT_GRACE_MS = 1200;

/** Start loading older history this close to the top. */
const LOAD_SLACK = 120;

/**
 * A bot's chat, or with `helper` the thread of one of its helpers, shown in the same place with the
 * same pieces: the task the bot gave first, then the helper's messages and work, live while it runs.
 */
export function Thread({ bot, helper }: { bot: Bot; helper?: OpenHelper }) {
  const threadId = helper?.frame.helperThreadId ?? bot.mainThreadId;
  const thread = useAppState((s) => s.threads[threadId] ?? emptyThread);
  const bots = useAppState((s) => s.bots);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Where the chat is now, kept for when a helper's thread opens over it. */
  const position = useRef({ top: 0, pinned: true });
  /** Distance from the bottom saved just before older items are added above. */
  const keepFromBottom = useRef<number | null>(null);
  const firstSeq = thread.items[0]?.seq;
  const chatFocus = useAppState((s) => (s.chatFocus?.botId === bot.id ? s.chatFocus : null));
  const focus = helper ? null : chatFocus;
  /** Older pages read while looking for a turn to show, so a missing turn does not read forever. */
  const focusPages = useRef(0);
  /** Texts seen arriving, and when the newest of them was done (see TEXT_GRACE_MS). */
  const streamed = useRef(new Set<string>());
  const textEnd = useRef<{ id: string; at: number } | null>(null);
  /** The answers that stood open (current or still in the turn) at the last drawing. */
  const keptOpen = useRef(new Set<string>());
  const [, rerender] = useState(0);

  useEffect(() => ensureThread(threadId), [threadId]);
  // Trigger messages show whether the trigger was a schedule or a webhook.
  useEffect(() => ensureTriggers(bot.id), [bot.id]);
  // Artifact rows show the newest state of their artifact: its title, its link, whether its file is there.
  useEffect(() => ensureArtifacts(bot.id), [bot.id]);

  // When the chat's width changes (the artifact panel opens, closes or is made wider), the line at
  // the top of the view stays the line at the top. The place is noted on scroll, after each change
  // that is not a change of width, and just before the panel changes; it is put back once the new
  // width has been laid out.
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const width = useRef(0);
  const noteAnchor = () => {
    const el = scroller.current;
    if (el && el.clientWidth === width.current) anchor.current = lineAtTop(el);
  };
  // Just before the panel opens or closes: what the person is acting on stays where it is. That is
  // the row they opened (an artifact's or a browser workspace's; it has the focus), or the row of
  // what is open, when it is in view; a long message above it may wrap anew at the new width, and
  // holding the top line instead would push the row out of sight (tester, step 2f). Otherwise the
  // line at the top.
  const notePanelAnchor = (rowsOf?: string) => {
    const el = scroller.current;
    if (!el || el.clientWidth !== width.current) return;
    const view = el.getBoundingClientRect();
    const seen = (x: Element) => {
      const r = x.getBoundingClientRect();
      return r.height > 0 && r.bottom > view.top && r.top < view.bottom;
    };
    const focused = document.activeElement instanceof Element ? document.activeElement.closest(PANEL_ROWS) : null;
    const rows = rowsOf ? [...el.querySelectorAll(rowsOf)].filter(seen) : [];
    const row = focused && el.contains(focused) && seen(focused) ? focused : rows.at(-1);
    anchor.current = row ? { el: row, top: row.getBoundingClientRect().top } : lineAtTop(el);
  };
  useEffect(() => onNotePlace(notePanelAnchor), []);

  // A new bot opens at the bottom. Coming back from a helper's thread, the chat is where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    // (On a phone, also where it was when the bot's page opened over it: state/chat-place.ts.)
    const back = kept.get(threadId) ?? (helper ? undefined : takeChatPlace(threadId));
    kept.delete(threadId);
    if (back && el) {
      // Shown again, not arriving: nothing fades or rises, every line is simply where it was.
      settle(el);
      pinned.current = back.pinned;
      el.scrollTop = back.pinned ? el.scrollHeight : back.top;
    } else {
      // A helper's thread, and on a phone any chat that is put on screen whole (after the bot's page,
      // from a notification): shown, not arriving, so no line fades in or rises.
      if ((helper || isPhone()) && el) settle(el);
      pinned.current = !!helper || !store.get().chatFocus;
      if (el) el.scrollTop = el.scrollHeight;
    }
    if (el) position.current = { top: el.scrollTop, pinned: pinned.current };
    if (helperReturn.itemId) {
      const row = el?.querySelector<HTMLElement>(`[data-helper-id="${CSS.escape(helperReturn.itemId)}"]`);
      helperReturn.itemId = null;
      row?.focus({ preventScroll: true });
    }
    const botId = bot.id;
    return () => {
      // A helper's thread opened over this one: keep the place to come back to.
      const now = store.get();
      const top = now.helpers[botId]?.at(-1);
      if (top && top.threadId === threadId) kept.set(threadId, position.current);
      // On a phone the bot's page opened over the chat: keep the place for the way back.
      else if (!helper && isPhone() && now.openBotId === botId && now.phoneScreen === "bot" && (now.tabs[botId] ?? "chat") !== "chat") keepChatPlace(threadId, botId, position.current);
    };
    // Only when the thread itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const seenFirstSeq = useRef(firstSeq);
  const lastItem = thread.items[thread.items.length - 1];
  const seenLastId = useRef(lastItem?.id);
  const wasLoaded = useRef(thread.loaded);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A helper's thread read for the first time comes in as a whole, not line by line.
    if (helper && thread.loaded && !wasLoaded.current) settle(el);
    wasLoaded.current = thread.loaded;
    const olderAdded = firstSeq !== seenFirstSeq.current;
    seenFirstSeq.current = firstSeq;
    // The person's own new message always brings the chat to the bottom, wherever they were reading.
    if (lastItem && lastItem.id !== seenLastId.current && lastItem.kind === "user" && lastItem.from.type === "you") pinned.current = true;
    seenLastId.current = lastItem?.id;
    if (olderAdded && keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
    position.current = { top: el.scrollTop, pinned: pinned.current };
    noteAnchor();
    // A short page that does not fill the panel: fetch more so scrolling up can work.
    if (el.scrollHeight <= el.clientHeight && thread.hasMore && !thread.loading) loadOlder();
  });

  // "Show in chat" from a run: bring that turn into view, reading older pages until it is found.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!focus || !el || !thread.loaded || thread.loading) return;
    // An artifact's newest row, or the turn.
    const target = focus.artifactId
      ? [...el.querySelectorAll<HTMLElement>(`.pb-artifact[data-artifact-id="${CSS.escape(focus.artifactId)}"]`)].pop()
      : focus.turnId
        ? el.querySelector<HTMLElement>(`[data-turn="${CSS.escape(focus.turnId)}"]`)
        : null;
    if (target) {
      focusPages.current = 0;
      pinned.current = false;
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      if (focus.artifactId) target.focus({ preventScroll: true });
      store.clearChatFocus();
    } else if (thread.hasMore && focusPages.current < 20) {
      focusPages.current++;
      keepFromBottom.current = el.scrollHeight - el.scrollTop;
      pinned.current = false;
      void readOlder(threadId);
    } else {
      focusPages.current = 0;
      store.clearChatFocus();
    }
  });

  // Keep the bottom in view when the panel itself changes height (window resize, composer growth).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const was = width.current;
      width.current = el.clientWidth;
      const keep = anchor.current;
      if (was && was !== el.clientWidth && keep?.el.isConnected) {
        // A new width: the line that was at the top of the view is put back where it was.
        el.scrollTop += keep.el.getBoundingClientRect().top - keep.top;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
        position.current = { top: el.scrollTop, pinned: pinned.current };
      } else if (pinned.current) {
        el.scrollTop = el.scrollHeight;
        position.current = { top: el.scrollTop, pinned: true };
      }
      anchor.current = lineAtTop(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function loadOlder() {
    const el = scroller.current;
    if (!el || thread.loading || !thread.hasMore) return;
    keepFromBottom.current = pinned.current ? null : el.scrollHeight - el.scrollTop;
    void readOlder(threadId);
  }

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    // Only a scroll that moved the chat can take it off the bottom. The event for a place the chat
    // was put in itself (kept at the bottom as an answer arrives) comes a frame later; if the foot
    // grew in between (a file attached, the box a line taller) the chat stands that much above the
    // bottom for the moment, and reading that as "scrolled up" left its last lines hidden under the
    // foot for good. The place is the same as noted, so the pin stays and the resize puts it right.
    if (Math.abs(el.scrollTop - position.current.top) >= 1) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
    position.current = { top: el.scrollTop, pinned: pinned.current };
    noteAnchor();
    if (el.scrollTop < LOAD_SLACK && thread.hasMore && !thread.loading) loadOlder();
  }

  // The lines that open (work done, folded turns) are one stop for the Tab key, the newest one, with
  // the arrow keys between them. Otherwise Tab walks through every line before the message box.
  const lines = useRef<HTMLDivElement>(null);
  const lineButtons = () => [...(lines.current?.querySelectorAll<HTMLButtonElement>(LINE_BUTTONS) ?? [])];
  useEffect(() => {
    const all = lineButtons();
    const held = all.find((b) => b === document.activeElement);
    all.forEach((b, i) => (b.tabIndex = (held ? b === held : i === all.length - 1) ? 0 : -1));
  });
  function onLineFocus(e: FocusEvent) {
    const target = e.target as HTMLElement;
    if (!target.matches?.(LINE_BUTTONS)) return;
    for (const b of lineButtons()) b.tabIndex = b === target ? 0 : -1;
  }
  function onLineKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (!target.matches?.(LINE_BUTTONS)) return;
    const all = lineButtons();
    const at = all.indexOf(target as HTMLButtonElement);
    const to = e.key === "ArrowUp" ? at - 1 : e.key === "ArrowDown" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -2;
    if (to === -2 || !all[to]) return;
    e.preventDefault();
    all[to]!.focus();
  }

  // A helper's thread is never folded: the task the bot gave it is its first message, not a turn
  // another bot started, and it is the place to read the work.
  // Waiting messages stand above the message box, not in the chat (step 7a); a message that started a
  // turn stands where that turn began.
  const shown = inReadOrder(thread.items.filter((i) => !(i.kind === "user" && i.queued)));
  const blocks: ThreadBlock[] = helper ? withAnswers(shown) : foldTurns(shown);
  const busy = bot.state === "thinking" || bot.state === "working";
  const liveTidy = helper ? undefined : liveTidyKey(blocks, bot);
  // A turn reads in the order it happens: what is live is the last thing itself (a running step,
  // the arriving text). Only when nothing is live, while the bot (or the helper) is at work, does a
  // quiet thinking line stand at the very end, exactly where the next thing will appear. A tidy turn
  // is not an answer to the person: it has its own quiet line instead.
  const helperStatus = helper?.item?.status ?? helper?.frame.status;
  const working = helper ? helperStatus === "running" : busy && !bot.context?.tidying && !liveTidy;
  const lastBlock = blocks[blocks.length - 1];
  // Engine 0.31.2: the turn running now (Bot.turnId); an older engine does not say.
  const liveTurn = working && !helper ? bot.turnId : undefined;
  // The answer the bot is still in: the newest one, with at most notices after it. When the engine
  // says which turn runs, only an answer of that turn: one of an earlier turn stays as it stood
  // (open while the work it started goes on, else folded), and the new turn gets an answer of its own.
  if (working) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if ("answer" in b) {
        const turn = turnOf(b);
        if (!liveTurn || !turn || turn === liveTurn) b.current = true;
        else if (keptOpen.current.has(b.key)) b.turnLive = true;
        break;
      }
      if ("fold" in b || "tidy" in b || b.kind !== "notice") break;
    }
    // The parts of the running turn before a message steered into it stay open too.
    const live = blocks.find((b): b is AnswerBlock => "answer" in b && !!b.current)?.items.find((i) => i.turnId)?.turnId;
    if (live) for (const b of blocks) if ("answer" in b && !b.current && b.items.some((i) => i.turnId === live)) b.turnLive = true;
    // Engine 0.31.2: a turn the bot began by itself is an answer of its own. The answers before it
    // that stood open stay open while the work goes on, so nothing folds under the new turn; they
    // fold together once the bot has ended its work.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if ("answer" in b) {
        if (!b.current && keptOpen.current.has(b.key)) b.turnLive = true;
        if (!b.woke) break;
        continue;
      }
      if ("fold" in b || "tidy" in b || b.kind !== "notice") break;
    }
  }
  // Another bot's turn running as the newest thing speaks for itself in its folded line.
  const liveNow = !lastBlock ? false : "answer" in lastBlock ? answerLive(lastBlock) : "fold" in lastBlock && !helper && busy;
  // Right after text that was just written, the turn usually ends at once: the thinking line waits a
  // moment there, so it does not flash up below the answer and go again.
  const lastOut = lastBlock && "answer" in lastBlock ? lastBlock.items[lastBlock.items.length - 1] : undefined;
  if (lastOut?.kind === "bot" && lastOut.streaming) streamed.current.add(lastOut.id);
  const textJustEnded = lastOut?.kind === "bot" && !lastOut.streaming && streamed.current.has(lastOut.id);
  if (textJustEnded && textEnd.current?.id !== lastOut.id) textEnd.current = { id: lastOut.id, at: Date.now() };
  const sinceText = textJustEnded ? Date.now() - textEnd.current!.at : Infinity;
  const holdAfterText = sinceText < TEXT_GRACE_MS;
  useEffect(() => {
    if (!holdAfterText) return;
    const t = setTimeout(() => rerender((n) => n + 1), TEXT_GRACE_MS - sinceText + 20);
    return () => clearTimeout(t);
  }, [holdAfterText, sinceText]);
  // Engine 0.31.2: a running turn that nothing in the chat belongs to yet began by itself: its
  // thinking line stands in an answer of its own below the one before, with its face, name and quiet
  // line from the start; the turn's first item fills that same answer (same key).
  const liveSeen = !!liveTurn && thread.items.some((i) => i.turnId === liveTurn);
  const liveWoke = !!liveTurn && !thread.items.some((i) => i.kind === "user" && i.turnId === liveTurn) && !(lastBlock && !("answer" in lastBlock) && !("fold" in lastBlock) && !("tidy" in lastBlock) && lastBlock.kind === "user");
  if (working && thread.loaded && liveTurn && !liveSeen && lastBlock && "answer" in lastBlock) {
    lastBlock.current = false;
    if (keptOpen.current.has(lastBlock.key)) lastBlock.turnLive = true;
    blocks.push({ answer: true, key: answerKey(lastBlock), items: [], head: true, thinking: true, current: true, ...(liveWoke ? { woke: true } : {}) });
  } else if (working && thread.loaded && !liveNow && !holdAfterText) {
    if (lastBlock && "answer" in lastBlock) lastBlock.thinking = true;
    else {
      const head = !afterAnswerNotice(blocks, blocks.length, liveTurn) && !steeredLast(blocks);
      blocks.push({ answer: true, key: answerKey(lastBlock), items: [], head, thinking: true, current: true, ...(head && liveWoke && lastBlock ? { woke: true } : {}) });
    }
  }
  keptOpen.current = new Set(blocks.flatMap((b) => ("answer" in b && (b.current || b.turnLive) ? [b.key] : [])));
  const thinkingWords = helper ? HELPER_WORD.running : thinkingLine(bot);
  const empty = thread.loaded && thread.items.length === 0;
  const title = helper?.item?.title ?? helper?.frame.title ?? "";

  return (
    <div className="pb-main-scroll" ref={scroller} onScroll={onScroll} tabIndex={-1}>
      {empty && !helper ? (
        <div className="app-thread-empty">
          <Face look={bot.look} state={bot.state} size="xl" />
          <p className="app-thread-empty-text">{`${bot.name} is new here. Tell it what its job is.`}</p>
        </div>
      ) : (
        <div
          className="pb-thread"
          role="log"
          aria-label={helper ? `Helper's thread: ${title}` : `Chat with ${bot.name}`}
          aria-busy={thread.loading || undefined}
          data-helper-thread={helper ? threadId : undefined}
          ref={lines}
          onKeyDown={onLineKey}
          onFocus={onLineFocus}
        >
          {thread.hasMore && <div className="app-thread-more">{thread.loading ? "Loading earlier messages" : "Scroll up for earlier messages"}</div>}
          {thread.error && !thread.loaded && <div className="app-notice app-notice-error"><Mark state="blocked" />{thread.error}</div>}
          <InHelper.Provider value={helper ? { bot, depth: helper.depth, name: helper.manager || helper.item?.taskManager ? "Task manager" : "Helper" } : null}>
            <Blocks blocks={blocks} bot={bot} bots={bots} liveTidy={liveTidy} foldWork={!helper} thinking={thinkingWords} />
          </InHelper.Provider>
        </div>
      )}
    </div>
  );
}

function Blocks({ blocks, bot, bots, liveTidy, foldWork = false, thinking = "Thinking" }: { blocks: ThreadBlock[]; bot?: Bot; bots: Bot[]; liveTidy?: string; foldWork?: boolean; thinking?: string }) {
  return (
    <>
      {blocks.map((block) =>
        "answer" in block ? (
          <Answer key={block.key} block={block} bot={bot} bots={bots} foldWork={foldWork} thinking={thinking} />
        ) : "fold" in block ? (
          bot ? <Fold key={`fold-${block.turnId}`} fold={block} bot={bot} bots={bots} /> : null
        ) : "tidy" in block ? (
          bot ? <FreshLine key={`tidy-${block.key}`} block={block} bot={bot} live={block.key === liveTidy} /> : null
        ) : (
          <ThreadItem key={block.id} item={block} bots={bots} botId={bot?.id} />
        ),
      )}
    </>
  );
}

/**
 * Items shown with the chat's own pieces, outside the chat: a fresh run's thread, read-only. Turns
 * another bot started fold the same way. The run is a place to read its work, so its work is not
 * folded away.
 */
export function ThreadBlocks({ items, bots }: { items: Item[]; bots: Bot[] }) {
  const owner = bots.find((b) => items.some((i) => (i.kind === "bot" || i.kind === "activity" || i.kind === "helper" || i.kind === "artifact" || i.kind === "browser") && i.botId === b.id));
  return <Blocks blocks={foldTurns(items)} bot={owner} bots={bots} />;
}


/** Which fresh start lines are open, while the app is open. */
const openFresh = new Set<string>();

/**
 * Where the bot's working session starts over. One quiet rule across the thread with a few words
 * in the middle. While the tidy turn runs it reads "Writing down what matters" beside the bot's
 * small face; when the notice comes the same box reads "Started fresh · 14:52" and opens to the
 * note and the steps. Both states have the same height, so the change moves nothing.
 */
function FreshLine({ block, bot, live }: { block: TidyBlock; bot: Bot; live: boolean }) {
  const [open, setOpen] = useState(() => openFresh.has(block.key));
  const [, wake] = useState(0);
  // Hold the pending line for a moment after the tidying ends without a notice yet (see TIDY_GRACE_MS).
  const liveAt = useRef(0);
  if (live) liveAt.current = Date.now();
  const since = Date.now() - liveAt.current;
  const holding = !live && !block.notice && liveAt.current > 0 && since < TIDY_GRACE_MS;
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => wake((n) => n + 1), TIDY_GRACE_MS - since + 20);
    return () => clearTimeout(t);
  }, [holding, since]);
  const wrap = useRef<HTMLDivElement>(null);

  const notice = block.notice;
  if (!notice && !live && !holding) return null;
  const bodyId = `fresh-${block.key}`;
  const toggle = () => {
    if (open) openFresh.delete(block.key);
    else openFresh.add(block.key);
    setOpen(!open);
    // The line stays where it is and the note opens below it. Tell the chat it is no longer at the
    // bottom, so the next new message does not pull the line away from the person.
    const opening = !open;
    requestAnimationFrame(() => {
      // Opened at the foot of the chat, the note would be out of sight: bring it in, moving as little as possible.
      if (opening) wrap.current?.scrollIntoView({ block: "nearest" });
      wrap.current?.closest(".pb-main-scroll")?.dispatchEvent(new Event("scroll"));
    });
  };
  const note = notice?.detail?.trim() || [...block.items].reverse().find((i): i is BotItem => i.kind === "bot")?.text.trim() || "";
  const steps = block.items.filter((i): i is ActivityItem => i.kind === "activity");

  return (
    <div className="pb-fresh-wrap pb-arrive" ref={wrap} data-turn={block.turnId} data-open={(open && !!notice) || undefined}>
      <div className="pb-fresh" data-state={notice ? "done" : "pending"}>
        {notice ? (
          <button type="button" className="pb-fresh-btn pb-fade-in" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle}>
            <span>Started fresh</span> <span>·</span> <time dateTime={notice.at}>{clockTime(notice.at)}</time>
          </button>
        ) : (
          <span className="pb-fresh-pending" role="status">
            <Face look={bot.look} state="working" />
            <span>Writing down what matters</span>
          </span>
        )}
      </div>
      {notice && open && (
        <div className="pb-fresh-body" id={bodyId}>
          <p className="pb-fresh-what">{`${bot.name} wrote this down for itself before starting fresh. The chat above is still there for you, and ${bot.name} can search it.`}</p>
          <div className="pb-fresh-note app-md">{note ? <MarkdownText text={note} /> : <p>No note was saved.</p>}</div>
          {steps.length > 0 && (
            <div className="pb-fresh-steps app-activity-group" aria-label="What it saved">
              {steps.map((item) => (
                <Activity key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}



/** Which folds are open, per turn, while the app is open. */
const openFolds = new Set<string>();

function Fold({ fold, bot, bots }: { fold: FoldBlock; bot: Bot; bots: Bot[] }) {
  const [open, setOpen] = useState(() => openFolds.has(fold.turnId));
  const from = bots.find((b) => b.id === fold.start.from.botId);
  const fromName = from?.name ?? "Another bot";
  const messages = fold.items.filter((i) => i.kind === "user" || i.kind === "bot").length;
  const live = fold.items.some((i) => (i.kind === "bot" && i.streaming) || ((i.kind === "activity" || i.kind === "helper") && i.status === "running"));
  const ask = fold.start.from.expectsReply;
  const verb = live ? (ask ? "is asking" : "is telling") : ask ? "asked" : "told";
  const label = `${fromName} ${verb} ${bot.name}, ${plural(messages, "message")}`;
  const bodyId = `fold-${fold.turnId}`;
  const toggle = () => {
    if (open) openFolds.delete(fold.turnId);
    else openFolds.add(fold.turnId);
    setOpen(!open);
  };
  return (
    <div className="pb-fold-wrap" data-open={open || undefined}>
      <button type="button" className="pb-fold app-fold" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="pb-fold-faces">
          {from && <Face look={from.look} />}
          <Face look={bot.look} />
        </span>
        <span>{label}</span>
        <time className="pb-time" dateTime={fold.start.at}>
          {clockTime(fold.start.at)}
        </time>
      </button>
      {open && (
        <div className="pb-fold-body" id={bodyId}>
          <Blocks blocks={withAnswers(fold.items)} bot={bot} bots={bots} />
        </div>
      )}
    </div>
  );
}

function ThreadItem({ item, bots, botId }: { item: Item; bots: Bot[]; botId?: string }) {
  const inHelper = useContext(InHelper);
  switch (item.kind) {
    case "bot":
      // The bot's words always stand in an answer (see Answer), never on their own.
      return null;
    case "user":
      if (inHelper && item.from.type === "bot") return <HelperTask item={item} bot={inHelper.bot} depth={inHelper.depth} />;
      return <YourMessage item={item} bots={bots} />;
    case "notice":
      return <Notice item={item} botId={botId} />;
    case "activity":
      return <Activity item={item} />;
    case "helper":
      return (
        <div className="pb-helper-group" role="group" aria-label="Helper">
          <HelperRow item={item} />
        </div>
      );
    case "artifact":
      return <ArtifactRow item={item} />;
  }
}
