// A chat's items grouped into blocks: answers, folds of a helper's turns and fresh starts.
import { createContext } from "react";
import type { ActivityItem, ArtifactItem, Bot, BotItem, BrowserItem, HelperItem, Item, NoticeItem, UserItem } from "../../shared/protocol";
import { STATE_WORD } from "../lib/words";

/** Inside a helper's thread, the bot it works for and how deep it is. Null in a bot's own chat. */
export const InHelper = createContext<{ bot: Bot; depth: number; name: string } | null>(null);

/** Within this many pixels of the bottom counts as "at the bottom". */
export const PIN_SLACK = 32;

/**
 * One answer of the bot: its words, its lines of work and its helpers, in the order they came, under
 * the bot's face and name once. A turn reads top to bottom as one continuous answer.
 */
export interface AnswerBlock {
  answer: true;
  /**
   * Stable for the life of the answer: made from what stands before it, so the thinking line that
   * stands before anything came and the answer that then fills it are one and the same.
   */
  key: string;
  /** The bot's words, lines of work and helper rows, in order. */
  items: Item[];
  /** The message that started the turn, for how long it worked. */
  start?: Item;
  /** The face and name stand at its top. Not for the rest of a turn that goes on after a notice. */
  head: boolean;
  /** The quiet thinking line stands at its end: the bot is at work and nothing else is live. */
  thinking?: boolean;
  /** The newest answer, while the bot is still in it. */
  current?: boolean;
  /**
   * An earlier part of the turn the bot is still in (before a message steered into it): its work does
   * not fold away until the turn has ended (step 7a).
   */
  turnLive?: boolean;
  /**
   * Protocol 23: it follows his question about a card that went into the turn (the bot's waiting
   * ask_human returned it, or he pressed Steer now). The bot's first words here answer him, so they
   * stay in sight when the work folds, as the turn's answer does.
   */
  afterQuestion?: boolean;
  /**
   * Engine 0.31.2: no message started its turn. The bot began it by itself, when a helper or a
   * command in the background reported back, and a quiet line under its name says so. Never on the
   * first thing loaded, whose message may stand on an older page.
   */
  woke?: boolean;
}

export const isOutput = (i: Item): i is BotItem | ActivityItem | HelperItem | ArtifactItem | BrowserItem =>
  i.kind === "bot" || i.kind === "activity" || i.kind === "helper" || i.kind === "artifact" || i.kind === "browser";
export const isStep = (i: Item): i is ActivityItem | HelperItem => i.kind === "activity" || i.kind === "helper";
export const blockKey = (b: ThreadBlock): string => ("answer" in b ? b.key : "fold" in b ? `fold-${b.turnId}` : "tidy" in b ? `tidy-${b.key}` : b.id);
/** The key of an answer that comes after this block. */
export const answerKey = (before: ThreadBlock | undefined): string => `a:${before ? blockKey(before) : "start"}`;
/** The turn an answer belongs to: that of its last item that has one. */
export const turnOf = (a: AnswerBlock): string | undefined => a.items.findLast((i) => i.turnId)?.turnId;
/**
 * The block at `at` follows a notice that itself follows an answer: the same answer goes on, without
 * a second face. Only within one turn: another turn (`turnId`) begins an answer of its own.
 */
export const afterAnswerNotice = (blocks: ThreadBlock[], at: number, turnId?: string): boolean => {
  const prev = blocks[at - 1];
  const before = blocks[at - 2];
  if (!prev || "answer" in prev || "fold" in prev || "tidy" in prev || prev.kind !== "notice" || !before || !("answer" in before)) return false;
  const was = turnOf(before) ?? prev.turnId;
  return !turnId || !was || was === turnId;
};
/** The newest block is a message steered into the bot's turn: what comes next goes on without a new face. */
export const steeredLast = (blocks: ThreadBlock[]): boolean => {
  const last = blocks[blocks.length - 1];
  return !!last && !("answer" in last) && !("fold" in last) && !("tidy" in last) && last.kind === "user" && !!last.steered;
};

/** Something in an answer that is happening now: a running step, or text arriving. */
export const isLive = (i: Item): boolean => (i.kind === "bot" && i.streaming && i.text !== "") || (isStep(i) && i.status === "running");

/**
 * The answer is live when its last thing is (a running step or helper, arriving text), or while a
 * step it started earlier still runs. Then nothing stands below it.
 */
