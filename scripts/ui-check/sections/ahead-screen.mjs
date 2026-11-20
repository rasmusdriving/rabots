// Part C: stable visit, actions, the row above the days with Overview, the filter, the laptop's Week
// with a drag to a day and a time, and the phone's Agenda and Day (docs/build/step-ahead-redesign.md).
import { b, check, ev, houseRules, open, shot, until } from "../lib.mjs";

const q = JSON.stringify;
const row = (title, parent = ".app-ahead") => `$$('${parent} [data-ahead-row]').find((r) => r.querySelector(".pb-ahead-title")?.textContent === ${q(title)})`;
const pos = (expr) => `Math.round((${expr}).getBoundingClientRect().top)`;
const set = (selector, value, kind = "HTMLInputElement", event = "input") => `(() => {
  const el = $(${q(selector)});
  Object.getOwnPropertyDescriptor(${kind}.prototype, "value").set.call(el, ${q(value)});
  el.dispatchEvent(new Event(${q(event)}, { bubbles: true }));
  return true;
})()`;
const firstBot = '$(".pb-vacation-list .app-row")';

const show = async () => {
  await ev('click($("[data-ahead-roster]"))');
  return until('!!$(".app-ahead [data-ahead-day], .app-ahead [data-ahead-week], [data-ahead-empty]")');
};
const checkUntil = async (name, expr) => check(name, !!(await until(expr)));

