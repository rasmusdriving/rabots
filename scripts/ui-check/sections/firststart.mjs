// The window check, section "firststart". Run it alone: node scripts/ui-check.mjs --only=firststart
// Engine 0.33.0 (docs/build/step-first-start.md): a new install's first start and "About you". With no
// bots (?scene=first-run) one calm screen: "Welcome to Pobots", the main bot's name filled in with Po,
// the model choices, one button. Creating sends `welcome`: the main bot greets by itself (the stand-in
// engine, ui/engine/mock-firststart.ts). Settings > General starts with About you: a text box with
// Save that keeps its room, follows a change from the main bot unless there is an edit not saved, and
// says what is wrong without moving anything. An install with bots never sees the screen.
import { check, ev, until, open, shot, houseRules, sleep, type, key } from "../lib.mjs";

const ABOUT = "Ada runs customer onboarding at Example Ltd (example.com).\nShe likes plain words.";
const lastAnswer = `(() => { const all = $$(".pb-msg-body"); return all.length ? all.at(-1).textContent : ""; })()`;
const screen = `({
  title: text(".app-first-title"),
  intro: text(".app-first-text"),
  label: $('label[for="first-name"]')?.textContent,
  name: $("#first-name")?.value,
  focus: document.activeElement?.id,
  picked: $$(".app-first-form [aria-pressed='true']").map((b) => b.textContent),
  models: $$(".app-first-form [aria-pressed]").length,
  button: $$(".app-first-form button[type=submit]").map((b) => b.textContent.trim()),
})`;
const fits = `(() => { const r = $(".app-first-form button[type=submit]").getBoundingClientRect(); const f = $(".app-first-form").getBoundingClientRect(); return { left: Math.round(f.left), right: Math.round(innerWidth - f.right), button: Math.round(r.height), width: innerWidth }; })()`;
const about = `$('.pb-appsettings-section[data-section="about"]')`;
const aboutState = `(() => { const s = ${about}; if (!s) return null; const t = s.querySelector("textarea"); const n = s.querySelector("#about-you-note"); const save = [...s.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
  return { title: s.querySelector(".pb-section-title")?.textContent, intro: s.querySelector(".pb-section-text")?.textContent, value: t?.value, note: n?.textContent, noteH: Math.round(n?.getBoundingClientRect().height ?? 0), alert: n?.getAttribute("role"), save: save ? !save.disabled : null, saved: s.querySelector(".pb-saved")?.hasAttribute("data-show"), foot: Math.round(s.querySelector(".pb-about-foot").getBoundingClientRect().height), box: Math.round(s.getBoundingClientRect().height) }; })()`;