export function answerLive(a: AnswerBlock): boolean {
  const last = a.items[a.items.length - 1];
  if (last && isLive(last)) return true;
  return a.items.some((i) => i.kind === "activity" && i.status === "running");
}

/** The words of the thinking line, from the engine. "Writing a reply" is never a line of its own: the text shows it. */
export function thinkingLine(bot: Bot): string {
  const words = bot.activity.trim();
  if (!words || /^writing (a reply|an answer)/i.test(words)) return STATE_WORD.thinking;
  return words;
}

/**
 * Puts the bot's words, lines of work and helper rows that follow each other into answers. Every turn
 * begins an answer of its own, also one the bot began by itself when a helper or a command in the
 * background reported back (engine 0.31.2; until then such a turn carried on the answer before it,
 * whose final words then folded away). A message, a notice or a fold ends an answer; the same turn
 * after a notice or a steered message goes on without a second face.
 */
export function withAnswers(flat: (Item | FoldBlock | TidyBlock)[]): ThreadBlock[] {
  const started = new Set<string>();
  for (const b of flat) if (!("fold" in b) && !("tidy" in b) && b.kind === "user" && b.turnId) started.add(b.turnId);
  const out: ThreadBlock[] = [];
  let cur: AnswerBlock | null = null;
  let curTurn: string | undefined;
  let lastStart: Item | undefined;
  // A message steered into the turn the bot is in: the work after it goes on under the same face (step 7a).
  let steeredInto: string | undefined;
  let question = false;
  // A turn seen before: from then on, a turn's message would stand in what is loaded.
  let seenTurn = false;
  for (const b of flat) {
    if (!("fold" in b) && !("tidy" in b) && isOutput(b)) {
      if (cur && b.turnId && curTurn && b.turnId !== curTurn) cur = null;
      if (!cur) {
        const start = lastStart && (!b.turnId || !lastStart.turnId || lastStart.turnId === b.turnId) ? lastStart : undefined;
        const goesOn = !!steeredInto && (!b.turnId || b.turnId === steeredInto);
        // Right after a message (one whose turn id the window has not heard yet) it is that message's turn.
        const prev = out[out.length - 1];
        // Or right after Pobots' own line that says why the turn starts by itself (protocol 33).
        const afterMessage = !!prev && !("answer" in prev) && !("fold" in prev) && !("tidy" in prev) && (prev.kind === "user" || (prev.kind === "notice" && !!prev.startsTurn));
        const woke = !!b.turnId && !started.has(b.turnId) && !goesOn && !afterMessage && seenTurn && !afterAnswerNotice(out, out.length, b.turnId);
        cur = {
          answer: true,
          key: answerKey(out[out.length - 1]),
          items: [],
          head: !afterAnswerNotice(out, out.length, b.turnId) && !goesOn,
          start,
          ...(goesOn && question ? { afterQuestion: true } : {}),
          ...(woke ? { woke: true } : {}),
        };
        curTurn = undefined;
        out.push(cur);
      }
      steeredInto = undefined;
      cur.items.push(b);
      if (b.turnId) curTurn = b.turnId;
      if (b.turnId) seenTurn = true;
      continue;
    }
    if (b.turnId) seenTurn = true;
    const steered = !("fold" in b) && !("tidy" in b) && b.kind === "user" && !!b.steered && !!b.turnId && b.turnId === (curTurn ?? lastStart?.turnId);
    steeredInto = steered ? (b as UserItem).turnId : undefined;
    const from = steered ? (b as UserItem).from : undefined;
    question = from?.type === "you" && !!from.question;
    cur = null;
    out.push(b);
    if (!steered && !("fold" in b) && !("tidy" in b) && b.kind === "user") lastStart = b;
  }
  return out;
}

/** A whole turn that another bot started, shown as one line until opened. */
export interface FoldBlock {
  fold: true;
  turnId: string;
  /** The message from the other bot that started the turn. */
  start: UserItem & { from: { type: "bot"; botId: string; expectsReply: boolean } };
  items: Item[];
}

/**
 * A tidy turn: the bot writing down what matters before its session is replaced. Never drawn as
 * messages. It stands as one quiet line at the place of its first item: "Writing down what matters"
 * while it runs, "Started fresh" once the engine's notice has come, and nothing if it failed.
 */
