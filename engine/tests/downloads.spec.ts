import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { downloadFileName, markdownFilePath } from "../../shared/downloads.js";
import { fileDisposition } from "../downloads.js";
import { EngineServer } from "../server.js";
import { newTodo } from "../todos.js";
import { setup } from "./fake.js";

test("folder and stored to-do downloads stream exact bytes and both real filenames", async () => {
  const w = setup();
  const bot = w.engine.createBot("Download test");
  const dir = join(w.dirs.botsDir, bot.id);
  const at = new Date().toISOString();
  const files = [
    ["artifacts/Skillen.zip", "Skillen (zip)", "Skillen.zip"],
    ["artifacts/Rapport [å ä ö].pdf", "Wrong.xlsx", "Rapport [å ä ö].pdf"],
    ["artifacts/report.v2.tar.gz", "", "report.v2.tar.gz"],
    ["artifacts/README", "Read me.txt", "README"],
  ] as const;
  const bytes = Buffer.from([0, 255, 13, 10, 21, 9]);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  for (const [path] of files) writeFileSync(join(dir, path), bytes);
  mkdirSync(join(dir, ".private"));
  writeFileSync(join(dir, ".private", "secret.txt"), "not visible");
  symlinkSync(join(dir, ".private", "secret.txt"), join(dir, "hidden.txt"));
  symlinkSync(w.dirs.dataDir, join(dir, "elsewhere"));
  const todo = newTodo(bot.id, { title: "Files", blocks: files.map(([path, label]) => ({ type: "file", path, label })) }, { botDir: dir, page: () => "No page" }, at);
  w.store.saveTodo({ status: "open", todo });
  const old = { ...todo, id: "todo_oldstoredfile001", blocks: [{ type: "file" as const, path: files[0][0], name: "Old label.pdf", picture: false }] };
  w.store.saveTodo({ status: "open", todo: old });
  const token = "test-token-for-file-downloads";
  const server = new EngineServer(token, { allowedLogins: [] });
  server.attach(w.engine);
  const port = await server.listen(0);
  const request = (path: string, params: Record<string, string> = {}, method = "GET") =>
    fetch(`http://127.0.0.1:${port}${path}?${new URLSearchParams({ token, ...params })}`, { method });
  const folder = `/api/bots/${bot.id}/download`;
  const check = async (res: Response, name: string, head = false) => {
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.match(res.headers.get("content-disposition")!, /^attachment; filename="[ -~]+"; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(res.headers.get("content-disposition")!.split("UTF-8''")[1]!), name);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), head ? Buffer.alloc(0) : bytes);
  };
  try {
    for (const [i, [path, label, name]] of files.entries()) {
      assert.equal(downloadFileName(path), name);
      const block = todo.blocks[i]!;
      assert.equal(block.type === "file" && block.name, label || name);
      await check(await request(`/api/todos/${todo.id}/files/${i}`), name);
      await check(await request(folder, { path: "./" + path }), name);
      await check(await request(folder, { path: join(dir, path) }, "HEAD"), name, true);
    }
    await check(await request(`/api/todos/${old.id}/files/0`), "Skillen.zip");
    assert.equal(fileDisposition("Rapport [å ä ö].pdf", false), 'attachment; filename="Rapport [_ _ _].pdf"; filename*=UTF-8\'\'Rapport%20%5B%C3%A5%20%C3%A4%20%C3%B6%5D.pdf');
    const inventory = await (await request(`/api/bots/${bot.id}/downloads`)).json() as { files: { path: string; downloadOnly?: boolean }[] };
    assert.ok(inventory.files.some((f) => f.path === files[0][0] && f.downloadOnly));
    assert.ok(!inventory.files.some((f) => f.path === "hidden.txt"));
    for (const path of ["/etc/hosts", "../outside.txt", "elsewhere/config.json", "bot.json", "hidden.txt", ".private/secret.txt", "missing.zip", "artifacts"]) {
      const res = await request(folder, { path });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("content-disposition"), null);
      await res.text();
    }
    const refused = await request(folder, { token: "wrong", path: files[0][0] });
    assert.equal(refused.status, 401);
    await refused.text();
  } finally {
    await server.close();
    await w.engine.shutdown();
    w.store.close();
  }
});

test("Markdown distinguishes checked paths from website links and unsupported local targets", () => {
  assert.equal(markdownFilePath("file:///bot/F%C3%A4rdigt%20%5Bzip%5D.zip"), "/bot/Färdigt [zip].zip");
  assert.equal(markdownFilePath("file://localhost/bot/report.v2.tar.gz"), "/bot/report.v2.tar.gz");
  assert.equal(markdownFilePath("./out/README"), "./out/README");
  assert.equal(markdownFilePath("out/a%23b.pdf"), "out/a#b.pdf");
  for (const v of ["https://example.org/x.zip", "mailto:a@example.org", "#notes", "javascript:alert(0)"]) {
    assert.equal(markdownFilePath(v), undefined, v);
  }
  for (const v of ["file://elsewhere/out/a.txt", "sandbox:/mnt/data/a.txt", "//host/share/a.zip", "C:/Downloads/a.zip", "out/%2Fetc"]) {
    assert.equal(markdownFilePath(v), null, v);
  }
});
