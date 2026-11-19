import { b, check, ev, open, shot, until } from "../lib.mjs";

const target = "HubSpot tickets";
const q = JSON.stringify;
const click = (sel) => ev(`click($(${q(sel)}))`);
const active = '.pb-vacation-list .app-row';
const toggle = ".pb-vacation-toggle";
const readPositions = `$$(${q(active)}).map((r) => [r.getAttribute("aria-label").split(",")[0], r.getBoundingClientRect().y])`;
const chart = () => ev(readPositions);
const noSideways = () => ev(`document.documentElement.scrollWidth <= innerWidth && $$(".app-side, .app-main").every((el) => el.scrollWidth <= el.clientWidth + 1)`);
const stable = `!$$(${q(".pb-vacation-motion")}).some((el) => el.getAnimations().some((a) => a.playState === "running"))`;
const confirm = () => ev('click($("[role=alertdialog] button.pb-btn-primary"))');

async function reload() {
  const before = await ev("performance.timeOrigin");
  await b.cmd("Page.reload", {});
  if (!await until(`performance.timeOrigin !== ${before} && !!$(".pb-shell")`, 7000)) throw new Error("The mock window did not reload.");
}

async function settings(name, phone) {
  await ev(`click($$(${q(active)}).find((r) => r.querySelector(".pb-row-name").textContent === ${q(name)}))`);
  await until(`$(".app-main")?.getAttribute("aria-label") === ${q(name)}`);
  if (phone) {
    await click(".app-phone-page");
    await until('!!$(".app-phone-head[data-page]")');
  }
  await click('.pb-tab[data-tab="settings"]');
  await until(`!!$('[id$="-vacation"]')`);
}

async function backToBots() {
  for (let i = 0; i < 4; i++) {
    const screen = await ev('$("[data-phone-screen]")?.dataset.phoneScreen');
    if (screen === "bots") return;
    const before = await ev("JSON.stringify(history.state)");
    await click(".app-main .app-phone-back");
    await until(`JSON.stringify(history.state) !== ${q(before)} || $("[data-phone-screen]")?.dataset.phoneScreen === "bots"`, 1500);
  }
  throw new Error("The phone could not get back to Bots.");
}