export interface TidyBlock {
  tidy: true;
  /** Stable for the life of the block: the id of the request that started it, else of the notice. */
  key: string;
  turnId?: string;
  /** The request, the steps and the bot's note, in order. */
  items: Item[];
  /** The "fresh" notice that ends it, once it has come. */
  notice?: NoticeItem;
}

export type ThreadBlock = Item | FoldBlock | TidyBlock | AnswerBlock;

export const isTidyRequest = (item: Item | undefined): boolean => item?.kind === "user" && item.from.type === "app";

/**
 * Groups the items of every turn another bot started (its first item is a user item from a bot)
 * into one fold, at the place of its first item, up to a message the person steered into it: that
 * message and the rest of the turn stand in the chat. A turn the person started is never folded. A tidy
 * turn (its first item is the app's request) and the "fresh" notice that ends it become one tidy
 * block, at the place of its first item, so messages that waited behind it stay below it.
 */
export function foldTurns(items: Item[]): ThreadBlock[] {
  const firstOfTurn = new Map<string, Item>();
  for (const item of items) if (item.turnId && !firstOfTurn.has(item.turnId)) firstOfTurn.set(item.turnId, item);
  const out: (Item | FoldBlock | TidyBlock)[] = [];
  const folds = new Map<string, FoldBlock>();
  const tidies = new Map<string, TidyBlock>();
  /** Turns another bot started that the person steered a message into. */
  const joined = new Set<string>();
  for (const item of items) {
    if (item.kind === "notice" && item.mark === "fresh") {
      const turnId = item.tidyTurnId;
      let tidy = turnId ? tidies.get(turnId) : undefined;
      if (!tidy) {
        tidy = { tidy: true, key: item.id, turnId, items: [] };
        if (turnId) tidies.set(turnId, tidy);
        out.push(tidy);
      }
      tidy.notice = item;
      continue;
    }
    const first = item.turnId ? firstOfTurn.get(item.turnId) : undefined;
    if (isTidyRequest(item) && !item.turnId) {
      // A request whose turn has not started yet.
      out.push({ tidy: true, key: item.id, items: [item] });
      continue;
    }
    if (first && isTidyRequest(first)) {
      let tidy = tidies.get(item.turnId!);
      if (!tidy) {
        tidy = { tidy: true, key: first.id, turnId: item.turnId, items: [] };
        tidies.set(item.turnId!, tidy);
        out.push(tidy);
      }
      tidy.items.push(item);
      continue;
    }
    // The person's own message steered into a turn another bot started is never folded away, and it
    // stands where the bot read it: the fold keeps the part before it, and the rest of the turn, the
    // bot's answer to the person too, stands open after it. Until 0.21.1 the fold took the whole turn
    // and the message ended below all of it (decided 15 Nov 2026).
    if (first && first.kind === "user" && first.from.type === "bot" && item.kind === "user" && item.from.type === "you") {
      joined.add(item.turnId!);
      out.push(item);
      continue;
    }
    if (first && first.kind === "user" && first.from.type === "bot" && !joined.has(item.turnId!)) {
      let fold = folds.get(item.turnId!);
      if (!fold) {
        fold = { fold: true, turnId: item.turnId!, start: first as FoldBlock["start"], items: [] };
        folds.set(item.turnId!, fold);
        out.push(fold);
      }
      fold.items.push(item);
    } else out.push(item);
  }
  // The bot's words and work between them become answers.
  return withAnswers(out);
}

/**
 * The key of the tidy block that is running now, if any: the last tidy block, without its notice,
 * while the engine says the bot is tidying or the turn still has work running, and no later turn has
 * started. A tidy turn that failed or was stopped leaves nothing in the chat.
 */
export function liveTidyKey(blocks: ThreadBlock[], bot: Bot): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (!("tidy" in b)) continue;
    if (b.notice) return undefined;
    const laterTurn = blocks.slice(i + 1).some((x) => "fold" in x || ("answer" in x ? x.items.length > 0 : "tidy" in x ? false : x.kind === "user" && !!x.turnId && !x.queued));
    if (laterTurn) return undefined;
    const running = b.items.some((x) => (x.kind === "bot" && x.streaming) || (x.kind === "activity" && x.status === "running"));
    return running || bot.context?.tidying ? b.key : undefined;
  }
  return undefined;
}
