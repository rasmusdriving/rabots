// The app check, section "restored-waiting": engine 0.31.1 (docs/build/step-restored-waiting.md).
// Run it alone: node scripts/app-check.mjs --only=restored-waiting
// A real Claude bot on the cheapest model asks with ask_human; the engine is stopped with the card
// open and started again. The bot, at rest with its card back, reads Waiting for you (atRest) in the
// snapshot and the window. A message to it starts a turn at once, and when that ends it reads Waiting
// again. His answer then goes from Waiting straight into the turn it starts, and the bot rests
// without Waiting. Every bot.updated the engine sends is recorded: no Idle or Done between.
import WebSocket from "ws";
import { sleep, check, sideChannel, shot, until, openWindow, run, startEngine, stopEngine, PROTOCOL_VERSION } from "../lib.mjs";

const QUESTION = "Which shape for the waiting test?";

/** Every state of the bot the engine sends to a window, in order. */
async function recorder(endpoint, botId) {
  const ws = new WebSocket(`${endpoint.url}?token=${endpoint.token}`);
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  const states = [];
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.t === "evt" && f.event === "bot.updated" && f.data.bot.id === botId) {
      const b = f.data.bot;
      const last = states.at(-1);
      if (!last || last.state !== b.state || last.activity !== b.activity || last.atRest !== b.atRest) states.push({ state: b.state, activity: b.activity, atRest: b.atRest });
    }
  });
  ws.send(JSON.stringify({ t: "req", id: "r1", method: "hello", params: { protocol: PROTOCOL_VERSION, client: "app-check" } }));
  return { states, from: () => states.length, close: () => ws.close() };
}

const rowState = (name) => `(() => { const r = [...document.querySelectorAll(".app-row")].find((x) => x.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}); return r && { state: r.dataset.state, line: r.querySelector(".pb-row-line")?.textContent }; })()`;

export default async function section() {
  const { cheap } = run;
  const s1 = await sideChannel(run.endpoint);
  const snap = await s1.request("snapshot");
  const model = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot = (await s1.request("bot.create", { name: "Waiter", purpose: "Asks one question for the waiting check", job: "Do what you are asked, briefly.", model: model.id, effort: model.efforts.includes("low") ? "low" : model.defaultEffort, access: "asks-first" })).bot;
  await s1.request("message.send", {
    botId: bot.id,
    text: `This is a test inside Pobots only. Use the Pobots tool ask_human (mcp__pobots__ask_human) once, with the question "${QUESTION}" and the choices Circle and Square. Use no connectors or MCP servers, and change no files outside your own folder. When my answer comes, reply with only the shape I chose. To any other message from me, reply with one short sentence and do not ask again.`,
  });
  let before;
  const end1 = Date.now() + 180_000;
  while (Date.now() < end1 && !before) {
    before = (await s1.request("snapshot")).cards.find((c) => c.kind === "question" && c.botId === bot.id);
    if (!before) await sleep(500);
  }
  check("restored waiting: the bot's question card is up before the restart", before?.title === QUESTION, JSON.stringify(before));
  const inTurn = (await s1.request("snapshot")).bots.find((b) => b.id === bot.id);
  check("restored waiting: before the restart it waits in its turn (no atRest)", inTurn?.state === "waiting" && inTurn.atRest === undefined, JSON.stringify(inTurn));
  s1.close();
  if (!before) return;

  // The restart, with the card open.
  await stopEngine();
  const endpoint = await startEngine();
  run.endpoint = endpoint;
  const s2 = await sideChannel(endpoint);
  const back = (await s2.request("snapshot")).bots.find((b) => b.id === bot.id);
  check("restored waiting: after the restart the bot reads Waiting for your answer, at rest", back?.state === "waiting" && back.activity === "Waiting for your answer" && back.atRest === true, JSON.stringify(back));
  await openWindow(endpoint);
  const row = await until(`(() => { const r = ${rowState("Waiter")}; return r?.state === "waiting" ? r : null; })()`, 20_000);
  check("restored waiting: the window's row reads Waiting for your answer", row?.line === "Waiting for your answer", JSON.stringify(row));
  await shot("90-restored-waiting");
  const rec = await recorder(endpoint, bot.id);

  // A message: Working wins, then Waiting again, never Idle or Done between.
  await s2.request("message.send", { botId: bot.id, text: "Say hello in one short sentence. Use no tools." });
  const end2 = Date.now() + 180_000;
  while (Date.now() < end2) {
    const b = (await s2.request("snapshot")).bots.find((x) => x.id === bot.id);
    if (rec.states.length > 1 && b?.state === "waiting") break;
    await sleep(500);
  }
  const msgStates = rec.states.map((s) => s.state);
  check("restored waiting: a message starts a turn at once", msgStates[0] === "thinking" || msgStates[0] === "working", JSON.stringify(rec.states));
  check("restored waiting: when it ends the bot reads Waiting again, at rest", rec.states.at(-1)?.state === "waiting" && rec.states.at(-1)?.atRest === true, JSON.stringify(rec.states.at(-1)));
  check("restored waiting: never Idle or Done between", !msgStates.some((s) => s === "idle" || s === "done"), JSON.stringify(msgStates));
  check("restored waiting: the card is still open", (await s2.request("snapshot")).cards.some((c) => c.id === before.id));

  // His answer: from Waiting straight into its turn, then at rest without Waiting.
  const from = rec.from();
  const card = await until(`(() => { const c = [...document.querySelectorAll(".app-rail .pb-card")].find((x) => x.querySelector(".pb-card-title")?.textContent === ${JSON.stringify(QUESTION)}); const b = c && [...c.querySelectorAll("button")].find((x) => x.textContent.trim() === "Square"); if (!b) return false; b.click(); return true; })()`, 15_000);
  check("restored waiting: his answer on the card", !!card);
  const end3 = Date.now() + 180_000;
  while (Date.now() < end3) {
    const b = (await s2.request("snapshot")).bots.find((x) => x.id === bot.id);
    if (rec.states.length > from + 1 && (b?.state === "done" || b?.state === "idle")) break;
    await sleep(500);
  }
  const answered = rec.states.slice(from).map((s) => s.state);
  check("restored waiting: the answer goes from Waiting straight into its turn", answered[0] === "thinking" || answered[0] === "working", JSON.stringify(rec.states.slice(from)));
  check("restored waiting: then the bot rests, and never read Idle or Waiting between", answered.slice(0, -1).every((s) => s === "thinking" || s === "working") && ["done", "idle"].includes(answered.at(-1)), JSON.stringify(answered));
  const rest = await until(`(() => { const r = ${rowState("Waiter")}; return r && r.state !== "waiting" && r.state !== "thinking" && r.state !== "working" ? r : null; })()`, 15_000);
  check("restored waiting: the window's row no longer waits", !!rest, JSON.stringify(rest));
  await shot("91-restored-waiting-answered");
  // Test bots see the person's own connectors and MCP servers: none may be used.
  const items = (await s2.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items;
  const outside = items.filter((i) => i.kind === "activity" && ((/^(Used|Using) .+ in /.test(i.label ?? "") && !/ in pobots$/i.test(i.label ?? "")) || /workbot/i.test(`${i.label} ${i.detail ?? ""}`)));
  check("restored waiting: no connector or MCP server outside Pobots was used", outside.length === 0, outside.map((i) => i.label).join("; "));
  rec.close();
  s2.close();
}
