// The window check, section "smallfixes". Run it alone: node scripts/ui-check.mjs --only=smallfixes
// The small fixes of engine 0.26.3 (docs/build/step-small-fixes-0.26.3.md), on the phones and the laptop:
//   fix 2: a helper row inside a fold keeps its title readable at 360 px, in one steady box;
//   fix 3: on a phone every tab of a bot's page can be reached, and the open one is in view;
//   fix 4: right after a reload the closed "What <bot> sees" line never reads a guess.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, shots, page, sleep, b, check, ev, until, open, goTo, houseRules } from "../lib.mjs";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PHONES = [
  { tag: "390", width: 390, height: 844, ua: IPHONE_UA, ios: true },
  { tag: "360", width: 360, height: 780, ua: ANDROID_UA, ios: false },
];
const HELPER_TITLE = "Check the open onboarding tickets";

export default async function section() {
  const M = (name) => `smallfixes: ${name}`;
  const dir = arg("smallfixes-shots") ?? (shots ? join(shots, "smallfixes") : undefined);
  if (dir) mkdirSync(dir, { recursive: true });
  const picture = async (name) => {
    if (!dir) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  let opens = 0;
  const openPhone = async (query, phone, theme) => {
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: phone.ua, platform: phone.ios ? "iPhone" : "Linux armv8l" });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
    await b.cmd("Page.resetNavigationHistory");
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}${query ? `&${query}` : ""}&fresh=${++opens}` });
    await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
    await sleep(300);
  };
  const leavePhone = async () => {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  };
  try {
    for (const theme of ["dark", "light"]) {
      for (const phone of PHONES) await walk(theme, phone);
      await leavePhone();
      await walk(theme, null);
    }
  } finally {
    await leavePhone();
  }

  async function walk(theme, phone) {
    const where = `${theme}, ${phone ? phone.tag : "laptop"}`;
    const T = (n) => M(`${where}: ${n}`);
    const go = (q) => (phone ? openPhone(q, phone, theme) : open(q, { theme }));
    const toBot = async (name) => {
      await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}))`);
      return until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
    };
    const toTab = async (name, tab) => {
      if (!phone) return goTo(name, tab);
      await toBot(name);
      if (!(await ev(`!!$('.app-main .pb-tab[data-tab="${tab}"]')`))) {
        await until(`!!$(".app-main .app-phone-page")`);
        await ev(`click($(".app-main .app-phone-page"))`);
        await until(`!!$('.app-main .pb-tab[data-tab="${tab}"]')`);
      }
      await ev(`click($('.app-main .pb-tab[data-tab="${tab}"]'))`);
      return until(`$(".app-tabpanel")?.dataset.tab === "${tab}"`);
    };

    // ---------------- fix 2: a helper row in a fold keeps its title readable, in one steady box
    await go("helperfold=1");
    await toBot("HubSpot tickets");
    await until(`$$(".app-main .pb-fold").some((x) => x.textContent.includes("Inbox asked"))`);
    await ev(`(() => { const f = $$(".app-main .pb-fold").find((x) => x.textContent.includes("Inbox asked")); inPanel(f); return click(f); })()`);
    const row = await until(`(() => {
      const r = $$(".app-main .pb-fold-body .pb-helper").find((x) => x.querySelector(".pb-helper-title")?.textContent === ${JSON.stringify(HELPER_TITLE)});
      if (!r) return null;
      const box = (s) => { const e = r.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, cut: e.scrollWidth > e.clientWidth + 1 }; };
      const rr = r.getBoundingClientRect();
      const all = $$(".app-main .pb-helper").map((x) => Math.round(x.getBoundingClientRect().height));
      return { h: Math.round(rr.height), all, inner: rr.width, title: box(".pb-helper-title"), model: box(".pb-helper-model"), state: box(".pb-helper-state"), last: box(".pb-helper-last"), go: box(".pb-helper-go"), label: r.getAttribute("aria-label") };
    })()`);
    const apart = (a, b) => !!a && !!b && (a.r <= b.l + 0.5 || b.r <= a.l + 0.5 || a.b <= b.t + 0.5 || b.b <= a.t + 0.5);
    const inside = (a) => !!a && !!row && a.r <= row.go.l + 0.5;
    if (phone) {
      check(T("the helper row in the fold: the title has a line of its own, above the state and the model label"), !!row?.title && row.state.t >= row.title.b - 0.5 && row.model.t >= row.title.b - 0.5 && row.last.t >= row.state.b - 0.5, row);
      check(T("the title reads, not a few letters (at least 60% of the row)"), !!row?.title && row.title.w >= row.inner * 0.6 && (phone.tag === "360" || !row.title.cut), row?.title);
      check(T("one fixed height for every helper row, 68 px"), !!row && row.all.length > 0 && row.all.every((h) => h === 68), row?.all);
    } else {
      check(T("the helper row in the fold keeps the laptop's one line: title and label on top, the state at the right, 52 px, the label whole"), !!row && row.h === 52 && Math.abs(row.model.t - row.title.t) < 1 && !row.model.cut && row.state.l >= row.model.r - 0.5, row);
    }
    check(T("nothing in the row covers anything else, and it stays left of the arrow"), !!row && apart(row.title, row.model) && apart(row.title, row.state) && apart(row.state, row.model) && apart(row.last, row.state) && [row.title, row.model, row.state, row.last].every(inside), row);
    check(T("the row's name still says the title and the model"), typeof row?.label === "string" && row.label.startsWith(HELPER_TITLE) && row.label.includes("GPT-6.1 Terra, extra high, fast"), row?.label);
    await houseRules(`smallfixes, helper in a fold, ${where}`);
    await picture(`fix2-helper-in-fold-${theme}-${phone ? phone.tag : "laptop"}`);

    // ---------------- fix 3: every tab of a bot's page can be reached, the open one in view
    const strip = `(() => { const t = $(".app-main .pb-tabs"); if (!t) return null; const box = t.getBoundingClientRect(); const on = $(".pb-tab[aria-selected=true]", t); const r = on.getBoundingClientRect(); return { tab: on.dataset.tab, whole: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, over: t.scrollWidth > t.clientWidth + 1, start: !!t.dataset.moreStart, end: !!t.dataset.moreEnd, left: Math.round(t.scrollLeft), h: Math.round(box.height), page: document.scrollingElement.scrollWidth - innerWidth }; })()`;
    await toTab("Inbox", "job");
    const atJob = await until(strip);
    if (phone) {
      check(T("the tabs are wider than the phone and scroll inside the row; the far edge fades, the near one not"), atJob?.over === true && atJob.end && !atJob.start && atJob.page <= 0, atJob);
      await ev(`click($('.app-main .pb-tab[data-tab="settings"]'))`);
      await until(`$(".app-tabpanel")?.dataset.tab === "settings"`);
      const atSettings = await until(`(() => { const s = ${strip}; return s && s.tab === "settings" && s.whole && !s.end ? s : null; })()`, 3000);
      check(T("Settings opens and its tab is brought whole into view; the near edge fades now, the far one not"), !!atSettings && atSettings.start && !atSettings.end && atSettings.h === atJob.h && atSettings.page <= 0, atSettings ?? (await ev(strip)));
      // Back to the chat, and Page again: the page opens on Settings, in view at once.
      await ev(`click($(".app-main .app-phone-back"))`);
      await until(`!!$(".app-main .app-phone-page")`);
      await ev(`click($(".app-main .app-phone-page"))`);
      const again = await until(`(() => { const s = ${strip}; return s && s.tab === "settings" ? s : null; })()`);
      check(T("Page opens again on Settings with its tab in view at once"), !!again && again.whole, again);
      await picture(`fix3-tabs-settings-${theme}-${phone.tag}`);
      await ev(`click($('.app-main .pb-tab[data-tab="chat"]'))`);
      await until(`$(".app-tabpanel")?.dataset.tab === "chat" || !$(".app-main .pb-tabs")`);
    } else {
      check(T("on the laptop all seven tabs fit: no scrolling, no fading"), !!atJob && !atJob.over && !atJob.start && !atJob.end, atJob);
    }

    // ---------------- fix 4: right after a reload the closed "What Kaja sees" line never guesses
    const seen = `(() => { const l = $(".app-sees [data-sees-summary]"); if (!l) return null; return { text: l.textContent, pending: l.hasAttribute("data-pending"), delay: getComputedStyle(l).animationDelay, h: Math.round($(".app-sees-summary").getBoundingClientRect().height) }; })()`;
    const watch = async (ms) => {
      const out = [];
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await ev(seen);
        if (v && !v.error) out.push(v);
        await sleep(40);
      }
      return out;
    };
    await go("seesset=1&sees=slow");
    await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("pobots.seesLine.")) localStorage.removeItem(k); return true; })()`);
    await toTab("Kaja", "settings");
    const firstRead = await watch(3800);
    const final = firstRead.at(-1);
    check(T("never read before in this browser: a quiet Reading line, then the real one; never a guess"), firstRead.length > 3 && firstRead[0].pending && firstRead[0].text === "Reading what Kaja sees" && firstRead.every((v) => v.pending || v.text === final.text) && final?.text.startsWith("Coding set: ") && !firstRead.some((v) => /\bbut\b/.test(v.text)), [...new Set(firstRead.map((v) => v.text))]);
    const delay = firstRead[0]?.delay;
    check(T("the Reading line comes in only after a moment, so a quick read never flashes it"), delay === "0.48s", delay);
    await go("seesset=1&sees=slow");
    await toTab("Kaja", "settings");
    const reload = await watch(3800);
    check(T("after a reload the line the bot had stands at once and does not change, in one height"), reload.length > 3 && reload.every((v) => !v.pending && v.text === final.text && v.h === final.h), [...new Set(reload.map((v) => `${v.text} ${v.h}`))]);
    await picture(`fix4-sees-${theme}-${phone ? phone.tag : "laptop"}`);
    await houseRules(`smallfixes, sees after a reload, ${where}`);
    if (!phone) {
      // Nothing could be read and nothing was kept: the words from the choice alone hold either way.
      await go("seesset=1&sees=fail");
      await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("pobots.seesLine.")) localStorage.removeItem(k); return true; })()`);
      await toTab("Kaja", "settings");
      const failed = await until(`(() => { const s = ${seen}; return s && !s.pending ? s : null; })()`, 4000);
      check(T("when nothing can be read: All services off but 1, all plugins off but 2, ..."), failed?.text === "All services off but 1 · all plugins off but 2 · all skills by name only but 12", failed);
    }
  }
}
