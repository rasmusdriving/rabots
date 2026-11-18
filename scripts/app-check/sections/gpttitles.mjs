// The app check, section "gpttitles": chat titles by real GPT-6 Luna through the real Codex, and the
// fallback to Haiku 5.5 when Codex cannot (docs/build/step-gpt-titles.md, engine 0.33.0).
// Run it alone: node scripts/app-check.mjs --only=gpttitles
// The bot itself is on step 1's cheap Claude model; only its chat titles go through Codex. The title
// threads are ephemeral, so nothing is left in the person's Codex history.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, check, sideChannel, run, dataDir, engineLog, startEngine, stopEngine } from "../lib.mjs";

export default async function section() {
  const { cheap } = run;
  const waitFor = async (fn, ms, every = 1000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return undefined;
      await sleep(every);
    }
  };
  let s = await sideChannel(run.endpoint);
  const rested = (id) =>
    waitFor(async () => {
      const b = (await s.request("snapshot")).bots.find((x) => x.id === id);
      return !!b && (b.state === "done" || b.state === "idle") && !b.helpers && !b.context?.tidying;
    }, 180_000, 500);
  const snap = await s.request("snapshot");
  const luna = snap.models.find((m) => m.id === "gpt-6-luna") ?? snap.models.find((m) => m.harness === "codex" && /luna/i.test(m.id));
  check("gpttitles: Codex is ready and offers a Luna model", snap.status?.codex?.ready === true && !!luna, JSON.stringify({ codex: snap.status?.codex, gpt: snap.models.filter((m) => m.harness === "codex").map((m) => m.id) }));
  if (!luna) {
    s.close();
    return;
  }
  await s.request("settings.set", { patch: { titleModel: luna.id } });
  check("gpttitles: the title model is set to a GPT model", (await s.request("snapshot")).settings.titleModel === luna.id);

  // A chat that ends with a fresh start gets its title from Luna, through Codex.
  const bot = (await s.request("bot.create", { name: "Gptitler", purpose: "Answers briefly for the GPT title check", job: "Answer briefly.", model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort })).bot;
  const titleOf = async (n) => waitFor(async () => (await s.request("chat.titles", { botId: bot.id })).chats.filter((c) => c.title).length >= n && (await s.request("chat.titles", { botId: bot.id })).chats, 180_000);
  const logFrom = engineLog.join("").length;
  const t0 = Date.now();
  await s.request("message.send", { botId: bot.id, text: "We are repainting the garden shed dark green next weekend. Reply with one short sentence." });
  await rested(bot.id);
  check("gpttitles: a fresh start begins", (await s.request("bot.startFresh", { botId: bot.id })).started === true);
  const first = await titleOf(1);
  const said = engineLog.join("").slice(logFrom);
  const viaCodex = new RegExp(`titles are made by ${luna.id} through Codex`).test(said);
  check("gpttitles: the chat has a short title, made by Luna through Codex (the log says so)", !!first && first[0].title.length > 3 && first[0].title.length <= 80 && viaCodex, JSON.stringify({ title: first?.[0]?.title, viaCodex, secs: Math.round((Date.now() - t0) / 1000) }));
  check("gpttitles: the log line holds no chat text", !/shed|green|repaint/i.test(said.split("\n").filter((l) => /Chat titles/.test(l)).join("\n")));

  // A GPT model Codex does not have: the title still comes, from Haiku 5.5, and the log says why.
  await stopEngine();
  const cfgPath = join(dataDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, titles: { ...(cfg.titles ?? {}), model: "gpt-6.1-luna" } }));
  run.endpoint = await startEngine();
  s.close();
  s = await sideChannel(run.endpoint);
  check("gpttitles: after a restart the title model is the wrong id from config.json", (await s.request("snapshot")).settings.titleModel === "gpt-6.1-luna");
  const logFrom2 = engineLog.join("").length;
  await s.request("message.send", { botId: bot.id, text: "Now we plan a bake sale for the school on Friday. Reply with one short sentence." });
  await rested(bot.id);
  check("gpttitles: a second fresh start begins", (await s.request("bot.startFresh", { botId: bot.id })).started === true);
  const second = await titleOf(2);
  const said2 = engineLog.join("").slice(logFrom2);
  const fellBack = /Codex gave no title \(.*?\), so this one is made by claude-haiku-5-5/.test(said2);
  check("gpttitles: with a GPT id Codex does not have, the title comes from Haiku 5.5 and the log says why", !!second && second.filter((c) => c.title).length >= 2 && fellBack, JSON.stringify({ titles: second?.map((c) => c.title), fellBack, line: said2.split("\n").find((l) => /Chat titles/.test(l)) }));
  s.close();
}
