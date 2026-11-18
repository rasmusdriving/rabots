// The app check, section "activityday" (engine 0.30.0, protocol 22, docs/build/step-activity-day-view.md):
// a message sent from the window to a real bot (Kaja, on the cheapest Claude model), then Settings,
// Activity in the same window:
//
//   1. Today's rows have the message ("Message to Kaja", You, its local time) and Kaja's turn started by you.
//   2. Nothing that was written is on the page: not the message, not Kaja's answer.
//   3. Previous day and Today step back and forth; the head keeps its place.
//
// Nothing here reaches outside Pobots: no connector, no service, no file outside the check's folders.
// Run it alone: node scripts/app-check.mjs --only=activityday
import { sleep, check, sideChannel, js, shot, until, openWindow, type, run } from "../lib.mjs";

const MARK = "ACTDAY-CHECK-WORDS";

export default async function section() {
  const { endpoint } = run;
  const s = await sideChannel(endpoint);
  try {
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
    await openWindow(endpoint);
    await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);
    await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === "Kaja").click()`);
    await until(`!!document.querySelector(".pb-composer textarea")`, 10_000);
    const sentAt = new Date();
    await type(`${MARK}: this is a check inside Pobots only. Use no tools, no connectors or MCP servers, change no files. Reply with the single word noted.`);
    await rested();
    const kaja = (await s.request("snapshot")).bots.find((x) => x.id === "kaja");
    const items = (await s.request("thread.read", { threadId: kaja.mainThreadId, limit: 40 })).items;
    const mine = [...items].reverse().find((i) => i.kind === "user" && i.text?.startsWith(MARK));
    const at = new Date(mine?.at ?? sentAt);
    const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const answer = [...items].reverse().find((i) => i.kind === "bot")?.text ?? "";

    // 1. Settings, Activity: today's rows.
    await js(`document.querySelector(".pb-foot-settings").click()`);
    await until(`!!document.querySelector('.pb-setwin-tab[data-section="activity"]')`, 10_000);
    await js(`document.querySelector('.pb-setwin-tab[data-section="activity"]').click()`);
    const rows = await until(
      `(() => { const r = [...document.querySelectorAll(".pb-actday-row")]; if (!r.length || document.querySelector(".pb-actday[data-reading]")) return null; return r.map((x) => [x.dataset.kind, x.querySelector(".pb-actday-time").firstChild.textContent, x.querySelector(".pb-actday-who").textContent, x.querySelector(".pb-actday-words").textContent]); })()`,
      20_000,
    );
    const msg = rows?.find((r) => r[0] === "you" && r[2] === "You" && /^Message to Kaja/.test(r[3]) && r[1] === hm);
    check(`activityday: today's rows have the message to Kaja at ${hm}, by You`, !!msg, JSON.stringify(rows ?? null).slice(0, 400));
    const turn = rows?.find((r) => r[0] === "turn" && r[2] === "Kaja" && /^Worked, started by you/.test(r[3]) && r[1] >= hm);
    check("activityday: and Kaja's turn, started by you", !!turn, JSON.stringify(rows ?? null).slice(0, 400));
    const head = await js(`({ name: document.querySelector(".pb-actday-name").textContent, summary: [...document.querySelectorAll(".pb-actday-summary p")].map((p) => p.textContent) })`);
    check("activityday: the day is named Today, with a summary of your actions", head?.name === "Today" && /^(You were active from|Your one action was at)/.test(head.summary?.[0] ?? ""), JSON.stringify(head));

    // 2. Nothing that was written.
    const words = answer.trim().split(/\s+/).filter((w) => w.length > 6).slice(0, 3);
    const leak = await js(`(() => { const t = document.querySelector(".app-appsettings").innerText; return [${JSON.stringify(MARK)}, ...${JSON.stringify(words)}].filter((w) => t.includes(w)); })()`);
    check("activityday: no message text on the page, neither his nor the bot's", Array.isArray(leak) && leak.length === 0, JSON.stringify(leak));
    await shot("activityday-today");

    // 3. Back a day and to today; the head keeps its place.
    const box = `["prev", "name", "next", "today"].map((k) => { const r = document.querySelector(".pb-actday-" + k).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(":"); }).join(",")`;
    const box0 = await js(box);
    await js(`document.querySelector(".pb-actday-prev").click()`);
    const y = await until(`document.querySelector(".pb-actday-name").textContent === "Yesterday" && !document.querySelector(".pb-actday[data-reading]") ? { rows: document.querySelectorAll(".pb-actday-row").length, empty: document.querySelector(".pb-actday-empty")?.textContent ?? "" } : null`, 15_000);
    check("activityday: Previous day shows yesterday", !!y, JSON.stringify(y ?? null));
    check("activityday: the head keeps its place", (await js(box)) === box0);
    await js(`document.querySelector(".pb-actday-today").click()`);
    const back = await until(`document.querySelector(".pb-actday-name").textContent === "Today" && !document.querySelector(".pb-actday[data-reading]") && document.querySelectorAll(".pb-actday-row").length > 0`, 15_000);
    check("activityday: Today goes back to today", !!back);
    await js(`document.querySelector(".pb-appsettings-back")?.click()`);
  } finally {
    s.close();
  }
}
