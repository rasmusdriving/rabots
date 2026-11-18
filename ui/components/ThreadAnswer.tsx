// One answer of the bot in a chat: its words and its lines of work, folding away when it ends.
import { memo, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ActivityItem, ArtifactItem, Bot, BotItem, BrowserItem, HelperItem, Item } from "../../shared/protocol";
import { clockTime, duration, plural, workedFor } from "../lib/words";
import { WaitingLine } from "./WaitingLine";
import { WorkGroup } from "./WorkGroup";
import { ChevronIcon, Face, HelperIcon } from "./bits";
import { MarkdownText } from "./ThreadMarkdown";
import { ArtifactRow, BrowserRow, HelperRow } from "./ThreadRows";
import { type AnswerBlock, InHelper, PIN_SLACK, isOutput, isStep } from "./thread-blocks";

/** Under the name of a turn no message started (engine 0.31.2), in the activity log's words for such a turn. */
export const WOKE_LINE = "A helper or background task reported back";

/** Which answers have their work open, while the app is open. */
export const openWork = new Set<string>();

export type Piece =
  | { key: string; kind: "text"; item: BotItem }
  /** Lines of work and thinking summaries that follow each other: one line (step 7a). */
  | { key: string; kind: "work"; items: ActivityItem[] }
  | { key: string; kind: "helpers"; items: HelperItem[] }
  | { key: string; kind: "artifact"; item: ArtifactItem }
  | { key: string; kind: "browser"; item: BrowserItem };

/**
 * An answer's items as pieces: a text, a line of work, the helpers started together as one group, or
 * an artifact's row. Several rows for the same artifact in one turn are one row, the newest, at the
 * place of the first, so the row changes in its box and nothing moves.
 */
export function pieces(items: Item[]): Piece[] {
  const out: Piece[] = [];
  const artifactAt = new Map<string, number>();
  const browserAt = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "browser") {
      // One row per turn and workspace; a second copy (the engine sends one per turn) changes it in its box.
      const same = `${item.turnId ?? item.id}:${item.spaceId}`;
      const at = browserAt.get(same);
      if (at !== undefined) out[at] = { key: out[at]!.key, kind: "browser", item };
      else {
        browserAt.set(same, out.length);
        out.push({ key: item.id, kind: "browser", item });
      }
      continue;
    }
    if (item.kind === "artifact") {
      const same = `${item.turnId ?? item.id}:${item.artifact.id}`;
      const at = artifactAt.get(same);
      if (at !== undefined) out[at] = { key: out[at]!.key, kind: "artifact", item };
      else {
        artifactAt.set(same, out.length);
        out.push({ key: item.id, kind: "artifact", item });
      }
      continue;
    }
    if (item.kind === "bot") {
      // An answer with no text yet is not drawn: the thinking line stands in its place.
      if (item.text !== "") out.push({ key: item.id, kind: "text", item });
    } else if (item.kind === "activity") {
      const last = out[out.length - 1];
      if (last?.kind === "work") last.items.push(item);
      else out.push({ key: item.id, kind: "work", items: [item] });
    }
    else if (item.kind === "helper") {
      const last = out[out.length - 1];
      if (last?.kind === "helpers") last.items.push(item);
      else out.push({ key: item.id, kind: "helpers", items: [item] });
    }
  }
  return out;
}

export const ms = (iso: string): number => new Date(iso).getTime();
/** When an item was over: a step's end, a helper's end, else when it came. */
export const endOf = (i: Item): number => (i.kind === "activity" && i.durationMs !== undefined ? ms(i.at) + i.durationMs : i.kind === "helper" && i.endedAt ? ms(i.endedAt) : ms(i.at));

