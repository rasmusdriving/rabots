// The window check, section "2b". Run it alone: node scripts/ui-check.mjs --only=2b
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 2b: triggers
export default async function section() {
  part2b: {
  // Helpers for this part: a trigger row by name, typing into a field, choosing in a select.
  const trow = (name) => `$$(".pb-trigger").find((r) => r.querySelector(".pb-trigger-name").textContent === ${JSON.stringify(name)})`;
  const say = `text(".pb-dialog .pb-sched-say")`;
  async function fill(selector, value) {
    await ev(`(() => { const el = $(${JSON.stringify(selector)}); el.focus(); el.select(); return true; })()`);
    await type(value);
  }
  const blur = (selector) => ev(`($(${JSON.stringify(selector)}).blur(), true)`);
  /** A bot's Triggers tab, on the list (the tab remembers an open trigger, so go back first). */
  const toList = async (bot) => {
    await goTo(bot, "triggers");
    await until(`!!$(".app-trigger-back, .pb-triggers, .pb-triggers-empty")`);
    await ev(`$(".app-trigger-back")?.click() ?? true`);
    return until(`!!$(".pb-triggers, .pb-triggers-empty")`);
  };
  const openTrigger = async (bot, name) => {
    await toList(bot);
    await until(`!!${trow(name)}`);
    await ev(`click(${trow(name)}.querySelector(".pb-trigger-open"))`);
    return until(`text(".pb-trigger-head-name") === ${JSON.stringify(name)}`);
  };

  await open("");

  // ---------------- the list
  await goTo("Kaja", "triggers");
  // Step 2f put Artifacts after Files; Triggers still comes before History.
  check("the Triggers tab sits between Artifacts and History", (await ev(`$$(".pb-tab").map((t) => t.textContent).join("|")`)) === "Chat|Job|Files|Artifacts|Triggers|History|Settings");
  check(
    "the list shows each trigger with when it runs in plain words",
    (await until(`$$(".pb-trigger-when").map((x) => x.textContent).join("|") === "Weekdays at 07:30|Every hour, 11:00 to 14:00, weekdays|Every day at 16:30"`)) === true,
    await ev(`$$(".pb-trigger-when").map((x) => x.textContent)`),
  );
  check("a row says how the last run went and when it runs next", /^Done.+Next (today|tomorrow|\w+day) 07:30$/.test((await ev(`${trow("Morning brief")}.querySelector(".pb-trigger-meta").innerText.replace(/\\s+/g, " ")`)) ?? ""), await ev(`${trow("Morning brief")}.querySelector(".pb-trigger-meta").innerText`));
  check("a quiet run with nothing to say has no mark and its own word", (await ev(`(() => { const l = ${trow("Midday sweep")}.querySelector(".pb-trigger-last"); return l.dataset.status === "silent" && l.textContent.startsWith("Nothing to report") && !l.querySelector(".pb-mark").className.includes("pb-mark-"); })()`)) === true);
  await houseRules("triggers list");
  await shot("triggers-list");
  await goTo("Inbox", "triggers");
  await until(`!!${trow("Check mail")}`);
  check("a trigger the bot made says so quietly", (await ev(`${trow("Check mail")}.querySelector(".pb-trigger-by")?.textContent`)) === "Made by Inbox");
  check("a webhook reads: When its address is called", (await ev(`${trow("New Teams message")}.querySelector(".pb-trigger-when").textContent`)) === "When its address is called");
  check("a running run shows the working mark", (await ev(`!!${trow("New Teams message")}.querySelector(".pb-mark-working")`)) === true);

  // ---------------- switch off and on, without the row moving
  await toList("Kaja");
  await until(`!!${trow("Morning brief")}`);
  const rowBox = `(() => { const r = ${trow("Morning brief")}.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)].join(","); })()`;
  const before = await ev(rowBox);
  await ev(`click(${trow("Morning brief")}.querySelector(".pb-switch"))`);
  check("a switch turns a trigger off", !!(await until(`${trow("Morning brief")}.dataset.off !== undefined && ${trow("Morning brief")}.querySelector(".pb-trigger-meta").textContent.includes("Switched off") && !${trow("Morning brief")}.querySelector(".pb-switch").checked`)));
  check("and the row stays where it was, the same height", (await ev(rowBox)) === before, [before, await ev(rowBox)]);
  await shot("triggers-list-off");
  await ev(`click(${trow("Morning brief")}.querySelector(".pb-switch"))`);
  check("and on again, with its next run back", !!(await until(`${trow("Morning brief")}.dataset.off === undefined && ${trow("Morning brief")}.querySelector(".pb-trigger-meta").textContent.includes("Next")`)));

  // ---------------- the sheet: each kind of schedule and its sentence
  await ev(`click(btn("New trigger"))`);
  check("New trigger opens the sheet with the name in focus", !!(await until(`text(".pb-dialog-title") === "New trigger" && document.activeElement?.id === "new-trigger-name"`)));
  check("Create trigger waits for a name and what the bot is told", (await ev(`btn("Create trigger").disabled`)) === true);
  await type("Standup prep");
  await fill("#new-trigger-prompt", "Read the calendar and list what I should bring to the standup.");
  check("the default reads as a sentence: weekdays at 07:30", /^Runs weekdays at 07:30\. Next: /.test((await ev(say)) ?? ""), await ev(say));
  await fill("#new-trigger-time", "815");
  await blur("#new-trigger-time");
  check("a time typed as digits is tidied to 08:15", (await until(`$("#new-trigger-time").value === "08:15"`)) === true);
  await ev(`click(btn("Every day", $(".pb-dialog")))`);
  check("Every day: the sentence follows", (await until(`${say}.startsWith("Runs every day at 08:15. Next: ")`)) === true, await ev(say));
  await ev(`click($('.pb-dialog .pb-day[aria-label="Saturday"]'))`);
  check("taking a day away names the days", (await until(`${say}.startsWith("Runs Mon, Tue, Wed, Thu, Fri and Sun at 08:15.")`)) === true, await ev(say));
  await ev(`$$('.pb-dialog .pb-day[aria-pressed="true"]').forEach((d) => d.click())`);
  check("no day at all is not allowed, in plain words", (await until(`${say} === "Choose at least one day." && $(".pb-dialog .pb-sched-say").dataset.problem !== undefined && btn("Create trigger").disabled`)) === true);
  await ev(`click(btn("Weekdays", $(".pb-dialog")))`);
  await until(`${say}.startsWith("Runs weekdays at 08:15")`);
  await shot("sheet-at-a-time");

  await ev(`click(btn("Every", $(".pb-dialog")))`);
  await fill("#new-trigger-every", "3");
  check("less than 5 minutes apart is refused in plain words", (await until(`${say} === "Runs must be at least 5 minutes apart." && btn("Create trigger").disabled`)) === true, await ev(say));
  await houseRules("sheet with a refusal");
  await shot("sheet-every-refused");
  await fill("#new-trigger-every", "30");
  await fill("#new-trigger-from", "8");
  await blur("#new-trigger-from");
  await fill("#new-trigger-to", "17");
  await blur("#new-trigger-to");
  check("Every 30 minutes between two times reads back", (await until(`${say}.startsWith("Runs every 30 minutes, 08:00 to 17:00, weekdays.")`)) === true, await ev(say));
  await fill("#new-trigger-every", "2");
  await ev(`click(btn("Hours", $(".pb-dialog")))`);
  check("hours read as hours", (await until(`${say}.startsWith("Runs every 2 hours, 08:00 to 17:00, weekdays.")`)) === true, await ev(say));
  await fill("#new-trigger-to", "7");
  await blur("#new-trigger-to");
  check("an end before the start is not allowed", (await until(`${say} === "The end time must come after the start time."`)) === true, await ev(say));
  await fill("#new-trigger-to", "17");
  await blur("#new-trigger-to");
  await shot("sheet-every");

  await ev(`click(btn("Once", $(".pb-dialog")))`);
  const onceDay = await ev(`(() => { const s = $("#new-trigger-date"); const o = s.options[3]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return o.textContent; })()`);
  await fill("#new-trigger-once-time", "13:00");
  check("Once reads back with its date and says it switches itself off", (await until(`${say} === ${JSON.stringify(`Runs once on ${onceDay} at 13:00. Then it switches itself off.`)}`)) === true, [onceDay, await ev(say)]);
  check("dates are chosen, never typed: the next days are offered", (await ev(`$("#new-trigger-date").tagName === "SELECT" && $("#new-trigger-date").options[0].textContent.startsWith("Today, ")`)) === true);
  await shot("sheet-once");
  await ev(`click(btn("Webhook", $(".pb-dialog")))`);
  check("a webhook needs no schedule and says the address comes after", (await until(`!$(".pb-dialog .pb-sched") && $(".pb-dialog").innerText.includes("The address is made when you create it")`)) === true);
  await shot("sheet-webhook");
  await ev(`click(btn("Schedule", $(".pb-dialog")))`);
  await ev(`click(btn("At a time", $(".pb-dialog")))`);
  await ev(`$$('.pb-dialog [role="radio"]')[0].focus()`);
  await key("ArrowDown");
  check("where it runs: arrow keys choose, with a hint on each", (await until(`$('.pb-dialog [role="radio"][aria-checked="true"]')?.textContent.includes("A fresh run starts with a clean head and only reports back if there is something to say.")`)) === true);
  await focusRings("trigger sheet", 24);
  await ev(`click(btn("Create trigger"))`);
  check("Create trigger opens the new trigger's page", !!(await until(`text(".pb-trigger-head-name") === "Standup prep" && !$(".pb-dialog")`)));
  check("which says when it runs", (await ev(`text(".pb-trigger-head-when").startsWith("Weekdays at 08:15")`)) === true, await ev(`text(".pb-trigger-head-when")`));
  await ev(`click(btn("All triggers"))`);
  check("and it is in the list, last", !!(await until(`$$(".pb-trigger-name").pop()?.textContent === "Standup prep"`)));

  // ---------------- keyboard alone: make a trigger without the mouse
  await ev(`$(".app-new-trigger").focus()`);
  await key("Enter");
  await until(`document.activeElement?.id === "new-trigger-name"`);
  await type("Keyboard check");
  await key("Tab");
  check("Tab goes from the name to what the bot is told", (await ev(`document.activeElement?.id`)) === "new-trigger-prompt");
  await type("Say hello.");
  await key("Tab", 8); // Shift+Tab, back to the name
  await key("Enter");
  check("Enter in the name field creates it", !!(await until(`text(".pb-trigger-head-name") === "Keyboard check"`)));
  await focusRings("trigger page", 30);
  await ev(`$(".app-trigger-back").focus()`);
  await key("Enter");
  check("All triggers by keyboard goes back to the list", !!(await until(`!!$(".pb-triggers")`)));
  await ev(`$(".pb-trigger-open").focus()`);
  await focusRings("triggers list", 12);

  // ---------------- a bot sets a schedule with its own tool while the list is open
  const countRows = await ev(`$$(".pb-trigger").length`);
  await ev(`window.pobotsMock.botSchedules("kaja", "Evening wrap", { type: "daily", time: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] })`);
  check("a schedule the bot made arrives in place, marked as its own", !!(await until(`$$(".pb-trigger").length === ${countRows + 1} && ${trow("Evening wrap")}?.querySelector(".pb-trigger-by")?.textContent === "Made by Kaja"`)));

  // ---------------- run now, a fresh run opened in place, nothing jumping
  await openTrigger("Kaja", "Morning brief");
  await until(`$$(".pb-run").length > 0`);
  await houseRules("trigger page");
  await shot("trigger-page");
  const runs = await ev(`$$(".pb-run").length`);
  await ev(`click(btn("Run now"))`);
  check("Run now adds a running run at the top", !!(await until(`$$(".pb-run").length === ${runs + 1} && $(".pb-run").dataset.status === "running"`)));
  const secondTop = `Math.round($$(".pb-run")[1].getBoundingClientRect().top)`;
  const top1 = await ev(secondTop);
  await shot("trigger-run-running");
  check("the run finishes in place", !!(await until(`$(".pb-run").dataset.status === "done"`, 6000)));
  check("and the rows below did not move", (await ev(secondTop)) === top1, [top1, await ev(secondTop)]);
  check("its note is the first words of the result", (await ev(`text(".pb-run .pb-run-note")`)) === "Done. One new message from Nordvik about the import. I told Kaja.");
  await ev(`click($(".pb-run-row"))`);
  check("a fresh run opens its own thread in place, read-only, with the chat's pieces", !!(await until(`!!$(".pb-run-thread .pb-msg-trigger") && $(".pb-run-thread").innerText.includes("Done. One new message from Nordvik") && !$(".pb-run-thread .pb-composer, .pb-run-thread textarea")`)));
  await shot("trigger-run-fresh-open");
  await goTo("Kaja", "chat");
  check("its result reached the main chat as a message from the trigger", !!(await until(`$$(".pb-msg-trigger").some((m) => m.innerText.includes("Result of Morning brief:") && m.innerText.includes("One new message from Nordvik"))`)));

  // ---------------- a run in the main chat opens the chat at that turn
  await openTrigger("Kaja", "Promise sweep");
  await until(`$$(".pb-run").length > 0`);
  await ev(`click($$(".pb-run-row").find((r) => r.tagName === "BUTTON"))`);
  await until(`!!btn("Show in chat")`);
  await shot("trigger-run-main-open");
  await ev(`click(btn("Show in chat"))`);
  check(
    "Show in chat goes to the Chat tab with that turn in view",
    !!(await until(`(() => {
        if (tabOpen() !== "chat") return false;
        const t = $('[data-turn="tk-ps"]'); const s = $(".pb-main-scroll");
        if (!t || !s) return false;
        const a = t.getBoundingClientRect(), b = s.getBoundingClientRect();
        return a.top >= b.top - 1 && a.top < b.bottom - 40;
      })()`)),
  );

  // ---------------- remove a trigger
  await openTrigger("Kaja", "Promise sweep");
  await ev(`click(btn("Remove trigger"))`);
  check("Remove asks first", !!(await until(`text(".pb-dialog-title") === "Remove Promise sweep?"`)));
  await houseRules("remove confirm");
  await shot("trigger-remove-confirm");
  await ev(`click($(".pb-dialog .pb-btn-danger"))`);
  check("the trigger is removed and the list shows again without it", !!(await until(`!$(".pb-dialog") && !!$(".pb-triggers") && !${trow("Promise sweep")}`)));

  // ---------------- a webhook's address: shown, copied, renewed
  await ev(`(() => {
      window.__copied = null;
      const writeText = async (t) => { window.__copied = t; };
      if (navigator.clipboard) navigator.clipboard.writeText = writeText;
      else Object.defineProperty(navigator, "clipboard", { value: { writeText } });
      return true;
    })()`);
  await openTrigger("Inbox", "New Teams message");
  check("the address is hidden until asked for", (await ev(`!$(".pb-address") && !!btn("Show address")`)) === true);
  await ev(`click(btn("Show address"))`);
  const address = await until(`(() => { const t = $$(".pb-address-text")[0]?.textContent ?? ""; return /^http:\\/\\/127\\.0\\.0\\.1:47600\\/hook\\/tr\\d+\\/[A-Za-z0-9_-]{43}$/.test(t) && t; })()`);
  check("Show address reveals it in mono, from the engine's address and the hook path", !!address, await ev(`$$(".pb-address-text")[0]?.textContent`));
  check("with a sentence that anyone with it can wake the bot", (await ev(`$(".pb-hook").innerText.includes("Anyone with this address can wake Inbox")`)) === true);
  check("and an example call with a JSON body", (await ev(`$$(".pb-address-text")[1]?.textContent`)) === `curl -X POST "${address}" -H "Content-Type: application/json" -d '{"text": "Hello"}'`);
  await ev(`click($$(".pb-address .pb-copy")[0])`);
  check("Copy copies it and says Copied quietly", !!(await until(`window.__copied === ${JSON.stringify(address)} && $$(".pb-address .pb-copy")[0].textContent === "Copied"`)));
  await houseRules("webhook address");
  await shot("webhook-address");
  await ev(`click(btn("New address"))`);
  check("New address asks first and says the old one stops working", !!(await until(`text(".pb-dialog-title") === "Make a new address?" && text(".pb-dialog-text").includes("The old address stops working at once")`)));
  await shot("webhook-new-address-confirm");
  await ev(`click(btn("Make a new address"))`);
  check("the new address replaces the old one", !!(await until(`!$(".pb-dialog") && /\\/hook\\/tr\\d+\\//.test($$(".pb-address-text")[0]?.textContent ?? "") && $$(".pb-address-text")[0].textContent !== ${JSON.stringify(address)}`)));

  // ---------------- webhook calls and schedules coming due, through the mock
  const ids = async (bot) => ev(`window.pobotsMock.triggerIds(${JSON.stringify(bot)})`);
  const [ticketId] = await ids("hubspot-tickets");
  await goTo("HubSpot tickets", "chat");
  const ticketMsgs = await ev(`$$(".pb-msg-trigger").length`);
  await ev(`window.pobotsMock.callHook(${JSON.stringify(ticketId)}, { ticket: 48240, subject: "Login" })`);
  check("a webhook call with something to say passes its result to the main chat", !!(await until(`$$(".pb-msg-trigger").length === ${ticketMsgs + 1} && $$(".pb-msg-trigger").pop().innerText.includes("Result of New ticket:")`, 6000)));
  const inboxIds = await ids("inbox");
  await goTo("Inbox", "chat");
  await until(`$$(".pb-msg-trigger").length > 0`);
  check("a message from a webhook in the chat sits on the left with the arrow mark, not as your bubble", (await ev(`(() => { const m = $$(".pb-msg-trigger").find((x) => x.innerText.includes("New Teams message")); const p = $(".app-main").getBoundingClientRect(); return !!m && !m.closest(".app-you") && m.getBoundingClientRect().left < p.left + p.width / 3 && !!m.querySelector(".pb-who-mark svg path") && !!m.querySelector(".app-sent-btn") && !m.innerText.includes("<data"); })()`)) === true);
  await ev(`click($$(".pb-msg-trigger").find((x) => x.innerText.includes("New Teams message")).querySelector(".app-sent-btn"))`);
  check("what the other system sent opens as data in a well", !!(await until(`($(".app-sent")?.textContent ?? "").includes("Lina Berg")`)));
  const inboxMsgs = await ev(`$$(".pb-msg-trigger").length`);
  await ev(`window.pobotsMock.fire(${JSON.stringify(inboxIds[1])})`);
  await openTrigger("Inbox", "Check mail");
  check("a fresh run with nothing to report is silent", !!(await until(`$(".pb-run")?.dataset.status === "silent" && text(".pb-run .pb-run-note") === "Nothing was passed on to the chat"`, 6000)));
  await goTo("Inbox", "chat");
  check("and nothing reached the main chat", (await ev(`$$(".pb-msg-trigger").length`)) === inboxMsgs);
  const [checkId] = await ids("onboardings");
  await goTo("Onboardings", "chat");
  const onbMsgs = await ev(`$$(".pb-msg-trigger").length`);
  await ev(`window.pobotsMock.fire(${JSON.stringify(checkId)})`);
  check("a schedule that runs in the chat arrives there as a message from the trigger", !!(await until(`$$(".pb-msg-trigger").length === ${onbMsgs + 1} && $$(".pb-msg-trigger").pop().querySelector(".pb-msg-trigger-name").textContent === "Morning check"`)));
  check("and the bot answers it in the chat", !!(await until(`$$(".pb-msg").pop()?.innerText.includes("One new message from Nordvik")`, 6000)));
  await houseRules("chat with trigger messages");
  await shot("chat-trigger-messages");

  // ---------------- Later today
  const soon = await ev(`(() => { const d = new Date(Date.now() + 6 * 60_000); return d.getDate() === new Date().getDate() ? String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") : null; })()`);
  if (soon) {
    await toList("Kaja");
    await ev(`click(btn("New trigger"))`);
    await until(`!!$(".pb-dialog")`);
    await type("Soon");
    await fill("#new-trigger-prompt", "Say hello.");
    await ev(`click(btn("Once", $(".pb-dialog")))`);
    await ev(`(() => { const s = $("#new-trigger-date"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, s.options[0].value); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await fill("#new-trigger-once-time", soon);
    await ev(`click(btn("Create trigger"))`);
    await until(`text(".pb-trigger-head-name") === "Soon"`);
    check("Later today lists today's coming runs as time and Name by Bot", !!(await until(`$$(".pb-later-item").some((x) => x.innerText.replace(/\\s+/g, " ") === "${soon} Soon by Kaja")`)), await ev(`$$(".pb-later-item").map((x) => x.innerText)`));
    check("one line per trigger, even one that runs every few minutes", (await ev(`(() => { const w = $$(".pb-later-what").map((x) => x.textContent); return w.length === new Set(w).size; })()`)) === true);
    await goTo("Inbox", "settings");
    await ev(`$(".app-rail").scrollTop = 99999`);
    await shot("rail-later-today");
    await ev(`click($$(".pb-later-item").find((x) => x.innerText.includes("Soon by Kaja")))`);
    check("a line opens that bot's Triggers tab at that trigger", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Kaja" && tabOpen() === "triggers" && text(".pb-trigger-head-name") === "Soon"`)));
  } else check("Later today (skipped: too close to midnight to make a run for today)", true);

  // ---------------- the three gaps from step 2a
  await goTo("HubSpot tickets", "history");
  await until(`!!$(".pb-change")`);
  await ev(`click($$(".pb-change").find((c) => c.textContent.includes("Created the bot")))`);
  await until(`!!$(".pb-diff")`);
  check("a change that cannot be undone has no Undo button", (await ev(`!btn("Undo this change")`)) === true);
  await goTo("Kaja", "history");
  await until(`!!$(".pb-change")`);
  await ev(`click($(".pb-change"))`);
  await until(`!!$(".pb-diff")`);
  check("a change that can be undone still has it", (await ev(`!!btn("Undo this change")`)) === true);
  await goTo("Inbox", "settings");
  await until(`!!$(".pb-rule")`);
  const rules = await ev(`$$(".pb-rule").length`);
  await ev(`click(btn("Always allow", $$(".pb-card").find((c) => c.textContent.includes("Send this reply in Teams"))))`);
  check("Always allow in the rail shows up in an open Settings tab at once", !!(await until(`$$(".pb-rule").length === ${rules + 1} && text(".app-settings").includes("Send this reply in Teams")`)));
  await ev(`window.pobotsMock.addRule("inbox", "Read files in Downloads", "Read(~/Downloads/**)")`);
  check("and so does a rule saved in another window", !!(await until(`$$(".pb-rule").length === ${rules + 2}`)));

  // ---------------- the roster: a long activity line cuts off cleanly
  await ev(`window.pobotsMock.setActivity("onboardings", "Next run Friday 13:00, then the weekly report for every customer onboarding that is still open")`);
  check(
    "a long activity line in the roster cuts off on one line",
    (await until(`(() => { const r = $$(".app-row").find((x) => x.textContent.includes("Onboardings")); const l = r.querySelector(".pb-row-line"); const s = getComputedStyle(l); return l.textContent.startsWith("Next run Friday") && s.textOverflow === "ellipsis" && s.whiteSpace === "nowrap" && l.scrollWidth > l.clientWidth && Math.round(l.getBoundingClientRect().height) <= 18; })()`)) === true,
  );

  // ---------------- 1280, 1024 and 800 px, light and dark, and Windows scaling
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 1024, 800]) {
      await open("", { width, theme });
      await goTo("Kaja", "triggers");
      await until(`$$(".pb-trigger").length > 0`);
      const fits = async (where) => {
        const o = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, panel: $(".app-main").scrollWidth - $(".app-main").clientWidth, view: $(".app-triggers").scrollWidth - $(".app-triggers").clientWidth })`);
        check(`${theme}, ${width} px, ${where}: nothing scrolls sideways`, o.page <= 0 && o.panel <= 1 && o.view <= 1, o);
      };
      await fits("triggers list");
      await shot(`${theme}-${width}-triggers-list`);
      await ev(`click(${trow("Morning brief")}.querySelector(".pb-trigger-open"))`);
      await until(`$$(".pb-run-row").length > 0`);
      await ev(`click($$("button.pb-run-row")[0])`);
      await until(`!!$(".pb-run-thread .pb-msg")`);
      await fits("trigger page with a fresh run open");
      await shot(`${theme}-${width}-trigger-page`);
      await openTrigger("Inbox", "New Teams message");
      await ev(`click(btn("Show address"))`);
      await until(`!!$(".pb-address-text")?.textContent`);
      await fits("webhook address");
      await shot(`${theme}-${width}-webhook`);
      await toList("Kaja");
      await ev(`click(btn("New trigger"))`);
      await until(`!!$(".pb-dialog")`);
      const sheet = await ev(`(() => { const d = $(".pb-dialog"); return d.scrollWidth - d.clientWidth; })()`);
      check(`${theme}, ${width} px: the sheet fits`, sheet <= 1, sheet);
      await shot(`${theme}-${width}-sheet`);
      if (width === 1280) {
        for (const mode of ["Every", "Once"]) {
          await ev(`click(btn(${JSON.stringify(mode)}, $(".pb-dialog")))`);
          await shot(`${theme}-${width}-sheet-${mode.toLowerCase()}`);
        }
        await ev(`click(btn("Webhook", $(".pb-dialog")))`);
        await shot(`${theme}-${width}-sheet-webhook`);
      }
      await key("Escape");
      if (width === 1280) {
        await openTrigger("Kaja", "Promise sweep");
        await until(`$$(".pb-run").length > 0`);
        await ev(`click($$(".pb-run-row").find((r) => r.tagName === "BUTTON"))`);
        await until(`!!btn("Show in chat")`);
        await shot(`${theme}-${width}-run-in-chat`);
        await ev(`click(btn("Remove trigger"))`);
        await until(`!!$(".pb-dialog")`);
        await shot(`${theme}-${width}-remove-confirm`);
        await key("Escape");
        await openTrigger("Inbox", "New Teams message");
        await ev(`click(btn("Show address"))`);
        await ev(`click(btn("New address"))`);
        await until(`!!$(".pb-dialog")`);
        await shot(`${theme}-${width}-new-address-confirm`);
        await key("Escape");
        await goTo("Inbox", "settings");
        await ev(`$(".app-rail").scrollTop = 99999`);
        await shot(`${theme}-${width}-rail-later-today`);
      }
      await goTo("Kaja", "chat");
      await ev(`$(".pb-main-scroll").scrollTop = 0`);
      await shot(`${theme}-${width}-chat-trigger-message`);
    }
  }
  for (const scale of [1.25, 1.5]) {
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: scale, mobile: false });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark` });
    await until(`!!$(".pb-shell")`);
    await goTo("Kaja", "triggers");
    await ev(`click(${trow("Morning brief")}.querySelector(".pb-trigger-open"))`);
    await until(`$$(".pb-run").length > 3`);
    const marks = await ev(`$$(".pb-mark, .pb-mark *").flatMap((el) => [getComputedStyle(el), getComputedStyle(el, "::after")]).filter((s) => ["Top", "Right", "Bottom", "Left"].some((side) => s["border" + side + "Style"] !== "none" && parseFloat(s["border" + side + "Width"]) > 0)).length`);
    check(`at ${scale * 100}% scaling no status mark is drawn from a border`, marks === 0, marks);
    await shot(`scale-${scale * 100}-trigger-page`);
    await toList("Kaja");
    await shot(`scale-${scale * 100}-triggers-list`);
  }
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  // ---------------- three widths
  for (const width of [1280, 1024, 800]) {
    await open("", { width });
    for (const tab of ["chat", "job", "files", "artifacts", "triggers", "history", "settings"]) {
      await goTo("Kaja", tab);
      await sleep(250);
      const head = await ev(`(() => {
          const main = $(".app-main").getBoundingClientRect();
          return $$(".pb-tab").every((t) => { const r = t.getBoundingClientRect(); return r.left >= main.left && r.right <= main.right && r.height > 0; });
        })()`);
      check(`${width} px, ${tab}: the tabs fit in the head`, head === true);
      const o = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, panel: $(".app-main").scrollWidth - $(".app-main").clientWidth })`);
      check(`${width} px, ${tab}: nothing scrolls sideways`, o.page <= 0 && o.panel <= 1, o);
    }
    if (width === 800) {
      await goTo("Kaja", "files");
      await until(`$$(".pb-file").length > 1`);
      await ev(`click($$(".pb-file")[1])`);
      check("800 px: a file opens in place of the list, with a way back", !!(await until(`getComputedStyle($(".app-files-list")).display === "none" && getComputedStyle($(".app-files-back")).display !== "none"`)));
      await ev(`click($(".app-files-back"))`);
      check("800 px: back to the list", !!(await until(`getComputedStyle($(".app-files-list")).display !== "none"`)));
    }
  }


  // ================================================================ step 2c: channels (in section 2b: it uses that step's helpers)
  // Helpers for this part: a channel row in the roster, opening a channel's page, a section by title.
  const crow = (name) => `$$(".pb-channel-row").find((r) => r.querySelector(".pb-channel-name").textContent === ${JSON.stringify(name)})`;
  const openChannel = async (name) => {
    await ev(`click(${crow(name)})`);
    return until(`$(".app-channel")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
  };
  const section = (title) => `$$(".pb-channel-page .pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === ${JSON.stringify(title)})`;
  const cmsgWords = `$$(".pb-cmsg-word").map((x) => x.textContent)`;
  const stubClipboard = () =>
    ev(`(() => {
      window.__copied = null;
      const writeText = async (t) => { window.__copied = t; };
      if (navigator.clipboard) navigator.clipboard.writeText = writeText;
      else Object.defineProperty(navigator, "clipboard", { value: { writeText } });
      return true;
    })()`);
  const channelIds = () => ev(`window.pobotsMock.channelIds()`);

  await open("");

  // ---------------- the roster
  check("the roster has Channels between Bots and Machines", (await ev(`$$(".app-side .pb-side-title").map((t) => t.textContent).join("|")`)) === "Bots|Channels|Machines");
  check(
    "each channel by name with a quiet on or off",
    (await ev(`$$(".pb-channel-row").map((r) => r.querySelector(".pb-channel-name").textContent + " " + r.querySelector(".pb-channel-word").textContent).join("|")`)) === "Ops - Internal on|Customer pilots off",
  );
  check("Channels has its own small add control", (await ev(`$(".app-channels .app-add-channel")?.getAttribute("aria-label")`)) === "Add a channel");

  // ---------------- a channel's page
  check("a channel opens in the reading panel", !!(await openChannel("Ops - Internal")));
  check("the roster shows the channel as the open thing, and no bot", (await ev(`${crow("Ops - Internal")}.getAttribute("aria-current") === "true" && !$('.app-row[aria-current="true"]')`)) === true);
  check("the head: the name, Teams channel and a switch that is on", (await ev(`text(".app-channel .app-name") === "Ops - Internal" && text(".pb-channel-head .pb-row-line") === "Teams channel" && $(".pb-channel-head .pb-switch").checked`)) === true);
  check(
    "the sections in order",
    (await ev(`$$(".pb-channel-page .pb-section-title").map((x) => x.textContent).join("|")`)) === "Who may write here|Tags|Background|Address|Answers|Posts|What the flow sends|Messages|Remove this channel",
    await ev(`$$(".pb-channel-page .pb-section-title").map((x) => x.textContent)`),
  );
  check("who may write: the addresses as soft rows with Remove", (await ev(`$$(".pb-writer").map((w) => w.querySelector(".pb-writer-email").textContent + ":" + w.querySelector("button").textContent).join("|")`)) === "ada@example.com:Remove|bo@example.com:Remove");
  check(
    "tags: each tag reaches a bot, shown with its face and name",
    (await ev(`$$(".pb-route").map((r) => [r.querySelector(".pb-route-tag").textContent, r.querySelector(".pb-route-word").textContent, r.querySelector(".pb-pick-name").textContent, !!r.querySelector(".pb-pick-btn .pb-avatar")].join(" ")).join("|")`)) === "Kaja reaches Kaja true|Inbox reaches Inbox true",
  );
  check("the line about tags as instructions and background", (await ev(`${section("Tags")}.innerText.includes("A message that tags a bot here is an instruction to that bot. The messages before it are given as background.")`)) === true);
  check("background: how many earlier messages", (await ev(`$("#channel-ch-ops-context").value`)) === "10");
  check("answers: an address is set, and nothing of it is shown", (await ev(`text(".pb-reply-state").startsWith("An address for answers is set") && getComputedStyle($("#channel-ch-ops-reply")).webkitTextSecurity === "disc" && $("#channel-ch-ops-reply").value === "" && !document.body.innerHTML.includes("flows.example.com")`)) === true);
  await houseRules("channel page");
  await shot("channel-page");

  // ---------------- the messages, in every status
  await until(`$$(".pb-cmsg").length >= 20`);
  check(
    "messages: newest first, with the status words",
    (await ev(`${cmsgWords}.slice(0, 6).join("|")`)) === "Delivered|Answered|Answer not posted|No answer|No tag matched|Refused",
    await ev(`${cmsgWords}.slice(0, 6)`),
  );
  check("each with a status mark, failed in clay, no answer without a mark", (await ev(`(() => {
      const rows = $$(".pb-cmsg").slice(0, 6);
      const mark = (r) => r.querySelector(".pb-mark").className;
      return mark(rows[0]).includes("pb-mark-working") && mark(rows[1]).includes("pb-mark-check") && mark(rows[2]).includes("pb-mark-blocked") && mark(rows[3]) === "pb-mark" && mark(rows[4]).includes("pb-mark-idle") && mark(rows[5]).includes("pb-mark-idle")
        && getComputedStyle(rows[2].querySelector(".pb-cmsg-word")).color !== getComputedStyle(rows[1].querySelector(".pb-cmsg-word")).color;
    })()`)) === true);
  check("the writer, the tag and bot, the note and when", (await ev(`(() => { const r = $$(".pb-cmsg")[0]; return r.querySelector(".pb-cmsg-who").textContent === "Bo Example" && r.querySelector(".pb-cmsg-to").textContent === "to Inbox" && r.querySelector(".pb-cmsg-note").textContent.startsWith("Inbox has Nordvik") && /min ago$/.test(r.querySelector("time").textContent); })()`)) === true);
  check("every row has the same height whatever its status", (await ev(`new Set($$(".pb-cmsg-row").map((r) => Math.round(r.getBoundingClientRect().height))).size`)) === 1);
  check("a message that never became a turn is not a button", (await ev(`$$(".pb-cmsg")[5].querySelector(".pb-cmsg-row").tagName`)) === "DIV");
  const firstPage = await ev(`$$(".pb-cmsg").length`);
  await ev(`click(btn("Show earlier messages"))`);
  check("more load on request", !!(await until(`$$(".pb-cmsg").length > ${firstPage} && !btn("Show earlier messages")`)), firstPage);
  await ev(`$(".app-channel-scroll").scrollTop = 99999`);
  await shot("channel-messages");
  await ev(`click($$(".pb-cmsg")[1].querySelector("button.pb-cmsg-row"))`);
  check("an answered message opens to its note and Show in chat", !!(await until(`!!$(".pb-cmsg .pb-run-open") && !!btn("Show in chat")`)));
  await shot("channel-message-open");
  await ev(`click(btn("Show in chat"))`);
  check(
    "Show in chat opens that bot's chat with the turn in view",
    !!(await until(`(() => {
        if ($(".app-main")?.getAttribute("aria-label") !== "Kaja" || tabOpen() !== "chat") return false;
        const t = $('[data-turn="tk-ch"]'); const s = $(".pb-main-scroll");
        if (!t || !s) return false;
        const a = t.getBoundingClientRect(), b = s.getBoundingClientRect();
        return a.top >= b.top - 1 && a.top < b.bottom - 40;
      })()`)),
  );
  check("and the roster shows the bot as open again", (await ev(`$('.app-row[aria-current="true"] .pb-row-name')?.textContent === "Kaja" && !$('.pb-channel-row[aria-current="true"]')`)) === true);

  // ---------------- a message from a channel in the chat
  check(
    "a message from a channel sits on the left with a speech mark, the writer and where it came from",
    (await ev(`(() => {
        const m = $(".pb-msg-channel"); const p = $(".app-main").getBoundingClientRect();
        return !!m && !m.closest(".app-you") && m.getBoundingClientRect().left < p.left + p.width / 3 && !!m.querySelector(".pb-who-mark svg path")
          && m.querySelector(".pb-msg-head b").textContent === "Ada Example" && m.querySelector(".pb-msg-from").textContent === "in Ops - Internal, to Kaja"
          && m.querySelector(".pb-msg-body").textContent === "Kaja can you draft the agenda for Thursday";
      })()`)) === true,
  );
  check("its background is closed behind a quiet control", (await ev(`!$(".pb-context") && $(".pb-msg-channel .app-sent-btn")?.textContent === "Show the messages before it"`)) === true);
  await ev(`click($(".pb-msg-channel .app-sent-btn"))`);
  check(
    "and opens as a list of writer and text in a well, oldest first",
    !!(await until(`$$(".pb-context-msg").map((m) => m.querySelector("b").textContent + ": " + m.querySelector(".pb-context-text").textContent).join("|") === "Bo Example: We need an agenda for Thursday.|Ada Example: Yes. The Nordvik import should be first, it runs at 10:00.|Bo Example: And leave ten minutes for the report template."`)),
  );
  check("the notice after the turn is an ordinary notice line", (await ev(`$$(".app-notice").some((n) => n.textContent.startsWith("Answered in Ops - Internal"))`)) === true);
  await houseRules("chat with a channel message");
  await shot("chat-channel-message");

  // ---------------- making a channel, with the keyboard alone
  await ev(`$(".app-add-channel").focus()`);
  await key("Enter");
  check("the add control opens the sheet with the name in focus", !!(await until(`text(".pb-dialog-title") === "New channel" && document.activeElement?.id === "new-channel-name"`)));
  check("Create channel waits for a name", (await ev(`btn("Create channel").disabled`)) === true);
  await houseRules("new channel sheet");
  await shot("channel-sheet");
  await type("Support desk");
  await key("Enter");
  check("Create channel opens its page", !!(await until(`$(".app-channel")?.getAttribute("aria-label") === "Support desk" && !$(".pb-dialog")`)));
  check("and it is in the roster, last, and open", (await ev(`$$(".pb-channel-name").pop()?.textContent === "Support desk" && $$(".pb-channel-row").pop().getAttribute("aria-current") === "true"`)) === true);
  check("a new channel says nobody can write yet", (await ev(`${section("Who may write here")}.innerText.includes("Nobody can write to bots here yet")`)) === true);
  check("and that it has no tags", (await ev(`${section("Tags")}.innerText.includes("No tags yet")`)) === true);
  check("and no address for answers", (await ev(`text(".pb-reply-state") === "No address for answers yet."`)) === true);
  check("and that nothing has come in", !!(await until(`${section("Messages")}.innerText.includes("Nothing has come in yet")`)));
  await shot("channel-page-new");
  const [, , deskId] = await channelIds();
  const did = (rest) => `#channel-${deskId}-${rest}`;

  // ---------------- who may write: add and remove, by keyboard
  await ev(`$(${JSON.stringify(did("writer-new"))}).focus()`);
  await type("Not an address");
  await key("Enter");
  check("something that is not an email address is refused in plain words", !!(await until(`${section("Who may write here")}.querySelector('[role="alert"]')?.textContent === "Write an email address, like name@example.com."`)));
  await ev(`(() => { const i = $(${JSON.stringify(did("writer-new"))}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await type(" Ada@Example.com ");
  await key("Enter");
  check("a writer is added, lowercased, and it says Saved", !!(await until(`$$(".pb-writer-email").map((x) => x.textContent).join("|") === "ada@example.com" && ${section("Who may write here")}.querySelector(".pb-saved[data-show]") && $(${JSON.stringify(did("writer-new"))}).value === ""`)));
  await type("bo@example.com");
  await key("Enter");
  await until(`$$(".pb-writer").length === 2`);
  await type("ADA@example.com");
  await key("Enter");
  check("the same address twice is said, not added", !!(await until(`${section("Who may write here")}.querySelector('[role="alert"]')?.textContent === "That address is already on the list." && $$(".pb-writer").length === 2`)));
  await ev(`click($('[aria-label="Remove bo@example.com"]'))`);
  check("Remove takes a writer away", !!(await until(`$$(".pb-writer-email").map((x) => x.textContent).join("|") === "ada@example.com"`)));

  // ---------------- tags: add one, change its bot, remove it
  await ev(`(() => { const i = $(${JSON.stringify(did("tag-new"))}); i.focus(); return true; })()`);
  await type("#Po");
  check("a new tag reaches the main bot unless another is chosen", (await ev(`$(".pb-route-add .pb-pick-name").textContent`)) === "Kaja");
  await key("Enter");
  check("Add tag adds it without the # and it reaches Kaja", !!(await until(`$$(".pb-route").map((r) => r.querySelector(".pb-route-tag").textContent + ">" + r.querySelector(".pb-pick-name").textContent).join("|") === "Po>Kaja"`)));
  await ev(`$(${JSON.stringify(did("tag-new"))}).focus()`);
  await type("Onboardings");
  check("a tag that is a bot's name reaches that bot", (await ev(`$(".pb-route-add .pb-pick-name").textContent`)) === "Onboardings");
  await key("Enter");
  await until(`$$(".pb-route").length === 2`);
  await type("po");
  await key("Enter");
  check("the same tag twice is said, not added", !!(await until(`${section("Tags")}.querySelector('[role="alert"]')?.textContent === "The tag Po is already here. Choose its bot in its row." && $$(".pb-route").length === 2`)));
  // Change the bot of Po with the keyboard: open the list, arrow down, Enter.
  await ev(`$$(".pb-route")[0].querySelector(".pb-pick-btn").focus()`);
  await key("Enter");
  check("the bot list opens with the chosen bot in focus", !!(await until(`$(".pb-pick-menu") && document.activeElement?.getAttribute("aria-checked") === "true" && document.activeElement.textContent === "Kaja"`)));
  await houseRules("bot list open");
  await shot("channel-bot-picker");
  await key("ArrowDown");
  await key("Enter");
  check("choosing another bot changes the route and focus goes back", !!(await until(`!$(".pb-pick-menu") && $$(".pb-route")[0].querySelector(".pb-pick-name").textContent === "Inbox" && document.activeElement === $$(".pb-route")[0].querySelector(".pb-pick-btn")`)));
  check("and it says Saved", !!(await until(`!!${section("Tags")}.querySelector(".pb-saved[data-show]")`)));
  await key("Enter");
  await until(`!!$(".pb-pick-menu")`);
  await key("Escape");
  check("Escape closes the list and changes nothing", !!(await until(`!$(".pb-pick-menu") && $$(".pb-route")[0].querySelector(".pb-pick-name").textContent === "Inbox" && !!$(".app-channel")`)));
  await ev(`click($('[aria-label="Remove the tag Onboardings"]'))`);
  check("Remove takes a tag away", !!(await until(`$$(".pb-route").length === 1`)));

  // ---------------- background
  await ev(`(() => { const i = $(${JSON.stringify(did("context"))}); i.focus(); i.select(); return true; })()`);
  await type("12");
  await key("Enter");
  check("background: a new number is saved", !!(await until(`$(${JSON.stringify(did("context"))}).value === "12" && !!${section("Background")}.querySelector(".pb-saved[data-show]")`)));
  await ev(`(() => { const i = $(${JSON.stringify(did("context"))}); i.focus(); i.select(); return true; })()`);
  await type("45");
  await ev(`($(${JSON.stringify(did("context"))}).blur(), true)`);
  check("more than 30 is not taken: it goes back to what was saved", !!(await until(`$(${JSON.stringify(did("context"))}).value === "12"`)));

  // ---------------- the answer address: set, never shown, replaced, removed
  const replyUrl = "https://flows.example.com/answer/check-7f3a";
  await ev(`$(${JSON.stringify(did("reply"))}).focus()`);
  await type("http://flows.example.com/answer");
  await key("Enter");
  check("an answer address must start with https://", !!(await until(`${section("Answers")}.querySelector('[role="alert"]')?.textContent === "Use an address that starts with https://."`)));
  await ev(`(() => { const i = $(${JSON.stringify(did("reply"))}); i.select(); return true; })()`);
  await type(replyUrl);
  check(
    "the answer address is typed into a password-style field that password managers leave alone",
    (await ev(`(() => { const i = $(${JSON.stringify(did("reply"))}); return i.type === "text" && getComputedStyle(i).webkitTextSecurity === "disc" && i.autocomplete === "off" && i.hasAttribute("data-1p-ignore"); })()`)) === true,
  );
  await key("Enter");
  check("saving it says it is set and Saved", !!(await until(`text(".pb-reply-state").startsWith("An address for answers is set") && !!${section("Answers")}.querySelector(".pb-saved[data-show]")`)));
  check("the engine has it", (await ev(`window.pobotsMock.hasReplyUrl(${JSON.stringify(deskId)}, ${JSON.stringify(replyUrl)})`)) === true);
  check(
    "and it is never shown again: not in the field, not on the page",
    (await ev(`(() => {
        const inField = $$("input, textarea").some((i) => i.value.includes("flows.example.com"));
        return !inField && !document.body.innerHTML.includes("check-7f3a") && !document.body.innerText.includes("flows.example.com");
      })()`)) === true,
  );
  check("the window's state keeps only that one is set", (await ev(`(() => { const s = JSON.stringify(window.pobotsState()); return !s.includes("check-7f3a") && s.includes('"hasReplyUrl":true'); })()`)) === true);
  await shot("channel-answers-set");
  await ev(`click(btn("Remove", ${section("Answers")}))`);
  check("Remove asks first", !!(await until(`text(".pb-dialog-title") === "Remove the address for answers?"`)));
  await ev(`click(btn("Remove address"))`);
  check("and then there is no answer address", !!(await until(`!$(".pb-dialog") && text(".pb-reply-state") === "No address for answers yet."`)) && (await ev(`window.pobotsMock.hasReplyUrl(${JSON.stringify(deskId)}, ${JSON.stringify(replyUrl)})`)) === false);

  // ---------------- the address: shown on request, copied, renewed
  await stubClipboard();
  check("the address is hidden until asked for", (await ev(`!${section("Address")}.querySelector(".pb-address") && !!btn("Show address", ${section("Address")})`)) === true);
  await ev(`click(btn("Show address", ${section("Address")}))`);
  const chAddress = await until(`(() => { const t = ${section("Address")}.querySelector(".pb-address-text")?.textContent ?? ""; return new RegExp("^http://127\\\\.0\\\\.0\\\\.1:47600/hook/${deskId}/[A-Za-z0-9_-]{43}$").test(t) && t; })()`);
  check("Show address asks the engine and shows it with the channel's id", !!chAddress, await ev(`${section("Address")}.querySelector(".pb-address-text")?.textContent`));
  check("with the line that the flow posts to it, and that it is not public yet", (await ev(`${section("Address")}.innerText.includes("The Power Automate flow posts each tagged message to this address") && ${section("Address")}.innerText.includes("Power Automate can only reach this address once Pobots has a public address")`)) === true);
  await ev(`click(${section("Address")}.querySelector(".pb-copy"))`);
  check("Copy copies it", !!(await until(`window.__copied === ${JSON.stringify(chAddress)}`)));
  await ev(`click(btn("New address", ${section("Address")}))`);
  await until(`text(".pb-dialog-title") === "Make a new address?"`);
  await ev(`click(btn("Make a new address"))`);
  check("a new address replaces the old one", !!(await until(`!$(".pb-dialog") && /\\/hook\\//.test(${section("Address")}.querySelector(".pb-address-text")?.textContent ?? "") && ${section("Address")}.querySelector(".pb-address-text").textContent !== ${JSON.stringify(chAddress)}`)));
  await ev(`click(btn("Hide address", ${section("Address")}))`);
  check("Hide address puts it away", !!(await until(`!${section("Address")}.querySelector(".pb-address")`)));

  // ---------------- what the flow should send
  check("what the flow sends is folded", (await ev(`!$(".pb-flow") && !!btn("Show what the flow should send")`)) === true);
  await ev(`click(btn("Show what the flow should send"))`);
  check("and opens the example body in a well", !!(await until(`(() => { try { const j = JSON.parse(text(".pb-flow-text")); return j.messageId === "1794391578003" && j.from.email === "ada@example.com" && j.mentions[0] === "Po" && j.context.length === 1; } catch { return false; } })()`)));
  await ev(`click($(".pb-flow .pb-copy"))`);
  check("with Copy", !!(await until(`(() => { try { return JSON.parse(window.__copied).threadId === "1794391500000"; } catch { return false; } })()`)));
  await houseRules("channel page, address and flow body open");
  await shot("channel-flow-body");

  // ---------------- the switch
  await ev(`click($(".pb-channel-head .pb-switch"))`);
  check("the switch turns the channel off: the head and the roster say so", !!(await until(`!$(".pb-channel-head .pb-switch").checked && text(".pb-channel-head .pb-row-line") === "Teams channel · Switched off" && ${crow("Support desk")}.querySelector(".pb-channel-word").textContent === "off"`)));
  await ev(`click($(".pb-channel-head .pb-switch"))`);
  check("and on again", !!(await until(`$(".pb-channel-head .pb-switch").checked && ${crow("Support desk")}.querySelector(".pb-channel-word").textContent === "on"`)));

  // ---------------- rename in place
  await ev(`click($(".app-channel .app-name"))`);
  await until(`document.activeElement?.classList.contains("app-rename")`);
  await type("Support desk team");
  await key("Enter");
  check("the name is renamed in place", !!(await until(`text(".app-channel .app-name") === "Support desk team" && !!${crow("Support desk team")}`)));

  await focusRings("channel page", 40);

  // ---------------- remove a channel
  await ev(`$(".app-channel-scroll").scrollTop = 99999`);
  await ev(`click(btn("Remove channel"))`);
  check("Remove asks first", !!(await until(`text(".pb-dialog-title") === "Remove Support desk team?"`)));
  await shot("channel-remove-confirm");
  await ev(`click($(".pb-dialog .pb-btn-danger"))`);
  check("the channel leaves the roster and the panel shows a bot", !!(await until(`!$(".pb-dialog") && !${crow("Support desk team")} && !$(".app-channel") && !!$(".app-main")?.getAttribute("aria-label")`)));

  // ---------------- messages coming in through the flow, live
  await openChannel("Ops - Internal");
  await until(`$$(".pb-cmsg").length > 0`);
  const post = (body) => ev(`window.pobotsMock.channelPost("ch-ops", ${JSON.stringify(body)})`);
  const rowTop = (i) => `Math.round($$(".pb-cmsg")[${i}].getBoundingClientRect().top)`;
  const rowHeight = `Math.round($$(".pb-cmsg-row")[0].getBoundingClientRect().height)`;
  const sent = await post({ messageId: "check-1", from: { name: "Ada Example", email: "ADA@example.com" }, text: "Kaja what is on Thursday", mentions: ["@Kaja"], context: [{ from: "Bo Example", text: "Thursday is busy." }] });
  check("a tagged message from an allowed writer is delivered", sent === "delivered", sent);
  check("it arrives on top of the list as Delivered", !!(await until(`$$(".pb-cmsg")[0].querySelector(".pb-cmsg-word").textContent === "Delivered" && $$(".pb-cmsg")[0].querySelector(".pb-cmsg-note").textContent === "Kaja what is on Thursday"`)));
  const h1 = await ev(rowHeight);
  const t1 = await ev(rowTop(1));
  await shot("channel-message-delivered");
  check("and becomes Answered in place when the answer is posted", !!(await until(`$$(".pb-cmsg")[0].querySelector(".pb-cmsg-word").textContent === "Answered"`, 8000)));
  check("the row keeps its height and the rows below do not move", (await ev(rowHeight)) === h1 && (await ev(rowTop(1))) === t1, [h1, await ev(rowHeight), t1, await ev(rowTop(1))]);
  check("the roster line of the channel is unchanged by it", (await ev(`${crow("Ops - Internal")}.querySelector(".pb-channel-word").textContent`)) === "on");
  check("a second post of the same message does nothing", (await post({ messageId: "check-1", from: { email: "ada@example.com" }, text: "Kaja again", mentions: ["Kaja"] })) === "duplicate" && (await ev(`$$(".pb-cmsg").filter((r) => r.querySelector(".pb-cmsg-note")?.textContent === "Kaja again").length`)) === 0);
  check("a writer who is not allowed is refused", (await post({ messageId: "check-2", from: { name: "Dee Example", email: "dee@example.com" }, text: "Kaja do this", mentions: ["Kaja"] })) === "refused" && !!(await until(`$$(".pb-cmsg")[0].querySelector(".pb-cmsg-word").textContent === "Refused" && $$(".pb-cmsg")[0].querySelector(".pb-cmsg-who").textContent === "Dee Example"`)));
  check("a message whose tag reaches no bot is No tag matched", (await post({ messageId: "check-3", from: { name: "Bo Example", email: "bo@example.com" }, text: "Hello all" })) === "ignored" && !!(await until(`$$(".pb-cmsg")[0].querySelector(".pb-cmsg-word").textContent === "No tag matched"`)));
  check("a tag at the start of the text reaches the bot without mentions", (await post({ messageId: "check-4", from: { name: "Bo Example", email: "bo@example.com" }, text: "Inbox no reply needed, just so you know" })) === "delivered");
  check("a turn that ends with No reply is No answer", !!(await until(`(() => { const r = $$(".pb-cmsg").find((x) => x.querySelector(".pb-cmsg-note")?.textContent.startsWith("Inbox had nothing")); return !!r && r.querySelector(".pb-cmsg-word").textContent === "No answer"; })()`, 8000)));
  await ev(`window.pobotsMock.replyFails("ch-ops", true)`);
  check("when posting the answer fails", (await post({ messageId: "check-5", from: { name: "Ada Example", email: "ada@example.com" }, text: "Kaja one more thing", mentions: ["Kaja"] })) === "delivered");
  check("the message says Answer not posted, in clay", !!(await until(`$$(".pb-cmsg")[0].querySelector(".pb-cmsg-word").textContent === "Answer not posted" && getComputedStyle($$(".pb-cmsg")[0].querySelector(".pb-cmsg-word")).color !== getComputedStyle($$(".pb-cmsg")[1].querySelector(".pb-cmsg-word")).color`, 8000)));
  await ev(`window.pobotsMock.replyFails("ch-ops", false)`);
  await shot("channel-messages-live");
  await ev(`click($(".pb-channel-head .pb-switch"))`);
  await until(`!$(".pb-channel-head .pb-switch").checked`);
  check("a channel that is switched off takes nothing in", (await post({ messageId: "check-6", from: { email: "ada@example.com" }, text: "Kaja hi", mentions: ["Kaja"] })) === "not-found");
  await ev(`click($(".pb-channel-head .pb-switch"))`);
  await until(`$(".pb-channel-head .pb-switch").checked`);
  await goTo("Kaja", "chat");
  check("the delivered message reached Kaja's chat with its background", !!(await until(`$$(".pb-msg-channel").some((m) => m.querySelector(".pb-msg-body").textContent === "Kaja what is on Thursday" && !!m.querySelector(".app-sent-btn"))`)));
  check("the failed answer is said in the chat as an error notice", !!(await until(`$$(".app-notice-error").some((n) => n.textContent.startsWith("The answer could not be posted in Ops - Internal"))`)));

  // ---------------- the main bot's changes to a channel: at once, one quiet line in its chat, no card
  // (two approval cards until the tester's walk of 15 Nov 2026; the section "changes" looks at the lines)
  await open("scene=channels");
  check("the main bot's channel changes put no card under Needs you", (await ev(`$$(".pb-card").some((c) => /Make the tag Inbox|Change who may write/.test(c.textContent))`)) === false);
  await goTo("Kaja", "chat");
  check(
    "a quiet line in the main bot's chat says what changed in the channel, from what to what",
    !!(await until(`$$(".app-main .app-notice span").some((n) => n.textContent === "Channel Ops - Internal: the tag Inbox reaches Onboardings (was Inbox); cy@example.com may write now; bo@example.com may no longer write")`)),
  );
  await openChannel("Ops - Internal");
  check("the change shows on the channel page", !!(await until(`$$(".pb-route").map((r) => r.querySelector(".pb-route-tag").textContent + ">" + r.querySelector(".pb-pick-name").textContent).join("|") === "Kaja>Kaja|Inbox>Onboardings"`)));
  check("and so does the change of writers", !!(await until(`$$(".pb-writer-email").map((x) => x.textContent).join("|") === "ada@example.com|cy@example.com"`)));

  // ---------------- a public base address, for webhooks and channels
  await open("publicBase=1");
  await openChannel("Ops - Internal");
  await ev(`click(btn("Show address", ${section("Address")}))`);
  check("with a public base the channel's address is the public one", !!(await until(`/^https:\\/\\/pobots\\.example\\.com\\/hook\\/ch-ops\\/[A-Za-z0-9_-]{43}$/.test(${section("Address")}.querySelector(".pb-address-text")?.textContent ?? "")`)));
  check("and the line about a public address is gone", (await ev(`!${section("Address")}.innerText.includes("once Pobots has a public address")`)) === true);
  await openTrigger("Inbox", "New Teams message");
  await ev(`click(btn("Show address"))`);
  check("a webhook's address uses it too, asked for with trigger.address", !!(await until(`/^https:\\/\\/pobots\\.example\\.com\\/hook\\/tr\\d+\\/[A-Za-z0-9_-]{43}$/.test($(".pb-address-text")?.textContent ?? "")`)));
  check("the window's state holds no address after showing two", (await ev(`(() => { const s = JSON.stringify(window.pobotsState()); return s.includes('"triggers"') && s.includes('"channels"') && !s.includes("/hook/") && !s.includes("hookPath"); })()`)) === true);

  // ---------------- a trigger's switch uses trigger.enable, never a whole save
  await toList("Kaja");
  await until(`!!${trow("Morning brief")}`);
  const calls = () => ev(`window.pobotsMock.requests()`);
  const before2c = await calls();
  await ev(`click(${trow("Morning brief")}.querySelector(".pb-switch"))`);
  await until(`!${trow("Morning brief")}.querySelector(".pb-switch").checked`);
  await ev(`click(${trow("Morning brief")}.querySelector(".pb-switch"))`);
  await until(`${trow("Morning brief")}.querySelector(".pb-switch").checked`);
  const after2c = await calls();
  check(
    "the switch on a trigger sends trigger.enable, not a whole trigger.save",
    (after2c["trigger.enable"] ?? 0) - (before2c["trigger.enable"] ?? 0) === 2 && (after2c["trigger.save"] ?? 0) === (before2c["trigger.save"] ?? 0),
    [before2c, after2c],
  );
  check("Show address asked with trigger.address", (after2c["trigger.address"] ?? 0) >= 1, after2c);

  // ---------------- no channels: only the title and the add control
  await open("");
  await openChannel("Customer pilots");
  await ev(`$(".app-channel-scroll").scrollTop = 99999`);
  await ev(`click(btn("Remove channel"))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click($(".pb-dialog .pb-btn-danger"))`);
  await until(`!${crow("Customer pilots")}`);
  await openChannel("Ops - Internal");
  await ev(`$(".app-channel-scroll").scrollTop = 99999`);
  await ev(`click(btn("Remove channel"))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click($(".pb-dialog .pb-btn-danger"))`);
  check("with no channels the group shows only its title and the add control", !!(await until(`$$(".pb-channel-row").length === 0 && text(".app-channels .pb-side-title") === "Channels" && !!$(".app-add-channel") && !$(".app-channels ul")`)));
  await shot("roster-no-channels");

  // ---------------- 1280, 1024 and 800 px, light and dark, and Windows scaling
  for (const theme of ["dark", "light"]) {
    for (const width of [1280, 1024, 800]) {
      const tag = `${theme}-${width}`;
      await open("", { width, theme });
      await stubClipboard();
      const fits = async (where) => {
        const o = await ev(`({ page: document.scrollingElement.scrollWidth - innerWidth, panel: $(".app-main").scrollWidth - $(".app-main").clientWidth, view: ($(".app-channel-scroll") ?? $(".pb-main-scroll")).scrollWidth - ($(".app-channel-scroll") ?? $(".pb-main-scroll")).clientWidth })`);
        check(`${theme}, ${width} px, ${where}: nothing scrolls sideways`, o.page <= 0 && o.panel <= 1 && o.view <= 1, o);
      };
      check(`${theme}, ${width} px: the channels can be reached in the roster`, (await ev(`(() => { const r = ${crow("Ops - Internal")}.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right <= $(".app-side").getBoundingClientRect().right; })()`)) === true);
      await openChannel("Ops - Internal");
      await fits("channel page");
      await shot(`${tag}-channel-page`);
      await ev(`click($$(".pb-route")[1].querySelector(".pb-pick-btn"))`);
      await until(`!!$(".pb-pick-menu")`);
      const menu = await ev(`(() => { const m = $(".pb-pick-menu").getBoundingClientRect(), p = $(".app-main").getBoundingClientRect(); return m.left >= p.left && m.right <= p.right; })()`);
      check(`${theme}, ${width} px: the bot list stays inside the panel`, menu === true);
      await shot(`${tag}-channel-bot-picker`);
      await key("Escape");
      await ev(`click(btn("Show address", ${section("Address")}))`);
      await until(`!!${section("Address")}.querySelector(".pb-address-text")`);
      await ev(`click(btn("Show what the flow should send"))`);
      await until(`!!$(".pb-flow-text")`);
      await ev(`inPanel(${section("Address")})`);
      await fits("channel page, address and flow body open");
      await shot(`${tag}-channel-address`);
      await ev(`inPanel(${section("Messages")})`);
      await fits("channel messages");
      await shot(`${tag}-channel-messages`);
      await ev(`click($(".app-add-channel"))`);
      await until(`!!$(".pb-dialog")`);
      const sheet = await ev(`(() => { const d = $(".pb-dialog"); return d.scrollWidth - d.clientWidth; })()`);
      check(`${theme}, ${width} px: the new channel sheet fits`, sheet <= 1, sheet);
      await shot(`${tag}-channel-sheet`);
      await key("Escape");
      await goTo("Kaja", "chat");
      await ev(`click($(".pb-msg-channel .app-sent-btn"))`);
      await until(`!!$(".pb-context")`);
      await ev(`inPanel($(".pb-msg-channel"))`);
      await fits("chat with a channel message open");
      await shot(`${tag}-chat-channel-message`);
      if (width === 1280) {
        await open("scene=channels", { width, theme });
        await shot(`${tag}-rail-after-channel-changes`);
        await openChannel("Customer pilots");
        await shot(`${tag}-channel-page-empty`);
        await ev(`$(".app-channel-scroll").scrollTop = 99999`);
        await ev(`click(btn("Remove channel"))`);
        await until(`!!$(".pb-dialog")`);
        await shot(`${tag}-channel-remove-confirm`);
        await key("Escape");
      }
    }
  }
  for (const scale of [1.25, 1.5]) {
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: scale, mobile: false });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=dark` });
    await until(`!!$(".pb-shell")`);
    await openChannel("Ops - Internal");
    await ev(`inPanel(${section("Messages")})`);
    await until(`$$(".pb-cmsg").length > 5`);
    const marks = await ev(`$$(".pb-mark, .pb-mark *, .pb-who-mark, .pb-channel-mark").flatMap((el) => [getComputedStyle(el), getComputedStyle(el, "::after")]).filter((s) => ["Top", "Right", "Bottom", "Left"].some((side) => s["border" + side + "Style"] !== "none" && parseFloat(s["border" + side + "Width"]) > 0)).length`);
    check(`at ${scale * 100}% scaling no mark on the channel page is drawn from a border`, marks === 0, marks);
    await shot(`scale-${scale * 100}-channel-messages`);
    await goTo("Kaja", "chat");
    await ev(`inPanel($(".pb-msg-channel"))`);
    await shot(`scale-${scale * 100}-chat-channel-message`);
  }
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  }
}
