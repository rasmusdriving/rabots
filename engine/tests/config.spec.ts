import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { defaultDataDir, parseFlags, resolveConfig, SERVE_PORT } from "../config.js";
import { tempDir } from "./helpers.js";

describe("config", () => {
  test("parses flags in both forms", () => {
    assert.deepEqual(parseFlags(["--port=0", "--data-dir=/tmp/a", "--bots-dir", "/tmp/b", "--other"]), {
      port: 0,
      dataDir: "/tmp/a",
      botsDir: "/tmp/b",
    });
    assert.throws(() => parseFlags(["--port=abc"]));
  });

  test("platform defaults", () => {
    assert.equal(defaultDataDir("darwin"), join(homedir(), "Library", "Application Support", "Pobots"));
    assert.equal(defaultDataDir("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }), join("C:\\Users\\x\\AppData\\Roaming", "Pobots"));
    assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "/xdg" }), join("/xdg", "pobots-engine"));
    assert.equal(defaultDataDir("linux", {}), join(homedir(), ".local", "share", "pobots-engine"));
  });

  test("creates config.json when missing, and flags win over the file", () => {
    const root = tempDir();
    const dataDir = join(root, "data");
    const flagBots = join(root, "flag-bots");
    const c1 = resolveConfig({ dataDir, botsDir: flagBots });
    assert.ok(existsSync(join(dataDir, "config.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")), { claude: {} });
    assert.equal(c1.botsDir, flagBots);
    assert.equal(c1.port, 0);

    const fileBots = join(root, "file-bots");
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ botsDir: fileBots, machineName: "Mac mini", claude: { executable: "/x/claude", envFile: "/x/env" } }),
    );
    const c2 = resolveConfig({ dataDir });
    assert.equal(c2.botsDir, fileBots);
    assert.ok(existsSync(fileBots));
    assert.equal(c2.machineName, "Mac mini");
    assert.deepEqual(c2.claude, { executable: "/x/claude", envFile: "/x/env" });
    assert.equal(resolveConfig({ dataDir, botsDir: flagBots }).botsDir, flagBots);
  });

  test("a broken config.json is reported", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "config.json"), "{ nope");
    assert.throws(() => resolveConfig({ dataDir, botsDir: join(dataDir, "bots") }), /not valid JSON/);
  });

  test("--serve is a switch and never eats the next argument", () => {
    assert.deepEqual(parseFlags(["--serve", "--port=5"]), { serve: true, port: 5 });
    assert.deepEqual(parseFlags(["--serve", "extra"]), { serve: true });
    assert.deepEqual(parseFlags(["--serve=false"]), { serve: false });
    assert.deepEqual(parseFlags(["--serve=1", "--ui-dir=/tmp/ui"]), { serve: true, uiDir: "/tmp/ui" });
    assert.throws(() => parseFlags(["--serve=maybe"]));
  });

  test("serve mode: fixed port, config.json's port and remote access", () => {
    const dataDir = tempDir();
    const botsDir = join(dataDir, "bots");
    // Without serve mode: a random port, even when config.json names one.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: 47700 }));
    const plain = resolveConfig({ dataDir, botsDir });
    assert.equal(plain.serve, false);
    assert.equal(plain.port, 0);
    assert.deepEqual(plain.remote, { allowedLogins: [] });

    // --serve: the default port, then config.json's, then the flag's.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
    assert.equal(resolveConfig({ dataDir, botsDir, serve: true }).port, SERVE_PORT);
    assert.equal(SERVE_PORT, 47600);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ serve: true, port: 47700, remote: { allowedLogins: [" A@Example.com ", ""] } }));
    const served = resolveConfig({ dataDir, botsDir });
    assert.equal(served.serve, true);
    assert.equal(served.port, 47700);
    assert.deepEqual(served.remote, { allowedLogins: ["A@Example.com"] });
    assert.equal(resolveConfig({ dataDir, botsDir, port: 0 }).port, 0);
    assert.equal(resolveConfig({ dataDir, botsDir, serve: false }).serve, false);
  });

  test("wrong serve settings are reported", () => {
    const dataDir = tempDir();
    const botsDir = join(dataDir, "bots");
    for (const bad of [{ serve: "yes" }, { port: 70000 }, { port: "1" }, { remote: [] }, { remote: { allowedLogins: "a@b.c" } }, { remote: { allowedLogins: [1] } }]) {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(bad));
      assert.throws(() => resolveConfig({ dataDir, botsDir }), Error, JSON.stringify(bad));
    }
  });
});
