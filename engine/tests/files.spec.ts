// A bot's files and their history: listing, refusals, conflicts, saved changes and undo. No model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Events } from "../../shared/protocol.js";
import { EngineError } from "../errors.js";
import { checkPath, fileTitle, listFiles, readTextFile, writeTextFile } from "../files.js";
import { gitAvailable } from "../history.js";
import { settle, setup } from "./fake.js";
import { tempDir } from "./helpers.js";

const code = (c: string) => (err: unknown) => err instanceof EngineError && err.code === c;

describe("a bot's files", () => {
  test("lists text files: job first, then memory, skills and the rest, with kinds and titles", () => {
    const { engine, store } = setup();
    const bot = engine.createBot({ name: "Kaja", job: "Sort the mail." });
    const files0 = engine.listFiles(bot.id);
    assert.deepEqual(files0.map((f) => f.path), ["AGENTS.md", "memory/MEMORY.md", "WORKERS.md"]);
    assert.deepEqual(files0.map((f) => [f.kind, f.title]), [["job", "Job"], ["memory", "Memory index"], ["other", "WORKERS"]]);

    engine.writeFile({ botId: bot.id, path: "memory/topics/customers.md", text: "# Customers\n" });
    engine.writeFile({ botId: bot.id, path: "skills/triage/SKILL.md", text: "# Triage\n" });
    engine.writeFile({ botId: bot.id, path: "notes.txt", text: "hello" });
    engine.writeFile({ botId: bot.id, path: "memory/a.md", text: "a" });
    const files = engine.listFiles(bot.id);
    assert.deepEqual(files.map((f) => f.path), ["AGENTS.md", "memory/MEMORY.md", "memory/a.md", "memory/topics/customers.md", "skills/triage/SKILL.md", "notes.txt", "WORKERS.md"]);
    assert.deepEqual(files.map((f) => f.kind), ["job", "memory", "memory", "memory", "skill", "other", "other"]);
    assert.equal(files.find((f) => f.path === "memory/topics/customers.md")?.title, "customers");
    assert.equal(files.find((f) => f.path === "skills/triage/SKILL.md")?.title, "triage");
    assert.ok(files.every((f) => f.size >= 0 && !Number.isNaN(Date.parse(f.modifiedAt))));
    // bot.json, CLAUDE.md, .git and hidden files never show.
    assert.ok(!files.some((f) => /bot\.json|CLAUDE\.md|^\.|\/\./.test(f.path)));
    store.close();
  });

  test("leaves out binary files, files over 1 MB and links that leave the folder", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "# Job\n");
    writeFileSync(join(dir, "bot.json"), "{}");
    writeFileSync(join(dir, "picture.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(1024 * 1024 + 1));
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    assert.deepEqual(listFiles(dir).map((f) => f.path), ["AGENTS.md"]);
  });

  test("refuses paths outside the folder and files Pobots keeps, in plain words", () => {
    const refusals: [string, RegExp][] = [
      ["/etc/passwd", /inside the bot's folder/],
      ["../other/AGENTS.md", /inside the bot's folder/],
      ["memory/../../x", /inside the bot's folder/],
      ["~/x", /inside the bot's folder/],
      ["C:/x", /inside the bot's folder/],
      [".git/config", /history folder/],
      ["bot.json", /Settings/],
      ["CLAUDE.md", /points to the job/],
      [".claude/settings.local.json", /Hidden files/],
      ["memory\\x.md", /forward slashes/],
      ["", /needs a name/],
    ];
    for (const [path, words] of refusals) {
      assert.throws(() => checkPath(path), (err: unknown) => err instanceof EngineError && err.code === "bad_request" && words.test(err.message), path);
    }
    assert.equal(checkPath("./memory//MEMORY.md"), "memory/MEMORY.md");
    assert.equal(fileTitle("memory/MEMORY.md"), "Memory index");

    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "x.md"), "x");
    symlinkSync(outside, join(dir, "away"));
    assert.throws(() => readTextFile(dir, "away/x.md"), /outside the bot's folder/);
    assert.throws(() => writeTextFile(dir, "away/new.md", "x"), /outside the bot's folder/);
    assert.ok(!existsSync(join(outside, "new.md")));
    assert.throws(() => writeTextFile(dir, "big.md", "x".repeat(1024 * 1024 + 1)), /larger than 1 MB/);
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    assert.throws(() => readTextFile(dir, "bin.dat"), /not a text file/);
    assert.throws(() => readTextFile(dir, "missing.md"), code("not_found"));
  });

  test("a write with a stale baseRev fails with conflict and leaves the file alone", () => {
    const { engine, store } = setup();
    const bot = engine.createBot("Kaja");
    const read = engine.readFile({ botId: bot.id, path: "memory/MEMORY.md" });
    const saved = engine.writeFile({ botId: bot.id, path: "memory/MEMORY.md", text: "first", baseRev: read.rev });
    assert.notEqual(saved.rev, read.rev);
    assert.throws(
      () => engine.writeFile({ botId: bot.id, path: "memory/MEMORY.md", text: "second", baseRev: read.rev }),
      (err: unknown) => err instanceof EngineError && err.code === "conflict" && /changed after you opened it/.test(err.message),
    );
    assert.equal(engine.readFile({ botId: bot.id, path: "memory/MEMORY.md" }).text, "first");
    assert.equal(engine.readFile({ botId: bot.id, path: "memory/MEMORY.md" }).rev, saved.rev);
    // A new file with a baseRev that names old content: it does not exist, so that is a conflict too.
    assert.throws(() => engine.writeFile({ botId: bot.id, path: "memory/gone.md", text: "x", baseRev: read.rev }), code("conflict"));
    assert.throws(() => engine.deleteFile({ botId: bot.id, path: "AGENTS.md" }), /job cannot be removed/);
    store.close();
  });
});

describe("history and undo", { skip: !gitAvailable() && "git is not installed" }, () => {
  test("a turn's changes are saved when the folder has the harness's own local settings (named in .gitignore)", async () => {
    const { engine, store, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const dir = join(dirs.botsDir, bot.id);
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.claude\/settings\.local\.json$/m);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), '{ "permissions": { "allow": [] } }\n');
    writeFileSync(join(dir, "bot.json.tmp"), "{}");
    engine.sendMessage({ botId: bot.id, text: "Remember y" });
    await settle();
    writeFileSync(join(dir, "memory", "MEMORY.md"), "# Memory\n\ny\n");
    sessions[0]!.reply("Done");
    await settle();
    const h = engine.history({ botId: bot.id });
    assert.equal(h.changes[0]?.summary, "Kaja changed MEMORY.md", "the turn's change was saved");
    const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" });
    assert.doesNotMatch(tracked, /settings\.local\.json|bot\.json\.tmp/);
    engine.shutdown();
    store.close();
  });

  test("saves each change with who made it, reads it back and undoes it", async () => {
    const { engine, store, events, sessions, dirs } = setup();
    const bot = engine.createBot("Kaja");
    const dir = join(dirs.botsDir, bot.id);

    const job = engine.readFile({ botId: bot.id, path: "AGENTS.md" });
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: job.text + "\nMore rules.\n", baseRev: job.rev });
    engine.writeFile({ botId: bot.id, path: "memory/topics/a.md", text: "A\n" });
    engine.deleteFile({ botId: bot.id, path: "memory/topics/a.md" });
    assert.ok(!existsSync(join(dir, "memory", "topics")), "the empty folder was left behind");

    // A turn in which the bot changes files is saved as one change by the bot.
    engine.sendMessage({ botId: bot.id, text: "Remember x" });
    await settle();
    writeFileSync(join(dir, "memory", "MEMORY.md"), "# Memory\n\nx\n");
    sessions[0]!.reply("Done");
    await settle();

    const changed = events.filter((e) => e.event === "bot.files.changed").map((e) => (e.data as Events["bot.files.changed"]).paths);
    assert.deepEqual(changed, [["AGENTS.md"], ["memory/topics/a.md"], ["memory/topics/a.md"], ["memory/MEMORY.md"]]);

    const h = engine.history({ botId: bot.id });
    assert.deepEqual(
      h.changes.map((c) => [c.by, c.summary]),
      [
        ["bot", "Kaja changed MEMORY.md"],
        ["you", "Removed memory/topics/a.md"],
        ["you", "Added memory/topics/a.md"],
        ["you", "Edited the job"],
        ["app", "Created the bot"],
      ],
    );
    assert.equal(h.hasMore, false);
    const page = engine.history({ botId: bot.id, before: h.changes[1]!.id, limit: 2 });
    assert.deepEqual(page.changes.map((c) => c.summary), ["Added memory/topics/a.md", "Edited the job"]);
    assert.equal(page.hasMore, true);
    assert.throws(() => engine.history({ botId: bot.id, before: "0123456789abcdef" }), code("not_found"));

    const jobChange = h.changes[3]!;
    const read = engine.readChange({ botId: bot.id, changeId: jobChange.id });
    assert.deepEqual(read.change.files, ["AGENTS.md"]);
    assert.match(read.diff, /^\+More rules\./m);

    // Undo the job edit: a new change by the app, and the file is as before.
    const undo = engine.undoChange({ botId: bot.id, changeId: jobChange.id });
    assert.equal(undo.change.by, "app");
    assert.equal(undo.change.summary, "Undid: Edited the job");
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), job.text);
    assert.deepEqual((events.at(-1)!.data as Events["bot.files.changed"]).paths, ["AGENTS.md"]);

    // Undoing it again cannot apply cleanly: conflict, and the folder stays as it was.
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.throws(() => engine.undoChange({ botId: bot.id, changeId: jobChange.id }), code("conflict"));
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before);

    // A file the bot is changing right now (not saved yet) blocks an undo of a change to it.
    const memChange = engine.history({ botId: bot.id }).changes.find((c) => c.by === "bot")!;
    writeFileSync(join(dir, "memory", "MEMORY.md"), "half written");
    assert.throws(() => engine.undoChange({ botId: bot.id, changeId: memChange.id }), code("conflict"));
    assert.equal(readFileSync(join(dir, "memory", "MEMORY.md"), "utf8"), "half written");

    // The change that made the bot cannot be undone.
    const first = engine.history({ botId: bot.id, limit: 50 }).changes.at(-1)!;
    assert.throws(() => engine.undoChange({ botId: bot.id, changeId: first.id }), /made the bot/);
    engine.shutdown();
    store.close();
  });

  test("the person's git settings play no part, and settings changes are not saved as changes", async () => {
    // A global git config that would break every commit: signing with a program that fails, and a hook that refuses.
    const home = tempDir();
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(home, "gitconfig"), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${hooks}\n[user]\n\tname = Someone Else\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    try {
      const { engine, store } = setup();
      const bot = engine.createBot("Kaja");
      await engine.updateBot({ botId: bot.id, patch: { purpose: "Sorts mail" } });
      engine.writeFile({ botId: bot.id, path: "notes.md", text: "n" });
      const log = engine.history({ botId: bot.id }).changes;
      assert.deepEqual(log.map((c) => c.summary), ["Added notes.md", "Created the bot"]);
      assert.deepEqual(log[0]!.files, ["notes.md"]);
      store.close();
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  test("a job change while the harness is awake restarts it before the next turn, with a note", async () => {
    const { engine, store, sessions } = setup();
    const bot = engine.createBot("Kaja");
    engine.sendMessage({ botId: bot.id, text: "Hi" });
    await settle();
    sessions[0]!.reply("Hello");
    await settle();
    assert.equal(sessions[0]!.closed, false);
    const job = engine.readFile({ botId: bot.id, path: "AGENTS.md" });
    engine.writeFile({ botId: bot.id, path: "AGENTS.md", text: job.text.replace("Not written yet.", "Sort the mail."), baseRev: job.rev });
    assert.equal(sessions[0]!.closed, true, "the harness kept the old job");
    engine.sendMessage({ botId: bot.id, text: "Go on" });
    await settle();
    const s = sessions[1]!;
    assert.equal(s.settings.resume, "sess-1", "the conversation was not kept");
    assert.match(s.sent[0]!.before.join("\n"), /your job in AGENTS\.md was changed/);
    engine.shutdown();
    store.close();
  });
});
