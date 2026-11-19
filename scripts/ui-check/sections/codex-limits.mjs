// One hub-only reading, then a local Codex reading arrives without moving the hub cards.
import { pathToFileURL } from "node:url";
import { b, check, ev, open, page, until } from "../lib.mjs";

const choose = (label) => ev(`click(btn(${JSON.stringify(label)}))`);
const source = () => ev('text(".pb-set7-checked-text")');
const box = () => ev(`JSON.stringify($$('[data-provider="claude"].pb-set7-meter-group .pb-set7-meter').map((el) => {
  const {x, y, width, height} = el.getBoundingClientRect();
  return [x, y, width, height];
}))`);
const done = (provider) => until(`!!$('.pb-set7-meter-group[data-provider="${provider}"]') && !$(".pb-set7-usage[data-reading]")`, 6500);
const switchTo = async (kind) => {
  await ev(`window.pobotsMock.usageNext(${JSON.stringify(kind)})`);
  await choose("Refresh");
};
const fit = () => ev(`[document.documentElement, $(".app-appsettings-scroll"), $(".pb-usage"), ...$$(".pb-set7-meter")].every((e) =>
  e && e.scrollWidth <= e.clientWidth + 1)`);

export default async function section() {
  for (const [width, height, theme] of [[1280, 820, "dark"], [390, 844, "light"], [360, 780, "dark"]]) {
    if (width === 1280) await open("usage=hub-claude", { width, height, theme });
    else {
      const userAgent = width === 390
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";
      await b.cmd("Emulation.setUserAgentOverride", { userAgent });
      await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
      await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&usage=hub-claude` });
    }
    await until('!!$(".pb-foot-usage")', 6500);
    await ev('click($(".pb-foot-usage"))');
    await until('!!btn("Limits")', 6500);
    await choose("Limits");
    const ready = await done("claude");
    const original = await box();
    const label = `codex-limits ${width} px`;
    check(`${label}: hub-only reading names its hub`, ready && /^From hub-mac\.example\.net:8443\./.test(await source()));
    await switchTo("mixed");
    const reading = await until('!!$(".pb-set7-usage[data-reading]")', 500);
    const during = await box();
    check(`${label}: refresh keeps hub cards in the same boxes while reading`, reading && during === original && !await ev('!!$(".pb-set7-meter-group[data-provider=codex]")'), { original, during });
    const mixed = await done("codex");
    const after = await box();
    check(`${label}: local Codex arrives below the hub without moving its cards`, mixed && after === original &&
      await ev('$$(".pb-set7-meter-group").map((e) => e.dataset.provider).join(",") === "claude,codex"'), { original, after });
    check(`${label}: the status names both sources and the Codex group marks This Mac`, /^From usage hubs and this Mac\./.test(await source()) &&
      await ev('text("[data-provider=codex] .pb-usage-origin") === "This Mac"'));
    check(`${label}: Codex shows limit windows, credit balance, reset count and expiry separately`, await ev(`(() => {
      const c = $('.pb-set7-meter-group[data-provider=codex]');
      return c.querySelectorAll("[data-window]").length === 2 &&
        c.querySelector("[data-credit=balance]").innerText.includes("450.5") &&
        c.querySelector("[data-credit=reset] .pb-set7-meter-pct").textContent === "2" &&
        c.querySelector("[data-credit=reset] time").textContent.includes("next expires");
    })()`));
    check(`${label}: limits and credits fit without sideways scroll`, await fit());

    if (width === 1280) {
      await switchTo("mixed-failure");
      check(`${label}: a failed Codex read stays in its own group`,
        !!await until('text("[data-provider=codex] .pb-set7-meter-problem") === "Codex could not be asked for its usage."') &&
        await box() === original);
      await switchTo("hub-codex");
      check(`${label}: a hub-backed Codex group reports its unlimited balance without a local duplicate`,
        !!await until('text("[data-credit=balance] .pb-set7-meter-pct") === "Unlimited"') &&
        /^From hub-mac\.example\.net:8443\./.test(await source()) &&
        !await ev('!!$("[data-provider=codex] .pb-usage-origin")'));
    }
  }
  await b.cmd("Emulation.clearDeviceMetricsOverride");
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
  await b.cmd("Emulation.setUserAgentOverride", { userAgent: "" });
}