export default async function section() {
  await open("ahead=on");
  await show();
  check("ahead-screen: no label filter on a plan without labels", await ev('!$("[data-ahead-label]")'));
  await open("ahead=1&todos=1");
  await show();

  // The one row above the days: a chip per bot with its counts; the words are in its name and in Overview.
  await checkUntil("ahead-screen: Carrying shows a bot with plan, due and waiting counts", '$$("[data-ahead-carry]").some((r) => { const a = r.getAttribute("aria-label") ?? ""; return a.includes("on Ahead") && a.includes("due this week") && a.includes("waiting on you") && /\\d/.test(r.textContent); })');
  check("ahead-screen: what stands above the days is one row of fixed height", await ev('Math.round($("[data-ahead-summary]").getBoundingClientRect().height) === 32 && !$(".pb-ahead-filters") && !$(".app-ahead select")'));
  const id = await ev('window.pobotsAhead.items().find((i) => i.title === "Send the sample summary").botId');
  const carrying = `$("[data-ahead-carry=" + ${q(id)} + "]")`;
  await ev(`click(${carrying})`);
  await checkUntil("ahead-screen: Carrying filters to the bot", `${carrying}.getAttribute("aria-pressed") === "true" && !!${row("Send the sample summary")} && !${row("Dentist")}`);
  await ev(`click(${carrying})`);
  await checkUntil("ahead-screen: clicking the selected Carrying line clears it", `!!${row("Dentist")}`);
  const dayTop = await ev(pos('$("[data-ahead-day]")'));
  await ev('click($("[data-ahead-overview-open]"))');
  await checkUntil("ahead-screen: Overview says each bot's counts in words and has the labels", '$$("[data-ahead-overview] [data-ahead-carry-line]").some((r) => r.textContent.includes("on Ahead") && r.textContent.includes("due this week") && r.textContent.includes("waiting on you")) && !!$("[data-ahead-overview] .pb-ahead-carry-head [data-ahead-label]")');
  check("ahead-screen: Overview floats, the days stay where they are", (await ev(pos('$("[data-ahead-day]")'))) === dayTop);
  await houseRules("ahead-screen Overview");
  await shot("ahead-screen-overview");
  await ev(`click($("[data-ahead-overview] [data-ahead-label='Sample project']"))`);
  const labelOn = `$("[data-ahead-summary] [data-ahead-label-on='Sample project']")`;
  await checkUntil("ahead-screen: a label picked in Overview shows matching items and stands in the row", `!$("[data-ahead-overview]") && !!${labelOn} && !!${row("Send the sample summary")} && !${row("Dentist")} && !${row("Quarter report due")}`);
  await ev(`click(${labelOn})`);
  await checkUntil("ahead-screen: tapping the label in the row clears it", `!${labelOn} && !!${row("Dentist")}`);

  const sample = row("Send the sample summary");
  const top = await ev(pos(sample));
  await ev(`click(${sample})`);
  await checkUntil("ahead-screen: the plain item sheet has the three choices, date picker, chat and shared question box",
    '!!$("[data-ahead-sheet]") && !!btn("Tomorrow") && !!btn("Monday") && !!btn("Next week") && !!$(".pb-ahead-day-input") && !!btn("Go to the bot\'s chat") && !!$(".pb-cq[data-place=ahead]")');
  check("ahead-screen: the sheet leaves the list in place", (await ev(pos(sample))) === top);
  await ev('click(btn("Close"))');

  await ev('click($("[data-ahead-add]"))');
  await ev(set("[data-ahead-add-form] input[type=text], [data-ahead-add-form] input:not([type])", "My sample reminder"));
  await ev('click(btn("Add to Ahead"))');
  const own = row("My sample reminder");
  await checkUntil("ahead-screen: Add puts a personal item in the plan immediately", `${own}?.textContent.includes("You") && !$(".pb-ahead-held") && !$(".pb-dialog")`);
  const youLine = '$("[data-ahead-carry=\'@you\']")';
  await checkUntil("ahead-screen: Carrying has a You chip for the person's own items", `${youLine}?.getAttribute("aria-label").includes("2 on Ahead") && ${youLine}.textContent.includes("You")`);
  await ev(`click(${youLine})`);
  await checkUntil("ahead-screen: the You line shows only the person's own items", `${youLine}.getAttribute("aria-pressed") === "true" && !!${own} && !!${row("Dentist")} && !${row("Send the sample summary")}`);
  await ev(`click(${youLine})`);
  await checkUntil("ahead-screen: tapping You again shows everyone", `!!${row("Send the sample summary")}`);
  await ev(`click(${own})`);
  await checkUntil("ahead-screen: a personal item has no chat or question box", '!!$("[data-ahead-sheet]") && !$(".pb-cq[data-place=ahead]") && !btn("Go to the bot\'s chat")');
  const ownTop = await ev(pos(own));
  await ev('click(btn("Done"))');
  await checkUntil("ahead-screen: Done keeps its row and folds the result at the bottom", `${own}?.dataset.tone === "closed" && ${pos(own)} === ${ownTop} && $("[data-ahead-done] button")?.getAttribute("aria-expanded") === "false"`);
  await ev('click($("[data-ahead-done] button"))');
  await ev(`click(${row("My sample reminder", "[data-ahead-done]")})`);
  await ev('click(btn("Open again"))');
  await checkUntil("ahead-screen: Open again restores the row", `${own} && !${own}.dataset.tone && !$(".pb-dialog")`);
  await ev(`click(${own})`);
  await ev('click(btn("Drop"))');
  await checkUntil("ahead-screen: Drop leaves a faded row with its new state", `${own}?.textContent.includes("Dropped") && ${pos(own)} === ${ownTop}`);

  // Leave an incoming item held, then look again. It remains marked until this visit also ends.
  const existing = await ev('window.pobotsAhead.items().find((i) => i.title === "Answer from the example team").id');
  const arrive = `window.pobotsAhead.add(${q(id)}, "An update from the example", 1, "note")`;
  const markTop = await ev(pos(sample));
  await ev(arrive);
  await ev(`window.pobotsAhead.move(${q(existing)}, 4)`);
  await checkUntil("ahead-screen: incoming changes stay behind Show", '$("[data-ahead-held]")?.textContent.includes("1 new, 1 change")');
  check("ahead-screen: incoming changes do not move a row", (await ev(pos(sample))) === markTop);
  await ev(`click(${firstBot})`);
  await until('!!window.pobotsAhead.state().lastOpenedAt && !$(".app-ahead")');
  await show();
  await checkUntil("ahead-screen: new and moved marks survive leaving without pressing Show", `$("[data-ahead-since]")?.textContent.includes("1 new, 1 moved") && $("[data-ahead-since]").title.includes("1 new, 1 moved since") && ${row("An update from the example")}?.textContent.includes("New") && ${row("Answer from the example team")}?.textContent.includes("Moved from")`);
  await shot("ahead-screen-agenda");
  await ev(`click(${firstBot})`);
  await show();
  await checkUntil("ahead-screen: after leaving the marked visit both marks clear", '$("[data-ahead-since]")?.textContent.includes("Nothing new") && !$(".app-ahead .pb-ahead-row .pb-ahead-change-dot")');

  await ev('click(btn("Week"))');
  await checkUntil("ahead-screen: Week has five working day columns on a laptop", '$$("[data-ahead-week-day]").length === 5 && btn("Week").getAttribute("aria-pressed") === "true"');
  await ev('window.pobotsAhead.workDays(["wed"])');
  await checkUntil("ahead-screen: Week reads sparse custom working days", '$$("[data-ahead-week-day]").every((d) => new Date(d.dataset.aheadWeekDay + "T12:00Z").getUTCDay() === 3)');
  await ev('window.pobotsAhead.workDays(["sun","mon","tue","wed","thu","fri","sat"])');
  await ev(`(() => {
    const at = new Date(); at.setDate(at.getDate() + 2); at.setHours(12, 0, 0, 0);
    window.pobotsMock.botSchedules(${q(id)}, "Sample once run", { type: "once", at: at.toISOString() });
    window.pobotsAhead.add(${q(id)}, "Sample time block", 2, "your-time", "14:00");
    return true;
  })()`);
  await until('$("[data-ahead-held]")?.textContent.includes("2 new")');
  await ev('click($("[data-ahead-held] button"))');
  // Only an open item and a "your time" slot can be dragged: a plain item anywhere, a slot to a time.
  const to = '$$("[data-ahead-week-day]").at(-1)';
  await checkUntil("ahead-screen: meetings, to-dos and runs in Week are never dragged, a your-time slot only to a time",
    `["meeting", "todo", "run"].every(source => {
      const cards = $$("[data-ahead-week] [data-ahead-row^=" + source + "]");
      return cards.length > 0 && cards.every((r) => !r.dataset.draggable);
    }) && ${row("Sample time block")}?.dataset.draggable === "timed" && ${sample}?.dataset.draggable === "any"`);
  const day = await ev(`${to}.dataset.aheadWeekDay`);
  const weekTop = await ev(pos(sample));
  // A pointer drag, as a person does it: press, travel, let go in the last day's column.
  const from = await ev(`(() => { const r = ${sample}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const goal = await ev(`(() => { const r = ${to}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.42 }; })()`);
  const mouse = (type, x, y, extra = {}) => b.cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
  await b.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + ((goal.x - from.x) * i) / 8, from.y + ((goal.y - from.y) * i) / 8, { buttons: 1 });
  const ghost = await until('$("[data-ahead-ghost]")?.textContent');
  check("ahead-screen: while dragging, an outline says the day and a time on the quarter", /^[A-Z][a-z]{2} \d{2}:(00|15|30|45)$/.test(ghost ?? ""), ghost);
  await mouse("mouseReleased", goal.x, goal.y, { clickCount: 1 });
  await checkUntil("ahead-screen: dropping calls Move with the day and time and keeps the old box",
    `(() => { const it = window.pobotsAhead.items().find((i) => i.title === "Send the sample summary"); const old = ${sample}; return it.day === ${q(day)} && it.time === ${q((ghost ?? "").slice(4))} && old?.closest(".pb-ahead-blk").dataset.state === "moved" && old.title.includes("Moved to") && ${pos(sample)} === ${weekTop} && ${to}.textContent.includes("Send the sample summary") && !$("[data-ahead-ghost]") && !$("[data-ahead-sheet]"); })()`);
  await houseRules("ahead-screen Week");
  await shot("ahead-screen-week");
  await ev(`click(${firstBot})`);
  await show();
  await checkUntil("ahead-screen: Week is remembered and shows the moved item at its new day", `${sample}?.closest("[data-ahead-week-day]")?.dataset.aheadWeekDay === ${q(day)}`);

  for (const [width, height, theme] of [[390, 844, "dark"], [360, 780, "light"]]) {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await ev('(() => { localStorage.removeItem("pobotsAheadWeek"); return true; })()');
    await open("ahead=1&todos=1", { width, height, theme });
    const onBots = await ev('$(".pb-shell")?.dataset.phoneScreen === "bots"');
    if (!onBots) {
      await ev('click($(".app-phone-back"))');
      await until('$(".pb-shell")?.dataset.phoneScreen === "bots"');
    }
    await show();
    await checkUntil(`ahead-screen: at ${width} the phone has Carrying, Add and the choice of Agenda or Day, and opens on Agenda`, '!!$("[data-ahead-carry]") && !!$("[data-ahead-add]") && !!btn("Day") && !btn("Week") && btn("Agenda").getAttribute("aria-pressed") === "true" && !$("[data-ahead-week]")');
    await ev('click(btn("Day"))');
    await checkUntil(`ahead-screen: at ${width} Day shows one day as a grid, with the working days to switch between and nothing to drag`, '!!$("[data-ahead-week][data-single]") && $$("[data-ahead-week-day]").length === 1 && $$("[data-ahead-day-switch] button").length === 5 && !$("[data-ahead-week] [data-draggable]")');
    const second = await ev('$$("[data-ahead-day-switch] button")[1].dataset.day');
    await ev('click($$("[data-ahead-day-switch] button")[1])');
    await checkUntil(`ahead-screen: at ${width} picking a day shows that day`, `$("[data-ahead-week-day]").dataset.aheadWeekDay === ${q(second)} && $$("[data-ahead-day-switch] button")[1].getAttribute("aria-pressed") === "true"`);
    await houseRules(`ahead-screen Day ${width}`);
    await shot(`ahead-screen-day-${width}`);
    await ev('click(btn("Agenda"))');
    await until('!!$(".app-ahead [data-ahead-day]")');
    await ev(`click(${sample})`);
    await checkUntil(`ahead-screen: item sheet fits the phone at ${width}`, '!!$("[data-ahead-sheet]") && $(".pb-dialog").getBoundingClientRect().right <= innerWidth && $(".pb-dialog").scrollWidth <= $(".pb-dialog").clientWidth + 1');
    await checkUntil(`ahead-screen: the item sheet is solid at ${width} in ${theme}`, '(() => { const d = $(".pb-dialog"), cs = getComputedStyle(d); const a = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor)?.[1].split(",").map(Number); return cs.opacity === "1" && !!a && (a.length < 4 || a[3] === 1); })()');
    await shot(`ahead-screen-sheet-${width}`);
  }
}
