// Plain words for tool calls: activity lines in the chat, the roster's activity line and the
// text of approval cards. Nothing here says "Claude Code".
import { basename } from "node:path";
import type { ToolKind } from "../../shared/protocol.js";
import { isBrowserCommand } from "../browser.js";

export interface ToolWords {
  /** Past tense, for the finished activity line: "Read AGENTS.md". */
  done: string;
  /** Present tense, for a running activity and the roster: "Reading AGENTS.md". */
  running: string;
  /** The extra detail shown on request: the command, the path, the query. */
  detail?: string;
  /** For the finished line when the call failed, when the past tense would say it worked. */
  failed?: string;
  /** When the call fails, its line's detail is why (the tool's answer) in place of `detail`. */
  whyOnFail?: boolean;
}

/** The parts of a tool's words a running call keeps for its line when the call fails. */
export function failWords(words: ToolWords): { failed?: string; whyOnFail?: boolean } {
  return { ...(words.failed ? { failed: words.failed } : {}), ...(words.whyOnFail ? { whyOnFail: true } : {}) };
}

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const short = (s: string, n = 60): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "..." : s);
const file = (input: Input): string | undefined => {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  return p ? basename(p) : undefined;
};
const words = (s: string): string => s.replace(/[_-]+/g, " ").trim();

/**
 * What kind of work a tool call is, for the icon of its line and for summing up a group of lines
 * ("Ran 3 commands"); step 7a. Pobots' own tools come as mcp__pobots__<name>.
 */
export function toolKind(name: string, input: Input): ToolKind {
  switch (name) {
    case "Bash":
    case "PowerShell":
    case "Monitor":
      return isBrowserCommand(input.command) ? "web" : "command";
    case "Read":
    case "NotebookRead":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Glob":
    case "Grep":
    case "LS":
      return "search";
    case "WebSearch":
    case "WebFetch":
      return "web";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "plan";
    case "Skill":
      return "skill";
    case "SendMessage":
    case "AskUserQuestion":
      return "message";
  }
  if (/^mcp__[^_]+(?:_[^_]+)*__(message_bot|ask_human|notify_human)$/.test(name)) return "message";
  return "other";
}

export function describeTool(name: string, input: Input): ToolWords {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Read": {
      const f = file(input) ?? "a file";
      return { done: `Read ${f}`, running: `Reading ${f}`, detail: path };
    }
    case "Write": {
      const f = file(input) ?? "a file";
      return { done: `Wrote ${f}`, running: `Writing ${f}`, detail: path };
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const f = file(input) ?? "a file";
      return { done: `Edited ${f}`, running: `Editing ${f}`, detail: path };
    }
    case "Bash":
    case "PowerShell":
      if (isBrowserCommand(input.command)) return { done: "Worked in the browser", running: "Working in the browser", detail: str(input.command) };
      return { done: "Ran a command", running: "Running a command", detail: str(input.command) };
    case "Monitor":
      return { done: "Watched a command", running: "Watching a command", detail: str(input.command) };
    case "Glob":
      return { done: "Looked for files", running: "Looking for files", detail: str(input.pattern) };
    case "Grep": {
      const q = str(input.pattern);
      return q
        ? { done: `Searched files for "${short(q, 40)}"`, running: `Searching files for "${short(q, 40)}"`, detail: q }
        : { done: "Searched files", running: "Searching files" };
    }
    case "WebSearch": {
      const q = str(input.query);
      return q
        ? { done: `Searched the web for "${short(q, 50)}"`, running: `Searching the web for "${short(q, 50)}"`, detail: q }
        : { done: "Searched the web", running: "Searching the web" };
    }
    case "WebFetch": {
      const url = str(input.url);
      let host: string | undefined;
      try {
        host = url ? new URL(url).hostname : undefined;
      } catch {
        host = undefined;
      }
      return host
        ? { done: `Read a page on ${host}`, running: `Reading a page on ${host}`, detail: url }
        : { done: "Read a web page", running: "Reading a web page", detail: url };
    }
    case "Agent":
    case "Task": {
      const d = str(input.description);
      return d
        ? { done: `Had a helper ${lowerFirst(short(d))}`, running: `A helper is working: ${lowerFirst(short(d))}`, detail: str(input.prompt) }
        : { done: "Had a helper do some work", running: "A helper is working" };
    }
    // The harness's way to give a helper that has ended more to do (seen in step 3b). It can also
    // reach other sessions; then it is just a message.
    case "SendMessage": {
      const kind = str(input.recipient_kind);
      const said = typeof input.message === "string" ? str(input.message) : str(input.content);
      if (kind && kind !== "agent") return { done: "Sent a message", running: "Sending a message", detail: said };
      return { done: "Gave a helper more to do", running: "Giving a helper more to do", detail: said };
    }
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { done: "Updated its to-do list", running: "Updating its to-do list" };
    case "Skill": {
      const s = str(input.skill) ?? str(input.name);
      return s ? { done: `Used the ${s} skill`, running: `Using the ${s} skill` } : { done: "Used a skill", running: "Using a skill" };
    }
    case "AskUserQuestion":
      return { done: "Asked you a question", running: "Asking you a question" };
    // A GPT bot's own agents inside Codex (step 3a): one line, no helper rows of their own yet.
    case "CodexAgents":
      return { done: "Worked with its own helpers", running: "Working with its own helpers", detail: str(input.prompt) };
    case "RequestPermissions":
      return { done: "Asked for more access", running: "Asking for more access", detail: permissionWords(input) };
    case "ToolSearch":
      return { done: "Looked up its tools", running: "Looking up its tools" };
    case "ExitPlanMode":
      return { done: "Shared a plan", running: "Sharing a plan" };
    case "Artifact": {
      const action = input.action;
      if ((action === undefined || action === "publish") && input.asset !== true && (str(input.file_path) || str(input.type_url))) {
        return { done: "Published it to Claude", running: "Publishing it to Claude", failed: "Could not publish it to Claude", detail: str(input.file_path) ?? str(input.title) };
      }
      if (action === "list") return { done: "Looked at its artifacts on Claude", running: "Looking at its artifacts on Claude" };
      if (action === "read") return { done: "Read an artifact on Claude", running: "Reading an artifact on Claude", detail: str(input.url) };
      break;
    }
  }
  if (/^mcp__.*Claude_Docs__batch$/i.test(name)) {
    const container = input.container && typeof input.container === "object" ? (input.container as Input) : undefined;
    const create = container?.create && typeof container.create === "object" ? (container.create as Input) : undefined;
    if (create) return { done: "Made a document on Claude", running: "Making a document on Claude", failed: "Could not make the document on Claude", detail: str(create.name) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const tool = words(mcp[2]!);
    const server = words(mcp[1]!.replace(/^claude_ai_/, ""));
    const step = `${tool} in ${server}`;
    return { done: `Used ${step}`, running: `Using ${step}`, failed: `Could not use ${step}`, detail: compactJson(input) };
  }
  return { done: `Used ${words(name)}`, running: `Using ${words(name)}`, detail: compactJson(input) };
}

