// The window check, section "3b". Run it alone: node scripts/ui-check.mjs --only=3b
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

// ================================================================ step 3b: fast mode as a choice
// docs/build/step-3b.md, Part B. The mock gives the four GPT models a fast mode ("2x speed, increased
// usage" on GPT-6.1 Sol and GPT-6 Astra, "1.5x speed" on GPT-6.1 Terra and GPT-6 Luna) and the Claude
// models none. In the gpt scene HubSpot tickets is a GPT bot (GPT-6.1 Terra, high) with fast off, and
// Kaja's turn has a fourth helper on GPT-6.1 Terra at extra high effort in fast mode. &nofast= takes
// the fast mode from a model, &nohint= its words, &fastfails=1 makes the engine refuse a change.
export default async function section() {
  step3b: {
  const fastShots = arg("fast-shots") ?? (shots ? join(shots, "fast") : undefined);
  if (fastShots) mkdirSync(fastShots, { recursive: true });
  /** A picture of one thing on screen with a little room around it. */
  async function fShot(name, selector) {
    if (!fastShots) return;
    await sleep(450);
    let clip;
    if (selector) {
      const r = await ev(`(() => { const b = (${selector}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
      const pad = 16;
      if (r && !r.error) clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
    }
    const { result } = await b.cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    writeFileSync(join(fastShots, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  async function space() {
    const base = { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    await b.cmd("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: " " });
    await b.cmd("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(40);
  }
  const CLAUDE = "Fable 5.2|Opus 5.5|Sonnet 5.5|Haiku 5.5";
  const GPT = "GPT-6.1 Sol|GPT-6.1 Terra|GPT-6 Luna|GPT-6 Astra";
  /** Words the person must never read (docs/build/step-3b.md, rules). */
  const JARGON = /service tier|priority|harness|provider|app-server|session id|\bthread\b/i;
  const botOf = (id) => `window.pobotsState().bots.find((b) => b.id === ${JSON.stringify(id)})`;
  // The picker and a dialog arrive (a fade and a rise of 6px over dur-calm): measuring starts after.
  const openPicker = async () => {
    await ev(`click($('.pb-composer button[aria-haspopup="dialog"]'))`);
    const ok = await until(`!!$(".app-picker")`);
    await settled(".app-picker");
    return ok;
  };
  /** Waits until the arrival of what `sel` names has ended (its animations, under load too). */
  const settled = async (sel) => {
    await sleep(300);
    await until(`(() => { const el = $(${JSON.stringify(sel)}); return !!el && el.getAnimations({ subtree: true }).every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity); })()`, 3000);
    await sleep(100);
  };
  const closePicker = async () => {
    if (await ev(`!!$(".app-picker")`)) await key("Escape");
    await until(`!$(".app-picker")`);
  };
  const modelSection = `$$(".app-settings .pb-section").find((s) => s.querySelector(".pb-section-title")?.textContent === "Model and effort")`;
  const ACCENT = `(() => { const d = document.createElement("div"); d.style.background = "var(--accent)"; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })()`;
  const pickModelIn = (scope, label) => `click($$("${scope} .pb-option").find((o) => o.childNodes[0]?.textContent.trim() === ${JSON.stringify(label)}))`;
  const pickChoice = (sel, label) => `click($$(${JSON.stringify(sel)}).find((x) => x.textContent === ${JSON.stringify(label)}))`;

  /** What the picker shows of the switch. */
  const pickerFast = `(() => { const p = $(".app-picker"); if (!p) return null; const side = p.querySelector(".pb-picker-side"), room = side.querySelector(".pb-fast-room"), sw = side.querySelector('[role="switch"]'); const efforts = $$(".pb-option:not(.pb-fast-option)", side); const r = (e) => e.getBoundingClientRect(); const R = (x) => Math.round(x * 10) / 10; const d = sw?.getAttribute("aria-describedby"); return {
      room: !!room, roomH: room ? R(r(room).height) : null, sw: !!sw, tag: sw?.tagName ?? null, checked: sw?.getAttribute("aria-checked") ?? null, name: sw?.getAttribute("aria-label") ?? null, shown: sw?.querySelector(".pb-fast-name")?.textContent ?? null,
      hint: sw?.querySelector(".pb-fast-hint")?.textContent ?? null, described: d ? (document.getElementById(d)?.textContent ?? "missing") : null,
      last: sw ? sw === $$(".pb-option", side).at(-1) && r(sw).top >= r(efforts.at(-1)).bottom - 0.5 && !!sw.closest('[aria-label="Effort"]') : null,
      hintWhole: sw?.querySelector(".pb-fast-hint") ? sw.querySelector(".pb-fast-hint").scrollWidth <= sw.querySelector(".pb-fast-hint").clientWidth : null,
      error: p.querySelector(".app-picker-error")?.textContent ?? "", words: p.innerText,
    }; })()`;
  /** Where everything of the picker and the message box stands; with `sw` also the switch's own box. */
  const pickerLayout = (sw) => `() => { const p = document.querySelector(".app-picker"); if (!p) return "closed"; const side = p.querySelector(".pb-picker-side"), s = side.querySelector('[role="switch"]'); const r = (e) => e.getBoundingClientRect(); const R = (x) => Math.round(x * 10) / 10;
      const parts = [p, ...p.querySelectorAll('.pb-picker-col[aria-label="Model"] .pb-option, .pb-picker-col[aria-label="Model"] .pb-picker-group'), side, ...side.querySelectorAll(".pb-option:not(.pb-fast-option), .pb-picker-title, .pb-fast-room"), p.querySelector(".pb-pop-foot"), document.querySelector(".pb-composer"), document.querySelector(".pb-composer .pb-send")${sw ? ", ...(s ? [s, s.querySelector('.pb-switch-quiet')] : [])" : ""}];
      return parts.flatMap((e) => [r(e).top, r(e).left, r(e).height, r(e).width]).map(R).join(","); }`;
  const settingsLayout = (sw) => `() => { const s = [...document.querySelectorAll(".app-settings .pb-section")].find((x) => x.querySelector(".pb-section-title")?.textContent === "Model and effort"); if (!s) return "gone"; const f = s.querySelector(".pb-fast"); const r = (e) => e.getBoundingClientRect(); const R = (x) => Math.round(x * 10) / 10;
      const parts = [...s.children, s.nextElementSibling, s.querySelector('[aria-label="Effort"]')${sw ? ", ...(f ? [f, f.querySelector('.pb-switch-quiet'), f.querySelector('.pb-fast-name')] : [])" : ""}];
      return parts.flatMap((e) => [r(e).top, r(e).left, r(e).height, r(e).width]).map(R).join(","); }`;
  const addLayout = (sw) => `() => { const d = document.querySelector(".pb-dialog"); if (!d) return "gone"; const f = d.querySelector(".pb-fast"); const r = (e) => e.getBoundingClientRect(); const R = (x) => Math.round(x * 10) / 10;
      const parts = [d, ...d.querySelectorAll(".pb-field, .pb-effort-box, .pb-dialog-actions")${sw ? ", ...(f ? [f, f.querySelector('.pb-switch-quiet')] : [])" : ""}];
      return parts.flatMap((e) => [r(e).top, r(e).left, r(e).height, r(e).width]).map(R).join(",") + "|" + d.querySelector(".pb-dialog-form").scrollHeight; }`;
  /** Watches a layout on every change of the page and every frame until `stopWatch`. */
  const startWatch = (layoutFn) => `(() => { const L = ${layoutFn}; window.__fw = [L()]; window.__fwObs = new MutationObserver(() => window.__fw.push(L())); window.__fwObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); window.__fwOn = true; const tick = () => { if (!window.__fwOn) return; window.__fw.push(L()); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`;
  const stopWatch = `(() => { window.__fwOn = false; window.__fwObs.disconnect(); const a = window.__fw; return { samples: a.length, first: a[0], bad: a.filter((x) => x !== a[0]).slice(0, 2) }; })()`;
  const still = (w) => !!w && w.samples > 1 && w.bad.length === 0;
  const composerWords = `(() => { const b = $('.pb-composer button[aria-haspopup="dialog"]'); return { small: b.querySelector("small").textContent, aria: b.getAttribute("aria-label") }; })()`;

  for (const theme of ["dark", "light"]) {
    const T = (name) => `${theme}: fast: ${name}`;

    // ---------------- the picker of a GPT bot with fast off
    await open("scene=gpt", { theme });
    await goTo("HubSpot tickets", "chat");
    let cw = await ev(composerWords);
    check(T("the message box of a GPT bot with fast off says the effort only"), cw?.small === "High" && cw.aria === "Model: GPT-6.1 Terra, effort High. Change model", cw);
    await openPicker();
    let pf = await ev(pickerFast);
    check(T("the picker of a GPT model: a switch named Fast under the efforts, at the end of the effort column, off"), pf?.sw && pf.tag === "BUTTON" && pf.name === "Fast" && pf.shown === "Fast" && pf.checked === "false" && pf.last === true, pf);
    check(T("beside its name the model's words, whole, said to a screen reader too"), pf?.hint === "1.5x speed" && pf.described === "1.5x speed" && pf.hintWhole === true, pf);
    check(T("the picker reads no jargon"), !JARGON.test(pf?.words ?? ""), pf?.words);
    const quiet = `(() => { const side = $(".app-picker .pb-picker-side"); const sw = side.querySelector('[role="switch"]'); const opt = side.querySelector(".pb-option:not(.pb-fast-option)"); const note = side.querySelector(".pb-option:not(.pb-fast-option) .pb-option-note"); const name = sw.querySelector(".pb-fast-name"), hint = sw.querySelector(".pb-fast-hint"), track = sw.querySelector(".pb-switch-quiet"); const s = (e, p) => getComputedStyle(e, p); return {
        nameSize: s(name).fontSize, optSize: s(opt).fontSize, nameColor: s(name).color, optColor: s(opt).color, nameWeight: s(name).fontWeight, optWeight: s(opt).fontWeight,
        hintSize: hint ? s(hint).fontSize : null, noteSize: note ? s(note).fontSize : null, hintColor: hint ? s(hint).color : null, noteColor: note ? s(note).color : null,
        track: s(track).backgroundColor, knob: s(track, "::after").backgroundColor, knobAt: s(track, "::after").transform, accent: ${ACCENT} }; })()`;
    const qOff = await ev(quiet);
    check(T("as quiet as an effort option: the same type size, weight and ink; the words like the note Default"), qOff && qOff.nameSize === qOff.optSize && qOff.nameColor === qOff.optColor && qOff.nameWeight === qOff.optWeight && qOff.hintSize === qOff.noteSize && qOff.hintColor === qOff.noteColor, qOff);
    await houseRules(T("the picker with the switch"));
    await fShot(`picker-gpt-off-${theme}`, `$(".app-picker")`);

    // Switched on from the picker: saved at once, the picker stays open, nothing moves.
    await ev(startWatch(pickerLayout(true)));
    await ev(`click($('.app-picker [role="switch"]'))`);
    const savedOn = await until(`${botOf("hubspot-tickets")}.fast === true && $('.app-picker [role="switch"]')?.getAttribute("aria-checked") === "true"`);
    await sleep(400);
    let w = await ev(stopWatch);
    check(T("switching it on in the picker saves at once (bot.update fast) and the switch shows it"), !!savedOn);
    check(T("the picker stays open"), (await ev(`!!$(".app-picker")`)) === true);
    check(T("nothing in the picker or the message box moved, and the switch kept its width (measured on every change and frame)"), still(w), w);
    const qOn = await ev(quiet);
    check(T("on, it calls for no colour: the track is grey, never the accent, on and off; the knob moves"), qOn && qOn.track !== qOn.accent && qOff.track !== qOff.accent && qOn.knob !== qOn.accent && qOn.track !== qOff.track && qOn.knobAt !== qOff.knobAt, { qOff, qOn });
    cw = await ev(composerWords);
    check(T("the message box now says High, fast, and its name for a screen reader too"), cw?.small === "High, fast" && cw.aria === "Model: GPT-6.1 Terra, effort High, fast. Change model", cw);
    await fShot(`picker-gpt-on-${theme}`, `$(".app-picker")`);

    // Keyboard: Space and Enter, the arrow keys and Tab.
    await ev(`$('.app-picker [role="switch"]').focus()`);
    await space();
    check(T("Space switches it off"), !!(await until(`${botOf("hubspot-tickets")}.fast === false && $('.app-picker [role="switch"]').getAttribute("aria-checked") === "false" && document.activeElement === $('.app-picker [role="switch"]')`)));
    await key("Enter");
    check(T("Enter switches it on again, and the picker stays open"), !!(await until(`${botOf("hubspot-tickets")}.fast === true && $('.app-picker [role="switch"]').getAttribute("aria-checked") === "true" && !!$(".app-picker")`)));
    const ring = await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; })()`);
    check(T("the switch shows the focus ring"), ring === true);
    await ev(`$$(".app-picker .pb-picker-side .pb-option")[0].focus()`);
    for (let i = 0; i < 4; i++) await key("ArrowDown");
    const atMax = await ev(`document.activeElement?.childNodes[0]?.textContent.trim()`);
    await key("ArrowDown");
    const atSwitch = await ev(`document.activeElement?.getAttribute("role") === "switch"`);
    await key("ArrowDown");
    const stays = await ev(`document.activeElement?.getAttribute("role") === "switch"`);
    await key("ArrowUp");
    const back = await ev(`document.activeElement?.childNodes[0]?.textContent.trim()`);
    check(T("the arrow keys walk the efforts and reach the switch at the end of the column, and back"), atMax === "Max" && atSwitch === true && stays === true && back === "Max", { atMax, atSwitch, stays, back });
    await ev(`$$(".app-picker .pb-picker-side .pb-option").find((o) => o.childNodes[0]?.textContent.trim() === "Max").focus()`);
    await key("Tab");
    check(T("Tab from the last effort reaches the switch"), (await ev(`document.activeElement?.getAttribute("role") === "switch" && !!document.activeElement.closest(".app-picker")`)) === true);
    // Choosing an effort still closes the picker; the message box says Extra high, fast.
    await ev(pickModelIn(".app-picker .pb-picker-side", "Extra high"));
    await until(`!$(".app-picker")`);
    cw = await ev(composerWords);
    check(T("the message box reads Extra high, fast"), cw?.small === "Extra high, fast" && cw.aria === "Model: GPT-6.1 Terra, effort Extra high, fast. Change model", cw);
    await fShot(`composer-fast-${theme}`, `$(".pb-composer")`);

    // A Claude bot: no switch in the picker, but its room is kept; the message box says no fast.
    await goTo("Kaja", "chat");
    cw = await ev(composerWords);
    check(T("a Claude bot's message box says its effort only"), cw?.small === "High" && !cw.aria.includes("fast"), cw);
    await openPicker();
    pf = await ev(pickerFast);
    check(T("the picker of a Claude model shows no switch, and keeps its room"), pf?.sw === false && pf.room === true && !pf.words.includes("Fast"), pf);
    await fShot(`picker-claude-${theme}`, `$(".app-picker")`);
    await closePicker();

    // A Claude bot moves to GPT-6 Luna in the picker: the switch comes, on, and nothing moves.
    await goTo("Onboardings", "chat");
    await openPicker();
    await ev(startWatch(pickerLayout(false)));
    await ev(pickModelIn(".app-picker .pb-picker-col", "GPT-6 Luna"));
    const came = await until(`${botOf("onboardings")}.model === "gpt-6-luna" && $('.app-picker [role="switch"]')?.getAttribute("aria-checked") === "true"`);
    await sleep(400);
    w = await ev(stopWatch);
    check(T("choosing a GPT model shows the switch as the bot has it (on), with that model's words"), !!came && (await ev(pickerFast))?.hint === "1.5x speed");
    check(T("nothing in the picker moved when the switch came"), still(w), w);
    await ev(startWatch(pickerLayout(false)));
    await ev(pickModelIn(".app-picker .pb-picker-col", "GPT-6.1 Sol"));
    const sol = await until(`${botOf("onboardings")}.model === "gpt-6.1-sol" && $(".app-picker .pb-fast-hint")?.textContent === "2x speed, increased usage"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("another GPT model brings its own words, whole, and nothing moves"), !!sol && (await ev(pickerFast))?.hintWhole === true && still(w), w);
    await ev(startWatch(pickerLayout(false)));
    await ev(pickModelIn(".app-picker .pb-picker-col", "Opus 5.5"));
    const left = await until(`${botOf("onboardings")}.model === "claude-opus-5-5" && !$('.app-picker [role="switch"]')`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("back to a Claude model the switch leaves, fast stays as it was, and nothing moves"), !!left && (await ev(`${botOf("onboardings")}.fast`)) === true && still(w), w);
    await closePicker();

    // ---------------- a GPT model without a fast mode, and one without words
    await open("scene=gpt&nofast=gpt-6-astra", { theme });
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    await ev(`click($('.app-picker [role="switch"]'))`);
    await until(`${botOf("hubspot-tickets")}.fast === true`);
    await ev(startWatch(pickerLayout(false)));
    await ev(pickModelIn(".app-picker .pb-picker-col", "GPT-6 Astra"));
    const gone = await until(`${botOf("hubspot-tickets")}.model === "gpt-6-astra" && !$('.app-picker [role="switch"]')`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("a GPT model without a fast mode: the switch leaves, fast is not changed, nothing moves"), !!gone && (await ev(`${botOf("hubspot-tickets")}.fast`)) === true && still(w), w);
    cw = await ev(composerWords);
    check(T("and the message box says no fast for it"), cw?.small === "High" && !cw.aria.includes("fast"), cw);
    await ev(pickModelIn(".app-picker .pb-picker-col", "GPT-6.1 Terra"));
    check(T("back on a model with a fast mode the switch shows as it was"), !!(await until(`${botOf("hubspot-tickets")}.model === "gpt-6.1-terra" && $('.app-picker [role="switch"]')?.getAttribute("aria-checked") === "true"`)));
    await closePicker();
    await open("scene=gpt&nohint=gpt-6.1-terra", { theme });
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    pf = await ev(pickerFast);
    check(T("a model with a fast mode and no words: the switch, and nothing beside its name"), pf?.sw && pf.hint === null && pf.described === null, pf);
    if (theme === "dark") await fShot("picker-no-hint-dark", `$(".app-picker")`);
    await closePicker();
    await open("codex=off", { theme });
    await goTo("Onboardings", "chat");
    await openPicker();
    pf = await ev(pickerFast);
    check(T("with no model with a fast mode in the list, no switch and no room for one"), pf?.sw === false && pf.room === false, pf);
    await closePicker();

    // ---------------- the engine refuses: said where the picker's errors go
    await open("scene=gpt&fastfails=1", { theme });
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    await ev(startWatch(pickerLayout(true)));
    await ev(`click($('.app-picker [role="switch"]'))`);
    const err = await until(`$(".app-picker .app-picker-error")?.textContent`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("a refusal shows where the picker's errors show, the switch stays as it was, the picker stays open"), err === "Fast mode could not be changed just now." && (await ev(`$('.app-picker [role="switch"]').getAttribute("aria-checked")`)) === "false" && (await ev(`${botOf("hubspot-tickets")}.fast`)) === false, err);
    check(T("nothing moved for the refusal"), still(w), w);
    await closePicker();

    // ---------------- Settings
    await open("scene=gpt", { theme });
    await goTo("HubSpot tickets", "settings");
    const setFast = `(() => { const s = ${modelSection}; const f = s.querySelector(".pb-fast"); if (!f) return { sw: false }; const r = (e) => e.getBoundingClientRect(); const seg = s.querySelector('[aria-label="Effort"]'); const on = f.querySelector(".pb-fast-hint[data-show]"); const d = f.getAttribute("aria-describedby"); const gs = (e, p) => getComputedStyle(e, p); const name = f.querySelector(".pb-fast-name"), track = f.querySelector(".pb-switch-quiet");
        const up = seg.querySelector('[aria-pressed="false"]'), down = seg.querySelector('[aria-pressed="true"]');
        return { sw: true, role: f.getAttribute("role"), name: f.getAttribute("aria-label"), checked: f.getAttribute("aria-checked"), shown: gs(f).visibility === "visible" && !f.inert && f.getAttribute("aria-hidden") !== "true", focusable: f.tabIndex >= 0 && !f.inert,
          hint: on?.textContent ?? null, described: d ? (document.getElementById(d)?.textContent ?? "missing") : null,
          besideEffort: !!f.closest(".pb-effort-line") && f.closest(".pb-effort-line") === seg.parentElement, sameLine: Math.abs(r(f).top + r(f).height / 2 - (r(seg).top + r(seg).height / 2)) <= 1, under: r(f).top >= r(seg).bottom - 0.5,
          nameSize: gs(name).fontSize, segSize: gs(down).fontSize, nameWeight: gs(name).fontWeight, segWeight: gs(down).fontWeight, nameColor: gs(name).color, upColor: up ? gs(up).color : null, downColor: gs(down).color,
          track: gs(track).backgroundColor, accent: ${ACCENT}, words: s.innerText }; })()`;
    let sf = await ev(setFast);
    check(T("settings of a GPT bot: the switch Fast with the effort choice, off, with the model's words"), sf?.sw && sf.role === "switch" && sf.name === "Fast" && sf.checked === "false" && sf.shown && sf.focusable && sf.besideEffort && (sf.sameLine || sf.under) && sf.hint === "1.5x speed" && sf.described === "1.5x speed", sf);
    check(T("settings: the same type as an effort, the ink of an effort not chosen while off, never the accent"), sf && sf.nameSize === sf.segSize && sf.nameWeight === sf.segWeight && sf.nameColor === sf.upColor && sf.track !== sf.accent, sf);
    check(T("the settings read no jargon"), !JARGON.test(sf?.words ?? ""), sf?.words);
    await houseRules(T("settings with the switch"));
    await ev(`inPanel(${modelSection})`);
    await fShot(`settings-gpt-off-${theme}`, modelSection);
    await ev(startWatch(settingsLayout(true)));
    await ev(`click(${modelSection}.querySelector(".pb-fast"))`);
    const setOn = await until(`${botOf("hubspot-tickets")}.fast === true && ${modelSection}.querySelector(".pb-fast").getAttribute("aria-checked") === "true" && ${modelSection}.querySelector(".pb-saved")?.textContent === "Saved"`);
    await sleep(400);
    w = await ev(stopWatch);
    check(T("settings: switching it on saves it the way effort is saved, and says Saved"), !!setOn);
    check(T("settings: nothing moved when it was switched, and the switch kept its width"), still(w), w);
    sf = await ev(setFast);
    check(T("on, its name takes the ink of a chosen effort, the track stays grey"), sf?.nameColor === sf?.downColor && sf.track !== sf.accent, sf);
    await fShot(`settings-gpt-on-${theme}`, modelSection);
    await ev(`${modelSection}.querySelector(".pb-fast").focus()`);
    await space();
    check(T("settings: Space switches it off"), !!(await until(`${botOf("hubspot-tickets")}.fast === false && ${modelSection}.querySelector(".pb-fast").getAttribute("aria-checked") === "false"`)));
    await key("Enter");
    check(T("settings: Enter switches it on"), !!(await until(`${botOf("hubspot-tickets")}.fast === true && ${modelSection}.querySelector(".pb-fast").getAttribute("aria-checked") === "true"`)));
    await ev(`$$('.app-settings [aria-label="Effort"] button').at(-1).focus()`);
    await key("Tab");
    check(T("settings: Tab from the last effort reaches the switch"), (await ev(`document.activeElement?.classList.contains("pb-fast")`)) === true);

    // A Claude bot in Settings: out of sight and out of reach, its room kept; moving to GPT shows it.
    await goTo("Onboardings", "settings");
    sf = await ev(setFast);
    check(T("settings of a Claude bot: no switch to see or reach, its room kept"), sf?.sw && !sf.shown && !sf.focusable && sf.hint === null && !sf.words.includes("Fast"), sf);
    await ev(`$$('.app-settings [aria-label="Effort"] button').at(-1).focus()`);
    await key("Tab");
    check(T("settings of a Claude bot: Tab passes it by"), (await ev(`!document.activeElement?.classList.contains("pb-fast")`)) === true);
    await ev(`inPanel(${modelSection})`);
    await ev(startWatch(settingsLayout(true)));
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "GPT-6 Luna"));
    const setCame = await until(`${botOf("onboardings")}.model === "gpt-6-luna" && ${setFast}.shown`);
    await sleep(400);
    w = await ev(stopWatch);
    check(T("settings: choosing a GPT model shows the switch, on as the bot has it, and nothing moves"), !!setCame && (await ev(setFast))?.checked === "true" && still(w), w);
    await ev(startWatch(settingsLayout(true)));
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "GPT-6.1 Sol"));
    const setSol = await until(`${botOf("onboardings")}.model === "gpt-6.1-sol" && ${setFast}.hint === "2x speed, increased usage"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("settings: another model's words take the place of the first, and nothing moves"), !!setSol && still(w), w);
    await ev(startWatch(settingsLayout(true)));
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "Opus 5.5"));
    const setLeft = await until(`${botOf("onboardings")}.model === "claude-opus-5-5" && !${setFast}.shown`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("settings: back on Claude the switch leaves, fast unchanged, nothing moves"), !!setLeft && (await ev(`${botOf("onboardings")}.fast`)) === true && still(w), w);
    await fShot(`settings-claude-${theme}`, modelSection);

    // A GPT model without a fast mode, and one without words, in Settings.
    await open("scene=gpt&nofast=gpt-6-astra", { theme });
    await goTo("HubSpot tickets", "settings");
    await ev(`inPanel(${modelSection})`);
    await ev(startWatch(settingsLayout(true)));
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "GPT-6 Astra"));
    const setGone = await until(`${botOf("hubspot-tickets")}.model === "gpt-6-astra" && !${setFast}.shown`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("settings: a GPT model without a fast mode hides it, fast unchanged, nothing moves"), !!setGone && (await ev(`${botOf("hubspot-tickets")}.fast`)) === false && still(w), w);
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "GPT-6.1 Terra"));
    check(T("settings: back on GPT-6.1 Terra it shows as it was"), !!(await until(`${setFast}.shown && ${setFast}.checked === "false"`)));
    await open("scene=gpt&nohint=gpt-6.1-terra", { theme });
    await goTo("HubSpot tickets", "settings");
    sf = await ev(setFast);
    check(T("settings: a model with a fast mode and no words shows the switch and nothing beside it"), sf?.shown && sf.hint === null && sf.described === null, sf);
    await open("codex=off", { theme });
    await goTo("Onboardings", "settings");
    check(T("settings: with no model with a fast mode in the list there is no switch at all"), (await ev(`!${modelSection}.querySelector(".pb-fast")`)) === true);
    await open("scene=gpt&fastfails=1", { theme });
    await goTo("HubSpot tickets", "settings");
    await ev(`inPanel(${modelSection})`);
    await ev(startWatch(settingsLayout(true)));
    await ev(`click(${modelSection}.querySelector(".pb-fast"))`);
    const setErr = await until(`(() => { const l = ${modelSection}.querySelector(".pb-model-note-line[data-show]"); return l && l.classList.contains("app-hint-error") ? l.textContent : null; })()`);
    await sleep(300);
    w = await ev(stopWatch);
    // Not beside the title: a sentence there can wrap in a narrow column (an artifact open beside the
    // chat, as earlier parts of this check leave it) and move the page.
    check(T("settings: a refusal takes the line's place under the choices in clay, the switch stays off, nothing moves"), setErr === "Fast mode could not be changed just now." && (await ev(setFast))?.checked === "false" && (await ev(`!${modelSection}.querySelector('.pb-saved[role="alert"]')`)) === true && still(w), { setErr, w });

    // ---------------- Add a bot
    await open("", { theme });
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    await settled(".pb-dialog");
    const addFast = `(() => { const f = $(".pb-dialog .pb-fast"); if (!f) return { sw: false }; const box = $(".pb-dialog .pb-effort-box"); const r = (e) => e.getBoundingClientRect(); return { sw: true, checked: f.getAttribute("aria-checked"), shown: getComputedStyle(f).visibility === "visible" && !f.inert, focusable: f.tabIndex >= 0 && !f.inert, hint: f.querySelector(".pb-fast-hint[data-show]")?.textContent ?? null, besideEffort: !!f.closest(".pb-label-row")?.contains($("#add-effort")) && f.closest(".pb-field") === box.closest(".pb-field"), onLabelLine: Math.abs(r(f).top + r(f).height / 2 - (r($("#add-effort")).top + r($("#add-effort")).height / 2)) <= 2 && r(f).bottom <= r(box).top + 0.5, sheetScrolls: $(".pb-dialog").scrollHeight > $(".pb-dialog").clientHeight + 1 }; })()`;
    let af = await ev(addFast);
    check(T("Add a bot with Opus 5.5 chosen: no switch to see or reach, its room kept"), af?.sw && !af.shown && !af.focusable, af);
    const addFirst = await ev(`(${addLayout(false)})()`);
    const addAll = [];
    for (const m of (CLAUDE + "|" + GPT).split("|")) {
      await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, m));
      await sleep(30);
      addAll.push({ m, layout: await ev(`(${addLayout(false)})()`), shown: (await ev(addFast))?.shown });
    }
    check(T("Add a bot: the switch shows for the GPT models only"), addAll.every((x) => x.shown === GPT.split("|").includes(x.m)), addAll.map((x) => `${x.m}:${x.shown}`));
    check(T("Add a bot: the sheet and every field keep their place and size for every model"), addAll.every((x) => x.layout === addFirst), addAll.filter((x) => x.layout !== addFirst).slice(0, 2));
    await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6 Luna"));
    af = await ev(addFast);
    check(T("Add a bot with GPT-6 Luna: the switch with the effort choice, on the line of its label, on by default, with its words"), af?.shown && af.checked === "true" && af.hint === "1.5x speed" && af.besideEffort && af.onLabelLine, af);
    check(T("Add a bot: the sheet does not need scrolling for it at 820 px"), af?.sheetScrolls === false, af);
    await houseRules(T("Add a bot with the switch"));
    await fShot(`add-bot-luna-${theme}`, `$(".pb-dialog")`);
    const sheetWith = await ev(`$(".pb-dialog .pb-dialog-form").scrollHeight`);
    await ev(startWatch(addLayout(true)));
    await ev(`$(".pb-dialog .pb-fast").focus()`);
    await space();
    await until(`$(".pb-dialog .pb-fast").getAttribute("aria-checked") === "false"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("Add a bot: Space switches it off, and nothing moves"), (await ev(`$(".pb-dialog .pb-fast").getAttribute("aria-checked")`)) === "false" && still(w), w);
    await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, "Opus 5.5"));
    await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6 Luna"));
    check(T("Add a bot: the choice made stays when the model changes and comes back"), (await ev(addFast))?.checked === "false");
    await ev(`$$('.pb-dialog [aria-labelledby="add-model"] button').at(-1).focus()`);
    await key("Tab");
    check(T("Add a bot: Tab from the last model reaches the switch, and the next Tab the efforts"), (await ev(`document.activeElement?.classList.contains("pb-fast")`)) === true);
    await key("Tab");
    const nextAfter = await ev(`!!document.activeElement?.closest('[aria-labelledby="add-effort"]')`);
    await key("Tab", 8);
    check(T("Add a bot: after the switch come the efforts"), nextAfter === true && (await ev(`document.activeElement?.classList.contains("pb-fast")`)) === true);
    await key("Enter");
    check(T("Add a bot: Enter switches it on again"), (await until(`$(".pb-dialog .pb-fast").getAttribute("aria-checked") === "true"`)) === true);
    await ev(`$("#add-name").focus()`);
    await type("Fast Test");
    await ev(`click(btn("Create bot"))`);
    const madeOn = await until(`(() => { const b = window.pobotsState().bots.find((x) => x.name === "Fast Test"); return b ? { model: b.model, fast: b.fast } : null; })()`);
    check(T("Add a bot: fast is sent with the create, on by default, and the bot has it"), madeOn?.model === "gpt-6-luna" && madeOn.fast === true, madeOn);
    await goTo("Fast Test", "settings");
    check(T("and its settings show the switch on"), (await ev(`${modelSection}.querySelector(".pb-fast")?.getAttribute("aria-checked")`)) === "true");
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6.1 Sol"));
    await ev(`click($(".pb-dialog .pb-fast"))`);
    await ev(`$("#add-name").focus()`);
    await type("Calm Test");
    await ev(`click(btn("Create bot"))`);
    const madeOff = await until(`(() => { const b = window.pobotsState().bots.find((x) => x.name === "Calm Test"); return b ? { model: b.model, fast: b.fast } : null; })()`);
    check(T("Add a bot: switched off, the bot is made with fast off"), madeOff?.model === "gpt-6.1-sol" && madeOff.fast === false, madeOff);
    // Without any model with a fast mode the switch has no room, and the sheet is as tall.
    await open("nofast=gpt-6.1-sol,gpt-6.1-terra,gpt-6-luna,gpt-6-astra", { theme });
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    const sheetWithout = await ev(`!$(".pb-dialog .pb-fast") && $(".pb-dialog .pb-dialog-form").scrollHeight`);
    check(T("Add a bot: with no model with a fast mode there is no switch, and the sheet is no taller with it"), typeof sheetWithout === "number" && sheetWith === sheetWithout, { sheetWith, sheetWithout });
    await key("Escape");

    // ---------------- a helper's label
    // At the chat's own width: an artifact or the browser left open beside the chat by an earlier part
    // of this check (kept for the tab) would leave too little room for any label to be whole.
    await ev(`sessionStorage.removeItem("pobots.artifactPanel")`);
    await open("scene=gpt", { theme });
    await goTo("Kaja", "chat");
    await until(`!!$(".app-main .pb-worked")`);
    await ev(`(() => { for (const w of $$('.app-main .pb-worked[aria-expanded="false"]')) w.click(); return true; })()`);
    const rowSel = (title) => `$$(".app-main .pb-helper").find((r) => r.querySelector(".pb-helper-title").textContent.startsWith(${JSON.stringify(title)}))`;
    await until(`!!${rowSel("Review the change")}`);
    const rowFacts = (title) => `(() => { const r = ${rowSel(title)}; if (!r) return null; const b = r.getBoundingClientRect(), t = r.querySelector(".pb-helper-title"), m = r.querySelector(".pb-helper-model"), last = r.querySelector(".pb-helper-last"); const R = (x) => Math.round(x * 10) / 10; return {
        label: m?.textContent ?? null, labelWhole: m ? m.scrollWidth <= m.clientWidth : null, titleCut: t.scrollWidth > t.clientWidth, aria: r.getAttribute("aria-label"),
        height: R(b.height), titleTop: R(t.getBoundingClientRect().top - b.top), lastTop: R(last.getBoundingClientRect().top - b.top) }; })()`;
    const review = await ev(rowFacts("Review the change"));
    const terra = await ev(rowFacts("Try the new picker"));
    check(T("a helper in fast mode says so at the end of its label: GPT-6.1 Terra, extra high, fast"), review?.label === "GPT-6.1 Terra, extra high, fast" && review.labelWhole && review.aria.includes("Helper on GPT-6.1 Terra, extra high, fast"), review);
    check(T("a helper not in fast mode does not"), terra?.label === "GPT-6.1 Terra, high", terra);
    check(T("both rows keep one height and the same places"), [review, terra].every((r) => r?.height === 52 && r.titleTop === terra.titleTop && r.lastTop === terra.lastTop), { review, terra });
    await houseRules(T("helper rows with fast"));
    await ev(`inPanel(${rowSel("Try the new picker")}.closest(".pb-helper-group"))`);
    await fShot(`helper-rows-${theme}`, `${rowSel("Try the new picker")}.closest(".pb-helper-group")`);
    // A long title with a label that gets ", fast": the title gives way, nothing moves.
    const longId = await ev(`${rowSel("Read every model picker")}.dataset.helperId`);
    await sleep(500);
    await ev(startWatch(`() => { const s = document.querySelector(".app-main .pb-main-scroll"); const R = (x) => Math.round(x * 10) / 10; return [...document.querySelectorAll(".app-main .pb-thread > *, .app-main .pb-helper, .app-main .pb-helper-title")].map((k) => R(k.getBoundingClientRect().top) + "/" + R(k.getBoundingClientRect().height)).join(",") + "|" + s.scrollTop + "|" + s.scrollHeight; }`));
    await ev(`window.pobotsMock.helperModel(${JSON.stringify(longId)}, "gpt-6.1-terra", "xhigh", true)`);
    await until(`${rowSel("Read every model picker")}.querySelector(".pb-helper-model")?.textContent === "GPT-6.1 Terra, extra high, fast"`);
    await sleep(300);
    const longFast = await ev(rowFacts("Read every model picker"));
    await ev(`window.pobotsMock.helperModel(${JSON.stringify(longId)}, "claude-sonnet-5-5")`);
    await until(`${rowSel("Read every model picker")}.querySelector(".pb-helper-model")?.textContent === "Sonnet 5.5"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("a long title gives way to a label with fast: the title is cut, the label whole, one height"), longFast?.label === "GPT-6.1 Terra, extra high, fast" && longFast.labelWhole && longFast.titleCut && longFast.height === 52, longFast);
    check(T("nothing in the chat moved while the longer label came and went"), still(w), w);
    // The top of the helper's thread.
    await ev(`click(${rowSel("Review the change")})`);
    await until(`!!$(".pb-helper-bar")`);
    const top = await ev(`(() => { const bar = $(".pb-helper-bar"), t = $(".pb-helper-bar-title"), m = $(".pb-helper-bar-model"), st = $(".pb-helper-bar-state"); const r = (e) => e.getBoundingClientRect(); return { label: m?.textContent ?? null, height: Math.round(r(bar).height), oneLine: [t, m, st].every((e) => Math.abs(r(e).top + r(e).height / 2 - (r(t).top + r(t).height / 2)) <= 2), words: bar.innerText }; })()`);
    check(T("the top of the helper's thread says fast too, on one line"), top?.label === "GPT-6.1 Terra, extra high, fast" && top.height === 40 && top.oneLine && !JARGON.test(top.words), top);
    await fShot(`helper-bar-${theme}`, `$(".pb-helper-bar")`);
    await ev(`click($(".pb-helper-back"))`);
    await until(`!$(".pb-helper-bar")`);

    // ---------------- 800 px
    await open("scene=gpt", { width: 800, theme });
    await goTo("HubSpot tickets", "chat");
    await openPicker();
    const fits = await ev(`(() => { const r = $(".app-picker").getBoundingClientRect(); const h = $(".app-picker .pb-fast-hint"); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && !!h && h.scrollWidth <= h.clientWidth; })()`);
    check(T("800 px: the picker with the switch fits the window, its words whole"), fits === true, fits);
    await houseRules(T("800 px, the picker with the switch"));
    await closePicker();
    await goTo("HubSpot tickets", "settings");
    await ev(`inPanel(${modelSection})`);
    await ev(startWatch(settingsLayout(true)));
    await ev(`click(${modelSection}.querySelector(".pb-fast"))`);
    await until(`${botOf("hubspot-tickets")}.fast === true`);
    await ev(pickChoice(`.app-settings [aria-label="Model"] button`, "GPT-6.1 Sol"));
    await until(`${botOf("hubspot-tickets")}.model === "gpt-6.1-sol"`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("800 px: settings: switching and another model's words move nothing"), still(w), w);
    await houseRules(T("800 px, settings with the switch"));
    await fShot(`settings-800-${theme}`, modelSection);
    await ev(`click($(".app-add-bot"))`);
    await until(`!!$(".pb-dialog")`);
    await ev(pickChoice(`.pb-dialog [aria-labelledby="add-model"] button`, "GPT-6.1 Sol"));
    await houseRules(T("800 px, Add a bot with the switch"));
    await key("Escape");
    await open("scene=gpt&fastfails=1", { width: 800, theme });
    await goTo("HubSpot tickets", "settings");
    await ev(`inPanel(${modelSection})`);
    await ev(startWatch(settingsLayout(true)));
    await ev(`click(${modelSection}.querySelector(".pb-fast"))`);
    const narrowErr = await until(`${modelSection}.querySelector(".pb-model-note-line.app-hint-error[data-show]")?.textContent`);
    await sleep(300);
    w = await ev(stopWatch);
    check(T("800 px: settings: the refusal under the choices moves nothing"), narrowErr === "Fast mode could not be changed just now." && still(w), { narrowErr, w });
  }
  if (fastShots) console.log(`Step 3b pictures in ${fastShots}`);
  }
}
