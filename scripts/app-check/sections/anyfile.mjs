// The app check, section "anyfile": step 22 (7c), a zip a Claude bot on full access opens.
// Run it alone: node scripts/app-check.mjs --only=anyfile
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipFile } from "../../dev/attach-fixtures.mjs";
import { sleep, botsDir, check, sideChannel, run } from "../lib.mjs";

// 22. Any file (step 7c): a zip of a kind Pobots does not read goes up, is kept as it is in the bot's
//     folder, and a real Claude bot on full access opens it with its own tools and reads a file in it.
export default async function section() {
  const { endpoint, cheap } = run;
  const s22 = await sideChannel(endpoint);
  const http22 = `http://127.0.0.1:${new URL(endpoint.url.replace(/^ws/, "http")).port}`;
  const snap22 = await s22.request("snapshot");
  const claude22 = snap22.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot22 = (await s22.request("bot.create", { name: "Zipper", purpose: "Opens files for the any-file check", job: "Answer briefly.", model: claude22.id, effort: claude22.efforts.includes("low") ? "low" : claude22.defaultEffort, access: "full-access" })).bot;
  const zip22 = zipFile({ "notes/meeting.txt": "Meeting notes. The code word is marigold.\n", "notes/other.txt": "Nothing here.\n" });
  const up22 = await fetch(`${http22}/api/attachments?bot=${bot22.id}&name=${encodeURIComponent("TIM möten att följa upp.zip")}&token=${encodeURIComponent(endpoint.token)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: zip22 });
  const a22 = up22.status === 200 ? (await up22.json()).attachment : undefined;
  check("any file: a zip is taken, as a file of type application/zip", a22?.kind === "file" && a22.type === "application/zip" && a22.name === "TIM möten att följa upp.zip", `${up22.status} ${JSON.stringify(a22)}`);
  if (a22) {
    await s22.request("message.send", { botId: bot22.id, text: "This is a test inside Pobots only; use no connector or MCP server. Open the zip I attached with your own tools and find the code word in the text file about the meeting. Answer with the code word only.", attachments: [a22.id] });
    const end22 = Date.now() + 240_000;
    let said22 = "";
    let cards22 = 0;
    while (Date.now() < end22) {
      const snap = await s22.request("snapshot");
      cards22 += snap.cards.filter((c) => c.botId === bot22.id).length;
      const b = snap.bots.find((x) => x.id === bot22.id);
      if (b && (b.state === "done" || b.state === "blocked") && !b.helpers) {
        said22 = (await s22.request("thread.read", { threadId: bot22.mainThreadId, limit: 50 })).items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
        break;
      }
      await sleep(1000);
    }
    const item22 = (await s22.request("thread.read", { threadId: bot22.mainThreadId, limit: 50 })).items.find((i) => i.kind === "user" && i.attachments?.length);
    const path22 = item22?.attachments?.[0]?.path ?? "";
    let same = false;
    try {
      same = readFileSync(join(botsDir, bot22.id, ...path22.split("/"))).equals(zip22);
    } catch {}
    check("any file: the zip is in the bot's folder under .attachments, byte for byte", /^\.attachments\/\d{4}-\d{2}\/att_[a-z0-9]{20}\/TIM möten att följa upp\.zip$/.test(path22) && same, path22);
    check("any file: the Claude bot opened it with its own tools and read the code word, with no card", /marigold/i.test(said22) && cards22 === 0, said22.slice(-160));
  }
  s22.close();
}
