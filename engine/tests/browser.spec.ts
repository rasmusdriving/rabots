// The bots' browser in the engine (docs/build/step-2g.md, A1 to A5, A7). No model and no real
// browser: the real helper script runs against a stand-in (fake-browser.ts).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type BrowserItem, type BrowserState, type Events, type Item } from "../../shared/protocol.js";
import { claimsOf, cleanAddress, isBrowserCommand, lastLine, scriptFilesOf, type BrowserConn, type BrowserTimings } from "../browser.js";
import { helperScript } from "../browser-script.js";
import { keyCodeOf, toActions } from "../browser-input.js";
import { EngineError } from "../errors.js";
import { EngineServer, FrameSlot } from "../server.js";
import { Store } from "../store.js";
import { FakeBrowser, type FakeTab, fakeFrame, until } from "./fake-browser.js";
import { type Ev, type FakeSession, settle, setup, upserts } from "./fake.js";
import { tempDir } from "./helpers.js";

const T: BrowserTimings = { fastMs: 40, slowMs: 150, idleStopMs: 600, readyMs: 2000, retryMs: 300, watcherGraceMs: 80, peekGapMs: 20, titlePeekMs: 100, lastMs: 60, endListMs: 300, tabsMs: 30, fastShotMs: 15, slowShotMs: 50, stillMs: 120 };

class Conn implements BrowserConn {
  id = `conn-${Math.random()}`;
  frames: Events["browser.frame"][] = [];
  endings: Events["browser.ended"][] = [];
  prompts: Events["browser.prompt"][] = [];
  frame(d: Events["browser.frame"]) {
    this.frames.push(d);
  }
  prompt(d: Events["browser.prompt"]) {
    this.prompts.push(d);
  }
  ended(d: Events["browser.ended"]) {
    this.endings.push(d);
  }
}

const worlds: { engine: { shutdown(): void } }[] = [];
after(() => {
  // A test that failed half-way still stops its engine, so the helper scripts end and the run can end.
  for (const w of worlds.splice(0)) w.engine.shutdown();
});

function world(o: { fb?: FakeBrowser; dirs?: { dataDir: string; botsDir: string } } = {}) {
  const fb = o.fb ?? new FakeBrowser();
  const w = setup(o.dirs, undefined, undefined, { browser: fb.driver(), browserTimings: T });
  worlds.push(w);
  return { ...w, fb, hub: w.engine.browser, close: () => w.engine.shutdown() };
}

const states = (events: Ev[]) => events.filter((e) => e.event === "browser.changed").map((e) => (e.data as Events["browser.changed"]).state);
const lastStateOf = (events: Ev[]) => states(events).at(-1);
const browserItems = (events: Ev[]) => {
  const byId = new Map<string, BrowserItem>();
  for (const i of upserts(events)) if (i.kind === "browser") byId.set(i.id, i);
  return [...byId.values()];
};

/** A bot in a turn, ready to run commands. */
async function botInTurn(w: ReturnType<typeof world>, name = "Po") {
  const bot = w.engine.createBot(name);
  w.engine.sendMessage({ botId: bot.id, text: "Open the page" });
  await settle();
  const s = w.sessions.find((x) => x.settings.botId === bot.id)!;
  return { bot, s };
}

function browserCommand(script: string): string {
  return `ego-browser nodejs <<'EOF'\n${script}\nEOF`;
}

function startCmd(s: FakeSession, id: string, command: string, parent?: string) {
  s.emit({ type: "tool-start", toolUseId: id, name: "Bash", input: { command }, ...(parent ? { parent } : {}) });
}
function endCmd(s: FakeSession, id: string, parent?: string) {
  s.emit({ type: "tool-end", toolUseId: id, isError: false, text: "ok", ...(parent ? { parent } : {}) });
}

// ---------------------------------------------------------------- small parts

describe("browser: reading a bot's command", () => {
  test("a command that runs ego-browser is browser work; others are not", () => {
    assert.ok(isBrowserCommand("ego-browser nodejs <<'EOF'\nx\nEOF"));
    assert.ok(isBrowserCommand("cd /tmp && ~/.local/bin/ego-browser nodejs < a.js"));
    assert.ok(isBrowserCommand("cat s.js | ego-browser nodejs"));
    assert.ok(!isBrowserCommand("echo ego-browsers"));
    assert.ok(!isBrowserCommand("ls -la"));
    assert.ok(!isBrowserCommand(undefined));
  });

  test("the workspace a script names: by name (quotes of every kind, escaped in -e) and by number", () => {
    assert.deepEqual(claimsOf('const t = await taskSpace("Check the survey settings");'), { names: ["Check the survey settings"], ids: [] });
    assert.deepEqual(claimsOf("const t = await taskSpace('Inbox');"), { names: ["Inbox"], ids: [] });
    assert.deepEqual(claimsOf('ego-browser nodejs -e "const t = await taskSpace(\\"Esc\\"); "'), { names: ["Esc"], ids: [] });
    assert.deepEqual(claimsOf("await taskSpace(7); await takeOverTaskSpace(12); await claimTaskSpace( 3 )"), { names: [], ids: [7, 12, 3] });
    assert.deepEqual(claimsOf("await taskSpace(name)"), { names: [], ids: [] });
    assert.deepEqual(claimsOf("await taskSpace(`x ${n}`)"), { names: [], ids: [] });
  });

  test("the script files a command hands to ego-browser", () => {
    assert.deepEqual(scriptFilesOf("ego-browser nodejs < /tmp/run.js"), ["/tmp/run.js"]);
    assert.deepEqual(scriptFilesOf('ego-browser nodejs < "my script.js"'), ["my script.js"]);
    assert.deepEqual(scriptFilesOf("ego-browser nodejs scripts/go.mjs"), ["scripts/go.mjs"]);
    assert.deepEqual(scriptFilesOf("cat work/s.js | ego-browser nodejs"), ["work/s.js"]);
    assert.deepEqual(scriptFilesOf("ego-browser nodejs -e 'await taskSpace(1)'"), []);
  });

  test("the row's line: title and host, on one line, at most 160 characters", () => {
    assert.equal(lastLine("Surveys", "https://app.example.com/surveys"), "Surveys · app.example.com");
    assert.equal(lastLine("  Two\nlines ", "https://example.org/"), "Two lines · example.org");
    // A new page with no address yet says nothing (never "New Tab").
    assert.equal(lastLine("Blank", "about:blank"), "");
    assert.equal(lastLine("New Tab", "chrome://newtab/"), "");
    assert.equal(lastLine("Only a title", ""), "Only a title");
    assert.equal(lastLine("", "https://example.net/"), "example.net");
    assert.equal(lastLine("x".repeat(300), "https://example.com/").length, 160);
  });

  test("the address rules of browser.go: http and https only, a bare host gets https", () => {
    assert.equal(cleanAddress("example.com"), "https://example.com/");
    assert.equal(cleanAddress("example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(cleanAddress("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(cleanAddress("localhost:3000"), "https://localhost:3000/");
    assert.equal(cleanAddress("127.0.0.1:9"), "https://127.0.0.1:9/");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "data:text/html,x", "chrome://settings", "mailto:a@example.com", "", "two words", "https://"]) {
      assert.equal(cleanAddress(bad), undefined, bad);
    }
  });
});

/** A step as it reaches the page when no drop-down list is there (see InputStep's pick and keyPick). */
type Step = { method: string; params: Record<string, unknown> };
function unwrap(s: Step | { pick: { step: Step } } | { keyPick: Step }): Step {
  return "pick" in s ? s.pick.step : "keyPick" in s ? s.keyPick : s;
}

