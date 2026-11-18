// The app check, section "titles": step 19 (7b), chat titles by real Haiku, change_settings, providers and usage.
// Run it alone: node scripts/app-check.mjs --only=titles
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { sleep, check, sideChannel, shot, run } from "../lib.mjs";

// 19 (step 7b): chat titles by real Haiku, the main bot's settings tool, the providers and usage
//    read for real (read-only). The real update of Claude Code or Codex is never run here.
export default async function section() {
  const { endpoint, cheap } = run;
  const s19 = await sideChannel(endpoint);
  const wait19 = async (fn, ms, every = 500) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return undefined;
      await sleep(every);
    }
  };
  const snap19 = await s19.request("snapshot");
  check("titles: the snapshot has the settings and the providers", snap19.settings?.titleModel === "claude-haiku-5-5" && snap19.settings.healthCheckSeconds === 300 && snap19.providers?.providers?.some((p) => p.id === "claude" && p.version), JSON.stringify({ model: snap19.settings?.titleModel, provs: snap19.providers?.providers?.map((p) => [p.id, p.version, p.installedBy]) }));
  const rested = (id) => wait19(async () => {
    const b = (await s19.request("snapshot")).bots.find((x) => x.id === id);
    return !!b && (b.state === "done" || b.state === "idle") && !b.helpers && !b.context?.tidying;
  }, 180_000);
  // A chat that ends with a fresh start gets its title from Haiku.
  const tb = (await s19.request("bot.create", { name: "Titlebot", purpose: "Answers briefly for the title check", job: "Answer briefly.", model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort })).bot;
  await s19.request("message.send", { botId: tb.id, text: "We are planning a picnic by the lake on Saturday with mango salad. Reply with one short sentence." });
  await rested(tb.id);
  const fresh = await s19.request("bot.startFresh", { botId: tb.id });
  check("titles: a fresh start begins", fresh.started === true);
  const titled = await wait19(async () => (await s19.request("chat.titles", { botId: tb.id })).chats[0], 180_000, 1000);
  check("titles: the chat that ended has a short title from Haiku", !!titled && titled.kind === "main" && titled.title.length > 3 && titled.title.length <= 80 && !/\n/.test(titled.title), JSON.stringify(titled));
  // The main bot changes a setting with its tool: no card, a quiet line in its chat says so.
  const before = (await s19.request("snapshot")).cards.length;
  await s19.request("message.send", { botId: "kaja", text: "Use your change_settings tool to set health_check_seconds to 600. Then reply with done." });
  const changed = await wait19(async () => (await s19.request("snapshot")).settings.healthCheckSeconds === 600, 180_000);
  check("titles: the main bot changed a setting with change_settings", !!changed);
  await rested("kaja");
  const snapAfter = await s19.request("snapshot");
  const cards = snapAfter.cards;
  const kajaThread = snapAfter.bots.find((b) => b.id === "kaja").mainThreadId;
  const line = (await s19.request("thread.read", { threadId: kajaThread, limit: 50 })).items.find((i) => i.kind === "notice" && !i.mark && i.text.startsWith("Pobots settings: "));
  check(
    "titles: no card to approve, and a quiet line in the main bot's chat says what changed",
    !!line && /providers looked at every 600 seconds/.test(line.text) && !cards.slice(before).some((c) => c.kind === "approval" || c.kind === "note"),
    JSON.stringify({ line: line?.text, cards: cards.slice(before).map((c) => [c.kind, c.title]) }),
  );
  // Usage, read for real from Claude Code and Codex on this Mac (only reads).
  const usage = (await s19.request("usage.read", { refresh: true })).usage;
  check("titles: usage is read from Claude Code on this Mac", usage.source === "providers" && usage.providers.some((p) => p.id === "claude"), JSON.stringify(usage.providers.map((p) => [p.id, p.accounts.map((a) => [a.windows.length, a.problem])])));
  await shot("62-usage-real");
  s19.close();
}
