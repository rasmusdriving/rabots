// Steering (protocol 14): a message sent into a running turn, putting it back in line, and the line itself.
import { away, requirePresent } from "./vacation.js";
import { questionBackInLine, questionTurnStarts } from "./card-questions.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import type { Methods, UserItem } from "../../shared/protocol.js";
import { contentFor, type Picture } from "../attachments.js";
import { log } from "../log.js";
import { saveHold, startNextInLine } from "./stop.js";
import { EngineError } from "../errors.js";
import { messageFraming } from "../team.js";
import { noteKey } from "./restored-cards.js";

/**
 * Whether a message for this thread can go into the bot's running turn now: a turn of the live
 * session in the main chat, not a tidy turn or a fresh run, no Stop asked or holding, and a harness
 * that can steer. Otherwise the message waits in line as before.
 */
export function canSteer(eng: Engine, rt: BotRuntime, threadId: string): boolean {
  // Keep a follow-up from the person in its own turn. A connection ask sends its last reply outside.
  if (rt.turn?.startedBy === "connection") return false;
  const t = rt.turn;
  const s = rt.session;
  return (
    !eng.stopping && !away(rt) &&
    rt.busy &&
    !!t &&
    !t.tidy &&
    !t.fresh &&
    t.threadId === threadId &&
    threadId === rt.threadId &&
    rt.sessionThread === threadId &&
    !rt.interruptRequested &&
    !rt.hold &&
    !rt.swallow &&
    !!s &&
    !s.closed &&
    typeof s.steer === "function"
  );
}

/**
 * Hands a steered message to the harness: its text built as at the start of a turn (a GPT bot gets a
 * file's text, a picture goes as a picture). Should the turn have ended meanwhile, or the harness
 * refuse it, the message waits in line instead: never lost, and sent only once.
 */
export async function steerInto(eng: Engine, rt: BotRuntime, item: UserItem): Promise<boolean> {
  const turn = rt.turn;
  const session = rt.session;
  let ok = false;
  try {
    let text = item.text;
    let pictures: Picture[] | undefined;
    if (item.attachments?.length) {
      const attached = (eng.withMissing(item) as UserItem).attachments ?? [];
      const built = await contentFor(rt.folder.dir, text, attached, { harness: rt.sessionHarness ?? rt.folder.file.harness, seesPictures: eng.seesPictures(rt) });
      text = built.text;
      if (built.pictures.length) pictures = built.pictures;
    }
    // From another bot (message_bot delivery steer): framed as information, as at the start of a turn.
    if (item.from.type === "bot") text = `${messageFraming(eng.nameOf(item.from.botId), "steer")}\n\n${text}`;
    // An answer to a card that came back after a restart: its note goes with it (engine 0.29.0).
    const cardNote = item.from.type === "you" && item.from.card && !item.from.question ? eng.store.getValue(noteKey(item.id)) : undefined;
    if (cardNote) text = `${cardNote}\n\n${text}`;
    // Engine 0.31.0: his question about a card, steered in with "Steer now": this turn answers it.
    const questionNote = item.from.type === "you" && item.from.question && turn ? questionTurnStarts(eng, rt, item, turn.id) : undefined;
    if (questionNote) text = `${questionNote}\n\n${text}`;
    if (session?.steer && rt.turn === turn && rt.session === session && canSteer(eng, rt, item.threadId)) {
      ok = await session.steer(text, { id: item.id, ...(pictures ? { pictures } : {}) });
    }
  } catch (err) {
    log.warn(`Bot ${rt.folder.id}: a message could not be steered`, err);
  }
  if (ok) {
    log.info(`Bot ${rt.folder.id}: a message was steered into its turn`);
    if (item.from.type === "you" && item.from.card) eng.store.deleteValue(noteKey(item.id));
  } else {
    if (item.from.type === "you" && item.from.question) questionBackInLine(eng, rt, item.id);
    backInLine(eng, rt, [item.id], "the harness could not take it now");
  }
  return ok;
}