describe("browser: the person's input", () => {
  test("pointer: move, down and up with button and click count (a double click), held buttons, wheel", () => {
    const p = { buttons: 0 };
    const [a] = toActions(
      [
        { type: "move", x: 10, y: 20 },
        { type: "down", x: 10, y: 20, button: "left", clicks: 1 },
        { type: "move", x: 30, y: 20 },
        { type: "up", x: 30, y: 20, button: "left", clicks: 1 },
        { type: "down", x: 5, y: 5, button: "left", clicks: 2 },
        { type: "up", x: 5, y: 5, button: "left", clicks: 2 },
        { type: "wheel", x: 50, y: 60, dx: 0, dy: 120 },
      ],
      p,
    );
    assert.equal(a!.kind, "steps");
    const steps = (a as { steps: Parameters<typeof unwrap>[0][] }).steps.map(unwrap);
    assert.deepEqual(steps.map((s) => s.params.type), ["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased", "mousePressed", "mouseReleased", "mouseWheel"]);
    assert.equal(steps[2]!.params.button, "left");
    assert.equal(steps[2]!.params.buttons, 1);
    assert.equal(steps[3]!.params.buttons, 0);
    assert.equal(steps[4]!.params.clickCount, 2);
    assert.equal(steps[6]!.params.deltaY, 120);
    assert.equal(p.buttons, 0);
  });

  test("keys: text, Enter, Tab, Escape, Backspace, arrows and Page Up/Down keep their meaning; held keys repeat", () => {
    const [a] = toActions(
      [
        { type: "key", down: true, key: "å", code: "BracketLeft", text: "å" },
        { type: "key", down: false, key: "å", code: "BracketLeft" },
        { type: "key", down: true, key: "Enter", code: "Enter" },
        { type: "key", down: true, key: "Tab", code: "Tab", mods: 8 },
        { type: "key", down: true, key: "Escape", code: "Escape" },
        { type: "key", down: true, key: "Backspace", code: "Backspace", repeat: true },
        { type: "key", down: true, key: "ArrowDown", code: "ArrowDown" },
        { type: "key", down: true, key: "PageDown", code: "PageDown" },
      ],
      { buttons: 0 },
    );
    const steps = (a as { steps: Parameters<typeof unwrap>[0][] }).steps.map(unwrap);
    assert.deepEqual(steps.map((s) => s.params.type), ["keyDown", "keyUp", "keyDown", "rawKeyDown", "rawKeyDown", "rawKeyDown", "rawKeyDown", "rawKeyDown"]);
    assert.equal(steps[0]!.params.text, "å");
    assert.equal(steps[2]!.params.text, "\r");
    assert.equal(steps[3]!.params.modifiers, 8);
    assert.equal(steps[3]!.params.windowsVirtualKeyCode, 9);
    assert.equal(steps[5]!.params.autoRepeat, true);
    assert.equal(steps[5]!.params.windowsVirtualKeyCode, 8);
    assert.equal(keyCodeOf("ArrowDown", "ArrowDown"), 40);
    assert.equal(keyCodeOf("a", "KeyA"), 65);
    assert.equal(keyCodeOf("5", "Digit5"), 53);
  });

  test("editing shortcuts work from Ctrl as from the command key, and never touch the Mac's clipboard", () => {
    const shortcut = (code: string, mods: number) => {
      const [a] = toActions([{ type: "key", down: true, key: code.slice(3).toLowerCase(), code, mods }], { buttons: 0 });
      return (a as { steps: Record<string, unknown>[] }).steps;
    };
    for (const mods of [2, 4]) {
      const sa = shortcut("KeyA", mods)[0] as { params: Record<string, unknown> };
      assert.deepEqual(sa.params.commands, ["selectAll"]);
      assert.equal(sa.params.modifiers, 4, "Ctrl becomes the command key on the Mac");
      assert.deepEqual((shortcut("KeyZ", mods)[0] as { params: Record<string, unknown> }).params.commands, ["undo"]);
      assert.deepEqual((shortcut("KeyZ", mods | 8)[0] as { params: Record<string, unknown> }).params.commands, ["redo"]);
      assert.deepEqual((shortcut("KeyY", mods)[0] as { params: Record<string, unknown> }).params.commands, ["redo"]);
      // Copy and paste: the key reaches the page, but no command: the app copies with browser.selection and pastes as text.
      assert.equal((shortcut("KeyC", mods)[0] as { params: Record<string, unknown> }).params.commands, undefined);
      assert.equal((shortcut("KeyV", mods)[0] as { params: Record<string, unknown> }).params.commands, undefined);
      // Cut keeps the selection for browser.selection, then deletes it.
      const cut = shortcut("KeyX", mods);
      assert.deepEqual(cut[0], { save: true });
      assert.deepEqual((cut[1] as { params: Record<string, unknown> }).params.commands, ["deleteBackward"]);
    }
    const all = toActions([{ type: "key", down: true, key: "a", code: "KeyA", mods: 2 }], { buttons: 0 });
    assert.ok(!JSON.stringify(all).includes('"copy"') && !JSON.stringify(all).includes('"paste"') && !JSON.stringify(all).includes('"cut"'));
  });

  test("Home, End, Ctrl+arrows, Ctrl+Backspace and Delete: in a field the caret moves, elsewhere Home and End scroll", () => {
    const one = (key: string, mods = 0) => ((toActions([{ type: "key", down: true, key, code: key, mods }], { buttons: 0 })[0] as { steps: unknown[] }).steps[0] as { focus: { editable: { params: Record<string, unknown> }[]; plain: { params: Record<string, unknown> }[] } }).focus;
    assert.deepEqual(one("Home").editable[0]!.params.commands, ["moveToBeginningOfLine"]);
    assert.deepEqual(one("Home").plain[0]!.params.commands, ["scrollToBeginningOfDocument"]);
    assert.deepEqual(one("End", 8).editable[0]!.params.commands, ["moveToEndOfLineAndModifySelection"]);
    assert.deepEqual(one("Home", 2).editable[0]!.params.commands, ["moveToBeginningOfDocument"]);
    assert.deepEqual(one("ArrowLeft", 2).editable[0]!.params.commands, ["moveWordLeft"]);
    assert.deepEqual(one("ArrowRight", 10).editable[0]!.params.commands, ["moveWordRightAndModifySelection"]);
    assert.deepEqual(one("Backspace", 2).editable[0]!.params.commands, ["deleteWordBackward"]);
    assert.deepEqual(one("Delete").editable[0]!.params.commands, ["deleteForward"]);
  });

  test("AltGr types its character; a paste is text at once", () => {
    const [a] = toActions(
      [
        { type: "key", down: true, key: "@", code: "Digit2", text: "@", mods: 3 },
        { type: "text", text: "pasted åäö" },
      ],
      { buttons: 0 },
    );
    const steps = (a as { steps: { method: string; params: Record<string, unknown> }[] }).steps;
    assert.equal(steps[0]!.params.type, "keyDown");
    assert.equal(steps[0]!.params.text, "@");
    assert.equal(steps[0]!.params.modifiers, 0);
    assert.deepEqual(steps[1], { method: "Input.insertText", params: { text: "pasted åäö" } });
  });

  test("a page's dialog: only the answer reaches it; Enter accepts (a prompt with what was typed), Escape dismisses", () => {
    const d = { type: "prompt", defaultPrompt: "", typed: "" };
    const acts = toActions(
      [
        { type: "down", x: 1, y: 1 },
        { type: "key", down: true, key: "h", code: "KeyH", text: "h" },
        { type: "text", text: "ej" },
        { type: "key", down: true, key: "Enter", code: "Enter" },
        { type: "key", down: true, key: "a", code: "KeyA", text: "a" },
      ],
      { buttons: 0 },
      d,
    );
    assert.deepEqual(acts[0], { kind: "dialog", accept: true, text: "hej" });
    assert.equal(acts[1]!.kind, "steps", "after the answer, keys reach the page again");
    assert.deepEqual(toActions([{ type: "key", down: true, key: "Escape", code: "Escape" }], { buttons: 0 }, { type: "confirm", defaultPrompt: "", typed: "" }), [{ kind: "dialog", accept: false }]);
  });

  test("a left press, and Space, Enter, Up, Down, Alt+Down, look for a drop-down list first; other presses and keys do not", () => {
    const stepsOf = (events: Parameters<typeof toActions>[0]) => (toActions(events, { buttons: 0 })[0] as { steps: Record<string, unknown>[] }).steps;
    const left = stepsOf([{ type: "down", x: 10, y: 20, button: "left", clicks: 1 }])[0] as { pick: { x: number; y: number; step: { params: { type: string } } } };
    assert.deepEqual([left.pick.x, left.pick.y, left.pick.step.params.type], [10, 20, "mousePressed"]);
    assert.ok("method" in stepsOf([{ type: "down", x: 10, y: 20, button: "right", clicks: 1 }])[0]!, "a right press is passed on");
    assert.ok("method" in stepsOf([{ type: "up", x: 10, y: 20, button: "left", clicks: 1 }])[0]!, "a release is passed on");
    const key = (key: string, code: string, mods = 0, text?: string) => stepsOf([{ type: "key", down: true, key, code, mods, ...(text ? { text } : {}) }])[0]!;
    for (const [k, c, m, t] of [[" ", "Space", 0, " "], ["Enter", "Enter", 0], ["ArrowDown", "ArrowDown", 0], ["ArrowUp", "ArrowUp", 0], ["ArrowDown", "ArrowDown", 1]] as const) assert.ok("keyPick" in key(k, c, m, t), `${k} ${m}`);
    for (const [k, c, m, t] of [["a", "KeyA", 0, "a"], ["ArrowDown", "ArrowDown", 2], ["ArrowUp", "ArrowUp", 1], ["Enter", "Enter", 8], ["ArrowLeft", "ArrowLeft", 0]] as const) assert.ok(!("keyPick" in key(k, c, m, t)), `${k} ${m}`);
  });
});

describe("browser: one picture at most waits for a connection", () => {
  test("a slow receiver gets the newest picture, never a backlog", () => {
    const sent: string[] = [];
    const callbacks: (() => void)[] = [];
    const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (text: string, cb: () => void) => (sent.push(text), callbacks.push(cb)) } as unknown as WebSocket;
    const slot = new FrameSlot(ws);
    for (let i = 1; i <= 50; i++) slot.push(`frame ${i}`);
    assert.deepEqual(sent, ["frame 1"]);
    assert.equal(slot.dropped, 48);
    assert.ok(slot.waiting <= "frame 50".length);
    callbacks.shift()!();
    assert.deepEqual(sent, ["frame 1", "frame 50"]);
    callbacks.shift()!();
    slot.push("frame 51");
    assert.deepEqual(sent, ["frame 1", "frame 50", "frame 51"]);
  });
});

