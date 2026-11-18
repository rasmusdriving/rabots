// Failed words for every Pobots tool (docs/build/step-failed-words.md). A refused or failed call is
// stored failed; its line must say so ("Could not change Mira Test") and show the reason, never
// read as if it worked ("Changed Mira Test").
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActivityItem } from "../../shared/protocol.js";
import { TOOL_NAMES } from "../tool-names.js";
import { CALENDAR_TOOL_NAMES, calendarToolList, type CalendarHost } from "../calendar-tools.js";
import { SHORTEN_TOOL } from "../workers.js";
import { settle, setup, upserts, type Ev } from "./fake.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const activities = (events: Ev[]) => items(events).filter((i): i is ActivityItem => i.kind === "activity");
const resultText = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

// Inputs that reach every branch of the words: with and without names, read and write, tell and ask.
const INPUTS: Record<string, unknown>[] = [
  {},
  { bot: "Mira Test", to: "Mira Test", name: "Morning", title: "Call back", tag: "#ops", id: "h-1", path: "notes.md", query: "budget", text: "Hello", subject: "Sync" },
  { mode: "tell", delivery: "steer", action: "read", task: "back_up_now", create: true, id: "w-1" },
  { mode: "tell", action: "write", task: "update_providers" },
  { mode: "ask", task: "test_notification" },
];

