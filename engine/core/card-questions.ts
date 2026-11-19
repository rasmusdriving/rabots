// Engine 0.31.0: follow-up questions on cards (docs/build/step-card-follow-ups.md).
//
// The person may ask a bot about one of its to-dos or question cards before he acts. The card stays
// open: a question is not an answer. Two ways, as T3 Code has them:
//
// - A question card whose tool call still waits (ask_human, the harness's own question tool, a task
//   manager's ask_human): his question ends the call with his words (T3's approval feedback,
//   ClaudeAdapterV2.ts permissionResultFromDecision). The card is "parked": it stays where it is, the
//   bot answers in its reply, and its next question card takes the parked card's place (same id, same
//   spot, the thread kept). What the bot wrote in between is the answer.
// - Everything else (a to-do, a card after a restart, a parked card, a GPT bot's card whose call was
//   answered early): his question goes to the bot as his message, marked as a question, waiting in
//   line and never steering in. The bot's last message of the turn it starts is the answer, as a
//   bot-to-bot ask takes it. A task manager's to-do or card goes to the task manager while it is there.
import { away, requirePresent } from "./vacation.js";
import type { Engine } from "../engine.js";
import type { BotRuntime, InternalDecision, PendingCard } from "./runtime.js";
import { deliver, type ManagerMessage, type TaskManager } from "./task-managers.js";
import { CARD_QUESTION_TEXT_MAX, CARD_QUESTIONS_MAX, type CardQuestion, type Methods, type QuestionCard, type UserItem } from "../../shared/protocol.js";
import { randomUUID } from "node:crypto";
import { EngineError } from "../errors.js";
import { log } from "../log.js";
import { clip, now } from "./words.js";
import { endHold, saveHold, startNextInLine } from "./stop.js";
import { answered } from "./restored-cards.js";
import { restWaitChanged } from "./restored-waiting.js";
import { FOLLOW_UP_RULE } from "../tool-names.js";


/** An answer kept in the card is cut here; the whole of it stays in the chat. */
export const QUESTION_ANSWER_MAX = 4000;

/** What a waiting question card's call returns when the person asks about it. */
export function followUpWords(question: string, tool: string): string {
  return `The person asks before answering: ${question}\n\nTheir card stays open. Answer them in your reply now, in plain words; then call ${tool} again to get their answer (the same question, or a better one if your answer changed it). Your new card takes this card's place.`;
}

type Target = { kind: "todo" | "card"; id: string };

/** A question that went as a message to the bot: answered by the turn it starts. */
interface TurnWatch {
  target: Target;
  qid: string;
  turnId: string;
  /** His message that carried it. */
  itemId: string;
}

/** A question that went to a task manager: answered by its turn that takes it up. */
interface ManagerWatch {
  target: Target;
  qid: string;
  botId: string;
  tmId: string;
  itemId: string;
  active: boolean;
}

/** A question card whose call returned with his question: it stays until the next card takes its place. */
interface Park {
  cardId: string;
  botId: string;
  /** "bot:<botId>" or "tm:<task manager id>": whose next question card takes the place. */
  owner: string;
  qid: string;
  /** What the owner wrote since, by item. */
  texts: Map<string, string>;
  open: boolean;
  /** His answer, when he answered the card before the bot asked again. */
  stash?: InternalDecision;
  card: QuestionCard;
}

interface State {
  turns: Map<string, TurnWatch[]>;
  managers: ManagerWatch[];
  parks: Map<string, Park>;
}

const states = new WeakMap<Engine, State>();

function st(eng: Engine): State {
  let s = states.get(eng);
  if (!s) {
    s = { turns: new Map(), managers: [], parks: new Map() };
    states.set(eng, s);
  }
  return s;
}

/** Where a question that went as a message waits for its turn, keyed by the message's item id. */
const itemKey = (itemId: string) => `cardq:${itemId}`;

