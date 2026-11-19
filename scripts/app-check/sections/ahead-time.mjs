// The app check, section "ahead-time" (docs/build/step-ahead.md, part B): the built engine and real
// bots on the cheapest Claude model.
//
//   1. The real main bot changes the working time with change_settings ahead_time, with its quiet line.
//   2. A bot with level time asks for 30 minutes of the person's time with ahead_item; Pobots places
//      it inside working hours on a working day, at least 30 minutes from now.
//   3. The real main bot moves it to a time of its choice (outside working hours).
//   4. The person moves it to the next free slot (ahead.act place), then marks it done; the bot hears
//      both at its next turn.
//
// Nothing reaches outside Pobots: every message names the tool and forbids connectors and MCP servers.
// No calendar: only Pobots' own items count. Run it alone: node scripts/app-check.mjs --only=ahead-time
import { check, run, sideChannel, sleep } from "../lib.mjs";

const RULE = "Use no connectors or MCP servers, change no files outside your own folder.";
const quiet = (b) => b && ["done", "idle", "blocked"].includes(b.state) && !b.helpers;
const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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
  const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  let bot;
  try {
    const snap = () => s.request("snapshot");
    const main = (await snap()).bots.find((b) => b.role === "main");
    if (!main) throw new Error("No main bot in the check.");
    await s.request("ahead.settings.set", { enabled: true });
    bot = (await s.request("bot.create", { name: "Time check", purpose: "For the check of Ahead's your time", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, welcome: false })).bot;
    await s.request("bot.update", { botId: bot.id, patch: { ahead: "time" } });
    const read = async (b) => (await s.request("thread.read", { threadId: b.mainThreadId, limit: 80 })).items;
    const ask = async (b, text) => {
      const before = (await read(b)).filter((i) => i.kind === "bot").length;
      await s.request("message.send", { botId: b.id, text });
      return until(async () => {
        const st = (await snap()).bots.find((x) => x.id === b.id);
        const items = await read(b);
        return quiet(st) && items.filter((i) => i.kind === "bot").length > before && items;
      }, 90_000);
    };
    const notice = async (b, words) => (await read(b)).some((i) => i.kind === "notice" && i.text.includes(words));

    // 1. The main bot sets the working time.
    await ask(main, `Use the Pobots change_settings tool once with ahead_time { "work_start": "08:00", "work_end": "17:00", "minutes_per_day": 90 }. ${RULE} Then say what the tool said in one short sentence.`);
    const set = (await snap()).ahead;
    check("ahead-time: the main bot changes the minutes a day with change_settings ahead_time, with its quiet line", set?.minutesPerDay === 90 && (await notice(main, "your time at most 90 minutes a day")), JSON.stringify(set ?? null));

    // 2. The bot asks for 30 minutes.
    const title = "Look at the check draft";
    const asked = Date.now();
    await ask(bot, `Use the Pobots ahead_item tool once with action "add", kind "your-time", title "${title}", minutes 30. ${RULE} Then copy the tool's answer exactly.`);
    const mine = async () => (await s.request("ahead.view", { days: 31 })).rows.find((r) => r.source === "item" && r.item.title === title)?.item;
    const placed = await mine();
    const startOf = (i) => new Date(`${i.day}T${i.time}:00`).getTime();
    const inHours = (i) => !!i?.time && i.time >= set.workStart && i.time <= "16:30" && set.workDays.includes(KEYS[new Date(`${i.day}T12:00:00`).getDay()]);
    check(
      "ahead-time: a real bot with level time gets a slot inside working hours, at least 30 minutes from now, that it did not choose",
      placed?.kind === "your-time" && placed.minutes === 30 && inHours(placed) && startOf(placed) >= asked + 29 * 60_000 && placed.changedBy === "bot" && placed.link?.threadId === bot.mainThreadId,
      JSON.stringify(placed ?? null),
    );

    // 3. The main bot moves it to a time of its choice.
    const { today } = await s.request("ahead.view", {});
    const plus = (n) => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    };
    await ask(main, `Use the Pobots ahead_item tool once with action "move", id "${placed?.id}", day "${plus(2)}", time "07:30". ${RULE} Then say what the tool said in one short sentence.`);
    const byMain = await mine();
    check("ahead-time: the real main bot moves it to a time of its choice", byMain?.day === plus(2) && byMain.time === "07:30" && byMain.changedBy === "main", JSON.stringify(byMain ?? null));

    // 4. The person moves it to the next free slot, then marks it done; the bot hears both.
    const next = (await s.request("ahead.act", { itemId: placed?.id, action: "move", place: "next" })).item;
    check("ahead-time: the person's Next free slot places it inside working hours again", inHours(next) && next.changedBy === "you", JSON.stringify(next));
    await s.request("ahead.act", { itemId: placed?.id, action: "done" });
    check("ahead-time: marked done, it leaves the open rows", !(await mine()));
    const heard = await ask(bot, `Did Pobots tell you anything about your Ahead items since your last answer? Use no tool. ${RULE} Answer in one or two sentences: who moved "${title}", and what happened to it in the end.`);
    const said = heard?.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    check("ahead-time: the bot hears at its next turn that it was moved and marked done", /done/i.test(said) && /mov/i.test(said), said.slice(0, 200));
  } finally {
    if (bot) await s.request("bot.retire", { botId: bot.id }).catch(() => {});
    await s.request("ahead.settings.set", { enabled: false, minutesPerDay: 120 }).catch(() => {});
    s.close();
  }
}
