// Step 2f: artifacts. A bot shows an HTML file from its folder with show_artifact; what it publishes
// to Claude (the harness's Artifact tool, the Claude Docs connector) becomes known from the recorded
// tool calls; the engine keeps the list, notices when the files change, and serves them under
// /page/<key>/ with headers that seal the page. Fake harness, no model. Nothing is published anywhere.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import WebSocket from "ws";
import type { ActivityItem, Artifact, ArtifactItem, Events } from "../../shared/protocol.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import { checkShowPath, claudeLink, claudeMade, filesSignature, htmlTitle, pageCsp, pageFile, PAGE_SANDBOX, resultLink, SCRIPT_HOSTS, sealHeaders, titleFromName } from "../artifacts.js";
import { describeTool } from "../claude/labels.js";
import { ClaudeSession, type HarnessEvent, type ToolResult } from "../claude/session.js";
import { TIDY_REFUSAL, type Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { EngineServer } from "../server.js";
import { MIGRATIONS, Store } from "../store.js";
import { ARTIFACT_PROMPT } from "../team.js";
import { settle, setup, upserts, type Ev, type FakeSession } from "./fake.js";
import { tempDir } from "./helpers.js";

const FAST = { wakeGraceMs: 5, helperStopMs: 60, helperNudgeMs: 10, liveCheckMs: 20, artifactCheckMs: 10 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const LINK = "https://claude.ai/code/artifact/0f6c2a1e-3b7d-4c55-9a1e-6d2b8f4e9a10";
const LINK2 = "https://claude.ai/artifact/a1b2c3d4e5";

const items = (events: Ev[]) => [...new Map(upserts(events).map((i) => [i.id, i] as const)).values()];
const artifactItems = (events: Ev[]) => items(events).filter((i): i is ArtifactItem => i.kind === "artifact");
const changes = (events: Ev[]) => events.filter((e) => e.event === "artifact.changed").map((e) => e.data as Events["artifact.changed"]);
const activities = (events: Ev[]) => items(events).filter((i): i is ActivityItem => i.kind === "activity");

function world(extra: Parameters<typeof setup>[3] = {}, dirs?: { dataDir: string; botsDir: string }) {
  return setup(dirs, () => true, FAST, extra);
}

function page(title?: string, body = "<p>Hello</p>"): string {
  return `<!doctype html><html><head>${title !== undefined ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>`;
}

function put(dir: string, rel: string, content: string | Buffer): string {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** A message to the bot and the start of its turn; returns the session. */
async function begin(engine: Engine, sessions: FakeSession[], botId: string, msg = "Make me something") {
  engine.sendMessage({ botId, text: msg });
  await settle();
  const s = sessions.at(-1)!;
  s.emit({ type: "session", sessionId: "sess-1" });
  s.emit({ type: "turn-start", own: true });
  s.emit({ type: "thinking" });
  return s;
}
function end(s: FakeSession, said = "Done.") {
  s.emit({ type: "text-full", key: `t-${Math.random()}`, text: said });
  s.emit({ type: "turn-end", ok: true, subtype: "success", errors: [], sessionId: "sess-1", own: true });
}

/** show_artifact as the harness runs it: the call's message, the tool, its result. */
async function show(s: FakeSession, args: Record<string, unknown>, parent?: string): Promise<ToolResult> {
  const id = `tu-${Math.random()}`;
  s.emit({ type: "tool-start", toolUseId: id, name: "mcp__pobots__show_artifact", input: args, ...(parent ? { parent } : {}) });
  const r = await s.tool("show_artifact", args);
  s.emit({ type: "tool-end", toolUseId: id, isError: r.isError === true, ...(parent ? { parent } : {}), text: text(r) });
  return r;
}

/** A recorded call of a harness tool and its result. */
function call(s: FakeSession, name: string, input: Record<string, unknown>, o: { full?: string; result?: unknown; isError?: boolean; parent?: string } = {}) {
  const id = `tu-${Math.random()}`;
  s.emit({ type: "tool-start", toolUseId: id, name, input, ...(o.parent ? { parent: o.parent } : {}) });
  s.emit({
    type: "tool-end",
    toolUseId: id,
    isError: o.isError === true,
    ...(o.parent ? { parent: o.parent } : {}),
    text: (o.full ?? "").slice(0, 400),
    ...(o.full !== undefined ? { full: o.full } : {}),
    ...(o.result !== undefined ? { result: o.result } : {}),
  });
}

/** What a publish by the harness's Artifact tool answers, as far as the SDK's ArtifactOutput and the result text tell (see notes-engine-2f.md). */
function published(url: string, path: string, title = "Status") {
  return {
    result: { url, path, artifact_id: url.split("/").pop(), title, version: "1", owned: true },
    full: `Published "${title}" to ${url}\nThe artifact is private to you until you share it.`,
  };
}

describe("artifacts: show_artifact", () => {
  test("the first call makes a page and a 'made' line in the turn; the answer says the person can open it; no card", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "artifacts/status/index.html", page("Onboarding status"));
    const s = await begin(engine, sessions, bot.id);
    const r = await show(s, { path: "artifacts/status/index.html" });
    assert.equal(r.isError, undefined);
    assert.equal(text(r), 'The person can now open "Onboarding status" beside the chat.');
    const [line] = artifactItems(events);
    assert.ok(line, "no artifact line");
    assert.equal(line.what, "made");
    assert.equal(line.threadId, bot.mainThreadId);
    assert.ok(line.turnId, "the line belongs to the turn");
    assert.equal(line.botId, bot.id);
    const a = line.artifact;
    assert.equal(a.kind, "page");
    assert.equal(a.title, "Onboarding status");
    assert.equal(a.path, "artifacts/status/index.html");
    assert.equal(a.rev, 1);
    assert.equal(a.available, true);
    assert.equal(a.url, undefined);
    assert.deepEqual(changes(events).at(-1), { botId: bot.id, artifact: a });
    assert.equal(events.filter((e) => e.event === "card.added").length, 0);
    assert.deepEqual(await s.ask("mcp__pobots__show_artifact", { path: "x.html" }), { behavior: "allow", updatedInput: { path: "x.html" } });
    assert.equal(activities(events).at(-1)!.label, "Showed you an artifact");
    end(s);
    await settle();
    assert.deepEqual(engine.listArtifacts(bot.id), [a]);
  });

  test("each refusal is one plain sentence the bot can act on", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    const outside = tempDir();
    put(outside, "evil.html", page("Evil"));
    put(dir, "notes.txt", "hello");
    put(dir, ".hidden/index.html", page("Hidden"));
    const big = put(dir, "artifacts/big/index.html", "");
    truncateSync(big, 17 * 1024 * 1024);
    mkdirSync(join(dir, "artifacts", "link"), { recursive: true });
    symlinkSync(join(outside, "evil.html"), join(dir, "artifacts", "link", "index.html"));
    const s = await begin(engine, sessions, bot.id);
    const cases: [string, RegExp][] = [
      ["../outside.html", /outside your folder/],
      [join(outside, "evil.html"), /outside your folder/],
      ["notes.txt", /Only an HTML file can be shown/],
      ["artifacts/missing/index.html", /There is no file at artifacts\/missing\/index.html in your folder\. Write the file first/],
      ["artifacts/big/index.html", /larger than 16 MB/],
      [".hidden/index.html", /start with a dot/],
      ["artifacts/link/index.html", /link to a place outside your folder/],
    ];
    for (const [path, why] of cases) {
      const r = await show(s, { path });
      assert.equal(r.isError, true, path);
      assert.match(text(r), why, path);
      assert.doesNotMatch(text(r), /\n/, "one line");
      assert.ok(!/!/.test(text(r)), "no exclamation mark");
    }
    assert.equal(artifactItems(events).length, 0);
    assert.equal(engine.listArtifacts(bot.id).length, 0);
  });

  test("a later call for the same path adds an 'updated' line, and changes the title only when one is given", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "artifacts/status/index.html", page("Onboarding status"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    put(dir, "artifacts/status/index.html", page("Onboarding status", "<p>More text now</p>"));
    await show(s, { path: "./artifacts/status/index.html" });
    await show(s, { path: join(dir, "artifacts/status/index.html"), title: "Status  of <b>onboarding</b>" });
    const lines = artifactItems(events);
    assert.deepEqual(lines.map((l) => l.what), ["made", "updated", "updated"]);
    assert.equal(new Set(lines.map((l) => l.artifact.id)).size, 1, "one artifact");
    assert.equal(lines[1]!.artifact.title, "Onboarding status");
    assert.equal(lines[1]!.artifact.rev, 2, "the changed file raised rev");
    assert.equal(lines[2]!.artifact.title, "Status of onboarding");
    assert.equal(engine.listArtifacts(bot.id).length, 1);
  });

  test("the title: given, else the page's <title>, else the file's name without its ending (the folder's for index.html)", async () => {
    const { engine, sessions, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "a/index.html", page("  Weekly   numbers &amp; more "));
    put(dir, "b/report.html", page());
    put(dir, "sales-chart/index.html", page(""));
    put(dir, "c/index.html", page("Ignored"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "a/index.html" });
    await show(s, { path: "b/report.html" });
    await show(s, { path: "sales-chart/index.html" });
    await show(s, { path: "c/index.html", title: "Given name" });
    assert.deepEqual(engine.listArtifacts(bot.id).map((a) => a.title).sort(), ["Given name", "Weekly numbers & more", "report", "sales-chart"]);
    assert.equal(htmlTitle("<TITLE lang=en>A\n<b>b</b></TITLE>"), "A b");
    assert.equal(titleFromName("x/index.html"), "x");
    assert.equal(titleFromName("plan.v2.html"), "plan.v2");
  });

  test("a helper's call puts the line in the bot's thread where the helper's row stands, also after the bot's turn and from a helper's helper", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "artifacts/one/index.html", page("One"));
    put(dir, "artifacts/two/index.html", page("Two"));
    put(dir, "artifacts/three/index.html", page("Three"));
    const s = await begin(engine, sessions, bot.id);
    s.helperStart("h1", { description: "Build a page" });
    const row = items(events).find((i) => i.kind === "helper")!;
    await show(s, { path: "artifacts/one/index.html" }, "h1");
    let line = artifactItems(events).at(-1)!;
    assert.equal(line.threadId, bot.mainThreadId, "not in the helper's own thread");
    assert.equal(line.turnId, row.turnId);
    s.helperEnd("h1", "completed", "Built it.");
    // A helper in the background works on after the bot's turn.
    s.helperStart("h2", { description: "Another page", background: true });
    end(s, "A helper is on it.");
    await settle();
    await show(s, { path: "artifacts/two/index.html" }, "h2");
    line = artifactItems(events).at(-1)!;
    assert.equal(line.threadId, bot.mainThreadId);
    assert.equal(line.artifact.title, "Two");
    // A helper started by that helper.
    s.helperStart("h3", { description: "Inner", parent: "h2" });
    await show(s, { path: "artifacts/three/index.html" }, "h3");
    line = artifactItems(events).at(-1)!;
    assert.equal(line.threadId, bot.mainThreadId);
    assert.equal(line.artifact.title, "Three");
  });

  test("in a tidy turn it is refused like every other tool that is not for memory", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "artifacts/x/index.html", page("X"));
    const s = await begin(engine, sessions, bot.id, "Hello");
    end(s, "Hi.");
    await settle();
    assert.deepEqual(engine.startFresh(bot.id), { started: true });
    await settle();
    const t = sessions.at(-1)!;
    const r = await t.tool("show_artifact", { path: "artifacts/x/index.html" });
    assert.equal(r.isError, true);
    assert.equal(text(r), TIDY_REFUSAL);
    assert.equal(artifactItems(events).length, 0);
  });

  test("the bots are told how, in their system prompt", async () => {
    const { engine, sessions } = world();
    const bot = engine.createBot("Po");
    const s = await begin(engine, sessions, bot.id);
    assert.ok(s.settings.team.includes(ARTIFACT_PROMPT));
    for (const w of ["artifacts/<short-name>/index.html", "show_artifact", "<title> of two to four words", "cdnjs.cloudflare.com", "cdn.jsdelivr.net/npm", "unpkg.com", "cdn.tailwindcss.com", "code.jquery.com", "Google Fonts", "light and dark", "phone width", "cannot reach the network or Pobots", "only when the person asks for a link", "a document, a deck"]) {
      assert.ok(ARTIFACT_PROMPT.includes(w), w);
    }
    assert.doesNotMatch(ARTIFACT_PROMPT, /!|—|–/);
  });

  test("its line is not found by search_chat", async () => {
    const { engine, sessions, dirs } = world();
    const bot = engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "artifacts/z/index.html", page("Zebrafinch report"));
    const s = await begin(engine, sessions, bot.id, "Hello there");
    await show(s, { path: "artifacts/z/index.html" });
    end(s, "Here it is.");
    await settle();
    const s2 = await begin(engine, sessions, bot.id, "Search please");
    const r = await s2.tool("search_chat", { query: "Zebrafinch" });
    assert.match(text(r), /Nothing in your chat holds/);
  });
});

