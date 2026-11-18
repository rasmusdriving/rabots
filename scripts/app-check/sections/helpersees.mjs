// The app check's section "helpersees" (docs/build/step-helper-sees.md): a real bot on the cheapest
// Claude model with services and plugins "the rest: off" starts a helper on the cheapest GPT model.
// The helper's thread follows the bot's choice: the engine says what it switched off, Codex took the
// thread with it (no fallback), the helper answers, and while it works its `codex app-server` starts
// no MCP server of the person's Codex setup or of the Codex plugins. The person's setup is only read.
// Run it alone: node scripts/app-check.mjs --only=helpersees. What it shares with the other sections is
// in ../lib.mjs (step 1's bot and model in `run`).
import { execFileSync } from "node:child_process";
import { sleep, check, engine, engineLog, sideChannel, collectCodexThreads, run } from "../lib.mjs";

const WORD = "PLOMMON";

/** The processes under `pid`, from one `ps` (pid, parent, memory in KB, command). */
function tree(pid) {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const all = out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const mine = [];
  const walk = (p) => {
    for (const c of all.filter((x) => x.ppid === p)) (mine.push(c), walk(c.pid));
  };
  walk(pid);
  return mine;
}

/** A short, harmless name for a process: its program and first argument, never its environment. */
const short = (cmd) => cmd.split(/\s+/).slice(0, 2).map((x) => x.split("/").pop()).join(" ").slice(0, 60);

export default async function section() {
  const { endpoint, cheap } = run;
  const side = await sideChannel(endpoint);
  try {
    let snap = await side.request("snapshot");
    for (let i = 0; i < 120 && !snap.status.codex?.ready && !snap.status.codex?.problem; i++) (await sleep(500), (snap = await side.request("snapshot")));
    const gpt = snap.status.codex?.ready ? (snap.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap.models.find((m) => m.harness === "codex")) : undefined;
    if (!gpt) return check("helper sees: a GPT model to try", false, snap.status.codex?.problem ?? "none");
    const haiku = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = (m) => (m.efforts.includes("low") ? "low" : m.defaultEffort);
    const bot = (await side.request("bot.create", { name: "Narrow", purpose: "Starts a helper for the check of what a helper sees", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: haiku.id, effort: low(haiku), access: "edits-freely" })).bot;
    const sees = { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } };
    await side.request("bot.update", { botId: bot.id, patch: { sees } });

    const logFrom = engineLog.join("").length;
    const ask = `This is a test inside Pobots only. Use your Pobots tool start_helper (mcp__pobots__start_helper) exactly once, with title "One word", model ${gpt.id}, effort ${low(gpt)}, and wait true, and this task, word for word: "Reply with the single word ${WORD}. Use no tools, no connectors and no MCP servers." When it returns, reply with the helper's result word for word and nothing else.`;
    await side.request("message.send", { botId: bot.id, text: ask });

    // While the helper works: the engine's Codex processes, sampled.
    const seen = new Map();
    let most = 0;
    let rested = false;
    const end = Date.now() + 240_000;
    await sleep(1000);
    while (Date.now() < end) {
      const procs = tree(engine.pid).filter((p) => !/claude/i.test(p.cmd.split(/\s+/)[0] ?? ""));
      const servers = procs.filter((p) => /app-server/.test(p.cmd));
      for (const sv of servers) {
        const sub = [sv, ...procs.filter((p) => p.pid !== sv.pid && isUnder(procs, p, sv.pid))];
        most = Math.max(most, sub.reduce((n, p) => n + p.rss, 0));
        for (const p of sub) seen.set(short(p.cmd), Math.max(seen.get(short(p.cmd)) ?? 0, p.rss));
      }
      const s = await side.request("snapshot");
      for (const card of s.cards.filter((x) => x.botId === bot.id)) await side.request("card.resolve", { cardId: card.id, decision: { type: card.kind === "question" ? "later" : "deny" } }).catch(() => undefined);
      const b = s.bots.find((x) => x.id === bot.id);
      if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers) {
        rested = true;
        break;
      }
      await sleep(400);
    }
    collectCodexThreads();
    check("helper sees: the bot's turn and its GPT helper ended", rested);
    const items = (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
    const row = items.find((i) => i.kind === "helper" && i.title === "One word");
    check("helper sees: the helper ran on the GPT model and is done", row?.status === "done" && row.harness === "codex", JSON.stringify(row && { status: row.status, model: row.model, harness: row.harness }));
    const said = items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    check("helper sees: the helper's answer came back", new RegExp(WORD, "i").test(said), said.slice(-120));
    const log = engineLog.join("").slice(logFrom);
    const line = /a helper on a GPT model follows the bot's choice; off for it: ([^\n]*)/.exec(log);
    check("helper sees: the engine switched Codex's plugins and apps off for the helper", !!line && /\bplugins\b/.test(line[1]) && /\bapps\b/.test(line[1]), line?.[1] ?? "no line in the engine's log");
    check("helper sees: Codex took the thread with the choice, no fallback", !/did not take the thread settings|runs without the thread settings/i.test(log));
    const listed = [...seen.entries()].map(([k, v]) => `${k} ${Math.round(v / 1024)} MB`).join("; ");
    const mcp = [...seen.keys()].filter((k) => /mcp|launch\.mjs|server\.mjs/i.test(k));
    check("helper sees: the helper's Codex started no MCP server", seen.size > 0 && mcp.length === 0, `${Math.round(most / 1024)} MB at most: ${listed || "no app-server seen"}`);
  } finally {
    side.close();
  }
}

/** Whether `p` is a descendant of `root` among `procs`. */
function isUnder(procs, p, root) {
  for (let q = p, i = 0; q && i < 20; i++) {
    if (q.ppid === root) return true;
    q = procs.find((x) => x.pid === q.ppid);
  }
  return false;
}