const newQuestionId = () => `cq_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

// ------------------------------------------------------------ a card's or to-do's questions

function readQuestions(eng: Engine, t: Target): CardQuestion[] | undefined {
  if (t.kind === "todo") {
    const row = eng.store.getTodo(t.id);
    return row && row.status === "open" ? (row.todo.questions ?? []) : undefined;
  }
  const p = eng.cards.get(t.id);
  return p?.card.kind === "question" ? (p.card.questions ?? []) : undefined;
}

/** Writes a to-do's or card's questions, and tells the window. Nothing when it has left. */
function writeQuestions(eng: Engine, t: Target, change: (qs: CardQuestion[]) => CardQuestion[]): void {
  if (!eng.store.isOpen) return;
  if (t.kind === "todo") {
    const row = eng.store.getTodo(t.id);
    if (!row || row.status !== "open") return;
    const todo = { ...row.todo, questions: change(row.todo.questions ?? []) };
    eng.store.saveTodo({ ...row, todo });
    if (!away(eng.bots.get(todo.botId))) eng.opts.emit("todo.changed", { todo });
    return;
  }
  const p = eng.cards.get(t.id);
  if (!p || p.card.kind !== "question") return;
  const card: QuestionCard = { ...p.card, questions: change(p.card.questions ?? []) };
  p.card = card;
  const park = st(eng).parks.get(t.id);
  if (park) park.card = card;
  eng.store.addCard(card);
  if (!away(p.rt)) eng.opts.emit("card.changed", { card });
}

function settle(qs: CardQuestion[], qid: string, said: string): CardQuestion[] {
  const answer = said.trim();
  return qs.map((q) =>
    q.id !== qid || q.state === "answered" || q.state === "unanswered"
      ? q
      : answer
        ? { ...q, state: "answered" as const, answer: clip(answer, QUESTION_ANSWER_MAX), answeredAt: now() }
        : { ...q, state: "unanswered" as const },
  );
}

function setState(qs: CardQuestion[], qid: string, state: CardQuestion["state"]): CardQuestion[] {
  return qs.map((q) => (q.id === qid && (q.state === "queued" || q.state === "answering") ? { ...q, state } : q));
}

function add(qs: CardQuestion[], q: CardQuestion): CardQuestion[] {
  const list = [...qs, q];
  const finished = list.findIndex((entry) => entry.state === "answered" || entry.state === "unanswered");
  if (list.length > CARD_QUESTIONS_MAX && finished >= 0) list.splice(finished, 1);
  return list;
}

function cleanText(text: string): string {
  const t = text.trim();
  if (!t) throw new EngineError("bad_request", "Write a question first.");
  if (t.length > CARD_QUESTION_TEXT_MAX) throw new EngineError("bad_request", `Keep the question under ${CARD_QUESTION_TEXT_MAX.toLocaleString("en")} characters.`);
  return t;
}

/** Never drop an unanswered question to make room in a long history. */
function checkRoom(qs: CardQuestion[]): void {
  if (qs.filter((q) => q.state === "queued" || q.state === "answering").length >= CARD_QUESTIONS_MAX) {
    throw new EngineError("bad_request", "There are too many questions waiting. Try again when a reply comes.");
  }
}

// ------------------------------------------------------------ the person asks

/** "todo.ask": his question about a to-do goes to its bot (or task manager). The to-do stays open. */
export function askOnTodo(eng: Engine, params: Methods["todo.ask"]["params"]): Methods["todo.ask"]["result"] {
  if (eng.stopping) throw new EngineError("unavailable", "Pobots is stopping. Ask again in a moment.");
  const row = eng.store.getTodo(params.todoId);
  if (!row || row.status !== "open") throw new EngineError("not_found", "This to-do is no longer on your list.");
  const rt = eng.bots.get(row.todo.botId);
  if (!rt) throw new EngineError("not_found", "The bot of this to-do is gone.");
  requirePresent(rt);
  const text = cleanText(params.text);
  checkRoom(row.todo.questions ?? []);
  const todo = row.todo;
  const target: Target = { kind: "todo", id: todo.id };
  const from: UserItem["from"] = { type: "you", todo: { id: todo.id, title: todo.title }, question: true };
  const tm = todo.taskManager ? rt.managers.get(todo.taskManager.id) : undefined;
  if (tm) {
    toManager(eng, rt, tm, target, text, from, `The person asks about your to-do "${todo.title}" (${todo.id}) before acting on it. The to-do is still open on their list; this is not their answer. ${FOLLOW_UP_RULE} Their question:`);
    log.info(`Bot ${rt.folder.id}: the person asked a task manager about its to-do`);
    return {};
  }
  eng.checkReady(rt);
  toBot(eng, rt, target, text, from);
  log.info(`Bot ${rt.folder.id}: the person asked about a to-do`);
  return {};
}

/** "card.ask": his question about a question card. The card stays open. */
export function askOnCard(eng: Engine, params: Methods["card.ask"]["params"]): Methods["card.ask"]["result"] {
  if (eng.stopping) throw new EngineError("unavailable", "Pobots is stopping. Ask again in a moment.");
  const pending = eng.cards.get(params.cardId);
  if (!pending) throw new EngineError("not_found", "That card is no longer open.");
  const card = pending.card;
  const rt = pending.rt;
  if (card.kind !== "question" || card.helper || !rt || pending.helper) throw new EngineError("bad_request", "This card does not take questions.");
  const text = cleanText(params.text);
  checkRoom(card.questions ?? []);
  const target: Target = { kind: "card", id: card.id };
  // The call that raised it still waits: it returns with his question, and the card stays.
  const from: UserItem["from"] = { type: "you", card: { id: card.id, title: card.title }, question: true };
  if (!pending.restored && !pending.call?.detached) {
    const qid = newQuestionId();
    writeQuestions(eng, target, (qs) => add(qs, { id: qid, at: now(), text, state: "answering" }));
    // Show his question above the answer, in the same turn as the waiting call.
    eng.addItem(rt, { kind: "user", at: now(), text, from, ...feedbackFields(rt, card.threadId) }, card.threadId);
    park(eng, pending, qid);
    pending.resolve({ type: "ask", text });
    log.info(`Bot ${rt.folder.id}: the person asked about a question card while its call waited`);
    return {};
  }
  const tm = card.taskManager !== undefined ? (pending.manager ? rt.managers.get(pending.manager) : [...rt.managers.values()].find((m) => m.ownThread === card.threadId)) : undefined;
  if (tm) {
    toManager(eng, rt, tm, target, text, from, `The person asks about the question you put on a card, "${card.title}", before answering it. The card is still open; this is not their answer, which reaches you later. Answer plainly. Their question:`);
    log.info(`Bot ${rt.folder.id}: the person asked a task manager about its card`);
    return {};
  }
  eng.checkReady(rt);
  toBot(eng, rt, target, text, from, st(eng).parks.has(card.id) ? card.threadId : undefined);
  log.info(`Bot ${rt.folder.id}: the person asked about a card`);
  return {};
}

/** As a message from him that waits in line and never steers in, like an answer to a to-do. */
function toBot(eng: Engine, rt: BotRuntime, target: Target, text: string, from: UserItem["from"], threadId?: string): void {
  const itemId = randomUUID();
  const qid = newQuestionId();
  writeQuestions(eng, target, (qs) => add(qs, { id: qid, at: now(), text, state: "queued", itemId }));
  eng.store.setValue(itemKey(itemId), JSON.stringify({ target, qid }));
  const holding = !!rt.hold;
  eng.enqueue(rt, text, from, { behind: holding, itemId, ...(threadId ? { threadId } : {}) });
  if (holding) {
    endHold(eng, rt);
    startNextInLine(eng, rt);
  }
}

/** Each question starts its own turn, using the task manager's normal inbox. */
function toManager(eng: Engine, rt: BotRuntime, tm: TaskManager, target: Target, text: string, from: UserItem["from"], lead: string): void {
  const itemId = randomUUID();
  const qid = newQuestionId();
  const prompt = `${lead}\n\n${text}`;
  eng.store.setValue(itemKey(itemId), JSON.stringify({ manager: tm.id, prompt }));
  writeQuestions(eng, target, (qs) => add(qs, { id: qid, at: now(), text, state: "queued", itemId }));
  eng.addItem(rt, { id: itemId, kind: "user", at: now(), text, from, queued: false }, tm.ownThread);
  st(eng).managers.push({ target, qid, botId: rt.folder.id, tmId: tm.id, itemId, active: false });
  void deliver(eng, rt, tm, prompt, "person", itemId, true).catch((err) => {
    log.error(`Bot ${rt.folder.id}: could not pass a question to a task manager`, err);
    const w = st(eng).managers.find((watch) => watch.itemId === itemId);
    if (w) endWatch(eng, w, "");
  });
}

function activate(eng: Engine, w: ManagerWatch): void {
  if (w.active || !st(eng).managers.includes(w)) return;
  w.active = true;
  writeQuestions(eng, w.target, (qs) => setState(qs, w.qid, "answering"));
}

function endWatch(eng: Engine, w: ManagerWatch, said: string): void {
  const s = st(eng);
  s.managers = s.managers.filter((m) => m !== w);
  eng.store.deleteValue(itemKey(w.itemId));
  writeQuestions(eng, w.target, (qs) => settle(qs, w.qid, said));
}

// ------------------------------------------------------------ hooks: the bot's turns

/** At a turn's start (turn-start.ts): a question takes up its turn. Returns the note the bot gets before it. */
export function questionTurnStarts(eng: Engine, rt: BotRuntime, item: UserItem, turnId: string): string | undefined {
  if (item.from.type !== "you" || !item.from.question) return undefined;
  // Kept until it is answered: a question steered in that the harness gave back starts again later.
  const raw = eng.store.getValue(itemKey(item.id));
  let kept: { target: Target; qid: string } | undefined;
  try {
    kept = raw ? (JSON.parse(raw) as { target: Target; qid: string }) : undefined;
  } catch {
    kept = undefined;
  }
  if (kept) {
    const s = st(eng);
    const list = (s.turns.get(rt.folder.id) ?? []).filter((w) => w.itemId !== item.id);
    list.push({ target: kept.target, qid: kept.qid, turnId, itemId: item.id });
    s.turns.set(rt.folder.id, list);
    writeQuestions(eng, kept.target, (qs) => setState(qs, kept!.qid, "answering"));
  }
  if (item.from.todo) {
    const row = eng.store.getTodo(item.from.todo.id);
    const open = row?.status === "open";
    return `Note from Pobots: the message below is the person's question about your to-do "${item.from.todo.title}" (${item.from.todo.id}), asked from its window in Pobots. ${
      open ? "The to-do is still open on their list and they have not acted on it yet, so this is not their answer." : "The to-do has left their list since."
    } ${FOLLOW_UP_RULE} Your reply in this turn is shown to them inside the to-do.`;
  }
  const title = item.from.card?.title ?? "";
  return `Note from Pobots: the message below is the person's question about the question you put on a card, "${title}". The card is still open and they have not answered it yet, so this is not their answer; their answer reaches you later. Answer plainly. Your reply in this turn is shown to them inside the card.`;
}

