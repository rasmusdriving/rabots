// The app check's section "flow-guides" (20 Nov 2026, docs/build/step-flow-guides.md): a real engine
// from the build, with no calendar and no channel, as a Pobots without Power Automate has it. The guides
// are in the build beside the engine; the main bot, on the cheapest model, reads the calendar guide from
// the path in its own instructions without a card; the engine's log has no warning or error from the
// calendar or the channels. Nothing leaves this computer. Run it alone: node scripts/app-check.mjs --only=flow-guides
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, engineLog, root, run, sideChannel, sleep } from "../lib.mjs";

const RULES = "This is a check inside Pobots only. Use only the Read tool named here; use no connectors or MCP servers, change no files outside your own folder.";

export default async function section() {
  const s = await sideChannel(run.endpoint);
  try {
    const dir = join(root, "dist", "engine", "guides");
    const files = ["calendar-flow.md", "teams-channel-flows.md", "flows/calendar.definition.json", "flows/teams-to-bots.definition.json", "flows/bot-answers-to-teams.definition.json"];
    const missing = files.filter((f) => !existsSync(join(dir, f)));
    check("flow-guides: the guides and the definitions are in the build beside the engine", !missing.length, missing.join(", "));
    const same = existsSync(join(dir, "calendar-flow.md")) && readFileSync(join(dir, "calendar-flow.md"), "utf8") === readFileSync(join(root, "docs", "guides", "calendar-flow.md"), "utf8");
    check("flow-guides: the build's calendar guide is the repository's", same);

    // Without Power Automate: no calendar, no channel.
    const cal = (await s.request("calendar.get", {})).calendar;
    const snap = await s.request("snapshot");
    check("flow-guides: no calendar and no channel to start with", cal.connected === false && !(snap.channels ?? []).length, JSON.stringify({ cal, channels: (snap.channels ?? []).length }));

    const main = snap.bots.find((b) => b.role === "main") ?? snap.bots[0];
    const cardsAtStart = new Set(snap.cards.map((c) => c.id));
    const items = async () => (await s.request("thread.read", { threadId: main.mainThreadId, limit: 300 })).items;
    const before = (await items()).length;
    await s.request("message.send", {
      botId: main.id,
      text: `${RULES} Your instructions name the full path of the guide for setting up the calendar flow. Read that file with the Read tool, then reply with only its first line, exactly as written.`,
    });
    const end = Date.now() + 180_000;
    const cards = [];
    let rested = false;
    await sleep(1500);
    while (Date.now() < end) {
      const now = await s.request("snapshot");
      for (const c of now.cards) {
        if (cardsAtStart.has(c.id) || cards.some((x) => x.id === c.id)) continue;
        cards.push(c);
        await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
      }
      const b = now.bots.find((x) => x.id === main.id);
      if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.context?.tidying) {
        rested = true;
        break;
      }
      await sleep(1000);
    }
    const after = (await items()).slice(before);
    const said = after.filter((i) => i.kind === "bot").at(-1)?.text ?? "";
    check("flow-guides: the main bot reads the calendar guide from its instructions and quotes its first line", rested && /Set up the calendar flow/.test(said), said.slice(0, 160));
    check("flow-guides: reading the guide raised no card", cards.length === 0, cards.map((c) => c.title ?? c.kind).join("; "));

    const log = engineLog.join("");
    const noisy = log.split("\n").filter((l) => /\b(warn|error)\b/i.test(l) && /calendar|channel|to-do block|todo block/i.test(l));
    check("flow-guides: the log has no warning or error from the calendar or the channels", noisy.length === 0, noisy.slice(0, 3).join(" | "));
  } finally {
    s.close();
  }
}
