// The window check, section "flow-guides". Run it alone: node scripts/ui-check.mjs --only=flow-guides
// The setup guides for the Power Automate flows (20 Nov 2026, docs/build/step-flow-guides.md): one quiet
// line in Settings, Calendar and on a channel's page under "What the flow sends", saying the main bot has
// a guide and can go through it. Shown whether or not the flow is set up, so nothing moves when it is;
// it holds no path. Laptop and phone, light and dark.
import { check, ev, until, open, shot, houseRules, sleep } from "../lib.mjs";

const CALENDAR_LINE = "The main bot has a guide for setting up the flow and can go through it with you.";
const TEAMS_LINE = "The main bot has a guide for setting up both flows and can go through it with you.";
const OPS = "Ops - Internal";

async function toRoster() {
  const phone = await ev(`!!$(".app-shell")?.dataset.phoneScreen`);
  if (!phone) return;
  const shown = `$$(".pb-channel-row").some((r) => r.checkVisibility())`;
  for (let i = 0; i < 6 && !(await ev(shown)); i++) {
    await ev(`(history.back(), true)`);
    await sleep(250);
  }
}

/** The line, where it stands and whether it fits: the page does not scroll sideways, the line is inside its section. */
const lineAt = (kind) => `(() => {
  const p = $('[data-guide="${kind}"]');
  if (!p || !p.checkVisibility()) return null;
  const r = p.getBoundingClientRect();
  const s = p.closest(".pb-section").getBoundingClientRect();
  return { text: p.textContent.trim(), fits: r.left >= s.left - 1 && r.right <= s.right + 1 && document.documentElement.scrollWidth <= innerWidth, next: p.nextElementSibling?.tagName, prev: p.previousElementSibling?.className };
})()`;

async function calendar(T, theme, width, connected) {
  await ev(`click($(".pb-foot-settings"))`);
  await until(`!!$("#setwin-tab-calendar")`);
  await ev(`click($("#setwin-tab-calendar"))`);
  await until(`!!$(".pb-calendar")`);
  const got = await until(lineAt("calendar"));
  check(T(`Settings, Calendar has the guide line (${connected ? "set up" : "not set up"})`), got?.text === CALENDAR_LINE && got.fits, got);
  check(T("it stands under the paragraph on what the calendar is"), got?.prev === "pb-section-text", got);
  check(T("it names no path"), !(got?.text ?? "").includes("/"), got);
  await houseRules(T("Settings, Calendar"));
  await shot(`flow-guides-calendar-${connected ? "set" : "empty"}-${theme}-${width}`);
}

export default async function section() {
  const M = (name) => `flow-guides: ${name}`;
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);

      // ---------------- the calendar, not set up and set up: the same line in the same place
      await open("", { width, height, theme });
      await calendar(T, theme, width, false);
      await open("calendar=1", { width, height, theme });
      await calendar(T, theme, width, true);

      // ---------------- a channel's page: the line under "What the flow sends", above the fold
      await open("posts=1", { width, height, theme });
      await toRoster();
      await ev(`click($$(".pb-channel-row").find((r) => r.querySelector(".pb-channel-name").textContent === ${JSON.stringify(OPS)}))`);
      await until(`$(".app-channel")?.getAttribute("aria-label") === ${JSON.stringify(OPS)}`);
      await ev(`$('[data-guide="teams"]')?.scrollIntoView({ block: "center" })`);
      const got = await until(lineAt("teams"));
      check(T("a channel's page has the guide line under What the flow sends"), got?.text === TEAMS_LINE && got.fits && got.prev === "pb-section-title", got);
      // Opening what the flow sends keeps the line where it was.
      const y = `$('[data-guide="teams"]').getBoundingClientRect().y`;
      const before = await ev(y);
      await ev(`click($$(".pb-channel-page button").find((b) => b.textContent === "Show what the flow should send"))`);
      await until(`!!$(".pb-flow")`);
      check(T("opening what the flow sends keeps the line in place"), Math.abs((await ev(y)) - before) < 1, { before, after: await ev(y) });
      await houseRules(T("a channel's page"));
      await shot(`flow-guides-channel-${theme}-${width}`);
    }
  }
}