export default async function section() {
  const M = (name) => `firststart: ${name}`;

  // ---------------- the screen, at 1280 and on phones, dark and light
  for (const [theme, width, height] of [["dark", 1280, 820], ["light", 1280, 820], ["dark", 390, 844], ["light", 390, 844], ["light", 360, 780]]) {
    const T = (name) => M(`${name} (${width} ${theme})`);
    await open("scene=first-run", { width, height, theme });
    const s = await until(`(() => { const v = ${screen}; return v.title ? v : null; })()`);
    check(
      T("Welcome to Pobots, the name field says Name your main bot and holds Po, in focus"),
      s?.title === "Welcome to Pobots" && s.label === "Name your main bot" && s.name === "Po" && s.focus === "first-name" && /main bot/.test(s.intro),
      s,
    );
    check(T("the model choices as Add a bot has them, Opus 5.5 chosen, one button Create main bot"), s?.models > 1 && s.picked?.join() === "Opus 5.5" && s.button?.join() === "Create main bot", s);
    const f = await ev(fits);
    check(T("the form keeps its side room and the button is easy to tap"), f && f.left >= 16 && f.right >= 16 && f.button >= (width < 500 ? 44 : 32), f);
    await houseRules(T("the first-start screen"));
    await shot(`firststart-screen-${width}-${theme}`);
  }

  // ---------------- creating the main bot: on Haiku, it greets by itself
  await open("scene=first-run");
  await until(`$("#first-name")?.value === "Po"`);
  await ev(`click($$(".app-first-form [aria-pressed]").find((b) => b.textContent === "Haiku 5.5"))`);
  check(M("choosing a model marks it, nothing else moves"), (await ev(`$$(".app-first-form [aria-pressed='true']").map((b) => b.textContent).join()`)) === "Haiku 5.5");
  await ev(`(() => { const i = $("#first-name"); i.focus(); i.select(); return true; })()`);
  await type("Ada's Po");
  await key("Enter");
  check(M("Create opens the main bot's chat"), !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Ada's Po" && text(".app-head .pb-row-line") === "Main bot" && tabOpen() === "chat"`)));
  check(M("it was made on the model chosen"), !!(await until(`$(".pb-composer")?.textContent.includes("Haiku 5.5")`)));
  check(M("the screen sent welcome: one welcome turn started"), (await ev(`window.pobotsFirstStart.welcomed()`)) === 1);
  const greeting = await until(`(() => { const t = ${lastAnswer}; return /what do you do[?]$/i.test(t.trim()) && !$(".pb-msg-you") ? t : null; })()`, 8000);
  check(M("the main bot greets by itself and asks who they are, with no message of theirs before it"), /Ada.s Po, your main bot/.test(String(greeting)) && /who are you/i.test(String(greeting)), greeting);
  await sleep(300);
  await shot("firststart-greeting");

  // ---------------- an install with bots never sees the screen
  await open("");
  check(M("an install with bots opens on its bots, as before"), !!(await until(`!!$(".pb-shell") && !$(".app-first-body") && $$(".app-row").length > 1`)));

  // ---------------- About you in Settings > General
  for (const theme of ["dark", "light"]) {
    const T = (name) => M(`${name} (${theme})`);
    await open("", { theme });
    await ev(`click($(".pb-foot-settings"))`);
    await until(`!!$(".pb-setwin")`);
    const a0 = await until(aboutState);
    check(
      T("General starts with About you: the words, an empty box, the count, Save waits"),
      (await ev(`$$(".pb-appsettings-section").map((s) => s.dataset.section).join()`)) === "about,notify,chat,backup" &&
        a0?.title === "About you" &&
        /every bot gets/.test(a0.intro) &&
        a0.value === "" &&
        a0.note === "0 of 4,000 characters" &&
        a0.save === false,
      a0,
    );
    await houseRules(T("About you"));
    if (theme === "light") break;

    // Typing and saving: Saved shows beside the title, the box shows what is kept (trimmed).
    await ev(`$("#about-you").focus()`);
    await type(`  ${ABOUT}  `);
    const a1 = await ev(aboutState);
    check(T("typing lights up Save and counts"), a1?.save === true && a1.note === `${ABOUT.length + 4} of 4,000 characters`, a1);
    await ev(`click($$('${'[data-section="about"]'} button').find((b) => b.textContent.trim() === "Save"))`);
    const a2 = await until(`(() => { const v = ${aboutState}; return v?.saved ? v : null; })()`);
    check(T("Save keeps it, Saved shows beside the title, the box shows it trimmed"), a2?.value === ABOUT && a2.save === false && (await ev(`window.pobotsFirstStart.aboutYou()`)) === ABOUT, a2);
    await shot("firststart-about-saved");

    // A change from the main bot shows at once; with an edit not saved, the edit stays.
    await ev(`(window.pobotsFirstStart.fromBot(${JSON.stringify(`${ABOUT}\nShe works from Stockholm.`)}), true)`);
    check(T("a change from the main bot shows at once in the box"), !!(await until(`${about}.querySelector("textarea").value.endsWith("Stockholm.")`)));
    await ev(`$("#about-you").focus()`);
    await type(" Draft");
    await ev(`(window.pobotsFirstStart.fromBot("Something else from the main bot."), true)`);
    await sleep(200);
    check(T("an edit not saved stays when the main bot changes it"), (await ev(`${about}.querySelector("textarea").value.endsWith("Draft")`)) === true);

    // Too long: says so in the count's own place; nothing moves, Save waits.
    const before = await ev(aboutState);
    await ev(`(() => { const t = $("#about-you"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, "x".repeat(4001)); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const a3 = await until(`(() => { const v = ${aboutState}; return v?.alert === "alert" ? v : null; })()`);
    check(T("more than 4,000 characters is said in the count's place, Save waits"), a3?.note === "Keep it under 4,000 characters." && a3.save === false, a3);
    check(T("the line under the box keeps its height"), a3?.foot === before?.foot && a3?.noteH === before?.noteH, { before: before?.foot, after: a3?.foot });
  }

  // The main bot's change leaves a quiet line in its chat, with the word count, never the words.
  await open("");
  await ev(`(window.pobotsFirstStart.fromBot(${JSON.stringify(ABOUT)}), true)`);
  const main = await ev(`$$(".app-row").find((r) => r.querySelector(".pb-row-line")?.textContent === "Main bot")?.querySelector(".pb-row-name")?.textContent`);
  if (main) await ev(`click($$(".app-row").find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(main)}))`);
  const line = await until(`$$(".app-notice").map((n) => n.textContent).find((t) => t.includes("About you")) ?? null`);
  check(M("a quiet line in the main bot's chat says About you was written, with the word count only"), /Pobots settings: About you written \(about \d+ words\)/.test(String(line)) && !String(line).includes("onboarding"), line);
}
