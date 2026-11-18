// The app check's section "taskmanagers" (docs/build/step-task-managers.md, 16 Nov 2026): a real bot
// on the cheapest Claude model starts a task manager with start_task_manager (only the workers tool,
// one worker at once). The bot lists it in Bot.taskManagers with its settings; its row stands in the
// bot's chat; it runs a worker of its own whose row stands in its thread; when it is done it rests
// and stays listed. The person writes to it with taskManager.send and it answers in its thread; then
// taskManager.end ends it: it leaves the list and its row says ended.
// Run it alone: node scripts/app-check.mjs --only=taskmanagers.
import { sleep, check, sideChannel, run } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Pobots tools named here; use no connectors or MCP servers, change no files outside your own folder.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap0 = await s.request("snapshot");
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const bot = (await s.request("bot.create", { name: "Manager check", purpose: "For the task managers check", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low, access: "edits-freely" })).bot;
    const state = async () => (await s.request("snapshot")).bots.find((b) => b.id === bot.id);
    const until = async (fn, ms, every = 500) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return undefined;
        await sleep(every);
      }
    };
    const denyNewCards = async () => {
      for (const c of (await s.request("snapshot")).cards) {
        if (cardsAtStart.has(c.id)) continue;
        await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
      }
    };
    const items = async (threadId) => (await s.request("thread.read", { threadId, limit: 200 })).items;

    await s.request("message.send", {
      botId: bot.id,
      text: `${RULES} Use your Pobots tool start_task_manager exactly once, with title "Count check", model ${haiku.id}, effort ${low}, tools ["workers"], max_workers 1, and this task, word for word: Use your Pobots tool start_helper once, with title "Say one", model ${haiku.id}, effort ${low}, wait true, and the task: Reply with the single word one. Then reply with one short line saying what the worker said. Then reply with one short line that you started it, and end your turn.`,
    });
    const listed = await until(async () => {
      await denyNewCards();
      const b = await state();
      const tm = b?.taskManagers?.find((t) => t.title === "Count check");
      return tm ? { b, tm } : undefined;
    }, 150_000);
    check("taskmanagers: its bot lists the task manager", !!listed, listed?.b?.taskManagers);
    const tm = listed?.tm;
    if (!tm) return;
    check("taskmanagers: with the settings its bot chose",
      tm.maxWorkers === 1 && JSON.stringify(tm.tools) === JSON.stringify(["workers"]) && tm.harness === "claude" && tm.model === haiku.id && tm.threadId === bot.mainThreadId && tm.managerThreadId && tm.mayMessage.length === 0,
      tm);
    const row = (await items(bot.mainThreadId)).find((i) => i.kind === "helper" && i.id === tm.id);
    check("taskmanagers: its row stands in the bot's chat, marked as a task manager", !!row?.taskManager && row.helperThreadId === tm.managerThreadId && row.taskManager.maxWorkers === 1, row);

    // It runs a worker in its own thread, then rests and stays.
    const worker = await until(async () => {
      await denyNewCards();
      return (await items(tm.managerThreadId)).find((i) => i.kind === "helper" && i.title === "Say one");
    }, 150_000, 1000);
    check("taskmanagers: its worker's row stands in its thread", !!worker, worker && { title: worker.title, status: worker.status });
    const resting = await until(async () => {
      await denyNewCards();
      const t = (await state())?.taskManagers?.find((x) => x.id === tm.id);
      return t?.state === "resting" ? t : undefined;
    }, 240_000, 1000);
    check("taskmanagers: when done it rests and stays listed, with no worker at work", !!resting && resting.workersNow === 0, resting);
    const own = await items(tm.managerThreadId);
    check("taskmanagers: its thread holds the task and its own words", own[0]?.kind === "user" && own[0].from?.type === "bot" && own.some((i) => i.kind === "bot" && i.text.trim()), own.map((i) => i.kind));
    const workingOwn = (await state())?.workingHelpers?.filter((w) => w.managerId === tm.id) ?? [];
    check("taskmanagers: its finished worker is not among the working helpers", workingOwn.length === 0, workingOwn);

    // The person writes to it: the message stands in its thread and it answers there.
    const before = own.filter((i) => i.kind === "bot").length;
    await s.request("taskManager.send", { botId: bot.id, managerId: tm.id, text: `${RULES} Reply with the single word ready, and use no tools.` });
    const answered = await until(async () => {
      const list = await items(tm.managerThreadId);
      const you = list.some((i) => i.kind === "user" && i.from?.type === "you" && i.text.includes("single word ready"));
      const t = (await state())?.taskManagers?.find((x) => x.id === tm.id);
      return you && list.filter((i) => i.kind === "bot" && !i.streaming).length > before && t?.state === "resting" ? list : undefined;
    }, 120_000, 1000);
    check("taskmanagers: the person's message stands in its thread and it answers there", !!answered);

    // End: it leaves the list; its row says ended.
    await s.request("taskManager.end", { botId: bot.id, managerId: tm.id });
    const gone = await until(async () => {
      const b = await state();
      return b && !b.taskManagers?.some((t) => t.id === tm.id) ? b : undefined;
    }, 20_000);
    const endedRow = (await items(bot.mainThreadId)).find((i) => i.id === tm.id);
    check("taskmanagers: ended, it leaves the list and its row says ended", !!gone && endedRow?.taskManager?.state === "ended" && endedRow.status !== "running", endedRow?.taskManager);
    let refused = false;
    await s.request("taskManager.send", { botId: bot.id, managerId: tm.id, text: "Hello" }).catch(() => (refused = true));
    check("taskmanagers: a message to an ended task manager is refused", refused);
    await until(async () => {
      const b = await state();
      return b && (b.state === "done" || b.state === "idle" || b.state === "blocked") ? true : undefined;
    }, 120_000, 1000);
  } finally {
    s.close();
  }
}
