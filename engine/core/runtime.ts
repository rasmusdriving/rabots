// The engine's shared kinds of state: a bot's runtime, its turns, helpers, tasks, asks and cards;
// the one call scope; counts that read only a bot's runtime; words more than one part of the engine uses.
import type { HeldNotice, NotePart } from "./notes.js";
import type { BotState, Card, CardDecision, Effort, Harness, HelperItem, UserItem } from "../../shared/protocol.js";
import type { HarnessSession } from "../engine.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerChoice, WorkerKind } from "../workers.js";
import type { Shortener } from "../shorten.js";
import type { KeptPlan } from "../plan.js";
import type { BotFolder } from "../bots.js";
import type { TaskManager } from "./task-managers.js";
import { waitingWords } from "./words.js";

/**
 * Engine 0.31.0: "ask" is not an answer: the person asked about a question card while its call
 * waited (core/card-questions.ts). The call returns his question and the card stays.
 */
export type InternalDecision = CardDecision | { type: "withdrawn" } | { type: "expired" } | { type: "ask"; text: string };

export interface PendingCard {
  card: Card;
  /** The bot the card belongs to. None for a card from Pobots itself (kind "system"). */
  rt?: BotRuntime;
  /** The helper whose tool call raised the card (its tool use id). Such a card outlives the bot's turn. */
  helper?: string;
  /** The GPT bot's tool call that opened the card. Once that call was answered early, the card outlives the turn too. */
  call?: CallContext;
  /** Engine 0.26.0: the task manager whose card it is (its own, or a worker's): it never holds the bot (core/task-managers.ts). */
  manager?: string;
  /** Engine 0.29.0: a card kept over a restart (core/restored-cards.ts). It waits on no turn; its answer becomes a message. */
  restored?: boolean;
  resolve: (decision: InternalDecision) => void;
  timer?: NodeJS.Timeout;
}

export interface RunningTool {
  itemId: string;
  started: number;
  name: string;
  input: Record<string, unknown>;
  running: string;
  done: string;
  /** Set by a bot tool when it has more to show, such as the answer to an ask. */
  detail?: string;
  /** The finished line when the call failed, when `done` would say it worked. */
  failed?: string;
  /** A failed call's line shows why (the tool's answer) as its detail. */
  whyOnFail?: boolean;
  /** The call started a helper: its line is the helper row, not an activity item. */
  helper?: boolean;
}

/** One bot asking another and waiting for the answer. */
export interface PendingAsk {
  id: string;
  from: string;
  to: string;
  hops: number;
  /** The answer came, or there will be none. */
  settled: boolean;
  /** The asker stopped waiting. A later answer goes to it as a message. */
  late: boolean;
  resolve: (r: AskOutcome) => void;
  timer?: NodeJS.Timeout;
  /** The asker's Stop count when it asked: a late answer to an ask from before a Stop that holds waits with the held messages. */
  epoch: number;
  /** Engine 0.26.0: where a late answer goes when the asker is not a bot (a task manager). */
  onLate?: (answer: string) => void;
}

export type AskOutcome = { answer: string } | { problem: string } | { late: true };

export interface Turn {
  id: string;
  /** The thread the turn happens in: the bot's main thread, or the own thread of a fresh run. */
  threadId: string;
  /** True for a fresh run: its own thread and its own new harness session. */
  fresh: boolean;
  /** The trigger run this turn is, when a trigger started it. */
  runId?: string;
  /** How many bots a message passed through to start this turn. 0 when the person started it. */
  hops: number;
  startedBy: UserItem["from"]["type"];
  /** Set when this turn answers another bot's ask. */
  ask?: PendingAsk;
  /** The last thing the bot said in this turn. Sent back as the answer to an ask. */
  lastText: string;
  /** The first error shown in this turn, for the note of a trigger run that failed. */
  errorText?: string;
  /** The channel message this turn answers, by its row id. */
  channelRid?: string;
  /** A tidy turn: the bot writes down what matters before its session is replaced. */
  tidy: boolean;
  /** A turn the harness began by itself, when a helper reported back. No user item starts it. */
  harness?: boolean;
  /** The harness said this turn took up our message (its turn began). */
  begun?: boolean;
  /** A bot waits for what this turn is about: a harness turn tells it the last message. */
  askFrom?: string;
  /** The trigger's name, for a run. */
  runLabel?: string;
}

