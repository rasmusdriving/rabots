// The window check, section "calendar". Run it alone: node scripts/ui-check.mjs --only=calendar
// The calendar tools (16 Nov 2026, docs/build/step-calendar.md): the switch in a bot's Settings tab
// (on for the main bot, off for the others, a way to set up the calendar while it is not), the
// settings window's Calendar section (the flow's address written and never shown again, Check the
// connection, the mailbox, the internal domains, Remove), the meeting card (the meeting written out,
// Approve and Deny only) and the quiet "Created ..." line with "Show the details". The stand-in engine
// seeds them with &calendar=1 (ui/engine/mock-calendar.ts); without the flag the calendar is not set up.
import { check, ev, until, open, shot, houseRules, sleep, type } from "../lib.mjs";

const isPhone = () => ev(`!!$(".app-shell")?.dataset.phoneScreen`);

/** On the phone: back until the roster shows. */
async function toRoster() {
  if (!(await isPhone())) return;
  const shown = `$$(".app-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(shown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
}

async function openBot(name, tab) {
  await toRoster();
  await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
  // On a phone the tabs are behind the bot's page button.
  const vis = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }))`;
  const tabSel = `.pb-tab[data-tab="${tab}"]`;
  if (!(await ev(`!!${vis(tabSel)}`))) await ev(`click(${vis(".app-phone-page")})`);
  await until(`!!${vis(tabSel)}`);
  await ev(`click(${vis(tabSel)})`);
  return until(`${vis(tabSel)}?.getAttribute("aria-selected") === "true" || null`);
}

const sec = `$$(".app-main .pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Calendar")`;
const sw = `${sec}?.querySelector(".pb-switch")`;
const win = `$(".app-appsettings")`;
const conn = `$(".pb-calendar")`;
const card = `$$(".pb-card").find((c) => c.querySelector(".pb-meet"))`;
const calLine = (start) => `$$(".app-main .app-notice").find((n) => n.dataset.mark === "calendar" && n.querySelector("span:not(.pb-mark)")?.textContent.startsWith(${JSON.stringify(start)}))`;

async function typeInto(selector, text) {
  await ev(`(() => { const i = $(${JSON.stringify(selector)}); i.focus(); i.select(); return true; })()`);
  await type(text);
}

