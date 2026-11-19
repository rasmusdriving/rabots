// The app check, section "todo": step 23 (7c), a to-do a real bot adds and the window answers.
// Run it alone: node scripts/app-check.mjs --only=todo
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { downloadSamples, savedDownload } from "../../download-fixtures.mjs";
import { sleep, check, sideChannel, js, cmd, shot, until, openWindow, run, botsDir, work } from "../lib.mjs";

// 23. A to-do for the person (step 7c): a real Claude bot adds one with its tool; the window shows it
//     at the foot of the rail; the person opens it, picks a choice and presses the bot's button; the
//     bot is woken with that as his message and acts on it; the to-do is off the list.
export default async function section() {
  const { endpoint, cheap } = run;
  const s23 = await sideChannel(endpoint);
  const snap23 = await s23.request("snapshot");
  const claude23 = snap23.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot23 = (await s23.request("bot.create", { name: "Todoer", purpose: "Adds a to-do for the to-do check", job: "Do what you are asked, briefly.", model: claude23.id, effort: claude23.efforts.includes("low") ? "low" : claude23.defaultEffort, access: "asks-first" })).bot;
  const out = join(botsDir, bot23.id, "out");
  mkdirSync(out);
  for (const [name, bytes] of Object.entries(downloadSamples)) writeFileSync(join(out, name), bytes);
  const files = Object.keys(downloadSamples);
  const artifactTitle = "Download sample page";
  const artifactPath = "artifacts/downloads/index.html";
  const artifactDir = join(botsDir, bot23.id, "artifacts/downloads");
  mkdirSync(artifactDir, { recursive: true });
  const zipUrl = encodeURIComponent(files[0]);
  writeFileSync(join(artifactDir, files[0]), downloadSamples[files[0]]);
  writeFileSync(join(artifactDir, "index.html"), `<!doctype html><title>${artifactTitle}</title><body style="margin:0"><a style="display:block;padding:16px" href="${zipUrl}?download">Download sample zip</a><a style="display:block;padding:16px" href="${zipUrl}">Ordinary zip link</a></body>`);
  const blocks = files.map((name, i) => ({ type: "file", path: `out/${name}`, label: i === 0 ? "The skill (zip)" : "Preview.pdf" }));
  await openWindow(endpoint);
  await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);
  await s23.request("message.send", {
    botId: bot23.id,
    text: `This is a test inside Pobots only. Use the Pobots tool add_todo (mcp__pobots__add_todo) once; use no connectors or MCP servers, change no files outside your own folder. Title "Choose a city", why "For the to-do check", one field block with id city, label City, input choice and choices Oslo and Lima, and one button with label Send. Include these existing file blocks as given: ${JSON.stringify(blocks)}. Use the built-in Pobots tool show_artifact (mcp__pobots__show_artifact) once with path ${artifactPath} and title ${artifactTitle}; never publish. Then reply with one short sentence. Later, when my answer to that to-do comes, reply with only the city I chose.`,
  });
  const row23 = await until(`(() => { const r = [...document.querySelectorAll(".app-rail .pb-todo-item")].find((x) => x.querySelector(".pb-todo-name")?.textContent === "Choose a city"); return r && { id: r.dataset.todoId, when: r.querySelector(".pb-todo-when").textContent, title: document.querySelector(".app-rail .pb-todo-title")?.firstChild?.textContent }; })()`, 180_000);
  check("to-do: the bot's to-do shows at the foot of the rail, under Your to-do", !!row23 && row23.title === "Your to-do" && /^(now|\d+ min)$/.test(row23.when), JSON.stringify(row23));
  // Its turn ends before the answer comes.
  await until(`(() => { const b = [...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === "Todoer"); return !!b; })()`, 5000);
  const rest23 = Date.now() + 120_000;
  while (Date.now() < rest23) {
    const b = (await s23.request("snapshot")).bots.find((x) => x.id === bot23.id);
    if (b && (b.state === "done" || b.state === "idle")) break;
    await sleep(500);
  }
  if (row23) {
    await js(`(() => { const r = document.querySelector('.app-rail .pb-todo-item[data-todo-id="${row23.id}"]'); r.focus(); r.click(); })()`);
    const win23 = await until(`(() => { const d = document.querySelector(".pb-dialog"); return d && { title: d.querySelector(".pb-dialog-title")?.textContent, choices: [...d.querySelectorAll(".pb-choice")].map((c) => c.textContent), buttons: [...d.querySelectorAll(".pb-todo-actions button")].map((x) => x.textContent) }; })()`, 10_000);
    check("to-do: its window shows the bot's field and button, with Mark done and Dismiss", JSON.stringify(win23?.choices) === JSON.stringify(["Oslo", "Lima"]) && JSON.stringify(win23.buttons) === JSON.stringify(["Dismiss", "Mark done", "Send"]), JSON.stringify(win23));
    const chip = (name) => `[...document.querySelectorAll(".pb-dialog .pb-todo-file")].find((e) => e.download === ${JSON.stringify(name)})`;
    check("to-do downloads: the zip chip shows the label and its actual filename", !!(await js(`(() => { const e = ${chip(files[0])}; return e?.textContent.includes("The skill (zip)") && e.textContent.includes(${JSON.stringify(files[0])}); })()`)));
    for (const name of files) {
      const path = join(work, "saved");
      const saved = await savedDownload({ cmd, path, name, expected: readFileSync(join(out, name)), click: () => js(`${chip(name)}?.click()`) });
      check(`to-do downloads: Chromium saves ${name} with the original SHA-256`, saved);
      if (saved && name.endsWith(".zip")) {
        check("to-do downloads: the saved zip opens", /Hello from a zip/.test(execFileSync("unzip", ["-p", join(path, name), "readme.txt"], { encoding: "utf8" })));
      }
    }
    await shot("70-todo-window");
    await js(`[...document.querySelectorAll(".pb-dialog .pb-choice")].find((c) => c.textContent === "Lima").click()`);
    await js(`[...document.querySelectorAll(".pb-dialog .pb-todo-actions button")].find((x) => x.textContent === "Send").click()`);
    const off = await until(`!document.querySelector(".pb-dialog") && !document.querySelector('.app-rail .pb-todo-item[data-todo-id="${row23.id}"]')`, 15_000);
    check("to-do: the answer closes the window and takes the to-do off the list", !!off);
    const end23 = Date.now() + 180_000;
    let items23 = [];
    while (Date.now() < end23) {
      items23 = (await s23.request("thread.read", { threadId: bot23.mainThreadId, limit: 100 })).items;
      const answered = items23.findIndex((i) => i.kind === "user" && i.from?.todo?.id === row23.id);
      const b = (await s23.request("snapshot")).bots.find((x) => x.id === bot23.id);
      if (answered >= 0 && items23.slice(answered + 1).some((i) => i.kind === "bot" && !i.streaming) && b && (b.state === "done" || b.state === "idle")) break;
      await sleep(1000);
    }
    const at23 = items23.findIndex((i) => i.kind === "user" && i.from?.todo?.id === row23.id);
    const msg23 = items23[at23];
    // Test bots see the person's own connectors and MCP servers (one has a to-do tool of its own): none may be used.
    const outside23 = items23.filter((i) => i.kind === "activity" && ((/^(Used|Using) .+ in /.test(i.label ?? "") && !/ in pobots$/i.test(i.label ?? "")) || /workbot/i.test(`${i.label} ${i.detail ?? ""}`)));
    check("to-do: no connector or MCP server outside Pobots was used", outside23.length === 0, outside23.map((i) => i.label).join("; "));
    check("to-do: the bot got his answer as his message, marked from the to-do", msg23?.from?.type === "you" && msg23.from.todo?.title === "Choose a city" && msg23.text === 'Pressed "Send".\nCity: Lima', JSON.stringify(msg23));
    const reply23 = items23.slice(at23 + 1).filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    check("to-do: the bot acted on it: its answer names the city he chose", /lima/i.test(reply23) && !/oslo/i.test(reply23), reply23.slice(-120));
    await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === "Todoer").click()`);
    const mark23 = await until(`[...document.querySelectorAll(".app-main .pb-from-todo")].some((n) => n.textContent === "From your to-do: Choose a city")`, 15_000);
    check("to-do: the window marks his answer From your to-do", !!mark23);
    await shot("71-todo-answer");

    const artifact = `[...document.querySelectorAll(".pb-artifact")].find((e) => e.textContent.includes(${JSON.stringify(artifactTitle)}))`;
    if (await until(artifact + "?.textContent", 3000)) {
      await js(artifact + ".click()");
      const frame = await until(`(() => {
        const frame = document.querySelector(${JSON.stringify(`iframe[title="${artifactTitle}"]`)});
        if (!frame || !frame.getBoundingClientRect().width || !frame.src.includes("/page/")) return false;
        const r = frame.getBoundingClientRect();
        return { x: r.left + 35, y: r.top + 26 };
      })()`, 12_000);
      if (frame) {
        await sleep(500);
        for (const [label, dy] of [["explicit", 0], ["ordinary", 50]]) {
          const saved = await savedDownload({
            cmd, path: join(work, "saved-artifact-" + label), name: files[0], expected: downloadSamples[files[0]],
            click: async () => {
              const point = { x: frame.x, y: frame.y + dy, button: "left", clickCount: 1 };
              await cmd("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
              await cmd("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
            },
          });
          check(`artifact downloads: ${label} link inside the sandbox saves the zip unchanged`, saved);
        }
      } else check("artifact downloads: the real artifact opens in the app's sandbox", false);
    } else check("artifact downloads: the real bot showed the artifact", false);
  }
  s23.close();
}