describe("browser: the helper script", () => {
  test("carries the port and a one-time token in its first line, nothing from the engine's environment", () => {
    const s = helperScript({ port: 4242, token: "a".repeat(64), role: "watcher", spaceId: 9 });
    assert.ok(s.startsWith('const CONFIG = {"maxWidth":1600,"maxHeight":1200'));
    assert.match(s.split("\n")[0]!, /"port":4242,"token":"a{64}","role":"watcher","spaceId":9/);
    assert.ok(!s.includes("process.env"));
    assert.ok(!s.includes("page.events"), "never reads the page's shared event buffer");
    assert.ok(!/takeOverTaskSpace|claimTaskSpace|handOff\(/.test(s.split("\n").slice(1).join("\n")), "never takes a workspace over");
  });
});

// ---------------------------------------------------------------- the hub with the stand-in

describe("browser: availability", () => {
  test("missing: not available with one sentence; every call answers unavailable; nothing is started", async () => {
    const fb = new FakeBrowser();
    fb.installed = false;
    const w = world({ fb });
    assert.deepEqual(w.engine.snapshot().browser, { available: false, problem: "The browser the bots use is not installed on this computer.", spaces: [] });
    assert.equal((await w.hub.stateFor()).available, false);
    const conn = new Conn();
    for (const call of [() => w.hub.watch(conn, { spaceId: "10" }), () => w.hub.own({})]) {
      await assert.rejects(call(), (e: unknown) => e instanceof EngineError && e.code === "unavailable");
    }
    assert.equal(fb.spawns, 0);
    w.close();
  });

  test("switched off in the settings: not available", () => {
    const w = setup(undefined, undefined, undefined, { browser: null });
    assert.equal(w.engine.snapshot().browser.available, false);
    assert.equal(w.engine.snapshot().browser.problem, "The browser is switched off for Pobots in its settings.");
    w.engine.shutdown();
  });

  test("not running: available, nothing open, and the browser app is not started by looking", async () => {
    const fb = new FakeBrowser();
    fb.running = false;
    const w = world({ fb });
    assert.deepEqual(await w.hub.stateFor(), { available: true, spaces: [] });
    assert.equal(fb.spawns, 0);
    assert.deepEqual(w.engine.snapshot().browser, { available: true, spaces: [] });
    w.close();
  });

  test("running: the lister starts; workspace 0 and the person's own windows are never listed; another program's work is other", async () => {
    const fb = new FakeBrowser();
    const other = fb.addSpace("Codex research");
    const w = world({ fb });
    const state = await w.hub.stateFor();
    assert.equal(state.available, true);
    assert.deepEqual(
      state.spaces.map((s) => [s.id, s.owner, s.name]),
      [[String(other.id), "other", "Codex research"]],
    );
    assert.deepEqual(state.spaces[0]!.pages, [{ id: `recent-${other.id}-0`, title: "New Tab", url: "", active: true }], "an other workspace is never attached: only its titles");
    assert.ok(!fb.attached.includes(0) && !fb.attached.includes(3) && !fb.attached.includes(other.id), "nothing was attached");
    assert.ok(fb.scripts.every((s) => !s.includes("My research")));
    assert.deepEqual(w.engine.snapshot().browser, state);
    w.close();
  });

  test("cannot be reached: one plain sentence, every call unavailable, and no retry storm", async () => {
    const fb = new FakeBrowser();
    fb.unreachable = true;
    const w = world({ fb });
    const state = await w.hub.stateFor();
    assert.equal(state.available, false);
    assert.equal(state.problem, "The browser the bots use could not be reached. Open it on the computer, then try again.");
    const conn = new Conn();
    await assert.rejects(w.hub.watch(conn, { spaceId: "10" }), (e: unknown) => e instanceof EngineError && e.code === "unavailable");
    for (let i = 0; i < 10; i++) await w.hub.stateFor();
    assert.equal(fb.spawns, 1, "tried once, then not again until the pause is over");
    await new Promise((r) => setTimeout(r, (T.retryMs ?? 0) + 50));
    fb.unreachable = false;
    assert.equal((await w.hub.stateFor()).available, true, "comes back when it can be reached again");
    w.close();
  });

  test("the lister stops by itself when nothing is open and nobody watches", async () => {
    const w = world();
    await w.hub.stateFor();
    assert.equal(w.fb.live("lister").length, 1);
    await until(() => w.fb.live("lister").length === 0, 5000, "the lister to stop");
    assert.equal(w.fb.live().length, 0);
    w.close();
  });
});

describe("browser: whose workspace it is", () => {
  test("by name: the row arrives with the bot, the state lists it as the bot's, busy while the command runs", async () => {
    const w = world();
    const { bot, s } = await botInTurn(w);
    startCmd(w.sessions[0]!, "c1", browserCommand('const task = await taskSpace("Check the survey settings");\nawait task.page("p1").goto("https://example.com");'));
    const made = w.fb.addSpace("Check the survey settings");
    w.fb.navigate(made.id, "https://example.com/", "Example Domain");
    await until(() => browserItems(w.events).length === 1, 4000, "the row");
    const item = browserItems(w.events)[0]!;
    assert.equal(item.botId, bot.id);
    assert.equal(item.spaceId, String(made.id));
    assert.equal(item.name, "Check the survey settings");
    assert.equal(item.status, "open");
    assert.equal(item.threadId, w.engine.snapshot().bots[0]!.mainThreadId);
    assert.ok(item.turnId, "part of the turn's work");
    await until(() => !!lastStateOf(w.events)?.spaces.find((x) => x.id === String(made.id))?.busy, 2000, "busy");
    const space = lastStateOf(w.events)!.spaces.find((x) => x.id === String(made.id))!;
    assert.equal(space.owner, "bot");
    assert.equal(space.botId, bot.id);
    // The line of work reads in plain words, with the script as its detail.
    const act = upserts(w.events).filter((i) => i.kind === "activity").at(-1)!;
    assert.equal(act.kind === "activity" && act.label, "Working in the browser");
    endCmd(s, "c1");
    await until(() => lastStateOf(w.events)?.spaces.find((x) => x.id === String(made.id))?.busy === false, 2000, "not busy");
    const done = upserts(w.events).filter((i) => i.kind === "activity" && i.status === "done").at(-1)!;
    assert.equal(done.kind === "activity" && done.label, "Worked in the browser");
    assert.match(done.kind === "activity" ? done.detail ?? "" : "", /taskSpace\("Check the survey settings"\)/);
    // After the command, a peek reads its pages: the row's line gets the title and host.
    await until(() => browserItems(w.events)[0]!.last === "Example Domain · example.com", 3000, "the row's line");
    assert.equal(w.fb.live("peek").length, 0, "the peek ended");
    w.close();
  });

  test("the row stands before the line of work when the workspace is known at the start, and once per turn and workspace", async () => {
    const w = world();
    const existing = w.fb.addSpace("Inbox check");
    const { s } = await botInTurn(w);
    await w.hub.stateFor();
    startCmd(s, "c1", browserCommand(`const t = await taskSpace(${existing.id});`));
    endCmd(s, "c1");
    startCmd(s, "c2", browserCommand('const t = await taskSpace("Inbox check");'));
    endCmd(s, "c2");
    await settle();
    await until(() => browserItems(w.events).length === 1, 2000, "one row");
    const items = upserts(w.events);
    const rowAt = items.findIndex((i) => i.kind === "browser");
    const firstWork = items.findIndex((i) => i.kind === "activity");
    assert.ok(rowAt < firstWork, "the row comes first");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(browserItems(w.events).length, 1, "the second command in the same turn adds no row");
    // A new turn: a new row.
    s.reply("Done");
    await settle();
    w.engine.sendMessage({ botId: w.engine.snapshot().bots[0]!.id, text: "Again" });
    await settle();
    startCmd(s, "c3", browserCommand(`await taskSpace(${existing.id})`));
    endCmd(s, "c3");
    await until(() => browserItems(w.events).length === 2, 2000, "a second row in the next turn");
    w.close();
  });

  test("by a script file in the bot's folder or the temporary folder", async () => {
    const w = world();
    const { bot, s } = await botInTurn(w);
    const dir = join(w.dirs.botsDir, bot.id, "work");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "open.js"), 'const t = await taskSpace("From a file");\n');
    startCmd(s, "c1", "cd work && ego-browser nodejs < open.js");
    w.fb.addSpace("From a file");
    await until(() => browserItems(w.events).some((i) => i.name === "From a file"), 3000, "a row from the file's name");
    endCmd(s, "c1");
    // A file outside the bot's folder and the temporary folders is not read: compared before and after instead.
    const outside = tempDir();
    writeFileSync(join(outside, "x.js"), 'await taskSpace("Not read");');
    w.fb.addSpace("Not read");
    await w.hub.stateFor();
    w.close();
  });

  test("by the list before and after, when the script names nothing", async () => {
    const w = world();
    const { bot, s } = await botInTurn(w);
    await w.hub.stateFor();
    startCmd(s, "c1", "ego-browser nodejs < /nowhere/hidden.js");
    await new Promise((r) => setTimeout(r, 100));
    const made = w.fb.addSpace("Made without a name in the command");
    endCmd(s, "c1");
    await until(() => lastStateOf(w.events)?.spaces.find((x) => x.id === String(made.id))?.owner === "bot", 3000, "owner by before and after");
    assert.equal(lastStateOf(w.events)!.spaces.find((x) => x.id === String(made.id))!.botId, bot.id);
    assert.equal(browserItems(w.events).length, 1);
    w.close();
  });

  test("two bots at once, neither naming its workspace: no owner beats a wrong one", async () => {
    const w = world();
    const a = await botInTurn(w, "Po");
    const b = await botInTurn(w, "Kaja");
    await w.hub.stateFor();
    startCmd(a.s, "a1", "ego-browser nodejs < /nowhere/a.js");
    startCmd(b.s, "b1", "ego-browser nodejs < /nowhere/b.js");
    await new Promise((r) => setTimeout(r, 100));
    const x = w.fb.addSpace("One of them");
    endCmd(a.s, "a1");
    endCmd(b.s, "b1");
    await new Promise((r) => setTimeout(r, 400));
    const space = (await w.hub.stateFor()).spaces.find((s) => s.id === String(x.id))!;
    assert.equal(space.owner, "other");
    assert.equal(browserItems(w.events).length, 0);
    // But two bots that name their workspaces get their own, even at the same moment.
    startCmd(a.s, "a2", browserCommand('await taskSpace("Po work")'));
    startCmd(b.s, "b2", browserCommand('await taskSpace("Kaja work")'));
    w.fb.addSpace("Kaja work");
    w.fb.addSpace("Po work");
    await until(() => browserItems(w.events).length === 2, 3000, "two rows");
    const items = browserItems(w.events);
    assert.equal(items.find((i) => i.name === "Po work")!.botId, a.bot.id);
    assert.equal(items.find((i) => i.name === "Kaja work")!.botId, b.bot.id);
    w.close();
  });

  test("a helper's browser work goes into the bot's thread where the helper's row stands", async () => {
    const w = world();
    const { bot, s } = await botInTurn(w);
    s.helperStart("h1", { description: "Look at the page" });
    await settle();
    startCmd(s, "hc1", browserCommand('await taskSpace("Helper page")'), "h1");
    w.fb.addSpace("Helper page");
    await until(() => browserItems(w.events).length === 1, 3000, "the helper's row");
    const item = browserItems(w.events)[0]!;
    const helperRow = upserts(w.events).find((i) => i.kind === "helper")!;
    assert.equal(item.threadId, helperRow.threadId, "beside the helper's row, not in the helper's own thread");
    assert.equal(item.botId, bot.id);
    endCmd(s, "hc1", "h1");
    w.close();
  });

  test("closed when the workspace is gone; the owner is dropped; after a restart a gone workspace's row is closed", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const fb = new FakeBrowser();
    let w = world({ fb, dirs });
    const { s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Short visit")'));
    const one = fb.addSpace("Short visit");
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    startCmd(s, "c2", browserCommand('await taskSpace("Left open")'));
    const two = fb.addSpace("Left open");
    await until(() => browserItems(w.events).length === 2, 3000, "second row");
    endCmd(s, "c2");
    fb.close(one.id);
    await until(() => browserItems(w.events).find((i) => i.name === "Short visit")!.status === "closed", 3000, "closed");
    const closed = browserItems(w.events).find((i) => i.name === "Short visit")!;
    assert.ok(closed.endedAt);
    assert.ok(closed.last !== undefined || closed.last === undefined);
    w.close();
    // The engine restarts; the other workspace went away meanwhile.
    fb.close(two.id);
    w = world({ fb, dirs });
    assert.equal(w.store.openBrowserItems().length, 1, "still open until the browser says otherwise");
    await w.hub.stateFor();
    await until(() => w.store.openBrowserItems().length === 0, 3000, "closed after the restart");
    assert.equal(w.store.listBrowserSpaces().length, 0);
    w.close();
  });

  test("a bot's idle workspace whose title keeps changing is read again only now and then", async () => {
    const fb = new FakeBrowser();
    const w = setup(undefined, undefined, undefined, { browser: fb.driver(), browserTimings: { ...T, titlePeekMs: 1000 } });
    worlds.push(w);
    const bot = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: bot.id, text: "Go" });
    await settle();
    const s = w.sessions[0]!;
    startCmd(s, "c1", browserCommand('await taskSpace("Inbox")'));
    const sp = fb.addSpace("Inbox", "agent", [fb.tab("(1) Inbox", "https://mail.example.com/", "p1")]);
    await until(() => w.store.listBrowserSpaces().length === 1, 3000, "owned");
    endCmd(s, "c1");
    await until(() => fb.runs.filter((r) => r.role === "peek").length >= 1 && fb.live("peek").length === 0, 3000, "the peek after the command");
    const peeksBefore = fb.runs.filter((r) => r.role === "peek").length;
    let n = 1;
    const ticker = setInterval(() => (sp.tabs[0]!.title = `(${++n}) Inbox`), 30);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(ticker);
    const peeks = fb.runs.filter((r) => r.role === "peek").length - peeksBefore;
    assert.ok(peeks <= 2, `${peeks} peeks in 1.5 s`);
    w.engine.shutdown();
  });

  test("a workspace stays the bot's across an engine restart (the table)", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const fb = new FakeBrowser();
    let w = world({ fb, dirs });
    const { bot, s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Kept")'));
    const kept = fb.addSpace("Kept");
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    w.close();
    w = world({ fb, dirs });
    const space = (await w.hub.stateFor()).spaces.find((x) => x.id === String(kept.id))!;
    assert.equal(space.owner, "bot");
    assert.equal(space.botId, bot.id);
    w.close();
  });
});