describe("failed words", () => {
  test("a refused update_bot reads 'Could not change <bot>' and shows the reason", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, {});
    const po = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.createBot({ name: "Mira Test", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: po.id, text: "Change Mira Test" });
    await settle();
    const s = sessions.find((x) => x.toolNames().includes(TOOL_NAMES.updateBot)) ?? sessions.at(-1)!;
    assert.ok(s.toolNames().includes(TOOL_NAMES.updateBot), "the main bot has update_bot");
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });

    const input = { bot: "Mira Test" };
    s.emit({ type: "tool-start", toolUseId: "tu-1", name: `mcp__pobots__${TOOL_NAMES.updateBot}`, input });
    const r = await s.tool(TOOL_NAMES.updateBot, input);
    assert.equal(r.isError, true, "the call is refused: nothing would change");
    s.emit({ type: "tool-end", toolUseId: "tu-1", isError: true, text: resultText(r) });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();

    const line = activities(events).find((a) => a.status === "failed");
    assert.ok(line, "a failed line");
    assert.equal(line.label, "Could not change Mira Test");
    assert.equal(line.detail, "Nothing would change.", "the reason, where a done line shows its detail");
    assert.ok(!activities(events).some((a) => a.label === "Changed Mira Test"), "no line reads as if it worked");
    engine.shutdown();
    store.close();
  });

  test("a refused add_todo reads 'Could not add the to-do', not 'Used add todo in pobots'", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, {});
    const po = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: po.id, text: "Add a to-do" });
    await settle();
    const s = sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const input = { title: "  " };
    s.emit({ type: "tool-start", toolUseId: "tu-1", name: `mcp__pobots__${TOOL_NAMES.addTodo}`, input });
    const r = await s.tool(TOOL_NAMES.addTodo, input);
    assert.equal(r.isError, true, "a to-do without a title is refused");
    s.emit({ type: "tool-end", toolUseId: "tu-1", isError: true, text: resultText(r) });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();
    const line = activities(events).find((a) => a.status === "failed");
    assert.ok(line, "a failed line");
    assert.equal(line.label, "Could not add the to-do");
    assert.ok(line.detail && line.detail.length > 0, "the reason shows");
    engine.shutdown();
    store.close();
  });

  test("a failed connector step uses failed words, but built-in steps keep their labels", async () => {
    const { engine, sessions, events, store } = setup();
    const bot = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: bot.id, text: "Test the activity lines." });
    await settle();
    const s = sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-labels" });
    s.emit({ type: "turn-start", own: true });
    for (const [name, input, isError] of [
      ["mcp__claude_ai_Microsoft_365__outlook_email_search", { query: "example" }, true],
      ["mcp__docs__search", {}, false],
      ["Bash", { command: "false" }, true],
      ["Read", { file_path: "notes.md" }, true],
      ["Edit", { file_path: "draft.md" }, true],
    ] as const) {
      s.emit({ type: "tool-start", toolUseId: name, name, input });
      s.emit({ type: "tool-end", toolUseId: name, isError, text: "Example response" });
    }
    assert.deepEqual(activities(events).map((row) => [row.label, row.status]), [
      ["Could not use outlook email search in Microsoft 365", "failed"],
      ["Used search in docs", "done"],
      ["Ran a command", "failed"],
      ["Read notes.md", "failed"],
      ["Edited draft.md", "failed"],
    ]);
    engine.shutdown();
    store.close();
  });

  test("every tool the engine registers has failed words of its own", async () => {
    const { engine, sessions, store } = setup(undefined, () => true, {});
    const po = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.createBot({ name: "Mira Test", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: po.id, text: "Hello" });
    await settle();
    const registered = sessions.flatMap((s) => s.toolNames());
    // The calendar tools are registered only when the calendar is on; take their names from the list itself.
    const calendarHost = new Proxy({}, { get: () => async () => ({ content: [] }) }) as unknown as CalendarHost;
    const calendar = calendarToolList(calendarHost, "Europe/Stockholm").map((t) => t.name);
    const names = new Set([...registered, ...Object.values(TOOL_NAMES), ...Object.values(CALENDAR_TOOL_NAMES), ...calendar, SHORTEN_TOOL]);
    assert.ok(names.size >= 40, `the walk sees the tools (${names.size})`);
    const missing: string[] = [];
    for (const n of names) {
      for (const input of INPUTS) {
        const w = engine.toolWords(`mcp__pobots__${n}`, input);
        assert.ok(w.failed, `${n} has failed words`);
        assert.match(w.failed, /^Could not /, `${n}: "${w.failed}" says it did not work`);
        assert.notEqual(w.failed, w.done, `${n}: the failed words differ from the done words`);
        assert.equal(w.whyOnFail, true, `${n} shows the reason when it fails`);
        assert.doesNotMatch(w.failed, /[!—–]/, `${n}: app voice`);
        if (w.failed.startsWith("Could not use ")) missing.push(n);
      }
    }
    assert.deepEqual([...new Set(missing)], [], "each known tool has its own words, not the fallback");
    engine.shutdown();
    store.close();
  });

  test("a restart with a question card open: the question was asked, its line is not failed; other calls cut short are", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, {});
    const po = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.createBot({ name: "Mira Test", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: po.id, text: "Ask me, then tell Mira Test" });
    await settle();
    const s = sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });
    const question = { question: "Which customer first?", choices: ["Nordvik", "Aalto"] };
    s.emit({ type: "tool-start", toolUseId: "tu-1", name: `mcp__pobots__${TOOL_NAMES.askHuman}`, input: question });
    void s.tool(TOOL_NAMES.askHuman, question);
    s.emit({ type: "tool-start", toolUseId: "tu-2", name: `mcp__pobots__${TOOL_NAMES.messageBot}`, input: { to: "Mira Test", mode: "ask", text: "Ready?" } });
    await settle();
    assert.ok(engine.snapshot().cards.some((c) => c.kind === "question"), "the card is open");
    engine.shutdown();
    await settle();
    const lines = activities(events);
    const asked = lines.find((a) => a.label === "Asked you a question" || a.label === "Could not ask you a question");
    assert.equal(asked?.label, "Asked you a question", "the card stays open, so the question was asked");
    assert.equal(asked?.status, "done");
    const ask = lines.find((a) => /Mira Test/.test(a.label));
    assert.equal(ask?.label, "Could not ask Mira Test", "a call cut short is failed, in its failed words");
    assert.equal(ask?.status, "failed");
    store.close();
  });

  test("activity_log shows its day, or its from/to range, as the detail", () => {
    const { engine, store } = setup(undefined, () => true, {});
    const words = (input: Record<string, unknown>) => engine.toolWords(`mcp__pobots__${TOOL_NAMES.activityLog}`, input);
    assert.equal(words({ day: "2026-11-16" }).detail, "2026-11-16");
    assert.equal(words({ from: "2026-11-10", to: "2026-11-14" }).detail, "2026-11-10 to 2026-11-14");
    assert.equal(words({ from: "2026-11-10" }).detail, "2026-11-10 to 2026-11-10");
    assert.equal(words({ day: "", from: "2026-11-10", to: "2026-11-12" }).detail, "2026-11-10 to 2026-11-12");
    assert.equal(words({}).detail, undefined);
    engine.shutdown();
    store.close();
  });

  test("a Pobots tool without words of its own still never reads as success", () => {
    const { engine, store } = setup(undefined, () => true, {});
    const w = engine.toolWords("mcp__pobots__brand_new_tool", {});
    assert.equal(w.failed, "Could not use brand new tool");
    assert.equal(w.whyOnFail, true);
    // Built-in tools keep their current words.
    assert.equal(engine.toolWords("Bash", { command: "ls" }).failed, undefined);
    engine.shutdown();
    store.close();
  });
});
