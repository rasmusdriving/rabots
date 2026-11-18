// The window check, section "failedwords". Run it alone: node scripts/ui-check.mjs --only=failedwords
// Failed words for every Pobots tool (docs/build/step-failed-words.md, engine 0.31.1): a refused
// call's line says it did not work ("Could not change HubSpot tickets"), carries "Failed" and opens
// to the reason; alone and as a row of a group of steps; on the laptop and the phones, dark and light.
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
// The same words as ui/engine/mock-failedwords.ts.
const CHANGE = "Could not change HubSpot tickets";
const CHANGE_WHY = "HubSpot tickets has the Coding set already, so nothing would change.";
const TODO = "Could not add the to-do";
const TODO_WHY = "A to-do needs a short title.";
const BOT = "Onboardings";

export default async function section() {
  const M = (name) => `failedwords: ${name}`;
  const dir = arg("failedwords-shots") ?? (shots ? join(shots, "failedwords") : undefined);
  if (dir) mkdirSync(dir, { recursive: true });
  const picture = async (name) => {
    if (!dir) return;
    await sleep(450);
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  let opens = 0;
  const openPhone = async (phone, theme) => {
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: phone.ua, platform: phone.ios ? "iPhone" : "Linux armv8l" });
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await b.cmd("Emulation.setDeviceMetricsOverride", { width: phone.width, height: phone.height, deviceScaleFactor: 2, mobile: true, screenWidth: phone.width, screenHeight: phone.height });
    await b.cmd("Page.resetNavigationHistory");
    await b.cmd("Page.navigate", { url: `${pathToFileURL(page).href}?mock=1&theme=${theme}&failedwords=1&fresh=${++opens}` });
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
    if (phone) await openPhone(phone, theme);
    else await open("failedwords=1", { theme });
    await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(BOT)}))`);
    check(T("the bot's chat opens"), !!(await until(`$(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(BOT)} && !!$(".app-main .pb-step, .app-main .pb-worked")`)));

    // A done turn folds its work behind "Worked for ..."; open the folds so the lines show.
    await ev(`$$(".app-main .pb-worked[aria-expanded='false']").forEach((x) => click(x))`);
    await sleep(200);
    const lineOf = (label) => `$$(".app-main .pb-activity").find((x) => x.querySelector(".pb-workline-words, .app-activity-label")?.textContent === ${JSON.stringify(label)})`;

    // ---------------- a refused call alone: its words, "Failed", the reason behind it
    const alone = await until(`(() => {
      const n = ${lineOf(CHANGE)};
      if (!n) return null;
      return { failed: n.querySelector(".app-activity-failed")?.textContent, btn: n.tagName === "BUTTON", expanded: n.getAttribute("aria-expanded") };
    })()`);
    check(T("a refused change reads Could not change HubSpot tickets"), !!alone, alone);
    check(T("with Failed beside it"), alone?.failed === "Failed", alone);
    check(T("it opens to the reason, closed at first"), alone?.btn === true && alone.expanded === "false", alone);
    const success = await ev(`$$(".app-main .pb-activity").map((x) => x.textContent).filter((t) => /^Changed HubSpot tickets|Used add todo/.test(t))`);
    check(T("no line reads as if it worked"), Array.isArray(success) && success.length === 0, success);
    await ev(`${lineOf(CHANGE)}.scrollIntoView({ block: "center" })`);
    await sleep(120);
    const before = await ev(`${lineOf(CHANGE)}.getBoundingClientRect().top`);
    await ev(`click(${lineOf(CHANGE)})`);
    const why = await until(`(() => {
      const n = ${lineOf(CHANGE)};
      const d = n?.closest(".pb-step")?.querySelector(".app-activity-detail");
      return d ? { text: d.textContent, top: n.getBoundingClientRect().top } : null;
    })()`);
    check(T("open, it shows the reason"), why?.text === CHANGE_WHY, why);
    check(T("and the line keeps its place"), !!why && Math.abs(why.top - before) <= 1, { before, after: why?.top });
    await picture(`change-${theme}-${phone ? phone.tag : "laptop"}`);

    // ---------------- a refused call inside a group of steps
    const group = await until(`(() => {
      const g = $$(".app-main .pb-workgroup").find((x) => x.dataset.count === "2" && x.textContent.includes("failed"));
      return g ? { failed: g.querySelector(":scope > .pb-workline .app-activity-failed")?.textContent, open: g.querySelector(":scope > .pb-workline")?.getAttribute("aria-expanded") } : null;
    })()`);
    check(T("the group of two steps says 1 failed"), group?.failed === "1 failed", group);
    if (group?.open === "false") await ev(`click($$(".app-main .pb-workgroup").find((x) => x.dataset.count === "2" && x.textContent.includes("failed")).querySelector(":scope > .pb-workline"))`);
    const row = await until(`(() => {
      const r = $$(".app-main .pb-work-row").find((x) => x.querySelector(".pb-workline-words")?.textContent === ${JSON.stringify(TODO)});
      return r ? { status: r.dataset.status, failed: r.querySelector(".app-activity-failed")?.textContent } : null;
    })()`);
    check(T("its row reads Could not add the to-do, marked failed"), row?.status === "failed" && row.failed === "Failed", row);
    await ev(`click($$(".app-main .pb-work-row").find((x) => x.querySelector(".pb-workline-words")?.textContent === ${JSON.stringify(TODO)}).querySelector(".pb-workline"))`);
    const rowWhy = await until(`$$(".app-main .pb-work-row").find((x) => x.querySelector(".pb-workline-words")?.textContent === ${JSON.stringify(TODO)})?.querySelector(".app-activity-detail")?.textContent ?? null`);
    check(T("the row opens to the reason"), rowWhy === TODO_WHY, rowWhy);
    await ev(`$$(".app-main .pb-work-row").find((x) => x.querySelector(".pb-workline-words")?.textContent === ${JSON.stringify(TODO)})?.scrollIntoView({ block: "center" })`);
    await picture(`todo-${theme}-${phone ? phone.tag : "laptop"}`);
    await houseRules(M(where));
  }
}