export default async function section() {
  const M = (name) => `calendar: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);

      // ---------------- not set up: the switch, and the way to set it up
      await open("", { width, height, theme });
      check(T("Inbox's Settings tab opens"), !!(await openBot("Inbox", "settings")));
      await ev(`${sec}?.scrollIntoView({ block: "center" })`);
      const off = await until(`(() => { const s = ${sec}; if (!s) return null; return {
        name: s.querySelector(".pb-peer-name")?.textContent, on: ${sw}.checked,
        hint: s.querySelector(".pb-steer .pb-hint")?.textContent,
        note: s.querySelector("[data-calendar-note]")?.textContent ?? "",
        h: s.getBoundingClientRect().height,
        order: $$(".app-main .pb-section-title").map((x) => x.textContent),
      }; })()`);
      check(T("a Calendar section with the Calendar tools switch, off for a bot that is not the main bot"), off?.name === "Calendar tools" && off.on === false, off);
      check(T("it stands after May steer"), !!off && off.order.indexOf("Calendar") === off.order.indexOf("May steer") + 1, off?.order);
      check(T("its hint says what the bot can do and that a meeting with others waits for approval"), off?.hint === "On: Inbox can look at your calendar, find free times, book and move meetings and answer invitations. A meeting with other people waits for your approval first.", off?.hint);
      check(T("while the calendar is not set up a line says so, with Set up the calendar"), off?.note === "The calendar is not set up yet, so the tools wait until it is.Set up the calendar", off?.note);
      await shot(`calendar-switch-${theme}-${width}`);
      await ev(`click(${sw})`);
      const on = await until(`(() => { const s = ${sec}; return ${sw}?.checked && s.textContent.includes("Saved") && window.pobotsState().bots.find((b) => b.id === "inbox").calendar === true ? s.getBoundingClientRect().height : null; })()`);
      check(T("switched on, it saves and says Saved"), typeof on === "number", on);
      check(T("the section keeps its height while it says Saved"), typeof on === "number" && Math.abs(on - off.h) < 1, { before: off?.h, on });
      await sleep(50);
      await ev(`click(${sw})`);
      check(T("and off again"), !!(await until(`window.pobotsState().bots.find((b) => b.id === "inbox").calendar === false || null`)));
      await houseRules(T("the bot's Calendar section"));

      check(T("Kaja, the main bot, has the tools on by default"), !!(await openBot("Kaja", "settings")) && (await until(`${sw}?.checked === true || null`)) === true);
      await ev(`${sec}?.scrollIntoView({ block: "center" })`);
      await ev(`click($$("button", ${sec}).find((b) => b.textContent === "Set up the calendar"))`);
      const first = await until(`(() => { const w = ${win}; const c = ${conn}; if (!w || !c) return null; return {
        tab: $('.pb-setwin-tab[aria-selected="true"]')?.dataset.section,
        state: c.querySelector("[data-calendar-state]")?.textContent, mark: c.querySelector("[data-calendar-state]")?.dataset.calendarState,
        label: c.querySelector("label")?.textContent, check: $$("button", c).some((b) => b.textContent === "Check the connection"),
      }; })()`);
      check(T("Set up the calendar opens the settings window on Calendar"), first?.tab === "calendar", first);
      check(T("it says the calendar is not set up yet, asks for the flow's address, and offers no check yet"), first?.state === "Not set up yet." && first.mark === "idle" && first.label === "The flow's address" && first.check === false, first);
      await shot(`calendar-settings-empty-${theme}-${width}`);

      // A wrong address is refused in the window, before the engine.
      await typeInto("#set-calendar-address", "ftp://flows.example.com/x");
      await ev(`click($$("button", ${conn}).find((b) => b.textContent === "Save"))`);
      check(T("an address that is not https is refused in plain words"), !!(await until(`${conn}.querySelector(".pb-set7-problem")?.textContent.trim() === "Use an address that starts with https://." || null`)));

      // A right one is saved, cleared from the field and never shown again; the mailbox shows.
      const secret = "https://flows.example.com/workflows/abc/triggers/manual/run?sig=calendar-secret-1";
      await typeInto("#set-calendar-address", secret);
      await ev(`click($$("button", ${conn}).find((b) => b.textContent === "Save"))`);
      const saved = await until(`(() => { const c = ${conn}; const s = c?.querySelector("[data-calendar-state]"); return s?.dataset.calendarState === "check" ? {
        state: s.textContent, field: $("#set-calendar-address").value, label: c.querySelector("label")?.textContent,
        buttons: $$(".pb-add-row button", c).map((b) => b.textContent), anywhere: document.documentElement.outerHTML.includes("calendar-secret-1"),
        checked: c.querySelector(".pb-set7-checked-text")?.textContent, hint: $("#set-calendar-address-hint")?.textContent,
      } : null; })()`);
      check(T("saved: Connected to Robin Example (robin@example.com)"), saved?.state === "Connected to Robin Example (robin@example.com).", saved);
      check(T("the field is empty again and the address is nowhere in the page"), saved?.field === "" && saved.anywhere === false, saved);
      check(T("then it offers Replace and Remove, and says the address is not shown again"), saved?.label === "Replace the flow's address with" && saved.buttons.join(",") === "Replace,Remove" && saved.hint?.startsWith("The address is set. It is not shown again."), saved);
      const checkedH = await ev(`${conn}.getBoundingClientRect().height`);
      await ev(`click($$("button", ${conn}).find((b) => b.textContent === "Check the connection"))`);
      check(T("Check the connection says when it was checked"), !!(await until(`${conn}.querySelector(".pb-set7-checked-text")?.textContent === "Checked just now." || null`)));
      check(T("checking does not change the section's height"), Math.abs((await ev(`${conn}.getBoundingClientRect().height`)) - checkedH) < 1);

      // The internal domains: from the mailbox, set by hand, refused when wrong, back to the mailbox's.
      const dom = `$("#set-calendar-domains")`;
      const domHint = `$("#set-calendar-domains-hint").textContent`;
      check(T("internal domains start from the mailbox's address"), (await until(`${dom}.value === "example.com" && ${domHint}.startsWith("From your mailbox's address.") || null`)) === true, await ev(`[${dom}.value, ${domHint}]`));
      await typeInto("#set-calendar-domains", "not a domain");
      await ev(`click($$("button", ${dom}.closest("form")).find((b) => b.textContent === "Save"))`);
      check(T("a word that is not a domain is refused"), !!(await until(`${dom}.closest("form").querySelector(".pb-set7-problem")?.textContent.includes("is not an email domain") || null`)));
      await typeInto("#set-calendar-domains", "example.com, example.org");
      await ev(`click($$("button", ${dom}.closest("form")).find((b) => b.textContent === "Save"))`);
      const setBy = await until(`window.pobotsCalendar.state().domainsSet && ${domHint}.startsWith("Set by you.") ? { value: ${dom}.value, list: window.pobotsCalendar.state().internalDomains.join(",") } : null`);
      check(T("two domains saved, said as set by you"), setBy?.list === "example.com,example.org" && setBy.value === "example.com, example.org", setBy);
      await ev(`click($$("button", ${dom}.closest("form")).find((b) => b.textContent === "Use the mailbox's"))`);
      check(T("Use the mailbox's goes back to the mailbox's domain"), !!(await until(`!window.pobotsCalendar.state().domainsSet && ${dom}.value === "example.com" || null`)));
      await houseRules(T("the settings window's Calendar section"));
      await ev(`${conn}.scrollIntoView({ block: "start" })`);
      await shot(`calendar-settings-${theme}-${width}`);

      // Remove asks first, then the calendar is not set up again.
      await ev(`click($$("button", ${conn}).find((b) => b.textContent === "Remove"))`);
      const ask = await until(`$(".pb-dialog-title")?.textContent === "Remove the calendar's address?" ? $(".pb-dialog-text")?.textContent : null`);
      check(T("Remove asks first and says nothing in the calendar changes"), ask === "Bots lose the calendar tools until an address is set again. Nothing in your calendar changes.", ask);
      await ev(`click($$(".pb-dialog button").find((b) => b.textContent === "Remove address"))`);
      check(T("removed: Not set up yet"), !!(await until(`${conn}?.querySelector("[data-calendar-state]")?.textContent === "Not set up yet." && !window.pobotsCalendar.state().connected || null`)));

      // ---------------- the meeting card and the lines
      await open("calendar=1", { width, height, theme });
      if (await isPhone()) {
        await ev(`click($(".app-needs-row"))`);
        await until(`$(".app-shell").dataset.phoneScreen === "needs"`);
      }
      const c0 = await until(`(() => { const c = ${card}; if (!c) return null; const m = c.querySelector(".pb-meet"); return {
        title: c.querySelector(".pb-card-title")?.textContent, caption: c.querySelector(".pb-draft-to")?.textContent,
        what: m.querySelector(".pb-meet-what")?.textContent, when: m.querySelector(".pb-meet-when")?.textContent,
        people: $$(".pb-meet-person", m).map((p) => [...p.children].map((x) => x.textContent).join("|")),
        lines: $$(".pb-meet-line", m).map((x) => x.textContent), clash: m.querySelector(".pb-meet-clash")?.textContent,
        text: m.querySelector(".pb-meet-text")?.textContent,
        buttons: $$(".pb-card-actions button", c).map((b) => b.textContent),
        wide: document.scrollingElement.scrollWidth - innerWidth, out: $$("*", c).filter((e) => e.getBoundingClientRect().right > c.getBoundingClientRect().right + 1).length,
      }; })()`);
      check(T("the card asks Book this meeting?, with the Calendar caption"), c0?.title === "Book this meeting?" && c0.caption === "Calendar", c0);
      check(T("it writes out the meeting and its time"), c0?.what === "Nordvik kickoff" && /^(Mon|Tue|Wed|Thu|Fri) \d{1,2} [A-Z][a-z]{2} 10:00 to 11:00$/.test(c0.when ?? ""), c0);
      check(T("who: inside and free, outside with the agreed time"), JSON.stringify(c0?.people) === JSON.stringify(["Alex Lund|alex@example.com|Internal, free then", "Kim Nordvik|kim@nordvik.example.net|External, the agreed time"]), c0?.people);
      check(T("the Teams link, the clash in the person's own calendar and the text"), c0?.lines.join("|") === "Teams meeting, a link is added" && c0.clash === "You have something else then: Lunch (12:00 to 13:00)" && c0.text === "TextKickoff for the Nordvik onboarding: scope, timeline and who does what.", c0);
      check(T("only Approve and Deny, never Always allow"), c0?.buttons.join(",") === "Approve,Deny", c0?.buttons);
      check(T("nothing in the card reaches past it or makes the page scroll sideways"), !!c0 && c0.wide <= 0 && c0.out === 0, c0);
      await houseRules(T("the meeting card"));
      await ev(`${card}.scrollIntoView({ block: "center" })`);
      await shot(`calendar-card-${theme}-${width}`);

      await ev(`click($$(".pb-card-actions button", ${card}).find((b) => b.textContent === "Approve"))`);
      check(T("Approve: the card leaves"), !!(await until(`!${card} || null`, 3000)));

      // A move: the new time and the old one. Deny: it leaves, and no line follows.
      const moveId = await ev(`window.pobotsCalendar.addMeetingCard("move")`);
      const mv = await until(`(() => { const c = ${card}; if (!c) return null; return { title: c.querySelector(".pb-card-title").textContent, when: c.querySelector(".pb-meet-when").textContent, was: c.querySelector(".pb-meet-was")?.textContent, lines: $$(".pb-meet-line", c).map((x) => x.textContent) }; })()`);
      check(T("a move says Move this meeting?, the new time and the old one"), mv?.title === "Move this meeting?" && /^To .* 13:00 to 13:30$/.test(mv.when) && /^Now .* 09:00 to 09:30$/.test(mv.was ?? "") && mv.lines.join("|") === "Teams meeting", mv);
      await shot(`calendar-move-${theme}-${width}`);
      await ev(`click($$(".pb-card-actions button", ${card}).find((b) => b.textContent === "Deny"))`);
      check(T("Deny: the card leaves"), !!(await until(`!${card} || null`, 3000)), moveId);

      // An answer to an invitation: who sent it and the message.
      await ev(`window.pobotsCalendar.addMeetingCard("respond")`);
      const rs = await until(`(() => { const c = ${card}; if (!c) return null; return { title: c.querySelector(".pb-card-title").textContent, lines: $$(".pb-meet-line", c).map((x) => x.textContent), text: c.querySelector(".pb-meet-text")?.textContent, people: $$(".pb-meet-person", c).length }; })()`);
      check(T("an answer says Accept this invitation?, who sent it and the message"), rs?.title === "Accept this invitation?" && rs.lines.join("|") === "From Sam Berg <sam@partner.example.org>|Teams meeting" && rs.text === "MessageThanks, see you there." && rs.people === 0, rs);
      await shot(`calendar-respond-${theme}-${width}`);
      await ev(`click($$(".pb-card-actions button", ${card}).find((b) => b.textContent === "Deny"))`);
      await until(`!${card} || null`, 3000);

      // Kaja's chat: the line of the approved meeting, the block it made before and the failed move.
      await openBot("Kaja", "chat");
      const made = await until(`(() => { const n = ${calLine("Created Nordvik kickoff (")}; if (!n) return null; const b = n.querySelector(".pb-notice-btn"); return { btn: b?.textContent, expanded: b?.getAttribute("aria-expanded") }; })()`);
      check(T("after Approve the chat says Created Nordvik kickoff (day and time), with a closed Show the details"), made?.btn === "Show the details" && made.expanded === "false", made);
      const block = `${calLine("Created Nordvik report (")}`;
      await ev(`${block}.scrollIntoView({ block: "center" })`);
      await sleep(100);
      const top0 = await ev(`${block}.getBoundingClientRect().top`);
      await ev(`click(${block}.querySelector(".pb-notice-btn"))`);
      const det = await until(`(() => { const n = ${block}; const w = n?.closest(".pb-notice-wrap")?.querySelector(".pb-notice-post"); return w ? { text: w.innerText, plain: w.hasAttribute("data-plain"), btn: n.querySelector(".pb-notice-btn").textContent, top: n.getBoundingClientRect().top, wide: document.scrollingElement.scrollWidth - innerWidth } : null; })()`);
      check(T("Show the details opens the meeting's lines, one per line, below the line"), det?.plain === true && det.text.split("\n").length >= 3 && det.text.includes("Teams meeting: a link is added.") && det.btn === "Hide the details", det);
      check(T("the line keeps its place when the details open"), !!det && Math.abs(det.top - top0) < 1, { top0, top: det?.top });
      check(T("open details never make the chat scroll sideways"), !!det && det.wide <= 0, det?.wide);
      await shot(`calendar-lines-${theme}-${width}`);
      await ev(`click(${block}.querySelector(".pb-notice-btn"))`);
      const failed = await until(`(() => { const n = ${calLine("Could not move Weekly sync")}; return n ? { tone: n.classList.contains("app-notice-error") ? "error" : "info", text: n.querySelector("span:not(.pb-mark)")?.textContent, btn: n.querySelector(".pb-notice-btn")?.textContent } : null; })()`);
      check(T("a failed move is said in the error tone with the next step, its details behind Show the details"), failed?.tone === "error" && failed.text === "Could not move Weekly sync: no answer in time. Check the calendar before trying again" && failed.btn === "Show the details", failed);
      await houseRules(T("Kaja's chat with calendar lines"));
    }
  }
}
