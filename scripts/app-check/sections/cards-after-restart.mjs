// The app check, section "cards-after-restart": engine 0.29.0 (docs/build/step-cards-after-restart.md).
// Run it alone: node scripts/app-check.mjs --only=cards-after-restart
// A real Claude bot on the cheapest model asks with ask_human; the engine is stopped with the card
// open and started again on the same folders; the card is back in the window with the same id and
// words; the person picks a choice on it; the bot gets his answer as a new message marked with the
// card, and replies with what he chose. One short turn before the restart, one after.
import { sleep, check, sideChannel, js, shot, until, openWindow, run, startEngine, stopEngine } from "../lib.mjs";

const QUESTION = "Which colour for the restart test?";

export default async function section() {
  const { cheap } = run;
  const s1 = await sideChannel(run.endpoint);
  const snap = await s1.request("snapshot");
  const model = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot = (await s1.request("bot.create", { name: "Asker", purpose: "Asks one question for the restart check", job: "Do what you are asked, briefly.", model: model.id, effort: model.efforts.includes("low") ? "low" : model.defaultEffort, access: "asks-first" })).bot;
  await openWindow(run.endpoint);
  await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);
  await s1.request("message.send", {
    botId: bot.id,
    text: `This is a test inside Pobots only. Use the Pobots tool ask_human (mcp__pobots__ask_human) once, with the question "${QUESTION}" and the choices Teal and Amber. Use no connectors or MCP servers, and change no files outside your own folder. When my answer comes, reply with only the colour I chose.`,
  });
  let before;
  const end1 = Date.now() + 180_000;
  while (Date.now() < end1 && !before) {
    before = (await s1.request("snapshot")).cards.find((c) => c.kind === "question" && c.botId === bot.id);
    if (!before) await sleep(500);
  }
  check("cards after restart: the bot's question card is up before the restart", before?.title === QUESTION && before.choices.map((c) => c.label).join(",") === "Teal,Amber", JSON.stringify(before));
  if (!before) return s1.close();
  await until(`[...document.querySelectorAll(".app-rail .pb-card-title")].some((t) => t.textContent === ${JSON.stringify(QUESTION)})`, 15_000);
  await shot("80-card-before-restart");
  s1.close();

  // The restart, with the card open.
  await stopEngine();
  const endpoint = await startEngine();
  run.endpoint = endpoint;
  const s2 = await sideChannel(endpoint);
  const after = (await s2.request("snapshot")).cards.find((c) => c.id === before.id);
  check("cards after restart: the card is back with the same id, words and time", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
  const notices = (await s2.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items.filter((i) => i.kind === "notice").map((i) => i.text);
  check("cards after restart: the chat says the card stays open, not that the turn was cut short", notices.some((t) => /waited for your answer\. Its card stays open/.test(t)) && !notices.some((t) => /cut short/.test(t)), JSON.stringify(notices));
  await openWindow(endpoint);
  const shown = await until(`(() => { const c = [...document.querySelectorAll(".app-rail .pb-card")].find((x) => x.querySelector(".pb-card-title")?.textContent === ${JSON.stringify(QUESTION)}); return c && [...c.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t === "Teal" || t === "Amber"); })()`, 20_000);
  check("cards after restart: the window shows the card again with its choices", JSON.stringify(shown) === JSON.stringify(["Teal", "Amber"]), JSON.stringify(shown));
  await shot("81-card-after-restart");

  // His answer.
  await js(`(() => { const c = [...document.querySelectorAll(".app-rail .pb-card")].find((x) => x.querySelector(".pb-card-title")?.textContent === ${JSON.stringify(QUESTION)}); [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === "Amber").click(); })()`);
  const gone = await until(`![...document.querySelectorAll(".app-rail .pb-card-title")].some((t) => t.textContent === ${JSON.stringify(QUESTION)})`, 15_000);
  check("cards after restart: the answer takes the card off the rail", !!gone);
  const end2 = Date.now() + 180_000;
  let items = [];
  while (Date.now() < end2) {
    items = (await s2.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items;
    const at = items.findIndex((i) => i.kind === "user" && i.from?.card?.id === before.id);
    const b = (await s2.request("snapshot")).bots.find((x) => x.id === bot.id);
    if (at >= 0 && items.slice(at + 1).some((i) => i.kind === "bot" && !i.streaming) && b && (b.state === "done" || b.state === "idle")) break;
    await sleep(1000);
  }
  const at = items.findIndex((i) => i.kind === "user" && i.from?.card?.id === before.id);
  const msg = items[at];
  check("cards after restart: the bot got his answer as a new message, marked with the card", msg?.from?.type === "you" && msg.from.card.title === QUESTION && msg.text === "Amber", JSON.stringify(msg));
  const reply = items.slice(at + 1).filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
  check("cards after restart: the bot replies with what he chose", /amber/i.test(reply) && !/teal/i.test(reply), reply.slice(-120));
  // Test bots see the person's own connectors and MCP servers: none may be used.
  const outside = items.filter((i) => i.kind === "activity" && ((/^(Used|Using) .+ in /.test(i.label ?? "") && !/ in pobots$/i.test(i.label ?? "")) || /workbot/i.test(`${i.label} ${i.detail ?? ""}`)));
  check("cards after restart: no connector or MCP server outside Pobots was used", outside.length === 0, outside.map((i) => i.label).join("; "));
  await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === "Asker").click()`);
  const mark = await until(`[...document.querySelectorAll(".app-main .pb-from-card")].some((n) => n.textContent === ${JSON.stringify(`From your card: ${QUESTION}`)})`, 15_000);
  check("cards after restart: the window marks his answer From your card", !!mark);
  await shot("82-card-answer");
  s2.close();
}
