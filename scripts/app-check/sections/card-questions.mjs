// The app check, section "card-questions": protocol 23 (docs/build/step-card-follow-ups.md).
// Run it alone: node scripts/app-check.mjs --only=card-questions
// A real Claude bot on the cheapest model. A to-do: it adds one with add_todo, the person asks about
// it in the to-do's window, the bot's answer lands in the to-do, which stays open; then a button
// answers it as before. An ask_human card: the person asks about it, the waiting call returns his
// question, the bot answers and asks again in the same card (same id), the answer stands in the card;
// then a choice answers it as before.
import { sleep, check, sideChannel, js, shot, until, openWindow, run } from "../lib.mjs";

const TODO_TITLE = "Pick a test colour";
const QUESTION = "Which colour for the follow-up test?";
const RULES = "Use no connectors or MCP servers, and change no files outside your own folder.";

/** Types into the ask box inside `root` (an element expression) and presses Ask, as the person does. */
const askIn = (root, text) =>
  js(`(() => { const r = ${root}; const t = r.querySelector(".pb-cq-input"); t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`).then(() => sleep(150)).then(() => js(`(${root}).querySelector(".pb-cq-form .pb-btn").click()`));

async function settled(s, botId, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const b = (await s.request("snapshot")).bots.find((x) => x.id === botId);
    if (b && (b.state === "done" || b.state === "idle")) return true;
    await sleep(1000);
  }
  return false;
}

