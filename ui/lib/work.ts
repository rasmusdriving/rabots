// Lines of work folded into one line (step 7a), after T3 Code's work log
// (packages/client-runtime/src/work-log/presentation.ts, summarizeToolGroup; MIT): the bot's tool
// calls and thinking summaries between two pieces of its text are one line, "Ran 3 commands and read
// 2 files", which opens to the list.
import type { ActivityItem, ToolKind } from "../../shared/protocol";

/**
 * The kind of a line of work: what the engine says (since protocol 15), else read from the words of
 * older lines ("Ran a command", "Read AGENTS.md").
 */
export function kindOf(item: ActivityItem): ToolKind {
  if (item.tool) return item.tool;
  const l = item.label;
  if (/^(Ran|Running|Watched|Watching) a command/.test(l)) return "command";
  if (/^(Read|Reading) a (web )?page|^(Searched|Searching) the web|in the browser/.test(l)) return "web";
  if (/^(Read|Reading) /.test(l)) return "read";
  if (/^(Edited|Editing|Wrote|Writing) /.test(l)) return "edit";
  if (/^(Searched|Searching|Looked|Looking) for files|^(Searched|Searching) files|^(Listed|Listing) /.test(l)) return "search";
  if (/to-do list/.test(l)) return "plan";
  if (/^(Asked|Asking|Told|Telling|Sent|Sending) /.test(l)) return "message";
  if (/skill/.test(l)) return "skill";
  return "other";
}

const WORDS: Record<Exclude<ToolKind, "think">, [one: string, many: (n: number) => string]> = {
  command: ["Ran a command", (n) => `Ran ${n} commands`],
  read: ["Read a file", (n) => `Read ${n} files`],
  edit: ["Changed a file", (n) => `Changed ${n} files`],
  search: ["Searched files", (n) => `Searched files ${n} times`],
  web: ["Used the web", (n) => `Used the web ${n} times`],
  plan: ["Updated its to-do list", () => "Updated its to-do list"],
  message: ["Sent a message", (n) => `Sent ${n} messages`],
  skill: ["Used a skill", (n) => `Used ${n} skills`],
  other: ["Used a tool", (n) => `Used ${n} tools`],
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * One line for a group of lines of work: the kinds in the order they first came, at most three named
 * ("Ran 3 commands and read 2 files", "Ran 3 commands, read a file and changed 2 files"), the rest
 * counted ("... and 2 more steps"). Thinking summaries count only when there is nothing else:
 * "Thought", "Thought 3 times".
 */
export function summarize(items: ActivityItem[]): { words: string; kind: ToolKind | "mixed" } {
  const order: Exclude<ToolKind, "think">[] = [];
  const count = new Map<ToolKind, number>();
  let thoughts = 0;
  for (const i of items) {
    const k = kindOf(i);
    if (k === "think") {
      thoughts++;
      continue;
    }
    if (!count.has(k)) order.push(k);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  if (!order.length) return { words: thoughts > 1 ? `Thought ${thoughts} times` : "Thought", kind: "think" };
  const phrase = (k: Exclude<ToolKind, "think">) => {
    const n = count.get(k)!;
    return n === 1 ? WORDS[k][0] : WORDS[k][1](n);
  };
  const named = order.slice(0, 3).map((k, i) => (i === 0 ? phrase(k) : lowerFirst(phrase(k))));
  const rest = order.slice(3).reduce((n, k) => n + count.get(k)!, 0);
  if (rest > 0) named.push(rest === 1 ? "1 more step" : `${rest} more steps`);
  const words = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return { words, kind: order.length === 1 ? order[0]! : "mixed" };
}

/** The line a group shows while the bot works in it: the step that runs, else the newest one. */
export function currentOf(items: ActivityItem[]): ActivityItem | undefined {
  return [...items].reverse().find((i) => i.status === "running") ?? items.at(-1);
}