describe("artifacts: changes to the files", () => {
  test("a changed page or supporting file raises rev and sends artifact.changed, without a line in the chat; dot files do not count", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "artifacts/status/index.html", page("Status"));
    put(dir, "artifacts/status/data/rows.json", "[1]");
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    end(s);
    await settle();
    const linesBefore = artifactItems(events).length;
    const at = events.length;
    engine.checkArtifacts(bot.id);
    assert.equal(changes(events.slice(at)).length, 0, "nothing changed, nothing sent");
    put(dir, "artifacts/status/index.html", page("Status", "<p>Changed and longer</p>"));
    engine.checkArtifacts(bot.id);
    assert.equal(changes(events).at(-1)!.artifact!.rev, 2);
    put(dir, "artifacts/status/data/rows.json", "[1, 2, 3]");
    engine.checkArtifacts();
    assert.equal(changes(events).at(-1)!.artifact!.rev, 3, "a supporting file below the page's folder counts");
    const at2 = events.length;
    put(dir, "artifacts/status/.cache", "x");
    put(dir, "artifacts/other.txt", "not in its folder");
    engine.checkArtifacts(bot.id);
    assert.equal(changes(events.slice(at2)).length, 0, "dot files and files outside its folder do not count");
    assert.equal(artifactItems(events).length, linesBefore, "no new line in the chat");
    assert.equal(engine.listArtifacts(bot.id)[0]!.rev, 3);
  });

  test("a change during a turn is noticed by itself after the bot's next step", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    put(dir, "artifacts/status/index.html", page("Status", "<p>Written by the bot with its Write tool</p>"));
    s.emit({ type: "tool-start", toolUseId: "w1", name: "Write", input: { file_path: join(dir, "artifacts/status/index.html") } });
    s.emit({ type: "tool-end", toolUseId: "w1", isError: false, text: "ok" });
    await wait(60);
    assert.equal(changes(events).at(-1)!.artifact!.rev, 2);
  });

  test("a deleted file makes the artifact unavailable, and it comes back with the file", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    const full = put(dir, "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    const id = engine.listArtifacts(bot.id)[0]!.id;
    unlinkSync(full);
    engine.checkArtifacts(bot.id);
    assert.equal(changes(events).at(-1)!.artifact!.available, false);
    assert.throws(() => engine.openArtifact({ botId: bot.id, artifactId: id }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
    put(dir, "artifacts/status/index.html", page("Status", "<p>Back again</p>"));
    engine.checkArtifacts(bot.id);
    const back = changes(events).at(-1)!.artifact!;
    assert.equal(back.available, true);
    assert.equal(back.rev, 2);
    assert.ok(engine.openArtifact({ botId: bot.id, artifactId: id }).path.startsWith("/page/"));
  });

  test("the person editing a file in the app is noticed at once", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    end(s);
    await settle();
    engine.writeFile({ botId: bot.id, path: "artifacts/status/notes.md", text: "A note beside the page" });
    assert.equal(changes(events).at(-1)!.artifact!.rev, 2);
  });

  test("filesSignature: a page directly in the bot's folder has only its own file", () => {
    const dir = tempDir();
    put(dir, "page.html", page("P"));
    const a = filesSignature(dir, "page.html");
    put(dir, "memory/MEMORY.md", "changed memory");
    assert.equal(filesSignature(dir, "page.html").sig, a.sig);
    assert.equal(filesSignature(dir, "gone.html").exists, false);
  });
});

