import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  allLooks,
  createBotFolder,
  gitAvailable,
  lookKey,
  pickLook,
  readBotFolders,
  slugify,
  uniqueSlug,
  type BotFile,
} from "../bots.js";
import { tempDir } from "./helpers.js";

const file = (name: string, role: "main" | "bot" = "bot"): BotFile => ({
  name,
  role,
  look: { eyes: "round", gap: "mid" },
  harness: "claude",
  model: "claude-haiku-5-5",
  effort: "low",
  fast: true,
  access: "asks-first",
  machine: "mac",
  purpose: "",
  mayMessage: [],
});

describe("slugs", () => {
  test("turns names into folder names", () => {
    assert.equal(slugify("Kaja"), "kaja");
    assert.equal(slugify("HubSpot tickets"), "hubspot-tickets");
    assert.equal(slugify("  Åsa Öberg!! "), "asa-oberg");
    assert.equal(slugify("???"), "bot");
    assert.equal(slugify("x".repeat(80)).length, 40);
  });

  test("never reuses a taken slug", () => {
    assert.equal(uniqueSlug("Kaja", new Set()), "kaja");
    assert.equal(uniqueSlug("Kaja", new Set(["kaja"])), "kaja-2");
    assert.equal(uniqueSlug("Kaja", new Set(["kaja", "kaja-2"])), "kaja-3");
  });
});

describe("looks", () => {
  test("gives every bot a look no other bot has, while there are free ones", () => {
    const used: ReturnType<typeof pickLook>[] = [];
    for (let i = 0; i < 12; i++) used.push(pickLook(used));
    assert.equal(new Set(used.map(lookKey)).size, 12);
    assert.equal(allLooks().length, 12);
  });

  test("picks one of the least used looks when all are taken", () => {
    const used = [...allLooks(), ...allLooks().slice(0, 11)];
    const extra = allLooks()[11]!;
    assert.equal(lookKey(pickLook(used)), lookKey(extra));
  });
});

describe("bot folders", () => {
  test("creates the folder layout with a starter job and a first commit", () => {
    const botsDir = tempDir();
    const bot = createBotFolder(botsDir, "kaja", file("Kaja", "main"));
    const dir = join(botsDir, "kaja");
    assert.equal(bot.dir, dir);
    for (const f of ["bot.json", "AGENTS.md", "CLAUDE.md", "memory/MEMORY.md", "skills", "triggers", "state"]) {
      assert.ok(existsSync(join(dir, f)), `${f} is missing`);
    }
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8").trim(), "@AGENTS.md");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /You are Kaja, a bot in Pobots/);
    assert.doesNotMatch(agents, /Claude Code|!|—/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "bot.json"), "utf8")), file("Kaja", "main"));
    if (gitAvailable()) {
      const log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
      assert.match(log, /Created the bot/);
    }
    assert.throws(() => createBotFolder(botsDir, "kaja", file("Kaja")));
  });

  test("reads folders back, fills in what is missing and skips what is not a bot", () => {
    const botsDir = tempDir();
    createBotFolder(botsDir, "kaja", file("Kaja", "main"));
    mkdirSync(join(botsDir, "hand-made"));
    writeFileSync(join(botsDir, "hand-made", "bot.json"), JSON.stringify({ name: "Hand", effort: "huge", look: { eyes: "x" } }));
    mkdirSync(join(botsDir, "broken"));
    writeFileSync(join(botsDir, "broken", "bot.json"), "{");
    mkdirSync(join(botsDir, "not-a-bot"));
    mkdirSync(join(botsDir, ".hidden"));

    const { bots, problems } = readBotFolders(botsDir, "mac");
    assert.deepEqual(bots.map((b) => b.id), ["hand-made", "kaja"]);
    const hand = bots[0]!.file;
    assert.equal(hand.name, "Hand");
    assert.equal(hand.effort, "medium");
    assert.equal(hand.access, "asks-first");
    assert.deepEqual(hand.look, { eyes: "round", gap: "mid" });
    assert.equal(hand.machine, "mac");
    assert.equal(hand.purpose, "");
    assert.deepEqual(hand.mayMessage, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /broken/);
  });
});