/** What a turn was for. A helper keeps the purpose of the turn that started it, and a turn the harness begins when it reports back carries it on. */
export interface Purpose {
  startedBy: Turn["startedBy"];
  threadId: string;
  fresh: boolean;
  hops: number;
  runId?: string;
  runLabel?: string;
  channelRid?: string;
  askFrom?: string;
}

/** One helper that is still working. Ended helpers live on only as their row and thread. */
export interface Helper {
  toolUseId: string;
  taskId?: string;
  /** The helper item as first made: id, thread, seq, title, its own thread. */
  base: HelperItem;
  status: HelperItem["status"];
  background: boolean;
  steps: number;
  last?: string;
  endedAt?: string;
  /** What it said last, whole. */
  lastText: string;
  /** The helper that started this one, by tool use id. */
  parent?: string;
  purpose: Purpose;
  session: HarnessSession;
  /** Its own tool calls that are running. */
  tools: Map<string, RunningTool>;
  sentAt: number;
  rowTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  stopAsked: boolean;
  /** A helper started with the bot tool start_helper, on any model: its own session (step 3a). */
  pobots?: PobotsHelper;
  /**
   * It stopped to wait for work of its own in the background (step 3b): the harness said
   * "completed", but its commands still run and it comes back when they end. It stays running.
   */
  paused?: boolean;
  /**
   * A row made for a helper from before that was given more to do (step 3b): its messages name a
   * call this engine never saw, which is taken as its own when it is the only such row.
   */
  orphan?: boolean;
  /** When the harness's list stopped showing it and anything of its own (see checkLive). */
  missingSince?: number;
  /** The bot's Stop count when it started (see BotRuntime.epoch): older than the last Stop is work from before it. */
  epoch: number;
  /** Engine 0.26.0: the id of the task manager this worker works for. Such a worker never holds or wakes the bot (core/task-manager-workers.ts). */
  manager?: string;
}

/** One task of the harness that runs now: a helper, a command of a helper, the bot's own command (step 3b). */
export interface LiveTask {
  type?: string;
  /** The helper's task that started it. */
  parent?: string;
  quiet: boolean;
  /** In the background; a task the caller waits for is not. */
  background: boolean;
  /** What the bot was doing when it started, for the turn the harness begins when it ends. */
  purpose?: Purpose;
  /** The bot's Stop count when it started (see BotRuntime.epoch). A task started by a helper takes the helper's. */
  epoch: number;
  /** The session it runs in: the live one or one set aside (core/aside.ts). */
  session?: HarnessSession;
}

/**
 * A session set aside (engine 0.24.1, core/aside.ts): one whose helpers or commands still worked when
 * a turn for another thread needed a session. It keeps running beside the live one until nothing of
 * it runs and nothing waits for it.
 */
export interface AsideSession {
  session: HarnessSession;
  threadId: string;
  harness?: Harness;
  tools?: string;
  /** What its work was for: the purpose of its last turn, then of the helper that ended last there. */
  purpose?: Purpose;
  /** A trigger run of its thread whose turn ended while its helpers worked. */
  pendingRun?: BotRuntime["pendingRun"];
  /** A turn the harness began by itself there while the bot was busy is being ended at its start. */
  swallowing: boolean;
  /** Its result waits for the bot in a turn of its own (a wake). */
  waiting: boolean;
  /** Settings changed since it was set aside: it is started again after its next turn. */
  stale: boolean;
  calmTimer?: NodeJS.Timeout;
}

/**
 * One call to a bot tool of a GPT bot, while it runs. `detached` once it was answered early ("you get
 * the result in a new message"): cards it opened then outlive the turn (step 3a).
 */
export interface CallContext {
  detached: boolean;
  onDetach?: () => void;
}

export const callScope = new AsyncLocalStorage<CallContext>();

/** How a helper started with start_helper ended, and what it handed back. */
export type HelperEnd = { status: "done" | "failed" | "stopped"; text: string };

