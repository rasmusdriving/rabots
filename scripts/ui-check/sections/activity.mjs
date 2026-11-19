// The window check, section "activity". Run it alone: node scripts/ui-check.mjs --only=activity
// Settings, Activity (protocol 22, docs/build/step-activity-day-view.md): a day of what happened in
// Pobots, read only. The tab after Usage; today's rows from the stand-in engine (ui/engine/
// mock-activity.ts) with times, who and the words; Previous day, Next day (not past today) and Today;
// the head not moving when the day changes, the old rows staying, faded, while the next day is read;
// a quiet day's one line; laptop and both phone sizes, light and dark, nothing sideways.
import { pathToFileURL } from "node:url";
import { b, check, ev, until, open, page, shot, houseRules, sleep } from "../lib.mjs";

const PHONES = {
  390: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  360: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};

async function openAt(width, height, theme) {
  const ua = PHONES[width];
  if (!ua) return open("", { width, height, theme });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua });
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}` });
  const ok = await until(`!!document.querySelector(".pb-shell[data-phone]")`, 6000);
  await sleep(300);
  return ok;
}

async function leavePhone() {
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
}

/** "Sun 15 Nov" for the day `n` days back, as the view names it. */
const backName = (n) => `(() => { const d = new Date(); d.setDate(d.getDate() - ${n}); return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()] + " " + d.getDate() + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]; })()`;

/** Where the head's parts stand: they must not move when the day changes. */
const headBoxes = `[".pb-actday-prev", ".pb-actday-name", ".pb-actday-next", ".pb-actday-today", ".pb-actday-checked", ".pb-setwin-tabs"].map((s) => { const r = $(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(":"); }).join(",")`;
const state = `({ name: text(".pb-actday-name"), rows: $$(".pb-actday-row").length, reading: !!$(".pb-actday[data-reading]"), fade: parseFloat(getComputedStyle($(".pb-actday-day")).opacity), todayHidden: getComputedStyle($(".pb-actday-today")).visibility === "hidden", nextOff: $(".pb-actday-next").getAttribute("aria-disabled") === "true", empty: text(".pb-actday-empty"), summary: $$(".pb-actday-summary p").length, status: text(".pb-actday-checked .pb-set7-checked-text") })`;

export default async function section() {
  const M = (name) => `activity: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      const phone = !!PHONES[width];
      await openAt(width, height, theme);
      if (phone) await ev(`$(".app-side").scrollTop = 99999`);
      await ev(`click($("${phone ? ".app-side " : ""}.pb-foot-settings"))`);
      await until(`!!$(".pb-setwin-tab[data-section='activity']")`);
      await sleep(250);
      await ev(`click($('.pb-setwin-tab[data-section="activity"]'))`);
      const first = await until(`$$(".pb-actday-row").length === 10 ? ${state} : null`);
      const tabs = await ev(`$$(".pb-setwin-tab").map((t) => t.textContent + (t.getAttribute("aria-selected") === "true" ? "*" : "")).join(",")`);
      check(T("Activity is the last section, after Connections, and chosen"), tabs === "General,Chats,Providers,Calendar,Usage,Connections,Activity*", tabs);
      if (phone) {
        const inRow = await ev(`(() => { const n = $(".pb-setwin-nav").getBoundingClientRect(); const t = $('.pb-setwin-tab[data-section="activity"]').getBoundingClientRect(); return t.left >= n.left - 1 && t.right <= n.right + 1; })()`);
        check(T("the chosen tab is brought into the row of tabs"), inRow === true, inRow);
      }
      check(T("today: its name, ten rows, the summary, Next and Today not offered"), first?.name === "Today" && first.summary === 2 && first.nextOff && first.todayHidden && !first.reading && /^Read at \d\d:\d\d\./.test(first.status), first);
      const rows = await ev(`$$(".pb-actday-row").map((r) => [r.dataset.kind, r.querySelector(".pb-actday-time").firstChild.textContent, r.querySelector(".pb-actday-end")?.textContent ?? "", r.querySelector(".pb-actday-who").textContent, r.querySelector(".pb-actday-words").textContent])`);
      check(
        T("rows: the time, its end, who and what, in time order"),
        Array.isArray(rows) &&
          rows[0]?.join("|") === 'turn|06:00|to 06:20|Kaja|Worked, started by schedule "Morning round", 2 turns: "Weekly note"' &&
          rows[1]?.join("|") === 'you|08:02||You|Message to Po, from a computer, chat "Planning the week"' &&
          rows.map((r) => r[1]).join() === [...rows.map((r) => r[1])].sort().join(),
        rows,
      );
      const fit = await ev(`(() => { const t = $$(".pb-actday-time").map((x) => Math.round(x.getBoundingClientRect().left)); const long = $$(".pb-actday-row").find((r) => r.dataset.kind === "helper"); return { aligned: new Set(t).size === 1, wraps: long.getBoundingClientRect().height > 30, clipped: $$(".pb-actday-text").some((x) => x.scrollWidth > x.clientWidth + 1), mono: getComputedStyle($(".pb-actday-time")).fontFamily.toLowerCase().includes("mono") }; })()`);
      check(T("times line up in mono; a long title wraps, nothing cut"), fit?.aligned && fit.mono && !fit.clipped && (width > 1000 || fit.wraps), fit);
      if (phone) {
        const taps = await ev(`[".pb-actday-prev", ".pb-actday-next"].map((s) => Math.round($(s).getBoundingClientRect().height))`);
        check(T("the arrows are 44 px to tap"), Array.isArray(taps) && taps.every((h) => h >= 44), taps);
      }
      await houseRules(T("today"));
      await shot(`activity-${theme}-${width}-today`);

      // Next on today does nothing.
      const box0 = await ev(headBoxes);
      await ev(`click($(".pb-actday-next"))`);
      await sleep(250);
      check(T("Next day is not offered past today"), (await ev(state))?.name === "Today");

      // A slow read: the head names the day at once and stands still; the old rows stay, faded.
      await ev(`(window.pobotsActivity.waitMs = 900, true)`);
      await ev(`click($(".pb-actday-prev"))`);
      await sleep(250);
      const mid = await ev(state);
      check(T("while yesterday is read: its name at once, today's rows still there, faded"), mid?.name === "Yesterday" && mid.rows === 10 && mid.reading && mid.fade < 1 && mid.fade > 0.3, mid);
      check(T("the head does not move while the day is read"), (await ev(headBoxes)) === box0, { before: box0, after: await ev(headBoxes) });
      await until(`$$(".pb-actday-row").length === 3 && !$(".pb-actday[data-reading]")`, 4000);
      await sleep(300);
      const y = await ev(state);
      check(T("yesterday: three rows, Next and Today offered, not faded"), y?.name === "Yesterday" && !y.nextOff && !y.todayHidden && y.fade === 1, y);
      check(T("the head does not move when the day changed"), (await ev(headBoxes)) === box0, { before: box0, after: await ev(headBoxes) });
      await ev(`(window.pobotsActivity.waitMs = 0, true)`);

      // A quiet day: one line.
      await ev(`click($(".pb-actday-prev"))`);
      const quiet = await until(`$(".pb-actday-empty") && !$(".pb-actday[data-reading]") ? ${state} : null`);
      const name2 = await ev(backName(2));
      check(T("two days back: its name and the quiet line, no summary"), quiet?.name === name2 && quiet.rows === 0 && quiet.empty === "Nothing happened in Pobots on this day." && quiet.summary === 0, { quiet, name2 });
      check(T("the head does not move on a quiet day"), (await ev(headBoxes)) === box0);
      await houseRules(T("a quiet day"));
      await shot(`activity-${theme}-${width}-quiet`);

      // Next, then Today.
      await ev(`click($(".pb-actday-next"))`);
      const back1 = await until(`$$(".pb-actday-row").length === 3 && !$(".pb-actday[data-reading]") ? ${state} : null`);
      check(T("Next day goes to yesterday"), back1?.name === "Yesterday", back1);
      await ev(`click($(".pb-actday-today"))`);
      const t2 = await until(`$$(".pb-actday-row").length === 10 && !$(".pb-actday[data-reading]") ? ${state} : null`);
      check(T("Today goes back to today; Today hides again, keeping its room"), t2?.name === "Today" && t2.todayHidden && (await ev(headBoxes)) === box0, t2);
      await ev(`click($(".pb-set7-refresh"))`);
      const again = await until(`!$(".pb-actday[data-reading]") && $$(".pb-actday-row").length === 10 ? ${state} : null`);
      check(T("Refresh reads the day again"), again?.name === "Today" && /^Read at/.test(again.status), again);
      if (phone) await leavePhone();
    }
  }
}
