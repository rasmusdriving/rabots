// The app check, section "activitylog" (engine 0.28.0, docs/build/step-activity-log.md): a real main
// bot (Kaja, on the cheapest Claude model) reads today's activity with its activity_log tool after a
// message sent from the window:
//
//   1. The server noted the message as the person's, from the Mac, with its item's id (person_actions).
//   2. Kaja called activity_log (one "Looked at the day's activity" line in its chat).
//   3. Its answer has the message's local time from the log.
//
// Nothing here reaches outside Pobots: no connector, no service, no file outside the check's folders.
// Run it alone: node scripts/app-check.mjs --only=activitylog
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sleep, check, sideChannel, run, dataDir } from "../lib.mjs";

export default async function section() {
  const { endpoint } = run;
  const s = await sideChannel(endpoint);
  try {
    const snap0 = await s.request("snapshot");
    const kaja = snap0.bots.find((b) => b.id === "kaja");
    const rested = async (ms = 180_000) => {
      const end = Date.now() + ms;
      await sleep(1200);
      while (Date.now() < end) {
        const b = (await s.request("snapshot")).bots.find((x) => x.id === "kaja");
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers && !b.context?.tidying) return true;
        await sleep(800);
      }
      return false;
    };
    await rested();
    const { item } = await s.request("message.send", {
      botId: "kaja",
      text: "This is a check inside Pobots only. Call your activity_log tool once, with nothing given. Use no connectors or MCP servers, change no files outside your own folder. Then reply with only the time (HH:MM) of the newest message to Kaja in its Your actions list.",
    });
    await rested();

    // 1. Noted by the server as his, from the Mac (the check's side channel uses the local token).
    const db = new DatabaseSync(join(dataDir, "pobots.db"), { readOnly: true });
    let row;
    try {
      row = db.prepare("SELECT kind, bot_id, via, ref FROM person_actions WHERE ref = ?").get(item.id);
    } finally {
      db.close();
    }
    check("activitylog: the server noted the message as the person's, from the Mac", !!row && row.kind === "message" && row.bot_id === "kaja" && row.via === "mac", JSON.stringify(row ?? null));

    // 2 and 3. The tool was used, and the answer has the message's local time.
    const items = (await s.request("thread.read", { threadId: kaja.mainThreadId, limit: 60 })).items.filter((i) => i.seq > item.seq);
    const used = items.some((i) => i.kind === "activity" && /day's activity/.test(i.label));
    check("activitylog: the main bot called activity_log", used, JSON.stringify(items.filter((i) => i.kind === "activity").map((i) => i.label)));
    const t = new Date(item.at);
    const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const answer = items.filter((i) => i.kind === "bot").map((i) => i.text).join("\n");
    check(`activitylog: its answer has the message's local time ${hm}`, answer.includes(hm), answer.slice(0, 200));
  } finally {
    s.close();
  }
}
