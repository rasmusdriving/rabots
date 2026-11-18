// The app check, section "maintools" (docs/build/step-main-bot-tools.md, docs/main-bot.md): a real main
// bot (Kaja, on the cheapest Claude model) changes and sets up another bot with its own tools, on the
// check's temporary folders, and nothing it may do is put on a card:
//
//   1. It sets what the other bot sees (one service off, or one skill by name only).
//   2. It starts the other bot fresh.
//   3. It rewrites the other bot's job, then undoes that change from its History.
//   4. It makes a schedule for the other bot switched off, switches it on and runs it now.
//   5. It makes a bot and retires it.
//   6. One quiet line per bot it changed, in its own chat; no card asked for any of it, and nothing
//      about it under Needs you (the tester's walk of 15 Nov 2026).
//
// The Mac's own setup is only read (the inventory, no model call). Nothing here reaches outside
// Pobots: no connector, no service, no file outside the check's folders, no provider update.
// Run it alone: node scripts/app-check.mjs --only=maintools
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, check, sideChannel, run, botsDir } from "../lib.mjs";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  const approvalsSeen = [];
  try {
    const snap0 = await s.request("snapshot");
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const pip = (await s.request("bot.create", { name: "Pip", purpose: "For the check of the main bot's tools", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, access: "asks-first" })).bot;

    const state = async (id) => (await s.request("snapshot")).bots.find((b) => b.id === id);
    const rested = async (id, ms = 180_000) => {
      const end = Date.now() + ms;
      await sleep(1200);
      while (Date.now() < end) {
        // Any card a bot raises here is denied and remembered: none should come.
        for (const c of (await s.request("snapshot")).cards) {
          if (cardsAtStart.has(c.id)) continue;
          if (!approvalsSeen.some((x) => x.id === c.id)) approvalsSeen.push({ id: c.id, title: c.title });
          await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
        }
        const b = await state(id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers && !b.context?.tidying) return true;
        await sleep(800);
      }
      return false;
    };
    const tellKaja = async (text) => {
      await s.request("message.send", { botId: "kaja", text: `This is a check inside Pobots only. Use only your Pobots tools, nothing else. ${text} Then reply with the word done.` });
      return rested("kaja");
    };
    // The quiet lines in Kaja's chat (notices without a mark) that start with a subject.
    const kajaThread = snap0.bots.find((b) => b.id === "kaja").mainThreadId;
    const linesFor = async (subject) =>
      (await s.request("thread.read", { threadId: kajaThread, limit: 200 })).items.filter((i) => i.kind === "notice" && !i.mark && i.text.startsWith(`${subject}: `)).map((i) => i.text);

    // Pip gets a session first, so it has something to start fresh from.
    await s.request("message.send", { botId: pip.id, text: "Reply with the word ready." });
    await rested(pip.id);

    // 1. What Pip sees.
    const inv = (await s.request("sees.inventory", { botId: pip.id })).inventory;
    const service = inv?.services.find((x) => x.state === "connected" && x.tools > 0 && x.from !== "plugin");
    const skill = inv?.skills.find((k) => k.from === "built-in") ?? inv?.skills[0];
    if (service) {
      await tellKaja(`Use your update_bot tool once with bot Pip and sees { "switch_off": ["${service.label}"] }.`);
      const sees = (await state(pip.id))?.sees;
      check(`maintools: the main bot switched ${service.label} off for another bot`, !!sees?.services && sees.services.rest === "on" && sees.services.except.includes(service.name), JSON.stringify(sees));
    } else if (skill) {
      await tellKaja(`Use your update_bot tool once with bot Pip and sees { "skills_by_name": ["${skill.name}"] }.`);
      const sees = (await state(pip.id))?.sees;
      check(`maintools: the main bot listed ${skill.name} by name only for another bot`, !!sees?.skills && sees.skills.except.includes(skill.name), JSON.stringify(sees));
    } else console.log("skip maintools: nothing to switch on this Mac, so what a bot sees is left out");

    // 2. A fresh start for Pip.
    await tellKaja("Use your update_bot tool once with bot Pip and start_fresh true.");
    const fresh = await (async () => {
      const end = Date.now() + 180_000;
      while (Date.now() < end) {
        const items = (await s.request("thread.read", { threadId: pip.mainThreadId, limit: 200 })).items;
        if (items.some((i) => i.kind === "notice" && i.mark === "fresh")) return true;
        await sleep(1000);
      }
      return false;
    })();
    check("maintools: the main bot started another bot fresh", fresh);
    await rested(pip.id);

    // 3. Pip's job, rewritten and undone.
    const jobFile = join(botsDir, pip.id, "AGENTS.md");
    await tellKaja('Use your update_bot tool once with bot Pip and job "Answer briefly. The check word is heron."');
    check("maintools: the main bot rewrote another bot's job", /The check word is heron\./.test(readFileSync(jobFile, "utf8")));
    const hist = (await s.request("bot.history", { botId: pip.id })).changes;
    check("maintools: that change is in the other bot's History with the main bot's name", hist[0]?.summary === "Kaja rewrote the job" && hist[0]?.canUndo === true, JSON.stringify(hist[0]));
    await tellKaja('Use your bot_files tool with bot Pip and action history, then bot_files with action undo and the change id of "Kaja rewrote the job".');
    check("maintools: the main bot undid that change from the History", !/heron/.test(readFileSync(jobFile, "utf8")), (await s.request("bot.history", { botId: pip.id })).changes[0]?.summary);

    // 4. A schedule for Pip: made switched off, switched on, run now.
    await tellKaja('Use your set_schedule tool once with bot Pip, name Ping, prompt "Reply with the word pong.", schedule daily at 23:59 on every day of the week, and enabled false.');
    let ping = (await s.request("trigger.list", { botId: pip.id })).triggers.find((t) => t.name === "Ping");
    check("maintools: the main bot made a schedule for another bot, switched off", !!ping && ping.enabled === false, JSON.stringify(ping && { enabled: ping.enabled }));
    if (ping) {
      await tellKaja(`Use your set_schedule tool once with bot Pip, id ${ping.id}, enabled true and run_now true. Give nothing else.`);
      ping = (await s.request("trigger.list", { botId: pip.id })).triggers.find((t) => t.id === ping.id);
      const runs = ping ? (await s.request("trigger.runs", { triggerId: ping.id })).runs : [];
      check("maintools: it switched the schedule on and ran it now, with what it was told kept", !!ping && ping.enabled && ping.prompt === "Reply with the word pong." && runs.length >= 1, JSON.stringify({ enabled: ping?.enabled, prompt: ping?.prompt, runs: runs.length }));
      await rested(pip.id);
    }

    // 5. A bot made and retired.
    await tellKaja(`Use your create_bot tool once: name Wren, purpose "Check bot", job "Answer briefly.", model ${cheap.id}, effort ${effort}.`);
    const wren = (await s.request("snapshot")).bots.find((b) => b.name === "Wren");
    check("maintools: the main bot made a bot at once, on Asks first", !!wren && wren.access === "asks-first", JSON.stringify(wren && { access: wren.access }));
    if (wren) {
      await tellKaja("Use your retire_bot tool once to retire Wren.");
      check("maintools: the main bot retired it at once", !(await s.request("snapshot")).bots.some((b) => b.id === wren.id));
    }

    // 6. Told, never asked: quiet lines in Kaja's chat, nothing under Needs you.
    const pipLines = await linesFor("Pip");
    check(
      "maintools: quiet lines in the main bot's chat say what changed about Pip, a job in a few words",
      pipLines.length >= 3 && pipLines.some((t) => /job rewritten \(about \d+ words\)/.test(t) && !/heron/.test(t)) && pipLines.some((t) => /the schedule Ping switched on|a new schedule Ping/.test(t)),
      JSON.stringify(pipLines).slice(0, 400),
    );
    check("maintools: a line says Wren was made and one that it was retired", (await linesFor("New bot Wren")).length === 1 && (await linesFor("Retired Wren")).length === 1, JSON.stringify([...(await linesFor("New bot Wren")), ...(await linesFor("Retired Wren"))]));
    const noteCards = (await s.request("snapshot")).cards.filter((c) => c.kind === "note" && !cardsAtStart.has(c.id));
    check("maintools: nothing about it under Needs you", noteCards.length === 0, JSON.stringify(noteCards.map((c) => c.title)));
    check("maintools: no card asked for any of it", approvalsSeen.length === 0, JSON.stringify(approvalsSeen));
  } finally {
    s.close();
  }
}
