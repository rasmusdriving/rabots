import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseEnvFile, readEnvFile } from "../envfile.js";
import { tempDir } from "./helpers.js";

describe("env file", () => {
  test("reads plain and exported lines", () => {
    const env = parseEnvFile("A=1\nexport B=two\n  export   C=three  \n");
    assert.deepEqual(env, { A: "1", B: "two", C: "three" });
  });

  test("skips comments, blank lines and lines that are not assignments", () => {
    const env = parseEnvFile("# comment\n\n   \nnot a line\n=nope\n1BAD=x\nGOOD=yes\n");
    assert.deepEqual(env, { GOOD: "yes" });
  });

  test("handles quotes, escapes and trailing comments", () => {
    const env = parseEnvFile(
      [`D="with spaces # not a comment"`, `E='single $NOT_EXPANDED'`, `F=plain # a comment`, `G="a\\"b\\nc"`, `H=`, `I=a=b=c`].join("\n"),
    );
    assert.equal(env.D, "with spaces # not a comment");
    assert.equal(env.E, "single $NOT_EXPANDED");
    assert.equal(env.F, "plain");
    assert.equal(env.G, 'a"b\nc');
    assert.equal(env.H, "");
    assert.equal(env.I, "a=b=c");
  });

  test("handles Windows line endings", () => {
    assert.deepEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  });

  test("reads a file, and gives undefined for a missing one", () => {
    const dir = tempDir();
    const path = join(dir, "x.env");
    writeFileSync(path, "export X=1\n");
    assert.deepEqual(readEnvFile(path), { X: "1" });
    assert.equal(readEnvFile(join(dir, "missing.env")), undefined);
  });
});