/** A question steered into a running turn that the harness did not take waits in line again (steering.ts). */
export function questionBackInLine(eng: Engine, rt: BotRuntime, itemId: string): void {
  const s = st(eng);
  const list = s.turns.get(rt.folder.id) ?? [];
  const w = list.find((x) => x.itemId === itemId);
  if (!w) return;
  s.turns.set(rt.folder.id, list.filter((x) => x !== w));
  writeQuestions(eng, w.target, (qs) => setState(qs, w.qid, "queued"));
}

/** The bot finished writing a message (harness-events.ts closeBotItem). */
export function botSaid(eng: Engine, rt: BotRuntime, itemId: string, text: string): void {
  if (!text.trim()) return;
  for (const p of st(eng).parks.values()) if (p.open && p.owner === `bot:${rt.folder.id}`) p.texts.set(itemId, text.trim());
}

/** At a turn's end (turn-end.ts): its questions get its last message as their answer, and a parked card is let go. */
export function questionTurnEnds(eng: Engine, rt: BotRuntime, turnId: string | undefined, lastText: string): void {
  const s = st(eng);
  const list = s.turns.get(rt.folder.id);
  if (list?.length) {
    const mine = list.filter((w) => w.turnId === turnId);
    const rest = list.filter((w) => w.turnId !== turnId);
    if (rest.length) s.turns.set(rt.folder.id, rest);
    else s.turns.delete(rt.folder.id);
    for (const w of mine) {
      // A steered question the harness gave back waits in line again: its own turn answers it.
      if (rt.queue.includes(w.itemId)) {
        writeQuestions(eng, w.target, (qs) => setState(qs, w.qid, "queued"));
        continue;
      }
      eng.store.deleteValue(itemKey(w.itemId));
      writeQuestions(eng, w.target, (qs) => settle(qs, w.qid, lastText));
    }
  }
  for (const p of [...s.parks.values()]) if (p.open && p.owner === `bot:${rt.folder.id}`) closePark(eng, p);
}