describe("browser: watching", () => {
  async function watched() {
    const w = world();
    const { bot, s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Watched")'));
    const sp = w.fb.addSpace("Watched", "agent", [w.fb.tab("Example Domain", "https://example.com/", "p1", true)]);
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    await settle();
    return { w, bot, s, sp };
  }

  test("the first picture at once, the page's own size; one sharp picture once it stands still; later pictures only when the page changed", async () => {
    const { w, sp } = await watched();
    const conn = new Conn();
    const tab = sp.tabs[0]!;
    tab.w = 2000;
    tab.h = 1400;
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    assert.equal(r.pageId, tab.targetId);
    assert.equal(r.width, 2000);
    assert.equal(r.height, 1400);
    await until(() => conn.frames.length >= 1, 2000, "the first picture");
    const f = conn.frames[0]!;
    assert.equal(f.watchId, r.watchId);
    assert.equal(f.data, fakeFrame(sp.id, tab.targetId, tab.frame));
    assert.deepEqual([f.width, f.height, f.pageId, f.url, f.title, f.seq], [2000, 1400, tab.targetId, "https://example.com/", "Example Domain", 1]);
    // The script asks for at most 1600 by 1200.
    const shot = w.fb.calls.find((c) => c.method === "Page.captureScreenshot")!;
    assert.equal((shot.params.clip as { scale: number }).scale, Math.min(1600 / 2000, 1200 / 1400));
    assert.equal(f.type, undefined, "a JPEG while it may change");
    // Step 2g, third round: a page that stands still gets one more picture, of the best quality.
    await until(() => conn.frames.length >= 2, 2000, "the sharp picture");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(conn.frames.length, 2, "a still page: no more pictures after the sharp one");
    assert.equal(conn.frames[1]!.type, "image/png");
    assert.equal(conn.frames[1]!.width, 2000, "the page's own size, as before");
    w.fb.navigate(sp.id, "https://example.org/", "Example Org");
    await until(() => conn.frames.length === 3, 2000, "a picture after the change");
    assert.equal(conn.frames[2]!.seq, 3);
    assert.equal(conn.frames[2]!.type, undefined);
    assert.ok(w.fb.attached.includes(sp.id), "the watcher attached to this workspace");
    w.close();
  });

  test("follow the front page (a page that opens is followed); a page asked for comes to the front and is followed from there; a page that closes: the watch goes on with the front page", async () => {
    const { w, sp } = await watched();
    const front = new Conn();
    const asked = new Conn();
    const first = sp.tabs[0]!;
    const second = w.fb.tab("Second", "https://example.org/2", "p2", false);
    w.fb.space(sp.id)!.tabs.push(second);
    await w.hub.watch(front, { spaceId: String(sp.id) });
    // Step 2g, third round: any look at a page makes it the page in front in this browser, so a
    // watch that asks for a page brings it to the front once and follows the front from then on
    // (a watch that stayed on a page behind would fight the bot over the front page).
    const r2 = await w.hub.watch(asked, { spaceId: String(sp.id), pageId: second.targetId });
    assert.equal(r2.pageId, second.targetId);
    assert.ok(second.active && !first.active, "brought to the front");
    assert.equal(w.fb.live("watcher").length, 1, "one watcher for the workspace, shared");
    await until(() => front.frames.at(-1)?.pageId === second.targetId, 2000, "the front watcher follows too");
    const popup = w.fb.openPage(sp.id, "Popup", "https://example.net/");
    await until(() => front.frames.some((f) => f.pageId === popup.targetId) && asked.frames.some((f) => f.pageId === popup.targetId), 2000, "both follow the page that opened");
    w.fb.closePage(sp.id, popup.targetId);
    await until(() => front.frames.at(-1)!.pageId === first.targetId, 2000, "back to the first page");
    w.fb.closePage(sp.id, first.targetId);
    w.fb.closePage(sp.id, second.targetId);
    const third = w.fb.tab("Third", "https://example.com/3", "p3", true);
    w.fb.space(sp.id)!.tabs.push(third);
    // With a row of pages, the watch is not over while the workspace is open.
    await until(() => asked.frames.at(-1)?.pageId === third.targetId && front.frames.at(-1)?.pageId === third.targetId, 2000, "both go on with the front page");
    assert.equal(asked.endings.length, 0);
    assert.equal(front.endings.length, 0);
    w.close();
  });

  test("two watchers of one page share one picture source", async () => {
    const { w, sp } = await watched();
    const a = new Conn();
    const b = new Conn();
    await w.hub.watch(a, { spaceId: String(sp.id) });
    await w.hub.watch(b, { spaceId: String(sp.id) });
    await until(() => a.frames.length >= 1 && b.frames.length >= 1, 2000, "pictures for both");
    const before = w.fb.shots(sp.tabs[0]!.targetId);
    w.fb.navigate(sp.id, "https://example.org/", "Org");
    await until(() => a.frames.length >= 2 && b.frames.length >= 2, 2000, "both get the change");
    assert.ok(w.fb.shots(sp.tabs[0]!.targetId) - before <= 3, "one picture taken for both");
    assert.equal(w.fb.live("watcher").length, 1);
    w.close();
  });

  test("the workspace gone ends the watch; a new watch on the same connection replaces the old; the connection's end stops the watcher", async () => {
    const { w, sp } = await watched();
    const conn = new Conn();
    const r1 = await w.hub.watch(conn, { spaceId: String(sp.id) });
    const other = w.fb.addSpace("Codex work", "agent", [w.fb.tab("Other", "https://example.org/", "p1")]);
    await w.hub.stateFor();
    await until(() => !!lastStateOf(w.events)?.spaces.some((x) => x.id === String(other.id)), 2000, "listed");
    const r2 = await w.hub.watch(conn, { spaceId: String(other.id) });
    assert.deepEqual(conn.endings, [{ watchId: r1.watchId, reason: "replaced" }]);
    w.fb.close(other.id);
    await until(() => conn.endings.length === 2, 3000, "ended when closed");
    assert.deepEqual(conn.endings[1], { watchId: r2.watchId, reason: "closed" });
    const c2 = new Conn();
    await w.hub.watch(c2, { spaceId: String(sp.id) });
    await until(() => w.fb.live("watcher").length === 1, 2000, "one watcher left");
    w.hub.dropConn(c2);
    await until(() => w.fb.live("watcher").length === 0, 2000, "the watcher stops with the connection");
    w.close();
  });

  test("unknown workspace or page: not_found; workspace 0 and the person's own are never watched; a handed-over one is unavailable", async () => {
    const { w, sp } = await watched();
    const conn = new Conn();
    for (const id of ["0", "3", "999"]) await assert.rejects(w.hub.watch(conn, { spaceId: id }), (e: unknown) => e instanceof EngineError && e.code === "not_found", id);
    await assert.rejects(w.hub.watch(conn, { spaceId: String(sp.id), pageId: "T-none" }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.ok(!w.fb.attached.includes(0) && !w.fb.attached.includes(3));
    w.fb.space(sp.id)!.ownership = "agentDelegatedToUser";
    await until(() => w.fb.live("lister").length === 1, 1000, "lister");
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(w.hub.watch(conn, { spaceId: String(sp.id) }), (e: unknown) => e instanceof EngineError && e.code === "unavailable" && /handed over/.test(e.message));
    w.close();
  });

  test("a watched workspace handed over in the browser ends the watch as gone", async () => {
    const { w, sp } = await watched();
    const conn = new Conn();
    await w.hub.watch(conn, { spaceId: String(sp.id) });
    w.fb.space(sp.id)!.ownership = "agentDelegatedToUser";
    await until(() => conn.endings.length === 1, 3000, "ended");
    assert.equal(conn.endings[0]!.reason, "gone");
    w.close();
  });

  test("the helper dying while someone watches: brought back, and the pictures carry on", async () => {
    const { w, sp } = await watched();
    const conn = new Conn();
    await w.hub.watch(conn, { spaceId: String(sp.id) });
    await until(() => conn.frames.length >= 1, 2000, "first picture");
    assert.equal(w.fb.kill("watcher"), 1);
    await until(() => w.fb.live("watcher").length === 1 && w.fb.runs.filter((r) => r.role === "watcher").length === 2, 3000, "a new watcher");
    const n = conn.frames.length;
    w.fb.navigate(sp.id, "https://example.org/", "After");
    await until(() => conn.frames.length > n, 3000, "pictures again");
    assert.equal(conn.endings.length, 0);
    // The lister dying while needed is brought back too.
    w.fb.kill("lister");
    await until(() => w.fb.live("lister").length === 1 && w.fb.runs.filter((r) => r.role === "lister").length >= 2, 3000, "a new lister");
    w.close();
  });

  test("watching does not change the workspace or its pages, and nothing about it lands in the chat or the database", async () => {
    const { w, sp } = await watched();
    const before = JSON.stringify(w.fb.space(sp.id));
    const itemsBefore = new Set(upserts(w.events).map((i) => i.id));
    const conn = new Conn();
    await w.hub.watch(conn, { spaceId: String(sp.id) });
    await until(() => conn.frames.length >= 1, 2000, "picture");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(JSON.stringify(w.fb.space(sp.id)), before);
    assert.deepEqual(upserts(w.events).filter((i) => !itemsBefore.has(i.id)), [], "no new item");
    assert.ok(!w.fb.calls.some((c) => c.method.startsWith("Input.") || c.method === "goto"), "no input, no move");
    const frame = conn.frames[0]!.data;
    const db = JSON.stringify(w.store.readThread(w.engine.snapshot().bots[0]!.mainThreadId, undefined, 500));
    assert.ok(!db.includes(frame), "a picture is never stored");
    w.close();
  });
});

describe("browser: stepping in", () => {
  async function controlled() {
    const w = world();
    const { s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Form")'));
    const sp = w.fb.addSpace("Form", "agent", [w.fb.tab("Form", "https://example.com/form", "p1", true)]);
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    return { w, sp, conn, r, tab: sp.tabs[0]! };
  }

  test("input and moves are refused without control, and reach the page in order with it; the state says controlled", async () => {
    const { w, conn, r, tab, sp } = await controlled();
    await assert.rejects(w.hub.input(conn, r.watchId, [{ type: "text", text: "x" }]), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    await assert.rejects(w.hub.go(conn, r.watchId, { url: "example.org" }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    await assert.rejects(w.hub.selection(conn, r.watchId), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    assert.deepEqual(w.hub.control(conn, r.watchId, true), { controlled: true });
    await until(() => !!lastStateOf(w.events)?.spaces.find((x) => x.id === String(sp.id))?.controlled, 1000, "controlled in the state");
    await w.hub.input(conn, r.watchId, [
      { type: "down", x: 40, y: 50, button: "left", clicks: 1 },
      { type: "up", x: 40, y: 50, button: "left", clicks: 1 },
      { type: "text", text: "åäö" },
      { type: "key", down: true, key: "a", code: "KeyA", mods: 2 },
    ]);
    const got = w.fb.inputs(tab.targetId).map((c) => [c.method, c.params.type ?? c.params.text]);
    assert.deepEqual(got, [
      ["Input.dispatchMouseEvent", "mousePressed"],
      ["Input.dispatchMouseEvent", "mouseReleased"],
      ["Input.insertText", "åäö"],
      ["Input.dispatchKeyEvent", "rawKeyDown"],
    ]);
    assert.equal(tab.typed, "åäö");
    // Nothing the person does becomes a line of work or a message to the bot.
    assert.ok(!upserts(w.events).some((i) => i.kind === "user" && i.text.includes("åäö")));
    // Handing back: refused again.
    w.hub.control(conn, r.watchId, false);
    await assert.rejects(w.hub.input(conn, r.watchId, [{ type: "text", text: "y" }]), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    w.close();
  });

  test("a field with the focus decides what Home does", async () => {
    const { w, conn, r, tab } = await controlled();
    w.hub.control(conn, r.watchId, true);
    tab.editable = true;
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: "Home", code: "Home" }]);
    tab.editable = false;
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: "Home", code: "Home" }]);
    const cmds = w.fb.inputs(tab.targetId).map((c) => c.params.commands);
    assert.deepEqual(cmds, [["moveToBeginningOfLine"], ["scrollToBeginningOfDocument"]]);
    w.close();
  });

  test("browser.go: an address there (a bare host gets https), back, forward, reload; anything else refused in one sentence", async () => {
    const { w, conn, r, tab } = await controlled();
    w.hub.control(conn, r.watchId, true);
    await w.hub.go(conn, r.watchId, { url: "example.org" });
    assert.equal(tab.url, "https://example.org/");
    await w.hub.go(conn, r.watchId, "back");
    assert.equal(tab.url, "https://example.org/");
    await w.hub.go(conn, r.watchId, "forward");
    assert.equal(tab.url, "https://example.net/");
    await w.hub.go(conn, r.watchId, "reload");
    assert.ok(w.fb.inputs(tab.targetId).some((c) => c.method === "Page.reload"));
    await assert.rejects(w.hub.go(conn, r.watchId, { url: "javascript:alert(1)" }), (e: unknown) => e instanceof EngineError && e.code === "bad_request" && e.message === "Only web addresses that start with http or https can be opened.");
    w.close();
  });

  test("browser.selection gives the selected text; after a cut, the text that was cut", async () => {
    const { w, conn, r, tab } = await controlled();
    w.hub.control(conn, r.watchId, true);
    tab.selection = "picked words";
    assert.deepEqual(await w.hub.selection(conn, r.watchId), { text: "picked words" });
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: "x", code: "KeyX", mods: 2 }]);
    tab.selection = "";
    assert.deepEqual(await w.hub.selection(conn, r.watchId), { text: "picked words" });
    assert.deepEqual(await w.hub.selection(conn, r.watchId), { text: "" });
    w.close();
  });

  test("a dialog: browser.prompt to every watcher (also one that starts later), never in a picture's title; Enter still accepts; gone when answered", async () => {
    const { w, conn, r, tab, sp } = await controlled();
    w.hub.control(conn, r.watchId, true);
    await until(() => conn.frames.length >= 1, 2000, "picture");
    const other = new Conn();
    const r2 = await w.hub.watch(other, { spaceId: String(sp.id) });
    tab.dialog = { type: "confirm", message: "Sure?" };
    tab.frame++;
    const ask = { kind: "dialog", type: "confirm", message: "Sure?" };
    await until(() => conn.prompts.length === 1 && other.prompts.length === 1, 2000, "the question to both");
    assert.deepEqual(conn.prompts[0], { watchId: r.watchId, prompt: ask });
    assert.deepEqual(other.prompts[0], { watchId: r2.watchId, prompt: ask });
    // A connection that starts watching while it waits hears it too.
    const late = new Conn();
    const r3 = await w.hub.watch(late, { spaceId: String(sp.id) });
    await until(() => late.prompts.length === 1, 1000, "the question to a late watcher");
    assert.deepEqual(late.prompts[0], { watchId: r3.watchId, prompt: ask });
    assert.ok(![...conn.frames, ...other.frames, ...late.frames].some((f) => /asks|says|Sure/.test(f.title)), "the question is not in a picture's title");
    const n = conn.frames.length;
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: "Enter", code: "Enter" }]);
    assert.ok(w.fb.inputs(tab.targetId).some((c) => c.method === "Page.handleJavaScriptDialog" && c.params.accept === true));
    assert.equal(tab.dialog, undefined);
    await until(() => conn.prompts.length === 2 && other.prompts.length === 2, 2000, "gone for both");
    assert.deepEqual(conn.prompts[1], { watchId: r.watchId });
    await until(() => conn.frames.length > n, 2000, "pictures again");
    w.close();
  });

  test("browser.answer for a dialog: accept with text for a prompt, dismiss; needs control; conflict when nothing asks; gone when the bot or the page answered", async () => {
    const { w, conn, r, tab } = await controlled();
    await until(() => conn.frames.length >= 1, 2000, "picture");
    tab.dialog = { type: "prompt", message: "Your name?", defaultPrompt: "Kim" };
    tab.frame++;
    await until(() => conn.prompts.length === 1, 2000, "the question");
    assert.deepEqual(conn.prompts[0]!.prompt, { kind: "dialog", type: "prompt", message: "Your name?", defaultText: "Kim" });
    await assert.rejects(w.hub.answer(conn, r.watchId, { kind: "dialog", accept: true }), (e: unknown) => e instanceof EngineError && e.code === "conflict" && e.message === "Take control first.");
    w.hub.control(conn, r.watchId, true);
    await assert.rejects(w.hub.answer(conn, r.watchId, { kind: "choices", index: 0 }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    await w.hub.answer(conn, r.watchId, { kind: "dialog", accept: true, text: "Alex" });
    const call = w.fb.inputs(tab.targetId).find((c) => c.method === "Page.handleJavaScriptDialog")!;
    assert.deepEqual(call.params, { accept: true, promptText: "Alex" });
    await until(() => conn.prompts.length === 2 && !conn.prompts[1]!.prompt, 2000, "gone");
    await assert.rejects(w.hub.answer(conn, r.watchId, { kind: "dialog", accept: true }), (e: unknown) => e instanceof EngineError && e.code === "conflict" && e.message === "Nothing on the page waits for an answer.");
    // Dismissed.
    tab.dialog = { type: "confirm", message: "Leave?" };
    tab.frame++;
    await until(() => conn.prompts.length === 3, 2000, "the next question");
    await w.hub.answer(conn, r.watchId, { kind: "dialog", accept: false });
    assert.deepEqual(w.fb.inputs(tab.targetId).filter((c) => c.method === "Page.handleJavaScriptDialog").at(-1)!.params, { accept: false });
    await until(() => conn.prompts.length === 4 && !conn.prompts[3]!.prompt, 2000, "gone again");
    // Answered elsewhere (the bot, or the page itself): gone too.
    tab.dialog = { type: "alert", message: "Saved" };
    tab.frame++;
    await until(() => conn.prompts.length === 5, 2000, "an alert");
    assert.deepEqual(conn.prompts[4]!.prompt, { kind: "dialog", type: "alert", message: "Saved" });
    tab.dialog = undefined;
    tab.frame++;
    await until(() => conn.prompts.length === 6 && !conn.prompts[5]!.prompt, 2000, "gone when answered elsewhere");
    w.close();
  });

  test("a drop-down list: a press on it shows its choices to every watcher instead of reaching the page; an answer chooses as a person would; none closes", async () => {
    const { w, conn, r, tab, sp } = await controlled();
    tab.select = { x: 20, y: 240, w: 150, h: 20, options: [{ label: "one" }, { label: "two", group: "More" }, { label: "three", group: "More" }, { label: "four", disabled: true }], index: 0, focused: false, heard: [] };
    const other = new Conn();
    const r2 = await w.hub.watch(other, { spaceId: String(sp.id) });
    w.hub.control(conn, r.watchId, true);
    // A press elsewhere reaches the page as before.
    await w.hub.input(conn, r.watchId, [{ type: "down", x: 400, y: 40, button: "left", clicks: 1 }, { type: "up", x: 400, y: 40, button: "left", clicks: 1 }]);
    assert.equal(w.fb.inputs(tab.targetId).filter((c) => c.method === "Input.dispatchMouseEvent").length, 2);
    assert.equal(conn.prompts.length, 0);
    await w.hub.input(conn, r.watchId, [{ type: "move", x: 90, y: 248 }, { type: "down", x: 90, y: 248, button: "left", clicks: 1 }, { type: "up", x: 90, y: 248, button: "left", clicks: 1 }]);
    const choices = {
      kind: "choices",
      x: 20,
      y: 240,
      width: 150,
      height: 20,
      options: [
        { label: "one", selected: true, disabled: false },
        { label: "two", selected: false, disabled: false, group: "More" },
        { label: "three", selected: false, disabled: false, group: "More" },
        { label: "four", selected: false, disabled: true },
      ],
    };
    await until(() => conn.prompts.length === 1 && other.prompts.length === 1, 2000, "the choices to both");
    assert.deepEqual(conn.prompts[0], { watchId: r.watchId, prompt: choices });
    assert.deepEqual(other.prompts[0], { watchId: r2.watchId, prompt: choices });
    const presses = w.fb.inputs(tab.targetId).filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type !== "mouseMoved");
    assert.equal(presses.length, 2, "neither the press nor its release reached the page");
    assert.ok(tab.select.focused, "the list has the focus");
    // While they are open nothing else reaches the page.
    await w.hub.input(conn, r.watchId, [{ type: "text", text: "x" }]);
    assert.equal(tab.typed, "");
    // A disabled option is not chosen; the choices still close.
    await w.hub.answer(conn, r.watchId, { kind: "choices", index: 3 });
    assert.equal(tab.select.index, 0);
    await until(() => conn.prompts.length === 2 && other.prompts.length === 2, 2000, "closed for both");
    assert.deepEqual(conn.prompts[1], { watchId: r.watchId });
    await assert.rejects(w.hub.answer(conn, r.watchId, { kind: "choices", index: 1 }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    // Down with the focus on the list opens them again; an index chooses, and the page hears input and change.
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: "ArrowDown", code: "ArrowDown" }, { type: "key", down: false, key: "ArrowDown", code: "ArrowDown" }]);
    await until(() => conn.prompts.length === 3, 2000, "choices by keyboard");
    assert.ok(!w.fb.inputs(tab.targetId).some((c) => c.params.key === "ArrowDown" && c.params.type !== "keyUp"), "the key was not passed on");
    await w.hub.answer(conn, r.watchId, { kind: "choices", index: 2 });
    assert.equal(tab.select.index, 2);
    assert.deepEqual(tab.select.heard, ["input", "change"]);
    await until(() => conn.prompts.length === 4 && !conn.prompts[3]!.prompt, 2000, "closed");
    // Without an index the choices just close.
    await w.hub.input(conn, r.watchId, [{ type: "key", down: true, key: " ", code: "Space", text: " " }]);
    await until(() => conn.prompts.length === 5, 2000, "choices by Space");
    assert.equal(tab.typed, "");
    await w.hub.answer(conn, r.watchId, { kind: "choices" });
    assert.equal(tab.select.index, 2);
    await until(() => conn.prompts.length === 6 && !conn.prompts[5]!.prompt, 2000, "closed without a choice");
    w.close();
  });

  test("open choices close when control is handed back, when the watch ends, and when the page moves; a later watcher hears open ones", async () => {
    const { w, conn, r, tab, sp } = await controlled();
    tab.select = { x: 0, y: 0, w: 100, h: 20, options: [{ label: "a" }, { label: "b" }], index: 0, focused: false, heard: [] };
    w.hub.control(conn, r.watchId, true);
    const open = async (n: number) => {
      await w.hub.input(conn, r.watchId, [{ type: "down", x: 5, y: 5, button: "left", clicks: 1 }, { type: "up", x: 5, y: 5, button: "left", clicks: 1 }]);
      await until(() => conn.prompts.length === n, 2000, `choices ${n}`);
    };
    await open(1);
    const late = new Conn();
    const rl = await w.hub.watch(late, { spaceId: String(sp.id) });
    await until(() => late.prompts.length === 1, 1000, "open choices to a later watcher");
    assert.equal(late.prompts[0]!.watchId, rl.watchId);
    w.hub.control(conn, r.watchId, false);
    await until(() => conn.prompts.length === 2 && !conn.prompts[1]!.prompt && late.prompts.length === 2, 2000, "closed on hand back");
    w.hub.control(conn, r.watchId, true);
    await open(3);
    w.fb.navigate(sp.id, "https://example.org/", "Elsewhere", tab.targetId);
    await until(() => conn.prompts.length === 4 && !conn.prompts[3]!.prompt, 2000, "closed when the page moved");
    await open(5);
    w.hub.unwatch(conn, r.watchId);
    await until(() => late.prompts.length >= 4 && !late.prompts.at(-1)!.prompt, 2000, "closed when the controlling watch ended");
    w.close();
  });

  test("the address: a picture goes again when the page's address or title changed, also when it looks the same", async () => {
    const { w, conn, r, tab } = await controlled();
    await until(() => conn.frames.length >= 1, 2000, "picture");
    await new Promise((res) => setTimeout(res, 150));
    const n = conn.frames.length;
    // The address and title change; the picture does not (the page list is read after the picture).
    tab.url = "https://example.org/next";
    tab.title = "Next";
    await until(() => conn.frames.length > n, 2000, "a picture with the new address");
    assert.deepEqual([conn.frames.at(-1)!.url, conn.frames.at(-1)!.title], ["https://example.org/next", "Next"]);
    assert.equal(conn.frames.at(-1)!.data, conn.frames.slice(0, n).filter((f) => !f.type).at(-1)!.data, "the same picture, with the new address");
    assert.ok(r.watchId);
    w.close();
  });

  test("control ends with the watch", async () => {
    const { w, conn, r, sp } = await controlled();
    w.hub.control(conn, r.watchId, true);
    w.hub.unwatch(conn, r.watchId);
    await until(() => lastStateOf(w.events)?.spaces.find((x) => x.id === String(sp.id))?.controlled === false, 1000, "not controlled");
    await assert.rejects(w.hub.input(conn, r.watchId, [{ type: "text", text: "x" }]), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    w.close();
  });
});

