// The app check, section "ahead-grid" (docs/build/step-ahead-redesign.md): what the Week grid's drag
// asks of the built engine, and a real bot on the cheapest Claude model for the "your time" slot.
//
//   1. The person's own item, dragged into a day: ahead.act move with a day and a time on the
//      quarter. The engine keeps exactly that time, the view carries it, and the other device sees it.
//   2. Dragged to the strip on top: move with time null gives the day with no time.
//   3. A real bot's "your time" slot (placed by Pobots), dragged to a time of the person's choice:
//      the engine keeps the day, the time and the length, and does not place it again when the plan
//      is settled afterwards (another slot is added).
//   4. A time that is no time is refused, and nothing changes.
//
// Nothing reaches outside Pobots: the message names the tool and forbids connectors and MCP servers.
// No calendar: only Pobots' own items. Run it alone: node scripts/app-check.mjs --only=ahead-grid
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
  const laptop = await sideChannel(endpoint);
  const phone = await sideChannel(endpoint);
  const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  let bot;
  const mine = [];
  try {
    await laptop.request("ahead.settings.set", { enabled: true });
    const view = (via = laptop) => via.request("ahead.view", { days: 31 });
    const { today } = await view();
    const plus = (n) => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    };
    const rowOf = async (id, via = laptop) => (await view(via)).rows.find((r) => r.source === "item" && r.item.id === id);

    // 1. The person's item into a day and a time.
    const own = (await laptop.request("ahead.add", { title: "Grid check reminder", day: plus(1) })).item;
    mine.push(own.id);
    check("ahead-grid: an item added with a day has no time, so it stands in the strip on top", !own.time && (await rowOf(own.id))?.time === undefined);
    const timed = (await laptop.request("ahead.act", { itemId: own.id, action: "move", day: plus(3), time: "10:15" })).item;
    const seen = await rowOf(own.id, phone);
    check("ahead-grid: a drag into a day gives the item that day and that time, on both devices", timed.day === plus(3) && timed.time === "10:15" && timed.changedBy === "you" && seen?.day === plus(3) && seen.time === "10:15", JSON.stringify(timed));
    const sameDay = (await laptop.request("ahead.act", { itemId: own.id, action: "move", day: plus(3), time: "14:45" })).item;
    check("ahead-grid: a drag within the day changes only the time", sameDay.day === plus(3) && sameDay.time === "14:45");

    // 2. Back to a day with no time.
    const untimed = (await laptop.request("ahead.act", { itemId: own.id, action: "move", day: plus(2), time: null })).item;
    check("ahead-grid: a drop on the strip on top gives the day with no time", untimed.day === plus(2) && untimed.time === undefined && (await rowOf(own.id, phone))?.time === undefined, JSON.stringify(untimed));

    // 4. A time that is no time is refused.
    const refused = await laptop.request("ahead.act", { itemId: own.id, action: "move", day: plus(2), time: "25:99" }).then(() => false, () => true);
    const after = (await rowOf(own.id))?.item;
    check("ahead-grid: a time that is no time is refused and nothing changes", refused && after?.day === plus(2) && after.time === undefined);

    // 3. A real bot's "your time" slot, dragged to the person's time.
    const snap = () => laptop.request("snapshot");
    bot = (await laptop.request("bot.create", { name: "Grid check", purpose: "For the check of Ahead's Week grid", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, welcome: false })).bot;
    await laptop.request("bot.update", { botId: bot.id, patch: { ahead: "time", sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
    const read = async () => (await laptop.request("thread.read", { threadId: bot.mainThreadId, limit: 80 })).items;
    const ask = async (text) => {
      const before = (await read()).filter((i) => i.kind === "bot").length;
      await laptop.request("message.send", { botId: bot.id, text });
      return until(async () => {
        const st = (await snap()).bots.find((x) => x.id === bot.id);
        const items = await read();
        return quiet(st) && items.filter((i) => i.kind === "bot").length > before && items;
      }, 90_000);
    };
    const slotOf = async (title) => (await view()).rows.find((r) => r.source === "item" && r.item.title === title)?.item;
    await ask(`Use the Pobots ahead_item tool once with action "add", kind "your-time", title "Grid check slot", minutes 45. ${RULE} Then reply ADDED.`);
    const placed = await slotOf("Grid check slot");
    check("ahead-grid: a real bot's your-time slot is placed by Pobots with its length", placed?.kind === "your-time" && placed.minutes === 45 && !!placed.time && placed.changedBy === "bot", JSON.stringify(placed ?? null));
    if (placed) {
      const dragged = (await laptop.request("ahead.act", { itemId: placed.id, action: "move", day: plus(4), time: "13:45" })).item;
      check("ahead-grid: dragged, the slot takes the person's day and time and keeps its length", dragged.day === plus(4) && dragged.time === "13:45" && dragged.minutes === 45 && dragged.changedBy === "you", JSON.stringify(dragged));
      // Another slot makes Pobots settle the plan again: the person's choice stays.
      await ask(`Use the Pobots ahead_item tool once with action "add", kind "your-time", title "Grid check second slot", minutes 30. ${RULE} Then reply ADDED.`);
      const second = await slotOf("Grid check second slot");
      const kept = await slotOf("Grid check slot");
      check("ahead-grid: when the plan is settled again the dragged slot stays where the person put it", !!second?.time && kept?.day === plus(4) && kept.time === "13:45" && kept.changedBy === "you", JSON.stringify({ second, kept }));
    }
  } finally {
    for (const id of mine) await laptop.request("ahead.act", { itemId: id, action: "drop" }).catch(() => {});
    if (bot) await laptop.request("bot.retire", { botId: bot.id }).catch(() => {});
    await laptop.request("ahead.settings.set", { enabled: false }).catch(() => {});
    laptop.close();
    phone.close();
  }
}