// ------------------------------------------------------------ hooks: task managers

/** A turn of the task manager begins (task-managers.ts beginTurn): what waited for it is being answered. */
export function managerTurnBegins(eng: Engine, tm: TaskManager, questionId: string): void {
  const w = st(eng).managers.find((watch) => watch.tmId === tm.id && watch.itemId === questionId);
  if (w) activate(eng, w);
}

/** The task manager said something (task-managers.ts said). */
export function managerSaid(eng: Engine, tm: TaskManager, text: string): void {
  if (!text.trim()) return;
  for (const p of st(eng).parks.values()) if (p.open && p.owner === `tm:${tm.id}`) p.texts.set(randomUUID(), text.trim());
}

/** Its turn is over (task-managers.ts turnOver): its last message answers what it took up. */
export function managerTurnOver(eng: Engine, tm: TaskManager): void {
  const s = st(eng);
  for (const w of [...s.managers]) if (w.tmId === tm.id && w.active) endWatch(eng, w, tm.lastText);
  for (const p of [...s.parks.values()]) if (p.open && p.owner === `tm:${tm.id}`) closePark(eng, p);
}

/** The task manager ended: what still waited for it has no answer coming. */
export function managerEnded(eng: Engine, tm: TaskManager): void {
  const s = st(eng);
  for (const w of [...s.managers]) if (w.tmId === tm.id) endWatch(eng, w, "");
  for (const p of [...s.parks.values()]) if (p.open && p.owner === `tm:${tm.id}`) closePark(eng, p);
}

