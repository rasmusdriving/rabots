import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeApproval, describeTool } from "../claude/labels.js";

describe("plain words for tools", () => {
  test("activity lines", () => {
    assert.deepEqual(describeTool("Read", { file_path: "/bots/kaja/AGENTS.md" }), {
      done: "Read AGENTS.md",
      running: "Reading AGENTS.md",
      detail: "/bots/kaja/AGENTS.md",
    });
    assert.equal(describeTool("Bash", { command: "ls" }).done, "Ran a command");
    assert.equal(describeTool("Bash", { command: "ls" }).detail, "ls");
    assert.equal(describeTool("WebSearch", { query: "weather" }).done, 'Searched the web for "weather"');
    assert.equal(describeTool("mcp__claude_ai_HubSpot__search_crm_objects", {}).done, "Used search crm objects in HubSpot");
    assert.equal(describeTool("SomethingNew", {}).running, "Using SomethingNew");
  });

  test("approval cards", () => {
    assert.deepEqual(describeApproval("Bash", { command: "touch a.txt", description: "Make a file" }), {
      title: "Run this command?",
      detail: "touch a.txt",
      caption: "Make a file",
    });
    assert.equal(describeApproval("Write", { file_path: "/x/y.md" }).title, "Write this file?");
  });

  test("no words that the app must not use", () => {
    const names = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "TodoWrite", "Skill", "AskUserQuestion", "X"];
    for (const n of names) {
      const w = describeTool(n, { description: "Check things" });
      const a = describeApproval(n, {});
      for (const text of [w.done, w.running, a.title]) {
        assert.doesNotMatch(text, /Claude Code|!|—|–/, `${n}: ${text}`);
      }
    }
  });
});