describe("browser: the person's own workspace", () => {
  test("browser.own makes it when missing, named Your page in the state and something no bot would pick in the browser; with url its front page goes there; close closes it", async () => {
    const w = world();
    const { space } = await w.hub.own({ url: "example.com" });
    assert.equal(space.owner, "you");
    assert.equal(space.name, "Your page");
    assert.equal(space.botId, undefined);
    const inBrowser = w.fb.space(Number(space.id))!;
    assert.match(inBrowser.name, /^Pobots: your page [0-9a-f]{8}$/);
    assert.equal(inBrowser.name, w.hub.ownSpaceName);
    await until(() => inBrowser.tabs.some((t) => t.url === "https://example.com/"), 2000, "moved there");
    // Asked again: the same workspace, moved.
    const again = await w.hub.own({ url: "https://example.org/" });
    assert.equal(again.space.id, space.id);
    assert.equal(w.fb.spaces.filter((s) => s.name === inBrowser.name).length, 1);
    await assert.rejects(w.hub.own({ url: "file:///etc/hosts" }), (e: unknown) => e instanceof EngineError && e.code === "bad_request");
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: space.id });
    await w.hub.close({ spaceId: space.id });
    assert.equal(w.fb.space(Number(space.id)), undefined);
    assert.deepEqual(conn.endings, [{ watchId: r.watchId, reason: "closed" }]);
    w.close();
  });

  test("browser.close of a bot's or another's workspace: conflict; a bot naming the person's workspace is never tied to it", async () => {
    const w = world();
    const { space } = await w.hub.own({});
    const { s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand(`await taskSpace(${JSON.stringify(w.hub.ownSpaceName)})`));
    startCmd(s, "c2", browserCommand('await taskSpace("Bot place")'));
    const bp = w.fb.addSpace("Bot place");
    await until(() => browserItems(w.events).length === 1, 3000, "one row");
    endCmd(s, "c1");
    endCmd(s, "c2");
    assert.equal(browserItems(w.events)[0]!.name, "Bot place");
    assert.equal((await w.hub.stateFor()).spaces.find((x) => x.id === space.id)!.owner, "you");
    await assert.rejects(w.hub.close({ spaceId: String(bp.id) }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    await assert.rejects(w.hub.close({ spaceId: "0" }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    assert.ok(w.fb.space(bp.id));
    w.close();
  });

  test("the order: the bots' workspaces first in roster order, then the person's own, then others", async () => {
    const w = world();
    w.fb.addSpace("Someone else");
    const a = await botInTurn(w, "Po");
    const b = await botInTurn(w, "Kaja");
    await w.hub.own({});
    startCmd(b.s, "b1", browserCommand('await taskSpace("Kaja place")'));
    w.fb.addSpace("Kaja place");
    startCmd(a.s, "a1", browserCommand('await taskSpace("Po place")'));
    w.fb.addSpace("Po place");
    await until(() => browserItems(w.events).length === 2, 3000, "rows");
    const st = await w.hub.stateFor();
    assert.deepEqual(st.spaces.map((x) => x.name), ["Po place", "Kaja place", "Your page", "Someone else"]);
    w.close();
  });
});

describe("browser: over the socket", () => {
  async function serverWorld() {
    const w = world();
    const server = new EngineServer("tok-123456789012345", {});
    server.attach(w.engine);
    const port = await server.listen(0);
    return { ...w, server, port, closeAll: async () => (w.close(), await server.close()) };
  }

  function client(port: number, origin?: string, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${origin ? "" : "tok-123456789012345"}`, { origin, headers });
    const events: { event: string; data: unknown }[] = [];
    const waiting = new Map<string, (f: { ok: boolean; result?: unknown; error?: { code: string } }) => void>();
    let n = 0;
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.t === "evt") events.push(f);
      else waiting.get(f.id)?.(f);
    });
    const call = (method: string, params: unknown = {}) =>
      new Promise<{ ok: boolean; result?: unknown; error?: { code: string } }>((res) => {
        const id = String(++n);
        waiting.set(id, res);
        ws.send(JSON.stringify({ t: "req", id, method, params }));
      });
    const open = new Promise<boolean>((res) => {
      ws.on("open", () => res(true));
      ws.on("unexpected-response", () => res(false));
      ws.on("error", () => res(false));
    });
    return { ws, events, call, open };
  }

  test("state, watch and pictures as events for the watching connection only; browser calls need hello", async () => {
    const w = await serverWorld();
    const sp = w.fb.addSpace("Over the socket", "agent", [w.fb.tab("Example", "https://example.com/", "p1")]);
    const { bot, s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Over the socket")'));
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    void bot;
    const a = client(w.port);
    const b = client(w.port);
    assert.ok(await a.open);
    assert.ok(await b.open);
    const before = await a.call("browser.state");
    assert.equal(before.ok, false, "hello first");
    for (const c of [a, b]) assert.ok((await c.call("hello", { protocol: PROTOCOL_VERSION, client: "test" })).ok);
    const st = await a.call("browser.state");
    assert.ok(st.ok);
    assert.ok((st.result as BrowserState).spaces.some((x) => x.id === String(sp.id)));
    const watch = await a.call("browser.watch", { spaceId: String(sp.id) });
    assert.ok(watch.ok, JSON.stringify(watch));
    await until(() => a.events.some((e) => e.event === "browser.frame"), 3000, "a picture event");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!b.events.some((e) => e.event === "browser.frame"), "the other connection gets no pictures");
    const bad = await b.call("browser.input", { watchId: (watch.result as { watchId: string }).watchId, events: [{ type: "text", text: "x" }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.error!.code, "not_found", "another connection cannot use the watch");
    const noControl = await a.call("browser.input", { watchId: (watch.result as { watchId: string }).watchId, events: [{ type: "text", text: "x" }] });
    assert.equal(noControl.error!.code, "conflict");
    a.ws.close();
    await until(() => w.fb.live("watcher").length === 0, 3000, "the watcher stops when the connection goes");
    b.ws.close();
    await w.closeAll();
  });

  test("a sealed frame (Origin null) cannot open the socket, so it reaches no browser call, with or without a Tailscale identity", async () => {
    const w = world();
    const server = new EngineServer("tok-123456789012345", { allowedLogins: ["someone@example.com"] });
    server.attach(w.engine);
    const port = await server.listen(0);
    const tries: Record<string, string>[] = [{}, { "tailscale-user-login": "someone@example.com", host: `127.0.0.1:${port}` }];
    for (const headers of tries) {
      const c = client(port, "null", headers);
      assert.equal(await c.open, false);
    }
    assert.equal(w.fb.spawns, 0);
    w.close();
    await server.close();
  });

  test("a slow receiver: the engine holds at most one picture for it, and memory stays flat", async () => {
    const w = await serverWorld();
    const tab = w.fb.tab("Fast", "https://example.com/", "p1");
    tab.pad = 200_000;
    const sp = w.fb.addSpace("Fast page", "agent", [tab]);
    const { s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand('await taskSpace("Fast page")'));
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    const a = client(w.port);
    assert.ok(await a.open);
    await a.call("hello", { protocol: PROTOCOL_VERSION, client: "test" });
    const watch = await a.call("browser.watch", { spaceId: String(sp.id) });
    assert.ok(watch.ok);
    await until(() => a.events.some((e) => e.event === "browser.frame"), 3000, "a picture");
    // The page changes all the time; the receiver stops reading.
    const ticker = setInterval(() => w.fb.navigate(sp.id, "https://example.com/", "Fast"), 5);
    const sock = (a.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    sock.pause();
    const frameBytes = 300_000;
    const samples: { waiting: number; heap: number }[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const b = w.server.pictureBacklog();
      samples.push({ waiting: Math.max(0, ...b.map((x) => x.waiting)), heap: process.memoryUsage().heapUsed });
    }
    const dropped = Math.max(...w.server.pictureBacklog().map((x) => x.dropped));
    clearInterval(ticker);
    sock.resume();
    const maxWaiting = Math.max(...samples.map((x) => x.waiting));
    assert.ok(maxWaiting <= 3 * frameBytes, `backlog ${maxWaiting} bytes`);
    assert.ok(dropped > 0, "older pictures were dropped");
    const firstHeap = samples.slice(0, 5).reduce((n, x) => n + x.heap, 0) / 5;
    const lastHeap = samples.slice(-5).reduce((n, x) => n + x.heap, 0) / 5;
    assert.ok(lastHeap - firstHeap < 40 * 1024 * 1024, `heap grew ${Math.round((lastHeap - firstHeap) / 1024 / 1024)} MB`);
    a.ws.close();
    await w.closeAll();
  });
});

// ---------------------------------------------------------------- step 2g, third round

describe("browser: tabs and sharper pictures (step 2g, third round)", () => {
  async function botSpace(name: string, tabs?: (fb: FakeBrowser) => FakeTab[]) {
    const w = world();
    const { s } = await botInTurn(w);
    startCmd(s, "c1", browserCommand(`await taskSpace(${JSON.stringify(name)})`));
    const sp = w.fb.addSpace(name, "agent", tabs ? tabs(w.fb) : [w.fb.tab("Example Domain", "https://example.com/", "p1", true)]);
    await until(() => browserItems(w.events).length === 1, 3000, "row");
    endCmd(s, "c1");
    await settle();
    return { w, sp };
  }
  const shotsOf = (w: ReturnType<typeof world>, targetId: string) => w.fb.calls.filter((c) => c.page === targetId && c.method === "Page.captureScreenshot");
  const scaleOf = (c: { params: Record<string, unknown> }) => (c.params.clip as { scale: number }).scale;
  const text = (f: Events["browser.frame"]) => Buffer.from(f.data, "base64").toString();
  const two = (fb: FakeBrowser) => [fb.tab("One", "https://example.com/1", "p1", true), fb.tab("Two", "https://example.com/2", "p2", false)];
  const isCode = (code: string) => (e: unknown) => e instanceof EngineError && e.code === code;

  test("ratio: light pictures never above the page's own size; the sharp one at the viewer's size, within 0.25 and 2; browser.view changes it; the largest of several watchers", async () => {
    const { w, sp } = await botSpace("Sharp");
    const tab = sp.tabs[0]!;
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id), ratio: 1.5 });
    await until(() => conn.frames.some((f) => f.type === "image/png"), 2000, "the sharp picture");
    const light = shotsOf(w, tab.targetId).filter((c) => c.params.format === "jpeg");
    assert.ok(light.length >= 1 && light.every((c) => scaleOf(c) === 1 && c.params.quality === 60), "light pictures: JPEG at quality 60, the page's own size");
    const sharp = conn.frames.find((f) => f.type === "image/png")!;
    assert.equal(text(sharp), `png ${sp.id} ${tab.targetId} ${tab.frame} 1.5`);
    assert.deepEqual([sharp.width, sharp.height], [1000, 700], "width and height stay the page's own size");
    // A smaller panel: a light picture at that size, then a sharp one.
    let n = conn.frames.length;
    w.hub.view(conn, r.watchId, 0.5);
    await until(() => conn.frames.slice(n).some((f) => f.type === "image/png" && text(f).endsWith(" 0.5")), 2000, "a sharp picture at 0.5");
    assert.ok(conn.frames.slice(n).some((f) => !f.type && text(f).endsWith(" 0.5")), "a light picture at 0.5 first");
    // The limits.
    n = conn.frames.length;
    w.hub.view(conn, r.watchId, 9);
    await until(() => conn.frames.slice(n).some((f) => f.type === "image/png" && text(f).endsWith(" 2")), 2000, "at most 2");
    n = conn.frames.length;
    w.hub.view(conn, r.watchId, 0.01);
    await until(() => conn.frames.slice(n).some((f) => f.type === "image/png" && text(f).endsWith(" 0.25")), 2000, "at least 0.25");
    // A second watcher of the same page asks for more: both get the larger.
    const b = new Conn();
    await w.hub.watch(b, { spaceId: String(sp.id), ratio: 1.6 });
    w.hub.view(conn, r.watchId, 0.8);
    await until(() => b.frames.some((f) => f.type === "image/png" && text(f).endsWith(" 1.6")) && conn.frames.some((f) => f.type === "image/png" && text(f).endsWith(" 1.6")), 2000, "the largest asked for");
    // Still: no more pictures after the sharp one.
    await new Promise((res) => setTimeout(res, 300));
    const still = conn.frames.length;
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(conn.frames.length, still, "a still page gets one sharp picture, then nothing");
    w.close();
  });

  test("a sharp picture that would be a large PNG is taken as WebP; the frame names its type; a very large page is kept within 3200 by 2400", async () => {
    const { w, sp } = await botSpace("Photos");
    const tab = sp.tabs[0]!;
    tab.pngPad = 700 * 1024;
    tab.w = 2000;
    tab.h = 1000;
    const conn = new Conn();
    await w.hub.watch(conn, { spaceId: String(sp.id), ratio: 2 });
    await until(() => conn.frames.some((f) => f.type === "image/webp"), 3000, "a WebP picture");
    const webp = shotsOf(w, tab.targetId).filter((c) => c.params.format === "webp").at(-1)!;
    assert.equal(webp.params.quality, 90);
    assert.equal(scaleOf(webp), 1.6, "3200 pixels wide at most");
    assert.ok(!conn.frames.some((f) => f.type === "image/png"), "the large PNG never went out");
    w.close();
  });

  test("browser.page.show without control: the page comes to the front too (any look at a page does, in this browser), and the watch follows the front, so a bot going back to its page is followed; not_found for a page not there", async () => {
    const { w, sp } = await botSpace("Two pages", two);
    const [one, second] = sp.tabs as [FakeTab, FakeTab];
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    await until(() => conn.frames.length >= 1, 2000, "a picture");
    const shown = await w.hub.pageShow(conn, r.watchId, second.targetId);
    assert.deepEqual(shown, { pageId: second.targetId, width: 1000, height: 700 });
    await until(() => conn.frames.at(-1)?.pageId === second.targetId, 2000, "pictures of page two");
    assert.ok(second.active && !one.active, "page two is in front in the browser");
    assert.deepEqual(w.fb.calls.filter((c) => c.method === "Target.activateTarget").map((c) => c.params.targetId), [second.targetId], "brought to the front once");
    assert.equal(w.hub.control(conn, r.watchId, false).controlled, false, "no control was taken");
    // The bot goes back to its page (any action there brings it to the front): followed, not fought over.
    second.active = false;
    one.active = true;
    await until(() => conn.frames.at(-1)?.pageId === one.targetId, 2000, "the bot's page followed");
    const shotsAfter = w.fb.calls.length;
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(!w.fb.calls.slice(shotsAfter).some((c) => c.method === "Page.captureScreenshot" && c.page === second.targetId), "no picture of the page behind, which would pull it to the front");
    assert.ok(one.active, "the bot's page stays in front");
    // No page: the front.
    const back = await w.hub.pageShow(conn, r.watchId, undefined);
    assert.equal(back.pageId, one.targetId);
    await assert.rejects(w.hub.pageShow(conn, r.watchId, "T999"), isCode("not_found"));
    await assert.rejects(w.hub.pageShow(new Conn(), r.watchId, one.targetId), isCode("not_found"), "another connection's watch");
    assert.equal(conn.endings.length, 0);
    w.close();
  });

  test("browser.page.show with control: the page comes to the front in the browser, control is kept, and a page that opens from it is followed", async () => {
    const { w, sp } = await botSpace("Two pages", two);
    const [one, second] = sp.tabs as [FakeTab, FakeTab];
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    w.hub.control(conn, r.watchId, true);
    await w.hub.pageShow(conn, r.watchId, second.targetId);
    assert.ok(second.active && !one.active, "page two is in front in the browser");
    assert.deepEqual(w.fb.calls.filter((c) => c.method === "Target.activateTarget").map((c) => c.params.targetId), [second.targetId]);
    await until(() => conn.frames.at(-1)?.pageId === second.targetId, 2000, "pictures of page two");
    await w.hub.input(conn, r.watchId, [{ type: "text", text: "still in control" }]);
    assert.equal(second.typed, "still in control");
    const popup = w.fb.openPage(sp.id, "Opened from two", "https://example.net/");
    await until(() => conn.frames.at(-1)?.pageId === popup.targetId, 2000, "the new page is followed");
    w.close();
  });

  test("a page's question belongs to its page: heard when that page is shown, gone when another is", async () => {
    const { w, sp } = await botSpace("Asking", two);
    const [, second] = sp.tabs as [FakeTab, FakeTab];
    second.dialog = { type: "confirm", message: "Leave?" };
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    await until(() => conn.frames.length >= 1, 2000, "a picture");
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(conn.prompts.length, 0, "page one asks nothing");
    await w.hub.pageShow(conn, r.watchId, second.targetId);
    await until(() => conn.prompts.some((p) => p.prompt?.kind === "dialog"), 2000, "the question of page two");
    await w.hub.pageShow(conn, r.watchId, sp.tabs[0]!.targetId);
    await until(() => conn.prompts.at(-1)!.prompt === undefined, 2000, "gone with page one shown");
    await w.hub.pageShow(conn, r.watchId, second.targetId);
    await until(() => conn.prompts.at(-1)!.prompt?.kind === "dialog", 2000, "back with page two");
    w.close();
  });

  test("your own page: browser.page.open and browser.page.close need control; a new page opens in front and is shown; the last page stays; a shown page that closes hands over to the front", async () => {
    const w = world();
    const { space } = await w.hub.own({ url: "example.com" });
    const inBrowser = w.fb.space(Number(space.id))!;
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: space.id });
    await until(() => conn.frames.length >= 1, 2000, "a picture");
    await assert.rejects(w.hub.pageOpen(conn, r.watchId, undefined), isCode("conflict"), "control first");
    w.hub.control(conn, r.watchId, true);
    await assert.rejects(w.hub.pageOpen(conn, r.watchId, "file:///etc/hosts"), isCode("bad_request"));
    const opened = await w.hub.pageOpen(conn, r.watchId, "example.org");
    assert.equal(inBrowser.tabs.length, 2);
    const fresh = inBrowser.tabs.find((t) => t.targetId === opened.pageId)!;
    assert.ok(fresh.active, "in front");
    assert.equal(fresh.url, "https://example.org/");
    await until(() => conn.frames.at(-1)?.pageId === opened.pageId, 2000, "the new page is shown");
    await until(() => lastStateOf(w.events)?.spaces.find((x) => x.id === space.id)?.pages.length === 2, 2000, "two pages in the state");
    const blank = await w.hub.pageOpen(conn, r.watchId, undefined);
    assert.equal(inBrowser.tabs.find((t) => t.targetId === blank.pageId)!.url, "chrome://newtab/", "no address: a new page");
    await w.hub.pageClose(conn, r.watchId, blank.pageId);
    await w.hub.pageClose(conn, r.watchId, opened.pageId);
    assert.equal(inBrowser.tabs.length, 1);
    await until(() => conn.frames.at(-1)?.pageId === inBrowser.tabs[0]!.targetId, 2000, "the watch goes on with the page left");
    assert.equal(conn.endings.length, 0);
    await assert.rejects(w.hub.pageClose(conn, r.watchId, inBrowser.tabs[0]!.targetId), isCode("conflict"), "never the last page");
    await assert.rejects(w.hub.pageClose(conn, r.watchId, "T999"), isCode("not_found"));
    w.hub.control(conn, r.watchId, false);
    await w.hub.pageOpen(conn, r.watchId, undefined).then(
      () => assert.fail("opened without control"),
      (e: unknown) => assert.ok(isCode("conflict")(e)),
    );
    w.close();
  });

  test("browser.page.open and browser.page.close are refused in a bot's workspace, also with control", async () => {
    const { w, sp } = await botSpace("Not yours", two);
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    w.hub.control(conn, r.watchId, true);
    await assert.rejects(w.hub.pageOpen(conn, r.watchId, "example.com"), isCode("conflict"));
    await assert.rejects(w.hub.pageClose(conn, r.watchId, sp.tabs[1]!.targetId), isCode("conflict"));
    assert.equal(w.fb.space(sp.id)!.tabs.length, 2);
    assert.ok(!w.fb.calls.some((c) => c.method === "newPage" || c.method === "close"));
    w.close();
  });

  test("another program's workspace: its pages get real ids once watched, in the browser's order, and a page can be shown", async () => {
    const fb = new FakeBrowser();
    const sp = fb.addSpace("Inventory sync", "agent", [fb.tab("First", "https://example.com/a", "p1", true), fb.tab("Second", "https://example.com/b", "p2", false), fb.tab("Third", "https://example.com/c", "p3", false)]);
    const w = world({ fb });
    const before = (await w.hub.stateFor()).spaces.find((x) => x.id === String(sp.id))!;
    assert.equal(before.owner, "other");
    assert.ok(before.pages.every((p) => p.id.startsWith("recent-")), "not attached: titles only");
    const conn = new Conn();
    const r = await w.hub.watch(conn, { spaceId: String(sp.id) });
    await until(() => JSON.stringify(lastStateOf(w.events)?.spaces.find((x) => x.id === String(sp.id))?.pages.map((p) => p.id)) === JSON.stringify(sp.tabs.map((t) => t.targetId)), 2000, "real ids");
    const pages = lastStateOf(w.events)!.spaces.find((x) => x.id === String(sp.id))!.pages;
    assert.deepEqual(pages.map((p) => [p.title, p.url, p.active]), [["First", "https://example.com/a", true], ["Second", "https://example.com/b", false], ["Third", "https://example.com/c", false]]);
    await w.hub.pageShow(conn, r.watchId, sp.tabs[2]!.targetId);
    await until(() => conn.frames.at(-1)?.pageId === sp.tabs[2]!.targetId, 2000, "page three");
    w.close();
  });

  test("over the socket: browser.view and the page calls are known, with their shapes checked", async () => {
    const w = world();
    const server = new EngineServer("tok-123456789012345", {});
    server.attach(w.engine);
    const port = await server.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok-123456789012345`);
    const waiting = new Map<string, (f: { ok: boolean; error?: { code: string } }) => void>();
    let n = 0;
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.t === "res") waiting.get(f.id)?.(f);
    });
    await new Promise((res) => ws.on("open", res));
    const call = (method: string, params: unknown) =>
      new Promise<{ ok: boolean; error?: { code: string } }>((res) => {
        const id = String(++n);
        waiting.set(id, res);
        ws.send(JSON.stringify({ t: "req", id, method, params }));
      });
    assert.ok((await call("hello", { protocol: PROTOCOL_VERSION, client: "test" })).ok);
    for (const [method, params] of [
      ["browser.view", { watchId: "w1", ratio: 1.5 }],
      ["browser.page.show", { watchId: "w1" }],
      ["browser.page.open", { watchId: "w1", url: "example.com" }],
      ["browser.page.close", { watchId: "w1", pageId: "T1" }],
    ] as const) {
      const r = await call(method, params);
      assert.equal(r.error?.code, "not_found", `${method}: known, the watch is not`);
    }
    assert.equal((await call("browser.view", { watchId: "w1", ratio: -1 })).error?.code, "bad_request");
    assert.equal((await call("browser.page.close", { watchId: "w1" })).error?.code, "bad_request");
    assert.equal((await call("browser.watch", { spaceId: "1", ratio: "big" })).error?.code, "bad_request");
    ws.close();
    w.close();
    await server.close();
  });
});

