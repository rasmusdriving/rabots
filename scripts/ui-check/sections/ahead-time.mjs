// Ahead, part B (protocol 31, docs/build/step-ahead.md), against the stand-in engine (?ahead=time):
// the week note at the top, a "your time" row (time and end, the amber tag, the length, Late), "Now"
// while it runs with nothing moving, its own sheet (Ask about this, Done, Drop, Later today,
// Tomorrow, Next free slot, Not this week, Pick a time), a place choice that keeps the row's box,
// Settings, Ahead, Your time (hours, days, minutes a day), the two notification switches shown only
// while Ahead is on and off by default, and the bot's "time" level hint. Laptop and both phone
// sizes, light and dark.
import { b, check, ev, houseRules, open, shot, until } from "../lib.mjs";

const q = JSON.stringify;
const yt = '$$(".app-ahead [data-ahead-your-time]")';
const rowOf = (title) => `${yt}.find((r) => r.querySelector(".pb-ahead-title")?.textContent === ${q(title)})`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
const FIRST = "Look at the draft plan";
const SECOND = "Check the numbers in the sample report";

async function device(width) {
  const phone = width < 700;
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 1 : 0 });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: width === 390 ? IPHONE : width === 360 ? ANDROID : "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" });
  return phone;
}

async function toBots() {
  for (let i = 0; i < 4 && (await ev('$("[data-phone-screen]")?.dataset.phoneScreen')) !== "bots"; i++) {
    await ev('click($(".app-main .app-phone-back, .app-phone-back"))');
    await until('$("[data-phone-screen]")?.dataset.phoneScreen === "bots"', 1500);
  }
}

async function toAhead(phone) {
  await until('!!$(".pb-shell")');
  if (phone) await toBots();
  await until('!!$("[data-ahead-roster]")');
  await ev('click($("[data-ahead-roster]"))');
  return until('$(".app-main")?.getAttribute("aria-label") === "Ahead" && !!$("[data-ahead-day]")');
}

