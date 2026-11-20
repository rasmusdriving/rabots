// The setup guides for the Power Automate flows (docs/build/step-flow-guides.md, engine 0.41.1): the bots
// are told where they are, every path they are told exists, and a Claude bot reads them without a card.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Events } from "../../shared/protocol.js";
import type { ToolResult } from "../claude/session.js";
import { setCalendar } from "../core/calendar-settings.js";
import { GUIDE_FILES, guidePath, guidesDir, insideGuides } from "../core/guides.js";
import { teamPrompt } from "../team.js";
import { type FakeSession, settle, setup } from "./fake.js";

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const sessionOf = (sessions: FakeSession[], botId: string) => sessions.filter((x) => x.settings.botId === botId).at(-1)!;

/** Every guide path in a text: each must be a file that exists. */
function namedGuides(words: string): string[] {
  const dir = guidesDir();
  const found: string[] = [];
  let at = words.indexOf(dir);
  while (at >= 0) {
    // The folder may hold spaces; what follows it is a plain file name.
    const m = /^[A-Za-z0-9._/-]+?\.md/.exec(words.slice(at + dir.length));
    if (m) found.push(dir + m[0]);
    at = words.indexOf(dir, at + 1);
  }
  return found;
}
function assertGuides(words: string, what: string, at_least = 1) {
  const paths = namedGuides(words);
  assert.ok(paths.length >= at_least, `${what} names no guide: ${words.slice(0, 300)}`);
  for (const p of paths) assert.ok(existsSync(p), `${what} names ${p}, which does not exist`);
}

describe("flow guides", () => {
  test("the guides and the definitions they link are there, with nothing of the owner's own", () => {
    for (const file of Object.values(GUIDE_FILES)) assert.ok(existsSync(join(guidesDir(), file)), file);
    for (const name of ["calendar", "teams"] as const) {
      const md = readFileSync(guidePath(name), "utf8");
      const links = [...md.matchAll(/\]\((flows\/[^)]+)\)/g)].map((m) => m[1]!);
      assert.ok(links.length >= 1, `${name} links its definition`);
      for (const l of links) {
        const def = join(guidesDir(), l);
        assert.ok(existsSync(def), l);
        const json = readFileSync(def, "utf8");
        JSON.parse(json);
        // The team and channel are placeholders: no GUID and no Teams channel id.
        assert.doesNotMatch(json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${l} holds an id`);
        assert.doesNotMatch(json, /"19:[^"<]/, `${l} holds a channel id`);
      }
    }
  });

  test("a path inside the guides folder counts, one beside it or climbing out does not", () => {
    assert.equal(insideGuides(guidePath("calendar")), true);
    assert.equal(insideGuides(join(guidesDir(), "flows", "calendar.definition.json")), true);
    assert.equal(insideGuides(guidesDir()), false);
    assert.equal(insideGuides(join(guidesDir(), "..", "decisions.md")), false);
    assert.equal(insideGuides(join(guidesDir(), "..", "guides-other", "x.md")), false);
    assert.equal(insideGuides("calendar-flow.md"), false, "a relative path");
    assert.equal(insideGuides(undefined), false);
    assert.equal(insideGuides(join(guidesDir(), "missing.md")), false, "a file that is not there");
  });

  test("the main bot's team paragraph names both guides; another bot's does not", () => {
    const main = teamPrompt("main");
    assertGuides(main, "the main bot's team paragraph", 2);
    assert.ok(main.includes(guidePath("calendar")) && main.includes(guidePath("teams")));
    assert.match(main, /everything else works without them/);
    assert.match(main, /give them the steps, never the path/);
    assert.equal(namedGuides(teamPrompt("bot")).length, 0);
  });

  test("without a calendar and a channel: the instructions, get_settings, get_bot, list_channels and update_channel name the guide", async () => {
    const w = setup();
    const po = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: po.id, text: "Go" });
    await settle();
    const ps = sessionOf(w.sessions, po.id);
    assertGuides(ps.settings.team, "the main bot's instructions", 2);
    assert.ok(ps.settings.team.includes(`The guide for setting up the calendar flow, to go through with the person, is ${guidePath("calendar")}.`));
    assertGuides(text(await ps.tool("get_settings")), "get_settings");
    assertGuides(text(await ps.tool("get_bot", { bot: "Po" })), "get_bot");
    const none = text(await ps.tool("list_channels"));
    assert.ok(none.includes(guidePath("teams")), none);
    const made = text(await ps.tool("update_channel", { channel: "Ops", create: true }));
    assert.ok(made.includes(guidePath("teams")), made);
    // The person's note about the new channel stays in plain words, without a path.
    const notes = JSON.stringify(w.events.filter((e) => e.event === "item.upsert"));
    assert.ok(!notes.includes(guidesDir()), "a path in the person's notes");
    w.engine.shutdown();
    w.store.close();
  });

  test("a calendar flow that refuses: the bot is pointed to the guide, the window's problem stays in plain words", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "No case for this action." }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/flow`;
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      const po = w.engine.createBot("Po");
      const state = (await setCalendar(w.engine, { address: url })).calendar;
      assert.match(state.problem ?? "", /no case for "hello"/);
      assert.ok(!(state.problem ?? "").includes(guidesDir()), "the window's problem holds a path");
      w.engine.sendMessage({ botId: po.id, text: "Go" });
      await settle();
      const ps = sessionOf(w.sessions, po.id);
      const listed = text(await ps.tool("calendar_list", { from: "2026-11-17" }));
      assert.match(listed, /status 400/);
      assertGuides(listed, "calendar_list's refusal");
      assertGuides(text(await ps.tool("get_settings")), "get_settings with a problem");
    } finally {
      w.engine.shutdown();
      w.store.close();
      await new Promise((r) => server.close(r));
    }
  });

  test("a Claude bot reads a guide without a card; a file beside the folder still asks", async () => {
    const w = setup();
    const po = w.engine.createBot("Po");
    w.engine.sendMessage({ botId: po.id, text: "Go" });
    await settle();
    const ps = sessionOf(w.sessions, po.id);
    const cards = () => w.events.filter((e) => e.event === "card.added").map((e) => (e.data as Events["card.added"]).card);
    const allowed = await ps.ask("Read", { file_path: guidePath("teams") });
    assert.equal(allowed?.behavior, "allow");
    assert.equal(cards().length, 0, "a card for a guide");
    const outside = ps.ask("Read", { file_path: join(guidesDir(), "..", "outside.md") });
    await settle();
    const card = cards().at(-1);
    assert.ok(card, "no card for a file outside the guides");
    w.engine.resolveCard(card.id, { type: "deny" });
    assert.equal((await outside)?.behavior, "deny");
    w.engine.shutdown();
    w.store.close();
  });
});
