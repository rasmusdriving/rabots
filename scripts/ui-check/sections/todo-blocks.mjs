// To-do blocks (protocol 32, docs/build/step-todo-blocks.md), against the stand-in engine with the
// calendar connected and to-dos in the calendar on (?ahead=on&calendar=1&todoblocks=1): a to-do's
// block is one amber block in Week and in the phone's Day, tagged To-do and as tall as its minutes,
// with no dated to-do row beside it; its sheet has Open the to-do first, Done marks the to-do done
// and Remove the block keeps it; Settings, Ahead has the switch only with a calendar and the "How to
// schedule me" box; and the page reloads once after a new engine version, not while the person
// types or a dialog is open, with the chat draft back. Engine 0.44.0: a block keeps its bot's wish (when
// it should land) and the window shows none. Laptop and both phone sizes, light and dark.
import { b, check, ev, houseRules, open, shot, sleep, type, until } from "../lib.mjs";

const q = JSON.stringify;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
const Q = "ahead=on&calendar=1&todoblocks=1";
const SMALL = "Send the sample summary";
const BIG = "Review the sample deck";
const block = (title) => `$$("[data-ahead-week] [data-ahead-row]").find((r) => r.querySelector(".pb-ahead-title")?.textContent === ${q(title)})`;
const item = (title) => `window.pobotsAhead.items().find((i) => i.title === ${q(title)})`;

async function device(width) {
  const phone = width < 700;
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 1 : 0 });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: width === 390 ? IPHONE : width === 360 ? ANDROID : "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" });
  return phone;
}

async function toGrid(phone) {
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
  return until(`!!${block(SMALL)}`);
}

async function toSettings() {
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="ahead"]\'))');
  return until('!!$("[data-todo-blocks-settings]")');
}

