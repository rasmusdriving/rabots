// Part C across two connections to the real engine, with a real bot and its Ahead tool.
import { check, run, sideChannel, sleep } from "../lib.mjs";

const rule = "Use no connectors or MCP servers, change no files outside your own folder.";
const quiet = (b) => b && ["done", "idle", "blocked"].includes(b.state) && !b.helpers;
const plus = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export default async function section() {
  const { endpoint, cheap } = run;
  const laptop = await sideChannel(endpoint);
  const phone = await sideChannel(endpoint);
  let bot;
  try {
    await laptop.request("ahead.settings.set", { enabled: true });
    bot = (await laptop.request("bot.create", {
      name: "Sample planner", purpose: "Use a sample plan", job: "Use only the named Pobots tool and answer briefly.",
      model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort, welcome: false,
    })).bot;
    await laptop.request("bot.update", { botId: bot.id, patch: { ahead: "items", sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
    const view = (via = laptop) => via.request("ahead.view");
    const before = await view();
    const ask = async (text, answer) => {
      const at = Date.now() + 60_000;
      await laptop.request("message.send", { botId: bot.id, text: `${text} ${rule}` });
      while (Date.now() < at) {
        const [{ bots }, { items }] = await Promise.all([
          laptop.request("snapshot"), laptop.request("thread.read", { threadId: bot.mainThreadId, limit: 20 }),
        ]);
        if (quiet(bots.find((b) => b.id === bot.id)) && items.some((i) => i.kind === "bot" && i.text.includes(answer))) return true;
        await sleep(350);
      }
      return false;
    };
    const title = "Send sample minutes";
    const added = await ask(`Use the Pobots ahead_item tool once: action add, kind deadline, title "${title}", day "${plus(before.today, 1)}", label "Sample project". Then reply ADDED.`, "ADDED");
    check("ahead-screen: the real bot adds its labelled item", added);
    await laptop.request("ahead.seen", { through: before.screen.readAt });
    const other = await view(phone);
    const row = other.rows.find((r) => r.source === "item" && r.item.title === title);
    check("ahead-screen: leaving did not acknowledge the held item on the other connection", row?.changed?.kind === "new" && other.screen.seenAt === before.screen.readAt);
    check("ahead-screen: engine counts the bot's Ahead item", other.screen.carrying.find((c) => c.botId === bot.id)?.onAhead === 1);
    if (!row) return;
    await phone.request("ahead.seen", { through: other.screen.readAt });

    const moved = await ask(`Use the Pobots ahead_item tool once: action move, id "${row.item.id}", day "${plus(before.today, 2)}". Then reply MOVED.`, "MOVED");
    const after = await view();
    const movedRow = after.rows.find((r) => r.key === row.key);
    check("ahead-screen: the real bot move is marked with its old day", moved && movedRow?.changed?.kind === "moved" && movedRow.changed.from === row.day);
    await laptop.request("ahead.seen", { through: after.screen.readAt });
    const cleared = await view(phone);
    check("ahead-screen: both devices use the newer checkpoint", cleared.screen.seenAt === after.screen.readAt && !cleared.rows.find((r) => r.key === row.key)?.changed);

    const own = (await laptop.request("ahead.add", { title: "My sample reminder", day: before.today })).item;
    check("ahead-screen: Add stores an open item with no bot", !own.botId && own.changedBy === "you" && (await view(phone)).rows.some((r) => r.item?.id === own.id));
    await phone.request("ahead.act", { itemId: own.id, action: "done" });
    const done = await view();
    check("ahead-screen: Done this week includes the person's item", done.done.some((r) => r.item.id === own.id) && !done.rows.some((r) => r.item?.id === own.id));
    await laptop.request("ahead.act", { itemId: own.id, action: "reopen" });
    check("ahead-screen: Open again restores the item", (await view(phone)).rows.some((r) => r.item?.id === own.id && r.item.state === "open"));
  } finally {
    if (bot) await laptop.request("bot.retire", { botId: bot.id }).catch(() => {});
    await laptop.request("ahead.settings.set", { enabled: false }).catch(() => {});
    laptop.close();
    phone.close();
  }
}
