// The window check, section "selfupdate". Run it alone: node scripts/ui-check.mjs --only=selfupdate
// A public install updates itself with one click (docs/build/step-self-update.md, engine 0.34.0). The
// stand-in engine acts out such an install with ?pobots=: the Pobots card at the end of Providers, the
// round arrow and its dialog with Pobots in the list, the run's lines, a refusal, a failed build, a
// Pobots that cannot restart itself, and a look that did not work (calm, never red). Without the flag
// nothing of it shows. On the laptop and the phones, dark and light.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, shots, page, sleep, b, check, ev, until, open, key, houseRules } from "../lib.mjs";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PHONES = [
  { tag: "390", width: 390, height: 844, ua: IPHONE_UA, ios: true },
  { tag: "360", width: 360, height: 780, ua: ANDROID_UA, ios: false },
];

/** The Pobots card as the person sees it. */
const card = `(() => {
  const c = $('.pb-set7-provider[data-provider="pobots"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const btn = c.querySelector(".pb-set7-update");
  const note = c.querySelector(".pb-set7-pobots-note");
  return {
    last: c.closest("li") === $(".pb-set7-provider-list").lastElementChild,
    name: c.querySelector(".pb-set7-provider-name").textContent,
    facts: c.querySelector(".pb-set7-provider-facts").textContent,
    latest: [...c.querySelectorAll(".pb-set7-provider-latest")].filter((x) => !x.classList.contains("pb-set7-pobots-note")).map((x) => x.textContent).join(""),
    button: getComputedStyle(btn).visibility,
    note: note?.textContent ?? "",
    noteColor: note ? getComputedStyle(note).color : "",
    problemColor: (() => { const p = document.createElement("p"); p.className = "pb-set7-provider-problem"; c.appendChild(p); const col = getComputedStyle(p).color; p.remove(); return col; })(),
    red: !!c.querySelector(".pb-set7-provider-problem"),
    box: [Math.round(r.left), Math.round(r.width)].join(":"),
    height: Math.round(r.height),
    run: $(".pb-set7-pobots-run")?.textContent ?? "",
    wide: document.documentElement.scrollWidth > innerWidth + 1,
    inView: r.right <= innerWidth + 1 && r.left >= -1,
  };
})()`;
const arrow = `({ shown: !!$(".pb-foot-update[data-show]"), label: $(".pb-foot-update").getAttribute("aria-label") })`;
const dialog = `$(".pb-dialog") ? { title: $(".pb-dialog-title").textContent, what: $$(".pb-set7-update-what").map((x) => x.textContent), text: $(".pb-set7-update-text").textContent, lines: $$(".pb-set7-update-line").map((x) => x.textContent), problem: $(".pb-dialog .pb-problem, .pb-dialog [role=alert]")?.textContent ?? "", wide: document.documentElement.scrollWidth > innerWidth + 1 } : null`;

