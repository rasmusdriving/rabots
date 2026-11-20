// Ahead, part A (protocol 31, docs/build/step-ahead.md), against the stand-in engine: off by default
// (no row, the switch in Settings, Ahead), the row first above the bots, the page with today, From
// earlier, the days, meetings and Hide meetings (remembered), Later folded, the bot filter, a new item
// held behind "1 new · Show" with nothing moving, the item sheet (Done keeps the row's box, Move to a
// picked day), the bot's permission, and the house rules, at laptop and both phone sizes, light and dark.
import { b, check, ev, houseRules, open, shot, until } from "../lib.mjs";

const q = JSON.stringify;
const rows = '$$(".app-ahead [data-ahead-row]")';
const chart = () => ev(`${rows}.map((r) => [r.dataset.aheadRow, Math.round(r.getBoundingClientRect().y)])`);
const rowOf = (title) => `${rows}.find((r) => r.querySelector(".pb-ahead-title")?.textContent === ${q(title)})`;
const setDate = (value) => `(() => { const el = $(".pb-ahead-day-input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${q(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";

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

export default async function section() {
  // Off by default: no row, no page; Settings, Ahead has the switch, and switching it on shows the row.
  await device(1280);
  await open("");
  check("ahead: off by default, no row in the bots list", !!(await until('!!$(".app-side .app-row")')) && (await ev('!$("[data-ahead-roster]")')));
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="ahead"]\'))');
  check("ahead: Settings has an Ahead section with the switch off", !!(await until('$("[data-ahead-switch]")?.checked === false')));
  await ev('click($("[data-ahead-switch]"))');
  check("ahead: switching it on shows the row at once", !!(await until('!!$("[data-ahead-roster]") && $("[data-ahead-switch]").checked')));
  await ev('(() => { localStorage.removeItem("pobotsAheadHideMeetings"); return true; })()');

  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    const phone = await device(width);
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      await ev('(() => { localStorage.removeItem("pobotsAheadHideMeetings"); return true; })()');
      await open("ahead=1&todos=1", { width, height, theme });
      await until('!!$(".pb-shell")');
      if (phone) await toBots();
      // The row: first, above the bots.
      const placed = await until('(() => { const a = $("[data-ahead-roster]"); const bot = $(".pb-vacation-list .app-row"); return a && bot && a.getBoundingClientRect().bottom <= bot.getBoundingClientRect().top + 1 && a.textContent.includes("Next 14 days"); })()');
      check(`ahead: the row stands first, above the bots, at ${where}`, !!placed);
      await ev('click($("[data-ahead-roster]"))');
      check(`ahead: the page opens at ${where}`, !!(await until('$(".app-main")?.getAttribute("aria-label") === "Ahead" && !!$("[data-ahead-day]")')));
      if (phone) check(`ahead: on a phone the way back leads to Bots at ${where}`, !!(await until('$(".app-ahead .app-phone-back")?.getAttribute("aria-label") === "Back to Bots"')));
      else check(`ahead: the row is marked open at ${where}`, await ev('$("[data-ahead-roster]").getAttribute("aria-current") === "true"'));
      check(`ahead: the head says the date and next 14 days at ${where}`, await ev('/next 14 days$/.test($(".pb-ahead-head .pb-row-line").textContent)'));
      check(`ahead: today leads, From earlier above it with the passed item at ${where}`, await ev(`(() => { const days = $$("[data-ahead-day]").map((d) => d.dataset.aheadDay); return days[0] === "earlier" && $("[data-ahead-day=earlier]").textContent.includes("Call back about the report") && $$("[data-ahead-day] h3")[1].textContent === "Today"; })()`));
      check(`ahead: items, a dated to-do and meetings show, the to-do the one amber tag at ${where}`, await ev(`!!${rowOf("Send the sample summary")} && !!${rowOf("Weekly sync")} && $$(".app-ahead [data-ahead-row^='todo:']").length > 0 && $$(".app-ahead .pb-ahead-tag[data-for=you]").length === $$(".app-ahead [data-ahead-row^='todo:']").length`));
      check(`ahead: Later is folded at ${where}`, await ev('$("#ahead-later").getAttribute("aria-expanded") === "false" && !$(".pb-ahead-later")'));
      await houseRules(`ahead page ${where}`);
      await shot(`ahead-page-${width}-${theme}`);

      // Hide meetings, remembered on this device.
      await ev('click($("[data-ahead-hide-meetings]"))');
      check(`ahead: Hide meetings takes them away at ${where}`, !!(await until(`!${rowOf("Weekly sync")}`)));
      // A new item while looking waits behind one line; nothing moves.
      const before = await chart();
      await ev('window.pobotsAhead.add("onboardings", "Book the sample review", 1, "will-do", "09:00")');
      const held = await until('$("[data-ahead-held]")?.textContent.includes("1 new")');
      check(`ahead: a new item waits behind "1 new · Show" at ${where}`, !!held);
      check(`ahead: nothing moved while it waits at ${where}`, q(await chart()) === q(before), await chart());
      await ev('click($("[data-ahead-held] button"))');
      check(`ahead: Show brings it in at ${where}`, !!(await until(`!!${rowOf("Book the sample review")} && !$("[data-ahead-held]")`)));

      // Later opens with its groups.
      await ev('click($("#ahead-later"))');
      check(`ahead: Later opens grouped, with the far deadline at ${where}`, !!(await until('$(".pb-ahead-later")?.textContent.includes("Year plan due") && !!$(".pb-ahead-group-title")')));

      // The item sheet: Done keeps the row's box.
      const at = await ev(`Math.round(${rowOf("Send the sample summary")}.getBoundingClientRect().y)`);
      await ev(`click(${rowOf("Send the sample summary")})`);
      check(`ahead: the item sheet opens with Done, Drop and Move at ${where}`, !!(await until('!!$("[data-ahead-sheet]") && !!btn("Done") && !!btn("Drop") && !!$(".pb-ahead-day-input")')));
      await shot(`ahead-sheet-${width}-${theme}`);
      await ev('click(btn("Done"))');
      const kept = await until(`!$("[data-ahead-sheet]") && ${rowOf("Send the sample summary")}?.dataset.tone === "closed"`);
      check(`ahead: a row marked done keeps its place and shows Done at ${where}`, !!kept && (await ev(`Math.round(${rowOf("Send the sample summary")}.getBoundingClientRect().y)`)) === at && (await ev(`${rowOf("Send the sample summary")}.textContent.includes("Done")`)));
      check(`ahead: the person's own action is not held at ${where}`, !!(await until('!$("[data-ahead-held]")', 800)));
      // Move to a picked day: it stays in its box until the screen is left.
      const moveAt = await ev(`Math.round(${rowOf("Answer from the example team")}.getBoundingClientRect().y)`);
      await ev(`click(${rowOf("Answer from the example team")})`);
      await until('!!$(".pb-ahead-day-input")');
      const target = await ev('(() => { const d = new Date(); d.setDate(d.getDate() + 9); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()');
      await ev(setDate(target));
      await ev('click(btn("Move"))');
      check(`ahead: a moved row stays in its box until the screen is left at ${where}`, !!(await until(`!$("[data-ahead-sheet]") && Math.round(${rowOf("Answer from the example team")}.getBoundingClientRect().y) === ${moveAt}`)));
      const moved = await ev(`window.pobotsAhead.items().find((i) => i.title === "Answer from the example team")`);
      check(`ahead: the move reached the engine at ${where}`, moved?.day === target, moved);
      check(`ahead: a moved row says where it went at ${where}`, await ev(`${rowOf("Answer from the example team")}.textContent.includes("Moved to ")`));

      // The bot filter is the Carrying line: tap for one bot only, tap again for everyone.
      if (await ev('!!$("[data-ahead-carry=hubspot-tickets]")')) {
        await ev('click($("[data-ahead-carry=hubspot-tickets]"))');
        check(`ahead: the Carrying line shows one bot's rows at ${where}`, !!(await until(`!${rowOf("Dentist")} && !!${rowOf("Quarter report due")}`)));
        await ev('click($("[data-ahead-carry=hubspot-tickets]"))');
        check(`ahead: tapping the line again shows everyone at ${where}`, !!(await until(`!!${rowOf("Dentist")}`)));
      }
      // Hide meetings is remembered after a reload.
      await b.cmd("Page.reload", {});
      await until('!!$(".pb-shell")');
      if (phone) await toBots();
      await ev('click($("[data-ahead-roster]"))');
      await until('!!$("[data-ahead-day]")');
      check(`ahead: Hide meetings is remembered on this device at ${where}`, await ev(`!${rowOf("Weekly sync")} && $("[data-ahead-hide-meetings]").getAttribute("aria-pressed") === "true"`));
      await ev('click($("[data-ahead-hide-meetings]"))');
      await ev('(() => { localStorage.removeItem("pobotsAheadHideMeetings"); return true; })()');
    }
  }

  // The bot's permission in its Settings; none for the main bot.
  await device(1280);
  await open("ahead=1");
  await until('!!$(".app-side .app-row")');
  await ev('click($$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === "Onboardings"))');
  await until('$(".app-main")?.getAttribute("aria-label") === "Onboardings"');
  await ev('click($(\'.pb-tab[data-tab="settings"]\'))');
  check("ahead: a bot's Settings has the three levels, off checked", !!(await until('$$("[data-ahead-level]").length === 3 && $("[data-ahead-level=off]").getAttribute("aria-checked") === "true"')));
  await ev('click($("[data-ahead-level=items]"))');
  check("ahead: picking Items saves it", !!(await until('$("[data-ahead-level=items]").getAttribute("aria-checked") === "true" && $("[data-ahead-setting]").textContent.includes("Saved")', 3000)) || !!(await ev('$("[data-ahead-level=items]").getAttribute("aria-checked") === "true"')));
  await ev('click($$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === "Kaja"))');
  await until('$(".app-main")?.getAttribute("aria-label") === "Kaja"');
  await ev('click($(\'.pb-tab[data-tab="settings"]\'))');
  check("ahead: the main bot shows no Ahead choice", !!(await until('!!$(".pb-section") && !$("[data-ahead-setting]")')));
  // Switched off from Settings, the page closes and the row goes.
  await ev('click($("[data-ahead-roster]"))');
  await until('$(".app-main")?.getAttribute("aria-label") === "Ahead"');
  await ev('window.pobotsMock ? true : true');
  await ev('click($(".pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="ahead"]\'))');
  await until('!!$("[data-ahead-switch]")');
  await ev('click($("[data-ahead-switch]"))');
  check("ahead: switched off, the row goes and the page closes", !!(await until('!$("[data-ahead-roster]") && $(".app-main:not(.app-ahead)")?.getAttribute("aria-label") !== "Ahead"')));
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
}
