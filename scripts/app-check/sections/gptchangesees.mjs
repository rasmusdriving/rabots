// The app check's section "gptchangesees" (docs/build/step-gpt-change-sees.md): a real bot on the cheapest
// GPT model with the Coding set calls change_what_i_see to switch one harmless Codex service on
// (openaiDeveloperDocs, OpenAI's read-only documentation), then off. Each time its choice changes, a quiet
// line is written in its own chat, and its next answer comes from the same Codex thread, resumed with the
// new config (the engine's log says what is off for it). The person's Codex setup is only read: if it has
// no openaiDeveloperDocs, nothing is switched and the section says so. Run it alone:
// node scripts/app-check.mjs --only=gptchangesees.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { sleep, check, engineLog, sideChannel, collectCodexThreads, run } from "../lib.mjs";

/** The Coding set's services and plugins (engine/claude/sees.ts SEES_SETS); skills do not change on Codex. */
const CODING = { services: { rest: "off", except: ["plugin:1password:1password"] }, plugins: { rest: "off", except: ["design@synced", "1password@synced"] } };
const DOCS = "openaiDeveloperDocs";
const SAFE = "This is a test inside Pobots only. Use no connectors or MCP servers, change no files outside your own folder.";

/** Whether Codex lists the docs server, switched on in the person's setup. Read only: names and switches. */
function codexHasDocs() {
  try {
    const list = JSON.parse(execFileSync("codex", ["mcp", "list", "--json"], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
    return Array.isArray(list) && list.some((s) => s?.name === DOCS && s.enabled !== false);
  } catch {
    return false;
  }
}

export default async function section() {
  const side = await sideChannel(run.endpoint);
  try {
    let snap = await side.request("snapshot");
    for (let i = 0; i < 120 && !snap.status.codex?.ready && !snap.status.codex?.problem; i++) (await sleep(500), (snap = await side.request("snapshot")));
    const gpt = snap.status.codex?.ready ? (snap.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap.models.find((m) => m.harness === "codex")) : undefined;
    if (!gpt) return check("gpt changes sees: a GPT model to try", false, snap.status.codex?.problem ?? "none");
    if (!codexHasDocs()) return check(`gpt changes sees: Codex lists ${DOCS} to try with`, false, "not in codex mcp list; nothing was switched");
    const low = gpt.efforts.includes("low") ? "low" : gpt.defaultEffort;
    const bot = (await side.request("bot.create", { name: "Switching GPT", purpose: "Answers for the check of a GPT bot changing what it sees", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: gpt.id, effort: low, access: "edits-freely" })).bot;
    await side.request("bot.update", { botId: bot.id, patch: { sees: CODING } });

    const items = async () => (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 80 })).items;
    /** One message; waits until the bot is calm a few seconds after (a turn of its own may follow). */
    async function turn(text) {
      const before = (await items()).filter((i) => i.kind === "bot").length;
      await side.request("message.send", { botId: bot.id, text });
      const end = Date.now() + 240_000;
      let calmSince = 0;
      await sleep(800);
      while (Date.now() < end) {
        const s = await side.request("snapshot");
        for (const card of s.cards.filter((x) => x.botId === bot.id)) await side.request("card.resolve", { cardId: card.id, decision: { type: card.kind === "question" ? "later" : "deny" } }).catch(() => undefined);
        const b = s.bots.find((x) => x.id === bot.id);
        const calm = b && (b.state === "done" || b.state === "idle" || b.state === "blocked");
        if (!calm) calmSince = 0;
        else if (!calmSince) calmSince = Date.now();
        else if (Date.now() - calmSince > 5000) break;
        await sleep(500);
      }
      const all = await items();
      const said = all.filter((i) => i.kind === "bot").slice(before).map((i) => i.text).join(" ");
      return { ended: !!calmSince, said, lines: all.filter((i) => i.kind === "notice").map((i) => i.text) };
    }
    const docsOn = async () => {
      const b = (await side.request("snapshot")).bots.find((x) => x.id === bot.id);
      const svc = b?.sees?.services;
      return !!svc && (svc.rest === "on") !== svc.except.includes(DOCS);
    };
    const offLines = (from) => [...engineLog.join("").slice(from).matchAll(/Bot [^:]+: its own session on a GPT model follows the bot's choice; off for it: ([^\n]*)/g)].map((m) => m[1]);

    const logStart = engineLog.join("").length;
    const first = await turn(`${SAFE} Reply with the single word HERON and nothing else.`);
    check("gpt changes sees: with the Coding set the GPT bot answers, the docs server off for it", first.ended && /heron/i.test(first.said) && offLines(logStart).some((l) => l.includes(DOCS)), first.said.slice(-120));

    const logOn = engineLog.join("").length;
    const on = await turn(`${SAFE} Use the Pobots tool change_what_i_see with switch_on ["${DOCS}"]. Then reply with the single word PLOVER and nothing else. When Pobots gives you a turn after that, reply with the single word DONE and use nothing.`);
    collectCodexThreads();
    const logAfterOn = engineLog.join("").slice(logOn);
    check("gpt changes sees: the bot switched the docs server on with change_what_i_see", await docsOn(), on.said.slice(-160));
    check("gpt changes sees: a quiet line in its own chat says so", on.lines.some((l) => l === `Switching GPT changed what it sees: ${DOCS} on (was off)`), on.lines.slice(-3).join(" | "));
    check("gpt changes sees: its next turn resumed the same Codex thread with the docs server on", /started Codex and resumed its session/.test(logAfterOn) && !/starting a fresh one|fresh session/i.test(logAfterOn) && offLines(logOn).length > 0 && !offLines(logOn).at(-1).includes(DOCS), offLines(logOn).at(-1) ?? "no line in the engine's log");
    check("gpt changes sees: Codex took the resumed thread with the change, no fallback", !/did not take the thread settings|runs without the thread settings/i.test(logAfterOn));

    const logOff = engineLog.join("").length;
    const off = await turn(`${SAFE} Use the Pobots tool change_what_i_see with switch_off ["${DOCS}"]. Then reply with the single word TERN and nothing else.`);
    check("gpt changes sees: the bot switched the docs server off again, with a quiet line", !(await docsOn()) && off.lines.some((l) => l === `Switching GPT changed what it sees: ${DOCS} off (was on)`), off.said.slice(-120));
    const last = await turn(`${SAFE} Reply with the single word EGRET and nothing else.`);
    collectCodexThreads();
    const logAfterOff = engineLog.join("").slice(logOff);
    check(
      "gpt changes sees: its next answer works, on the same Codex thread with the docs server off",
      last.ended && /egret/i.test(last.said) && /started Codex and resumed its session/.test(logAfterOff) && !/starting a fresh one|fresh session/i.test(logAfterOff) && (offLines(logOff).at(-1) ?? "").includes(DOCS),
      `${last.said.slice(-80)}; off: ${offLines(logOff).at(-1) ?? "no line"}`,
    );
  } finally {
    side.close();
  }
}
