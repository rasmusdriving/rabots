// The Week grid of Ahead (docs/build/step-ahead-redesign.md), against the stand-in engine's busy
// week (?ahead=busy): at 1330 x 860 the whole working day of five days shows with no scrolling, on
// the page or inside the grid; things at the same time stand side by side and never cover each
// other; the bots' things are told from meetings; what is outside the working hours, with no time
// or too many at once is one tap away; nothing shifts when a sheet opens, the view is switched,
// meetings are hidden, the clock moves or something arrives; a drag goes to a day and a time on the
// quarter, to a day with no time, and Escape lets go; a wide and a low window; the phone's Day.
import { b, check, ev, fixClock, houseRules, open, shot, until } from "../lib.mjs";

const q = JSON.stringify;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
const Q = "ahead=busy&todos=1";
const box = (title) => `$$("[data-ahead-week] [data-ahead-row]").find((r) => r.querySelector(".pb-ahead-title")?.textContent === ${q(title)})`;
const item = (title) => `window.pobotsAhead.items().find((i) => i.title === ${q(title)})`;
// Every block of the grid with its box, rounded: what must not move.
const chart = () => ev('JSON.stringify($$("[data-ahead-week] .pb-ahead-blk-box, [data-ahead-week] .pb-ahead-grid-more, .pb-ahead-head, [data-ahead-summary], [data-ahead-grid-body]").map((el) => { const r = el.getBoundingClientRect(); return [el.dataset.aheadRow ?? el.className.split(" ")[0], Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }))');
// Pairs of blocks in one day that cover each other by more than half a pixel.
const covering = `(() => {
  const bad = [];
  for (const col of $$("[data-ahead-week-day]")) {
    const c = col.getBoundingClientRect();
    const all = [...col.querySelectorAll(".pb-ahead-blk-box")].map((el) => [el.textContent.slice(0, 24), el.getBoundingClientRect()]);
    for (const [name, r] of all) if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) bad.push("outside: " + name);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const [a, b] = [all[i][1], all[j][1]];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) bad.push(all[i][0] + " / " + all[j][0]);
    }
  }
  for (const cell of $$("[data-ahead-strip-day], [data-ahead-band] .pb-ahead-grid-cell")) {
    const kids = [...cell.children].map((el) => el.getBoundingClientRect());
    for (let i = 1; i < kids.length; i++) if (kids[i].top < kids[i - 1].bottom - 0.5) bad.push("strip");
  }
  return bad;
})()`;
const fits = `(() => {
  const page = $(".app-ahead-scroll"), body = $("[data-ahead-grid-body]"), hours = $(".pb-ahead-grid-hours").getBoundingClientRect();
  const foot = $(".pb-ahead-grid-foot").getBoundingClientRect();
  return { page: page.scrollHeight - page.clientHeight, inner: body.scrollHeight - body.clientHeight, sideways: page.scrollWidth - page.clientWidth,
    hour: Math.round((hours.height / $$(".pb-ahead-grid-times span").length) * 10) / 10, first: $(".pb-ahead-grid-times span").textContent, last: $$(".pb-ahead-grid-times span").at(-1).textContent,
    shown: foot.bottom <= innerHeight && $$("[data-ahead-week-day]").every((c) => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; }) };
})()`;
const mouse = (type, x, y, extra = {}) => b.cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
const centre = (expr) => ev(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

/** Presses on `from` and travels to a point; the caller lets go (or presses Escape). */
async function dragTo(from, goal) {
  const at = await centre(from);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await mouse("mousePressed", at.x, at.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", at.x + ((goal.x - at.x) * i) / 8, at.y + ((goal.y - at.y) * i) / 8, { buttons: 1 });
}

async function device(width) {
  const phone = width < 700;
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 1 : 0 });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: width === 390 ? IPHONE : width === 360 ? ANDROID : "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" });
  return phone;
}

async function toWeek(phone = false) {
  await until('!!$(".pb-shell")');
  if (phone) {
    for (let i = 0; i < 4 && (await ev('$("[data-phone-screen]")?.dataset.phoneScreen')) !== "bots"; i++) {
      await ev('click($(".app-main .app-phone-back, .app-phone-back"))');
      await until('$("[data-phone-screen]")?.dataset.phoneScreen === "bots"', 1500);
    }
  }
  await until('!!$("[data-ahead-roster]")');
  await ev('click($("[data-ahead-roster]"))');
  await until(`!!btn(${q(phone ? "Day" : "Week")})`);
  await ev(`click(btn(${q(phone ? "Day" : "Week")}))`);
  return until('!!$("[data-ahead-week] .pb-ahead-blk-box")');
}