/** What a GPT bot asks to be allowed, in plain words, one thing per line. */
function permissionWords(input: Input): string | undefined {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const lines: string[] = [];
  if (input.network === true) lines.push("Use the network");
  const write = list(input.write);
  const read = list(input.read);
  if (write.length) lines.push(`Write in: ${write.join(", ")}`);
  if (read.length) lines.push(`Read in: ${read.join(", ")}`);
  const reason = str(input.reason);
  if (reason) lines.push("", `Why: ${reason}`);
  return lines.length ? lines.join("\n") : undefined;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function compactJson(input: Input): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  try {
    const text = JSON.stringify(input, null, 2);
    return text.length > 2000 ? text.slice(0, 2000) + "\n..." : text;
  } catch {
    return undefined;
  }
}

/** The approval card text for a tool the bot wants to use. */
export function describeApproval(name: string, input: Input): { title: string; detail: string; caption?: string } {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Bash":
    case "PowerShell":
    case "Monitor":
      return { title: "Run this command?", detail: str(input.command) ?? "", caption: str(input.description) ?? "Command" };
    case "Write":
      return { title: "Write this file?", detail: path ?? "", caption: "Write a file" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      // A GPT bot's change can touch several files at once; the card names them all.
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === "string") : [];
      if (files.length > 1) return { title: "Change these files?", detail: files.join("\n"), caption: "Edit files" };
      return { title: "Change this file?", detail: path ?? "", caption: "Edit a file" };
    }
    case "RequestPermissions":
      return { title: "Allow more access?", detail: permissionWords(input) ?? "", caption: "More access" };
    case "WebFetch":
      return { title: "Open this page?", detail: str(input.url) ?? "", caption: "Web page" };
    case "WebSearch":
      return { title: "Search the web?", detail: str(input.query) ?? "", caption: "Web search" };
    case "ExitPlanMode":
      return { title: "Go ahead with this plan?", detail: str(input.plan) ?? "", caption: "Plan" };
  }
  const w = describeTool(name, input);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return {
    title: `${w.running.replace(/^Using/, "Use")}?`,
    detail: w.detail ?? compactJson(input) ?? "",
    caption: mcp ? words(mcp[1]!.replace(/^claude_ai_/, "")) : name,
  };
}
