// A refused start_helper call says so (docs/build/step-helper-status-clock.md). On the test copy a
// turn showed "1 failed" beside a helper that had worked: the failed line was an earlier call the
// engine refused (no model, no kind), stored failed but worded as if a helper had done the work.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActivityItem, HelperItem } from "../../shared/protocol.js";
import { settle, setup, upserts, type Ev } from "./fake.js";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const activities = (events: Ev[]) => items(events).filter((i): i is ActivityItem => i.kind === "activity");
const helperRows = (events: Ev[]) => items(events).filter((i): i is HelperItem => i.kind === "helper");
const resultText = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

describe("a refused start_helper call", () => {
  test("is a failed line that says it could not start a helper and why; the helper started after it is done", async () => {
    const { engine, sessions, events, store } = setup(undefined, () => true, {});
    const bot = engine.createBot({ name: "Po", model: "claude-haiku-5-5", access: "edits-freely" });
    engine.sendMessage({ botId: bot.id, text: "Have a helper check the docs" });
    await settle();
    const s = sessions.at(-1)!;
    s.emit({ type: "session", sessionId: "sess-1" });
    s.emit({ type: "turn-start", own: true });

    // First call: no model and no kind, so the engine refuses it before any helper starts.
    const refused = { title: "Check the docs", task: "Read the docs and say what is missing", wait: true };
    s.emit({ type: "tool-start", toolUseId: "tu-1", name: "mcp__pobots__start_helper", input: refused });
    const r1 = await s.tool("start_helper", refused);
    assert.equal(r1.isError, true, "the call is refused");
    s.emit({ type: "tool-end", toolUseId: "tu-1", isError: true, text: resultText(r1) });
    await settle();

    // Second call: with a model; the helper runs and answers.
    const before = sessions.length;
    const good = { ...refused, model: "claude-haiku-5-5", effort: "low", wait: false };
    s.emit({ type: "tool-start", toolUseId: "tu-2", name: "mcp__pobots__start_helper", input: good });
    const r2 = await s.tool("start_helper", good);
    assert.notEqual(r2.isError, true);
    s.emit({ type: "tool-end", toolUseId: "tu-2", isError: false, text: resultText(r2) });
    await settle();
    assert.equal(sessions.length, before + 1, "one helper session, for the second call only");
    sessions.at(-1)!.reply("Nothing is missing.");
    await settle();
    s.emit({ type: "text-full", key: "t-1", text: "The helper found nothing missing." });
    s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
    await settle();

    const failed = activities(events).filter((a) => a.status === "failed");
    assert.equal(failed.length, 1, "one failed line: the refused call");
    assert.equal(failed[0]!.label, "Could not start a helper: Check the docs");
    assert.equal(failed[0]!.detail, "A helper needs a model, or a kind that names one.", "the line says why, not the task");
    const rows = helperRows(events);
    assert.equal(rows.length, 1, "one helper row");
    assert.equal(rows[0]!.status, "done");
    engine.shutdown();
    store.close();
  });

  test("start_helper and start_task_manager have words for a failed call", () => {
    const { engine, store } = setup(undefined, () => true, {});
    const h = engine.toolWords("mcp__pobots__start_helper", { title: "Check the docs", task: "x" });
    assert.equal(h.failed, "Could not start a helper: Check the docs");
    assert.equal(engine.toolWords("mcp__pobots__start_helper", { task: "x" }).failed, "Could not start a helper");
    const m = engine.toolWords("mcp__pobots__start_task_manager", { title: "Customer survey", task: "x" });
    assert.equal(m.failed, "Could not start a task manager: Customer survey");
    assert.equal(engine.toolWords("mcp__pobots__start_task_manager", { task: "x" }).failed, "Could not start a task manager");
    engine.shutdown();
    store.close();
  });
});