// ------------------------------------------------------------ a parked card

function ownerOf(pending: PendingCard): string {
  return pending.manager ? `tm:${pending.manager}` : `bot:${pending.rt!.folder.id}`;
}

/** The card stays on the rail, waiting on no call: its answer is kept for the bot's next ask, or becomes a message. */
function park(eng: Engine, pending: PendingCard, qid: string): void {
  const s = st(eng);
  const card = pending.card as QuestionCard;
  const owner = ownerOf(pending);
  const p: Park = { cardId: card.id, botId: card.botId, owner, qid, texts: new Map(), open: true, card };
  const parked: PendingCard = {
    card,
    rt: pending.rt,
    restored: true,
    ...(pending.manager ? { manager: pending.manager } : {}),
    resolve: (d) => parkedAnswer(eng, p, d),
  };
  clearTimeout(pending.timer);
  eng.cards.set(card.id, parked);
  s.parks.set(card.id, p);
  // Engine 0.31.1: a parked card waits on no call; a bot at rest reads Waiting for it.
  if (pending.rt) restWaitChanged(eng, pending.rt);
}

function parkedAnswer(eng: Engine, p: Park, d: InternalDecision): void {
  if (d.type === "withdrawn") {
    // Pobots stops (the card comes back at the next start) or the bot was retired.
    if (p.open) {
      p.open = false;
      st(eng).parks.delete(p.cardId);
    }
    return;
  }
  if (p.open) {
    p.stash = d;
    return;
  }
  const rt = eng.bots.get(p.botId);
  if (rt) answered(eng, rt, p.card, d, "asked");
}

