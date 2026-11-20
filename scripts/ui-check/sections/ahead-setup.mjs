// The window check, section "ahead-setup". Run it alone: node scripts/ui-check.mjs --only=ahead-setup
// Ahead needs the calendar (protocol 33, docs/build/step-ahead-setup.md): with Ahead on and no calendar,
// one calm line between the row above the days and the days, with "Ask the main bot" and "Calendar
// settings"; the empty state does not say it again. When the calendar is set up while the person looks,
// the line keeps its box and nothing under it moves; at the next visit it is gone. A calendar set up from
// the start shows no line. The setup turn in the main bot's chat follows Pobots' quiet line, without the
// "reported back" line. A Google calendar's words in Settings, Calendar. Laptop and both phone sizes,
// light and dark.
import { b, check, ev, houseRules, open, shot, until } from "../lib.mjs";

const q = JSON.stringify;
const WORDS = "Your calendar is not set up, so Ahead shows no meetings or free time. The main bot can set it up with you.";
const READY = "Your calendar is set up. Meetings and free time show on Ahead from now on.";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";

async function device(width) {
  const phone = width < 700;
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 1 : 0 });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: width === 390 ? IPHONE : width === 360 ? ANDROID : "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" });
  return phone;
}

async function toAhead(phone) {
  await until('!!$(".pb-shell")');
  if (phone) {
    for (let i = 0; i < 4 && (await ev('$("[data-phone-screen]")?.dataset.phoneScreen')) !== "bots"; i++) {
      await ev('click($(".app-main .app-phone-back, .app-phone-back"))');
      await until('$("[data-phone-screen]")?.dataset.phoneScreen === "bots"', 1500);
    }
  }
  await until('!!$("[data-ahead-roster]")');
  await ev('click($("[data-ahead-roster]"))');
  return until('$(".app-main")?.getAttribute("aria-label") === "Ahead" && !!$(".pb-ahead-content")');
}

/** The line and what is around it: its words, its actions, its box, and where the things under it stand. */
const LINE = `(() => {
  const l = $("[data-ahead-setup]");
  if (!l) return null;
  const r = l.getBoundingClientRect();
  const sum = $(".pb-ahead-sum")?.getBoundingClientRect();
  const under = l.nextElementSibling?.getBoundingClientRect();
  return {
    state: l.dataset.aheadSetup,
    text: l.querySelector(".pb-hint").textContent,
    actions: $$("[data-ahead-setup-action]", l).filter((x) => x.checkVisibility()).map((x) => x.textContent.trim()),
    top: Math.round(r.top), height: Math.round(r.height),
    belowRow: !sum || r.top >= sum.bottom - 1,
    underTop: under ? Math.round(under.top) : null,
    inside: r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
  };
})()`;

