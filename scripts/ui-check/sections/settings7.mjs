// The window check, section "settings7". Run it alone: node scripts/ui-check.mjs --only=settings7
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ---------------- step 7b (14 Nov 2026): the icon row, the settings window (General, Chats,
// Providers, Usage), the update button, usage meters, a bot's own steer or queue, earlier chats
export default async function section() {
  settings7Step: {
  const Z = (name) => `settings 7b: ${name}`;
  const zShots = arg("settings7-shots") ?? (shots ? join(shots, "settings7") : undefined);
  if (zShots) mkdirSync(zShots, { recursive: true });
  async function zShot(name) {
    if (!zShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(zShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const footBoxes = `["${".pb-foot-settings"}", ".pb-foot-usage", ".pb-foot-update"].map((s) => { const r = $(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(":"); }).join(",")`;
  const winBox = `(() => { const r = $(".pb-setwin").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(":"); })()`;
  const section = (id) => `click($('.pb-setwin-tab[data-section="${id}"]'))`;
  const mock = (expr) => ev(`window.pobotsMock.${expr}`);

  for (const theme of ["dark", "light"]) {
    const T = (name) => Z(`${theme}: ${name}`);
    // The icon row.
    await open("", { theme });
    const row = await ev(`(() => { const r = $(".pb-foot-icons"); const foot = $(".app-side-foot"); return { last: foot.lastElementChild.contains(r), icons: $$(".pb-foot-icons button").map((x) => x.getAttribute("aria-label")), update: !!$(".pb-foot-update[data-show]"), old: !!$(".pb-settings-line") }; })()`);
    check(T("the icon row is the very foot of the roster: settings, usage, and the update arrow while Codex has an update"), row?.last && row.icons?.join("|") === "Settings|Usage|Update Codex" && row.update && !row.old, row);
    const withUpdate = await ev(footBoxes);
    await open("update=none", { theme });
    const without = await ev(footBoxes);
    const hidden = await ev(`({ shown: !!$(".pb-foot-update[data-show]"), vis: getComputedStyle($(".pb-foot-update")).visibility, tab: $(".pb-foot-update").tabIndex })`);
    check(T("without an update the arrow is not there, and nothing else in the row moves when it comes"), withUpdate === without && !hidden?.shown && hidden.vis === "hidden" && hidden.tab === -1, { withUpdate, without, hidden });
    await zShot(`01-foot-${theme}`);

    // The window: General first, the sections on the left, one size whatever the section.
    await open("", { theme });
    await ev(`click($(".pb-foot-settings"))`);
    await until(`!!$(".pb-setwin")`);
    await sleep(250);
    const win = await ev(`({ tabs: $$(".pb-setwin-tab").map((t) => t.textContent + (t.getAttribute("aria-selected") === "true" ? "*" : "")), title: $(".pb-appsettings-title").textContent, focus: document.activeElement?.textContent, parts: $$(".pb-appsettings-section").map((s) => s.dataset.section).join(",") })`);
    check(T("the settings window opens on General, the six sections listed on the left, its title in focus"), win?.tabs?.join(",") === "General*,Chats,Providers,Calendar,Usage,Activity" && win.title === "Settings" && win.focus === "Settings" && win.parts === "notify,chat,backup", win);
    const box0 = await ev(winBox);
    const boxes = [];
    for (const id of ["chats", "providers", "calendar", "usage", "general"]) {
      await ev(section(id));
      await sleep(250);
      boxes.push(await ev(winBox));
      await houseRules(T(`the ${id} section`));
    }
    check(T("changing sections never changes the window's size or place"), boxes.every((x) => x === box0), { box0, boxes });
    await ev(`$('.pb-setwin-tab[data-section="general"]').focus()`);
    await key("ArrowDown");
    check(T("the arrow keys move between the sections"), !!(await until(`$('.pb-setwin-tab[aria-selected="true"]')?.dataset.section === "chats" && document.activeElement?.dataset.section === "chats"`)));

    // Chats: a value per provider, with its default and Reset; a refusal keeps its room.
    await ev(section("chats"));
    await until(`!!$("#set7-claude-minTokens")`);
    const minRow = `$('.pb-set7-row[data-key="minTokens"]')`;
    const c0 = await ev(`({ value: $("#set7-claude-minTokens").value, def: ${minRow}.querySelector(".pb-set7-default").textContent, reset: getComputedStyle(${minRow}.querySelector(".pb-set7-reset-btn")).visibility })`);
    check(T("Chats: each value with its default, and Reset while it is set apart"), c0?.value === "150000" && c0.def === "Default: 100,000 tokens" && c0.reset === "visible", c0);
    const rowsBefore = await ev(`$$(".pb-set7-row").map((r) => Math.round(r.getBoundingClientRect().top)).join(",")`);
    await ev(`(() => { const i = $("#set7-claude-fullTokens"); i.focus(); i.select(); return true; })()`);
    await type("5");
    await key("Enter");
    const refused = await until(`$('.pb-set7-row[data-key="fullTokens"] .pb-set7-problem')?.textContent.includes("1,000") ? $('.pb-set7-row[data-key="fullTokens"] .pb-set7-problem').textContent : null`);
    const rowsAfter = await ev(`$$(".pb-set7-row").map((r) => Math.round(r.getBoundingClientRect().top)).join(",")`);
    check(T("Chats: a value out of range is refused in plain words, the field goes back, nothing moves"), !!refused && rowsAfter === rowsBefore && (await ev(`$("#set7-claude-fullTokens").value`)) === "300000", { refused, rowsBefore, rowsAfter });
    await ev(`click(${minRow}.querySelector(".pb-set7-reset-btn"))`);
    const reset = await until(`(() => { const s = window.pobotsMock.settingsState(); return s.timing.claude.minTokens === 100000 && !s.timingSet.claude.includes("minTokens") && $("#set7-claude-minTokens").value === "100000" ? true : null; })()`);
    check(T("Chats: Reset puts the default back"), !!reset);
    await ev(`(() => { const i = $("#set7-claude-coldHours"); i.focus(); i.select(); return true; })()`);
    await type("6");
    await ev(`$("#set7-claude-coldHours").blur()`);
    check(T("Chats: a new value saves when the field is left, and says Saved"), !!(await until(`window.pobotsMock.settingsState().timing.claude.coldHours === 6 && !!$('.pb-set7-row[data-key="coldHours"] .pb-saved[data-show]')`)));
    // The size at which Claude Code or Codex itself summarises a conversation in the middle of work
    // (14 Nov 2026): its own row under the fresh-start values, never dimmed with them, per provider.
    const longRow = await ev(`(() => { const r = $('.pb-set7-row[data-key="compactTokens"]'); return r && { label: r.querySelector(".pb-set7-row-label").textContent, hint: r.querySelector(".pb-set7-row-hint").textContent, value: $("#set7-claude-compactTokens").value, def: r.querySelector(".pb-set7-default").textContent, own: !!r.closest("[data-long-work]"), dimmed: !!r.closest(".pb-set7-rows[data-off]") }; })()`);
    check(T("Chats: the size at which work is shortened has its own row, 500,000 tokens for Claude unless set, and says whose summarising it is"), longRow?.label === "Shortened in the middle of work at" && longRow.value === "500000" && longRow.def === "Default: 500,000 tokens (in use)" && longRow.own === true && longRow.dimmed === false && /Claude Code or Codex itself/.test(longRow.hint), longRow);
    await ev(`(() => { const i = $("#set7-claude-compactTokens"); i.focus(); i.select(); return true; })()`);
    await type("50000");
    await key("Enter");
    const longRefused = await until(`$('.pb-set7-row[data-key="compactTokens"] .pb-set7-problem')?.textContent.includes("150,000") ? $('.pb-set7-row[data-key="compactTokens"] .pb-set7-problem').textContent : null`);
    check(T("Chats: a size the programs do not take is refused in plain words, and the field goes back"), !!longRefused && (await ev(`$("#set7-claude-compactTokens").value`)) === "500000", { longRefused });
    await ev(`(() => { const i = $("#set7-claude-compactTokens"); i.focus(); i.select(); return true; })()`);
    await type("600000");
    await ev(`$("#set7-claude-compactTokens").blur()`);
    check(T("Chats: a new size saves for Claude bots only"), !!(await until(`(() => { const t = window.pobotsMock.settingsState().timing; return t.claude.compactTokens === 600000 && t.codex.compactTokens === 300000; })()`)));
    await ev(`click($('.pb-set7-which [data-provider="codex"]'))`);
    const codexTab = await until(`$("#set7-codex-warmMarginMinutes") ? { disabled: $("#set7-codex-warmMarginMinutes").disabled, hint: $('.pb-set7-row[data-key="warmMarginMinutes"] .pb-set7-row-hint').textContent } : null`);
    check(T("Chats: for Codex bots the cache value is off, and says why"), codexTab?.disabled && /Codex does not say how long its cache lives/.test(codexTab.hint), codexTab);
    await ev(`(() => { const s = $("#set7-title-model"); s.value = "claude-sonnet-5-5"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    check(T("Chats: the model that names chats is chosen from the Claude models"), !!(await until(`window.pobotsMock.settingsState().titleModel === "claude-sonnet-5-5"`)) && !(await ev(`$$("#set7-title-model option").some((o) => o.value.startsWith("gpt"))`)));
    await zShot(`02-chats-${theme}`);

    // Providers.
    await ev(section("providers"));
    await until(`$$(".pb-set7-provider").length === 2`);
    const prov = await ev(`$$(".pb-set7-provider").map((p) => ({ id: p.dataset.provider, facts: p.querySelector(".pb-set7-provider-facts").textContent, latest: p.querySelector(".pb-set7-provider-latest").textContent, update: getComputedStyle(p.querySelector(".pb-set7-update")).visibility }))`);
    check(T("Providers: Claude Code and Codex with version, sign-in and how installed; Update only where there is an update"), prov?.[0]?.facts === "Version 2.1.325 · Signed in · Installed with its own installer" && prov[0].latest === "Up to date." && prov[0].update === "hidden" && prov[1].latest === "Version 0.169.0 is out." && prov[1].update === "visible", prov);
    await ev(`click($('.pb-set7-provider[data-provider="claude"] .pb-switch'))`);
    const off = await until(`$('.pb-set7-provider[data-provider="claude"] .pb-set7-problem')?.textContent.includes("cannot be switched off") ? { text: $('.pb-set7-provider[data-provider="claude"] .pb-set7-problem').textContent, on: window.pobotsMock.settingsState().providers.claude.enabled } : null`);
    check(T("Providers: a provider bots run on cannot be switched off, and it says which bots"), off?.on === true && /Kaja/.test(off.text), off);
    await ev(`click($(".pb-set7-check"))`);
    check(T("Providers: Check now looks again and says when"), !!(await until(`$(".pb-set7-checked-text").textContent === "Looking now."`, 1500)) && !!(await until(`$(".pb-set7-checked-text").textContent === "Checked just now."`, 3000)));
    // Usage hubs: the key is never shown again.
    const KEY = "zz-hub-key-not-real-1234567890";
    await ev(`$("#set7-hub-url").focus()`);
    await type("https://hub.example.net:8443/management.html");
    await ev(`$("#set7-hub-key").focus()`);
    await type(KEY);
    check(T("Usage hubs: the key field hides what is typed"), (await ev(`$("#set7-hub-key").type`)) === "password");
    await ev(`click($(".pb-set7-hub-add"))`);
    // The field is emptied a moment after the hub's row appears: wait for both (a field never emptied still fails).
    const hub = await until(`$(".pb-set7-hub-url")?.textContent && $("#set7-hub-key").value === "" ? { url: $(".pb-set7-hub-url").textContent, key: $("#set7-hub-key").value, kept: window.pobotsMock.hubKeysKept(), state: JSON.stringify(window.pobotsMock.settingsState()) } : null`);
    check(T("Usage hubs: added by its address (the panel's page taken off), the key emptied from the field and kept only by the engine"), hub?.url === "https://hub.example.net:8443" && hub.key === "" && hub.kept === 1 && !hub.state.includes(KEY), hub);
    check(T("Usage hubs: the key is nowhere in the window"), !(await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(KEY)})`)));
    await zShot(`03-providers-${theme}`);
    await ev(`click($(".pb-set7-hub-remove"))`);
    check(T("Usage hubs: Remove takes it away"), !!(await until(`!$(".pb-set7-hub-url") && window.pobotsMock.hubKeysKept() === 0`)));
    // Escape in a field belongs to the field; from the window's title it closes the window.
    await ev(`$(".pb-appsettings-title").focus()`);
    await key("Escape");
    check(T("Escape closes the window and gives the focus back to the gear"), !!(await until(`!$(".pb-setwin") && document.activeElement?.classList.contains("pb-foot-settings")`)));

    // Usage: the bars open the window on Usage; one account, then several.
    await open("usage=several", { theme });
    await ev(`click($(".pb-foot-usage"))`);
    const usage = await until(`$$(".pb-set7-meter").length >= 6 ? { current: $(".pb-foot-usage").getAttribute("aria-current"), section: $('.pb-setwin-tab[aria-selected="true"]').dataset.section, groups: $$(".pb-set7-meter-title").map((x) => x.textContent), first: $(".pb-set7-meter").querySelector(".pb-set7-meter-pct").textContent, bars: $(".pb-set7-meter").querySelectorAll(".pb-set7-bar").length, chips: $$(".pb-set7-chip").length, label: $(".pb-set7-bar").getAttribute("aria-label"), fable: $$(".pb-set7-meter-label").map((x) => x.textContent).includes("Weekly · Fable"), spend: $$(".pb-set7-meter-label").map((x) => x.textContent).includes("Monthly spend") } : null`, 5000);
    check(T("Usage: the bars open the window on Usage"), usage?.current === "page" && usage.section === "usage", usage);
    check(T("Usage: per provider and window the % left in big, a bar per account with its two letters, the reset time"), usage?.groups?.join(",") === "Claude,Codex" && usage.first === "100%" && usage.bars === 2 && usage.chips > 0 && /^kaja\.lind@example\.com: 100% left, resets in 3 h \d+ min$/.test(usage.label) && usage.fable && usage.spend, usage);
    const low = await ev(`({ low: $$(".pb-set7-bar[data-low]").length })`);
    check(T("Usage: a bar with little left is told apart"), low?.low >= 1, low);
    await zShot(`04-usage-several-${theme}`);
    await houseRules(T("the usage section, several accounts"));
    const meters0 = await ev(`$$(".pb-set7-meter").map((m) => Math.round(m.getBoundingClientRect().top)).join(",")`);
    await mock(`usageNext("several")`);
    await ev(`click($(".pb-set7-refresh"))`);
    await until(`$(".pb-set7-usage")?.dataset.reading === "true"`, 1500);
    const meters1 = await ev(`$$(".pb-set7-meter").map((m) => Math.round(m.getBoundingClientRect().top)).join(",")`);
    await until(`!$(".pb-set7-usage")?.dataset.reading`, 3000);
    check(T("Usage: Refresh reads again with the meters in place"), meters0 === meters1, { meters0, meters1 });
    await open("", { theme });
    await ev(`click($(".pb-foot-usage"))`);
    const one = await until(`$$(".pb-set7-meter").length >= 4 && !$(".pb-set7-usage").dataset.reading ? { bars: $(".pb-set7-meter").querySelectorAll(".pb-set7-bar").length, chips: $$(".pb-set7-chip").length, source: $(".pb-set7-checked-text").textContent } : null`, 5000);
    check(T("Usage: with one account each there is one bar per window, no letters, and it says where the reading came from"), one?.bars === 1 && one.chips === 0 && /^From Claude Code and Codex on this Mac\./.test(one.source), one);
    await zShot(`05-usage-one-${theme}`);
    await key("Escape");

    // The update arrow: what is updated, waiting for a bot, the result; then the arrow leaves.
    await mock(`updateHold(["Inbox"])`);
    await ev(`click($(".pb-foot-update"))`);
    const ask = await until(`$(".pb-dialog") ? { title: $(".pb-dialog-title").textContent, text: $(".pb-set7-update-text").textContent } : null`);
    check(T("Update: the arrow asks first, says what goes from which version to which, and that the bots are restarted, not Pobots"), ask?.title === "Update Codex?" && /Codex 0\.165\.0 to 0\.169\.0/.test(ask.text) && /Pobots itself keeps running/.test(ask.text), ask);
    await zShot(`06-update-ask-${theme}`);
    await ev(`click($(".pb-set7-update-go"))`);
    check(T("Update: it waits for a bot that works, and says so"), !!(await until(`$(".pb-set7-update-line")?.textContent === "Waiting for Inbox to finish."`, 2000)));
    await zShot(`07-update-waiting-${theme}`);
    await mock(`updateHold([])`);
    const done = await until(`$(".pb-dialog-title")?.textContent === "Update done" ? { line: $(".pb-set7-update-line").textContent, arrow: !!$(".pb-foot-update[data-show]") } : null`, 6000);
    check(T("Update: the result in plain words, and the arrow is gone"), done?.line === "Codex updated from 0.165.0 to 0.169.0." && !done.arrow, done);
    await zShot(`08-update-done-${theme}`);
    await key("Escape");
    await mock(`updateHold(null)`);

    // A bot's own steer or queue, in its Settings tab.
    await goTo("Inbox", "settings");
    const fu = await until(`$(".pb-bot-followup") ? $$(".pb-bot-followup .pb-choice").map((c) => c.querySelector(".pb-choice-label").textContent + (c.getAttribute("aria-checked") === "true" ? "*" : "")) : null`);
    check(T("a bot's Settings: When Inbox is working, the Pobots default named with what it is, then Steer and Queue"), fu?.join(",") === "Pobots default (Steer)*,Steer,Queue", fu);
    await ev(`click($('.pb-bot-followup [data-follow="queue"]'))`);
    check(T("a bot's Settings: choosing Queue saves it for that bot"), !!(await until(`$('.pb-bot-followup [data-follow="queue"]').getAttribute("aria-checked") === "true" && !!$(".pb-bot-followup .pb-saved[data-show]")`)));
    await ev(`click($('.pb-bot-followup [data-follow="default"]'))`);
    check(T("a bot's Settings: back to the Pobots default"), !!(await until(`$('.pb-bot-followup [data-follow="default"]').getAttribute("aria-checked") === "true"`)));
    await houseRules(T("a bot's Settings"));

    // Earlier chats in the History tab.
    await goTo("Kaja", "history");
    const hist = await until(`$$(".pb-chat-title").length ? { rows: $$(".pb-chat-title").map((r) => r.querySelector(".pb-chat-title-kind").textContent + ":" + r.querySelector(".pb-chat-title-text").textContent), heads: $$(".pb-history-title").map((h) => h.textContent) } : null`);
    check(T("History: earlier chats by title, newest first, above the changes to the folder"), hist?.heads?.join(",") === "Earlier chats,Changes to the folder" && hist.rows[0] === "Chat:Customer survey launch for Acme" && hist.rows.length === 5, hist);
    await mock(`titleChat("kaja", { threadId: "kaja-main", kind: "main", fromSeq: 200, title: "Moving the 15:00 prep", startedAt: new Date().toISOString() })`);
    check(T("History: a chat that gets its title shows at the top at once"), !!(await until(`$(".pb-chat-title .pb-chat-title-text")?.textContent === "Moving the 15:00 prep"`)));
    await zShot(`09-history-${theme}`);
    await houseRules(T("the History tab"));
  }

  // Keyboard: the gear and the bars are reached by Tab with rings, Enter opens.
  await open("");
  await ev(`click($(".pb-foot-settings"))`);
  await until(`!!$(".pb-setwin")`);
  await ev(section("providers"));
  await ev(`$(".pb-appsettings-title").focus()`);
  await focusRings(Z("the providers section"), 10);
  await ev(`$(".pb-appsettings-title").focus()`);
  let inside = true;
  for (let i = 0; i < 40; i++) {
    await key("Tab");
    if (!(await ev(`!!document.activeElement?.closest(".pb-setwin")`))) inside = false;
  }
  check(Z("Tab stays inside the window"), inside);
  await key("Escape");

  // At 800 px the row stands as a column in the roster of faces, inside it.
  await open("", { width: 800 });
  const r800 = await ev(`(() => { const side = $(".app-side").getBoundingClientRect(); return $$(".pb-foot-icons button").every((b) => { const r = b.getBoundingClientRect(); return r.left >= side.left && r.right <= side.right; }); })()`);
  check(Z("800 px: the icons stand inside the narrow roster"), r800 === true);
  await ev(`click($(".pb-foot-settings"))`);
  await until(`!!$(".pb-setwin")`);
  await houseRules(Z("800 px: the window"));

  // The phone: the row at the foot of Bots, each 44 px; the window is a full-screen sheet with the sections as tabs.
  for (const [w, h, ua] of [[390, 844, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"], [360, 780, "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"]]) {
    const P = (name) => Z(`phone ${w}: ${name}`);
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: ua });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1` });
    await until(`!!document.querySelector(".pb-shell[data-phone]")`, 6000);
    await sleep(300);
    await ev(`$(".app-side").scrollTop = 99999`);
    const icons = await ev(`$$(".app-side .pb-foot-icons button").map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), r.top >= 0 && r.bottom <= innerHeight]; })`);
    check(P("the icon row stands in a row at the foot of Bots, each 44 px to tap"), Array.isArray(icons) && icons.length === 3 && icons.every(([a, c, inView]) => a >= 44 && c >= 44 && inView), icons);
    await ev(`click($(".app-side .pb-foot-settings"))`);
    await until(`$(".app-shell").dataset.phoneSheet === "settings"`);
    await sleep(300);
    for (const id of ["general", "chats", "providers", "usage"]) {
      await ev(section(id));
      await sleep(700);
      const fit = await ev(`(() => { const tabs = $$(".pb-setwin-tab").map((t) => Math.round(t.getBoundingClientRect().height)); const wide = $$(".app-appsettings *").filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".pb-setwin-nav") && e.checkVisibility()).map((e) => e.className).slice(0, 3); return { tabs, wide, page: document.scrollingElement.scrollWidth - innerWidth, inputs: $$(".app-appsettings input.pb-input").every((i) => parseFloat(getComputedStyle(i).fontSize) >= 16) }; })()`);
      check(P(`${id}: a full-screen sheet, tabs 44 px, nothing wider than the screen, fields at 16 px`), fit?.tabs?.every((x) => x >= 44) && fit.wide.length === 0 && fit.page <= 0 && fit.inputs, fit);
      await houseRules(P(`the ${id} section`));
      await zShot(`10-phone-${w}-${id}`);
    }
  }
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&settings7-done=1` });
  await until(`!!document.querySelector(".pb-shell")`, 6000);
  if (zShots) console.log(`Settings 7b pictures in ${zShots}`);
  }
}
