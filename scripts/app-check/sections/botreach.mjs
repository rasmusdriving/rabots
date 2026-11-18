// The app check's section "botreach" (docs/build/step-bot-reach.md, 15 Nov 2026): real bots on the
// cheapest Claude model. A bot starts a helper on Haiku with start_helper (wait false) for a few slow
// harmless commands, reads it with read_helper in both views, steers it with steer_helper and the
// helper acts on it; then it starts another and stops it with stop_helper. The main bot (Kaja, step
// 1's bot) steers a working bot with message_bot delivery steer, and a bot without the right that
// asks for steer gets queue and says so. Run it alone: node scripts/app-check.mjs --only=botreach.
import { sleep, check, sideChannel, run } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Pobots tools named here and your shell; use no connectors or MCP servers, change no files outside your own folder.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap0 = await s.request("snapshot");
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const make = async (name) => (await s.request("bot.create", { name, purpose: `For the bot reach check (${name})`, job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low, access: "edits-freely" })).bot;
    const state = async (id) => (await s.request("snapshot")).bots.find((b) => b.id === id);
    const rested = async (id, ms = 240_000) => {
      const end = Date.now() + ms;
      await sleep(1500);
      while (Date.now() < end) {
        for (const c of (await s.request("snapshot")).cards) {
          if (cardsAtStart.has(c.id)) continue;
          await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
        }
        const b = await state(id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers && !b.context?.tidying) return true;
        await sleep(1000);
      }
      return false;
    };
    const until = async (fn, ms, every = 500) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return undefined;
        await sleep(every);
      }
    };
    const read = async (threadId, limit = 300) => (await s.request("thread.read", { threadId, limit })).items;
    const lastSaid = async (bot) => (await read(bot.mainThreadId)).filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    const helpers = async (bot) => (await read(bot.mainThreadId)).filter((i) => i.kind === "helper");

    // 1. A bot follows, steers and stops its helpers.
    const reach = await make("Reacher");
    const slow = 'Run these four shell commands with your shell tool, one call each, one after the other, never together: "sleep 10; echo one", "sleep 10; echo two", "sleep 10; echo three", "sleep 10; echo four". Then reply with one short line, and say there any word you were told to say while you worked.';
    await s.request("message.send", {
      botId: reach.id,
      text: `${RULES} Use your Pobots tool start_helper exactly once, with title "Slow count", model ${haiku.id}, effort ${low}, wait false, and this task, word for word: ${slow} Then call read_helper with the helper's id from start_helper's answer (view latest), then read_helper with that id and view overview, then steer_helper with that id and the text: Also say the word KIWI in your last line. Then reply with the helper's id and nothing else.`,
    });
    const steered = await until(async () => {
      const row = (await helpers(reach)).find((h) => h.title === "Slow count");
      if (!row) return undefined;
      const t = await read(row.helperThreadId);
      return t.find((i) => i.kind === "user" && i.steered && i.from.type === "bot" && i.from.botId === reach.id) ? row : undefined;
    }, 150_000);
    check("botreach: a bot steered its working helper with steer_helper, and the helper's thread shows it from the bot", !!steered, steered?.status);
    const acts = (await read(reach.mainThreadId)).filter((i) => i.kind === "activity").map((i) => i.label);
    check("botreach: the bot read its helper (read_helper, both views)", acts.filter((l) => l === "Looked at a helper's work").length >= 2, acts.join(" | "));
    check("botreach: its answer names the helper's id", !!steered && (await until(async () => (await lastSaid(reach)).includes(steered.id.slice(0, 8)), 60_000)) === true, (await lastSaid(reach)).slice(0, 200));
    const r1 = await rested(reach.id, 240_000);
    const row1 = (await helpers(reach)).find((h) => h.title === "Slow count");
    const words1 = row1 ? (await read(row1.helperThreadId)).filter((i) => i.kind === "bot").map((i) => i.text).join(" ") : "";
    check("botreach: the helper finished and acted on the steer (KIWI in its last line)", r1 && row1?.status === "done" && /KIWI/i.test(words1), `${row1?.status}: ${words1.slice(-200)}`);

    await s.request("message.send", {
      botId: reach.id,
      text: `${RULES} Use start_helper exactly once with title "Long wait", model ${haiku.id}, effort ${low}, wait false, and the task: Run the shell command "sleep 120; echo late" and then reply with one line. Then call stop_helper with its id at once. Then reply with the first sentence of stop_helper's answer, word for word.`,
    });
    const r2 = await rested(reach.id, 180_000);
    const row2 = (await helpers(reach)).find((h) => h.title === "Long wait");
    check("botreach: stop_helper stopped the helper at once", r2 && row2?.status === "stopped", row2?.status);
    // The cheapest model passes answers on in its own words, so the checks below look for what they say, not their wording.
    check("botreach: the bot was told it stopped", /stopped/i.test(await lastSaid(reach)), (await lastSaid(reach)).slice(0, 200));

    // 2. The main bot steers a working bot.
    const busy = await make("Busybot");
    const work = 'Run these three shell commands with your shell tool, one call each, one after the other: "sleep 12; echo a", "sleep 12; echo b", "sleep 12; echo c". Then reply with one line that names every word another bot told you while you worked, or NONE.';
    const startWork = async () => {
      await s.request("message.send", { botId: busy.id, text: `${RULES} ${work}` });
      return until(async () => {
        const b = await state(busy.id);
        return b?.state === "working" ? true : undefined;
      }, 60_000, 300);
    };
    check("botreach: the bot to steer is working", (await startWork()) === true);
    await s.request("message.send", { botId: "kaja", text: `${RULES} Use your Pobots tool message_bot once: to ${busy.name}, mode tell, delivery steer, text: The word is PLUM. Then reply with message_bot's answer word for word.` });
    const kajaRested = await rested("kaja", 120_000);
    const kajaSaid = await lastSaid(snap0.bots.find((b) => b.id === "kaja"));
    check("botreach: the main bot's message_bot receipt says it steered and what the other bot was doing", kajaRested && /steer/i.test(kajaSaid) && /(working|running|busy|thinking)/i.test(kajaSaid), kajaSaid.slice(0, 240));
    const inBusy = (await read(busy.mainThreadId)).find((i) => i.kind === "user" && i.from.type === "bot" && i.from.botId === "kaja" && /PLUM/.test(i.text));
    check("botreach: it stands in the working bot's chat from the main bot, marked steered, in its running turn", !!inBusy && inBusy.steered === true && !!inBusy.turnId && !inBusy.queued, JSON.stringify(inBusy && { steered: inBusy.steered, queued: inBusy.queued, turn: !!inBusy.turnId }));
    await rested(busy.id, 180_000);
    check("botreach: the working bot acted on it in the same turn", /PLUM/i.test(await lastSaid(busy)), (await lastSaid(busy)).slice(0, 200));

    // 3. A bot without the right asks for steer and gets queue.
    await s.request("bot.update", { botId: reach.id, patch: { mayMessage: [busy.id] } });
    check("botreach: the bot does not have the right", (await state(reach.id))?.maySteer === false);
    check("botreach: the bot to steer is working again", (await startWork()) === true);
    await s.request("message.send", { botId: reach.id, text: `${RULES} Use your Pobots tool message_bot once: to ${busy.name}, mode tell, delivery steer, text: The word is FIG. Then reply with message_bot's answer word for word.` });
    await rested(reach.id, 120_000);
    const reachSaid = await lastSaid(reach);
    check("botreach: the receipt says it was queued because the bot may not steer", /queued/i.test(reachSaid) && /(not allowed|may not|cannot|can't|no right|permission)/i.test(reachSaid), reachSaid.slice(0, 240));
    const fig = (await read(busy.mainThreadId)).find((i) => i.kind === "user" && i.from.type === "bot" && i.from.botId === reach.id && /FIG/.test(i.text));
    check("botreach: the message waited in line, not steered", !!fig && !fig.steered, JSON.stringify(fig && { steered: fig.steered, queued: fig.queued }));
    await rested(busy.id, 240_000);
  } finally {
    s.close();
  }
}
