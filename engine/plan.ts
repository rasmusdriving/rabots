// A bot's own to-do list (step 7a): the plan its harness keeps, read from the harness's own tools.
// Claude: the task tools (TaskCreate, TaskUpdate, TaskList), switched on with
// CLAUDE_CODE_ENABLE_TODO_TOOLS, or the older TodoWrite. Codex: turn/plan/updated (the session sends
// a "plan" event). Follows T3 Code's ClaudeAdapterV2.ts (claudeTodoSteps, applyClaudeTaskTool; MIT).
import type { BotPlan, PlanStep } from "../shared/protocol.js";

/** A plan with the harness's own key for each step (Claude's task ids), in the order they were made. */
export interface KeptPlan {
  plan: BotPlan;
  /** keys[i] is the harness's id of plan.steps[i]; "" where it has none (TodoWrite, Codex). */
  keys: string[];
}

type Loose = Record<string, unknown>;
const field = (v: unknown, key: string): unknown => (v && typeof v === "object" ? (v as Loose)[key] : undefined);
const text = (v: unknown, key: string): string | undefined => {
  const f = field(v, key);
  return typeof f === "string" && f.trim() ? f.trim() : undefined;
};

/** Claude's words for a status as ours; undefined for anything else (deleted is handled apart). */
function claudeStatus(v: unknown): PlanStep["status"] | undefined {
  return v === "completed" ? "completed" : v === "in_progress" ? "inProgress" : v === "pending" ? "pending" : undefined;
}

/** TodoWrite's input: the whole list. Empty todos are left out. */
export function todoWriteSteps(input: unknown): PlanStep[] | undefined {
  const todos = field(input, "todos");
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((t) => {
    const content = text(t, "content");
    return content ? [{ text: content, status: claudeStatus(field(t, "status")) ?? "pending" }] : [];
  });
}

/** "Task #3 created successfully: Run the tests": what TaskCreate answers when it gives no structure. */
function createdFromText(result: string | undefined): { id: string; subject: string } | undefined {
  const m = result ? /Task #(\S+) created successfully: (.+)$/s.exec(result.trim()) : null;
  return m ? { id: m[1]!, subject: m[2]!.trim() } : undefined;
}

/**
 * The list after one of Claude's task tools came back, or undefined when it does not change. `result`
 * is the structured result when the harness gave one, `resultText` its text. `fresh` starts a new
 * list for a TaskCreate when every step of the old one is done and it came from an earlier turn.
 */
export function applyTaskTool(kept: KeptPlan | undefined, name: string, input: unknown, result: unknown, resultText: string | undefined, fresh: boolean): KeptPlan | undefined {
  const steps = kept?.plan.steps ?? [];
  const keys = kept?.keys ?? [];
  if (name === "TaskList") {
    const listed = field(result, "tasks");
    if (!Array.isArray(listed)) return undefined;
    const next: { key: string; step: PlanStep }[] = [];
    for (const t of listed) {
      const id = text(t, "id");
      const subject = text(t, "subject");
      const status = claudeStatus(field(t, "status"));
      if (id && subject && status) next.push({ key: id, step: { text: subject, status } });
    }
    if (!next.length && !steps.length) return undefined;
    return { plan: { steps: next.map((n) => n.step), updatedAt: "" }, keys: next.map((n) => n.key) };
  }
  if (name === "TaskCreate") {
    const task = field(result, "task");
    const fromText = createdFromText(resultText ?? (typeof result === "string" ? result : undefined));
    const id = text(task, "id") ?? fromText?.id;
    const subject = text(task, "subject") ?? fromText?.subject ?? text(input, "subject");
    if (!id || !subject) return undefined;
    const base = fresh ? { steps: [] as PlanStep[], keys: [] as string[] } : { steps, keys };
    const at = base.keys.indexOf(id);
    if (at >= 0) return { plan: { steps: base.steps.map((s, i) => (i === at ? { text: subject, status: s.status } : s)), updatedAt: "" }, keys: base.keys };
    return { plan: { steps: [...base.steps, { text: subject, status: "pending" }], updatedAt: "" }, keys: [...base.keys, id] };
  }
  if (name === "TaskUpdate") {
    if (field(result, "success") === false) return undefined;
    if (resultText && /error|not found|failed/i.test(resultText) && !/^Updated task/i.test(resultText.trim())) return undefined;
    const id = text(input, "taskId") ?? text(result, "taskId");
    const at = id ? keys.indexOf(id) : -1;
    if (at < 0) return undefined;
    const native = field(input, "status");
    if (native === "deleted") return { plan: { steps: steps.filter((_, i) => i !== at), updatedAt: "" }, keys: keys.filter((_, i) => i !== at) };
    const old = steps[at]!;
    const next = { text: text(input, "subject") ?? old.text, status: claudeStatus(native) ?? old.status };
    if (next.text === old.text && next.status === old.status) return undefined;
    return { plan: { steps: steps.map((s, i) => (i === at ? next : s)), updatedAt: "" }, keys };
  }
  return undefined;
}

/** Whether every step is done (or there are none). */
export function planDone(plan: BotPlan | undefined): boolean {
  return !plan || plan.steps.every((s) => s.status === "completed");
}

/** A kept plan read back from the database, or undefined when it is not one. */
export function readKept(raw: string | undefined): KeptPlan | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as KeptPlan;
    if (!v || !v.plan || !Array.isArray(v.plan.steps) || !Array.isArray(v.keys)) return undefined;
    const steps = v.plan.steps.filter((s) => s && typeof s.text === "string" && (s.status === "pending" || s.status === "inProgress" || s.status === "completed"));
    return { plan: { ...v.plan, steps }, keys: v.keys.slice(0, steps.length).map(String) };
  } catch {
    return undefined;
  }
}
