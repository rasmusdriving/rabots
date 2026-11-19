// Part C: stable visit, actions, filter and laptop Week; phone stays on Agenda.
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

  await checkUntil("ahead-screen: Carrying shows a bot with plan, due and waiting counts", '$$("[data-ahead-carry]").some((r) => r.textContent.includes("on Ahead") && r.textContent.includes("due this week") && r.textContent.includes("waiting on you"))');
  const id = await ev('window.pobotsAhead.items().find((i) => i.title === "Send the sample summary").botId');
  const carrying = `$("[data-ahead-carry=" + ${q(id)} + "]")`;
  await ev(`click(${carrying})`);
  await checkUntil("ahead-screen: Carrying filters to the bot", `${carrying}.getAttribute("aria-pressed") === "true" && !!${row("Send the sample summary")} && !${row("Dentist")}`);
  await ev(`click(${carrying})`);
  await checkUntil("ahead-screen: clicking the selected Carrying line clears it", `!!${row("Dentist")}`);
  check("ahead-screen: one block above the days, no separate bot chips or native label select", await ev('!$(".pb-ahead-filters") && !$(".app-ahead select") && !!$(".pb-ahead-carry-head [data-ahead-label]")'));
  const labelChip = '$(".pb-ahead-carry-head [data-ahead-label=\'Sample project\']")';
  await ev(`click(${labelChip})`);
  await checkUntil("ahead-screen: a label chip on the Carrying line shows matching items", `${labelChip}.getAttribute("aria-pressed") === "true" && !!${row("Send the sample summary")} && !${row("Dentist")} && !${row("Quarter report due")}`);
  await ev(`click(${labelChip})`);
  await checkUntil("ahead-screen: tapping the label chip again clears it", `${labelChip}.getAttribute("aria-pressed") === "false" && !!${row("Dentist")}`);

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
  await checkUntil("ahead-screen: Carrying has a You line for the person's own items", `${youLine}?.textContent.includes("2 on Ahead")`);
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
  await checkUntil("ahead-screen: new and moved marks survive leaving without pressing Show", `$("[data-ahead-since]")?.textContent.includes("1 new, 1 moved since") && ${row("An update from the example")}?.textContent.includes("New") && ${row("Answer from the example team")}?.textContent.includes("Moved from")`);
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
  // A native draggable wrapper is present only on ordinary open items. Drag without changing
  // row positions, then check that the engine moved the item.
  const from = `(${sample})?.closest('[draggable="true"]')`;
  const to = '$$("[data-ahead-week-day]").at(-1)';
  await checkUntil("ahead-screen: meetings, to-dos, runs and your time in Week are never draggable",
    `["meeting", "todo", "run"].every(source => {
      const cards = $$("[data-ahead-week] [data-ahead-row^=" + source + "]");
      return cards.length > 0 && cards.every((r) => !r.closest("[draggable=true]"));
    }) && !!${row("Sample time block")} && !${row("Sample time block")}.closest("[draggable=true]")`);
  const day = await ev(`${to}.dataset.aheadWeekDay`);
  const weekTop = await ev(pos(sample));
  await ev(`(() => {
    const d = new DataTransfer(), from = ${from}, to = ${to};
    const fire = (at, name) => at.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: d }));
    fire(from, "dragstart"); fire(to, "dragover"); fire(to, "drop"); return true;
  })()`);
  await checkUntil("ahead-screen: dropping calls Move and keeps the old slot", `window.pobotsAhead.items().find((i) => i.title === "Send the sample summary").day === ${q(day)} && ${sample}?.textContent.includes("Moved to") && ${pos(sample)} === ${weekTop} && ${to}.textContent.includes("Send the sample summary")`);
  await houseRules("ahead-screen Week");
  await shot("ahead-screen-week");
  await ev(`click(${firstBot})`);
  await show();
  await checkUntil("ahead-screen: Week is remembered and shows the moved item at its new day", `${sample}?.closest("[data-ahead-week-day]")?.dataset.aheadWeekDay === ${q(day)}`);

  for (const [width, height, theme] of [[390, 844, "dark"], [360, 780, "light"]]) {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await open("ahead=1&todos=1", { width, height, theme });
    const onBots = await ev('$(".pb-shell")?.dataset.phoneScreen === "bots"');
    if (!onBots) {
      await ev('click($(".app-phone-back"))');
      await until('$(".pb-shell")?.dataset.phoneScreen === "bots"');
    }
    await show();
    await checkUntil(`ahead-screen: at ${width} the phone has Carrying and Add and stays on Agenda`, '!!$("[data-ahead-carry]") && !!$("[data-ahead-add]") && !$("[data-ahead-view-choice]") && !$("[data-ahead-week]")');
    await ev(`click(${sample})`);
    await checkUntil(`ahead-screen: item sheet fits the phone at ${width}`, '!!$("[data-ahead-sheet]") && $(".pb-dialog").getBoundingClientRect().right <= innerWidth && $(".pb-dialog").scrollWidth <= $(".pb-dialog").clientWidth + 1');
    await checkUntil(`ahead-screen: the item sheet is solid at ${width} in ${theme}`, '(() => { const d = $(".pb-dialog"), cs = getComputedStyle(d); const a = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor)?.[1].split(",").map(Number); return cs.opacity === "1" && !!a && (a.length < 4 || a[3] === 1); })()');
    await shot(`ahead-screen-sheet-${width}`);
  }
}