export default async function section() {
  const M = (name) => `selfupdate: ${name}`;
  const dir = arg("selfupdate-shots") ?? (shots ? join(shots, "selfupdate") : undefined);
  if (dir) mkdirSync(dir, { recursive: true });
  const picture = async (name) => {
    if (!dir) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const mock = (expr) => ev(`window.pobotsMock.${expr}`);
  let opens = 0;
  const openPhone = async (phone, theme, query = "") => {
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: phone.ua, platform: phone.ios ? "iPhone" : "Linux armv8l" });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
    await b.cmd("Page.resetNavigationHistory");
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&fresh=${++opens}${query ? `&${query}` : ""}` });
    await until(`!!document.querySelector(".pb-shell, .app-first-body, .app-line")`, 6000);
    await sleep(300);
  };
  const leavePhone = async () => {
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  };
  /** Settings, Providers, the Pobots card in view. */
  const toProviders = async () => {
    await ev(`(() => { const side = $(".app-side"); if (side) side.scrollTop = 99999; click($(".app-side .pb-foot-settings") ?? $(".pb-foot-settings")); return true; })()`);
    await until(`!!$('.pb-setwin-tab[data-section="providers"]')`, 4000);
    await ev(`click($('.pb-setwin-tab[data-section="providers"]'))`);
    await until(`$$(".pb-set7-provider").length >= 2`, 4000);
    await ev(`($('.pb-set7-provider[data-provider="pobots"]') ?? $(".pb-set7-provider-list")).scrollIntoView({ block: "center" })`);
    await sleep(250);
  };

  try {
    for (const theme of ["dark", "light"]) {
      const T = (n) => M(`${theme}, laptop: ${n}`);
      await leavePhone();

      // ---------------- not a public install: nothing new
      await open("", { theme });
      check(T("without a public install the arrow names only Codex"), (await ev(arrow))?.label === "Update Codex", await ev(arrow));
      await toProviders();
      const none = await ev(`({ cards: $$(".pb-set7-provider").map((c) => c.dataset.provider), pobots: !!$('[data-provider="pobots"]'), run: !!$(".pb-set7-pobots-run") })`);
      check(T("and Providers has Claude Code and Codex only: no Pobots card, no Pobots line"), none?.cards.join(",") === "claude,codex" && !none.pobots && !none.run, none);
      await key("Escape");

      // ---------------- a public install with a new Pobots, nothing else to update
      await open("pobots=available&update=none", { theme });
      const a1 = await ev(arrow);
      check(T("the round arrow comes for Pobots alone: Update Pobots"), a1?.shown && a1.label === "Update Pobots", a1);
      await toProviders();
      const c1 = await ev(card);
      check(
        T("Providers ends with a Pobots card: its version, where it updates from, Pobots 0.34.1 is available, and Update"),
        c1?.last && c1.name === "Pobots" && c1.facts === "Version 0.34.0 · Updates from the public repository" && c1.latest === "Pobots 0.34.1 is available." && c1.button === "visible" && !c1.red && !c1.wide,
        c1,
      );
      await houseRules(T("Providers with Pobots"));
      await picture(`01-laptop-${theme}-available`);
      await ev(`click($('.pb-set7-provider[data-provider="pobots"] .pb-set7-update'))`);
      const d1 = await until(dialog);
      check(
        T("Update asks first: Update Pobots?, Pobots 0.34.0 to 0.34.1, and that Pobots restarts and reconnects by itself"),
        d1?.title === "Update Pobots?" && d1.what.join("|") === "Pobots 0.34.0 to 0.34.1" && /then updates itself and restarts\. It reconnects by itself after about a minute\./.test(d1.text),
        d1,
      );
      await picture(`02-laptop-${theme}-ask`);
      await mock(`updateHold(["Inbox"])`);
      await ev(`click($(".pb-set7-update-go"))`);
      check(T("it waits for a bot that works, and says so"), !!(await until(`$(".pb-set7-update-line")?.textContent === "Waiting for Inbox to finish."`, 2000)));
      await mock(`updateHold([])`);
      const building = await until(`$(".pb-set7-update-line")?.textContent === "Building Pobots 0.34.1." ? true : null`, 4000);
      check(T("then says what it does: Building Pobots 0.34.1."), !!building);
      await picture(`03-laptop-${theme}-building`);
      const restarting = await until(`$(".pb-set7-update-line")?.textContent === "Restarting Pobots to finish the update." ? true : null`, 4000);
      check(T("and Restarting Pobots to finish the update."), !!restarting);
      const d2 = await until(`$(".pb-dialog-title")?.textContent === "Update done" ? (${dialog}) : null`, 6000);
      check(T("the result in plain words: Pobots updated to 0.34.1."), d2?.lines.join("|") === "Pobots updated to 0.34.1.", d2);
      // Close (not Escape, which would close the settings window under it too).
      await ev(`click($$(".pb-dialog .pb-btn").find((x) => x.textContent === "Close"))`);
      await sleep(250);
      const c2 = await ev(card);
      check(T("the card says Up to date., the line under the cards keeps the result, and the card keeps its box"), c2?.latest === "Up to date." && c2.button === "hidden" && /^Last update of Pobots, \d\d:\d\d: Pobots updated to 0\.34\.1\.$/.test(c2.run) && c2.box === c1?.box && c2.height === c1?.height, { c1, c2 });
      check(T("and the arrow is gone"), !(await ev(arrow))?.shown);
      await picture(`04-laptop-${theme}-done`);
      await key("Escape");

      // ---------------- with a Codex update too: one press, harnesses first
      await open("pobots=available", { theme });
      await mock(`updateHold([])`);
      check(T("the arrow names both: Update Codex and Pobots"), (await ev(arrow))?.label === "Update Codex and Pobots");
      await ev(`click($(".pb-foot-update"))`);
      const d3 = await until(dialog);
      check(
        T("one dialog lists Codex first, then Pobots, and says the bots' Codex restarts and then Pobots"),
        d3?.title === "Update Codex and Pobots?" && d3.what.join("|") === "Codex 0.165.0 to 0.169.0|Pobots 0.34.0 to 0.34.1" && /restarts their Codex\. Then Pobots updates itself and restarts/.test(d3.text),
        d3,
      );
      await picture(`05-laptop-${theme}-both`);
      await ev(`click($(".pb-set7-update-go"))`);
      const d4 = await until(`$(".pb-dialog-title")?.textContent === "Update done" ? (${dialog}) : null`, 9000);
      check(T("both results, one line each"), d4?.lines.join("|") === "Codex updated from 0.165.0 to 0.169.0.|Pobots updated to 0.34.1.", d4);
      await key("Escape");

      // ---------------- a build that fails
      await open("pobots=available&update=none", { theme });
      await mock(`updateHold([])`);
      await mock(`updateNext("fail")`);
      await ev(`click($(".pb-foot-update"))`);
      await until(dialog);
      await ev(`click($(".pb-set7-update-go"))`);
      const d5 = await until(`$(".pb-dialog-title")?.textContent === "Update did not finish" ? (${dialog}) : null`, 6000);
      check(T("a build that fails: Update did not finish, and nothing changed"), d5?.lines.join("|") === "Pobots 0.34.1 could not be built, so nothing changed. See the log.", d5);
      await picture(`06-laptop-${theme}-failed`);
      await key("Escape");
      await mock(`updateNext("ok")`);

      // ---------------- a folder with changes of its own: refused, said in the dialog
      await open("pobots=dirty&update=none", { theme });
      await ev(`click($(".pb-foot-update"))`);
      await until(dialog);
      await ev(`click($(".pb-set7-update-go"))`);
      const d6 = await until(`(() => { const d = ${dialog}; return d && /changes of its own/.test($(".pb-dialog").textContent) ? { ...d, all: $(".pb-dialog").textContent } : null; })()`, 3000);
      check(T("a folder with changes of its own: refused in one plain sentence, the question stays"), d6?.title === "Update Pobots?" && /has changes of its own\. Commit or undo them, then try again\./.test(d6.all), d6);
      await picture(`07-laptop-${theme}-refused`);
      await key("Escape");

      // ---------------- cannot restart itself; a look that did not work
      await open("pobots=manual&update=none", { theme });
      check(T("a Pobots that cannot restart itself: no arrow"), !(await ev(arrow))?.shown);
      await toProviders();
      const c3 = await ev(card);
      check(T("its card says so and how, without an Update button"), /cannot restart itself here: quit it, then run git pull and npm start in its folder\./.test(c3?.latest ?? "") && c3.button === "hidden", c3);
      await key("Escape");
      await open("pobots=problem&update=none", { theme });
      await toProviders();
      const c4 = await ev(card);
      check(T("a look that did not work is one calm line, not the red of a problem"), c4?.note === "Pobots could not look for a new version just now. It tries again later." && !c4.red && c4.noteColor !== c4.problemColor, c4);
      await picture(`08-laptop-${theme}-problem`);
      await key("Escape");

      // ---------------- a public install without Codex: said calmly, nothing to update
      await open("pobots=current&update=nocodex", { theme });
      check(T("without Codex and with nothing new: no round arrow"), !(await ev(arrow))?.shown);
      await toProviders();
      const nc = await ev(`(() => { const c = $('.pb-set7-provider[data-provider="codex"]'); const p = c?.querySelector(".pb-set7-provider-problem"); const f = c?.querySelector(".pb-set7-provider-facts"); return c && { facts: f.textContent, problem: p?.textContent ?? "", calm: !!p && getComputedStyle(p).color === getComputedStyle(f).color, latest: c.querySelector(".pb-set7-provider-latest").textContent, button: getComputedStyle(c.querySelector(".pb-set7-update")).visibility, mark: c.querySelector(".pb-set7-provider-head > :first-child")?.outerHTML.slice(0, 80) }; })()`);
      check(T("Codex not installed: Not installed, one muted sentence, no line about a newest version, no Update button"), nc?.facts === "Not installed" && nc.problem === "Codex is not installed on this Mac." && nc.calm && nc.latest === "" && nc.button === "hidden", nc);
      await picture(`08b-laptop-${theme}-no-codex`);
      await key("Escape");

      // ---------------- the phones
      for (const phone of PHONES) {
        const P = (n) => M(`${theme}, ${phone.tag}: ${n}`);
        await openPhone(phone, theme, "pobots=available&update=none");
        await toProviders();
        const pc = await ev(card);
        check(P("the Pobots card fits the screen, no sideways scroll"), pc?.inView && !pc.wide && pc.button === "visible", pc);
        await picture(`09-phone${phone.tag}-${theme}-card`);
        await ev(`click($('.pb-set7-provider[data-provider="pobots"] .pb-set7-update'))`);
        const pd = await until(dialog);
        check(P("the dialog fits too"), pd?.title === "Update Pobots?" && !pd.wide, pd);
        await picture(`10-phone${phone.tag}-${theme}-ask`);
        await key("Escape");
      }
      await leavePhone();
    }
  } finally {
    await leavePhone();
  }
}
