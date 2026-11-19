// The window check: a click has to save a file, even when the label is not its name.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadSamples, savedDownload } from "../../download-fixtures.mjs";
import { b, check, ev, goTo, key, open, until, work } from "../lib.mjs";

export default async function section() {
  const save = (sel, name, expected, source) => savedDownload({
    cmd: b.cmd, path: join(work, source), name, expected,
    click: () => ev(`document.querySelector(${JSON.stringify(sel)})?.click()`),
  });
  const label = "The skill (zip)";
  const name = "Read this [åäö].txt";
  await open("todos=1");
  await goTo("Kaja", "files");
  const memoName = "MEMORY.md";
  const memoryDownload = `a[download="${memoName}"]`;
  const editable = await until(`document.querySelector(".pb-editor-text")?.value`);
  check("downloads: the Files tab saves the file by its original name", typeof editable === "string" && await save(memoryDownload, memoName, Buffer.from(editable), "files"));
  await ev(`window.pobotsTodos.add({botId:"kaja",title:"Check file downloads",blocks:[
    {type:"file",path:${JSON.stringify("out/" + name)},name:${JSON.stringify(label)},picture:false},
    {type:"text",text:"[Read the file](memory/MEMORY.md) · [Outside](file:///nope.xlsx) · [Website](https://example.org)."},
    {type:"copy",text:"A draft."},{type:"link",label:"Visit",url:"https://example.org"}
  ]})`);
  await ev(`[...document.querySelectorAll(".pb-todo-item")].find((e) => e.textContent.includes("Check file downloads")).click()`);
  const todo = `a.pb-todo-file[download=${JSON.stringify(name)}]`;
  const details = await until(`document.querySelector(".pb-dialog .pb-todo-file")?.textContent`);
  check("downloads: the old to-do block shows its label and actual name", details?.includes(label) && details.includes(name), details);
  check("downloads: the to-do saves the actual name and bytes", await save(todo, name, Buffer.from(`A sample of ${label}.\n`), "todo"));
  const md = `.pb-dialog .pb-md-file a[download="${memoName}"]`;
  const good = await until(`document.querySelector(${JSON.stringify(md)})?.textContent`);
  check("downloads: the Markdown label saves the file from this bot's folder", good === "Read the file" && await save(md, memoName, Buffer.from(editable), "markdown"));
  const links = await ev(`(() => {
    const d = document.querySelector(".pb-dialog");
    const bad = [...d.querySelectorAll(".pb-md-file")].find((x) => x.textContent.includes("Outside"));
    return [bad?.textContent, !!bad?.querySelector("a"), d.querySelector(".pb-todo-copy a") === null, d.querySelector(".pb-todo-link").getAttribute("href"), d.querySelector(".pb-todo-text a[target=_blank]").getAttribute("href")];
  })()`);
  check("downloads: missing links are inert, Copy stays text, and web links stay web links", JSON.stringify(links) === JSON.stringify(["Outside · File unavailable", false, true, "https://example.org", "https://example.org"]), links);
  await key("Escape");
  await goTo("Kaja");
  const entries = Object.entries(downloadSamples).slice(0, 4);
  const paths = entries.map(([filename, bytes]) => {
    const p = join(work, filename);
    writeFileSync(p, bytes);
    return p;
  });
  const input = await b.cmd("Runtime.evaluate", { expression: 'document.querySelector(".pb-attach-input")' });
  await b.cmd("DOM.setFileInputFiles", { objectId: input.result.result.objectId, files: paths });
  await until(`document.querySelectorAll(".pb-tray .pb-chip-file[data-status=done]").length === ${entries.length}`);
  await ev(`document.querySelector(".app-main .pb-composer textarea").focus()`);
  await key("Enter");
  await until(`document.querySelectorAll(".app-main a.pb-msg-file[download]").length >= ${entries.length}`);
  for (const [filename, bytes] of entries) {
    const attachment = `a.pb-msg-file[download=${JSON.stringify(filename)}]`;
    check(`downloads: the chat attachment saves ${filename} with the original SHA-256`, await save(attachment, filename, bytes, "attachment"));
  }
}
