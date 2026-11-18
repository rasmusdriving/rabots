// The app check, section "todo": step 23 (7c), a to-do a real bot adds and the window answers.
// Run it alone: node scripts/app-check.mjs --only=todo
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { sleep, check, sideChannel, js, shot, until, openWindow, run } from "../lib.mjs";

// 23. A to-do for the person (step 7c): a real Claude bot adds one with its tool; the window shows it
//     at the foot of the rail; the person opens it, picks a choice and presses the bot's button; the
//     bot is woken with that as his message and acts on it; the to-do is off the list.
export default async function section() {
  const { endpoint, cheap } = run;
  const s23 = await sideChannel(endpoint);
  const snap23 = await s23.request("snapshot");
  const claude23 = snap23.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot23 = (await s23.request("bot.create", { name: "Todoer", purpose: "Adds a to-do for the to-do check", job: "Do what you are asked, briefly.", model: claude23.id, effort: claude23.efforts.includes("low") ? "low" : claude23.defaultEffort, access: "asks-first" })).bot;
  await openWindow(endpoint);
  await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);
  await s23.request("message.send", {
    botId: bot23.id,
    text: 'This is a test inside Pobots only. Use the Pobots tool add_todo (mcp__pobots__add_todo) once, and no connector or other MCP server: title "Choose a city", why "For the to-do check", one block of type field with id city, label City, input choice and choices Oslo and Lima, and one button with the label Send. Then reply with one short sentence. Later, when my answer to that to-do comes, reply with only the city I chose.',
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
  }
  s23.close();
}