export default async function section() {
  await open("vacation=1&vacationCase=setup");
  await until('new URL(location.href).searchParams.get("vacationCase") === "setup" && !!$(".pb-shell")');
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    const phone = width < 700;
    await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 1 : 0 });
    await b.cmd("Emulation.setUserAgentOverride", { userAgent: width === 390 ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" : width === 360 ? "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36" : "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36" });
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      // Start each walk in a freshly navigated fixture with clean mock state. The reload below
      // tests persistence after the walk changes that state.
      await ev('(() => { localStorage.removeItem("pobots:vacation-shelf-open"); localStorage.removeItem("pobots:mock-vacation"); return true; })()');
      // As in a real tab that opened Pobots after another page, a too-large Back can leave the app.
      await b.cmd("Page.navigate", { url: "about:blank" });
      await until('location.href === "about:blank"');
      await open(`vacation=1&vacationCase=${width}-${theme}`, { width, height, theme });
      await until(`new URL(location.href).searchParams.get("vacationCase") === ${q(width + "-" + theme)} && !!$(".pb-shell")`);
      await until('!!$(".pb-shell") && !!$(".app-side .app-row") && !$(".pb-vacation-shelf:not([data-empty])")');
      if (phone && await ev('$("[data-phone-screen]")?.dataset.phoneScreen === "bot"')) await backToBots();
      await until(stable);
      const original = await chart();
      if (!phone) {
        await settings("Kaja", false);
        check(`vacation: main bot cannot go away at ${where}`, await ev('$(\'[id$="-vacation"]\').closest("section").querySelector("button").disabled'));
      }
      await settings(target, phone);
      await ev('click($(\'[id$="-vacation"]\').closest("section").querySelector("button"))');
      check(`vacation: settings explains the change in a confirm at ${where}`, !!await until('$("[role=alertdialog]")?.textContent.includes("Send HubSpot tickets on vacation?") && $("[role=alertdialog]").textContent.includes("schedules will rest")'));
      const beforeRemove = await chart();
      await confirm();
      const replacement = await until(`$(".app-main")?.getAttribute("aria-label") === "Onboardings" && $(${q(toggle)})?.getAttribute("aria-expanded") === "false"`);
      check(`vacation: next bot selected and shelf starts folded at ${where}`, !!replacement, replacement ? undefined : await ev('({bot: $(".app-main")?.getAttribute("aria-label"), expanded: $(".pb-vacation-toggle")?.getAttribute("aria-expanded"), screen: $("[data-phone-screen]")?.dataset.phoneScreen, history: history.state?.pobotsPhoneView})'));
      if (!phone) check("vacation: the leaving row keeps its box during the fade", (await chart()).at(-1)?.[1] === beforeRemove.at(-1)?.[1]);
      await until(`!$$(${q(active)}).some((r) => r.getAttribute("aria-label").startsWith(${q(target + ",")}))`);
      if (phone) {
        check(`vacation: phone Back leads to Bots after sending away at ${where}`, !!await until('$(".app-main .app-phone-back")?.getAttribute("aria-label") === "Back to Bots"'));
        await backToBots();
      }
      await until(stable);
      const before = await chart();
      await click(toggle);
      await until(stable);
      check(`vacation: opening keeps every active row in place at ${where}`, q(await chart()) === q(before), await chart());
      check(`vacation: shelf row has a face, name and date without sideways scroll at ${where}`, await ev('!!$(".app-vacation-row .pb-avatar") && $(".app-vacation-row .pb-row-line").textContent.startsWith("Since ")') && await noSideways());
      if (!phone) check(`vacation: the hidden action leaves room for the name and date at ${where}`, await ev('$$(".app-vacation-row :is(.pb-row-name, .pb-row-line)").every((el) => el.scrollWidth <= el.clientWidth + 1)'));
      await shot(`vacation-shelf-${width}-${theme}`);
      await click(toggle);
      await until(stable);
      check(`vacation: closing keeps every active row in place at ${where}`, q(await chart()) === q(before));
      await click(toggle);
      await until(stable);
      await reload();
      check(`vacation: expanded preference and bot survive reload at ${where}`, !!await until(`$(${q(toggle)})?.getAttribute("aria-expanded") === "true" && $(".app-vacation-row")?.getAttribute("aria-label") === "HubSpot tickets, on vacation"`));
      if (phone && await ev('$("[data-phone-screen]")?.dataset.phoneScreen === "bot"')) await backToBots();
      if (!phone) {
        await until(stable);
        await ev('$(".pb-vacation-quick").focus({ preventScroll: true })');
        const quick = '(() => { const el = $(".pb-vacation-quick"); return {focused: el === document.activeElement, opacity: getComputedStyle(el).opacity, width: innerWidth}; })()';
        check("vacation: shelf bring-back action appears on keyboard focus", !!await until('$(".pb-vacation-quick") === document.activeElement && Number(getComputedStyle($(".pb-vacation-quick")).opacity) === 1'), await ev(quick));
      }
      await click(".app-vacation-row");
      check(`vacation: opens a read-only chat with Bring back at ${where}`, !!await until('!!$(".pb-vacation-chat") && !$(".app-main .pb-composer") && $(".app-main")?.getAttribute("aria-label") === "HubSpot tickets"'));
      await shot(`vacation-chat-${width}-${theme}`);
      await click(".pb-vacation-chat button");
      check(`vacation: brings it back immediately and restores the composer at ${where}`, !!await until('!!$(".app-main .pb-composer") && !$(".pb-vacation-shelf:not([data-empty])") && $$(".app-notice").some((n) => n.textContent.includes("Back from vacation."))'));
      await until(stable);
      const returned = await chart();
      check(`vacation: active rows return to their original order at ${where}`, q(returned.map(([name]) => name)) === q(original.map(([name]) => name)), returned);
    }
  }
  await b.cmd("Emulation.setTouchEmulationEnabled", { enabled: false });
}
