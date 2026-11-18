// The app check, step 24 (--only=sees): what a bot sees (docs/sees.md), with a real engine, the real
// Claude Code on this Mac and a bot on the cheapest Claude model. The Mac's own setup is the
// person's real one: it is only read. The check picks whatever connected services and skills exist
// at the time, and skips a part with a clear line when there is none.
//
//   1. "sees.inventory" reads what exists for the bot's folder, without a model call.
//   2. The bot gets a choice: one connected service off, one skill by name only.
//   3. Its real session shows it: the service that is off has no tools in the session, a service
//      that is on still has (the control), and the skill by name only can still be opened.
//
// Run it alone: node scripts/app-check.mjs --only=sees. What it shares with the other sections is in
// ../lib.mjs (step 1's bot and model in `run`).
import { sleep, check, sideChannel, run } from "../lib.mjs";

/** Claude Code's prefix for a server's tools: "claude.ai Notion" gives "mcp__claude_ai_Notion__". */
const toolPrefix = (server) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
/** Skills that only explain something, so opening one does nothing on the Mac. */
const CALM_SKILLS = ["keybindings-help", "artifact-design", "dataviz", "artifact-diagramming", "update-config"];

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap = await s.request("snapshot");
    const model = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const bot = (await s.request("bot.create", { name: "Seer", purpose: "For the check of what a bot sees", job: "Do what you are asked, briefly. Never use a connector or an MCP server unless asked.", model: model.id, effort: model.efforts.includes("low") ? "low" : model.defaultEffort, access: "asks-first" })).bot;

    // 1. The inventory, read for real.
    const t0 = Date.now();
    const read = await s.request("sees.inventory", { botId: bot.id });
    const inv = read.inventory;
    check("sees: the inventory is read without a model call", !!inv && !read.problem && Array.isArray(inv.services) && !inv.services.some((x) => x.name === "pobots") && inv.sets.some((x) => x.id === "coding"), read.problem ?? `${inv?.services.length} services, ${inv?.plugins.length} plugins, ${inv?.skills.length} skills in ${Date.now() - t0} ms`);
    if (!inv) return;
    const again = await s.request("sees.inventory", { botId: bot.id });
    check("sees: a second request within minutes uses the same read", again.inventory?.readAt === inv.readAt);

    const connected = inv.services.filter((x) => x.state === "connected" && x.tools > 0 && x.from !== "plugin");
    const [off, control] = connected;
    const skill = CALM_SKILLS.map((n) => inv.skills.find((k) => k.name === n)).find(Boolean) ?? inv.skills.find((k) => k.from === "built-in");
    if (!off) console.log("skip sees: no connected service with tools on this Mac, so the service part is left out");
    if (!skill) console.log("skip sees: no skill on this Mac, so the skill part is left out");
    if (!off && !skill) return;

    // 2. The choice.
    const sees = { ...(off ? { services: { rest: "on", except: [off.name] } } : {}), ...(skill ? { skills: { rest: "full", except: [skill.name] } } : {}) };
    const saved = (await s.request("bot.update", { botId: bot.id, patch: { sees } })).bot;
    check("sees: the choice is saved and carried on the bot", JSON.stringify(saved.sees) === JSON.stringify(sees), JSON.stringify(saved.sees));

    /** Sends a message and waits until the bot is done; a card for the skill is allowed once, any other is denied. */
    async function ask(text) {
      const before = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items.length;
      await s.request("message.send", { botId: bot.id, text });
      const end = Date.now() + 180_000;
      await sleep(1500);
      while (Date.now() < end) {
        const now = await s.request("snapshot");
        for (const c of now.cards.filter((x) => x.botId === bot.id)) {
          const yes = c.kind === "approval" && skill && `${c.title} ${c.detail} ${c.caption ?? ""}`.includes(skill.name);
          await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: yes ? "allow-once" : "deny" } }).catch(() => undefined);
        }
        const b = now.bots.find((x) => x.id === bot.id);
        if (b && (b.state === "done" || b.state === "blocked") && !b.helpers) break;
        await sleep(800);
      }
      const items = (await s.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items.slice(before);
      return { items, said: items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ") };
    }

    // 3a. The service that is off is not in the session; a service that is on still is.
    if (off) {
      const a = toolPrefix(off.name);
      const b = control ? toolPrefix(control.name) : undefined;
      const q = [
        "This is a test inside Pobots only. Do not call any tool, and do not search for tools.",
        "Look at the names of the tools you have, also the ones listed only by name as deferred tools.",
        `A: is there any tool whose name starts with "${a}"?`,
        ...(b ? [`B: is there any tool whose name starts with "${b}"?`] : []),
        b ? "Reply on one line in exactly this form: A=YES or A=NO, then a space, then B=YES or B=NO." : "Reply with exactly A=YES or A=NO.",
      ].join(" ");
      const r = await ask(q);
      const answer = r.said.toUpperCase();
      const used = r.items.filter((i) => i.kind === "activity" && i.tool !== "think");
      check(`sees: the service that is off (${off.label}) has no tools in the bot's real session`, /A\s*=\s*NO/.test(answer), r.said.slice(-120));
      if (b) check(`sees: a service that is on (${control.label}) still has its tools there`, /B\s*=\s*YES/.test(answer), r.said.slice(-120));
      else console.log("skip sees: only one connected service, so there is no service left on to compare with");
      check("sees: the bot called no tool for that", used.length === 0, used.map((i) => i.label).join("; "));
    }

    // 3b. The skill by name only can still be opened.
    if (skill) {
      const r = await ask(`This is a test inside Pobots only. Open the skill named ${skill.name} with your Skill tool, once. Do not follow its instructions and do nothing else. Then reply with the single word OPENED.`);
      const opened = r.items.some((i) => i.kind === "activity" && i.label === `Used the ${skill.name} skill`);
      check(`sees: a skill by name only (${skill.name}) can still be opened by the bot`, opened && /OPENED/i.test(r.said), `${r.items.filter((i) => i.kind === "activity").map((i) => i.label).join("; ")} | ${r.said.slice(-80)}`);
    }
  } finally {
    s.close();
  }
}