export default async function section() {
  const M = (n) => `ahead-setup: ${n}`;
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    const phone = await device(width);
    for (const theme of ["light", "dark"]) {
      const T = (n) => M(`${width} ${theme}: ${n}`);
      // Ahead on, no calendar.
      await open("ahead=on", { width, height, theme });
      check(T("Ahead opens"), !!(await toAhead(phone)));
      const line = await until(LINE);
      check(T("one line with the words"), line?.text === WORDS && line.state === "not-set", line);
      check(T("its two actions"), q(line?.actions) === q(["Ask the main bot", "Calendar settings"]), line);
      check(T("it stands under the row above the days, inside the page"), !!line?.belowRow && !!line.inside, line);
      check(T("the empty state does not say it again"), await ev('!$$(".pb-ahead-content .pb-hint").some((h) => !h.closest("[data-ahead-setup]") && /calendar/.test(h.textContent))'));
      check(T("one line only"), await ev('$$("[data-ahead-setup]").length === 1'));
      await houseRules(T("the line"));
      await shot(`ahead-setup-line-${width}-${theme}`);

      // Set up while the person looks: the box stays, nothing under it moves, the actions go.
      await ev("(window.pobotsCalendar.connect(), true)");
      const ready = await until(`(() => { const l = ${LINE}; return l && l.state === "ready" ? l : null; })()`);
      check(T("set up while looking: it says so in the same place"), ready?.text === READY && ready.top === line?.top, { line, ready });
      check(T("its box keeps its height and nothing under it moves"), ready?.height === line?.height && ready?.underTop === line?.underTop, { line, ready });
      check(T("no actions once set up"), q(ready?.actions) === "[]", ready);
      await shot(`ahead-setup-ready-${width}-${theme}`);
    }

    // The next visit with the calendar set up: no line.
    await open("ahead=on&calendar=set", { width, height, theme: "light" });
    await toAhead(phone);
    check(M(`${width}: with the calendar set up there is no line`), await ev('!$("[data-ahead-setup]")'));

    // A calendar whose check failed: the line says so.
    await open("ahead=on&calendar=fail", { width, height, theme: "light" });
    await toAhead(phone);
    const fail = await until(LINE);
    check(M(`${width}: a calendar with a problem says so`), fail?.state === "problem" && /has a problem/.test(fail.text) && fail.actions.length === 2, fail);

    // The actions: the main bot's chat, and Settings, Calendar.
    await open("ahead=on", { width, height, theme: "light" });
    await toAhead(phone);
    await until(LINE);
    await ev('click($("[data-ahead-setup-action=bot]"))');
    // Kaja is the main bot of the stand-in's scene (ui/engine/mock-scenes.ts).
    const chat = await until('(() => { const m = $(".app-main"); return m && m.getAttribute("aria-label") !== "Ahead" && !!$(".pb-composer textarea") ? m.getAttribute("aria-label") : null; })()');
    check(M(`${width}: "Ask the main bot" opens the main bot's chat`), chat === "Kaja", chat);
    await open("ahead=on", { width, height, theme: "light" });
    await toAhead(phone);
    await until(LINE);
    await ev('click($("[data-ahead-setup-action=settings]"))');
    check(M(`${width}: "Calendar settings" opens Settings, Calendar`), !!(await until('!!$(".pb-calendar") && $(".pb-calendar").checkVisibility()')));
  }

  // The setup turn in the main bot's chat: Pobots' quiet line says why it starts, and the turn has no
  // "reported back" line.
  await device(1280);
  for (const theme of ["light", "dark"]) {
    await open("ahead=on", { width: 1280, height: 820, theme });
    await toAhead(false);
    await until(LINE);
    await ev('click($("[data-ahead-setup-action=bot]"))');
    await until('$(".app-main")?.getAttribute("aria-label") === "Kaja" && !!$(".pb-thread")');
    await ev("(window.pobotsCalendar.setupTurn(), true)");
    const turn = await until(`(() => {
      const kids = [...$(".app-main .pb-thread").children];
      const i = kids.findIndex((k) => k.textContent.includes("You switched on Ahead. Your calendar is not set up yet, so the setup starts here."));
      const a = kids[i + 1];
      if (i < 0 || !a?.matches(".pb-answer") || !a.textContent.includes("Ahead needs your calendar")) return null;
      return { woke: a.querySelector(".pb-woke")?.textContent ?? null, head: !!a.querySelector(".pb-msg-head") };
    })()`);
    check(M(`${theme}: the setup turn follows Pobots' line, with its face and no "reported back" line`), !!turn && turn.woke === null && turn.head, turn);
    await shot(`ahead-setup-turn-${theme}`);
  }

  // Settings, Calendar with a Google script: the words follow the calendar.
  await open("calendar=google", { width: 1280, height: 820, theme: "light" });
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="calendar"]\'))');
  const google = await until('$(".pb-calendar")?.textContent ?? null');
  check(M("Settings, Calendar with a Google script says Google Calendar and the script"), /your Google Calendar through a script in your Google account/.test(google ?? "") && /guide for setting up the script/.test(google ?? "") && !/Power Automate/.test(google ?? ""), google?.slice(0, 300));
  await shot("ahead-setup-google-settings");
  await open("calendar=set", { width: 1280, height: 820, theme: "light" });
  await ev('click($(".pb-foot-icon[aria-label=\'Pobots settings\'], .pb-foot-icon"))');
  await ev('click($(\'.pb-setwin-tab[data-section="calendar"]\'))');
  const outlook = await until('$(".pb-calendar")?.textContent ?? null');
  check(M("Settings, Calendar with Outlook keeps its words"), /Bots with the calendar tools use your Outlook calendar through a flow in your Power Automate\. The main bot/.test(outlook ?? ""), outlook?.slice(0, 300));
}