export interface PobotsHelper {
  harness: Harness;
  session?: HarnessSession;
  /** The bot's session whose call started it: it counts as that session's work, so its result goes back there (core/aside.ts). */
  from?: HarnessSession;
  /** Resolves once, when the helper has ended. */
  done: Promise<HelperEnd>;
  finish: (end: HelperEnd) => void;
  /** The bot's call returned before the helper ended (wait false, or a GPT bot's call that took too long): its result comes to the bot as a new turn. */
  detached: boolean;
  /** Text of the message the helper is writing, by key (a helper's text is drawn whole). */
  texts: Map<string, string>;
  /** False when the bot is not to be woken when it ends: Stop on the bot, a restart. */
  tell: boolean;
  /** The bot waits for the result in its call (wait true); else it is told in a new turn. */
  wait: boolean;
  /** What the call asked for, to match the call's handler with the row its tool-start made. */
  title: string;
  task: string;
  /** The handler of the call has taken this row. */
  linked: boolean;
  /** Why it failed, in plain words, for the bot. */
  why?: string;
  /** Step workers: what the call, its kind and the defaults chose. */
  choice: WorkerChoice;
  kind?: WorkerKind;
  /** Step workers: a Claude helper's shortening on request. */
  shortener?: Shortener;
  /** Step workers: the size of its last request, from its last turn. */
  size?: number;
}

/** What a helper row is made from: the harness's helper tool, or start_helper. */
export interface HelperStart {
  title: string;
  prompt: string;
  background: boolean;
  model?: string;
  effort?: Effort;
  /** start_helper on a model with a fast mode, not switched off (step 3b). */
  fast?: boolean;
  /** Engine 0.26.0: a task manager's worker: the thread its row stands in, what it works for, and the manager's id. */
  home?: string;
  purpose?: Purpose;
  manager?: string;
}

/** A result for a bot that has to wait for a turn of its own: a helper's, or a slow tool call's on a GPT bot. */
export interface Wake {
  text: string;
  purpose: Purpose;
  /** The set-aside session whose result this is (core/aside.ts). */
  aside?: HarnessSession;
}