/** What the owner wrote since his question: what it finished, and what it still writes. */
function textsSince(eng: Engine, p: Park): string {
  const parts = new Map(p.texts);
  const rt = eng.bots.get(p.botId);
  if (rt && p.owner.startsWith("bot:")) {
    for (const id of rt.textItems.values()) {
      const item = eng.live.get(id);
      if (item?.kind === "bot" && item.text.trim()) parts.set(id, item.text.trim());
    }
  } else if (rt) {
    const tm = rt.managers.get(p.owner.slice(3));
    for (const [key, text] of tm?.texts ?? []) if (text.trim()) parts.set(key, text.trim());
  }
  return [...parts.values()].join("\n\n");
}

/** The turn that took his question ended without a new card: the card stays, and its answer becomes a message. */
function closePark(eng: Engine, p: Park): void {
  const said = textsSince(eng, p);
  p.open = false;
  st(eng).parks.delete(p.cardId);
  writeQuestions(eng, { kind: "card", id: p.cardId }, (qs) => settle(qs, p.qid, said));
  if (p.stash) {
    const rt = eng.bots.get(p.botId);
    if (rt) answered(eng, rt, p.card, p.stash, "asked");
  }
}

function feedbackFields(rt: BotRuntime, threadId: string) {
  const turnId = rt.busy && rt.turn?.threadId === threadId ? rt.turn.id : undefined;
  return { queued: false, steered: true, ...(turnId ? { turnId } : {}) };
}

/** The waiting call can take the oldest question on this card without starting a second turn. */
function takePendingFeedback(eng: Engine, rt: BotRuntime, card: QuestionCard, manager?: string): CardQuestion | undefined {
  const q = card.questions?.find((entry) => entry.state === "queued");
  if (!q?.itemId) return undefined;
  const item = eng.store.getItem(q.itemId);
  if (item?.kind !== "user") return undefined;
  if (manager) {
    const inbox = rt.managers.get(manager)?.inbox;
    const idx = inbox?.findIndex((entry) => typeof entry !== "string" && entry.questionId === q.itemId) ?? -1;
    if (idx < 0) return undefined;
    inbox!.splice(idx, 1);
    const state = st(eng);
    state.managers = state.managers.filter((w) => w.itemId !== q.itemId);
  } else {
    const idx = rt.queue.indexOf(q.itemId);
    if (idx < 0) return undefined;
    rt.queue.splice(idx, 1);
    if (rt.hold?.held.delete(q.itemId)) saveHold(eng, rt);
  }
  eng.store.deleteValue(itemKey(q.itemId));
  eng.putItem({ ...item, ...feedbackFields(rt, item.threadId) });
  return q;
}

/**
 * The bot (or task manager) asks again (cards.ts openCard, task-manager-host.ts openManagerCard): its
 * new question card takes the parked card's place. `decision` when he answered in between: the call
 * returns it at once and no card goes up. `replaced` when the new card took the old one's id and spot.
 */
export function takePlace(eng: Engine, rt: BotRuntime, card: QuestionCard, manager?: string): { decision?: InternalDecision; replaced?: boolean } {
  const s = st(eng);
  const owner = manager ? `tm:${manager}` : `bot:${rt.folder.id}`;
  const p = [...s.parks.values()].find((x) => x.open && x.owner === owner);
  if (!p) return {};
  const said = textsSince(eng, p);
  p.open = false;
  s.parks.delete(p.cardId);
  if (p.stash) {
    log.info(`Bot ${rt.folder.id}: the person answered a card before the bot asked again; the new ask gets that answer`);
    return { decision: carried(p.stash, p.card, card) };
  }
  const old = eng.cards.get(p.cardId);
  if (!old || old.card.kind !== "question") return {};
  clearTimeout(old.timer);
  eng.cards.delete(p.cardId);
  card.id = old.card.id;
  card.at = old.card.at;
  card.questions = settle(old.card.questions ?? [], p.qid, said);
  const next = takePendingFeedback(eng, rt, card, manager);
  if (!next) return { replaced: true };

  card.questions = setState(card.questions, next.id, "answering");
  park(eng, { card, rt, ...(manager ? { manager } : {}), resolve: () => {} }, next.id);
  eng.store.addCard(card);
  eng.opts.emit("card.changed", { card });
  return { decision: { type: "ask", text: next.text } };
}