export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A duration token in milliseconds, read from the page's tokens. */
export function tokenMs(el: Element, name: string): number {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/**
 * Before a turn's work folds away: how to keep the place. At the bottom of the chat, the chat stays
 * at the bottom, so the answer keeps its distance to the foot. Reading further up, the first thing in
 * view that stays (not part of the work that closes) keeps its place on the screen.
 */
export function keepPlace(from: HTMLElement): () => void {
  const s = from.closest<HTMLElement>(".pb-main-scroll");
  if (!s) return () => {};
  if (s.scrollHeight - s.scrollTop - s.clientHeight < PIN_SLACK)
    return () => {
      s.scrollTop = s.scrollHeight;
    };
  const view = s.getBoundingClientRect();
  const stays: HTMLElement[] = [];
  for (const kid of s.querySelectorAll<HTMLElement>(".pb-thread > *")) {
    if (!kid.classList.contains("pb-answer")) {
      stays.push(kid);
      continue;
    }
    const head = kid.querySelector<HTMLElement>(":scope > .pb-answer-col > .pb-msg-head");
    if (head) stays.push(head);
    const woke = kid.querySelector<HTMLElement>(":scope > .pb-answer-col > .pb-woke");
    if (woke) stays.push(woke);
    stays.push(...kid.querySelectorAll<HTMLElement>(":scope > .pb-answer-col > .pb-answer-flow > :not([data-work])"));
  }
  const anchor = stays.find((el) => el.getBoundingClientRect().top >= view.top - 0.5);
  if (!anchor) return () => {};
  const top = anchor.getBoundingClientRect().top;
  return () => {
    s.scrollTop += anchor.getBoundingClientRect().top - top;
  };
}

/**
 * One answer of the bot, read top to bottom in the order it happened: the face and name once, then
 * its words, lines of work and helper rows, and while nothing is live the quiet thinking line at the
 * very end, where the next thing will appear. When the turn has ended (and no helper of it still
 * works), everything before the answer folds into one quiet line, "Worked for 1m 11s", that opens to
 * show the work again in place.
 */
export function Answer({ block, bot, bots, foldWork, thinking }: { block: AnswerBlock; bot?: Bot; bots: Bot[]; foldWork: boolean; thinking: string }) {
  const inHelper = useContext(InHelper);
  const speakerId = block.items.find(isOutput)?.botId;
  const speaker = (speakerId ? bots.find((b) => b.id === speakerId) : undefined) ?? bot;
  const all = pieces(block.items);
  let lastStep = -1;
  all.forEach((p, i) => (p.kind === "work" || p.kind === "helpers" || p.kind === "browser") && (lastStep = i));
  // The answer: the text after the last step; when nothing was said after it, the last text before it.
  // A block is one turn (engine 0.31.2): a turn the bot began when a helper or a command in the
  // background reported back has a block and an answer of its own, so no turn's answer folds away.
  const answer = new Set<string>();
  if (lastStep >= 0) {
    const after = all.slice(lastStep + 1).filter((p) => p.kind === "text");
    if (after.length) for (const p of after) answer.add(p.key);
    else {
      const before = all.slice(0, lastStep).reverse().find((p) => p.kind === "text");
      if (before) answer.add(before.key);
    }
  }
  // Protocol 23: after his question about a card that went into the turn, what the bot said before
  // its next step answers him: it stays in sight too.
  if (block.afterQuestion) {
    for (const p of all) {
      if (p.kind !== "text") break;
      answer.add(p.key);
    }
  }
  // An artifact is part of the answer, not of the work: its row stays in sight, in its order.
  for (const p of all) if (p.kind === "artifact") answer.add(p.key);
  const running = block.items.some((i) => (i.kind === "bot" && i.streaming) || (isStep(i) && i.status === "running"));
  const canFold = foldWork && !block.current && !block.turnLive && !running && lastStep >= 0;
  // A browser row is work, and folds away with it. But while its workspace is still open after the
  // turn (the bot left it open because it needs the person), it stays in sight with the answer, in
  // its order, like an artifact's row. Once in sight it stays there until the chat is drawn again,
  // also after the workspace closes: nothing moves under the person's eyes. Drawn again later, a
  // closed one is in the fold.
  const inView = useRef(new Set<string>());
  for (const p of all) if (p.kind === "browser" && p.item.status === "open" && canFold) inView.current.add(p.key);
  for (const p of all) if (p.kind === "browser" && inView.current.has(p.key)) answer.add(p.key);

  const [shut, setShut] = useState(canFold);
  const [open, setOpen] = useState(() => openWork.has(block.key));
  const [foldedHere, setFoldedHere] = useState(false);
  const flow = useRef<HTMLDivElement>(null);
  const restore = useRef<(() => void) | null>(null);
  const folded = shut && canFold;

  // The moment of folding: the work fades out where it stands (at once with reduced motion), then
  // closes into the line, keeping the place the person reads.
  useLayoutEffect(() => {
    if (!canFold) {
      if (shut) setShut(false);
      return;
    }
    if (shut) return;
    const el = flow.current;
    const close = () => {
      restore.current = el ? keepPlace(el) : null;
      setFoldedHere(true);
      setShut(true);
    };
    const work = el ? [...el.querySelectorAll<HTMLElement>(":scope > [data-work]")] : [];
    const quick = el ? tokenMs(el, "--dur-quick") : 0;
    if (!el || work.length === 0 || reducedMotion() || quick <= 0 || typeof work[0]!.animate !== "function") {
      close();
      return;
    }
    const easing = getComputedStyle(el).getPropertyValue("--ease-soft").trim() || "linear";
    const fades = work.map((w) => w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: quick, easing, fill: "forwards" }));
    let gone = false;
    Promise.all(fades.map((a) => a.finished)).then(
      () => !gone && close(),
      () => undefined,
    );
    return () => {
      gone = true;
      for (const a of fades) a.cancel();
    };
  }, [canFold, shut]);
  useLayoutEffect(() => {
    if (!shut || !restore.current) return;
    restore.current();
    restore.current = null;
  }, [shut]);

  const toggle = () => {
    const next = !open;
    if (next) openWork.add(block.key);
    else openWork.delete(block.key);
    setOpen(next);
    // The line stays where it is and the work opens below it. Tell the chat whether it is still at
    // the bottom, so the next new message does not pull the line away from the person.
    requestAnimationFrame(() => flow.current?.closest(".pb-main-scroll")?.dispatchEvent(new Event("scroll")));
  };

  const firstAt = block.items.find((i) => !(i.kind === "bot" && i.text === ""))?.at;
  const turnId = block.items.find((i) => i.turnId)?.turnId;
  // The newest group of work while the bot is in this answer is live: it shows what runs now, and
  // while nothing runs the thinking words stand in it (no thinking line of its own below it, so
  // nothing comes and goes under it).
  const lastPiece = all[all.length - 1];
  const liveWork = !!block.current && lastPiece?.kind === "work" ? lastPiece.key : undefined;
  const draw = (p: Piece, work: boolean) =>
    p.kind === "text" ? (
      <AnswerText key={p.key} item={p.item} work={work} />
    ) : p.kind === "work" ? (
      <WorkGroup key={p.key} id={p.key} items={p.items} work={work} live={p.key === liveWork} thinking={p.key === liveWork && block.thinking ? thinking : undefined} />
    ) : p.kind === "artifact" ? (
      <ArtifactRow key={p.key} item={p.item} />
    ) : p.kind === "browser" ? (
      <BrowserRow key={p.key} item={p.item} work={work} />
    ) : (
      <div className="pb-helper-group" role="group" aria-label={p.items.length === 1 ? "Helper" : "Helpers"} key={p.key} data-work={work || undefined}>
        {p.items.map((item) => (
          <HelperRow key={item.id} item={item} />
        ))}
      </div>
    );

  let body: ReactNode;
  if (folded) {
    const start = ms((block.start ?? block.items[0]!).at);
    const endMs = Math.max(...block.items.map(endOf));
    const end = new Date(endMs).toISOString();
    const helpers = block.items.filter((i) => i.kind === "helper").length;
    const workId = `work-${block.key}`;
    body = (
      <>
        <button type="button" className={`pb-worked${foldedHere ? " pb-fade-in" : ""}`} key="worked" aria-expanded={open} aria-controls={open ? workId : undefined} onClick={toggle}>
          <ChevronIcon />
          <span className="pb-worked-words">{`Worked for ${workedFor(endMs - start)}${helpers ? ` · ${plural(helpers, "helper")}` : ""}`}</span>
          <time className="pb-time" dateTime={end}>
            {clockTime(end)}
          </time>
        </button>
        {open && (
          <div className="pb-work" id={workId} key="work" role="group" aria-label="The work">
            {all.filter((p) => !answer.has(p.key)).map((p) => draw(p, false))}
          </div>
        )}
        {all.filter((p) => answer.has(p.key)).map((p) => draw(p, false))}
      </>
    );
  } else {
    body = (
      <>
        {all.map((p) => draw(p, canFold && !answer.has(p.key)))}
        {block.thinking && !liveWork && <WaitingLine key="thinking" bot={bot} words={thinking} />}
      </>
    );
  }

  return (
    <article className="pb-msg pb-answer pb-arrive" data-turn={turnId} data-helper={inHelper ? true : undefined} data-current={block.current || undefined} data-folded={folded || undefined}>
      {!block.head ? (
        <span aria-hidden="true" />
      ) : inHelper ? (
        <span className="pb-who pb-who-mark" aria-hidden="true">
          <HelperIcon />
        </span>
      ) : speaker ? (
        <Face look={speaker.look} state={block.current ? speaker.state : undefined} size="sm" />
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="pb-answer-col">
        {block.head && (
          <div className="pb-msg-head">
            <b>{inHelper ? inHelper.name : (speaker?.name ?? "Bot")}</b>
            {firstAt && <time dateTime={firstAt}>{clockTime(firstAt)}</time>}
          </div>
        )}
        {block.head && block.woke && !inHelper && <p className="pb-woke">{WOKE_LINE}</p>}
        <div className="pb-answer-flow" ref={flow}>
          {body}
        </div>
      </div>
    </article>
  );
}

/** A piece of what the bot said, inside its answer. */
export const AnswerText = memo(function AnswerText({ item, work }: { item: BotItem; work: boolean }) {
  return (
    <div className="pb-msg-body app-md pb-arrive" data-turn={item.turnId} data-item={item.id} data-work={work || undefined}>
      <MarkdownText text={item.text} />
    </div>
  );
});