export default async function section() {
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    const phone = await device(width);
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      await open("ahead=time", { width, height, theme });
      check(`ahead-time: the page opens at ${where}`, !!(await toAhead(phone)));

      // The week note, at the top, above the days.
      check(
        `ahead-time: the week note stands at the top, from the main bot, at ${where}`,
        await ev('(() => { const n = $("[data-ahead-week-note]"); const d = $("[data-ahead-day]"); return !!n && !!d && n.getBoundingClientRect().bottom <= d.getBoundingClientRect().top && n.textContent.includes("A calm week") && /^From /.test(n.querySelector(".pb-ahead-week-note-from").textContent); })()'),
      );

      // The rows: time and end, the amber tag, the length, Late.
      const first = await ev(`(() => { const r = ${rowOf(FIRST)}; if (!r) return null; return { tag: r.querySelector(".pb-ahead-tag")?.textContent, amber: r.querySelector(".pb-ahead-tag")?.dataset.for, meta: r.querySelector(".pb-ahead-meta").textContent, when: r.querySelector(".pb-ahead-when").textContent }; })()`);
      check(`ahead-time: a your-time row shows time and end, Your time in amber, the length and the bot at ${where}`, first?.tag === "Your time" && first.amber === "you" && /30 min · \S/.test(first.meta) && /^\d{2}:\d{2}\d{2}:\d{2}$/.test(first.when), first);
      check(`ahead-time: one placed after its latest day says Late at ${where}`, await ev(`${rowOf(SECOND)}?.querySelector(".pb-ahead-meta").textContent.includes("Late")`));
      check(`ahead-time: not running yet, so no Now at ${where}`, await ev(`!${rowOf(FIRST)}.hasAttribute("data-now")`));
      await houseRules(`ahead-time page ${where}`);
      await shot(`ahead-time-page-${width}-${theme}`);

      // Now: the slot starts; the change waits behind the held line like any other, then the row says Now.
      const id = await ev(`window.pobotsAhead.items().find((i) => i.title === ${q(FIRST)}).id`);
      await ev(`window.pobotsAheadTime.running(${q(id)})`);
      await until('!!$("[data-ahead-held]")', 3000);
      if (await ev('!!$("[data-ahead-held] button")')) await ev('click($("[data-ahead-held] button"))');
      const now = await until(`${rowOf(FIRST)}?.dataset.now === "true" && ${rowOf(FIRST)}.querySelector(".pb-ahead-end")?.textContent === "Now"`);
      check(`ahead-time: while it runs the row says Now, softly at ${where}`, !!now);
      const h = await ev(`Math.round(${rowOf(SECOND)}?.getBoundingClientRect().height ?? 0)`);
      await shot(`ahead-time-now-${width}-${theme}`);

      // The sheet: its own, with every choice.
      const at = await ev(`Math.round(${rowOf(SECOND)}.getBoundingClientRect().y)`);
      await ev(`click(${rowOf(SECOND)}.querySelector("button"))`);
      const sheet = await until('!!$("[data-ahead-time-sheet]")');
      const acts = await ev('$$("[data-ahead-time-sheet] button").map((x) => x.textContent)');
      const want = ["Ask about this", "Done", "Drop", "Later today", "Tomorrow", "Next free slot", "Not this week", "Move", "Close"];
      check(`ahead-time: the sheet has Ask about this, Done, Drop, the place choices and Pick a time at ${where}`, !!sheet && want.every((w) => acts?.includes(w)) && (await ev('!!$("[data-ahead-time-sheet] .pb-ahead-day-input") && !!$("[data-ahead-time-sheet] .pb-time-input")')), acts);
      check(`ahead-time: the sheet says Late, the length and the bot's next turn at ${where}`, await ev('(() => { const t = $("[data-ahead-time-sheet]").textContent; return t.includes("Late") && t.includes("20 min") && t.includes("is told at its next turn"); })()'));
      await houseRules(`ahead-time sheet ${where}`);
      await shot(`ahead-time-sheet-${width}-${theme}`);
      await ev('click($("[data-ahead-place=next-week]"))');
      const kept = await until(`!$("[data-ahead-time-sheet]") && ${rowOf(SECOND)}?.querySelector(".pb-ahead-row")?.dataset.tone === "moved"`);
      check(`ahead-time: Not this week keeps the row's box and says where it went at ${where}`, !!kept && (await ev(`Math.round(${rowOf(SECOND)}.getBoundingClientRect().y)`)) === at && (await ev(`${rowOf(SECOND)}.textContent.includes("Moved to ")`)));
      check(`ahead-time: the row's height did not change at ${where}`, (await ev(`Math.round(${rowOf(SECOND)}.getBoundingClientRect().height)`)) === h);
      const moved = await ev(`window.pobotsAhead.items().find((i) => i.title === ${q(SECOND)})`);
      const monday = await ev('(() => { const d = new Date(); d.setDate(d.getDate() + 7 - ((d.getDay() + 6) % 7)); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()');
      check(`ahead-time: the engine placed it in next week at ${where}`, moved?.day >= monday && /^\d{2}:\d{2}$/.test(moved?.time ?? ""), moved);
      // Tomorrow on the first.
      await ev(`click(${rowOf(FIRST)}.querySelector("button"))`);
      await until('!!$("[data-ahead-place=tomorrow]")');
      await ev('click($("[data-ahead-place=tomorrow]"))');
      const t1 = await until(`!$("[data-ahead-time-sheet]") && ${rowOf(FIRST)}?.textContent.includes("Moved to ")`);
      check(`ahead-time: Tomorrow moves it to the next free slot from tomorrow at ${where}`, !!t1 && (await ev(`(() => { const d = new Date(); const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); return window.pobotsAhead.items().find((i) => i.title === ${q(FIRST)}).day > today; })()`)));
      // The box a running slot leaves behind when moved no longer says Now (found in the browser test).
      check(`ahead-time: the box a running slot was moved from no longer says Now at ${where}`, await ev(`!${rowOf(FIRST)}.hasAttribute("data-now") && ${rowOf(FIRST)}.querySelector(".pb-ahead-end")?.textContent !== "Now"`));
      // The week note goes when the main bot clears it.
      await ev('window.pobotsAheadTime.weekNote("")');
      check(`ahead-time: a cleared week note goes at ${where}`, !!(await until('!$("[data-ahead-week-note]")')));
    }
  }

  // Settings, Ahead, Your time; and the notification switches only while Ahead is on.
  await device(1280);
  await open("ahead=time");
  await until('!!$(".app-side .app-row")');
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="ahead"]\'))');
  const set = await until('!!$("[data-ahead-time-settings]")');
  check("ahead-time: Settings, Ahead has Your time with hours, days and minutes a day", !!set && (await ev('$("#set-ahead-start").value === "08:00" && $$("[data-ahead-time-settings] .pb-day[aria-pressed=true]").length === 5 && $("#set-ahead-minutes").value === "120"')));
  await houseRules("ahead-time settings 1280");
  await shot("ahead-time-settings-1280");
  await ev('(() => { const el = $("#set-ahead-minutes"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "90"); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
  check("ahead-time: minutes a day saves at once", !!(await until("window.pobotsAhead.state().minutesPerDay === 90")));
  await ev('click($$("[data-ahead-time-settings] .pb-day").find((x) => x.getAttribute("aria-label") === "Saturday"))');
  check("ahead-time: a working day saves at once", !!(await until('window.pobotsAhead.state().workDays.includes("sat")')));
  await ev('(() => { const el = $("#set-ahead-start"); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "9"); el.dispatchEvent(new Event("input", { bubbles: true })); el.blur(); return true; })()');
  check("ahead-time: a typed start is tidied and saved", !!(await until('window.pobotsAhead.state().workStart === "09:00" && $("#set-ahead-start").value === "09:00"')));

  await open("ahead=time");
  await until('!!$(".pb-shell")');
  await ev('click($$(".pb-foot-settings").find((x) => x.checkVisibility({ visibilityProperty: true })))');
  await until('!!$(".pb-notify")');
  const kinds = await ev('$$(".pb-notify-kind input").map((i) => i.dataset.kind + ":" + i.checked)');
  check("ahead-time: with Ahead on, the two switches show, both off", kinds?.join(",") === "needs:true,note:true,finished:false,yourTime:false,dayReady:false", kinds);
  await ev(`click($('.pb-notify-kind input[data-kind="yourTime"]'))`);
  check("ahead-time: Your time on Ahead switches on and saves", !!(await until("window.pobotsMock.notifyState().kinds.yourTime === true")));
  await open("");
  await until('!!$(".pb-shell")');
  await ev('click($$(".pb-foot-settings").find((x) => x.checkVisibility({ visibilityProperty: true })))');
  await until('!!$(".pb-notify")');
  check("ahead-time: with Ahead off, the two switches are not there", await ev('$$(".pb-notify-kind input").length === 3 && !$(\'.pb-notify-kind input[data-kind="dayReady"]\')'));

  // The bot's level: "time" is no longer "later".
  await open("ahead=time");
  await until('!!$(".app-side .app-row")');
  await ev('click($$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === "Onboardings"))');
  await until('$(".app-main")?.getAttribute("aria-label") === "Onboardings"');
  await ev('click($(\'.pb-tab[data-tab="settings"]\'))');
  const hint = await until('$("[data-ahead-setting]")?.textContent.includes("free slot in your working hours")');
  check("ahead-time: the bot's Items and your time level says Pobots puts it in a free slot", !!hint);
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
}
