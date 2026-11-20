// The app check, section "todo-blocks" (docs/build/step-todo-blocks.md): the built engine, real bots
// on the cheapest Claude model, and the calendar stand-in (scripts/calendar-standin.mjs), never Outlook.
//
//   1. The real main bot turns to-dos in the calendar on and rewrites how to schedule the person with
//      change_settings, each with its quiet line.
//   2. A real bot adds a to-do with minutes; its block is on Ahead (one row, no dated to-do row), and
//      in the stand-in calendar as busy, with no Teams fields, no attendees and no reminder.
//   3. The person marks the to-do done: the block is done and its event is deleted.
//
// Nothing reaches outside Pobots: every message names the tool and forbids connectors and MCP servers.
// Run it alone: node scripts/app-check.mjs --only=todo-blocks
import { check, run, sideChannel, sleep } from "../lib.mjs";
import { makeCalendarStandin } from "../../calendar-standin.mjs";

const RULE = "Use no connectors or MCP servers, change no files outside your own folder.";
const quiet = (b) => b && ["done", "idle", "blocked"].includes(b.state) && !b.helpers;

async function until(read, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await read();
    if (found) return found;
    await sleep(400);
  }
  return undefined;
}

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  const standin = makeCalendarStandin();
  const address = await standin.listen(0);
  let bot;
  try {
    const snap = () => s.request("snapshot");
    const main = (await snap()).bots.find((b) => b.role === "main");
    if (!main) throw new Error("No main bot in the check.");
    const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
    await s.request("calendar.set", { address });
    await s.request("ahead.settings.set", { enabled: true });
    const read = async (b) => (await s.request("thread.read", { threadId: b.mainThreadId, limit: 80 })).items;
    const ask = async (b, text) => {
      const before = (await read(b)).filter((i) => i.kind === "bot").length;
      await s.request("message.send", { botId: b.id, text });
      return until(async () => {
        const st = (await snap()).bots.find((x) => x.id === b.id);
        const items = await read(b);
        return quiet(st) && items.filter((i) => i.kind === "bot").length > before && items;
      }, 120_000);
    };
    const notice = async (b, words) => (await read(b)).some((i) => i.kind === "notice" && i.text.includes(words));

    // 1. The main bot turns it on and rewrites the instruction.
    await ask(main, `Use the Pobots change_settings tool once with ahead_todo_blocks true. ${RULE} Then say what the tool said in one short sentence.`);
    check("todo-blocks: the main bot turns to-dos in the calendar on, with its quiet line", (await snap()).ahead?.todoBlocks === true && (await notice(main, "to-dos in the calendar from off to on")));
    const mine = "Ten minutes for a small check. Mornings are for customers.";
    await ask(main, `Use the Pobots change_settings tool once with ahead_scheduling "${mine}". ${RULE} Then say what the tool said in one short sentence.`);
    check("todo-blocks: the main bot rewrites how to schedule the person, with its quiet line", (await snap()).ahead?.scheduling === mine && (await notice(main, "how to schedule the person: changed")), (await snap()).ahead?.scheduling ?? "");

    // 2. A real bot adds a to-do with minutes.
    bot = (await s.request("bot.create", { name: "Block check", purpose: "For the check of to-do blocks", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, welcome: false })).bot;
    const title = "Check the sample report";
    const said = await ask(bot, `Use the Pobots add_todo tool once with title "${title}" and minutes 10. ${RULE} Then copy the tool's answer exactly.`);
    const answer = said?.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    const todo = (await snap()).todos.find((t) => t.title === title);
    const view = await s.request("ahead.view", { days: 31 });
    const rows = view.rows.filter((r) => (r.source === "item" && r.item.forTodo === todo?.id) || (r.source === "todo" && r.todoId === todo?.id) || (r.source === "meeting" && r.title.startsWith("To-do:")));
    const block = rows[0]?.source === "item" ? rows[0].item : undefined;
    check("todo-blocks: the to-do has minutes and one block on Ahead, nothing beside it", todo?.minutes === 10 && rows.length === 1 && block?.minutes === 10 && block.kind === "your-time" && block.outlook?.state === "made", JSON.stringify({ todo: todo?.minutes, rows: rows.map((r) => r.source), outlook: block?.outlook?.state }));
    // The bot passes on what the tool said in its own words: the time and the calendar.
    check("todo-blocks: the bot is told where its block is", /calendar/i.test(answer) && /\d{1,2}:\d{2}/.test(answer), answer.slice(0, 300));
    const ev = [...standin.events.values()].find((e) => e.subject === `To-do: ${title}`);
    const sent = standin.calls.find((c) => c.action === "create")?.event ?? {};
    check(
      "todo-blocks: in the calendar as busy, with no Teams fields, no attendees and no reminder",
      !!ev && ev.showAs === "busy" && ev.isOnlineMeeting === false && !ev.onlineMeeting && ev.isReminderOn === false && ev.attendees.length === 0 && sent.onlineMeetingProvider === undefined && ev.id === block?.outlook?.eventId,
      JSON.stringify(ev ?? null).slice(0, 300),
    );

    // 3. The person marks the to-do done: the block is done and the event goes.
    await s.request("todo.close", { todoId: todo?.id, how: "done" });
    const gone = await until(() => ![...standin.events.values()].some((e) => e.subject === `To-do: ${title}`), 20_000);
    const after = (await s.request("ahead.view", { days: 31 })).done.find((r) => r.item.forTodo === todo?.id)?.item;
    check("todo-blocks: done, the block is done and its event is deleted from the calendar", !!gone && after?.state === "done" && after.outlook?.state === "deleted", JSON.stringify(after?.outlook ?? null));
  } finally {
    if (bot) await s.request("bot.retire", { botId: bot.id }).catch(() => {});
    await s.request("ahead.settings.set", { todoBlocks: false, scheduling: "", enabled: false }).catch(() => {});
    await s.request("calendar.set", { address: "" }).catch(() => undefined);
    await standin.close();
    s.close();
  }
}