export default async function section() {
  await ev('(() => { localStorage.removeItem("pobotsAheadHideMeetings"); localStorage.removeItem("pobotsAheadWeek"); return true; })()');
  for (const [width, height] of [[1330, 860], [390, 844], [360, 780]]) {
    const phone = await device(width);
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      await open(Q, { width, height, theme });
      check(`todo-blocks: ${phone ? "Day" : "Week"} opens with the blocks at ${where}`, !!(await toGrid(phone)));
      const look = await ev(`(() => {
        const s = ${block(SMALL)}, g = ${block(BIG)};
        if (!s || !g) return null;
        const h = (r) => Math.round(r.getBoundingClientRect().height);
        return { tone: s.closest(".pb-ahead-blk")?.dataset.tone ?? s.dataset.tone, small: h(s), big: h(g), label: s.getAttribute("aria-label"),
          todoRow: $$('[data-ahead-week] [data-ahead-row^="todo:"]').some((r) => r.textContent.includes(${q(BIG)})),
          meeting: $$("[data-ahead-week] [data-ahead-row^='meeting:']").some((r) => r.textContent.includes("To-do:")) };
      })()`);
      check(`todo-blocks: a block is amber, tagged To-do, as tall as its minutes, at ${where}`, !!look && look.tone === "you" && /^To-do, /.test(look.label) && look.big > look.small * 2, look);
      check(`todo-blocks: no dated to-do row and no grey meeting beside it at ${where}`, !!look && !look.todoRow && !look.meeting, look);
      // Engine 0.44.0: the block keeps its bot's wish (after 13:00) and is still one amber block; the window shows no wish.
      const wish = await ev(`(() => { const s = ${block(SMALL)}; return { wish: ${item(SMALL)}?.wish ?? null, rows: $$("[data-ahead-week] [data-ahead-row]").filter((r) => r.textContent.includes(${q(SMALL)})).length, words: /block_not|not before|wish/i.test((s?.textContent ?? "") + (s?.getAttribute("aria-label") ?? "")) }; })()`);
      check(`todo-blocks: a block with a wish keeps it and shows as one block with no wish words at ${where}`, wish.wish?.notBefore === "13:00" && wish.rows === 1 && !wish.words, wish);
      if (!phone) {
        const f = await ev('(() => { const page = $(".app-ahead-scroll"), body = $("[data-ahead-grid-body]"); return { page: page.scrollHeight - page.clientHeight, inner: body.scrollHeight - body.clientHeight, sideways: page.scrollWidth - page.clientWidth, days: $$("[data-ahead-week-day]").length }; })()');
        check(`todo-blocks: five days fit with no scrolling at ${where}`, f.page <= 0 && f.inner <= 0 && f.sideways <= 0 && f.days === 5, f);
      } else {
        check(`todo-blocks: nothing goes sideways on the phone at ${where}`, await ev('document.documentElement.scrollWidth <= innerWidth'));
      }
      await houseRules(`todo-blocks grid ${where}`);
      await shot(`todo-blocks-grid-${width}-${theme}`);

      // The sheet: Open the to-do first, Done, Remove the block.
      await ev(`click(${block(SMALL)})`);
      const sheet = await until(`(() => { const s = $("[data-ahead-time-sheet]"); if (!s) return null; const btns = [...s.querySelectorAll("button")].map((x) => x.textContent); const r = $(".pb-dialog").getBoundingClientRect(); return { first: btns[0], drop: btns.includes("Remove the block"), plainDrop: btns.includes("Drop"), from: s.querySelector(".pb-ahead-sheet-from").textContent, fits: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5 }; })()`);
      check(`todo-blocks: the sheet says To-do, has Open the to-do first and Remove the block, at ${where}`, !!sheet && sheet.first === "Open the to-do" && sheet.drop && !sheet.plainDrop && /^To-do · /.test(sheet.from) && sheet.fits, sheet);
      check(`todo-blocks: the sheet shows no wish at ${where}`, !(await ev('/block_not|not before|wish/i.test($("[data-ahead-time-sheet]")?.textContent ?? "")')));
      await houseRules(`todo-blocks sheet ${where}`);
      await shot(`todo-blocks-sheet-${width}-${theme}`);
      if (width === 1330 && theme === "light") {
        // Done marks the to-do done; the block leaves.
        const todoId = await ev(`${item(SMALL)}.forTodo`);
        await ev('click(btn("Done"))');
        check("todo-blocks: Done on the block marks the to-do done", !!(await until(`!window.pobotsTodos.list().some((t) => t.id === ${q(todoId)}) && ${item(SMALL)}.state === "done"`)));
        // Remove the block keeps the to-do.
        await until(`!!${block(BIG)}`);
        await ev(`click(${block(BIG)})`);
        await until('!!$("[data-ahead-time-sheet]")');
        const bigTodo = await ev(`${item(BIG)}.forTodo`);
        await ev('click(btn("Remove the block"))');
        check("todo-blocks: Remove the block drops it and keeps the to-do", !!(await until(`${item(BIG)}.state === "dropped" && window.pobotsTodos.list().some((t) => t.id === ${q(bigTodo)})`)));
        const todoRow = `$$('[data-ahead-week] [data-ahead-row^="todo:"]').some((r) => r.textContent.includes(${q(BIG)}))`;
        await until(`!!$("[data-ahead-held] button") || ${todoRow}`, 4000);
        if (await ev('!!$("[data-ahead-held] button")')) await ev('click($("[data-ahead-held] button"))');
        check("todo-blocks: with its block gone, the dated to-do shows again", !!(await until(todoRow)));
      } else {
        await ev('click(btn("Close"))');
        await until('!$("[data-ahead-time-sheet]")');
      }

      // Settings, Ahead: the switch with the calendar connected, and How to schedule me.
      if (!phone || theme === "light") {
        check(`todo-blocks: Settings, Ahead has the switch, on, at ${where}`, !!(await toSettings()) && (await ev('$("[data-todo-blocks-switch]")?.checked === true && $("[data-ahead-scheduling]").value.startsWith("Small things get 5 minutes")')));
        await houseRules(`todo-blocks settings ${where}`);
        await shot(`todo-blocks-settings-${width}-${theme}`);
      }
    }
  }

  // The box: Save, then Use the default.
  await device(1280);
  await open(Q, { width: 1280, height: 820, theme: "light" });
  await toSettings();
  await ev('(() => { const t = $("[data-ahead-scheduling]"); t.focus(); t.select(); return true; })()');
  await type("Five minutes for small things. Mornings are for customers.");
  check("todo-blocks: Save is there once the text changed", await ev('!$("[data-ahead-scheduling-save]").disabled'));
  await ev('click($("[data-ahead-scheduling-save]"))');
  check("todo-blocks: the person's text is saved", !!(await until('window.pobotsAhead.state().scheduling === "Five minutes for small things. Mornings are for customers." && $("[data-ahead-scheduling-save]").disabled')));
  await ev('click($("[data-ahead-scheduling-default]"))');
  check("todo-blocks: Use the default puts the default back", !!(await until('window.pobotsAhead.state().scheduling === undefined && $("[data-ahead-scheduling]").value.startsWith("Small things get 5 minutes")')));
  await ev('click($("[data-todo-blocks-switch]"))');
  check("todo-blocks: the switch turns it off", !!(await until('window.pobotsAhead.state().todoBlocks === false')));

  // A bot's Ahead setting no longer says its to-dos never reach the calendar while the switch is on.
  await open(Q, { width: 1280, height: 820, theme: "light" });
  await until('!!$(".app-side .app-row")');
  await ev('click($$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === "Onboardings"))');
  await until('$(".app-main")?.getAttribute("aria-label") === "Onboardings"');
  await ev('click($(\'.pb-tab[data-tab="settings"]\'))');
  check("todo-blocks: a bot's Ahead setting says its to-dos get a block in the calendar", !!(await until('$("[data-ahead-calendar-hint]")?.textContent.includes("gets its block of time in your calendar")')));

  // Without a calendar: no switch, a line that says where to connect it.
  await open("ahead=on", { width: 1280, height: 820, theme: "light" });
  await toSettings();
  check("todo-blocks: without a calendar there is no switch, only where to connect it", await ev('!$("[data-todo-blocks-switch]") && !!$("[data-todo-blocks-no-calendar]") && !!$("[data-ahead-scheduling]")'));

  // The reload after a new engine version: not while typing, then once, with the draft back.
  await ev("sessionStorage.clear()");
  await open("", { width: 1280, height: 820, theme: "light" });
  await until('!!$(".pb-composer textarea")');
  await ev('(() => { window.pobotsMark = 1; $(".pb-composer textarea").focus(); return true; })()');
  await type("A draft that must not be lost");
  await ev('window.pobotsMock.dropConnection()');
  await ev('window.pobotsMock.newEngineVersion("9.9.9")');
  await sleep(4000);
  check("todo-blocks: no reload while the person types", (await ev("window.pobotsMark")) === 1);
  await ev('(() => { $(".pb-composer textarea").blur(); return true; })()');
  const reloaded = await until('window.pobotsMark === undefined && !!$(".pb-composer textarea")', 8000);
  check("todo-blocks: once the box is left, the page reloads by itself", !!reloaded && (await ev('performance.getEntriesByType("navigation")[0].type')) === "reload" && (await ev('sessionStorage.getItem("pobots.reloadedForVersion")')) === "9.9.9");
  check("todo-blocks: the draft is back after the reload", !!(await until('$(".pb-composer textarea")?.value === "A draft that must not be lost"', 4000)));
  // Once per version: the same version again does not reload.
  await ev("window.pobotsMark = 2");
  await ev('(() => { $(".pb-composer textarea").blur(); return true; })()');
  await ev('window.pobotsMock.dropConnection()');
  await ev('window.pobotsMock.newEngineVersion("9.9.9")');
  await sleep(1500);
  check("todo-blocks: the same version never reloads twice", (await ev("window.pobotsMark")) === 2);
  // A dialog open holds it too.
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  const dialog = await until('!!$("[role=dialog]")');
  await ev('window.pobotsMock.dropConnection()');
  await ev('window.pobotsMock.newEngineVersion("9.9.10")');
  await sleep(4000);
  check("todo-blocks: no reload while a dialog is open", !!dialog && (await ev("window.pobotsMark")) === 2);
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
}
