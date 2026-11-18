// Settings > Usage against the stand-in: values, preserving the old reading, and the phone layout.
import { pathToFileURL } from "node:url";
import { b, check, ev, open, page, until, sleep } from "../lib.mjs";

const choose = async (label) => ev(`click(btn(${JSON.stringify(label)}))`);
const read = (range) => until(`$('.pb-usage-data[data-range="${range}"]:not([data-reading])') ? text('[data-usage-total]') : null`, 6000);
const boxes = `[".pb-usage-top", "[data-usage-total]", ".pb-usage-chart"].map((s) => { const r = $(s).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width)]; })`;

export default async function section() {
  await open("usage=several", { width: 1440, height: 900, theme: "dark" });
  await ev(`click($(".pb-foot-usage"))`);
  const initial = await read("30d");
  check("usage-page: opens to Cost with API estimate and two provider trends", initial === "$142.50" && await ev(`text(".pb-usage-caption").includes("API estimate") && $$(".pb-usage-line").length === 2`));
  const before = await ev(boxes);
  await ev(`window.pobotsUsage.waitMs = 850`);
  await choose("7 days");
  await sleep(240);
  const during = await ev(`({ total: text("[data-usage-total]"), reading: !!$(".pb-usage-data[data-reading]"), fade: +getComputedStyle($(".pb-usage-data")).opacity })`);
  check("usage-page: changing the range keeps the old figures and their boxes", during?.total === initial && during?.reading && during.fade < 1 && JSON.stringify(before) === JSON.stringify(await ev(boxes)), during);
  check("usage-page: the requested range replaces the old figures", await read("7d") === "$33.25");
  await ev(`window.pobotsUsage.waitMs = 0`);
  await choose("Tokens");
  check("usage-page: tokens changes both share and the breakdown", await ev(`text("[data-usage-total]") === "8.4M" && text(".pb-usage-chart h3") === "Daily processed tokens" && text(".pb-usage-share h3") === "Tokens by type"`));
  await choose("Day");
  check("usage-page: breakdown groups by day", await ev(`$('[aria-label="Usage by day"]') && $$(".pb-usage-table-row").length === 7`));
  await ev(`(() => { const select = $(".pb-usage-filter"); select.value = "codex"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  check("usage-page: provider filter updates the chart, total and rows", !!await until(`$$(".pb-usage-provider").length === 1 && text("[data-usage-total]") === "1.4M" && $$(".pb-usage-line").length === 1`));
  await choose("Past 24h");
  check("usage-page: the rolling 24 hours use hourly points", await read("24h") === "200K" && await ev(`text(".pb-usage-chart h3") === "Hourly processed tokens"`));
  await choose("90 days");
  check("usage-page: 90 days uses the full range", await read("90d") === "18M");
  await choose("Limits");
  const filteredLimits = await until(`!$(".pb-set7-usage[data-reading]") && $$(".pb-set7-meter-group").length === 1 && $(".pb-set7-meter-group").dataset.provider === "codex"`, 6000);
  check("usage-page: Limits keeps the provider filter and hides the range", !!filteredLimits && await ev(`!$(".pb-usage-ranges") && !!$(".pb-set7-bar-reset")`));

  for (const [width, height] of [[390, 844], [360, 780]]) {
    const userAgent = width === 390
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
    await b.cmd("Emulation.setUserAgentOverride", { userAgent });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=light` });
    await until(`!!$(".pb-shell[data-phone] .app-side .pb-foot-settings")`, 6000);
    await ev(`click($(".app-side .pb-foot-settings"))`);
    await until(`!!$('.pb-setwin-tab[data-section="usage"]')`, 6000);
    await ev(`click($('.pb-setwin-tab[data-section="usage"]'))`);
    await read("30d");
    const fit = `(() => { const pane = $(".app-appsettings-scroll"); const content = $(".pb-usage"); return pane.scrollWidth <= pane.clientWidth + 1 && content.scrollWidth <= content.clientWidth + 1; })()`;
    const mobile = await ev(`({ fit: ${fit}, columns: getComputedStyle($(".pb-usage-overview")).gridTemplateColumns, labels: getComputedStyle($(".pb-usage-cell-label")).display })`);
    check(`usage-page: ${width} px fits as one column with stacked table rows`, mobile?.fit && mobile.columns.split(" ").length === 1 && mobile.labels === "block", mobile);
    await choose("Limits");
    await until(`!!$(".pb-set7-meter")`, 6000);
    check(`usage-page: ${width} px fits plan limit cards`, await ev(fit));
  }
}
