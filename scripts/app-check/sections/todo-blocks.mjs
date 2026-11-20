// The app check, section "todo-blocks" (docs/build/step-todo-blocks.md): the built engine, real bots
// on the cheapest Claude model, and the calendar stand-in (scripts/calendar-standin.mjs), never Outlook.
//
//   0. The person turns it on and saves a text the way the window does (engine 0.42.1), then off again.
//   1. The real main bot turns to-dos in the calendar on and rewrites how to schedule the person with
//      change_settings, each with its quiet line.
//   2. A real bot adds a to-do with minutes; its block is on Ahead (one row, no dated to-do row), and
//      in the stand-in calendar as busy, with no Teams fields, no attendees and no reminder.
//   3. The person marks the to-do done: the block is done and its event is deleted.
//   4. Engine 0.44.0: a real bot adds a to-do "not before 13:00" (block_not_before); its block and its
//      stand-in event start at 13:00 or later, and the wish is kept on the block.
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

    // 0. The person's way, as the window sends it (TodoBlocksSettings.tsx), read back from the engine
    //    (engine 0.42.1: the schema dropped both keys, so the switch and Save did nothing).
    const byPerson = await s.request("ahead.settings.set", { todoBlocks: true });
    check("todo-blocks: the switch in Settings turns to-dos in the calendar on and it is kept", byPerson.ahead?.todoBlocks === true && (await snap()).ahead?.todoBlocks === true, JSON.stringify(byPerson.ahead ?? null).slice(0, 200));
    const typed = "Small things after lunch. Mornings are for deep work.";
    const saved = await s.request("ahead.settings.set", { scheduling: typed });
    check("todo-blocks: Save on how to schedule me keeps the text", saved.ahead?.scheduling === typed && (await snap()).ahead?.scheduling === typed && (await snap()).ahead?.todoBlocks === true, (await snap()).ahead?.scheduling ?? "");
    // Back to off and the default, so the main bot's change below is a real change.
    await s.request("ahead.settings.set", { todoBlocks: false, scheduling: "" });
    check("todo-blocks: the switch off and an empty text go back to off and the default", (await snap()).ahead?.todoBlocks === false && (await snap()).ahead?.scheduling === undefined);

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

    // 4. Not before 13:00: the bot says when, and Pobots keeps to it (any hour the check runs at).
    const later = "Check the sample invoice";
    const told = await ask(bot, `Use the Pobots add_todo tool once with title "${later}", minutes 10 and block_not_before "13:00". ${RULE} Then copy the tool's answer exactly.`);
    const laterTodo = (await snap()).todos.find((t) => t.title === later);
    const laterBlock = (await s.request("ahead.view", { days: 31 })).rows.find((r) => r.source === "item" && r.item.forTodo === laterTodo?.id)?.item;
    const laterEv = [...standin.events.values()].find((e) => e.subject === `To-do: ${later}`);
    check(
      "todo-blocks: a to-do not before 13:00 gets its block at 13:00 or later, kept with the wish",
      !!laterBlock && laterBlock.time >= "13:00" && laterBlock.wish?.notBefore === "13:00" && laterBlock.outlook?.state === "made",
      JSON.stringify({ time: laterBlock?.time, wish: laterBlock?.wish, outlook: laterBlock?.outlook?.state, said: told?.filter((i) => i.kind === "bot").at(-1)?.text.slice(0, 200) }),
    );
    check("todo-blocks: its event in the calendar starts when its block does", !!laterEv && Date.parse(laterEv.start.dateTime + "Z") === Date.parse(laterBlock?.outlook?.start ?? ""), JSON.stringify(laterEv?.start ?? null));
  } finally {
    if (bot) await s.request("bot.retire", { botId: bot.id }).catch(() => {});
    await s.request("ahead.settings.set", { todoBlocks: false, scheduling: "", enabled: false }).catch(() => {});
    await s.request("calendar.set", { address: "" }).catch(() => undefined);
    await standin.close();
    s.close();
  }
}
