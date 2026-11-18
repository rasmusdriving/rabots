// A task manager's workers (engine 0.26.0, docs/build/step-task-managers.md): start_helper helpers
// whose rows stand in the task manager's thread and whose results go to it, never to the bot. They
// live among the bot's helpers (rt.helpers, marked with `manager`) so the helper machinery runs
// them, but they never hold the bot and have a cap of their own: the task manager's max_workers.
import type { Engine } from "../engine.js";
import { type BotRuntime, callScope, type Helper, type HelperEnd } from "./runtime.js";
import type { HelperItem } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem, type StartHelperArgs } from "../team.js";
import type { ReadHelperArgs, SteerHelperArgs, StopHelperArgs } from "../helper-tools.js";
import { endHelper, sendHelperRow } from "./helpers.js";
import { helperEndResult, launchPobotsHelper, startHelperProblem, startPobotsRow } from "./start-helper.js";
import { helperHead, hideSecrets, readHelperView, shortHelperId } from "./helper-read.js";
import { steerHelperFor, stopHelperFor } from "./helper-control.js";
import { deliver, managerChanged, settleManager, type TaskManager } from "./task-managers.js";
import { log } from "../log.js";
import { randomUUID } from "node:crypto";

/** The task manager's workers that work now. */
export function workersOf(rt: BotRuntime, managerId: string): Helper[] {
  return [...rt.helpers.values()].filter((h) => h.manager === managerId && h.status === "running");
}

/** start_helper for a task manager: refused at its max_workers; else a worker row in its thread and the worker's own session. */
export async function startWorkerFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: StartHelperArgs, signal?: AbortSignal): Promise<ToolResult> {
  const working = workersOf(rt, tm.id).length;
  if (working >= tm.maxWorkers) {
    return problem(`You already have ${working} worker${working === 1 ? "" : "s"} working, the most at once for this task (${tm.maxWorkers}). Wait until one of them is done, then start the next.`);
  }
  // Its workers work in its folder unless the call names another.
  const input = { ...args, ...(args.folder?.trim() ? {} : tm.folder ? { folder: tm.folder } : {}) } as StartHelperArgs;
  const why = startHelperProblem(eng, rt, input as unknown as Record<string, unknown>, undefined, true);
  if (why) return problem(why.replace("You already have", "Your bot already has"));
  if (!tm.session || tm.session.closed) return problem("Your session is closing, so no worker was started.");
  const h = startPobotsRow(eng, rt, tm.session, `tm-${randomUUID()}`, input as unknown as Record<string, unknown>, { home: tm.ownThread, purpose: tm.purpose, manager: tm.id });
  const pobots = h.pobots!;
  pobots.linked = true;
  tm.workers.push(h.base.id);
  try {
    launchPobotsHelper(eng, rt, h, input);
  } catch (err) {
    log.error(`Bot ${rt.folder.id}: could not start a task manager's worker`, err);
    endHelper(eng, rt, h, "failed", "The worker could not start.");
    return problem("The worker could not start. The details are in the engine log.");
  }
  managerChanged(eng, rt, tm.id);
  const id = shortHelperId(h.base.id);
  if (!pobots.wait) return ok(`Started worker ${id} "${pobots.title}". You get its result in a new message when it is done. Meanwhile read_helper id ${id} shows its steps, steer_helper sends it more, stop_helper stops it.`);
  // A GPT task manager's call that takes long is answered early; the worker then goes on in the background.
  const call = callScope.getStore();
  if (call) {
    call.onDetach = () => {
      pobots.detached = true;
      if (!h.background) {
        h.background = true;
        sendHelperRow(eng, h, true);
      }
    };
  }
  const end = await new Promise<HelperEnd>((resolve) => {
    void pobots.done.then(resolve);
    signal?.addEventListener("abort", () => resolve({ status: "stopped", text: "" }), { once: true });
  });
  return helperEndResult(eng, pobots.title, end, id);
}