/**
 * Steered messages the harness did not take (refused, or given back unread by a Stop or the end of
 * its process) wait in line again, first, in their order. A Stop that holds holds them too.
 */
export function backInLine(eng: Engine, rt: BotRuntime, ids: string[], why: string): void {
  const back: string[] = [];
  for (const id of ids) {
    const cur = eng.store.getItem(id);
    if (!cur || cur.kind !== "user" || rt.queue.includes(id)) continue;
    const { steered: _steered, turnId: _turnId, ...rest } = cur;
    eng.putItem({ ...rest, queued: true });
    back.push(id);
    if (rt.hold) rt.hold.held.add(id);
  }
  if (!back.length) return;
  rt.queue.unshift(...back);
  if (rt.hold) {
    saveHold(eng, rt);
    if (!rt.busy && (rt.state === "done" || rt.state === "idle")) eng.setState(rt, rt.state, rt.activity);
  }
  log.info(`Bot ${rt.folder.id}: ${back.length === 1 ? "a steered message waits" : `${back.length} steered messages wait`} in line instead (${why})`);
  startNextInLine(eng, rt);
}

/** "message.steer": a queued message from the person goes into the running turn now. */
export function steerQueued(eng: Engine, params: Methods["message.steer"]["params"]): Methods["message.steer"]["result"] {
  const rt = eng.bot(params.botId);
  const item = eng.store.getItem(params.itemId);
  if (!item || item.kind !== "user" || item.from.type !== "you" || !item.queued || !rt.queue.includes(item.id)) {
    throw new EngineError("not_found", "That message is no longer waiting.");
  }
  if (rt.hold?.held.has(item.id) || !canSteer(eng, rt, item.threadId)) return { steered: false };
  rt.queue.splice(rt.queue.indexOf(item.id), 1);
  const steered: UserItem = { ...item, queued: false, steered: true, turnId: rt.turn!.id };
  eng.putItem(steered);
  void steerInto(eng, rt, steered);
  return { steered: true };
}

/** "message.unqueue": the person takes a waiting message back before the bot read it (step 7a). */
export function unqueue(eng: Engine, params: Methods["message.unqueue"]["params"]): Methods["message.unqueue"]["result"] {
  const rt = eng.bot(params.botId);
  requirePresent(rt);
  const item = eng.store.getItem(params.itemId);
  if (!item || item.kind !== "user" || item.from.type !== "you" || !item.queued || !rt.queue.includes(item.id)) {
    throw new EngineError("not_found", "That message is no longer waiting.");
  }
  // Engine 0.31.0: nor a question about a card or to-do: it is kept with the card.
  if (item.from.question) throw new EngineError("bad_request", "A question on a card cannot be taken back.");
  // An answer to a to-do is not taken back: the to-do has left the list with it (step 7c).
  if (item.from.todo) throw new EngineError("bad_request", "An answer to a to-do cannot be taken back.");
  // Nor an answer to a card that came back after a restart: the card has left the rail with it (engine 0.29.0).
  if (item.from.card) throw new EngineError("bad_request", "An answer to a card cannot be taken back.");
  rt.queue.splice(rt.queue.indexOf(item.id), 1);
  if (rt.hold?.held.delete(item.id)) saveHold(eng, rt);
  eng.askByItem.delete(item.id);
  eng.store.removeItem(item.id);
  eng.opts.emit("item.removed", { threadId: item.threadId, itemId: item.id });
  log.info(`Bot ${rt.folder.id}: a waiting message was taken back`);
  if (rt.hold && !rt.busy && (rt.state === "done" || rt.state === "idle")) eng.setState(rt, rt.state, rt.activity);
  return {};
}

/** "thread.queued": the messages of a thread that wait, oldest first (step 7a). */
export function queuedOf(eng: Engine, threadId: string): Methods["thread.queued"]["result"] {
  return { items: eng.store.queuedItems(threadId).filter((i): i is UserItem => i.kind === "user") };
}
