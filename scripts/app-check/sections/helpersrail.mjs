// The app check's section "helpersrail" (docs/build/step-helpers-in-rail.md, 16 Nov 2026): a real bot
// on the cheapest Claude model starts a helper with start_helper (wait false) for a slow harmless
// command and ends its turn. While the helper works, the bot lists it in Bot.workingHelpers (title,
// harness, its row's thread and its own, when it started) and says it waits for a helper; when the
// helper ends, the list goes. Run it alone: node scripts/app-check.mjs --only=helpersrail.
import { sleep, check, sideChannel, run } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Pobots tools named here; use no connectors or MCP servers, change no files outside your own folder.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap0 = await s.request("snapshot");
    const haiku = snap0.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const bot = (await s.request("bot.create", { name: "Rail", purpose: "For the helpers at work check", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low, access: "edits-freely" })).bot;
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
    const rows = async () => (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items.filter((i) => i.kind === "helper");

    await s.request("message.send", {
      botId: bot.id,
      text: `${RULES} Use your Pobots tool start_helper exactly once, with title "Slow count", model ${haiku.id}, effort ${low}, wait false, and this task, word for word: Run the shell command "sleep 40; echo done" with your shell tool, then reply with one short line. Then reply with one short line that you started it, and end your turn. Do not wait for the helper.`,
    });
    // While it works: the bot lists it, and once its own turn is over it says it waits for a helper.
    const listed = await until(async () => {
      await denyNewCards();
      const b = await state();
      const w = b?.workingHelpers?.find((x) => x.title === "Slow count");
      return w ? { b, w } : undefined;
    }, 150_000);
    check("helpersrail: while the helper works, its bot lists it", !!listed, listed?.b?.workingHelpers);
    if (listed) {
      const row = (await rows()).find((r) => r.title === "Slow count");
      const { w } = listed;
      check("helpersrail: the list names its item, its row's thread, its own thread, when it started and its harness",
        !!row && w.itemId === row.id && w.threadId === bot.mainThreadId && w.helperThreadId === row.helperThreadId && w.startedAt === row.at && w.harness === "claude" && w.model === haiku.id && !w.inRun && !w.parentItemId,
        { w, row: row && { id: row.id, threadId: row.threadId, helperThreadId: row.helperThreadId, at: row.at } });
    }
    const waiting = await until(async () => {
      const b = await state();
      return b?.workingHelpers?.length && /^Waiting for a helper/.test(b.activity) ? b.activity : b && !b.workingHelpers?.length ? "ended" : undefined;
    }, 90_000, 300);
    check("helpersrail: after its turn the bot says it waits for a helper, with the helper listed", typeof waiting === "string" && waiting !== "ended", waiting);
    // When it ends, the list goes.
    const ended = await until(async () => {
      await denyNewCards();
      const b = await state();
      return b && !b.workingHelpers && !b.helpers ? b : undefined;
    }, 180_000, 1000);
    const row = (await rows()).find((r) => r.title === "Slow count");
    check("helpersrail: when the helper ends, the list goes", !!ended && row?.status !== "running", { helpers: ended?.helpers, list: ended?.workingHelpers, status: row?.status });
    await until(async () => {
      const b = await state();
      return b && (b.state === "done" || b.state === "idle" || b.state === "blocked") ? true : undefined;
    }, 120_000, 1000);
  } finally {
    s.close();
  }
}