/** A worker ended (from endHelper): a result it did not wait for goes to its task manager, which may then settle. */
export function workerEnded(eng: Engine, rt: BotRuntime, h: Helper, end: HelperEnd): void {
  const tm = h.manager ? rt.managers.get(h.manager) : undefined;
  if (!tm || eng.stopping || !eng.bots.has(rt.folder.id)) return;
  const pobots = h.pobots!;
  managerChanged(eng, rt, tm.id);
  if (!pobots.wait && pobots.tell) {
    const text = helperEndResult(eng, pobots.title, end, shortHelperId(h.base.id)).content[0]!.text.replace(/^Your helper/, "Your worker");
    void deliver(eng, rt, tm, text, tm.origin).catch((err) => log.error(`Bot ${rt.folder.id}: could not pass a worker's result to its task manager`, err));
    return;
  }
  // Its turn may have ended while this worker worked: once the last one is done, it settles.
  // A call that was answered early tells the result itself (see managerLateCall).
  if (!tm.busy && !pobots.detached) settleManager(eng, rt, tm);
}

/** Its workers stop at once, without telling it (Stop, end, Pobots stopping). */
export function stopWorkers(eng: Engine, rt: BotRuntime, tm: TaskManager): void {
  for (const h of [...rt.helpers.values()]) {
    if (h.manager !== tm.id || h.status !== "running") continue;
    if (h.pobots) h.pobots.tell = false;
    endHelper(eng, rt, h, "stopped", undefined, false);
  }
}

/** One of its own workers by id (the short one or the whole), live or ended. */
function ownWorker(eng: Engine, rt: BotRuntime, tm: TaskManager, id: string): { item: HelperItem; live?: Helper } | string {
  const want = id.trim().toLowerCase();
  if (want.length < 6) return `Give the worker's whole id (8 characters), from start_helper or read_helper without an id.`;
  const itemId = tm.workers.find((w) => w.toLowerCase().startsWith(want));
  if (!itemId) return `There is no worker ${id.trim()} of yours. read_helper without an id lists them.`;
  const item = eng.store.getItem(itemId);
  if (!item || item.kind !== "helper") return `There is no worker ${id.trim()} of yours.`;
  const live = [...rt.helpers.values()].find((h) => h.base.id === itemId);
  return { item, ...(live ? { live } : {}) };
}

/** read_helper for a task manager: its own workers only. */
export function readWorkerFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: ReadHelperArgs): ToolResult {
  if (!args.id?.trim()) {
    const items = tm.workers
      .map((id) => eng.store.getItem(id))
      .filter((i): i is HelperItem => i?.kind === "helper")
      .reverse()
      .slice(0, 20);
    if (!items.length) return ok("You have no workers yet.");
    const working = workersOf(rt, tm.id).length;
    const lines = items.map((item) => `- ${helperHead(eng, item, [...rt.helpers.values()].find((h) => h.base.id === item.id))}`);
    return ok(hideSecrets(eng, `${working ? `${working} of your workers work now` : "None of your workers works now"} (at most ${tm.maxWorkers} at once). Newest first:\n${lines.join("\n")}`));
  }
  const found = ownWorker(eng, rt, tm, args.id);
  if (typeof found === "string") return problem(found);
  return ok(readHelperView(eng, rt, found.item, found.live, args));
}

/** steer_helper for a task manager: its own working workers only. */
export async function steerWorkerFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: SteerHelperArgs): Promise<ToolResult> {
  const found = ownWorker(eng, rt, tm, args.id ?? "");
  if (typeof found === "string") return problem(found);
  return steerHelperFor(eng, rt, { id: found.item.id, text: args.text });
}

/** stop_helper for a task manager: its own workers only. */
export async function stopWorkerFor(eng: Engine, rt: BotRuntime, tm: TaskManager, args: StopHelperArgs): Promise<ToolResult> {
  const found = ownWorker(eng, rt, tm, args.id ?? "");
  if (typeof found === "string") return problem(found);
  return stopHelperFor(eng, rt, { id: found.item.id });
}