export interface BotRuntime {
  /** The bot's own to-do list (step 7a), kept in the database as "plan:<botId>". Read lazily. */
  plan?: KeptPlan | null;
  folder: BotFolder;
  threadId: string;
  state: BotState;
  activity: string;
  session?: HarnessSession;
  /** The thread the live harness session belongs to. */
  sessionThread?: string;
  /** A turn is in progress: a message was handed to the harness and its result has not come. */
  busy: boolean;
  /** Queued user item ids, oldest first. */
  queue: string[];
  current?: UserItem;
  turn?: Turn;
  interruptRequested: boolean;
  interruptTimer?: NodeJS.Timeout;
  /** Open bot items of this turn, by assistant message id. */
  textItems: Map<string, string>;
  streamedKeys: Set<string>;
  tools: Map<string, RunningTool>;
  /** A resume was tried for the current turn's session and has not been confirmed yet. */
  resumedFrom?: string;
  retriedFresh: boolean;
  turnError?: string;
  restartAfterTurn: boolean;
  /** The job changed since the last turn; the next turn starts with a short note about it. */
  jobChanged: boolean;
  doneTimer?: NodeJS.Timeout;
  sleepTimer?: NodeJS.Timeout;
  /** The live session was started new (not resumed) for the main thread. */
  newMainSession: boolean;
  /** The fresh session was handed the saved note; it is not pending once the session is there. */
  noteHanded: boolean;
  /** The state and activity before a tidy turn, to go back to after it. */
  beforeTidy?: { state: BotState; activity: string };
  /** Helpers that are working, by the tool use id that started them. */
  helpers: Map<string, Helper>;
  /** Engine 0.26.0: the bot's task managers that have not been ended, by their row's id (core/task-managers.ts). */
  managers: Map<string, TaskManager>;
  /** The start of its helpers' tool results, by activity item id, while Pobots runs (read_helper, 15 Nov 2026). */
  helperResults?: Map<string, string>;
  /** The purpose of the last turn that started (for helpers started outside a turn). */
  lastPurpose?: Purpose;
  /** The purpose of the helper that ended last: a harness turn that follows carries it on. */
  wakePurpose?: Purpose;
  /** How the bot reads once its last helper has ended, set when a turn ended while helpers worked. */
  afterHelpers?: { state: BotState; activity: string };
  /** A turn that ended while helpers worked: who started it, for the "finished" notification once they are done. */
  restNotice?: { startedBy: Turn["startedBy"] };
  settleTimer?: NodeJS.Timeout;
  liveTimer?: NodeJS.Timeout;
  /** A trigger run whose turn ended while its helpers worked: it ends when they and what follows have ended. */
  pendingRun?: { runId: string; threadId: string; fresh: boolean; label?: string; lastText: string };
  /** The session is to be closed once no helper works and no turn runs. */
  closeWhenCalm: boolean;
  /** The harness of the live session. */
  sessionHarness?: Harness;
  /** Codex: the fingerprint of the live session's tool list, kept with its thread id. */
  sessionTools?: string;
  /** The live session was handed the handoff of a change between harnesses. */
  switchHanded?: boolean;
  /** A GPT bot's slow tool calls that were answered early: aborted when the bot is stopped. */
  lateCalls: Set<AbortController>;
  /** Results that wait for a turn of their own, oldest first (see Wake). */
  wakes: Wake[];
  /** This bot's changes inside Pobots in this turn, gathered into one quiet line per bot (or channel, or Pobots) in its chat at its end (core/notes.ts). */
  notes?: Map<string, { title: string; lines: NotePart[] }>;
  /** Whole lines that wait for the turn's end as the notes do: a post the bot wrote in a channel (engine 0.23.0, core/notes.ts). */
  heldNotices?: HeldNotice[];
  /** The tasks that run now in the live session and the ones set aside, by task id, from the harness's own word (step 3b). */
  tasks: Map<string, LiveTask>;
  /** Sessions set aside while their helpers work, beside the live one (engine 0.24.1, core/aside.ts). */
  aside: AsideSession[];
  /** The live session's run settles while sessions set aside still work (core/aside.ts). */
  liveCalmTimer?: NodeJS.Timeout;
  /** How many of the bot's own commands ran in the background when last logged. For the log only: decisions look at `tasks`. */
  ownBackground: number;
  /** Helpers of this engine's life that ended, by task id: one given more to do gets its row back (step 3b). */
  endedHelpers: Map<string, Helper>;
  /** A helper's messages that name another call than the key of its row: that call, to the key. */
  helperAlias: Map<string, string>;
  /**
   * The person pressed Stop and has not written to the bot since (step 3b, third part). `held` are
   * the messages that were waiting at the Stop: they stay queued, in their place, until the hold
   * ends. Kept in the database (see saveHold), so a restart does not end it.
   */
  hold?: {
    at: string;
    held: Set<string>;
    /**
     * Work from before the Stop that may still report back: the task ids of what was live at the Stop
     * (helpers, their commands, the bot's own commands, also one let go after the grace) and of what
     * such work started since, until each has ended. In memory only: nothing survives a restart.
     */
    old: Set<string>;
    /** Old work the engine let go after the grace: it may have left its own list of live tasks, so the harness's list decides. */
    letGo: Set<string>;
  };
  /**
   * How many times Stop began a hold on this bot in this engine's life. Work in the background (a
   * task, a helper, an ask) keeps the count from when it started; while a hold is on, work with a
   * smaller count is from before the last Stop and starts no turn.
   */
  epoch: number;
  /**
   * While a hold is on: what reported back since the last turn began, from before the Stop (`old`)
   * and from after it (`fresh`), for the turn the harness may begin next (see beginHarnessTurn).
   */
  wake?: { old: boolean; fresh: boolean };
  /** A turn the harness began by itself while a Stop holds, being ended at once: nothing of it reaches the chat. */
  swallow?: HarnessSession;
  /**
   * Steering: messages steered into the turn that just ended before it took them up. The harness runs
   * them next by itself, so the next turn is theirs and nothing is sent for it (see afterTurn).
   */
  ahead?: string[];
}

/** The purpose of a turn, for helpers it starts and the harness turns that follow them. */
export function purposeOf(turn: Turn): Purpose {
  return {
    startedBy: turn.startedBy,
    threadId: turn.threadId,
    fresh: turn.fresh,
    hops: turn.hops,
    ...(turn.runId ? { runId: turn.runId } : {}),
    ...(turn.runLabel ? { runLabel: turn.runLabel } : {}),
    ...(turn.channelRid ? { channelRid: turn.channelRid } : {}),
    ...(turn.askFrom ? { askFrom: turn.askFrom } : {}),
  };
}

/** The harness a bot needs is not there; the message is its plain sentence for the person. */
export class HarnessUnavailable extends Error {}

/** What the roster says while a bot writes down what matters. */
export const TIDY_ACTIVITY = "Writing down what matters";

/** The answer to a tool call in a turn the harness began by itself while a Stop holds (step 3b, third part). */
export const STOP_REFUSAL = "Not now: the person pressed Stop. Do nothing more and end your turn.";