describe("artifacts: what is published to Claude", () => {
  test("a publish of a file in the bot's folder gives the artifact its link and a 'published' line", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    const full = put(dir, "artifacts/status/index.html", page("Status page"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    call(s, "Artifact", { file_path: full, icon: "chart", description: "Where each onboarding stands." }, published(LINK, full));
    const lines = artifactItems(events);
    assert.deepEqual(lines.map((l) => l.what), ["made", "published"]);
    assert.equal(lines[1]!.artifact.id, lines[0]!.artifact.id);
    assert.equal(lines[1]!.artifact.url, LINK);
    assert.equal(lines[1]!.artifact.kind, "page");
    assert.equal(lines[1]!.threadId, bot.mainThreadId);
    assert.equal(activities(events).at(-1)!.label, "Published it to Claude");
    assert.equal(engine.listArtifacts(bot.id)[0]!.url, LINK);
  });

  test("a publish of a file in the bot's folder that was never shown makes the page first, with one 'published' line", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "artifacts/plan/index.html", page("Plan"));
    const s = await begin(engine, sessions, bot.id);
    // A relative path, and the link only in the result's text.
    call(s, "Artifact", { file_path: "artifacts/plan/index.html", action: "publish" }, { full: `Published to ${LINK2}.` });
    const lines = artifactItems(events);
    assert.deepEqual(lines.map((l) => l.what), ["published"]);
    assert.equal(lines[0]!.artifact.kind, "page");
    assert.equal(lines[0]!.artifact.title, "Plan");
    assert.equal(lines[0]!.artifact.url, LINK2);
    assert.equal(lines[0]!.artifact.path, "artifacts/plan/index.html");
  });

  test("a publish of a file elsewhere, and one made from one of Claude's types, become 'link' artifacts", async () => {
    const { engine, sessions, events } = world();
    const bot = engine.createBot("Po");
    const outside = tempDir();
    const elsewhere = put(outside, "report.html", page("Report"));
    const s = await begin(engine, sessions, bot.id);
    call(s, "Artifact", { file_path: elsewhere, title: "Quarter report" }, published(LINK, elsewhere, "Quarter report"));
    call(s, "Artifact", { type_url: "https://claude.ai/artifact/type-slides", title: "Kickoff deck" }, { full: `Created ${LINK2}`, result: { url: LINK2, path: "" } });
    call(s, "Artifact", { type_url: "https://claude.ai/artifact/type-doc" }, { full: "Created https://claude.ai/artifact/zz99yy88" });
    const lines = artifactItems(events);
    assert.deepEqual(lines.map((l) => [l.what, l.artifact.kind, l.artifact.title, l.artifact.url]), [
      ["made", "link", "Quarter report", LINK],
      ["made", "link", "Kickoff deck", LINK2],
      ["made", "link", "Artifact on Claude", "https://claude.ai/artifact/zz99yy88"],
    ]);
    for (const l of lines) {
      assert.equal(l.artifact.rev, 0);
      assert.equal(l.artifact.path, undefined);
      assert.equal(l.artifact.available, true);
    }
    assert.throws(() => engine.openArtifact({ botId: bot.id, artifactId: lines[0]!.artifact.id }), (e: unknown) => e instanceof EngineError && e.code === "conflict");
  });

  test("a second publish to a known link changes only updatedAt, with at most one 'updated' line per turn", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const full = put(join(dirs.botsDir, bot.id), "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    call(s, "Artifact", { file_path: full }, published(LINK, full));
    await wait(5);
    call(s, "Artifact", { file_path: full, url: LINK }, published(LINK, full));
    call(s, "Artifact", { file_path: full, url: LINK }, published(LINK, full));
    end(s);
    await settle();
    const first = artifactItems(events);
    assert.deepEqual(first.map((l) => l.what), ["published", "updated"]);
    assert.ok(first[1]!.artifact.updatedAt >= first[0]!.artifact.updatedAt);
    assert.equal(first[1]!.artifact.title, "Status");
    const s2 = await begin(engine, sessions, bot.id, "Publish it again");
    call(s2, "Artifact", { file_path: full, url: LINK }, published(LINK, full));
    assert.deepEqual(artifactItems(events).map((l) => l.what), ["published", "updated", "updated"]);
    assert.equal(engine.listArtifacts(bot.id).length, 1);
  });

  test("a new Claude document becomes a 'link' artifact with its title", async () => {
    const { engine, sessions, events } = world();
    const bot = engine.createBot("Po");
    const s = await begin(engine, sessions, bot.id);
    const input = {
      container: { kind: "project", create: { name: "Onboarding plan", doc: { blocks: { s1: { type: "pending", intent: "Goals" } }, markdown: "# Onboarding plan\n\n<?claude block s1?>" } } },
      batch: [],
    };
    call(s, "mcp__claude_ai_Claude_Docs__batch", input, { full: JSON.stringify({ ok: true, project: { id: "p1", url: "https://claude.ai/artifact/doc123abc" } }) });
    const [line] = artifactItems(events);
    assert.equal(line!.what, "made");
    assert.equal(line!.artifact.kind, "link");
    assert.equal(line!.artifact.title, "Onboarding plan");
    assert.equal(line!.artifact.url, "https://claude.ai/artifact/doc123abc");
    assert.equal(activities(events).at(-1)!.label, "Made a document on Claude");
  });

  test("failed calls, other actions, asset uploads and links that are not on claude.ai make nothing", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const full = put(join(dirs.botsDir, bot.id), "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    const listing = { full: `Your artifacts:\n- Status ${LINK}\n- Other ${LINK2}`, result: { artifacts: [{ title: "Status", url: LINK }] } };
    call(s, "Artifact", { file_path: full }, { ...published(LINK, full), isError: true });
    call(s, "Artifact", { action: "list" }, listing);
    call(s, "Artifact", { action: "read", url: LINK }, { full: `Read ${LINK}`, result: { read: { url: LINK } } });
    call(s, "Artifact", { action: "upload_asset", url: LINK, file_path: full }, { full: `Uploaded to ${LINK}` });
    call(s, "Artifact", { url: LINK, file_path: full, asset: true }, { full: `Uploaded to ${LINK}` });
    call(s, "Artifact", { action: "delete", url: LINK }, { full: `Deleted ${LINK}` });
    call(s, "Artifact", { action: "pin", url: LINK }, { full: `Pinned ${LINK}` });
    call(s, "Artifact", {}, { full: `Nothing to publish ${LINK}` });
    call(s, "mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", id: "p1" }, batch: [{ op: "replace" }] }, { full: `Updated https://claude.ai/artifact/doc123abc` });
    call(s, "mcp__claude_ai_Claude_Docs__read", { container: { kind: "project", id: "p1" } }, { full: `https://claude.ai/artifact/doc123abc` });
    call(s, "mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", create: { name: "Failed doc" } }, batch: [] }, { full: "https://claude.ai/artifact/doc999", isError: true });
    // Links that are not claude.ai artifact links.
    for (const bad of ["https://claude.ai.example.com/artifact/abcdef", "http://claude.ai/artifact/abcdef", "https://example.com/artifact/abcdef", "https://claude.ai/chat/abcdef", "https://claude.ai/project/abcdef"]) {
      call(s, "Artifact", { file_path: full }, { full: `Published to ${bad}`, result: { url: bad, path: full } });
    }
    // A Bash command that prints a link is not a publish either.
    call(s, "Bash", { command: "echo" }, { full: LINK });
    assert.equal(artifactItems(events).length, 0);
    assert.equal(engine.listArtifacts(bot.id).length, 0);
    const failed = activities(events).find((a) => a.status === "failed" && /publish/i.test(a.label));
    assert.equal(failed?.label, "Could not publish it to Claude");
  });

  test("a helper's publish puts the line in the bot's thread", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const full = put(join(dirs.botsDir, bot.id), "artifacts/status/index.html", page("Status"));
    const s = await begin(engine, sessions, bot.id);
    s.helperStart("h1", { description: "Publish it" });
    call(s, "Artifact", { file_path: full }, { ...published(LINK, full), parent: "h1" });
    const [line] = artifactItems(events);
    assert.equal(line!.what, "published");
    assert.equal(line!.threadId, bot.mainThreadId);
  });

  test("claudeLink, resultLink and claudeMade", () => {
    assert.equal(claudeLink(`see ${LINK}.`), LINK);
    assert.equal(claudeLink("(https://claude.ai/artifact/abc_DEF-123)"), "https://claude.ai/artifact/abc_DEF-123");
    for (const bad of ["https://claude.ai/artifact/", "https://claude.ai/artifacts/abc", "https://evil.example/https:/claude.ai", "https://claude.ai/artifact/ab", "https://claude.ai.evil.com/artifact/abcdef"]) assert.equal(claudeLink(bad), undefined, bad);
    assert.equal(resultLink({ url: LINK }, ""), LINK);
    assert.equal(resultLink({ url: `${LINK}?x=1` }, "nothing"), undefined, "a url field with more than a link is not taken as it is");
    assert.equal(resultLink({ url: "https://example.com/x" }, `text ${LINK2}`), LINK2);
    assert.deepEqual(claudeMade("Artifact", { file_path: "/x/a.html" }), { kind: "publish", filePath: "/x/a.html" });
    assert.equal(claudeMade("Artifact", { file_path: "/x/a.html", action: "read" }), undefined);
    assert.equal(claudeMade("Read", { file_path: "/x/a.html" }), undefined);
    assert.deepEqual(claudeMade("mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", create: { name: "N" } } }), { kind: "document", title: "N" });
    assert.equal(claudeMade("mcp__claude_ai_Claude_Docs__create", { object: "node", payload: {} }), undefined, "create adds to an existing document");
  });

  test("the words for the calls", () => {
    assert.deepEqual(describeTool("Artifact", { file_path: "/b/artifacts/x/index.html" }), {
      done: "Published it to Claude",
      running: "Publishing it to Claude",
      failed: "Could not publish it to Claude",
      detail: "/b/artifacts/x/index.html",
    });
    assert.equal(describeTool("Artifact", { action: "list" }).done, "Looked at its artifacts on Claude");
    assert.equal(describeTool("Artifact", { action: "upload_asset", file_path: "a.png", url: LINK }).done, "Used Artifact");
    assert.equal(describeTool("mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", create: { name: "Plan" } } }).done, "Made a document on Claude");
    assert.equal(describeTool("mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", id: "p" } }).done, "Used batch in Claude Docs");
  });

  test("the real session passes a tool's whole text and its structured result on", () => {
    const got: HarnessEvent[] = [];
    const cs = new ClaudeSession({
      botId: "po",
      botName: "Po",
      botDir: tempDir(),
      model: "claude-haiku-5-5",
      effort: "low",
      access: "asks-first",
      executable: "/fake/claude",
      env: {},
      tools: [],
      rules: [],
      team: "",
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      onEvent: (e) => got.push(e),
    });
    const handle = (m: unknown) => (cs as unknown as { handle(m: unknown): void }).handle(m);
    const long = "x".repeat(600) + ` ${LINK}`;
    handle({ type: "user", parent_tool_use_id: null, uuid: "u1", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: long }] }] }, tool_use_result: { url: LINK, path: "/x" } });
    handle({
      type: "user",
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "s",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "a" }, { type: "tool_result", tool_use_id: "t3", content: "b" }] },
      tool_use_result: { url: LINK },
    });
    const ends = got.filter((e): e is Extract<HarnessEvent, { type: "tool-end" }> => e.type === "tool-end");
    assert.equal(ends[0]!.text!.length, 400);
    assert.ok(ends[0]!.full!.endsWith(LINK));
    assert.deepEqual(ends[0]!.result, { url: LINK, path: "/x" });
    assert.equal(ends[1]!.result, undefined, "a structured result is only taken for a message that answers one call");
    assert.equal(ends[2]!.result, undefined);
  });
});

