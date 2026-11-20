import { downloadFileName } from "../../shared/downloads.js";
import { asDownload } from "../downloads.js";
// To-dos for the person (step 7c): the bots' to-do tools, answers and closing from the page, and a to-do's files.
import { requirePresent } from "./vacation.js";
import type { Engine } from "../engine.js";
import type { BotRuntime } from "./runtime.js";
import { ANSWER_MAX, answerText, changedTodo, closedNews, todoFileInFolder, isTodoId, listWords, newTodo, notOpenWords, pictureType, type TodoArgs, type TodoContext } from "../todos.js";
import { checkShowPath } from "../artifacts.js";
import { pageArtifact, toArtifact } from "./artifacts.js";
import type { ToolResult } from "../claude/session.js";
import { ok, problem } from "../team.js";
import { type Methods, type Todo, TODOS_PER_BOT } from "../../shared/protocol.js";
import { now } from "./words.js";
import { log } from "../log.js";
import { whenWords } from "../schedule.js";
import { EngineError } from "../errors.js";
import type { ServedFile } from "../attachments.js";
import { endHold, startNextInLine } from "./stop.js";
import { answerToManager } from "./task-manager-host.js";
import { changedBlock, closeBlockOf, newBlock } from "./todo-blocks.js";

/** What a to-do's file and page blocks are checked against: the bot's folder, and its artifacts (made when new, without a line in the chat). */
export function todoContext(eng: Engine, rt: BotRuntime): TodoContext {
  return {
    botDir: rt.folder.dir,
    page: (path) => {
      const check = checkShowPath(rt.folder.dir, path);
      if (!check.ok) return check.why;
      const { row, made } = pageArtifact(eng, rt, check.rel, check.full);
      const artifact = toArtifact(row);
      if (made) eng.opts.emit("artifact.changed", { botId: rt.folder.id, artifact });
      return artifact;
    },
  };
}

/** add_todo: puts a to-do on the person's list. */
export async function addTodoFor(eng: Engine, rt: BotRuntime, args: TodoArgs): Promise<ToolResult> {
  if (!eng.store.isOpen) return problem("Pobots is stopping, so the to-do was not added.");
  if (eng.store.openTodos(rt.folder.id).length >= TODOS_PER_BOT) {
    return problem(`You already have ${TODOS_PER_BOT} open to-dos on the person's list. Remove or update one with remove_todo or update_todo first.`);
  }
  let todo: Todo;
  try {
    todo = newTodo(rt.folder.id, args, todoContext(eng, rt), now());
  } catch (err) {
    return problem(err instanceof Error ? err.message : String(err));
  }
  eng.store.saveTodo({ todo, status: "open" });
  eng.opts.emit("todo.changed", { todo });
  log.info(`Bot ${rt.folder.id}: added a to-do for the person`);
  const block = await newBlock(eng, rt, todo);
  return ok(
    `Added "${todo.title}" to the person's to-do list (id ${todo.id}). It waits there without a notification; when they act on it you get their answer in your chat as a message from them.${todo.keepOpen ? " It stays on the list after an answer, as you asked: update or remove it when it is settled." : " An answer takes it off the list."}${block}`,
  );
}

/** update_todo: changes one of the bot's open to-dos. */
export async function updateTodoFor(eng: Engine, rt: BotRuntime, args: TodoArgs & { id?: string }): Promise<ToolResult> {
  const row = typeof args.id === "string" ? eng.store.getTodo(args.id.trim()) : undefined;
  if (!row || row.todo.botId !== rt.folder.id) return problem("You have no to-do with that id. list_todos shows your open ones.");
  if (row.status !== "open") return problem(notOpenWords(row));
  let todo: Todo;
  try {
    todo = changedTodo(row.todo, args, todoContext(eng, rt), now());
  } catch (err) {
    return problem(err instanceof Error ? err.message : String(err));
  }
  eng.store.saveTodo({ todo, status: "open" });
  eng.opts.emit("todo.changed", { todo });
  const block = await changedBlock(eng, rt, row.todo, todo, args);
  return ok(`Changed the to-do "${todo.title}" (${todo.id}).${block}`);
}

/** remove_todo: takes one of the bot's to-dos off the person's list. */
export function removeTodoFor(eng: Engine, rt: BotRuntime, args: { id?: string }): ToolResult {
  const row = typeof args.id === "string" ? eng.store.getTodo(args.id.trim()) : undefined;
  if (!row || row.todo.botId !== rt.folder.id) return problem("You have no to-do with that id. list_todos shows your open ones.");
  if (row.status !== "open") return ok(`${notOpenWords(row)} Nothing to remove.`);
  eng.store.saveTodo({ ...row, status: "removed", closedAt: now() });
  eng.opts.emit("todo.removed", { todoId: row.todo.id, reason: "removed" });
  closeBlockOf(eng, row.todo.id, "dropped", "bot");
  return ok(`Took "${row.todo.title}" off the person's list.`);
}

