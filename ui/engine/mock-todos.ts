// Step 7c: the mock engine's to-dos for the person (docs/build/step-7c.md, part 2): what the engine
// keeps, "todo.answer" and "todo.close" as the engine does them, and a few to-dos to start from.
//
// ?todos= picks the starting point (any scene but first-run):
//   (absent)  none
//   1         three to-dos: one with every kind of block and a "by when", one kept open, a short one
//   many      twelve, for a long list
// Levers on window.pobotsTodos: add(partial) adds one as a bot would (returns its id), change(id, patch),
// remove(id) as the bot's remove_todo, list() the open ones, answers() what was answered.
import type { Artifact, Events, Methods, Todo, UserItem } from "../../shared/protocol";
import { sketch } from "./mock-files";
import { EngineError } from "./types";

type TodoMethod = "todo.answer" | "todo.close";

export interface MockTodosHost {
  emit(e: { event: "todo.changed"; data: Events["todo.changed"] } | { event: "todo.removed"; data: Events["todo.removed"] }): void;
  /** The person's answer goes to the bot as his message, marked from the to-do. */
  answer(botId: string, text: string, from: Extract<UserItem["from"], { type: "you" }>): void;
}

export interface TodoLevers {
  add(partial: Partial<Todo> & { title: string; botId: string }): string;
  change(id: string, patch: Partial<Todo>): void;
  remove(id: string): void;
  list(): Todo[];
  answers(): { todoId: string; buttonId?: string; values: Record<string, string> }[];
}

