// Step 7c, part 3: a bot on full access and its helpers are never asked by Pobots. The harness still
// asks in its bypass mode about calls its own safety checks could not settle (13 Nov 2026: "Dangerous
// rm operation not ruled out" for heredocs into python3); those go on without a card. A helper never
// asks the person more than its bot would, and a card a helper raises names the helper.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AccessLevel, ApprovalCard, Events } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { settle, setup, type Ev, type FakeSession } from "./fake.js";

const FAST = { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20 };
const SAFETY = "Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed";
const HEREDOC = `cd "/tmp/other" && python3 - <<'EOF'\nold='await ev(\`$(".pb-x")[0]\`)'\nprint(old)\nEOF`;

async function botOn(access: AccessLevel) {
  const w = setup(undefined, () => true, FAST);
  const bot = w.engine.createBot({ name: "Po", purpose: "", job: "", model: "claude-haiku-5-5", effort: "low", access } as never);
  w.engine.sendMessage({ botId: bot.id, text: "Go" });
  await settle();
  const s = w.sessions.at(-1)!;
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  return { ...w, bot, s };
}

const cards = (events: Ev[]) => events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);

function ask(s: FakeSession, o: { agentID?: string } = {}) {
  return s.settings.canUseTool("Bash", { command: HEREDOC, description: "Fix the selectors" }, { signal: new AbortController().signal, toolUseID: "t-" + Math.random(), decisionReason: SAFETY, ...o } as never);
}

function done(w: { engine: Engine; store: { close(): void } }) {
  w.engine.shutdown();
  w.store.close();
}

describe("step 7c: full access means no cards", () => {
  test("a bot on full access: the harness's own safety question about its command goes on, with no card", async () => {
    const w = await botOn("full-access");
    const r = await ask(w.s);
    assert.equal(r?.behavior, "allow");
    assert.deepEqual((r as { updatedInput: unknown }).updatedInput, { command: HEREDOC, description: "Fix the selectors" });
    await settle();
    assert.equal(cards(w.events).length, 0, "no card was raised");
    done(w);
  });

  test("a helper of a bot on full access (the harness's own helper): the same, no card", async () => {
    const w = await botOn("full-access");
    w.s.helperStart("h1", { description: "Fix notifications review findings", background: true });
    await settle();
    const r = await ask(w.s, { agentID: "task-h1" });
    assert.equal(r?.behavior, "allow");
    await settle();
    assert.equal(cards(w.events).length, 0);
    done(w);
  });

  test("a helper of a bot on Decides itself is refused with a sentence, never a card", async () => {
    const w = await botOn("decides-itself");
    w.s.helperStart("h1", { description: "Fix things", background: true });
    await settle();
    const r = await ask(w.s, { agentID: "task-h1" });
    assert.equal(r?.behavior, "deny");
    assert.match((r as { message: string }).message, /decides by itself/);
    await settle();
    assert.equal(cards(w.events).length, 0);
    done(w);
  });

  test("a helper of a bot on Asks first raises the bot's card, which names the helper", async () => {
    const w = await botOn("asks-first");
    w.s.helperStart("h1", { description: "Fix notifications review findings", background: true });
    await settle();
    const asked = ask(w.s, { agentID: "task-h1" });
    await settle();
    const card = cards(w.events).at(-1) as ApprovalCard;
    assert.equal(card?.kind, "approval");
    assert.equal(card.helper, "Fix notifications review findings");
    w.engine.resolveCard(card.id, { type: "allow-once" });
    assert.equal((await asked)?.behavior, "allow");
    done(w);
  });

  test("the bot itself on Asks first and on Edits freely still gets a card, without a helper's name", async () => {
    for (const access of ["asks-first", "edits-freely"] as const) {
      const w = await botOn(access);
      const asked = ask(w.s);
      await settle();
      const card = cards(w.events).at(-1) as ApprovalCard;
      assert.equal(card?.kind, "approval", access);
      assert.equal(card.helper, undefined);
      w.engine.resolveCard(card.id, { type: "deny" });
      assert.equal((await asked)?.behavior, "deny");
      done(w);
    }
  });

  test("on full access a question from the harness's own question tool is still a question card", async () => {
    const w = await botOn("full-access");
    const asked = w.s.settings.canUseTool("AskUserQuestion", { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] }, { signal: new AbortController().signal, toolUseID: "q1" } as never);
    await settle();
    const card = cards(w.events).at(-1);
    assert.equal(card?.kind, "question");
    w.engine.resolveCard(card!.id, { type: "choice", choiceId: "1" });
    const r = await asked;
    assert.equal(r?.behavior, "allow");
    done(w);
  });
});
