// The app check, section "fullaccess": step 21 (7c), full access means no cards, on Claude and on Codex.
// Run it alone: node scripts/app-check.mjs --only=fullaccess
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, work, check, engineLog, sideChannel, collectCodexThreads, type, run } from "../lib.mjs";

// ================================================================ step 7c (job 7, files-todo)
// 21. Full access means no cards (decided 14 Nov 2026). Claude Code's own safety check asks about
//     a heredoc into python3 with $( and backticks inside, also in its bypass mode; on 13 Nov 2026
//     each such question from the developer bot's helpers became a card. A bot on full access
//     starts a helper that runs that kind of command in a folder outside the bot's own: it runs,
//     the engine's log shows the harness asked, and no card is raised. A GPT bot on full access
//     runs the same command itself, with no card.
export default async function section() {
  const { endpoint, cheap } = run;
  const s21 = await sideChannel(endpoint);
  let snap21 = await s21.request("snapshot");
  for (let i = 0; i < 120 && !snap21.status.codex?.ready && !snap21.status.codex?.problem; i++) {
    await sleep(500);
    snap21 = await s21.request("snapshot");
  }
  const claude21 = snap21.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const gpt21 = snap21.status.codex?.ready ? (snap21.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap21.models.find((m) => m.harness === "codex")) : undefined;
  const low21 = (m) => (m.efforts.includes("low") ? "low" : m.defaultEffort);
  for (const [name, model] of [["Fullclaude", claude21], ["Fullgpt", gpt21]]) {
    if (!model) {
      check(`full access: a ${name === "Fullgpt" ? "GPT" : "Claude"} model to try`, false, snap21.status.codex?.problem ?? "none");
      continue;
    }
    const tag = model.harness === "codex" ? "Codex" : "Claude";
    const other = join(work, `outside-${tag.toLowerCase()}`);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "check.mjs"), "const x = 1;\n");
    const command = [
      `cd "${other}" && python3 - <<'EOF'`,
      `p="check.mjs"`,
      `s=open(p).read()`,
      "old='await ev(`$(\".pb-x\")[0]?.hasAttribute(\"data-gone\")`)'",
      "s=s.replace(old,'await ev(`$$(\".pb-x\")[0]?.dataset.id`)')",
      `open(p,"w").write(s + "// kiwi\\n")`,
      `EOF`,
      `cat check.mjs`,
    ].join("\n");
    const bot = (await s21.request("bot.create", { name, purpose: "Runs commands for the full-access check", job: "Do what you are asked, briefly.", model: model.id, effort: low21(model), access: "full-access" })).bot;
    const logFrom = engineLog.join("").length;
    const task =
      tag === "Claude"
        ? `Use your Agent tool to start exactly one helper (subagent_type general-purpose, not in the background) whose task is: run this exact Bash command once, unchanged, as one call, and report its output. Do not run it yourself.\n\n${command}\n\nWhen the helper is done, reply with one short sentence.`
        : `Run this exact shell command once, unchanged, as one call, and reply with one short sentence.\n\n${command}`;
    await s21.request("message.send", { botId: bot.id, text: task });
    const seen = [];
    const end21 = Date.now() + 300_000;
    let rested = false;
    while (Date.now() < end21) {
      const snap = await s21.request("snapshot");
      for (const c of snap.cards.filter((c) => c.botId === bot.id)) {
        seen.push(c);
        await s21.request("card.resolve", { cardId: c.id, decision: { type: c.kind === "question" ? "later" : "deny" } }).catch(() => undefined);
      }
      const b = snap.bots.find((x) => x.id === bot.id);
      if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers && Date.now() > end21 - 290_000) {
        rested = true;
        break;
      }
      await sleep(500);
    }
    check(`full access (${tag}): the turn ends`, rested);
    let file = "";
    try {
      file = readFileSync(join(other, "check.mjs"), "utf8");
    } catch {}
    check(`full access (${tag}): the command ran in the folder outside the bot's own`, /kiwi/.test(file), file.trim().slice(0, 60));
    check(`full access (${tag}): no card was raised`, seen.length === 0, seen.map((c) => `${c.kind}: ${c.title}`).join("; "));
    if (tag === "Claude") {
      const said = engineLog.join("").slice(logFrom);
      check("full access (Claude): the harness asked about the helper's command and Pobots let it go on (the log says so)", new RegExp(`Bot ${bot.id}: allowed a Bash call of a helper that the harness asked about, on full access`).test(said), said.match(/allowed a [^\n]*/)?.[0] ?? "no such line");
      const items21 = (await s21.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
      check("full access (Claude): it was a helper that ran it", items21.some((i) => i.kind === "helper"), items21.map((i) => i.kind).join(","));
    }
    if (tag === "Codex") collectCodexThreads();
  }
  s21.close();
}
