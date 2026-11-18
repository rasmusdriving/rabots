// The window check, section "gpttitles". Run it alone: node scripts/ui-check.mjs --only=gpttitles
// Chat titles by a GPT model (docs/build/step-gpt-titles.md, engine 0.33.0): Settings, Chats, "Made
// by" lists Claude and ChatGPT models in two groups, the chosen one's provider mark beside it; a
// ChatGPT model saves; nothing moves when the mark changes; without Codex only Claude's are offered.
// On the laptop and the phones, dark and light.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, shots, page, sleep, b, check, ev, until, open, houseRules } from "../lib.mjs";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PHONES = [
  { tag: "390", width: 390, height: 844, ua: IPHONE_UA, ios: true },
  { tag: "360", width: 360, height: 780, ua: ANDROID_UA, ios: false },
];

const picker = `(() => {
  const s = $("#set7-title-model");
  if (!s) return null;
  const r = s.getBoundingClientRect();
  const mark = $(".pb-set7-model-mark");
  const m = mark?.getBoundingClientRect();
  return {
    value: s.value,
    groups: $$("#set7-title-model optgroup").map((g) => g.label + ":" + [...g.querySelectorAll("option")].map((o) => o.value).join("|")),
    loose: $$("#set7-title-model > option").map((o) => o.value),
    mark: mark?.dataset.provider,
    markSvg: !!mark?.querySelector("svg"),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(":"),
    markBox: m ? [Math.round(m.left), Math.round(m.top), Math.round(m.width), Math.round(m.height)].join(":") : "",
    hint: s.closest(".pb-field")?.querySelector(".pb-hint")?.textContent ?? "",
    wide: document.documentElement.scrollWidth > innerWidth + 1,
    inView: r.right <= innerWidth + 1 && r.left >= -1,
  };
})()`;

export default async function section() {
  const M = (name) => `gpttitles: ${name}`;
  const dir = arg("gpttitles-shots") ?? (shots ? join(shots, "gpttitles") : undefined);
  if (dir) mkdirSync(dir, { recursive: true });
  const picture = async (name) => {
    if (!dir) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  };
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
  /** Settings, Chats, scrolled to "Chat titles". */
  const toTitles = async () => {
    await ev(`(() => { const side = $(".app-side"); if (side) side.scrollTop = 99999; click($(".app-side .pb-foot-settings") ?? $(".pb-foot-settings")); return true; })()`);
    await until(`!!$('.pb-setwin-tab[data-section="chats"]')`, 4000);
    await ev(`click($('.pb-setwin-tab[data-section="chats"]'))`);
    await until(`!!$("#set7-title-model")`, 4000);
    await ev(`$(".pb-set7-titles").scrollIntoView({ block: "center" })`);
    await sleep(250);
  };
  const choose = (id) => ev(`(() => { const s = $("#set7-title-model"); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);

  try {
    for (const theme of ["dark", "light"]) {
      // ---------------- the laptop
      const T = (n) => M(`${theme}, laptop: ${n}`);
      await leavePhone();
      await open("", { theme });
      await toTitles();
      const before = await ev(picker);
      check(
        T("Made by lists Claude's models and ChatGPT's, in two groups named as in the bot picker; Haiku 5.5 with Claude's mark"),
        before?.value === "claude-haiku-5-5" &&
          before.groups.length === 2 &&
          before.groups[0].startsWith("Claude:") &&
          before.groups[0].includes("claude-haiku-5-5") &&
          before.groups[1] === "ChatGPT:gpt-6.1-sol|gpt-6.1-terra|gpt-6-luna|gpt-6-astra" &&
          before.loose.length === 0 &&
          before.mark === "claude" &&
          before.markSvg,
        before,
      );
      check(T("the hint says a ChatGPT model goes through Codex and spares Claude usage, with Haiku 5.5 when Codex cannot"), /through Codex/.test(before?.hint ?? "") && /Claude usage/.test(before.hint) && /when Codex cannot, Haiku 5\.5 does/.test(before.hint), before?.hint);
      await picture(`01-laptop-${theme}-haiku`);
      await choose("gpt-6-luna");
      const saved = await until(`window.pobotsMock.settingsState().titleModel === "gpt-6-luna"`);
      await sleep(200);
      const after = await ev(picker);
      check(T("choosing GPT-6 Luna saves it, and the mark beside the picker becomes OpenAI's"), !!saved && after?.value === "gpt-6-luna" && after.mark === "codex" && after.markSvg, after);
      check(T("nothing moves when the mark changes: the picker and the mark keep their boxes"), after?.box === before?.box && after.markBox === before.markBox, { before: [before?.box, before?.markBox], after: [after?.box, after?.markBox] });
      check(T("Saved is said"), !!(await until(`!!$(".pb-set7-titles .pb-saved[data-show]")`, 2000)));
      await houseRules(T("chat titles"));
      await picture(`02-laptop-${theme}-luna`);
      await choose("claude-haiku-5-5");
      check(T("back to Haiku 5.5: saved, Claude's mark again"), !!(await until(`window.pobotsMock.settingsState().titleModel === "claude-haiku-5-5" && $(".pb-set7-model-mark")?.dataset.provider === "claude"`)));

      // Without Codex the bot picker offers no GPT model; neither does this one.
      await open("codex=off", { theme });
      await toTitles();
      const off = await ev(picker);
      check(T("with Codex not ready only Claude's models are offered, without groups"), off?.groups.length === 0 && off.loose.length > 0 && off.loose.every((v) => v.startsWith("claude-")), off);

      // ---------------- the phones
      for (const phone of PHONES) {
        const P = (n) => M(`${theme}, ${phone.tag}: ${n}`);
        await openPhone(phone, theme);
        await toTitles();
        const ph = await ev(picker);
        check(P("both groups, the mark beside the picker, all on the screen, no sideways scroll"), ph?.groups.length === 2 && ph.mark === "claude" && ph.inView && !ph.wide, ph);
        await choose("gpt-6-luna");
        await until(`window.pobotsMock.settingsState().titleModel === "gpt-6-luna"`);
        await sleep(200);
        const ph2 = await ev(picker);
        check(P("GPT-6 Luna saves and the mark changes without anything moving"), ph2?.value === "gpt-6-luna" && ph2.mark === "codex" && ph2.box === ph?.box && ph2.markBox === ph?.markBox, { ph, ph2 });
        await picture(`03-phone${phone.tag}-${theme}-luna`);
      }
    }
  } finally {
    await leavePhone();
  }
}