describe("artifacts: the list", () => {
  test("newest change first; remove takes one off with removedId, the file and its old line stay, open says not_found", async () => {
    const { engine, sessions, events, dirs } = world();
    const bot = engine.createBot("Po");
    const dir = join(dirs.botsDir, bot.id);
    put(dir, "a/index.html", page("A"));
    put(dir, "b/index.html", page("B"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "a/index.html" });
    await wait(5);
    await show(s, { path: "b/index.html" });
    assert.deepEqual(engine.listArtifacts(bot.id).map((a) => a.title), ["B", "A"]);
    await wait(5);
    await show(s, { path: "a/index.html" });
    assert.deepEqual(engine.listArtifacts(bot.id).map((a) => a.title), ["A", "B"]);
    const a = engine.listArtifacts(bot.id)[0]!;
    const { path } = engine.openArtifact({ botId: bot.id, artifactId: a.id });
    const key = path.split("/")[2]!;
    engine.removeArtifact({ botId: bot.id, artifactId: a.id });
    assert.deepEqual(changes(events).at(-1), { botId: bot.id, removedId: a.id });
    assert.deepEqual(engine.listArtifacts(bot.id).map((x) => x.title), ["B"]);
    assert.throws(() => engine.openArtifact({ botId: bot.id, artifactId: a.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.throws(() => engine.removeArtifact({ botId: bot.id, artifactId: a.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.equal(engine.pageRequest(key, "index.html").ok, false, "its key opens nothing any more");
    const old = engine.readThread({ threadId: bot.mainThreadId }).items.filter((i) => i.kind === "artifact" && i.artifact.id === a.id);
    assert.equal(old.length, 2, "old lines stay");
    assert.ok(checkShowPath(dir, "a/index.html").ok, "the file stays");
    // Showing the same file again makes a new artifact.
    await show(s, { path: "a/index.html" });
    const again = artifactItems(events).at(-1)!;
    assert.equal(again.what, "made");
    assert.notEqual(again.artifact.id, a.id);
    // Another bot's artifact is not found through this bot.
    const other = engine.createBot("Bo");
    assert.throws(() => engine.openArtifact({ botId: other.id, artifactId: again.artifact.id }), (e: unknown) => e instanceof EngineError && e.code === "not_found");
    assert.throws(() => engine.listArtifacts("nobody"), (e: unknown) => e instanceof EngineError && e.code === "not_found");
  });

  test("artifacts are kept across a restart", async () => {
    const dirs = { dataDir: tempDir(), botsDir: tempDir() };
    const first = world({}, dirs);
    const bot = first.engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "a/index.html", page("Kept"));
    const s = await begin(first.engine, first.sessions, bot.id);
    await show(s, { path: "a/index.html" });
    call(s, "mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", create: { name: "Doc" } } }, { full: "https://claude.ai/artifact/doc123abc" });
    end(s);
    await settle();
    const before = first.engine.listArtifacts(bot.id);
    first.engine.shutdown();
    first.store.close();
    const second = world({}, dirs);
    assert.deepEqual(second.engine.listArtifacts(bot.id), before);
    assert.ok(second.engine.openArtifact({ botId: bot.id, artifactId: before.find((a) => a.kind === "page")!.id }).path.startsWith("/page/"));
    second.engine.shutdown();
    second.store.close();
  });

  test("a retired bot's artifacts go with it", async () => {
    const { engine, sessions, store, dirs } = world();
    engine.createBot("Main");
    const bot = engine.createBot("Po");
    put(join(dirs.botsDir, bot.id), "a/index.html", page("A"));
    const s = await begin(engine, sessions, bot.id);
    await show(s, { path: "a/index.html" });
    end(s);
    await settle();
    const a = engine.listArtifacts(bot.id)[0]!;
    const key = engine.openArtifact({ botId: bot.id, artifactId: a.id }).path.split("/")[2]!;
    engine.retireBot(bot.id);
    assert.equal(engine.pageRequest(key, "").ok, false);
    assert.equal(store.listArtifacts(bot.id).length, 0);
    assert.equal(store.getArtifact(a.id)!.retired, true);
    const again = engine.createBot("Po");
    assert.equal(again.id, "po-2");
    assert.equal(engine.listArtifacts(again.id).length, 0);
  });

  test("a database from version 7 gets the artifacts table and keeps everything", () => {
    const dir = tempDir();
    const path = join(dir, "pobots.db");
    const db = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 7)) db.exec(m);
    db.exec("PRAGMA user_version = 7");
    db.prepare("INSERT INTO threads (id, bot_id, kind, created_at) VALUES ('t1', 'po', 'main', '2026-11-10T10:00:00Z')").run();
    db.prepare("INSERT INTO items (id, thread_id, seq, kind, open, data) VALUES ('i1', 't1', 1, 'bot', 0, ?)").run(
      JSON.stringify({ id: "i1", threadId: "t1", seq: 1, kind: "bot", at: "2026-11-10T10:00:00Z", botId: "po", text: "Hello", streaming: false }),
    );
    db.close();
    const s = new Store(path);
    assert.equal(s.schemaVersion, 11);
    assert.equal(s.readThread("t1").items.length, 1);
    const row = { id: "a1", botId: "po", kind: "page" as const, title: "T", path: "a/index.html", rev: 1, available: true, sig: "x", createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z", removed: false, retired: false };
    s.addArtifact(row);
    assert.deepEqual(s.getArtifact("a1"), row);
    assert.deepEqual(s.artifactByPath("po", "a/index.html"), row);
    s.updateArtifact({ ...row, url: LINK, rev: 2 });
    assert.equal(s.artifactByUrl("po", LINK)!.rev, 2);
    assert.ok(s.removeArtifact("a1"));
    assert.equal(s.listArtifacts("po").length, 0);
    assert.equal(s.artifactByPath("po", "a/index.html"), undefined);
    assert.equal(s.getArtifact("a1")!.removed, true);
    s.close();
  });
});

describe("artifacts: the key and the files under /page/", () => {
  async function shown(extra: Parameters<typeof setup>[3] = {}) {
    const w = world(extra);
    const bot = w.engine.createBot("Po");
    const dir = join(w.dirs.botsDir, bot.id);
    put(dir, "artifacts/status/index.html", page("Status"));
    put(dir, "artifacts/status/app.js", "console.log(1)");
    put(dir, "artifacts/status/img/logo.png", Buffer.from([137, 80, 78, 71]));
    put(dir, "artifacts/status/run.py", "print(1)");
    put(dir, "artifacts/status/.env", "SECRET=1");
    put(dir, "artifacts/status/.dot/x.js", "x");
    put(dir, "artifacts/other/index.html", page("Other"));
    put(dir, "artifacts/other/secret.js", "other");
    put(dir, "top.html", page("Top"));
    const outside = tempDir();
    put(outside, "out.js", "outside");
    symlinkSync(join(outside, "out.js"), join(dir, "artifacts", "status", "link.js"));
    symlinkSync(join(dir, "artifacts", "other"), join(dir, "artifacts", "status", "sib"));
    const s = await begin(w.engine, w.sessions, bot.id);
    await show(s, { path: "artifacts/status/index.html" });
    await show(s, { path: "artifacts/other/index.html" });
    await show(s, { path: "top.html" });
    end(s);
    await settle();
    const list = w.engine.listArtifacts(bot.id);
    const of = (title: string) => list.find((a) => a.title === title)!;
    return { ...w, bot, dir, of };
  }

  test("a good key serves the page and its files; the same key again while it is good; unknown, expired and other paths give nothing", async () => {
    let clock = Date.parse("2026-11-11T10:00:00Z");
    const { engine, bot, of } = await shown({ clock: () => clock });
    const status = of("Status");
    const opened = engine.openArtifact({ botId: bot.id, artifactId: status.id });
    assert.match(opened.path, /^\/page\/[A-Za-z0-9_-]{43}\/index\.html\?r=1$/);
    assert.equal(opened.rev, 1);
    const key = opened.path.split("/")[2]!;
    assert.equal(engine.openArtifact({ botId: bot.id, artifactId: status.id }).path.split("/")[2], key, "the same key while it is good");
    const ok = (rest: string) => engine.pageRequest(key, rest);
    assert.deepEqual([ok("index.html").ok, ok("").ok, ok("app.js").ok, ok("img/logo.png").ok], [true, true, true, true]);
    const pg = ok("");
    assert.ok(pg.ok && pg.isPage && pg.type === "text/html; charset=utf-8");
    const js = ok("app.js");
    assert.ok(js.ok && !js.isPage && js.type === "text/javascript; charset=utf-8");
    for (const bad of ["../other/secret.js", "..%2fother%2fsecret.js", "%2e%2e/other/secret.js", "img/../app.js", ".env", ".dot/x.js", "link.js", "sib/secret.js", "run.py", "img", "img/", "missing.js", "a\\b.js", "%00.js", "/etc/hosts"]) {
      assert.equal(ok(bad).ok, false, bad);
    }
    assert.equal(engine.pageRequest("A".repeat(43), "index.html").ok, false, "an unknown key");
    // Another artifact's files are not reached with this key, and its own key only reaches its own.
    const otherKey = engine.openArtifact({ botId: bot.id, artifactId: of("Other").id }).path.split("/")[2]!;
    assert.notEqual(otherKey, key);
    assert.equal(engine.pageRequest(otherKey, "secret.js").ok, true);
    assert.equal(engine.pageRequest(otherKey, "app.js").ok, false);
    // A page directly in the bot's folder: only the page itself, never the job, memory or settings.
    const topKey = engine.openArtifact({ botId: bot.id, artifactId: of("Top").id }).path.split("/")[2]!;
    assert.equal(engine.pageRequest(topKey, "top.html").ok, true);
    assert.equal(engine.pageRequest(topKey, "").ok, true);
    for (const bad of ["AGENTS.md", "bot.json", "memory/MEMORY.md", "artifacts/status/app.js"]) assert.equal(engine.pageRequest(topKey, bad).ok, false, bad);
    // Some hours on: a key with less than an hour left is not handed out again, and an expired one opens nothing.
    clock += 5.5 * 60 * 60 * 1000;
    const fresh = engine.openArtifact({ botId: bot.id, artifactId: status.id }).path.split("/")[2]!;
    assert.notEqual(fresh, key);
    assert.equal(engine.pageRequest(key, "index.html").ok, true, "still good for a while");
    clock += 31 * 60 * 1000;
    assert.equal(engine.pageRequest(key, "index.html").ok, false, "expired");
    assert.equal(engine.pageRequest(fresh, "index.html").ok, true);
  });

  test("pageFile and checkShowPath on their own", () => {
    const dir = tempDir();
    put(dir, "x/index.html", page("X"));
    put(dir, "x/data.csv", "a,b");
    put(dir, "x/notes.md", "# n");
    put(dir, "x/font.woff2", "f");
    put(dir, "x/my file.json", "{}");
    for (const ok of ["data.csv", "notes.md", "font.woff2", "my%20file.json"]) assert.equal(pageFile(dir, "x/index.html", ok).ok, true, ok);
    assert.equal(pageFile(dir, "x/index.html", "%E0%A4%A").ok, false, "a broken escape");
    // The folder reached through a link (on macOS the temporary folder is /var, really /private/var).
    const viaReal = checkShowPath(dir, join(realpathSync(dir), "x", "index.html"));
    assert.ok(viaReal.ok && viaReal.rel === "x/index.html", JSON.stringify(viaReal));
    rmSync(join(dir, "x", "index.html"));
    assert.equal(pageFile(dir, "x/index.html", "").ok, false, "a page whose file is gone");
  });

  // ------------------------------------------------------------ the server

  interface Answer {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }
  function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  const LOGIN = "someone@example.com";
  const TOKEN = "test-token-0123456789";

  async function served(serve: boolean) {
    const w = await shown();
    const uiDir = tempDir();
    put(uiDir, "index.html", "<!doctype html><title>Pobots</title>");
    const server = new EngineServer(TOKEN, { ...(serve ? { uiDir } : {}), allowedLogins: [LOGIN] });
    server.attach(w.engine);
    const port = await server.listen(0);
    const open = (title: string) => w.engine.openArtifact({ botId: w.bot.id, artifactId: w.of(title).id }).path;
    return { ...w, server, port, open };
  }

  function assertSealed(a: Answer, what: string, kind: "page" | "file" | "error", key?: string, host?: string) {
    const csp = String(a.headers["content-security-policy"] ?? "");
    assert.ok(csp, `${what}: no CSP`);
    assert.ok(csp.includes(`sandbox ${PAGE_SANDBOX}`), `${what}: sandbox`);
    assert.ok(!/allow-same-origin|allow-top-navigation/.test(csp), `${what}: never same origin or top navigation`);
    for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self' file:", "img-src data: blob:", "media-src data: blob:"]) {
      assert.ok(csp.includes(part), `${what}: ${part}`);
    }
    assert.ok(csp.includes(`script-src 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS.join(" ")}`), `${what}: script hosts`);
    assert.ok(csp.includes("style-src 'unsafe-inline' https://fonts.googleapis.com"), `${what}: styles`);
    assert.ok(csp.includes("font-src https://fonts.gstatic.com data:"), `${what}: fonts`);
    assert.ok(!/'self'(?! file:)/.test(csp), `${what}: 'self' only in frame-ancestors`);
    if (key && host) assert.ok(csp.includes(`http://${host}/page/${key}/ https://${host}/page/${key}/`), `${what}: its own folder, by name`);
    if (kind === "error") assert.ok(!csp.includes("/page/"), `${what}: a refusal names no folder`);
    assert.equal(a.headers["x-content-type-options"], "nosniff", `${what}: nosniff`);
    assert.equal(a.headers["referrer-policy"], "no-referrer", `${what}: referrer`);
    assert.equal(a.headers["cache-control"], "no-store", `${what}: cache`);
    assert.equal(a.headers["cross-origin-resource-policy"], kind === "file" ? "cross-origin" : "same-origin", `${what}: CORP`);
    assert.equal(a.headers["set-cookie"], undefined);
  }

  for (const serve of [false, true]) {
    test(`every answer under /page/ is sealed, ${serve ? "in serve mode" : "without serve mode (the desktop window)"}`, async () => {
      const { server, port, open } = await served(serve);
      try {
        const path = open("Status");
        const key = path.split("/")[2]!;
        const host = `127.0.0.1:${port}`;
        const pg = await get(port, path);
        assert.equal(pg.status, 200);
        assert.equal(pg.headers["content-type"], "text/html; charset=utf-8");
        assert.match(pg.body, /<title>Status<\/title>/);
        assertSealed(pg, "the page", "page", key, host);
        const bare = await get(port, `/page/${key}/`);
        assert.equal(bare.status, 200);
        assertSealed(bare, "the bare folder", "page", key, host);
        const js = await get(port, `/page/${key}/app.js`);
        assert.equal(js.status, 200);
        assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
        assertSealed(js, "a supporting file", "file", key, host);
        const png = await get(port, `/page/${key}/img/logo.png`);
        assert.equal(png.headers["content-type"], "image/png");
        assertSealed(png, "an image", "file", key, host);
        const head = await get(port, path, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.body, "");
        assertSealed(head, "HEAD", "page", key, host);
        for (const [what, p] of [
          ["an unknown key", `/page/${"B".repeat(43)}/index.html`],
          ["a short key", "/page/abc/index.html"],
          ["no key", "/page/"],
          ["the bare /page", "/page"],
          ["a path out of the folder", `/page/${key}/../other/secret.js`],
          ["an escaped path out", `/page/${key}/..%2fother%2fsecret.js`],
          ["a dot file", `/page/${key}/.env`],
          ["a link out of the folder", `/page/${key}/link.js`],
          ["a kind that is not served", `/page/${key}/run.py`],
          ["a folder", `/page/${key}/img/`],
        ]) {
          const a = await get(port, p!);
          assert.equal(a.status, 404, what);
          assert.equal(a.body, "Not found", what);
          assert.ok(!a.body.includes("SECRET"), what);
          assertSealed(a, what!, "error");
        }
        for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
          const a = await get(port, path, { method, headers: { "content-type": "application/json" } });
          assert.equal(a.status, 405, method);
          assert.equal(a.headers.allow, "GET, HEAD");
          assertSealed(a, method, "error");
        }
        // Through a proxy (as tailscale serve sends it): only with an allowed Tailscale identity.
        const via = { "x-forwarded-for": "100.64.0.7", host: "mac.example.ts.net" };
        assert.equal((await get(port, path, { headers: via })).status, 404, "a proxy without an identity");
        assert.equal((await get(port, path, { headers: { ...via, "tailscale-user-login": "stranger@example.org" } })).status, 404, "a login not on the list");
        assert.equal((await get(port, path, { headers: { "tailscale-funnel-request": "?1" } })).status, 404, "a Funnel request");
        const tail = await get(port, path, { headers: { ...via, "tailscale-user-login": LOGIN } });
        assert.equal(tail.status, 200, "an allowed device on the tailnet");
        assertSealed(tail, "over the tailnet", "page", key, "mac.example.ts.net");
        // An odd Host header names no folder.
        const odd = await get(port, path, { headers: { host: "evil; script-src *" } });
        assert.equal(odd.status, 200);
        assert.ok(!String(odd.headers["content-security-policy"]).includes("evil"));
      } finally {
        await server.close();
      }
    });
  }

  function socket(port: number, o: { token?: string; login?: string; origin?: string }) {
    return new Promise<{ ws: WebSocket; req: (method: string, params: unknown) => Promise<Record<string, unknown>> } | number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${o.token ? `?token=${o.token}` : ""}`, { headers: o.login ? { "tailscale-user-login": o.login } : {}, ...(o.origin ? { origin: o.origin } : {}) });
      let n = 0;
      const pending = new Map<string, (f: Record<string, unknown>) => void>();
      ws.on("unexpected-response", (_r, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("error", () => resolve(-1));
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw)) as Record<string, unknown>;
        if (f.t === "res") pending.get(String(f.id))?.(f);
      });
      const req = (method: string, params: unknown) =>
        new Promise<Record<string, unknown>>((res) => {
          const id = String(++n);
          pending.set(id, res);
          ws.send(JSON.stringify({ t: "req", id, method, params }));
        });
      ws.on("open", async () => {
        await req("hello", { protocol: PROTOCOL_VERSION, client: "test" });
        resolve({ ws, req });
      });
    });
  }

  test("artifact.open over the socket: the desktop window gets a whole address, a browser page a path; the list and remove", async () => {
    const { server, port, bot, of } = await served(true);
    try {
      const local = await socket(port, { token: TOKEN });
      assert.ok(typeof local === "object");
      const opened = (await local.req("artifact.open", { botId: bot.id, artifactId: of("Status").id })) as { ok: boolean; result: { src: string; rev: number } };
      assert.ok(opened.ok);
      assert.match(opened.result.src, new RegExp(`^http://127\\.0\\.0\\.1:${port}/page/[A-Za-z0-9_-]{43}/index\\.html\\?r=1$`));
      const fetched = await get(port, opened.result.src.slice(`http://127.0.0.1:${port}`.length));
      assert.equal(fetched.status, 200);
      const remote = await socket(port, { login: LOGIN, origin: `http://127.0.0.1:${port}` });
      assert.ok(typeof remote === "object");
      const r2 = (await remote.req("artifact.open", { botId: bot.id, artifactId: of("Status").id })) as { result: { src: string } };
      assert.match(r2.result.src, /^\/page\/[A-Za-z0-9_-]{43}\/index\.html\?r=1$/);
      const listed = (await remote.req("artifact.list", { botId: bot.id })) as { result: { artifacts: Artifact[] } };
      assert.equal(listed.result.artifacts.length, 3);
      const removed = (await remote.req("artifact.remove", { botId: bot.id, artifactId: of("Other").id })) as { ok: boolean };
      assert.ok(removed.ok);
      const gone = (await remote.req("artifact.open", { botId: bot.id, artifactId: of("Other").id })) as { ok: boolean; error: { code: string } };
      assert.equal(gone.ok, false);
      assert.equal(gone.error.code, "not_found");
      const bad = (await remote.req("artifact.open", { botId: bot.id })) as { ok: boolean; error: { code: string } };
      assert.equal(bad.error.code, "bad_request");
      local.ws.close();
      remote.ws.close();
      // A sandboxed frame's page sends the Origin "null": the socket refuses it, identity or not.
      assert.equal(await socket(port, { login: LOGIN, origin: "null" }), 401);
      assert.equal(await socket(port, { origin: "null" }), 401);
    } finally {
      await server.close();
    }
  });

  test("the policy and the headers on their own", () => {
    const own = ["http://h:1/page/k/", "https://h:1/page/k/"];
    const csp = pageCsp(own);
    assert.ok(csp.startsWith(`sandbox ${PAGE_SANDBOX};`));
    assert.equal(PAGE_SANDBOX, "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals");
    assert.ok(csp.includes(`img-src data: blob: ${own.join(" ")}`));
    assert.equal(sealHeaders("page", own)["Cross-Origin-Resource-Policy"], "same-origin");
    assert.equal(sealHeaders("file", own)["Cross-Origin-Resource-Policy"], "cross-origin");
    assert.ok(!sealHeaders("error", own)["Content-Security-Policy"]!.includes("/page/"));
  });
});

describe("artifacts: the harness's tool for publishing", () => {
  test("a bot's harness is started with the switch that gives it the tool, whatever the engine's own parent had", async () => {
    const { harnessEnv } = await import("../claude/detect.js");
    assert.equal(harnessEnv({ PATH: "/bin" }, undefined).CLAUDE_CODE_ARTIFACT, "1");
    assert.equal(harnessEnv({ PATH: "/bin", CLAUDE_CODE_ARTIFACT: "0", CLAUDECODE: "1" }, undefined).CLAUDE_CODE_ARTIFACT, "1");
    assert.equal(harnessEnv({ PATH: "/bin" }, { CLAUDE_CODE_ARTIFACT: "0" }).CLAUDE_CODE_ARTIFACT, "0", "the env file has the last word");
  });
});
