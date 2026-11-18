// The window check, section "3a". Run it alone: node scripts/ui-check.mjs --only=3a
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 3a: GPT models
// The mock lists the four GPT models after the Claude ones with Codex ready; &codex=off makes Codex
// not signed in, &codex=missing not installed. The "gpt" scene has HubSpot tickets on GPT-6.1 Terra
// and, in Kaja's chat, three helpers: one on GPT-6.1 Terra at high effort, one with a long title on
// Sonnet 5.5, one with no label.
export default async function section() {
  step3a: {
  const gptShots = arg("gpt-shots") ?? (shots ? join(shots, "gpt") : undefined);
  if (gptShots) mkdirSync(gptShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it, or of the whole window. */
  async function gShot(name, selector) {
    if (!gptShots) return;
    await sleep(450);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      if (r && !r.error) clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(gptShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  const CLAUDE = "Fable 5.2|Opus 5.5|Sonnet 5.5|Haiku 5.5";
  const GPT = "GPT-6.1 Sol|GPT-6.1 Terra|GPT-6 Luna|GPT-6 Astra";
  const CHANGE = "Changing between Claude and ChatGPT starts a fresh session. The bot keeps its memory and gets the end of the chat.";
  const REFUSED = "Wait until the bot is done, then change its model.";
  const RUNS = "Runs on Codex with your ChatGPT login.";
  const NOT_SIGNED_IN = "Codex is not signed in. Run codex login in a terminal on the Mac.";
  const MISSING = "Codex is not installed on this Mac.";
  /** Words the person must never read (docs/build/step-3a.md, rules). */
  const JARGON = /harness|provider|app-server|session id|sandbox|dynamic tool|\bthread\b/i;
  const openPicker = async () => {
    await ev(`click($('.pb-composer button[aria-haspopup="dialog"]'))`);
    return until(`!!$(".app-picker")`);
  };
  const picker = `(() => { const p = $(".app-picker"); if (!p) return null; const col = p.querySelector('.pb-picker-col[aria-label="Model"]'); return {
      heads: $$(".pb-picker-group", col).map((h) => h.firstChild.textContent),
      options: $$(".pb-option", col).map((o) => o.childNodes[0].textContent.trim()),
      keys: $$(".pb-option .pb-key", col).length,
      headsFocusable: $$(".pb-picker-group", col).some((h) => h.tabIndex >= 0 || h.tagName === "BUTTON"),
      order: $$(".pb-picker-group, .pb-option", col).map((x) => x.classList.contains("pb-picker-group") ? "#" + x.firstChild.textContent : x.childNodes[0].textContent.trim()).join("|"),
      error: p.querySelector(".app-picker-error")?.textContent ?? "",
      words: p.innerText,
    }; })()`;
  const choices = (scope) => `(() => { const g = ${scope}.querySelector('[aria-label="Model"], [aria-labelledby="add-model"]'); if (!g) return null; return {
      heads: $$(".pb-model-group-title", g).map((h) => h.firstChild.textContent),
      options: $$("button", g).map((x) => x.textContent),
      pressed: $$('button[aria-pressed="true"]', g).map((x) => x.textContent).join("|"),
    }; })()`;
  const modelSection = `$$(".app-settings .pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Model and effort")`;
  const note = `(() => { const s = ${modelSection}; const box = s.querySelector(".pb-model-note"); const on = box.querySelector(".pb-model-note-line[data-show]"); return { shown: on ? on.textContent : "", height: Math.round(box.getBoundingClientRect().height * 10) / 10, visible: $$(".pb-model-note-line", box).filter((l) => getComputedStyle(l).visibility === "visible").length }; })()`;
  const nextTop = `(() => { const s = ${modelSection}; const n = s.nextElementSibling; return Math.round(n.getBoundingClientRect().top * 10) / 10; })()`;
  const saved = `(() => { const w = ${modelSection}.querySelector(".pb-saved"); return { text: w?.textContent ?? "", alert: w?.getAttribute("role") === "alert" }; })()`;
  const botOf = (id) => `window.pobotsState().bots.find((b) => b.id === ${JSON.stringify(id)})`;

  for (const theme of ["dark", "light"]) {
    const T = (name) => `${theme}: ${name}`;

    // ---------------- 1: the picker in two groups
    await open("", { theme });
    await goTo("Onboardings", "chat");
    await openPicker();
    let p = await ev(picker);
    check(T("the picker shows the models in two groups, Claude then ChatGPT, in the engine's order"), JSON.stringify(p?.heads) === '["Claude","ChatGPT"]' && p.order === `#Claude|${CLAUDE}|#ChatGPT|${GPT}`, p);
    check(T("the headings are quiet words, not options: never focused"), p?.headsFocusable === false && p.keys === 4, p);
    check(T("the picker reads no jargon"), !JARGON.test(p?.words ?? ""), p?.words);
    const headStyle = await ev(`(() => { const h = $(".app-picker .pb-picker-group"), o = $(".app-picker .pb-option"); const a = getComputedStyle(h), c = getComputedStyle(o); return { size: parseFloat(a.fontSize), optSize: parseFloat(c.fontSize), color: a.color, optColor: c.color }; })()`);
    check(T("a heading is smaller and quieter than an option"), headStyle && headStyle.size < headStyle.optSize && headStyle.color !== headStyle.optColor, headStyle);
    await houseRules(T("the picker with two groups"));
    await gShot(`picker-groups-${theme}`, `$(".app-picker")`);
    if (theme === "dark") {
      await ev(`$(".app-picker .pb-search").focus()`);
      for (let i = 0; i < 5; i++) await key("ArrowDown");
      check("dark: Down from the search walks the options over the heading into the ChatGPT group", (await ev(`document.activeElement?.childNodes[0]?.textContent.trim()`)) === "GPT-6.1 Sol");
      await key("ArrowUp");
      check("dark: and Up walks back into the Claude group", (await ev(`document.activeElement?.childNodes[0]?.textContent.trim()`)) === "Haiku 5.5");
      await ev(`$(".app-picker .pb-search").focus()`);
      await type("terra");
      p = await ev(picker);
      check("dark: a search keeps the heading of the group it keeps", JSON.stringify(p?.heads) === '["ChatGPT"]' && p.options.join("|") === "GPT-6.1 Terra", p);
      await key("Escape");
    }
    if (await ev(`!!$(".app-picker")`)) await key("Escape");

    // The picker's own refusal: Kaja waits on a card, so a change to the other group waits.
    await goTo("Kaja", "chat");
    await openPicker();
    await ev(`click($$(".app-picker .pb-option").find((o) => o.childNodes[0].textContent.trim() === "GPT-6 Luna"))`);
    check(T("the picker refuses a change between the groups while the bot works, in plain words"), !!(await until(`$(".app-picker .app-picker-error")?.textContent === ${JSON.stringify(REFUSED)}`)) && (await ev(`${botOf("kaja")}.model`)) === "claude-opus-5-5");
    await gShot(`picker-refused-${theme}`, `$(".app-picker")`);
    await key("Escape");

    // ---------------- 2 and 4: one kind only, Codex missing, and a GPT bot's settings
    await open("codex=off", { theme });
    await goTo("Onboardings", "chat");
    await openPicker();
    p = await ev(picker);
    check(T("Codex not ready: the picker shows no ChatGPT group and no headings, as before"), p?.heads.length === 0 && p.options.join("|") === CLAUDE && !(await ev(`!!$(".app-picker .pb-picker-group")`)), p);
    check(T("and says nothing about it there"), !p?.words.includes("Codex"), p?.words);
    await key("Escape");
    check(T("the chat of a Claude bot says nothing about Codex"), (await ev(`$$(".app-line").some((l) => l.textContent.includes("Codex"))`)) === false);
    await goTo("Onboardings", "settings");
    let c = await ev(choices(modelSection));
    check(T("settings: one row of Claude models without headings"), c?.heads.length === 0 && c.options.join("|") === CLAUDE && !(await ev(`!!$(".app-settings .pb-model-group")`)), c);
    let n = await ev(note);
    check(T("settings: one quiet line under the choices says why, in the engine's sentence"), n?.shown === NOT_SIGNED_IN && n.visible === 1, n);
    const quiet = await ev(`(() => { const l = ${modelSection}.querySelector(".pb-model-note-line[data-show]"); const s = getComputedStyle(l); return { color: s.color, muted: getComputedStyle(${modelSection}.querySelector(".pb-hint")).color, role: l.closest("[role]")?.getAttribute("role") }; })()`);
    check(T("the line is quiet like a hint, never a warning"), quiet?.color === quiet?.muted && quiet.role === "status", quiet);
    await houseRules(T("settings without ChatGPT"));
    await ev(`inPanel(${modelSection})`);
    await gShot(`settings-codex-off-${theme}`, modelSection);
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    c = await ev(choices(`$(".pb-dialog")`));
    const addLine = await ev(`(() => { const f = $("#add-model").closest(".pb-field"); return $$(".pb-hint", f).map((h) => h.textContent); })()`);
    check(T("Add a bot: Claude models only, and the engine's sentence under them"), c?.heads.length === 0 && c.options.join("|") === CLAUDE && JSON.stringify(addLine) === JSON.stringify([NOT_SIGNED_IN]), { c, addLine });
    await houseRules(T("Add a bot without ChatGPT"));
    await gShot(`add-bot-codex-off-${theme}`, `$(".pb-dialog")`);
    await key("Escape");

    if (theme === "dark") {
      await open("codex=missing", { theme });
      await goTo("Onboardings", "settings");
      check("dark: Codex not installed: the settings line says so", (await ev(note))?.shown === MISSING);
    }

    // A bot on a GPT model while Codex is not ready.
    await open("scene=gpt&codex=off", { theme });
    await goTo("HubSpot tickets", "chat");
    check(T("a GPT bot's chat shows the Codex sentence where Claude's would be"), !!(await until(`$$(".app-foot .app-line").some((l) => l.textContent === ${JSON.stringify(NOT_SIGNED_IN)})`)));
    await gShot(`chat-gpt-codex-off-${theme}`, `$(".app-foot")`);
    await openPicker();
    p = await ev(picker);
    check(T("its picker keeps the model it is on, under ChatGPT, and no other GPT model"), JSON.stringify(p?.heads) === '["Claude","ChatGPT"]' && p.order === `#Claude|${CLAUDE}|#ChatGPT|GPT-6.1 Terra`, p);
    await key("Escape");
    await goTo("HubSpot tickets", "settings");
    n = await ev(note);
    check(T("its settings say why ChatGPT is missing rather than which program runs it"), n?.shown === NOT_SIGNED_IN, n);
    await goTo("Kaja", "chat");
    check(T("a Claude bot's chat says nothing about Codex then"), (await ev(`$$(".app-line").some((l) => l.textContent.includes("Codex"))`)) === false);

    // ---------------- 4: which program runs a GPT bot; 1: the groups in settings and Add a bot
    await open("scene=gpt", { theme });
    await goTo("HubSpot tickets", "settings");
    c = await ev(choices(modelSection));
    check(T("settings: two groups with quiet headings, the GPT model chosen"), JSON.stringify(c?.heads) === '["Claude","ChatGPT"]' && c.options.join("|") === `${CLAUDE}|${GPT}` && c.pressed === "GPT-6.1 Terra", c);
    const gptNote = await ev(note);
    check(T("a GPT bot's settings say in one quiet line which program runs it"), gptNote?.shown === RUNS && gptNote.visible === 1, gptNote);
    check(T("the settings read no jargon"), !JARGON.test((await ev(`${modelSection}.innerText`)) ?? ""));
    await houseRules(T("a GPT bot's settings"));
    await ev(`inPanel(${modelSection})`);
    await gShot(`settings-gpt-bot-${theme}`, modelSection);
    await goTo("Onboardings", "settings");
    const claudeNote = await ev(note);
    check(T("a Claude bot's settings say nothing about it, and the line's box keeps its height"), claudeNote?.shown === "" && claudeNote.visible === 0 && claudeNote.height === gptNote?.height && claudeNote.height > 0, { claudeNote, gptNote });
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    c = await ev(choices(`$(".pb-dialog")`));
    check(T("Add a bot: the same two groups, Opus 5.5 chosen"), JSON.stringify(c?.heads) === '["Claude","ChatGPT"]' && c.options.join("|") === `${CLAUDE}|${GPT}` && c.pressed === "Opus 5.5", c);
    await houseRules(T("Add a bot with two groups"));
    await gShot(`add-bot-groups-${theme}`, `$(".pb-dialog")`);
    await key("Escape");

    // ---------------- 3: changing a bot between the two
    await goTo("Onboardings", "settings");
    const before = await ev(nextTop);
    await ev(`(() => { window.__nt = []; const s = ${modelSection}.nextElementSibling; const o = new ResizeObserver(() => window.__nt.push(Math.round(s.getBoundingClientRect().top * 10) / 10)); o.observe(${modelSection}); window.__ntObs = o; return true; })()`);
    await ev(`click($$('[aria-label="Model"] button').find((x) => x.textContent === "GPT-6 Luna"))`);
    check(T("choosing a GPT model for a Claude bot shows the change line at once"), !!(await until(`${note}.shown === ${JSON.stringify(CHANGE)}`, 1500)));
    check(T("the bot moves to ChatGPT and says Saved"), !!(await until(`${botOf("onboardings")}.harness === "codex" && ${botOf("onboardings")}.model === "gpt-6-luna" && ${saved}.text === "Saved"`)));
    const after = await ev(nextTop);
    const moves = await ev(`(() => { window.__ntObs.disconnect(); return window.__nt; })()`);
    check(T("nothing below the line moved when it came"), before === after && (moves ?? []).every((t) => t === before), { before, after, moves });
    await ev(`inPanel(${modelSection})`);
    await gShot(`settings-change-line-${theme}`, modelSection);
    await goTo("Onboardings", "chat");
    check(T("the chat says it changed, and the composer names the new model"), !!(await until(`$$(".app-main .app-notice").some((x) => x.textContent.includes("Changed from Claude to ChatGPT. The bot starts a fresh session with its memory and the end of this chat."))`)) && (await ev(`$('.pb-composer button[aria-haspopup="dialog"]').textContent.startsWith("GPT-6 Luna")`)) === true);
    await gShot(`chat-changed-notice-${theme}`, `$$(".app-main .app-notice").at(-1)`);
    await goTo("Onboardings", "settings");
    check(T("back on its settings: which program runs it"), (await ev(note))?.shown === RUNS);
    await ev(`click($$('[aria-label="Model"] button').find((x) => x.textContent === "Opus 5.5"))`);
    check(T("and back to Claude: the change line again, then the chat says so"), !!(await until(`${note}.shown === ${JSON.stringify(CHANGE)} && ${botOf("onboardings")}.harness === "claude"`)));
    await goTo("Onboardings", "chat");
    check(T("Changed from ChatGPT to Claude"), !!(await until(`$$(".app-main .app-notice").some((x) => x.textContent.startsWith("Changed from ChatGPT to Claude."))`)));

    // The refusal: Inbox is working.
    await goTo("Inbox", "settings");
    const inboxTop = await ev(nextTop);
    await ev(`click($$('[aria-label="Model"] button').find((x) => x.textContent === "GPT-6.1 Sol"))`);
    check(T("a change between the groups while the bot works is refused in plain words, in the line's place under the choices"), !!(await until(`${note}.shown === ${JSON.stringify(REFUSED)}`)), await ev(note));
    const refusedFacts = await ev(`(() => { const l = ${modelSection}.querySelector(".pb-model-note-line[data-show]"); return { clay: getComputedStyle(l).color === getComputedStyle($(".app-hint-error") ?? l).color && l.classList.contains("app-hint-error"), head: ${saved} }; })()`);
    check(T("said in the colour of an error, and not beside the title"), refusedFacts?.clay === true && refusedFacts.head.alert === false && refusedFacts.head.text === "Saved", refusedFacts);
    check(T("the bot stays where it was"), (await ev(`${botOf("inbox")}.model`)) === "claude-sonnet-5-5" && (await ev(`$('[aria-label="Model"] [aria-pressed="true"]').textContent`)) === "Sonnet 5.5");
    const inboxAfter = await ev(nextTop);
    check(T("nothing moved for the refusal"), inboxAfter === inboxTop, { before: inboxTop, after: inboxAfter });
    await houseRules(T("settings with a refusal"));
    await ev(`inPanel(${modelSection})`);
    await gShot(`settings-refused-${theme}`, modelSection);

    // ---------------- 5: a helper's model
    await goTo("Kaja", "chat");
    await until(`!!$(".app-main .pb-worked")`);
    await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
    const rowSel = (title) => `$$(".app-main .pb-helper").find((r) => r.querySelector(".pb-helper-title").textContent.startsWith(${JSON.stringify(title)}))`;
    await until(`!!${rowSel("Try the new picker")}`);
    const rowFacts = (title) => `(() => { const r = ${rowSel(title)}; if (!r) return null; const b = r.getBoundingClientRect(), t = r.querySelector(".pb-helper-title"), m = r.querySelector(".pb-helper-model"), last = r.querySelector(".pb-helper-last"); return {
        label: m?.textContent ?? null, labelWhole: m ? m.scrollWidth <= m.clientWidth : null, titleCut: t.scrollWidth > t.clientWidth,
        height: Math.round(b.height * 10) / 10, titleTop: Math.round((t.getBoundingClientRect().top - b.top) * 10) / 10, lastTop: Math.round((last.getBoundingClientRect().top - b.top) * 10) / 10,
        labelAfter: m ? m.getBoundingClientRect().left >= t.getBoundingClientRect().right - 0.5 : null, aria: r.getAttribute("aria-label"),
        labelColor: m ? getComputedStyle(m).color : null, lastColor: getComputedStyle(last).color, titleSize: parseFloat(getComputedStyle(t).fontSize), labelSize: m ? parseFloat(getComputedStyle(m).fontSize) : null,
      }; })()`;
    const terra = await ev(rowFacts("Try the new picker"));
    const sonnet = await ev(rowFacts("Read every model picker"));
    const plain = await ev(rowFacts("Count the open cards"));
    check(T("a helper the bot put on GPT-6.1 Terra at high effort says so after its title"), terra?.label === "GPT-6.1 Terra, high" && terra.labelAfter === true && terra.aria.includes("Helper on GPT-6.1 Terra, high"), terra);
    check(T("the label is quiet: smaller than the title, in the muted ink of the line under it"), terra?.labelSize < terra?.titleSize && terra.labelColor === terra.lastColor, terra);
    check(T("a helper with a model and no effort shows the model's name"), sonnet?.label === "Sonnet 5.5", sonnet);
    check(T("a long title gives way to the label: the title is cut, the label is whole"), sonnet?.titleCut === true && sonnet.labelWhole === true, sonnet);
    check(T("a helper on the bot's own model has no label"), plain?.label === null, plain);
    check(T("the rows keep one height and the same places with or without a label"), [terra, sonnet, plain].every((r) => r?.height === 52 && r.titleTop === plain.titleTop && r.lastTop === plain.lastTop), { terra, sonnet, plain });
    await houseRules(T("helper rows with labels"));
    await ev(`inPanel(${rowSel("Try the new picker")}.closest(".pb-helper-group"))`);
    await gShot(`helper-rows-${theme}`, `${rowSel("Try the new picker")}.closest(".pb-helper-group")`);

    // The label arriving later moves nothing.
    const plainId = await ev(`${rowSel("Count the open cards")}.dataset.helperId`);
    // The chat's own arrivals (each line rises 6px as it comes in) are ended first: in a headless
    // page their clock may still stand at the start here, and a frame that moves them on during the
    // watch read as a move of 1.5px of every line (two full runs on 13 Nov 2026, not in a run of
    // step 3a alone, nor in a third full run). What is watched is the label, not the arrivals.
    await ev(`(() => { for (const a of document.getAnimations()) if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish(); return true; })()`);
    await ev(`(() => { const s = $(".app-main .pb-main-scroll"); const measure = () => ({ tops: $$(".app-main .pb-thread > *, .app-main .pb-helper").map((k) => Math.round(k.getBoundingClientRect().top * 10) / 10).join(","), rows: $$(".app-main .pb-helper").map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10).join(","), title: Math.round(${rowSel("Count the open cards")}.querySelector(".pb-helper-title").getBoundingClientRect().top * 10) / 10, scroll: s.scrollTop, height: s.scrollHeight }); window.__lw = [measure()]; window.__lwObs = new MutationObserver(() => window.__lw.push(measure())); window.__lwObs.observe(s, { subtree: true, childList: true, attributes: true, characterData: true }); return true; })()`);
    await ev(`window.pobotsMock.helperModel(${JSON.stringify(plainId)}, "gpt-6-luna", "low")`);
    check(T("a label that arrives later reads GPT-6 Luna, low"), !!(await until(`${rowSel("Count the open cards")}.querySelector(".pb-helper-model")?.textContent === "GPT-6 Luna, low"`)));
    await ev(`window.pobotsMock.helperModel(${JSON.stringify(plainId)}, "gpt-5.6-luna")`);
    check(T("a model that is not in the list shows its id"), !!(await until(`${rowSel("Count the open cards")}.querySelector(".pb-helper-model")?.textContent === "gpt-5.6-luna"`)));
    await ev(`window.pobotsMock.helperModel(${JSON.stringify(plainId)})`);
    check(T("and with none the label goes"), !!(await until(`!${rowSel("Count the open cards")}.querySelector(".pb-helper-model")`)));
    const lw = await ev(`(() => { window.__lwObs.disconnect(); return window.__lw; })()`);
    const lwBad = (lw ?? []).filter((x) => JSON.stringify(x) !== JSON.stringify(lw[0]));
    check(T("nothing moved while the label came, changed and went"), (lw?.length ?? 0) > 1 && lwBad.length === 0, { samples: lw?.length, bad: lwBad.slice(0, 2), first: lw?.[0] });

    // The top of the helper's own thread.
    await ev(`click(${rowSel("Try the new picker")})`);
    await until(`!!$(".pb-helper-bar")`);
    const top = await ev(`(() => { const bar = $(".pb-helper-bar"), t = $(".pb-helper-bar-title"), m = $(".pb-helper-bar-model"), st = $(".pb-helper-bar-state"); const r = (e) => e.getBoundingClientRect(); return { label: m?.textContent ?? null, height: Math.round(r(bar).height), oneLine: [t, m, st].every((e) => Math.abs(r(e).top + r(e).height / 2 - (r(t).top + r(t).height / 2)) <= 2), after: r(m).left >= r(t).right - 0.5 && r(st).left >= r(m).right, words: bar.innerText }; })()`);
    check(T("the top of the helper's thread names its model after the title, on one line"), top?.label === "GPT-6.1 Terra, high" && top.height === 40 && top.oneLine && top.after && !JARGON.test(top.words), top);
    await houseRules(T("a helper's thread with its model"));
    await gShot(`helper-bar-${theme}`, `$(".pb-helper-bar")`);
    await ev(`click($(".pb-helper-back"))`);
    await until(`!$(".pb-helper-bar")`);
    await ev(`click(${rowSel("Count the open cards")})`);
    check(T("a helper without a model has none at the top of its thread"), !!(await until(`!!$(".pb-helper-bar") && !$(".pb-helper-bar-model")`)));
    await ev(`click($(".pb-helper-back"))`);
    await until(`!$(".pb-helper-bar")`);

    // A helper the bot starts on GPT, live.
    await goTo("Onboardings", "chat");
    await ev(`window.pobotsMock.holdHelpers(true)`);
    await ev(`$(".pb-composer textarea").focus()`);
    await type("Start a helper on GPT to try the picker.");
    await key("Enter");
    check(T("a helper started on GPT carries its label while it works"), !!(await until(`(() => { const r = $$(".app-main .pb-helper").at(-1); return r?.dataset.status === "running" && r.querySelector(".pb-helper-model")?.textContent === "GPT-6.1 Terra, high" && Math.round(r.getBoundingClientRect().height) === 52; })()`, 5000)));
    if (theme === "dark") {
      await ev(`inPanel($$(".app-main .pb-helper").at(-1))`);
      await gShot("helper-row-working-dark", `$$(".app-main .pb-helper").at(-1)`);
    }
    await ev(`window.pobotsMock.holdHelpers(false)`);
    await until(`$$(".app-main .pb-helper").at(-1)?.dataset.status === "done"`, 6000);

    // ---------------- 800 px
    await open("scene=gpt", { width: 800, theme });
    await goTo("Kaja", "chat");
    await until(`!!$(".app-main .pb-worked")`);
    await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
    await until(`!!${rowSel("Read every model picker")}`);
    const narrow = await ev(rowFacts("Read every model picker"));
    check(T("800 px: the long title still gives way to the label, one height"), narrow?.label === "Sonnet 5.5" && narrow.labelWhole && narrow.titleCut && narrow.height === 52, narrow);
    await houseRules(T("800 px, helper rows with labels"));
    await ev(`inPanel(${rowSel("Try the new picker")}.closest(".pb-helper-group"))`);
    await gShot(`helper-rows-800-${theme}`, `${rowSel("Try the new picker")}.closest(".pb-helper-group")`);
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    const fits = await ev(`(() => { const r = $(".app-picker").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()`);
    check(T("800 px: the picker with two groups fits the window"), fits === true, fits);
    await houseRules(T("800 px, the picker"));
    await gShot(`picker-groups-800-${theme}`, `$(".app-picker")`);
    await key("Escape");
    await goTo("HubSpot tickets", "settings");
    await houseRules(T("800 px, a GPT bot's settings"));
    await ev(`inPanel(${modelSection})`);
    await gShot(`settings-gpt-bot-800-${theme}`, modelSection);
  }

  // ================================================================ step 3a, after the tester
  // docs/build/step-3a-fixes.md: (1) the heading of the group a bot is not on says quietly "starts a
  // fresh session", in the picker and in Settings, before the choice; (2) "Add a bot" has an effort
  // choice under the model; (3) the chat's header says "Stopped" after Stop.
  const FRESH = "starts a fresh session";
  const EFFORTS5 = "Low|Medium|High|Extra high|Max";
  /** Each heading of the groups in `scope`: its name, its note, and where its parts stand. */
  const headsOf = (scope, sel) => `(() => { const sc = ${scope}; if (!sc) return null; return $$(${JSON.stringify(sel)}, sc).map((h) => { const n = h.querySelector(".pb-group-name"), q = h.querySelector(".pb-group-note"); const r = (e) => e.getBoundingClientRect(); const hn = getComputedStyle(n), hq = q ? getComputedStyle(q) : null; return {
      name: n?.textContent ?? null, note: q?.textContent ?? null, height: Math.round(r(h).height * 10) / 10,
      oneLine: !q || (Math.abs(r(q).top - r(n).top) <= 0.5 && Math.abs(r(q).height - r(n).height) <= 0.5 && r(q).left >= r(n).right),
      quieter: !q || (hq.color !== hn.color && Number(hq.fontWeight) < Number(hn.fontWeight) && hq.fontSize === hn.fontSize),
      whole: !q || h.scrollWidth <= h.clientWidth,
    }; }); })()`;
  const pickerHeads = headsOf(`$('.app-picker .pb-picker-col[aria-label="Model"]')`, ".pb-picker-group");
  const settingsHeads = headsOf(modelSection, ".pb-model-group-title");
  /** Claude plain and ChatGPT with the note for a bot on Claude; the other way round for a GPT bot. */
  const headsSay = (h, side) => Array.isArray(h) && h.length === 2 && h[0].name === "Claude" && h[1].name === "ChatGPT" &&
    h[0].note === (side === "codex" ? FRESH : null) && h[1].note === (side === "claude" ? FRESH : null) &&
    h.every((x) => x.oneLine && x.quieter && x.whole) && h[0].height === h[1].height;
  const effortOf = `(() => { const g = $('.pb-dialog [aria-labelledby="add-effort"]'); if (!g) return null; const box = g.closest(".pb-effort-box"), d = $(".pb-dialog"), f = $(".pb-dialog-form"); return {
      options: $$("button", g).map((x) => x.textContent).join("|"), pressed: $$('button[aria-pressed="true"]', g).map((x) => x.textContent).join("|"),
      box: Math.round(box.getBoundingClientRect().height * 10) / 10, sheet: Math.round(d.getBoundingClientRect().height * 10) / 10, form: f.scrollHeight,
      access: Math.round(($("#add-access").getBoundingClientRect().top - f.getBoundingClientRect().top) * 10) / 10,
      under: $("#add-effort").getBoundingClientRect().top > $("#add-model").closest(".pb-field").getBoundingClientRect().bottom - 0.5,
    }; })()`;
  const pickIn = (sel, label) => `click($$(${JSON.stringify(sel)}).find((x) => x.textContent === ${JSON.stringify(label)}))`;

  for (const theme of ["dark", "light"]) {
    const T = (name) => `${theme}: after the tester: ${name}`;

    // ---------------- 1: the heading says it before the choice
    await open("scene=gpt", { theme });
    await goTo("Onboardings", "chat");
    await openPicker();
    let h = await ev(pickerHeads);
    check(T("the picker of a bot on Claude: ChatGPT's heading says quietly that choosing there starts a fresh session, Claude's is plain"), headsSay(h, "claude"), h);
    const aria = await ev(`(() => { const o = (l) => $$(".app-picker .pb-option").find((x) => x.childNodes[0].textContent.trim() === l)?.getAttribute("aria-label"); return { gpt: o("GPT-6 Luna"), claude: o("Sonnet 5.5") }; })()`);
    check(T("for a screen reader a ChatGPT option's name says it too, a Claude option's does not"), aria?.gpt === `GPT-6 Luna, ChatGPT, ${FRESH}` && aria.claude === "Sonnet 5.5, Claude", aria);
    await houseRules(T("the picker of a Claude bot"));
    await gShot(`fixes-picker-claude-bot-${theme}`, `$(".app-picker")`);
    await key("Escape");
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    h = await ev(pickerHeads);
    check(T("the picker of a bot on GPT: Claude's heading says it, ChatGPT's is plain"), headsSay(h, "codex"), h);
    await gShot(`fixes-picker-gpt-bot-${theme}`, `$(".app-picker")`);
    await key("Escape");
    await goTo("HubSpot tickets", "settings");
    h = await ev(settingsHeads);
    const groupName = await ev(`(() => $$('.pb-model-groups > .pb-model-group > [role="group"]', ${modelSection}).map((g) => g.getAttribute("aria-label")))()`);
    check(T("settings of a bot on GPT: Claude's heading says it, ChatGPT's is plain"), headsSay(h, "codex"), h);
    check(T("and the group's name for a screen reader includes the words"), JSON.stringify(groupName) === JSON.stringify([`Claude, ${FRESH}`, "ChatGPT"]), groupName);
    await houseRules(T("settings of a GPT bot"));
    await ev(`inPanel(${modelSection})`);
    await gShot(`fixes-settings-gpt-bot-${theme}`, modelSection);
    await goTo("Onboardings", "settings");
    h = await ev(settingsHeads);
    check(T("settings of a bot on Claude: ChatGPT's heading says it, Claude's is plain"), headsSay(h, "claude"), h);
    await ev(`inPanel(${modelSection})`);
    await gShot(`fixes-settings-claude-bot-${theme}`, modelSection);

    // Nothing moves when the bot changes side and the words change heading.
    const layout = `(() => { const s = ${modelSection}; const r = (e) => Math.round(e.getBoundingClientRect().top * 10) / 10 + "/" + Math.round(e.getBoundingClientRect().height * 10) / 10; return [...$$(".pb-model-group-title, .pb-seg", s), s.nextElementSibling].map(r).join(","); })()`;
    const before = await ev(layout);
    await ev(`(() => { window.__fx = []; const s = ${modelSection}; const o = new MutationObserver(() => window.__fx.push(${layout})); o.observe(s, { subtree: true, childList: true, attributes: true, characterData: true }); window.__fxObs = o; return true; })()`);
    await ev(pickIn(`.app-settings [aria-label="Model"] button`, "GPT-6 Luna"));
    await until(`${botOf("onboardings")}.harness === "codex" && ${saved}.text === "Saved"`);
    h = await ev(settingsHeads);
    check(T("once the bot is on GPT the words stand on Claude's heading"), headsSay(h, "codex"), h);
    const after = await ev(layout);
    const fx = await ev(`(() => { window.__fxObs.disconnect(); return window.__fx; })()`);
    check(T("nothing moved when the words changed heading"), before === after && (fx ?? []).every((x) => x === before), { before, after, bad: (fx ?? []).filter((x) => x !== before).slice(0, 2) });
    await goTo("Onboardings", "chat");
    await openPicker();
    h = await ev(pickerHeads);
    check(T("and its picker says it on Claude's heading now"), headsSay(h, "codex"), h);
    await key("Escape");

    // Plain headings in Add a bot, and no headings with one kind only.
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    const addHeads = await ev(headsOf(`$(".pb-dialog")`, ".pb-model-group-title"));
    check(T("Add a bot: both headings stay plain"), addHeads?.length === 2 && addHeads.every((x) => x.note === null) && addHeads.map((x) => x.name).join("|") === "Claude|ChatGPT", addHeads);
    await key("Escape");
    await open("codex=off", { theme });
    await goTo("Onboardings", "chat");
    await openPicker();
    check(T("one kind only: no headings and no words in the picker"), (await ev(`!$(".app-picker .pb-picker-group") && !$(".app-picker .pb-group-note") && !$(".app-picker").innerText.includes(${JSON.stringify(FRESH)})`)) === true);
    await key("Escape");
    await goTo("Onboardings", "settings");
    check(T("one kind only: none in Settings either"), (await ev(`!${modelSection}.querySelector(".pb-model-group-title, .pb-group-note")`)) === true);

    // ---------------- 2: effort in Add a bot
    await open("", { theme });
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    let e = await ev(effortOf);
    check(T("Add a bot: an effort choice under the model, the model's efforts, its default chosen"), e?.options === EFFORTS5 && e.pressed === "Medium" && e.under === true, e);
    await houseRules(T("Add a bot with effort"));
    await gShot(`fixes-add-bot-effort-${theme}`, `$(".pb-dialog")`);
    const first = e;
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-effort"] button`, "Max"));
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-model"] button`, "Haiku 5.5"));
    e = await ev(effortOf);
    check(T("the efforts follow the model, and one the new model lacks falls back to its default"), e?.options === "Low|Medium|High" && e.pressed === "Medium", e);
    const same = (x) => x && x.box === first.box && x.sheet === first.sheet && x.form === first.form && x.access === first.access;
    check(T("the sheet keeps its height with fewer efforts"), same(e), { first, e });
    if (theme === "dark") await gShot("fixes-add-bot-effort-haiku-dark", `$(".pb-dialog")`);
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-effort"] button`, "High"));
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6 Luna"));
    e = await ev(effortOf);
    check(T("an effort the new model has stays chosen"), e?.options === EFFORTS5 && e.pressed === "High", e);
    const heights = [];
    for (const m of (CLAUDE + "|" + GPT).split("|")) {
      await ev(pickIn(`.pb-dialog [aria-labelledby="add-model"] button`, m));
      heights.push(await ev(effortOf));
    }
    check(T("the sheet's height is the same for every model"), heights.every(same), heights.filter((x) => !same(x)).slice(0, 2));
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6 Luna"));
    await ev(pickIn(`.pb-dialog [aria-labelledby="add-effort"] button`, "Extra high"));
    await ev(`$("#add-name").focus()`);
    await type("Luna Test");
    await ev(`click(btn("Create bot"))`);
    const made = await until(`(() => { const b = window.pobotsState().bots.find((x) => x.name === "Luna Test"); return b ? { model: b.model, effort: b.effort, harness: b.harness } : null; })()`);
    check(T("the chosen effort is sent with the create, and the bot has it"), made?.model === "gpt-6-luna" && made.effort === "xhigh" && made.harness === "codex", made);
    await goTo("Luna Test", "settings");
    check(T("its settings show that effort"), (await ev(`$('.app-settings [aria-label="Effort"] [aria-pressed="true"]')?.textContent`)) === "Extra high");

    // ---------------- 3: the header after Stop
    await open("scene=gpt&stopped=hubspot-tickets", { theme });
    await goTo("HubSpot tickets", "chat");
    const head = `(() => { const s = $(".app-head .pb-status"); const m = s.querySelector(".pb-mark"); return { word: s.textContent, done: s.classList.contains("pb-status-done"), mark: m.className, color: getComputedStyle(s).color, row: $$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "HubSpot tickets")?.innerText ?? "" }; })()`;
    const stoppedHead = await ev(head);
    check(T("a bot that was stopped: the header says Stopped, with the mark and tone of Done, as the roster does"), stoppedHead?.word === "Stopped" && stoppedHead.done && stoppedHead.mark.includes("pb-mark-done") && stoppedHead.row.includes("Stopped"), stoppedHead);
    await houseRules(T("the header after Stop"));
    await gShot(`fixes-head-stopped-${theme}`, `$(".app-head")`);
    await ev(`$(".pb-composer textarea").focus()`);
    await type("Say hello.");
    await key("Enter");
    const doneHead = await until(`(() => { const b = ${botOf("hubspot-tickets")}; if (b.state !== "done" || b.activity === "Stopped") return null; return { ...${head}, activity: b.activity }; })()`, 8000);
    check(T("after a turn that ends any other way the header says Done again, in the same tone"), doneHead?.word === "Done" && doneHead.done && doneHead.mark === stoppedHead?.mark && doneHead.color === stoppedHead?.color, doneHead);
  }
  if (gptShots) console.log(`Step 3a pictures in ${gptShots}`);
  }
}
