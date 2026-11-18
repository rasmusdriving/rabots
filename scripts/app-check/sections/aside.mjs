// The app check's section "aside" (docs/build/step-no-wait-for-helpers.md, engine 0.24.1): a real bot
// on the cheapest Claude model runs a fresh run that starts a slow helper in the background with the
// harness's own helper tool and ends its turn. While that helper works, a message in the main chat is
// answered at once (it is not queued), the helper keeps working, and when it ends it reports back
// into the run's own thread and the run ends. Run it alone: node scripts/app-check.mjs --only=aside.
import { sleep, check, sideChannel, run } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the tools named here; use no connectors or MCP servers, change no files outside your own folder.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap0 = await s.request("snapshot");
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const bot = (await s.request("bot.create", { name: "Aside", purpose: "For the answer at once check", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low, access: "edits-freely" })).bot;
    const state = async () => (await s.request("snapshot")).bots.find((b) => b.id === bot.id);
    const until = async (fn, ms, every = 500) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return undefined;
        await sleep(every);
      }
    };
    const denyNewCards = async () => {
      for (const c of (await s.request("snapshot")).cards) {
        if (cardsAtStart.has(c.id)) continue;
        await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
      }
    };
    const read = async (threadId) => (await s.request("thread.read", { threadId, limit: 200 })).items;

    const trigger = (
      await s.request("trigger.save", {
        botId: bot.id,
        trigger: {
          kind: "webhook",
          name: "Slow round",
          where: "fresh",
          enabled: true,
          prompt: `${RULES} Use your Agent tool exactly once, with run_in_background true, description "Slow look", and this prompt, word for word: Run the shell command "sleep 50; echo done" with your Bash tool, then reply with only the word: heron. Then reply with one short line that you started it, and end your turn. Do not wait for the helper. When the helper reports back later, reply with only its word.`,
        },
      })
    ).trigger;
    const fired = (await s.request("trigger.run", { triggerId: trigger.id })).run;
    // The run's helper works and the run's own turn has ended.
    const working = await until(async () => {
      await denyNewCards();
      const b = await state();
      const w = b?.workingHelpers?.find((x) => x.title === "Slow look");
      return w && b.state !== "thinking" && /^Waiting for a helper/.test(b.activity) ? { b, w } : undefined;
    }, 150_000);
    check("aside: the fresh run's helper works in the background after the run's turn", !!working, working?.b && { activity: working.b.activity, list: working.b.workingHelpers });
    if (!working) return;
    const runThread = working.w.threadId;
    check("aside: the helper's row stands in the run's thread", runThread !== bot.mainThreadId, working.w);

    // A message in the main chat is answered at once while the helper works.
    const sentAt = Date.now();
    const sent = await s.request("message.send", { botId: bot.id, text: `${RULES} Reply with only the word: robin` });
    const sentItem = (await read(bot.mainThreadId)).find((i) => i.id === sent.item.id);
    check("aside: the main-chat message is not queued", sentItem && sentItem.queued === false, sentItem && { queued: sentItem.queued });
    const answered = await until(async () => {
      await denyNewCards();
      const items = await read(bot.mainThreadId);
      return items.find((i) => i.kind === "bot" && /robin/i.test(i.text) && i.seq > sentItem.seq);
    }, 90_000);
    const b1 = await state();
    const stillWorking = !!b1?.workingHelpers?.some((x) => x.title === "Slow look");
    check("aside: the main chat is answered while the helper still works", !!answered && stillWorking, { answered: answered?.text, secs: Math.round((Date.now() - sentAt) / 1000), stillWorking });

    // The helper ends and reports back into the run's thread; the run ends.
    const ended = await until(async () => {
      await denyNewCards();
      const b = await state();
      return b && !b.workingHelpers?.length && !b.helpers ? b : undefined;
    }, 180_000, 1000);
    check("aside: the helper ends by itself (it was not stopped)", !!ended);
    const row = (await read(runThread)).find((i) => i.kind === "helper" && i.title === "Slow look");
    check("aside: its row says done", row?.status === "done", row?.status);
    // The run's turn named the word already; the report is a later message that says only the word.
    const reported = await until(async () => {
      const items = await read(runThread);
      return items.find((i) => i.kind === "bot" && /^\W*heron\W*$/i.test(i.text.trim()) && (!row || i.seq > row.seq));
    }, 120_000, 1000);
    check("aside: the helper's result comes back in the run's own thread", !!reported, reported?.text);
    const mainHeron = (await read(bot.mainThreadId)).some((i) => i.kind === "bot" && /^\W*heron\W*$/i.test(i.text.trim()));
    check("aside: nothing of it is drawn into the main chat's own answers", !mainHeron);
    const done = await until(async () => {
      const r = (await s.request("trigger.runs", { triggerId: trigger.id })).runs.find((x) => x.id === fired.id);
      return r && r.status !== "running" ? r : undefined;
    }, 60_000, 1000);
    check("aside: the run ends after its helper", !!done && done.status !== "failed", done && { status: done.status, note: done.note });
    await until(async () => {
      const b = await state();
      return b && (b.state === "done" || b.state === "idle" || b.state === "blocked") ? true : undefined;
    }, 120_000, 1000);
  } finally {
    s.close();
  }
}