declare global {
  interface Window {
    pobotsTodos?: TodoLevers;
  }
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3600_000;
const D = 24 * H;
const dayAhead = (days: number) => {
  const d = new Date(Date.now() + days * D);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const PAGE: Artifact = {
  id: "onboarding-status",
  botId: "kaja",
  kind: "page",
  title: "Onboarding status",
  path: "artifacts/onboarding-status/index.html",
  rev: 1,
  available: true,
  createdAt: iso(3 * D),
  updatedAt: iso(3 * D),
};

export class MockTodos {
  private todos: Todo[] = [];
  private answered: { todoId: string; buttonId?: string; values: Record<string, string> }[] = [];
  private n = 1;

  constructor(
    private host: MockTodosHost,
    flag: string | null,
  ) {
    if (flag === "1") this.seed();
    if (flag === "many") this.seedMany();
    window.pobotsTodos = {
      add: (p) => {
        const todo = this.make(p);
        this.todos.push(todo);
        this.host.emit({ event: "todo.changed", data: { todo: structuredClone(todo) } });
        return todo.id;
      },
      change: (id, patch) => {
        const at = this.todos.findIndex((t) => t.id === id);
        if (at < 0) return;
        this.todos[at] = { ...this.todos[at]!, ...patch, updatedAt: new Date().toISOString() };
        this.host.emit({ event: "todo.changed", data: { todo: structuredClone(this.todos[at]!) } });
      },
      remove: (id) => this.drop(id, "removed"),
      list: () => structuredClone(this.todos),
      answers: () => structuredClone(this.answered),
    };
  }

  state(): Todo[] {
    return structuredClone(this.todos);
  }

  /** The bot of a retired bot's to-dos: they leave the list. */
  retired(botId: string): void {
    for (const t of this.todos.filter((x) => x.botId === botId)) this.drop(t.id, "retired");
  }

  /** The address of a file block: a drawn picture, or a small text for a file. */
  fileUrl(todoId: string, index: number): string | undefined {
    const b = this.todos.find((t) => t.id === todoId)?.blocks[index];
    if (!b || b.type !== "file") return undefined;
    return b.picture ? sketch(960, 540, 200, b.name) : `data:application/octet-stream;base64,${btoa(`A sample of ${b.name}.\n`)}`;
  }

  readonly handlers: { [M in TodoMethod]: (p: Methods[M]["params"]) => Methods[M]["result"] } = {
    "todo.answer": (p) => {
      const todo = this.todos.find((t) => t.id === p.todoId);
      if (!todo) throw new EngineError({ code: "not_found", message: "This to-do is no longer on your list." });
      const button = p.buttonId === undefined ? undefined : todo.buttons.find((b) => b.id === p.buttonId);
      if (p.buttonId !== undefined && !button) throw new EngineError({ code: "bad_request", message: "That button is not on this to-do any more. Open it again." });
      const values: Record<string, string> = {};
      const lines: string[] = [];
      if (button) lines.push(`Pressed "${button.label}".`);
      for (const b of todo.blocks) {
        if (b.type !== "field") continue;
        const v = (p.values?.[b.id] ?? "").trim();
        if (!v) continue;
        values[b.id] = v;
        lines.push(b.input === "long" || v.includes("\n") ? `${b.label}:\n${v}` : `${b.label}: ${v}`);
      }
      if (!button && !lines.length) throw new EngineError({ code: "bad_request", message: "Press a button or fill in a field first." });
      // A field whose name holds "fail" acts out an engine that refuses, so the window's error line can be seen.
      if (Object.values(values).some((v) => /^fail$/i.test(v))) throw new EngineError({ code: "bad_request", message: "The bot of this to-do is gone." });
      this.answered.push({ todoId: todo.id, ...(button ? { buttonId: button.id } : {}), values });
      const at = new Date().toISOString();
      if (todo.keepOpen) {
        Object.assign(todo, { updatedAt: at, answer: { at, ...(button ? { buttonId: button.id, label: button.label } : {}) } });
        this.host.emit({ event: "todo.changed", data: { todo: structuredClone(todo) } });
      } else this.drop(todo.id, "answered");
      this.host.answer(todo.botId, lines.join("\n"), { type: "you", todo: { id: todo.id, title: todo.title } });
      return {};
    },
    "todo.close": (p) => {
      if (!this.todos.some((t) => t.id === p.todoId)) throw new EngineError({ code: "not_found", message: "This to-do is no longer on your list." });
      this.drop(p.todoId, p.how);
      return {};
    },
  };

  private drop(id: string, reason: Events["todo.removed"]["reason"]): void {
    if (!this.todos.some((t) => t.id === id)) return;
    this.todos = this.todos.filter((t) => t.id !== id);
    this.host.emit({ event: "todo.removed", data: { todoId: id, reason } });
  }

  private make(p: Partial<Todo> & { title: string; botId: string }): Todo {
    const at = p.at ?? new Date().toISOString();
    const id = p.id ?? `todo_mock${String(this.n++).padStart(11, "0")}`;
    return { blocks: [], buttons: [], keepOpen: false, ...p, id, at, updatedAt: p.updatedAt ?? at };
  }

  private seed(): void {
    this.todos.push(
      this.make({
        id: "todo_mocknordvik00001",
        botId: "hubspot-tickets",
        title: "Send the Nordvik import summary",
        why: "The import is done and Nordvik waits for the summary.",
        at: iso(2 * D),
        due: dayAhead(2),
        blocks: [
          { type: "text", text: "The import **finished** at 09:12 with no errors. The customer asked for a short summary they can forward to their HR team." },
          { type: "facts", facts: [{ label: "Customer", value: "Nordvik AB" }, { label: "Rows imported", value: "4 210" }, { label: "Ticket", value: "#48211" }] },
          { type: "link", label: "The ticket in HubSpot", url: "https://example.com/tickets/48211" },
          { type: "copy", label: "Email draft", text: "Hej Anna,\n\nImporten av era medarbetare är klar: 4 210 personer finns nu i systemet.\n\nHör av er om något ser fel ut.\n\nVänliga hälsningar\nKaja" },
          { type: "file", path: "out/import-chart.png", name: "import-chart.png", picture: true, size: 182_000 },
          { type: "file", path: "out/import-report.pdf", name: "Import report.pdf", picture: false, size: 248_000 },
          { type: "page", artifact: PAGE },
          { type: "field", id: "note", label: "Anything to add for the customer?", input: "long", placeholder: "A line I should add" },
          { type: "field", id: "lang", label: "Language", input: "choice", choices: ["Swedish", "English"], value: "Swedish" },
        ],
        buttons: [
          { id: "sent", label: "I sent it", primary: true },
          { id: "change", label: "Change the draft" },
        ],
      }),
      this.make({
        id: "todo_mockweekly00002",
        botId: "kaja",
        title: "Look at this week's onboarding numbers",
        why: "Every Friday, before the team meeting.",
        at: iso(5 * H),
        keepOpen: true,
        answer: { at: iso(7 * D), buttonId: "looked", label: "Looked at them" },
        blocks: [{ type: "text", text: "Three onboardings started this week. One waits for the customer's file." }],
        buttons: [{ id: "looked", label: "Looked at them", primary: true }],
      }),
      this.make({
        id: "todo_mockdate0000003",
        botId: "inbox",
        title: "Pick a start date for Lindgren",
        at: iso(40 * 60_000),
        blocks: [{ type: "field", id: "date", label: "Start date", input: "short", placeholder: "For example 2 December" }],
        buttons: [{ id: "send", label: "Send", primary: true }],
      }),
    );
  }

  private seedMany(): void {
    const bots = ["kaja", "inbox", "hubspot-tickets"];
    for (let i = 0; i < 12; i++) {
      this.todos.push(this.make({ botId: bots[i % 3]!, title: `Follow up with customer number ${i + 1} about their survey dates`, at: iso((i + 1) * 3 * H), ...(i % 4 === 0 ? { due: dayAhead(i) } : {}) }));
    }
  }
}
