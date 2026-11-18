// The window check, section "sees". Run it alone: node scripts/ui-check.mjs --only=sees
// What a bot sees (docs/sees.md): the part "What Kaja sees" in a Claude bot's settings, against the
// mock's made-up inventory (ui/engine/mock-sees.ts). &sees=fail|slow in the mock.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, shots, page, sleep, b, check, ev, until, open, key, goTo, houseRules, focusRings } from "../lib.mjs";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export default async function section() {
  const S = (name) => `sees: ${name}`;
  const sShots = arg("sees-shots") ?? (shots ? join(shots, "sees") : undefined);
  if (sShots) mkdirSync(sShots, { recursive: true });
  async function sShot(name) {
    if (!sShots) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(sShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const part = `$(".app-sees")`;
  const summary = `$(".app-sees [data-sees-summary]").textContent`;
  const status = `$(".app-sees [data-sees-status]")?.textContent`;
  const row = (name) => `$('.app-sees [data-sees-row=${JSON.stringify(JSON.stringify(name)).slice(1, -1)}]')`;
  const pressed = (name, group) => `(() => { const r = $('.app-sees [data-sees-group="${group}"] [data-sees-row=${JSON.stringify(JSON.stringify(name)).slice(1, -1)}]'); return r && $$("button", r).find((x) => x.getAttribute("aria-pressed") === "true")?.textContent; })()`;
  const pick = (name, group, word) => `click($$("button", $('.app-sees [data-sees-group="${group}"] [data-sees-row=${JSON.stringify(JSON.stringify(name)).slice(1, -1)}]')).find((x) => x.textContent === "${word}"))`;
  const choose = `click(btn("Choose", $(".app-sees")))`;
  const scrollTo = `inPanel($(".app-sees"))`;
  const top = (sel) => `Math.round(${sel}.getBoundingClientRect().top)`;

  for (const theme of ["dark", "light"]) {
    const T = (n) => S(`${theme}: ${n}`);
    await open("", { theme });
    await goTo("Kaja", "settings");
    const closed = await until(`${part} && { title: $(".app-sees .pb-section-title").textContent, summary: ${summary}, hint: $$(".app-sees .pb-hint").map((h) => h.textContent).join("|"), body: !!$(".app-sees-body"), reads: window.pobotsSees.reads(), last: !!$(".app-sees + .pb-section-last") }`);
    check(T("a Claude bot's settings have the part, closed, saying it sees everything; nothing is read for a bot without a choice"),
      closed?.title === "What Kaja sees" && closed.summary === "Sees everything" && closed.hint.includes("A change holds from Kaja's next message.") && !closed.body && closed.reads === 0 && closed.last, closed);
    // The part above fills in when its own list comes; measure after that.
    await until(`$$(".pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Always allowed")?.querySelector(".pb-rules, .pb-section-text")`);
    await sleep(200);
    const before = await ev(`(${scrollTo}, { head: ${top(`$(".app-sees .pb-section-title")`)}, line: ${top(`$(".app-sees-summary")`)} })`);

    // Opening reads, holds the space while it reads, and fills in place.
    await ev(choose);
    const reading = await until(`$(".app-sees-body") && { status: ${status}, h: Math.round($(".app-sees-body").getBoundingClientRect().height), expanded: btn("Close", $(".app-sees"))?.getAttribute("aria-expanded"), head: ${top(`$(".app-sees .pb-section-title")`)}, scroll: $(".app-settings").scrollTop }`, 1500);
    check(T("Choose opens it and says quietly that it reads, in a body that holds its space"), reading?.status === "Reading what this Mac has." && reading.h >= 320 && reading.expanded === "true", reading);
    const filled = await until(`$$(".app-sees-row").length > 10 && { status: ${status}, head: ${top(`$(".app-sees .pb-section-title")`)}, line: ${top(`$(".app-sees-summary")`)}, statusTop: ${top(`$(".app-sees-status")`)}, scroll: $(".app-settings").scrollTop }`, 4000);
    check(T("when the read comes back nothing above it moved"), filled?.status === "Read just now" && filled.head === before?.head && filled.line === before.line, { before, reading, filled });
    const groups = await ev(`({
      groups: $$(".app-sees-group-title").map((h) => h.textContent),
      sets: $$('.app-sees [role="radio"]').map((r) => r.querySelector(".pb-choice-label").textContent + (r.getAttribute("aria-checked") === "true" ? "*" : "")),
      services: $$('.app-sees [data-sees-group="services"] .app-sees-row').map((r) => r.dataset.seesRow),
      fold: $(".app-sees-fold")?.textContent,
      notion: $('.app-sees [data-sees-row="claude.ai Notion"] .app-sees-hint')?.textContent,
      skill: $('.app-sees [data-sees-group="skills"] [data-sees-row="docs"] .app-sees-hint')?.textContent,
      skillWords: $$('.app-sees [data-sees-group="skills"] [data-sees-row="docs"] button').map((x) => x.textContent),
      rest: $('.app-sees [data-sees-group="services"] [data-sees-row="rest"] .app-sees-hint')?.textContent,
    })`);
    check(T("the two sets, Everything chosen; three groups, each with the rest as its own row"),
      JSON.stringify(groups?.sets) === JSON.stringify(["Everything*", "Coding"]) && JSON.stringify(groups.groups) === JSON.stringify(["Connected services", "Plugins", "Skills"]) && groups.services[0] === "rest" && /added later|connect later/.test(groups.rest), groups);
    check(T("connected services with where they come from, their tools and tokens; the rest folded into one line"),
      groups?.services.length === 12 && groups.fold === "19 not connected, they cost nothing" && groups.notion === "claude.ai · 77 tools · about 2,100 tokens", groups);
    check(T("a skill says where it comes from and its tokens in full, with In full and Name only"), groups?.skill === "claude.ai · about 340 tokens in full" && JSON.stringify(groups.skillWords) === JSON.stringify(["In full", "Name only"]), groups);
    await ev(`click($(".app-sees-fold"))`);
    const unfolded = await until(`$('.app-sees [data-sees-row="claude.ai Gmail"]') && { hint: $('.app-sees [data-sees-row="claude.ai Gmail"] .app-sees-hint').textContent, open: $(".app-sees-fold").getAttribute("aria-expanded") }`);
    check(T("the folded line opens to show the services that are not connected"), unfolded?.hint === "claude.ai · Not signed in" && unfolded.open === "true", unfolded);
    if (theme === "dark") {
      await houseRules(T("the part, open"));
      await ev(`(btn("Close", $(".app-sees")).focus(), true)`);
      await focusRings(T("the part, open"), 10);
    }
    await sShot(`01-open-${theme}`);

    // The Coding set.
    await ev(`click($('.app-sees [data-sees-set="coding"]'))`);
    const coding = await until(`$('.app-sees [data-sees-set="coding"]').getAttribute("aria-checked") === "true" && !!$(".app-sees .pb-saved[data-show]") && { summary: ${summary} }`, 3000);
    check(T("Coding is picked and saved, and the line names the set and says what it leaves out and saves"),
      /^Coding set: 10 services off · 3 plugins off · 10 skills by name only · saves about [\d,]+ tokens on every step$/.test(coding?.summary ?? ""), coding);
    const rows = await ev(`({ notion: ${pressed("claude.ai Notion", "services")}, onepass: ${pressed("plugin:1password:1password", "services")}, rest: ${pressed("rest", "services")}, design: ${pressed("design@synced", "plugins")}, data: ${pressed("data@synced", "plugins")}, docs: ${pressed("docs", "skills")}, legal: ${pressed("legal-dpa", "skills")}, skillsRest: ${pressed("rest", "skills")}, hex: $('.app-sees [data-sees-row="plugin:data:hex"] .app-sees-hint')?.textContent })`);
    check(T("under Coding: the rest off, 1Password and design on, the chosen skills in full and the rest by name only"),
      rows?.notion === "Off" && rows.onepass === "On" && rows.rest === "Off" && rows.design === "On" && rows.data === "Off" && rows.docs === "In full" && rows.legal === "Name only" && rows.skillsRest === "Name only" && / · off with its plugin$/.test(rows.hex), rows);
    await sShot(`02-coding-${theme}`);

    // One switch makes it the bot's own choice; the rest switches every row.
    await ev(pick("claude.ai Notion", "services", "On"));
    const own = await until(`${pressed("claude.ai Notion", "services")} === "On" && !$('.app-sees [role="radio"][aria-checked="true"]') && $(".app-sees-own")?.textContent`);
    check(T("one switch: Notion on, no set is chosen, and it says this is Kaja's own choice"), own === "Kaja's own choice. Picking a set replaces it.", own);
    await ev(pick("rest", "services", "On"));
    const allOn = await until(`${pressed("rest", "services")} === "On" && ${pressed("ado", "services")} === "On" && ${pressed("claude.ai HubSpot", "services")} === "On"`);
    check(T("the rest On switches every service row on"), !!allOn);
    // Back to everything: the line says so again.
    await ev(`click($('.app-sees [data-sees-set="everything"]'))`);
    const back = await until(`(${summary}) === "Sees everything" && $('.app-sees [data-sees-set="everything"]').getAttribute("aria-checked") === "true"`, 3000);
    check(T("Everything puts it back to no choice"), !!back);

    // Read again; a read that fails says so and keeps what it had.
    const n0 = await ev(`window.pobotsSees.reads()`);
    await ev(`click(btn("Read again", $(".app-sees")))`);
    const again = await until(`window.pobotsSees.reads() === ${n0 + 1} && (${status}) === "Read just now"`, 3000);
    check(T("Read again reads once more"), !!again);
    await ev(`window.pobotsSees.fail(true)`);
    await ev(`click(btn("Read again", $(".app-sees")))`);
    const failed = await until(`(${status})?.includes("could not be read") && { status: ${status}, rows: $$(".app-sees-row").length, alert: $(".app-sees [data-sees-status]").classList.contains("app-hint-error") }`, 3000);
    check(T("a failed read says so in plain words and the lists stay"), failed?.rows > 10 && failed.alert, failed);
    await ev(`window.pobotsSees.fail(false)`);
  }

  // A read that fails before anything was read: the window still works.
  await open("sees=fail");
  await goTo("Kaja", "settings");
  await until(part);
  await ev(`(${scrollTo}, ${choose})`);
  const firstFail = await until(`(${status})?.includes("could not be read") && { rows: $$(".app-sees-row").length, error: !!document.querySelector(".app-error, .pb-crash") }`, 3000);
  check(S("a first read that fails: the sentence, no lists, nothing broken"), firstFail?.rows === 0 && !firstFail.error, firstFail);
  await ev(`window.pobotsSees.fail(false)`);
  await ev(`click(btn("Read again", $(".app-sees")))`);
  check(S("and Read again then fills it"), !!(await until(`$$(".app-sees-row").length > 10`, 3000)));
  await key("Escape");

  // A GPT bot has the part too (engine 0.26.2): one more hint on how it applies in Codex, no token figures.
  for (const theme of ["dark", "light"]) {
    await open("scene=gpt", { theme });
    await goTo("HubSpot tickets", "settings");
    const gptClosed = await until(`${part} && { summary: ${summary}, gpt: $(".app-sees [data-sees-gpt]")?.textContent, reads: window.pobotsSees.reads() }`);
    check(S(`${theme}: a GPT bot without a choice has the part, sees everything, says how it works on a GPT model and reads nothing`),
      gptClosed?.summary === "Sees everything" && /^On a GPT model, a service Codex also has follows its row here/.test(gptClosed.gpt ?? "") && gptClosed.reads === 0, gptClosed);
    await ev(`(${scrollTo}, ${choose})`);
    await until(`$$(".app-sees-row").length > 10`, 4000);
    await ev(`click($$('.app-sees [role="radio"]').find((r) => r.querySelector(".pb-choice-label").textContent === "Coding"))`);
    const gptSet = await until(`${summary}.startsWith("Coding set") && { summary: ${summary}, notion: $('.app-sees [data-sees-row="claude.ai Notion"] .app-sees-hint')?.textContent, skill: $('.app-sees [data-sees-group="skills"] .app-sees-row:not([data-sees-row="rest"]) .app-sees-hint')?.textContent, plugin: $('.app-sees [data-sees-group="plugins"] .app-sees-row:not([data-sees-row="rest"]) .app-sees-hint')?.textContent }`, 3000);
    check(S(`${theme}: a GPT bot picks the Coding set; no token figure in the line or the rows`),
      !!gptSet && !/token|saves/i.test(gptSet.summary) && !/token/i.test(`${gptSet.notion}${gptSet.skill}${gptSet.plugin}`), gptSet);
    if (theme === "light") await sShot("gpt-coding-light");
    await key("Escape");
  }

  // At phone width: the rows fit, the controls are 44 px to tap, nothing scrolls sideways.
  for (const theme of ["dark", "light"]) {
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA, platform: "iPhone" });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&sees-phone=${theme}` });
    await until(`!!document.querySelector(".pb-shell")`, 6000);
    await sleep(300);
    await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "Kaja"))`);
    await until(`$(".app-main")?.getAttribute("aria-label") === "Kaja"`);
    const vis = (sel) => `$$(${JSON.stringify(sel)}).find((x) => x.checkVisibility({ visibilityProperty: true }))`;
    if (!(await ev(`!!${vis('.pb-tab[data-tab="settings"]')}`))) await ev(`click(${vis(".app-phone-page")})`);
    await until(`!!${vis('.pb-tab[data-tab="settings"]')}`);
    await ev(`click(${vis('.pb-tab[data-tab="settings"]')})`);
    await until(part);
    await ev(`(${scrollTo}, ${choose})`);
    await until(`$$(".app-sees-row").length > 10`, 3000);
    const fit = await ev(`(() => {
      const root = $(".app-sees");
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true }); };
      const small = $$("button", root).filter(vis).map((el) => { const r = el.getBoundingClientRect(); return { what: el.textContent.trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 43.5 || x.h < 43.5);
      const wide = $$("*", root).filter(vis).filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5).map((el) => String(el.className || el.tagName).slice(0, 40));
      return { small: small.slice(0, 5), wide: wide.slice(0, 5), sideways: document.scrollingElement.scrollWidth - innerWidth };
    })()`);
    check(S(`phone, ${theme}: controls 44 px to tap, nothing wider than the screen, nothing scrolls sideways`), fit && fit.small.length === 0 && fit.wide.length === 0 && fit.sideways <= 0, fit);
    await sShot(`03-phone-${theme}`);
  }
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
}
