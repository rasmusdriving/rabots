// The app check, section "ahead" (docs/build/step-ahead.md, part A): the built engine and real bots
// on the cheapest Claude model.
//
//   1. The real main bot switches Ahead on with change_settings and lets another bot put items on it
//      with update_bot, each with its quiet line in its own chat.
//   2. That bot adds an item with ahead_item, moves it, and lists it; the view shows it with the
//      bot's chat as its link.
//   3. The person marks it done (ahead.act); the bot hears it at its next turn.
//   4. The tool refuses your-time at level items (part B: it needs level time).
//
// Nothing reaches outside Pobots: every message names the tool and forbids connectors and MCP servers.
// Run it alone: node scripts/app-check.mjs --only=ahead
import { check, run, sideChannel, sleep } from "../lib.mjs";

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
  const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  let bot;
  try {
    const snap = () => s.request("snapshot");
    const main = (await snap()).bots.find((b) => b.role === "main");
    if (!main) throw new Error("No main bot in the check.");
    bot = (await s.request("bot.create", { name: "Ahead check", purpose: "For the check of Ahead", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, welcome: false })).bot;
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

    check("ahead: off at the start, and the view says so", (await snap()).ahead?.enabled === false && (await s.request("ahead.view", {}).then(() => false, (e) => /off/i.test(String(e?.message ?? e)))));

    await ask(main, `Use the Pobots change_settings tool once with ahead true. ${RULE} Then say what the tool said in one short sentence.`);
    check("ahead: a real main bot switches it on with change_settings, with its quiet line", (await snap()).ahead?.enabled === true && (await notice(main, "Ahead from off to on")));

    await ask(main, `Use the Pobots update_bot tool once with bot "${bot.id}" and ahead "items". ${RULE} Then say what the tool said in one short sentence.`);
    const level = (await snap()).bots.find((b) => b.id === bot.id)?.ahead;
    check("ahead: the main bot lets the bot put items on Ahead with update_bot, with its quiet line", level === "items" && (await notice(main, "Ahead from off to items")), String(level));

    const { today } = await s.request("ahead.view", {});
    const plus = (n) => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    };
    const title = "Send the check summary";
    await ask(bot, `Use the Pobots ahead_item tool once with action "add", kind "will-do", title "${title}", day "${plus(1)}". ${RULE} Then answer with the item's id only.`);
    const mine = async () => (await s.request("ahead.view", { days: 14 })).rows.find((r) => r.source === "item" && r.item.title === title)?.item;
    const added = await mine();
    check("ahead: a real bot adds an item with ahead_item, linked to its chat", added?.botId === bot.id && added.day === plus(1) && added.kind === "will-do" && added.link?.threadId === bot.mainThreadId && added.changedBy === "bot", JSON.stringify(added ?? null));

    await ask(bot, `Use the Pobots ahead_item tool once with action "move", id "${added?.id}", day "${plus(3)}". ${RULE} Then say done.`);
    const moved = await mine();
    check("ahead: the bot moves it to another day", moved?.day === plus(3) && moved.movedFrom === plus(1), JSON.stringify(moved ?? null));

    const listed = await ask(bot, `Use the Pobots ahead_item tool once with action "list". ${RULE} Then copy the tool's answer exactly.`);
    check("ahead: the bot lists its items", !!listed && listed.filter((i) => i.kind === "bot").at(-1)?.text.includes(title));

    await s.request("ahead.act", { itemId: added?.id, action: "done" });
    check("ahead: the person marks it done, and it leaves the open rows", !(await mine()) && (await s.request("ahead.view", {})).done.some((r) => r.item.id === added?.id));
    const heard = await ask(bot, `Did Pobots tell you anything about your Ahead items since your last answer? Use no tool. ${RULE} Answer in one sentence and quote the item's title and what happened to it.`);
    const said = heard?.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    check("ahead: the bot hears at its next turn that the person marked it done", /done/i.test(said) && said.includes("check summary"), said.slice(0, 160));

    const refused = await ask(bot, `Use the Pobots ahead_item tool once with action "add", kind "your-time", title "Focus block", day "${plus(2)}". ${RULE} Then copy the tool's answer exactly.`);
    // A small model may put the tool's words in its own; it must still say permission and who gives it.
    const refusal = refused?.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    check("ahead: the tool refuses your-time at level items, saying who gives the permission", /permission/i.test(refusal) && /settings|main bot/i.test(refusal) && !(await s.request("ahead.view", {})).rows.some((r) => r.source === "item" && r.item.title === "Focus block"), refusal.slice(0, 160));
  } finally {
    if (bot) await s.request("bot.retire", { botId: bot.id }).catch(() => {});
    await s.request("ahead.settings.set", { enabled: false }).catch(() => {});
    s.close();
  }
}
