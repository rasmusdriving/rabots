// The app check's section "gptbotsees" (docs/build/step-gpt-bot-sees.md): a real bot on the cheapest
// GPT model answers once with no choice (its `codex app-server` starts what the person's Codex setup
// has), then its services and plugins are set to "the rest: off". Its next answer comes from the same
// Codex thread, resumed in a new `codex app-server` with the bot's choice: the engine says what it
// switched off, Codex took it (no fallback), and that app-server starts no MCP server of the person's
// Codex setup or of the Codex plugins. Memory of the bot's app-server before and after is in the details.
// The person's setup is only read. Run it alone: node scripts/app-check.mjs --only=gptbotsees.
import { execFileSync } from "node:child_process";
import { sleep, check, engine, engineLog, sideChannel, collectCodexThreads, run } from "../lib.mjs";

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

/** Whether `p` is a descendant of `root` among `procs`. */
function isUnder(procs, p, root) {
  for (let q = p, i = 0; q && i < 20; i++) {
    if (q.ppid === root) return true;
    q = procs.find((x) => x.pid === q.ppid);
  }
  return false;
}

const isMcp = (name) => /mcp|launch\.mjs|server\.mjs/i.test(name);

export default async function section() {
  const side = await sideChannel(run.endpoint);
  try {
    let snap = await side.request("snapshot");
    for (let i = 0; i < 120 && !snap.status.codex?.ready && !snap.status.codex?.problem; i++) (await sleep(500), (snap = await side.request("snapshot")));
    const gpt = snap.status.codex?.ready ? (snap.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap.models.find((m) => m.harness === "codex")) : undefined;
    if (!gpt) return check("gpt bot sees: a GPT model to try", false, snap.status.codex?.problem ?? "none");
    const low = gpt.efforts.includes("low") ? "low" : gpt.defaultEffort;
    const bot = (await side.request("bot.create", { name: "Narrow GPT", purpose: "Answers for the check of what a GPT bot sees", job: "Do what you are asked, briefly. Never use a connector or an MCP server.", model: gpt.id, effort: low, access: "edits-freely" })).bot;
    // App-servers that were there before this bot's first message belong to others.
    const others = new Set(tree(engine.pid).filter((p) => /app-server/.test(p.cmd)).map((p) => p.pid));

    /** One message; while it is answered, and a little after, this bot's new app-server and what runs under it. */
    async function turn(word, skip) {
      await side.request("message.send", { botId: bot.id, text: `This is a test inside Pobots only. Reply with the single word ${word} and nothing else. Use no tools, no connectors and no MCP servers.` });
      const seen = new Map();
      const servers = new Set();
      let most = 0;
      let doneAt = 0;
      const end = Date.now() + 180_000;
      await sleep(800);
      while (Date.now() < end) {
        const procs = tree(engine.pid);
        for (const sv of procs.filter((p) => /app-server/.test(p.cmd) && !others.has(p.pid) && !skip.has(p.pid))) {
          servers.add(sv.pid);
          const sub = [sv, ...procs.filter((p) => p.pid !== sv.pid && isUnder(procs, p, sv.pid))];
          most = Math.max(most, sub.reduce((n, p) => n + p.rss, 0));
          for (const p of sub) seen.set(short(p.cmd), Math.max(seen.get(short(p.cmd)) ?? 0, p.rss));
        }
        const s = await side.request("snapshot");
        for (const card of s.cards.filter((x) => x.botId === bot.id)) await side.request("card.resolve", { cardId: card.id, decision: { type: card.kind === "question" ? "later" : "deny" } }).catch(() => undefined);
        const b = s.bots.find((x) => x.id === bot.id);
        if (!doneAt && b && (b.state === "done" || b.state === "idle" || b.state === "blocked")) doneAt = Date.now();
        // Codex starts its MCP servers with the thread; a few seconds after the answer they are all up.
        if (doneAt && Date.now() - doneAt > 4000) break;
        await sleep(400);
      }
      const items = (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 50 })).items;
      const said = items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
      const listed = [...seen.entries()].map(([k, v]) => `${k} ${Math.round(v / 1024)} MB`).join("; ");
      return { ended: !!doneAt, answered: new RegExp(word, "i").test(said), servers, seen, mcp: [...seen.keys()].filter(isMcp), mb: Math.round(most / 1024), listed, said: said.slice(-120) };
    }

    const logFrom = engineLog.join("").length;
    const first = await turn("HERON", new Set());
    check("gpt bot sees: with no choice the GPT bot answers, its Codex as before", first.ended && first.answered && first.servers.size > 0, `${first.mb} MB at most: ${first.listed || "no app-server seen"}`);
    const log1 = engineLog.join("").slice(logFrom);
    check("gpt bot sees: with no choice nothing is switched off and Codex is not asked for its list", !/its own session on a GPT model follows the bot's choice/.test(log1));

    await side.request("bot.update", { botId: bot.id, patch: { sees: { services: { rest: "off", except: [] }, plugins: { rest: "off", except: [] } } } });
    const logFrom2 = engineLog.join("").length;
    const second = await turn("PLOVER", first.servers);
    collectCodexThreads();
    check("gpt bot sees: after the change it answers again", second.ended && second.answered, second.said);
    const log = engineLog.join("").slice(logFrom2);
    const line = /its own session on a GPT model follows the bot's choice; off for it: ([^\n]*)/.exec(log);
    check("gpt bot sees: the engine switched Codex's plugins and apps off for the bot's own session", !!line && /\bplugins\b/.test(line[1]) && /\bapps\b/.test(line[1]), line?.[1] ?? "no line in the engine's log");
    check("gpt bot sees: the same conversation, its Codex thread resumed", /started Codex and resumed its session/.test(log) && !/starting a fresh one|fresh session/i.test(log));
    check("gpt bot sees: Codex took the resumed thread with the choice, no fallback", !/did not take the thread settings|runs without the thread settings/i.test(log));
    check(
      "gpt bot sees: its new Codex started no MCP server",
      second.servers.size > 0 && second.mcp.length === 0,
      `before ${first.mb} MB (${first.mcp.length} MCP processes), after ${second.mb} MB: ${second.listed || "no app-server seen"}`,
    );
  } finally {
    side.close();
  }
}