/** Something new and something changed wait at once: the longest the held line gets. Show is whole, and so are the words. */
async function heldBoth(where) {
  await ev('(() => { const a = window.pobotsAhead; a.add("inbox", "Order the sample badges", 1, "will-do"); a.move(a.items().find((i) => i.state === "open" && i.botId).id, 1); return true; })()');
  const held = await until(`$("[data-ahead-held]")?.textContent.includes("change") && (() => { const n = $(".pb-ahead-sum-news").getBoundingClientRect(), w = $(".pb-ahead-held-words"), show = $("[data-ahead-held] button").getBoundingClientRect(); return { text: $("[data-ahead-held]").textContent, show: show.left >= n.left && show.right <= n.right + 0.5 && show.width > 0, cut: w.scrollWidth - w.clientWidth }; })()`);
  check(`ahead-grid: "1 new, 1 change" and Show both fit their fixed place ${where}`, !!held && /new, 1 change/.test(held.text) && held.show && held.cut <= 0, held);
}

export default async function section() {
  await device(1330);
  await ev('(() => { localStorage.removeItem("pobotsAheadHideMeetings"); localStorage.removeItem("pobotsAheadWeek"); return true; })()');
  let unfix = await fixClock(10, 20);

  // The laptop he works on: 1330 x 860, the bots at the left and the rail at the right.
  let morning;
  for (const theme of ["light", "dark"]) {
    const where = `1330 ${theme}`;
    await open(Q, { width: 1330, height: 860, theme });
    check(`ahead-grid: Week opens as a grid of five days at ${where}`, !!(await toWeek()) && (await ev('$$("[data-ahead-week-day]").length === 5 && $$(".pb-ahead-grid-day").length === 5 && $(".pb-ahead-grid-day[data-today]")?.textContent.startsWith("Today")')));
    const f = await ev(fits);
    check(`ahead-grid: the whole working day of five days shows with no scrolling at ${where}`, f.page <= 0 && f.inner <= 0 && f.sideways <= 0 && f.shown && f.first === "08:00" && f.last === "16:00" && f.hour >= 48, f);
    const bad = await ev(covering);
    check(`ahead-grid: no thing covers another, and all stay inside their day, at ${where}`, bad.length === 0 && (await ev('$$("[data-ahead-week-day] .pb-ahead-blk-box").length > 60')), bad);
    check(
      `ahead-grid: a bot's thing is told from a meeting, a free meeting is hollow, what waits on you is amber, at ${where}`,
      await ev(`(() => {
        const bg = (tone) => getComputedStyle($("[data-ahead-week-day] .pb-ahead-blk[data-tone=" + tone + "] .pb-ahead-blk-box")).backgroundColor;
        const set = new Set([bg("meeting"), bg("bot"), bg("you")]);
        const meetings = $$("[data-ahead-week] .pb-ahead-blk:is([data-tone=meeting], [data-tone=free]) .pb-ahead-blk-box");
        const loud = $$("[data-ahead-week-day] .pb-ahead-blk:is([data-tone=bot], [data-tone=you])");
        return set.size === 3 && /, 0\\)$|transparent/.test(bg("free")) && meetings.every((m) => m.tagName !== "BUTTON" && !m.querySelector(".pb-avatar")) && loud.length > 8 && loud.every((l) => l.querySelector("button.pb-ahead-blk-box")) && loud.some((l) => l.querySelector(".pb-avatar"));
      })()`),
    );
    check(`ahead-grid: now is a line in today's column only at ${where}`, await ev('$$("[data-ahead-now]").length === 1 && !!$("[data-ahead-week-day] [data-ahead-now]") && $("[data-ahead-now]").parentElement.hasAttribute("data-today")'));
    await houseRules(`ahead-grid Week ${where}`);
    await shot(`ahead-grid-week-1330-${theme}`);
    morning = await chart();
  }

  // More than three at once fold into a count; it opens the day as a list with every one of them.
  const before = await chart();
  check("ahead-grid: from the fourth at one time they fold into one count", await ev('$("[data-ahead-folded]")?.textContent === "+3"'));
  await ev('click($("[data-ahead-folded]"))');
  check("ahead-grid: the count opens the day as a list with all of them", !!(await until('["Town hall", "Release review", "Hiring panel", "Vendor demo", "Sample walkthrough"].every((t) => $("[data-ahead-day-sheet]")?.textContent.includes(t))')));
  check("ahead-grid: the list scrolls inside its sheet, which stays on the screen", await ev('(() => { const d = $(".pb-dialog").getBoundingClientRect(); return d.top >= 0 && d.bottom <= innerHeight; })()'));
  check("ahead-grid: a sheet floats, nothing under it moves", (await chart()) === before);
  await houseRules("ahead-grid day list");
  await shot("ahead-grid-day-list");
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-day-sheet]")');

  // Outside the working hours: one line above and one below, each thing with its time.
  check("ahead-grid: before the working hours stands on its own line with its time", await ev('(() => { const c = $("[data-ahead-band=before]"); return c.textContent.includes("07:15") && c.textContent.includes("Breakfast with the board") && c.textContent.includes("06:30"); })()'));
  check("ahead-grid: after the working hours too, and two on one day are a count", await ev('(() => { const c = $("[data-ahead-band=after]"); return c.textContent.includes("18:00") && c.textContent.includes("Team dinner") && c.textContent.includes("2 later"); })()'));
  await ev('click($$("[data-ahead-band=after] .pb-ahead-grid-more")[0])');
  check("ahead-grid: the count opens that day with both", !!(await until('["Wrap-up", "Evening webinar"].every((t) => $("[data-ahead-day-sheet]")?.textContent.includes(t))')));
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-day-sheet]")');

  // No time: four fixed lines a day, the rest one tap away. From earlier: one chip on today.
  check("ahead-grid: the strip on top has the same height on every day", await ev('new Set($$("[data-ahead-strip-day]").map((c) => Math.round(c.getBoundingClientRect().height))).size === 1'));
  check("ahead-grid: nothing in the strip is cut off at its foot", await ev('$$("[data-ahead-strip-day]").every((c) => [...c.children].every((x) => x.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5))'));
  check("ahead-grid: a day with more than four says how many more", await ev('$$("[data-ahead-strip-more]").some((m) => m.textContent === "2 more")'));
  // A day with room gives a bot's thing two lines, so its title can be read whole.
  const tall = await ev(`(() => { const b = $$('[data-ahead-strip-day] .pb-ahead-blk[data-lines="2"]').find((x) => x.textContent.includes("Survey dates")); if (!b) return null; const t = b.querySelector(".pb-ahead-title"); const one = $('[data-ahead-strip-day] .pb-ahead-blk[data-line]:not([data-lines])').getBoundingClientRect().height; return { lines: Math.round(t.getBoundingClientRect().height / 16), height: b.getBoundingClientRect().height, one, tone: b.dataset.tone, meetings: $$('[data-ahead-strip-day] .pb-ahead-blk[data-lines="2"][data-tone="meeting"]').length }; })()`);
  check("ahead-grid: with room in the strip a bot's thing takes two lines, a meeting never", !!tall && tall.lines === 2 && Math.abs(tall.height - (tall.one * 2 + 2)) < 0.6 && tall.meetings === 0, tall);
  // Words: a title is never broken inside a word, a time shows whole or not at all, and a free meeting says so.
  const words = await ev(`(() => { const blocks = $$("[data-ahead-week-day] .pb-ahead-blk").filter((b) => b.querySelector(".pb-ahead-title")); const shown = (el) => !!el && getComputedStyle(el).display !== "none";
    const wrapping = blocks.map((b) => getComputedStyle(b.querySelector(".pb-ahead-title"))).filter((c) => c.whiteSpace === "normal");
    return { wrapping: wrapping.length, hyphens: [...new Set(wrapping.map((c) => c.hyphens))].join(","), wraps: [...new Set(wrapping.map((c) => c.overflowWrap))].join(","),
      cutTimes: blocks.filter((b) => { const m = b.querySelector(".pb-ahead-blk-more"); return shown(m) && m.scrollWidth > m.clientWidth + 0.5; }).length, times: blocks.filter((b) => shown(b.querySelector(".pb-ahead-blk-more"))).length,
      narrowWithTime: blocks.filter((b) => b.getBoundingClientRect().width < 100 && shown(b.querySelector(".pb-ahead-blk-more"))).length,
      free: blocks.filter((b) => b.dataset.tone === "free" && shown(b.querySelector(".pb-ahead-blk-more"))).map((b) => b.querySelector(".pb-ahead-blk-more").textContent)[0], freeHint: $('[data-ahead-week-day] .pb-ahead-blk[data-tone="free"] [data-ahead-row]').title }; })()`);
  check("ahead-grid: a title wraps at words only, never inside one", words.wrapping > 0 && words.hyphens === "manual" && words.wraps === "normal", words);
  check("ahead-grid: a block shows its time whole or not at all", words.times > 0 && words.cutTimes === 0 && words.narrowWithTime === 0, words);
  check("ahead-grid: a meeting marked free says Free where it has the room, and in its hint", /Free$/.test(words.free ?? "") && words.freeHint.includes("Marked free"), words);
  await ev('click($$("[data-ahead-strip-more]").find((m) => m.textContent === "2 more"))');
  check("ahead-grid: that opens the day with every one of them", !!(await until('["Answer from the example team", "Book the venue", "Update the price list", "Signature from the legal team", "Offer to the example customer"].every((t) => $("[data-ahead-day-sheet]")?.textContent.includes(t))')));
  // A row of the list opens its sheet over the list; the list is still there afterwards.
  await ev(`click($$("[data-ahead-day-sheet] [data-ahead-row]").find((r) => r.textContent.includes("Update the price list")))`);
  check("ahead-grid: a row of the list opens its sheet", !!(await until('!!$("[data-ahead-sheet]")')));
  await ev('click([...$("[data-ahead-sheet]").closest(".pb-dialog").querySelectorAll("button")].find((x) => x.textContent === "Close"))');
  check("ahead-grid: the list is still there after the sheet closes", !!(await until('!$("[data-ahead-sheet]") && !!$("[data-ahead-day-sheet]")')));
  await ev('click([...$("[data-ahead-day-sheet]").querySelectorAll("button")].find((x) => x.textContent === "Close"))');
  await until('!$("[data-ahead-day-sheet]")');
  check("ahead-grid: From earlier is one chip on today", await ev('$("[data-ahead-strip-day][data-today] [data-ahead-earlier]")?.textContent === "From earlier · 1"'));
  await ev('click($("[data-ahead-earlier]"))');
  check("ahead-grid: it opens what is from earlier", !!(await until('$("[data-ahead-day-sheet]")?.textContent.includes("Call back about the report")')));
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-day-sheet]")');

  // A block opens its sheet; nothing under it moves.
  await ev(`click(${box("Plan next week")})`);
  check("ahead-grid: a your-time block opens its own sheet", !!(await until('!!$("[data-ahead-time-sheet]")')));
  check("ahead-grid: the sheet floats, nothing in the grid moves", (await chart()) === before);
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-time-sheet]")');

  // Agenda and back, several times: the head and the row above stay, the grid comes back as it was.
  const fixed = () => ev('JSON.stringify([".pb-ahead-head", "[data-ahead-summary]", "[data-ahead-view-choice]", "[data-ahead-add]"].map((s) => { const r = $(s).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }))');
  const headWeek = await fixed();
  let steady = true;
  for (let i = 0; i < 3; i++) {
    await ev('click(btn("Agenda"))');
    await until('!!$(".app-ahead [data-ahead-day]")');
    steady &&= (await fixed()) === headWeek;
    await ev('click(btn("Week"))');
    await until('!!$("[data-ahead-week] .pb-ahead-blk-box")');
    steady &&= (await fixed()) === headWeek && (await chart()) === before;
  }
  check("ahead-grid: switching between Agenda and Week moves neither the head nor the row above, and the grid comes back as it was", steady);

  // Something arrives while he looks: it waits in the fixed place at the right of the row; nothing moves.
  await ev('window.pobotsAhead.add("inbox", "Book the sample review", 1, "will-do", "12:15")');
  const held = await until('$("[data-ahead-summary] .pb-ahead-sum-news [data-ahead-held]")?.textContent.includes("1 new")');
  check("ahead-grid: what arrives waits behind Show at the right end of the row", !!held && (await ev('(() => { const h = $("[data-ahead-held]").getBoundingClientRect(), s = $("[data-ahead-summary]").getBoundingClientRect(); return h.top >= s.top && h.bottom <= s.bottom && h.right <= s.right + 1 && getComputedStyle($("[data-ahead-held]")).position === "static"; })()')));
  check("ahead-grid: nothing moved while it waits", (await chart()) === before);
  await ev('click($("[data-ahead-held] button"))');
  check("ahead-grid: Show brings it into the grid at its time", !!(await until(`!!${box("Book the sample review")}?.closest("[data-ahead-week-day]") && !$("[data-ahead-held]")`)));
  check("ahead-grid: still nothing covers another", (await ev(covering)).length === 0);

  // Hide meetings: the hours keep their place and height, the bots' things their time.
  const tops = () => ev('JSON.stringify([$("[data-ahead-grid-body]").getBoundingClientRect().height, ...$$("[data-ahead-week-day] .pb-ahead-blk:is([data-tone=bot], [data-tone=you]) .pb-ahead-blk-box").map((el) => [el.dataset.aheadRow, Math.round(el.getBoundingClientRect().y), Math.round(el.getBoundingClientRect().height)])])');
  const loudBefore = await tops();
  await ev('click($("[data-ahead-hide-meetings]"))');
  check("ahead-grid: Hide meetings takes every meeting out of the grid", !!(await until('!$("[data-ahead-week] [data-ahead-row^=meeting]") && $$("[data-ahead-week-day] .pb-ahead-blk-box").length > 8')));
  check("ahead-grid: the hours and the bots' things stay where they were", (await tops()) === loudBefore && (await ev('!!$("[data-ahead-band=before]") && !!$("[data-ahead-band=after]")')));
  await shot("ahead-grid-no-meetings");
  await ev('click($("[data-ahead-hide-meetings]"))');
  await until('!!$("[data-ahead-week] [data-ahead-row^=meeting]")');

  // Dragging. A your-time slot to another day and time: an outline says where, on the quarter.
  const slot = box("Plan next week");
  const slotAt = await ev(`JSON.stringify(${slot}.getBoundingClientRect())`);
  const third = '$$("[data-ahead-week-day]")[2]';
  const goal = await ev(`(() => { const r = ${third}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.61, day: ${third}.dataset.aheadWeekDay }; })()`);
  await dragTo(slot, goal);
  const ghost = await until('$("[data-ahead-ghost]")?.textContent');
  check("ahead-grid: while dragging, an outline in the day says the day and a time on the quarter", /^[A-Z][a-z]{2} \d{2}:(00|15|30|45)$/.test(ghost ?? "") && (await ev(`!!${third}.querySelector("[data-ahead-ghost]") && !!$("[data-ahead-week][data-ahead-dragging]") && ${slot}.closest(".pb-ahead-blk").hasAttribute("data-drag-source")`)), ghost);
  check("ahead-grid: the block does not move while it is dragged", (await ev(`JSON.stringify(${slot}.getBoundingClientRect())`)) === slotAt);
  await mouse("mouseReleased", goal.x, goal.y, { clickCount: 1 });
  check(
    "ahead-grid: letting go moves it to that day and time, the old box stays and says where it went",
    !!(await until(`(() => { const it = ${item("Plan next week")}; const all = $$("[data-ahead-week] [data-ahead-row]").filter((r) => r.querySelector(".pb-ahead-title")?.textContent === "Plan next week"); return it.day === ${q(goal.day)} && it.time === ${q((ghost ?? "").slice(4))} && all.length === 2 && all.some((r) => r.closest(".pb-ahead-blk").dataset.state === "moved" && r.title.includes("Moved to") && JSON.stringify(r.getBoundingClientRect()) === ${q(slotAt)}) && all.some((r) => r.closest("[data-ahead-week-day]")?.dataset.aheadWeekDay === ${q(goal.day)} && !r.closest(".pb-ahead-blk").dataset.state) && !$("[data-ahead-ghost]") && !$(".pb-dialog"); })()`)),
  );
  check("ahead-grid: after a drop nothing covers another", (await ev(covering)).length === 0);

  // A plain item with no time, from the strip to a time; and a timed one back to a day with no time.
  const fourth = '$$("[data-ahead-week-day]")[3]';
  const goal2 = await ev(`(() => { const r = ${fourth}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.5, day: ${fourth}.dataset.aheadWeekDay }; })()`);
  await dragTo(box("Call the dentist"), goal2);
  const ghost2 = await until('$("[data-ahead-ghost]")?.textContent');
  await mouse("mouseReleased", goal2.x, goal2.y, { clickCount: 1 });
  check("ahead-grid: an item with no time dragged into a day gets that day and a time", !!(await until(`(() => { const it = ${item("Call the dentist")}; return it.day === ${q(goal2.day)} && it.time === ${q((ghost2 ?? "").slice(4))} && /:(00|15|30|45)$/.test(it.time); })()`)), ghost2);
  const strip = '$$("[data-ahead-strip-day]")[4]';
  const goal3 = await ev(`(() => { const r = ${strip}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height - 6, day: ${strip}.dataset.aheadStripDay }; })()`);
  await dragTo(box("Publish the weekly digest"), goal3);
  check("ahead-grid: over the strip on top the day lights up, with no outline in the hours", !!(await until(`${strip}.hasAttribute("data-drop-target") && !$("[data-ahead-ghost]")`)));
  await mouse("mouseReleased", goal3.x, goal3.y, { clickCount: 1 });
  check("ahead-grid: dropped on the strip it gets the day with no time", !!(await until(`(() => { const it = ${item("Publish the weekly digest")}; return it.day === ${q(goal3.day)} && !it.time; })()`)));

  // Escape lets go; a press with no travel is a click and opens the sheet; a meeting cannot be dragged.
  const send = box("Send the week's report");
  const was = await ev(`JSON.stringify([${item("Send the week's report")}.day, ${item("Send the week's report")}.time])`);
  await dragTo(send, goal2);
  await until('!!$("[data-ahead-ghost]")');
  await b.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("ahead-grid: Escape takes the outline away", !!(await until('!$("[data-ahead-ghost]") && !$("[data-ahead-week][data-ahead-dragging]")')));
  await mouse("mouseReleased", goal2.x, goal2.y, { clickCount: 1 });
  check("ahead-grid: and nothing was moved", (await ev(`JSON.stringify([${item("Send the week's report")}.day, ${item("Send the week's report")}.time])`)) === was && (await ev('!$(".pb-dialog")')));
  // The drag was let go somewhere else, so no click followed it: the next plain click still opens.
  const left = await ev(`(() => { const all = $$('[data-ahead-week] .pb-ahead-blk[data-state]').map((x) => x.dataset.state + ":" + x.textContent.slice(0, 30) + ":" + !!x.querySelector("button")); const el = $('[data-ahead-week] .pb-ahead-blk[data-state="moved"] button'); if (el) el.click(); return all; })()`);
  check("ahead-grid: the click after a drag that was let go elsewhere opens as any click", !!(await until('!!$("[data-ahead-sheet]")')), left);
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-sheet]")');
  const at = await centre(send);
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await mouse("mousePressed", at.x, at.y, { clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", at.x, at.y, { clickCount: 1 });
  check("ahead-grid: a press with no travel is a click and opens the sheet", !!(await until('!!$("[data-ahead-sheet]")')));
  await ev('click(btn("Close"))');
  await until('!$("[data-ahead-sheet]")');
  const meeting = '$$("[data-ahead-week-day] [data-ahead-row^=meeting]").find((r) => r.textContent.includes("Roadmap workshop"))';
  await dragTo(meeting, goal2);
  check("ahead-grid: a meeting cannot be dragged", await ev('!$("[data-ahead-ghost]") && !$("[data-ahead-week][data-ahead-dragging]")'));
  await mouse("mouseReleased", goal2.x, goal2.y, { clickCount: 1 });
  check("ahead-grid: and a press that travels over meetings selects no text", await ev('String(getSelection()) === "" && getComputedStyle($("[data-ahead-week]")).userSelect === "none"'));
  await houseRules("ahead-grid after drags");
  await shot("ahead-grid-after-drags");

  // The clock moves: only the now line does.
  await unfix();
  unfix = await fixClock(14, 40);
  await open(Q, { width: 1330, height: 860, theme: "dark" });
  await toWeek();
  const nowAt = await ev('Math.round($("[data-ahead-now]").getBoundingClientRect().y)');
  const hoursAt = await ev('(() => { const r = $(".pb-ahead-grid-hours").getBoundingClientRect(); return [r.y, r.height]; })()');
  check("ahead-grid: the now line stands at the time of day", Math.abs(nowAt - (hoursAt[0] + (hoursAt[1] * (14 * 60 + 40 - 480)) / 540)) <= 2, { nowAt, hoursAt });
  check("ahead-grid: when the clock moves only the now line does", (await chart()) === morning);
  await unfix();
  unfix = await fixClock(19, 5);
  await open(Q, { width: 1330, height: 860, theme: "dark" });
  await toWeek();
  check("ahead-grid: after the working hours there is no now line, and nothing else changed", (await ev('!$("[data-ahead-now]")')) && (await chart()) === morning);
  await unfix();
  unfix = await fixClock(10, 20);

  // A large screen: the hours take the room, the day names are written out.
  await open(Q, { width: 1920, height: 1080, theme: "dark" });
  await toWeek();
  const wide = await ev(fits);
  check("ahead-grid: at 1920 x 1080 the hours fill the room with no scrolling", wide.page <= 0 && wide.inner <= 0 && wide.shown && wide.hour > 70, wide);
  check("ahead-grid: on a wide grid the days' names are written out", await ev('$$(".pb-ahead-grid-day")[1].innerText.trim().split(/\\s+/)[0].length > 3'));
  check("ahead-grid: nothing covers another at 1920", (await ev(covering)).length === 0);
  await houseRules("ahead-grid Week 1920");
  await shot("ahead-grid-week-1920");

  // A low window: an hour is never squeezed under 48px; the hours scroll inside themselves instead.
  await open(Q, { width: 1330, height: 600, theme: "light" });
  await toWeek();
  const low = await ev(fits);
  check("ahead-grid: in a low window an hour keeps 48px and the hours scroll inside the grid", low.hour >= 48 && low.inner > 0 && low.sideways <= 0, low);
  await houseRules("ahead-grid Week low window");

  // Other working hours and days from Settings: the grid shows exactly those.
  await open(Q, { width: 1330, height: 860, theme: "light" });
  await toWeek();
  await ev('window.pobotsAhead.workDays(["mon", "wed"])');
  check("ahead-grid: the days follow the working days of Settings", !!(await until('$$("[data-ahead-week-day]").length === 5 && $$("[data-ahead-week-day]").every((d) => [1, 3].includes(new Date(d.dataset.aheadWeekDay + "T12:00Z").getUTCDay()))')));

  // The row above the days: what empties while he looks keeps its box, so nothing beside it moves.
  await ev('click(btn("Agenda"))');
  await until('!!$(".pb-ahead-day [data-ahead-row]")');
  const place = '(() => { const left = (sel) => { const e = $(sel); return e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : null; }; return JSON.stringify([left(".pb-ahead-sum-note"), left(".pb-ahead-sum-news"), $$(".pb-ahead-sum-chip").length]); })()';
  const stood = await ev(place);
  const mine = await ev('$(\'[data-ahead-carry="@you"] .pb-ahead-sum-n\')?.textContent');
  for (const title of ["Call the dentist", "Book the venue"]) {
    await ev(`click($$(".pb-ahead-day [data-ahead-row]").find((r) => r.textContent.includes(${q(title)}) && !r.closest("[data-state]")))`);
    await until('!!$("[data-ahead-sheet]")');
    await ev('click(btn("Done", $(".pb-dialog")))');
    await until('!$("[data-ahead-sheet]") || !btn("Done", $(".pb-dialog"))');
    if (await ev('!!$("[data-ahead-sheet]")')) await ev('click(btn("Close", $(".pb-dialog")))');
    await until('!$("[data-ahead-sheet]")');
  }
  check("ahead-grid: the person's own chip that empties keeps its box, and nothing beside it moves", mine === "2" && !!(await until('!$(\'[data-ahead-carry="@you"]\') && !!$(".pb-ahead-sum-chip[data-empty]")')) && (await ev(place)) === stood, { mine, stood, now: await ev(place) });
  await ev('click(btn("Week"))');
  await until('!!$("[data-ahead-week] .pb-ahead-blk-box")');
  await heldBoth("at 1330");

  // The phone: Day, one day at a time, the page scrolls, nothing to drag, a tap opens the sheet.
  for (const [width, height, theme] of [[390, 844, "dark"], [360, 780, "light"]]) {
    const where = `${width} ${theme}`;
    await device(width);
    await ev('(() => { localStorage.removeItem("pobotsAheadWeek"); return true; })()');
    await open(Q, { width, height, theme });
    check(`ahead-grid: the phone's Day opens at ${where}`, !!(await toWeek(true)) && (await ev('!!$("[data-ahead-week][data-single]") && $$("[data-ahead-week-day]").length === 1 && $$("[data-ahead-day-switch] button").length === 5 && !btn("Week")')));
    const p = await ev('(() => { const page = $(".app-ahead-scroll"), body = $("[data-ahead-grid-body]"), hours = $(".pb-ahead-grid-hours").getBoundingClientRect(); return { page: page.scrollHeight - page.clientHeight, inner: body.scrollHeight - body.clientHeight, sideways: page.scrollWidth - page.clientWidth, hour: hours.height / $$(".pb-ahead-grid-times span").length, right: Math.max(...$$("[data-ahead-week] *").map((el) => el.getBoundingClientRect().right)) - innerWidth }; })()');
    check(`ahead-grid: on the phone the day is as tall as it needs and the page scrolls, never sideways, at ${where}`, p.page > 0 && p.inner <= 0 && p.sideways <= 0 && p.hour >= 72 && p.right <= 0.5, p);
    check(`ahead-grid: nothing covers another on the phone at ${where}`, (await ev(covering)).length === 0);
    check(`ahead-grid: nothing can be dragged on the phone at ${where}`, await ev('!$("[data-ahead-week] [data-draggable]")'));
    const day2 = await ev('$$("[data-ahead-day-switch] button")[2].dataset.day');
    const switchAt = await ev('JSON.stringify($("[data-ahead-day-switch]").getBoundingClientRect())');
    await ev('click($$("[data-ahead-day-switch] button")[2])');
    check(`ahead-grid: a tap on a day shows that day, the strip of days stays where it is, at ${where}`, !!(await until(`$("[data-ahead-week-day]").dataset.aheadWeekDay === ${q(day2)} && !!${box("Publish the weekly digest")}`)) && (await ev('JSON.stringify($("[data-ahead-day-switch]").getBoundingClientRect())')) === switchAt);
    check(`ahead-grid: more than three at once fold on the phone too at ${where}`, await ev('$("[data-ahead-folded]")?.textContent === "+3"'));
    await houseRules(`ahead-grid Day ${where}`);
    await shot(`ahead-grid-day-${width}-${theme}`);
    await ev(`click(${box("Publish the weekly digest")})`);
    check(`ahead-grid: a tap on a block opens its sheet, which fits the phone, at ${where}`, !!(await until('!!$("[data-ahead-sheet]") && $(".pb-dialog").getBoundingClientRect().right <= innerWidth && $(".pb-dialog").scrollWidth <= $(".pb-dialog").clientWidth + 1')));
    await ev('click(btn("Close"))');
    await until('!$("[data-ahead-sheet]")');
    // The row above the days on a phone: the chips, then the note and what is new; Overview fits.
    await ev('click($("[data-ahead-overview-open]"))');
    check(`ahead-grid: Overview fits the phone at ${where}`, !!(await until('!!$("[data-ahead-overview]") && $(".pb-dialog").getBoundingClientRect().right <= innerWidth && $(".pb-dialog").scrollWidth <= $(".pb-dialog").clientWidth + 1 && $("[data-ahead-overview] [data-ahead-week-note]").textContent.includes("A full week")')));
    await houseRules(`ahead-grid Overview ${where}`);
    await ev('click(btn("Close"))');
    await until('!$("[data-ahead-overview]")');
    await heldBoth(`at ${where}`);
  }
  await unfix();
  await device(1280);
  await ev('(() => { localStorage.removeItem("pobotsAheadWeek"); localStorage.removeItem("pobotsAheadHideMeetings"); return true; })()');
}
