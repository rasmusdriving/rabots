// The app check's section "ahead-setup" (engine 0.42.0, docs/build/step-ahead-setup.md): a real engine
// from the build with no calendar, the main bot Kaja on the cheapest model.
//
//   1. Kaja is told first, in its chat, to stay inside Pobots for the rest of the check.
//   2. Ahead switched on through the protocol, as Settings does: Kaja gets one turn by itself and answers
//      in its main chat about the calendar, after one quiet line from Pobots that says why, with no
//      message from the person, no path on this computer, and no card.
//   3. A restart of the engine with Ahead on and no calendar starts no turn.
//   4. With a stand-in calendar flow on 127.0.0.1 that answers the check, Ahead off and on starts nothing.
//
// Nothing leaves this computer. Run it alone: node scripts/app-check.mjs --only=ahead-setup
import { createServer } from "node:http";
import { join } from "node:path";
import { check, root, run, sideChannel, sleep, startEngine, stopEngine } from "../lib.mjs";

const SAFE = "This is a check inside Pobots only. For the rest of this chat: use only your Pobots tools, no connectors or MCP servers and no browser, and change no files outside your own folder.";

async function quiet(s, botId, cardsAtStart, ms = 180_000) {
  const end = Date.now() + ms;
  const cards = [];
  await sleep(1500);
  while (Date.now() < end) {
    const now = await s.request("snapshot");
    for (const c of now.cards) {
      if (cardsAtStart.has(c.id) || cards.some((x) => x.id === c.id)) continue;
      cards.push(c);
      await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
    }
    const b = now.bots.find((x) => x.id === botId);
    if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers && !b.context?.tidying) return { rested: true, cards };
    await sleep(1000);
  }
  return { rested: false, cards };
}

export default async function section() {
  let s = await sideChannel(run.endpoint);
  const flow = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(JSON.parse(body || "{}").action === "hello" ? { ok: true, result: { owner: { name: "Ada Example", address: "ada@example.com" } } } : { ok: true, result: { value: [] } }));
    });
  });
  try {
    const snap = await s.request("snapshot");
    const main = snap.bots.find((b) => b.role === "main");
    check("ahead-setup: a main bot, Ahead off and no calendar to start with", !!main && !snap.ahead?.enabled && (await s.request("calendar.get", {})).calendar.connected === false, JSON.stringify({ main: main?.name, ahead: snap.ahead?.enabled }));
    const cardsAtStart = new Set(snap.cards.map((c) => c.id));
    const items = async () => (await s.request("thread.read", { threadId: main.mainThreadId, limit: 300 })).items;

    // 1. The rules for the check, in its chat.
    await s.request("message.send", { botId: main.id, text: `${SAFE} Reply with only the word ok.` });
    await quiet(s, main.id, cardsAtStart);

    // 2. Ahead on, as Settings does it.
    const before = (await items()).length;
    await s.request("ahead.settings.set", { enabled: true });
    const started = await (async () => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        const b = (await s.request("snapshot")).bots.find((x) => x.id === main.id);
        if (b?.state === "working" || b?.state === "thinking" || (await items()).length > before) return true;
        await sleep(400);
      }
      return false;
    })();
    check("ahead-setup: switching Ahead on without a calendar starts the main bot's turn by itself", started);
    const turn = await quiet(s, main.id, cardsAtStart);
    const after = (await items()).slice(before);
    const said = after.filter((i) => i.kind === "bot").map((i) => i.text).join("\n");
    check("ahead-setup: the main bot answers in its chat about the calendar", turn.rested && /calendar/i.test(said), said.slice(0, 200));
    check("ahead-setup: no message from the person was added", !after.some((i) => i.kind === "user"));
    check("ahead-setup: its answer names no path on this computer", !said.includes(join(root, "dist")) && !/\/guides\/|calendar-flow\.md|google-calendar\.md/.test(said), said.slice(0, 200));
    check("ahead-setup: the setup turn raised no card", turn.cards.length === 0, turn.cards.map((c) => c.title ?? c.kind).join("; "));
    const line = after.findIndex((i) => i.kind === "notice" && i.startsTurn);
    check("ahead-setup: one quiet line from Pobots says why, before the main bot's answer", line >= 0 && after.filter((i) => i.kind === "notice" && i.startsTurn).length === 1 && after[line].text === "You switched on Ahead. Your calendar is not set up yet, so the setup starts here." && after.findIndex((i) => i.kind === "bot") > line, JSON.stringify(after.map((i) => i.kind)));
    const settled = (await items()).length;

    // 3. A restart with Ahead on and no calendar: nothing starts.
    s.close();
    await stopEngine();
    run.endpoint = await startEngine();
    s = await sideChannel(run.endpoint);
    await sleep(6000);
    const back = await s.request("snapshot");
    const kaja = back.bots.find((b) => b.id === main.id);
    check("ahead-setup: after a restart Ahead is still on", back.ahead?.enabled === true);
    check("ahead-setup: a restart starts no turn", kaja?.state !== "working" && kaja?.state !== "thinking" && (await items()).length === settled, JSON.stringify({ state: kaja?.state, items: (await items()).length, settled }));

    // 4. A calendar that answers its check: off and on starts nothing.
    await new Promise((r) => flow.listen(0, "127.0.0.1", r));
    const cal = (await s.request("calendar.set", { address: `http://127.0.0.1:${flow.address().port}/flow` })).calendar;
    check("ahead-setup: the stand-in calendar is set up and fine", cal.connected && !cal.problem && cal.service === "outlook", JSON.stringify(cal));
    const was = (await items()).length;
    await s.request("ahead.settings.set", { enabled: false });
    await s.request("ahead.settings.set", { enabled: true });
    await sleep(6000);
    const k2 = (await s.request("snapshot")).bots.find((b) => b.id === main.id);
    const now = (await items()).length;
    check("ahead-setup: with the calendar set up, Ahead on starts nothing", k2?.state !== "working" && k2?.state !== "thinking" && now === was, JSON.stringify({ state: k2?.state, was, now }));
    await s.request("calendar.set", { address: "" });
  } finally {
    s.close();
    flow.close();
  }
}