/** His answer to the old card, for the new one: a choice goes by its label. */
function carried(d: InternalDecision, from: QuestionCard, to: QuestionCard): InternalDecision {
  if (d.type !== "choice") return d;
  const label = from.choices.find((c) => c.id === d.choiceId)?.label ?? d.choiceId;
  const same = to.choices.find((c) => c.label === label);
  return same ? { type: "choice", choiceId: same.id } : { type: "text", text: label };
}

// ------------------------------------------------------------ at start

/**
 * After a restart, queued questions keep waiting. An interrupted reply is left in the thread as
 * unanswered: replaying a turn that already started could repeat what the bot did in it.
 */
export function settleQuestionsAtStart(eng: Engine): void {
  const waiting = new Set([...eng.bots.values()].flatMap((rt) => rt.queue));
  const managerQueues = new Map<TaskManager, { at: string; message: ManagerMessage }[]>();
  const fix = (target: Target, qs: CardQuestion[] | undefined, rt: BotRuntime | undefined) => {
    if (!qs?.some((q) => q.state === "queued" || q.state === "answering")) return undefined;
    return qs.map((q) => {
      if (q.state !== "queued" && q.state !== "answering") return q;
      const raw = q.itemId && eng.store.getValue(itemKey(q.itemId));
      if (q.state === "queued" && q.itemId && raw) {
        if (waiting.has(q.itemId)) return q;
        try {
          const { manager, prompt } = JSON.parse(raw) as { manager?: string; prompt?: string };
          const tm = manager && rt?.managers.get(manager);
          if (tm && rt && typeof prompt === "string" && eng.store.getItem(q.itemId)) {
            const messages = managerQueues.get(tm) ?? [];
            messages.push({ at: q.at, message: { text: prompt, questionId: q.itemId } });
            managerQueues.set(tm, messages);
            st(eng).managers.push({ target, qid: q.id, botId: rt.folder.id, tmId: tm.id, itemId: q.itemId, active: false });
            return q;
          }
        } catch {
          // An unreadable queue record cannot be resumed, but the question stays visible.
        }
      }
      if (q.itemId) eng.store.deleteValue(itemKey(q.itemId));
      return { ...q, state: "unanswered" as const };
    });
  };
  for (const todo of eng.store.openTodos()) {
    if (away(eng.bots.get(todo.botId))) continue;
    const qs = fix({ kind: "todo", id: todo.id }, todo.questions, eng.bots.get(todo.botId));
    const row = qs && eng.store.getTodo(todo.id);
    if (row) eng.store.saveTodo({ ...row, todo: { ...row.todo, questions: qs } });
  }
  for (const p of eng.cards.values()) {
    if (p.card.kind !== "question") continue;
    const qs = fix({ kind: "card", id: p.card.id }, p.card.questions, p.rt);
    if (!qs) continue;
    p.card = { ...p.card, questions: qs };
    eng.store.addCard(p.card);
  }
  for (const [tm, messages] of managerQueues) {
    tm.inbox.push(...messages.sort((a, b) => a.at.localeCompare(b.at)).map((entry) => entry.message));
  }
}

/** Whether a to-do or card's question is still waiting (for tests). */
export function openQuestion(eng: Engine, t: Target): CardQuestion | undefined {
  return readQuestions(eng, t)?.find((q) => q.state === "queued" || q.state === "answering");
}