export default async function section() {
  const { cheap } = run;
  const s = await sideChannel(run.endpoint);
  const snap = await s.request("snapshot");
  const model = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot = (await s.request("bot.create", { name: "Explainer", purpose: "Answers questions about its cards for the check", job: "Do what you are asked, briefly.", model: model.id, effort: model.efforts.includes("low") ? "low" : model.defaultEffort, access: "asks-first" })).bot;
  await openWindow(run.endpoint);
  await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);

  // ---------------- a to-do
  await s.request("message.send", {
    botId: bot.id,
    text: `This is a test inside Pobots only. Use the Pobots tool add_todo (mcp__pobots__add_todo) once, with the title "${TODO_TITLE}", one text block "Choose Teal or Amber.", and the buttons Teal and Amber. ${RULES} Then reply with only the word Added. If I later ask about the to-do, answer in one short sentence that Teal is calmer if asked which is calmer, and Amber is warmer if asked which is warmer.`,
  });
  let todo;
  const end1 = Date.now() + 180_000;
  while (Date.now() < end1 && !todo) {
    todo = (await s.request("snapshot")).todos.find((t) => t.botId === bot.id && t.title === TODO_TITLE);
    if (!todo) await sleep(500);
  }
  check("card questions: the bot's to-do is on the list", !!todo, JSON.stringify(todo));
  if (!todo) return s.close();
  await settled(s, bot.id);
  await js(`document.querySelector('.app-rail .pb-todo-item[data-todo-id="${todo.id}"]').click()`);
  const box = await until(`document.querySelector(".pb-dialog .pb-cq-input")?.placeholder`, 15_000);
  check("card questions: the to-do's window has the box", box === "Ask about this before you act", box);
  const dialog = `document.querySelector(".pb-dialog")`;
  await askIn(dialog, "Which one is calmer?");
  await askIn(dialog, "Which one is warmer?");
  const todoRows = await until(`document.querySelectorAll(".pb-dialog .pb-cq-item").length === 2`, 15_000);
  check("card questions: two questions can be sent to the same to-do before acting", !!todoRows);
  let q;
  const end2 = Date.now() + 180_000;
  while (Date.now() < end2) {
    q = (await s.request("snapshot")).todos.find((t) => t.id === todo.id)?.questions;
    if (q?.length === 2 && q.every((x) => x.state === "answered" || x.state === "unanswered")) break;
    await sleep(1000);
  }
  check("card questions: the bot's answer lands in the to-do", q?.[0]?.state === "answered" && /teal/i.test(q[0].answer ?? "") && q?.[1]?.state === "answered" && /amber/i.test(q[1].answer ?? ""), JSON.stringify(q));
  const shown = await until(`document.querySelector(".pb-dialog .pb-cq-answer")?.textContent`, 15_000);
  check("card questions: the window shows the answer inside the to-do", /teal/i.test(shown ?? ""), shown);
  check("card questions: the to-do stays open after a question", !!(await s.request("snapshot")).todos.find((t) => t.id === todo.id));
  let items = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items;
  const asked = items.find((i) => i.kind === "user" && i.from?.question && i.from.todo?.id === todo.id);
  check("card questions: his question is in the chat, marked as a question on the to-do", asked?.text === "Which one is calmer?", JSON.stringify(asked?.from));
  await shot("90-todo-question");
  await settled(s, bot.id);
  // Then the button answers it as before.
  await js(`[...document.querySelectorAll(".pb-dialog .pb-todo-actions .pb-btn")].find((b) => b.textContent.trim() === "Amber").click()`);
  const end3 = Date.now() + 180_000;
  let answer;
  while (Date.now() < end3 && !answer) {
    items = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items;
    answer = items.find((i) => i.kind === "user" && i.from?.todo?.id === todo.id && !i.from.question);
    if (!answer) await sleep(1000);
  }
  check("card questions: a button still answers the to-do as before", /Amber/.test(answer?.text ?? "") && !(await s.request("snapshot")).todos.some((t) => t.id === todo.id), answer?.text);
  await settled(s, bot.id);

  // ---------------- an ask_human card
  await s.request("message.send", {
    botId: bot.id,
    text: `Next test, inside Pobots only. Use the Pobots tool ask_human (mcp__pobots__ask_human) with the question "${QUESTION}" and the choices Teal and Amber. ${RULES} If the tool returns that I ask a question first, answer it in one short sentence (Teal is calmer if asked which is calmer, Amber is warmer if asked which is warmer), then call ask_human again with the same question and choices. Repeat for each follow-up as the tool says. When my answer comes, reply with only the colour I chose.`,
  });
  let card;
  const end4 = Date.now() + 180_000;
  while (Date.now() < end4 && !card) {
    card = (await s.request("snapshot")).cards.find((c) => c.kind === "question" && c.botId === bot.id);
    if (!card) await sleep(500);
  }
  check("card questions: the bot's question card is up", card?.title === QUESTION, JSON.stringify(card));
  if (!card) return s.close();
  const cardEl = `[...document.querySelectorAll(".app-rail .pb-card")].find((c) => c.querySelector(".pb-card-title")?.textContent.startsWith("Which colour"))`;
  await until(`!!(${cardEl})?.querySelector(".pb-cq-input")`, 15_000);
  await askIn(cardEl, "Which one is calmer?");
  await askIn(cardEl, "Which one is warmer?");
  let now;
  const end5 = Date.now() + 180_000;
  while (Date.now() < end5) {
    now = (await s.request("snapshot")).cards.find((c) => c.id === card.id);
    if (now?.questions?.length === 2 && now.questions.every((x) => x.state === "answered" || x.state === "unanswered")) break;
    await sleep(1000);
  }
  const q0 = now?.questions?.[0];
  check("card questions: the bot answered and asked again in the same card (same id), with the answer in it", q0?.state === "answered" && /teal/i.test(q0.answer ?? "") && now?.questions?.[1]?.state === "answered" && /amber/i.test(now.questions[1].answer ?? ""), JSON.stringify(now));
  check("card questions: only one card for the question stands on the rail", (await s.request("snapshot")).cards.filter((c) => c.kind === "question" && c.botId === bot.id).length === 1);
  const inCard = await until(`(${cardEl})?.querySelector(".pb-cq-answer")?.textContent`, 15_000);
  check("card questions: the window shows the answer inside the card", /teal/i.test(inCard ?? ""), inCard);
  items = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
  const askedCard = items.filter((i) => i.kind === "user" && i.from?.question && i.from.card?.id === card.id);
  check("card questions: his questions on the card reach the chat once each and in order", askedCard.length === 2 && askedCard[0].text === "Which one is calmer?" && askedCard[1].text === "Which one is warmer?" && askedCard.every((i) => !i.queued), JSON.stringify(askedCard));
  await shot("91-card-question");
  // Then a choice answers it as before.
  await js(`[...(${cardEl}).querySelectorAll(".pb-card-actions .pb-btn")].find((b) => b.textContent.trim() === "Amber").click()`);
  await settled(s, bot.id);
  items = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
  const last = items.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
  check("card questions: the choice reaches the bot as before", /amber/i.test(last) && !/teal/i.test(last), last.slice(-120));
  const outside = items.filter((i) => i.kind === "activity" && ((/^(Used|Using) .+ in /.test(i.label ?? "") && !/ in pobots$/i.test(i.label ?? "")) || /workbot/i.test(`${i.label} ${i.detail ?? ""}`)));
  check("card questions: no connector or MCP server outside Pobots was used", outside.length === 0, outside.map((i) => i.label).join("; "));
  s.close();
}
