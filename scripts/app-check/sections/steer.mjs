// The app check, section "steer": step 18, a message steered into a running turn on Claude and on Codex.
// Run it alone: node scripts/app-check.mjs --only=steer
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, botsDir, check, sideChannel, collectCodexThreads, js, shot, until, openWindow, run } from "../lib.mjs";

// 18. Steering (protocol 14): a message the person sends while a bot works goes into its running
//     turn, and the bot acts on it in that same turn. A bot on Claude and one on Codex, each on the
//     cheapest model at low effort with full access in its own temporary folder, run three short
//     commands one after the other; while the first runs, a message is steered in that asks for a
//     file with a word. Proved by the file, the word in the answer, and one turn id for all of it.
export default async function section() {
  const { endpoint, cheap } = run;
  const s18 = await sideChannel(endpoint);
  // Codex is looked for once the engine has started: wait for its answer (it says ready or why not).
  const end18 = Date.now() + 90_000;
  let snap18 = await s18.request("snapshot");
  while (!snap18.status.codex?.ready && Date.now() < end18) {
    await sleep(1000);
    snap18 = await s18.request("snapshot");
  }
  check("steer: the engine says steering is the default", snap18.chat?.followUp === "steer", JSON.stringify(snap18.chat));
  const claude18 = snap18.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const gpt18 = snap18.status.codex?.ready ? (snap18.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap18.models.find((m) => m.harness === "codex")) : undefined;
  check("steer: Codex is ready for the GPT half", !!gpt18, gpt18?.label ?? snap18.status.codex?.problem ?? "no GPT model");
  const TASK = 'Run these three shell commands with your shell tool, one call each, one after the other, never together: "sleep 6; echo one", "sleep 6; echo two", "sleep 6; echo three". After the third, reply with one short sentence.';
  const STEER = 'Change of plan: also write the word kiwi into a file named steer.txt in your folder before you reply. Say the word kiwi in your reply.';
  const wait18 = async (fn, ms, every = 250) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return undefined;
      await sleep(every);
    }
  };
  for (const [name, model] of [["Steerclaude", claude18], ["Steergpt", gpt18]]) {
    if (!model) continue;
    const tag = model.harness === "codex" ? "Codex" : "Claude";
    const bot = (await s18.request("bot.create", { name, purpose: "Runs short commands for the steering check", job: "Do what you are asked, briefly, inside your own folder only.", model: model.id, effort: model.efforts.includes("low") ? "low" : model.defaultEffort, access: "full-access" })).bot;
    const items = async () => (await s18.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
    const first = (await s18.request("message.send", { botId: bot.id, text: TASK })).item;
    // While a command of that turn runs, the message is steered in.
    const running = await wait18(async () => (await items()).some((i) => i.kind === "activity" && i.status === "running" && i.turnId), 120_000, 200);
    check(`steer (${tag}): the bot is in its first command`, !!running);
    const steered = (await s18.request("message.send", { botId: bot.id, text: STEER })).item;
    const turnId = (await items()).find((i) => i.id === first.id)?.turnId;
    check(`steer (${tag}): the message goes into the running turn: steered, not queued, with that turn's id`, steered.steered === true && steered.queued === false && !!turnId && steered.turnId === turnId, JSON.stringify({ steered: steered.steered, queued: steered.queued, same: steered.turnId === turnId }));
    const rested = await wait18(async () => {
      const b = (await s18.request("snapshot")).bots.find((x) => x.id === bot.id);
      return !!b && (b.state === "done" || b.state === "idle") && !b.helpers;
    }, 240_000, 500);
    check(`steer (${tag}): the turn ends`, !!rested);
    const all = await items();
    const after = all.filter((i) => i.seq >= first.seq);
    const said = after.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    const kept = all.find((i) => i.id === steered.id);
    let file = "";
    try {
      file = readFileSync(join(botsDir, bot.id, "steer.txt"), "utf8");
    } catch {}
    check(`steer (${tag}): the bot acted on it: steer.txt holds kiwi, and its answer says kiwi`, /kiwi/i.test(file) && /kiwi/i.test(said), JSON.stringify({ file: file.trim().slice(0, 40), said: said.slice(-160) }));
    const turns = [...new Set(after.map((i) => i.turnId).filter(Boolean))];
    check(`steer (${tag}): all in that same turn: one turn id from the first message to the answer, nothing queued, the message still steered`, turns.length === 1 && turns[0] === turnId && !after.some((i) => i.kind === "user" && i.queued) && kept?.steered === true && kept.queued === false, JSON.stringify({ turns: turns.length, kinds: after.map((i) => i.kind + (i.kind === "user" ? (i.steered ? ":steered" : "") : "")) }));
    const commands = after.filter((i) => i.kind === "activity").length;
    check(`steer (${tag}): the work went on after it went in (the commands did not stop)`, commands >= 3, `${commands} lines of work`);
    // In the window: the message carries "Steered".
    if (tag === "Claude") {
      await openWindow(endpoint);
      await until(`[...document.querySelectorAll(".app-row")].some((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)})`, 20_000);
      await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}).click()`);
      check("steer: the window shows the message as Steered", !!(await until(`[...document.querySelectorAll(".app-main .app-you")].some((y) => y.querySelector(".pb-msg-you")?.textContent.includes("kiwi") && y.querySelector(".app-you-note")?.textContent === "Steered")`, 20_000)));
      await shot("60-steered");
    }
    if (tag === "Codex") collectCodexThreads();
  }
  s18.close();
}
