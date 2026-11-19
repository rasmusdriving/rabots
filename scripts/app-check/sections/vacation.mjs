// The built engine, real Haiku and the real main-bot tool, on a clock this check owns.
import { copyFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { check, dataDir, sideChannel, sleep, startEngine, stopEngine, work } from "../lib.mjs";

const MODEL_RULE = "Use no connectors or MCP servers, change no files outside your own folder.";
const SEES = { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] }, skills: { rest: "name", except: [] } };
const quiet = (b) => b && ["done", "idle", "blocked"].includes(b.state) && !b.helpers;

async function until(read, timeout = 50_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await read();
    if (found) return found;
    await sleep(300);
  }
  return undefined;
}

export default async function section() {
  await stopEngine();
  const data = join(work, "vacation-data");
  const bots = join(work, "vacation-bots");
  const clock = join(work, "vacation-clock");
  mkdirSync(data);
  mkdirSync(bots);
  copyFileSync(join(dataDir, "config.json"), join(data, "config.json"));
  const setClock = (at) => {
    writeFileSync(clock + ".tmp", String(at));
    renameSync(clock + ".tmp", clock);
  };
  const now = Math.floor(Date.now() / 300_000) * 300_000 + 299_000;
  setClock(now);
  const config = { dataDir: data, botsDir: bots, env: { POBOTS_VACATION_CHECK_CLOCK: clock, NODE_OPTIONS: `--import=${new URL("../vacation-clock.mjs", import.meta.url).href}`, TZ: "UTC" } };
  let side;
  try {
    side = await sideChannel(await startEngine(config));
    const snap = () => side.request("snapshot");
    const model = (await snap()).models.find((m) => /haiku-5-5/.test(m.id));
    if (!model) throw new Error("Haiku 5.5 is not available for the real model check.");
    const add = async (name) => {
      const { bot } = await side.request("bot.create", { name, welcome: false, effort: "low", model: model.id });
      await side.request("bot.update", { botId: bot.id, patch: { sees: SEES } });
      return bot;
    };
    const main = await add("Po");
    const mira = await add("Vacation check");
    const read = async (bot) => (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 80 })).items;
    const find = async () => (await snap()).bots.find((b) => b.id === mira.id);
    const { trigger } = await side.request("trigger.save", { botId: mira.id, trigger: {
      kind: "schedule", where: "main", name: "Five minute check", enabled: true,
      schedule: { type: "every", minutes: 5, days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
      prompt: `Use the Pobots list_triggers tool once to read your own schedules. ${MODEL_RULE} Then answer with exactly "vacation-check-ready".`,
    } });
    const runs = async () => (await side.request("trigger.runs", { triggerId: trigger.id })).runs;
    const setFromPo = async (vacation) => {
      await side.request("message.send", { botId: main.id, text: `Use the Pobots update_bot tool once with bot "${mira.id}" and vacation ${vacation}. ${MODEL_RULE} Then report what the tool said in one short sentence.` });
      const wanted = vacation ? "sent on vacation" : "back from vacation";
      return until(async () => quiet((await snap()).bots.find((b) => b.id === main.id)) && (await read(main)).some((i) => i.kind === "notice" && i.text === `Vacation check: ${wanted}`));
    };
    check("vacation: a real Po sends the bot away with update_bot and leaves its quiet line", !!await setFromPo(true));
    const away = await find();
    const sleeping = (await side.request("trigger.list", { botId: mira.id })).triggers[0];
    check("vacation: still an idle bot, with its schedule switched on and resting", away?.state === "idle" && !!away.vacationSince && sleeping?.enabled && sleeping.resting && !sleeping.nextAt);
    if (!away?.vacationSince) throw new Error("Po did not send the bot on vacation.");
    side.close();
    await stopEngine();
    // The first scheduler check at restart normally catches up a missed run. It must skip this one.
    setClock(now + 300_000);
    side = await sideChannel(await startEngine(config));
    check("vacation: restart after a due time keeps state without starting or queuing the schedule", (await find())?.vacationSince === away.vacationSince && !(await runs()).length && !(await read(mira)).some((i) => i.kind === "user"));
    check("vacation: a real Po brings the bot back with update_bot and leaves its quiet line", !!await setFromPo(false));
    const resumed = (await side.request("trigger.list", { botId: mira.id })).triggers[0];
    check("vacation: picks the next time strictly after the return, with no catch-up", !(await find())?.vacationSince && !resumed?.resting && Date.parse(resumed?.nextAt) === now + 301_000 && !(await runs()).length);
    setClock(now + 301_100);
    const fired = await until(async () => (await runs()).find((r) => r.status === "done"), 45_000);
    check("vacation: the next five minute run fires and the real bot answers", !!fired && (await runs()).length === 1 && (await read(mira)).some((i) => i.kind === "bot" && i.text.includes("vacation-check-ready")));
  } finally {
    side?.close();
    await stopEngine();
  }
}