/** list_todos: the bot's own open to-dos. */
export function listTodosFor(eng: Engine, rt: BotRuntime): ToolResult {
  const ago = (at: string) => whenWords(Date.parse(at), eng.clock(), eng.tz);
  return ok(listWords(eng.store.openTodos(rt.folder.id), ago));
}

/**
 * "todo.answer": the person pressed a button of a to-do and/or filled its fields. The bot gets it
 * as his message in its main chat (waiting in line while it works, as a message that is not urgent);
 * the to-do is then off the list unless the bot keeps it open.
 */
export function answerTodo(eng: Engine, params: Methods["todo.answer"]["params"]): void {
  const row = eng.store.getTodo(params.todoId);
  if (!row || row.status !== "open") throw new EngineError("not_found", "This to-do is no longer on your list.");
  const rt = eng.bots.get(row.todo.botId);
  if (!rt) throw new EngineError("not_found", "The bot of this to-do is gone.");
  requirePresent(rt);
  const todo = row.todo;
  const button = params.buttonId === undefined ? undefined : todo.buttons.find((b) => b.id === params.buttonId);
  if (params.buttonId !== undefined && !button) throw new EngineError("bad_request", "That button is not on this to-do any more. Open it again.");
  const values: Record<string, string> = {};
  for (const b of todo.blocks) {
    if (b.type !== "field") continue;
    const v = params.values?.[b.id];
    if (typeof v !== "string" || !v.trim()) continue;
    if (v.length > ANSWER_MAX) throw new EngineError("bad_request", `${b.label} is too long. Keep it under ${ANSWER_MAX.toLocaleString("en")} characters.`);
    if (b.input === "choice" && !b.choices?.includes(v)) throw new EngineError("bad_request", `Choose one of the choices for ${b.label}.`);
    values[b.id] = v;
  }
  if (!button && !Object.keys(values).length) throw new EngineError("bad_request", "Press a button or fill in a field first.");
  eng.checkReady(rt);
  const at = now();
  // Its state first, so the bot's turn reads whether it stays open.
  if (todo.keepOpen) {
    const kept: Todo = { ...todo, updatedAt: at, answer: { at, ...(button ? { buttonId: button.id, label: button.label } : {}) } };
    eng.store.saveTodo({ todo: kept, status: "open" });
    eng.opts.emit("todo.changed", { todo: kept });
  } else {
    eng.store.saveTodo({ todo, status: "answered", closedAt: at });
    eng.opts.emit("todo.removed", { todoId: todo.id, reason: "answered" });
  }
  // The person acted on it: its block of time is done, also when the bot keeps the to-do open.
  closeBlockOf(eng, todo.id, "done", "you");
  const text = answerText(todo, button?.id, values);
  // A task manager's to-do: its answer goes to the task manager while it is there (engine 0.26.0).
  if (answerToManager(eng, rt, todo, text)) {
    log.info(`Bot ${rt.folder.id}: the person answered a task manager's to-do`);
    return;
  }
  // Like the person's own message, but it never steers into a running turn: it is not urgent.
  const holding = !!rt.hold;
  eng.enqueue(rt, text, { type: "you", todo: { id: todo.id, title: todo.title } }, { behind: holding });
  if (holding) {
    endHold(eng, rt);
    startNextInLine(eng, rt);
  }
  log.info(`Bot ${rt.folder.id}: the person answered a to-do`);
}

/** "todo.close": the person marks a to-do done or dismisses it. The bot hears of it at its next turn. */
export function closeTodo(eng: Engine, params: Methods["todo.close"]["params"]): void {
  const row = eng.store.getTodo(params.todoId);
  if (!row || row.status !== "open") throw new EngineError("not_found", "This to-do is no longer on your list.");
  const owner = eng.bots.get(row.todo.botId);
  if (owner) requirePresent(owner);
  eng.store.saveTodo({ ...row, status: params.how, closedAt: now() });
  eng.opts.emit("todo.removed", { todoId: row.todo.id, reason: params.how });
  closeBlockOf(eng, row.todo.id, params.how === "done" ? "done" : "dropped", "you");
  const rt = eng.bots.get(row.todo.botId);
  if (rt) eng.store.addNews(rt.folder.id, rt.threadId, closedNews(row.todo, params.how));
}

/**
 * GET /api/todos/<todoId>/files/<n>: the file of block n of an open to-do, from inside its bot's
 * folder only (looked at again on every request). A checked picture is shown inline, anything else
 * is a download.
 */
export function todoFile(eng: Engine, todoId: string, index: number): ServedFile | undefined {
  if (!isTodoId(todoId)) return undefined;
  const row = eng.store.getTodo(todoId);
  const block = row?.status === "open" ? row.todo.blocks[index] : undefined;
  const rt = row ? eng.bots.get(row.todo.botId) : undefined;
  if (!block || block.type !== "file" || !rt) return undefined;
  const f = todoFileInFolder(rt.folder.dir, block.path);
  if (typeof f === "string") return undefined;
  const name = downloadFileName(f.rel);
  const type = block.picture ? pictureType(f.full) : undefined;
  return type ? { full: f.full, type, size: f.size, name, inline: true } : asDownload(f, name);
}
