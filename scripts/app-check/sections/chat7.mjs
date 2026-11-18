// The app check, section "chat7": step 20 (7a), job 7's chat: to-do lists, kinds of work, thinking summaries.
// Run it alone: node scripts/app-check.mjs --only=chat7
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { sleep, check, sideChannel, collectCodexThreads, js, shot, until, openWindow, run } from "../lib.mjs";

// 20. Job 7, the chat (step 7a): a real bot on Claude and one on Codex keep their own to-do list with
//     their harness's tool, which reaches Bot.plan step by step; lines of work say their kind; a
//     thinking summary from Claude reaches the chat as a line of its own; in the window the work
//     folds into lines with their icons.
export default async function section() {
  const { endpoint, cheap } = run;
  const s20 = await sideChannel(endpoint);
  const end20 = Date.now() + 90_000;
  let snap20 = await s20.request("snapshot");
  while (!snap20.status.codex?.ready && Date.now() < end20) {
    await sleep(1000);
    snap20 = await s20.request("snapshot");
  }
  const claude20 = snap20.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const gpt20 = snap20.status.codex?.ready ? (snap20.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap20.models.find((m) => m.harness === "codex")) : undefined;
  check("chat7: Codex is ready for the GPT half", !!gpt20, gpt20?.label ?? snap20.status.codex?.problem ?? "no GPT model");
  // The harness's own tool by name, and no connectors: on 14 Nov 2026 a GPT bot asked for "your to-do
  // tool" used a to-do tool of the person's own MCP servers instead (a real list outside Pobots).
  const TASK20 = (harness) =>
    `This is a small test inside your own folder. Do not use any connectors or MCP tools. First write a to-do list of three steps with ${harness === "codex" ? "your update_plan tool" : "your TaskCreate tool"}. Then do the steps one by one, keeping the list up to date with ${harness === "codex" ? "update_plan" : "TaskUpdate"} as each starts and ends: run "echo one", then "echo two", then "echo three" with your shell tool, one call each. Think briefly about the order before you start. End with one short sentence.`;
  const wait20 = async (fn, ms, every = 300) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return undefined;
      await sleep(every);
    }
  };
  for (const [name, model, effort] of [["Planclaude", claude20, "high"], ["Plangpt", gpt20, "low"]]) {
    if (!model) continue;
    const tag = model.harness === "codex" ? "Codex" : "Claude";
    const bot = (await s20.request("bot.create", { name, purpose: "Runs short commands for the to-do list check", job: "Do what you are asked, briefly, inside your own folder only.", model: model.id, effort: model.efforts.includes(effort) ? effort : model.defaultEffort, access: "full-access" })).bot;
    check(`chat7 (${tag}): the new bot has a colour`, !!bot.look.color, JSON.stringify(bot.look));
    await s20.request("message.send", { botId: bot.id, text: TASK20(model.harness) });
    // The list as it grows and changes, read while the turn runs.
    const seen = { most: 0, doing: false };
    const rested = await wait20(async () => {
      const b = (await s20.request("snapshot")).bots.find((x) => x.id === bot.id);
      if (b?.plan) {
        seen.most = Math.max(seen.most, b.plan.steps.length);
        if (b.plan.steps.some((x) => x.status === "inProgress")) seen.doing = true;
      }
      return !!b && (b.state === "done" || b.state === "idle") && !b.helpers && b;
    }, 240_000, 400);
    check(`chat7 (${tag}): the turn ends`, !!rested);
    const plan = rested?.plan;
    check(`chat7 (${tag}): the bot kept a to-do list with its harness's tool: three steps seen, one of them in progress while it worked`, seen.most >= 3 && seen.doing, JSON.stringify(seen));
    check(`chat7 (${tag}): at the end the list holds the steps, all done`, !!plan && plan.steps.length >= 3 && plan.steps.every((x) => x.status === "completed"), JSON.stringify(plan?.steps));
    const items20 = (await s20.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
    const lines = items20.filter((i) => i.kind === "activity");
    check(`chat7 (${tag}): no connector or MCP tool was used`, !lines.some((l) => / in [a-z0-9_-]+$/i.test(l.label) && l.tool === "other" && !/^(Looked up|Used the)/.test(l.label)), JSON.stringify(lines.map((l) => l.label).slice(0, 12)));
    check(`chat7 (${tag}): every line of work says its kind; the commands say command`, lines.length > 0 && lines.every((l) => !!l.tool) && lines.filter((l) => l.tool === "command").length >= 3, JSON.stringify(lines.map((l) => l.tool)));
    const thoughts = lines.filter((l) => l.tool === "think");
    if (tag === "Claude") check("chat7 (Claude): a thinking summary reached the chat as a line of its own, with words", thoughts.length > 0 && thoughts.every((t) => t.label.trim().length > 0), `${thoughts.length} thinking lines`);
    else console.log(`      (chat7 Codex: ${thoughts.length} reasoning summaries arrived at ${model.efforts.includes(effort) ? effort : model.defaultEffort} effort)`);
    if (tag === "Claude") {
      await openWindow(endpoint);
      await until(`[...document.querySelectorAll(".app-row")].some((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)})`, 20_000);
      await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}).click()`);
      await until(`!!document.querySelector(".app-main .pb-worked")`, 20_000);
      await js(`document.querySelector(".app-main .pb-worked").click()`);
      const groups = await until(`(() => { const g = [...document.querySelectorAll(".app-main .pb-workgroup")]; return g.length > 0 && g.map((x) => x.querySelector(".pb-work-icon").dataset.kind + ":" + x.dataset.count); })()`, 20_000);
      check("chat7: in the window the work folds into lines with the icon of their kind", Array.isArray(groups) && groups.length > 0, JSON.stringify(groups));
      check("chat7: the face in the roster has the bot's colour", (await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}).querySelector(".pb-avatar").dataset.color`)) === bot.look.color);
      await shot("61-work-lines");
    }
    if (tag === "Codex") collectCodexThreads();
  }
  s20.close();
}
