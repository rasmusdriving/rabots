// Engine 0.33.0 (protocol 24): a new install's first start and "About you" (docs/build/step-first-start.md).
// The main bot made by the first-start screen greets the person by itself; About you is kept in the
// database, every bot's session gets it, the person and the main bot can change it, and its words are
// never in the log or a quiet line.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Events } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { ABOUT_YOU_MAX, WELCOME_NOTE } from "../core/first-start.js";
import { Store } from "../store.js";
import { join } from "node:path";
import { changeLines, settle, setup, type FakeSession } from "./fake.js";

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const code = (c: string) => (err: unknown) => err instanceof EngineError && err.code === c;
const ABOUT = "Ada runs customer onboarding at Example Ltd (example.com).\nShe cares about clear plans.\nShe likes plain words, result first.";

async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const original = process.stderr.write.bind(process.stderr);
  const level = process.env.POBOTS_LOG;
  process.env.POBOTS_LOG = "info";
  let t = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    t += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), text: t };
  } finally {
    process.stderr.write = original;
    process.env.POBOTS_LOG = level;
  }
}

function sessionOf(sessions: FakeSession[], botId: string): FakeSession | undefined {
  return sessions.filter((s) => s.settings.botId === botId).at(-1);
}

async function turnOf(engine: ReturnType<typeof setup>["engine"], sessions: FakeSession[], botId: string, msg = "Go"): Promise<FakeSession> {
  engine.sendMessage({ botId, text: msg });
  await settle();
  const s = sessionOf(sessions, botId);
  assert.ok(s);
  return s;
}

describe("engine 0.33.0: the first start", () => {
  test("welcome starts the main bot's first turn by itself with Pobots' note, and nothing is in the chat before its greeting", async () => {
    const { engine, store, sessions, events } = setup();
    const po = engine.createBot({ name: "Po", welcome: true });
    await settle();
    assert.equal(po.role, "main");
    const s = sessionOf(sessions, po.id);
    assert.ok(s, "a session started without a message from the person");
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.text, WELCOME_NOTE);
    assert.match(WELCOME_NOTE, /change_settings about_you/);
    assert.ok(!engine.readThread({ threadId: po.mainThreadId }).items.some((i) => i.kind === "user"), "the note is not a message in the chat");
    assert.equal(engine.snapshot().bots[0]!.state === "idle", false, "the bot is at work");
    s.reply("Hello, I am Po, your main bot. Who are you, and what do you do?");
    await settle();
    const said = engine.readThread({ threadId: po.mainThreadId }).items.filter((i) => i.kind === "bot");
    assert.equal(said.length, 1);
    assert.match((said[0] as { text: string }).text, /^Hello, I am Po/);
    assert.ok(!events.some((e) => e.event === "card.added"));
    engine.shutdown();
    store.close();
  });

  test("no welcome turn without welcome, and never for a bot that is not the main bot", async () => {
    const { engine, store, sessions } = setup();
    const po = engine.createBot({ name: "Po" });
    await settle();
    assert.equal(sessionOf(sessions, po.id), undefined, "the first bot without welcome waits for the person, as before");
    const bo = engine.createBot({ name: "Bo", welcome: true });
    await settle();
    assert.equal(bo.role, "bot");
    assert.equal(sessionOf(sessions, bo.id), undefined, "welcome is ignored for any other bot");
    engine.shutdown();
    store.close();
  });
});

