// "Always allow" rules. The engine owns them: each is kept in its database, shown in plain words,
// handed to the bot's harness session when it starts (as settings) and added to a live session
// for that session only. Forgetting a rule takes effect when the harness session is refreshed,
// which the engine does between turns.
//
// Rules are written the way the harness writes them: "Bash(git status:*)", "WebFetch(domain:x.se)",
// "mcp__server__tool", "Edit(/path/**)".
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const words = (s: string): string => s.replace(/[_-]+/g, " ").trim();
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "..." : s);

/** The rule string for one harness rule value. */
export function ruleString(toolName: string, ruleContent?: string): string {
  return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

export function parseRule(rule: string): { tool: string; content?: string } {
  const m = /^([^()]+)\((.*)\)$/s.exec(rule.trim());
  return m ? { tool: m[1]!.trim(), content: m[2]! } : { tool: rule.trim() };
}

/** A rule in plain words: "Run commands that start with git status". */
export function ruleLabel(rule: string): string {
  const { tool, content } = parseRule(rule);
  const c = content?.trim();
  switch (tool) {
    case "Bash":
    case "PowerShell": {
      if (!c || c === "*") return "Run any command";
      const prefix = /^(.*?)(?::\*|\s\*|\*)$/.exec(c);
      if (prefix && prefix[1]!.trim()) return `Run commands that start with ${clip(prefix[1]!.trim())}`;
      return `Run the command ${clip(c)}`;
    }
    case "Read":
      return c ? `Read files in ${clip(c)}` : "Read any file";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return c ? `Change files in ${clip(c)}` : "Change any file";
    case "WebFetch": {
      const d = c?.replace(/^domain:/, "");
      return d ? `Open pages on ${clip(d)}` : "Open web pages";
    }
    case "WebSearch":
      return "Search the web";
    case "Glob":
    case "Grep":
      return "Look through files";
  }
  const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(tool);
  if (mcp) {
    const server = words(mcp[1]!.replace(/^claude_ai_/, ""));
    if (!mcp[2] || mcp[2] === "*") return `Use any tool in ${server}`;
    return `Use ${words(mcp[2])} in ${server}`;
  }
  return c ? `Use ${words(tool)} for ${clip(c)}` : `Use ${words(tool)}`;
}

/**
 * The rules to save from the harness's suggestions for an "Always allow". Only allow rules are
 * kept. Suggestions that would change the access level or add folders are left out, so an
 * "Always allow" never widens more than the one kind of action.
 */
export function rulesFromSuggestions(suggestions: PermissionUpdate[] | undefined): string[] {
  const out: string[] = [];
  for (const s of suggestions ?? []) {
    if ((s.type === "addRules" || s.type === "replaceRules") && s.behavior === "allow") {
      for (const r of s.rules) out.push(ruleString(r.toolName, r.ruleContent));
    }
  }
  return [...new Set(out)];
}

/** The live update for the running harness session: the same rules, for this session only. */
export function sessionUpdate(rules: string[]): PermissionUpdate[] {
  if (!rules.length) return [];
  return [
    {
      type: "addRules",
      behavior: "allow",
      destination: "session",
      rules: rules.map((r) => {
        const p = parseRule(r);
        return p.content !== undefined ? { toolName: p.tool, ruleContent: p.content } : { toolName: p.tool };
      }),
    },
  ];
}

/**
 * Rules made before step 2a: step 1 let the harness save them in the bot's own
 * `.claude/settings.local.json`, which later sessions did not load. Returns what can be read.
 */
export function readOldRules(botDir: string): { rules: string[]; at: string } {
  const path = join(botDir, ".claude", "settings.local.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { permissions?: { allow?: unknown } };
    const allow = raw?.permissions?.allow;
    const rules = Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim()) : [];
    return { rules: [...new Set(rules)], at: statSync(path).mtime.toISOString() };
  } catch {
    return { rules: [], at: new Date().toISOString() };
  }
}