describe("browser: the migration", () => {
  test("a database from step 2f gets the browser table, and keeps everything", () => {
    const dir = tempDir();
    const path = join(dir, "pobots.db");
    const s1 = new Store(path);
    const th = s1.createThread("po");
    s1.addItem(th.id, { kind: "notice", at: new Date().toISOString(), text: "kept", tone: "info" });
    s1.close();
    const s2 = new Store(path);
    assert.equal(s2.schemaVersion, 11);
    s2.setBrowserSpace({ spaceId: "12", kind: "bot", botId: "po", name: "Work", createdAt: "2026-11-12T10:00:00.000Z" });
    s2.setBrowserSpace({ spaceId: "13", kind: "you", name: "Your page", createdAt: "2026-11-12T10:00:00.000Z" });
    s2.setValue("browser.ownName", "Pobots: your page 0011aabb");
    s2.close();
    const s3 = new Store(path);
    assert.deepEqual(
      s3.listBrowserSpaces().map((r) => [r.spaceId, r.kind, r.botId ?? null]),
      [
        ["12", "bot", "po"],
        ["13", "you", null],
      ],
    );
    assert.equal(s3.getValue("browser.ownName"), "Pobots: your page 0011aabb");
    assert.equal(s3.readThread(th.id).items.length, 1);
    assert.ok(s3.removeBrowserSpace("12"));
    assert.equal(s3.listBrowserSpaces().length, 1);
    s3.close();
  });
});

void ({} as Item);