describe("engine 0.33.0: About you", () => {
  test("aboutYou.set keeps it trimmed in the database, tells every window, is in the snapshot, refuses more than 4,000 characters and clears with empty", () => {
    const { engine, store, events, dirs } = setup();
    assert.equal(engine.snapshot().aboutYou, "");
    const r = engine.aboutYouSet(`  ${ABOUT.replace(/\n/g, "\r\n")}  \n`);
    assert.equal(r.aboutYou, ABOUT);
    assert.equal(engine.snapshot().aboutYou, ABOUT);
    const changed = events.filter((e) => e.event === "aboutYou.changed").map((e) => (e.data as Events["aboutYou.changed"]).aboutYou);
    assert.deepEqual(changed, [ABOUT]);
    // The same again changes nothing and says nothing.
    engine.aboutYouSet(ABOUT);
    assert.equal(events.filter((e) => e.event === "aboutYou.changed").length, 1);
    assert.throws(() => engine.aboutYouSet("x".repeat(ABOUT_YOU_MAX + 1)), code("bad_request"));
    assert.equal(engine.snapshot().aboutYou, ABOUT, "a refused text changes nothing");
    engine.shutdown();
    store.close();
    // Kept in the database, so a restart (and the backup, which is the database) has it.
    const again = new Store(join(dirs.dataDir, "pobots.db"));
    assert.equal(again.getValue("about-you"), ABOUT);
    again.close();
    const { engine: e2, store: s2, events: ev2 } = setup(dirs);
    assert.equal(e2.snapshot().aboutYou, ABOUT);
    assert.equal(e2.aboutYouSet("  ").aboutYou, "");
    assert.equal(e2.snapshot().aboutYou, "");
    assert.equal(ev2.filter((e) => e.event === "aboutYou.changed").length, 1);
    e2.shutdown();
    s2.close();
  });

  test("every bot's session gets it after Pobots' team words; a change starts the sessions again between turns", async () => {
    const { engine, store, sessions } = setup();
    const po = engine.createBot("Po");
    const bo = engine.createBot("Bo");
    const s1 = await turnOf(engine, sessions, bo.id);
    assert.ok(!s1.settings.team.includes("About the person"), "no paragraph while there is no note");
    s1.reply("Ok.");
    await settle();
    engine.aboutYouSet(ABOUT);
    assert.equal(s1.closed, true, "a calm session closes, so the next turn has the note");
    const s2 = await turnOf(engine, sessions, bo.id, "Again");
    assert.notEqual(s2, s1);
    assert.match(s2.settings.team, /About the person you work for, as they or the main bot wrote it/);
    assert.ok(s2.settings.team.endsWith(ABOUT));
    // The main bot too; a busy session finishes its turn first.
    const m1 = await turnOf(engine, sessions, po.id);
    assert.ok(m1.settings.team.includes(ABOUT));
    engine.aboutYouSet(`${ABOUT}\nShe works from Stockholm.`);
    assert.equal(m1.closed, false, "a session in the middle of a turn is not closed");
    m1.reply("Done.");
    await settle();
    assert.equal(m1.closed, true, "it closes once the turn ended");
    engine.shutdown();
    store.close();
  });

  test("the main bot changes it with change_settings about_you: a quiet line with the word count, never the words; get_settings shows it", async () => {
    const { engine, store, sessions, events } = setup();
    const po = engine.createBot("Po");
    const ms = await turnOf(engine, sessions, po.id);
    assert.match(text(await ms.tool("get_settings")), /About you \(about_you\): not written yet\./);
    const { result, text: logged } = await captureLog(async () => text(await ms.tool("change_settings", { about_you: ABOUT })));
    assert.match(result, /person has a note/);
    assert.equal(engine.snapshot().aboutYou, ABOUT);
    assert.ok(!logged.includes("onboarding") && !logged.includes("Example Ltd"), "the words are never in the log");
    assert.match(logged, /About you was changed/);
    assert.match(text(await ms.tool("get_settings")), /About you \(about_you\), the note every bot gets:\nAda runs customer onboarding/);
    // Too long: refused in plain words, nothing changes.
    const refused = await ms.tool("change_settings", { about_you: "y".repeat(ABOUT_YOU_MAX + 1) });
    assert.equal(refused.isError, true);
    assert.equal(engine.snapshot().aboutYou, ABOUT);
    ms.reply("Written.");
    await settle();
    const lines = changeLines(events, po.mainThreadId);
    assert.deepEqual(lines, ["Pobots settings: About you written (about 19 words)"]);
    assert.ok(!lines.join(" ").includes("onboarding"));
    // Changed and cleared, from a new turn.
    const ms2 = await turnOf(engine, sessions, po.id, "Again");
    await ms2.tool("change_settings", { about_you: `${ABOUT} She works from Stockholm.` });
    ms2.reply("Changed.");
    await settle();
    const ms3 = await turnOf(engine, sessions, po.id, "And clear it");
    await ms3.tool("change_settings", { about_you: "" });
    ms3.reply("Cleared.");
    await settle();
    assert.deepEqual(changeLines(events, po.mainThreadId).slice(1), ["Pobots settings: About you changed (about 23 words)", "Pobots settings: About you cleared"]);
    assert.equal(engine.snapshot().aboutYou, "");
    engine.shutdown();
    store.close();
  });
});