/** The answer to a tool call a tidy turn may not make. */
export const TIDY_REFUSAL = "Not now: this is a tidy turn, where you only read and write in your memory folder. Nothing else is done. Finish your note instead.";

/** The window assumed when the harness reports none. */
export const DEFAULT_WINDOW = 200_000;

export function newRuntime(folder: BotFolder, threadId: string): BotRuntime {
  return {
    folder,
    threadId,
    state: "idle",
    activity: "",
    busy: false,
    queue: [],
    interruptRequested: false,
    textItems: new Map(),
    streamedKeys: new Set(),
    tools: new Map(),
    retriedFresh: false,
    restartAfterTurn: false,
    jobChanged: false,
    newMainSession: false,
    noteHanded: false,
    helpers: new Map(),
    managers: new Map(),
    closeWhenCalm: false,
    wakes: [],
    lateCalls: new Set(),
    tasks: new Map(),
    aside: [],
    ownBackground: 0,
    endedHelpers: new Map(),
    helperAlias: new Map(),
    epoch: 0,
  };
}

/** The tasks a helper started that still run (its commands in the background, helpers of its own). */
export function helperWork(rt: BotRuntime, h: Helper): string[] {
  if (!h.taskId) return [];
  return [...rt.tasks].filter(([, t]) => t.parent === h.taskId && !t.quiet).map(([id]) => id);
}

/** The bot's own commands that run in the background now: not helpers, not a helper's, not quiet (step 3b). */
export function ownBackgroundTasks(rt: BotRuntime): string[] {
  const helperTasks = new Set([...rt.helpers.values()].map((h) => h.taskId).filter(Boolean));
  return [...rt.tasks].filter(([, t]) => t.background && !t.quiet && !!t.type && t.type !== "local_agent" && !(t.parent && helperTasks.has(t.parent))).map(([id]) => id);
}

/**
 * Helpers the harness lists as running that have no running row: one whose start was missed, or a
 * stopped one that came back under its first call. They count like any helper (review of step 3b).
 * A row that has not learnt its task id yet (the list comes just before the task's start) takes up one.
 */
export function unmatchedHelperTasks(rt: BotRuntime): string[] {
  const rows = [...rt.helpers.values()];
  const known = new Set(rows.map((h) => h.taskId).filter(Boolean));
  const listed = [...rt.tasks].filter(([id, t]) => t.background && !t.quiet && t.type === "local_agent" && !known.has(id)).map(([id]) => id);
  const waiting = rows.filter((h) => !h.taskId && !h.pobots).length;
  return listed.slice(Math.min(waiting, listed.length));
}

/** Helpers working now: the rows that run, and helpers the harness lists that have none. */
export function helperCount(rt: BotRuntime): number {
  // A task manager's workers never hold the bot (engine 0.26.0).
  let n = 0;
  for (const h of rt.helpers.values()) if (!h.manager) n++;
  return n + unmatchedHelperTasks(rt).length;
}

/** Everything the bot started that still runs in the background: its helpers and its own commands. */
export function inBackground(rt: BotRuntime): number {
  return helperCount(rt) + ownBackgroundTasks(rt).length;
}

/** What the bot waits for, in the roster's words. */
export function waitWords(rt: BotRuntime): string {
  const n = helperCount(rt);
  return n ? waitingWords(n) : "Working in the background";
}

/** What the person reads when a bot changes between the two kinds of model. */
export const SWITCH_WORDS: Record<Harness, string> = { claude: "Claude", codex: "ChatGPT" };

/** What the bot is told in a tidy turn. */
export const TIDY_PROMPT = [
  "Note from Pobots, not from the person. You have been working in this session for a while. Your next message will start in a fresh session, so that you stay quick and clear. The chat the person sees stays as it is, and you can search it later with search_chat.",
  "",
  "Do two things now.",
  "",
  "1. Save to your memory folder what you will need later and what is not there yet: facts, decisions, the person's preferences, where things are. Keep the index short.",
  "2. Then answer with a note for yourself of at most 300 words: what you were working on, open tasks and promises with their dates, what you are waiting for and from whom, and what the person said lately that still matters. Write it as plain text. If nothing is open, say so in one line.",
  "",
  "Use nothing but reading and writing in your memory folder. Do not message anyone and do not start other work.",
].join("\n");
