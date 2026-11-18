// The window check, section "base". Run it alone: node scripts/ui-check.mjs --only=base
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

export default async function section() {
  everything: {
  // ---------------- adding a bot
  await open("");
  check("the window opens on the mock", !!(await ev(`!!$(".pb-shell")`)));
  check("Chat is the default tab", (await ev(`tabOpen()`)) === "chat");
  await ev(`click($(".app-add-bot"))`);
  check("the add control opens the sheet", !!(await until(`!!$('.pb-dialog[role="dialog"]')`)));
  check("the name field has focus", (await ev(`document.activeElement?.id`)) === "add-name");
  check("defaults are filled in: Opus 5.5, its default effort Medium (step 3a, after the tester) and Asks first", (await ev(`$$('.pb-dialog [aria-pressed="true"]').map((x) => x.textContent).join("|")`)) === "Opus 5.5|Medium|Asks first");
  check("Create bot waits for a name", (await ev(`btn("Create bot").disabled`)) === true);
  await type("Reports");
  await ev(`$("#add-purpose").focus()`);
  await type("Writes the weekly customer report");
  await ev(`$("#add-job").focus()`);
  await type("Every Friday, collect the week and write one page.");
  await houseRules("add sheet");
  await shot("add-bot-sheet");
  await ev(`click(btn("Create bot"))`);
  check("Create bot opens the new bot's chat", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Reports" && tabOpen() === "chat" && !$(".pb-dialog")`)));
  check("the new bot is in the roster", !!(await ev(`$$(".pb-row-name").some((x) => x.textContent === "Reports")`)));
  check("its job holds what was typed", ((await ev(`window.pobotsMock.read("reports", "AGENTS.md")`)) ?? "").includes("Every Friday, collect the week"));
  await ev(`$(".app-add-bot").focus()`);
  await key("Enter");
  await until(`!!$(".pb-dialog")`);
  await key("Escape");
  check("Escape closes the sheet and focus returns to the add control", !!(await until(`!$(".pb-dialog") && document.activeElement?.classList.contains("app-add-bot")`)));

  // ---------------- tabs
  await goTo("Kaja");
  for (const tab of ["job", "files", "triggers", "history", "settings", "chat"]) {
    await ev(`click($('.pb-tab[data-tab="${tab}"]'))`);
    check(`the ${tab} tab opens`, !!(await until(`tabOpen() === "${tab}" && $('.pb-tab[aria-selected="true"]').dataset.tab === "${tab}"`)));
  }
  await ev(`$('.pb-tab[aria-selected="true"]').focus()`);
  await key("ArrowRight");
  check("arrow keys move between tabs", !!(await until(`tabOpen() === "job" && document.activeElement?.dataset.tab === "job"`)));
  await key("ArrowLeft");
  await until(`tabOpen() === "chat"`);
  await ev(`click($('.pb-tab[data-tab="settings"]'))`);
  await until(`tabOpen() === "settings"`);
  const row = (name) => `click($$(".app-row").find((r) => r.querySelector(".pb-row-name").textContent === "${name}"))`;
  await ev(row("Inbox"));
  check("another bot opens on its own tab (Chat)", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Inbox" && tabOpen() === "chat"`)));
  await ev(row("Kaja"));
  check("each bot keeps its open tab while the app is open", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Kaja" && tabOpen() === "settings"`)));

  // ---------------- the job: edit and save
  await goTo("Kaja", "job");
  check("the job loads into the editor", !!(await until(`!$(".pb-editor-text").disabled && $(".pb-editor-text").value.startsWith("# Kaja")`)));
  check("Save is dimmed before a change", (await ev(`btn("Save").disabled`)) === true);
  await ev(`(() => { const t = $(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
  await type("\n- Added by the check.\n");
  check("Save lights up after a change and the bar says Not saved", !!(await until(`!btn("Save").disabled && text(".pb-editor-state") === "Not saved"`)));
  await shot("job-unsaved");
  await ev(`click(btn("Save"))`);
  check("Save saves and says Saved", !!(await until(`text(".pb-editor-state") === "Saved" && btn("Save").disabled`)));
  check("the saved text is in the bot's folder", ((await ev(`window.pobotsMock.read("kaja", "AGENTS.md")`)) ?? "").includes("- Added by the check."));
  await houseRules("job");
  await shot("job-saved");

  // ---------------- conflicts
  await ev(`(() => { const t = $(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
  await type("- Typed while Kaja changes the file.\n");
  await ev(`window.pobotsMock.botWrites("kaja", "AGENTS.md", "# Kaja\\n\\nKaja rewrote this.\\n")`);
  check("a change underneath with unsaved text is said, not replaced, and says who", !!(await until(`text(".pb-editor-note").includes("Kaja changed this file while you were editing") && $(".pb-editor-text").value.includes("Typed while Kaja")`)));
  await shot("job-changed-underneath");
  await ev(`click(btn("Save"))`);
  check("saving over a newer version hits a conflict", !!(await until(`text(".pb-editor-note").includes("changed after you opened it")`)));
  await shot("job-conflict");
  await ev(`click(btn("Keep editing"))`);
  check("Keep editing keeps the text and says the next save replaces", !!(await until(`!$(".pb-editor-note") && text(".app-editor-hint").startsWith("Saving now replaces")`)));
  await ev(`click(btn("Save"))`);
  check("then Save goes through", !!(await until(`text(".pb-editor-state") === "Saved"`)) && ((await ev(`window.pobotsMock.read("kaja", "AGENTS.md")`)) ?? "").includes("Typed while Kaja"));
  await ev(`(() => { const t = $(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
  await type("- One more line.\n");
  await ev(`window.pobotsMock.botWrites("kaja", "AGENTS.md", "# Kaja\\n\\nThe newest version.\\n")`);
  await until(`!!$(".pb-editor-note")`);
  await ev(`click(btn("Load the new version"))`);
  check("Load the new version replaces the text with the newer one", !!(await until(`$(".pb-editor-text").value === "# Kaja\\n\\nThe newest version.\\n" && !$(".pb-editor-note")`)));
  await ev(`window.pobotsMock.botWrites("kaja", "AGENTS.md", "# Kaja\\n\\nChanged again, nothing typed.\\n")`);
  check("without unsaved text a change underneath simply loads", !!(await until(`$(".pb-editor-text").value.includes("Changed again")`)));

  // ---------------- leaving unsaved text asks first
  await ev(`(() => { const t = $(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
  await type("Not saved yet.");
  await ev(`click($('.pb-tab[data-tab="files"]'))`);
  check("leaving with unsaved text asks first", !!(await until(`text(".pb-dialog-title") === "Leave without saving?"`)));
  await houseRules("leave confirm");
  await shot("leave-confirm");
  await ev(`click(btn("Keep editing"))`);
  check("Keep editing stays on the job with the text", !!(await until(`!$(".pb-dialog") && tabOpen() === "job" && $(".pb-editor-text").value.endsWith("Not saved yet.")`)));
  await ev(`click($$(".app-row")[2])`);
  check("switching bots asks too", !!(await until(`text(".pb-dialog-title") === "Leave without saving?"`)));
  await ev(`click(btn("Leave without saving"))`);
  check("Leave without saving goes on", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "HubSpot tickets"`)));

  // ---------------- files: add and remove
  await goTo("Kaja", "files");
  check("the files list loads, grouped, without the job", !!(await until(`$$(".pb-files-title").map((x) => x.textContent).join("|") === "Memory|Skills|Other" && !$$(".pb-file-path").some((x) => x.textContent === "AGENTS.md")`)));
  check("the memory index comes first", (await ev(`$(".pb-file-path")?.textContent`)) === "memory/MEMORY.md");
  check("the open file is in the editor", !!(await until(`$(".pb-editor-path")?.textContent === "memory/MEMORY.md" && !$(".pb-editor-text").disabled`)));
  await houseRules("files");
  await shot("files");
  await ev(`click(btn("New file"))`);
  check("New file asks for a name", (await until(`document.activeElement?.id === "new-file-kaja"`)) === true);
  await type("lindgren notes");
  check("a plain name goes under memory/", (await ev(`text(".app-files-new .pb-file-path")`)) === "memory/lindgren-notes.md");
  await shot("files-new");
  await key("Enter");
  check("the new file opens in the editor", !!(await until(`$(".pb-editor-path")?.textContent === "memory/lindgren-notes.md"`)));
  check("the new file is listed", !!(await until(`$$(".pb-file-path").some((x) => x.textContent === "memory/lindgren-notes.md")`)));
  await ev(`click(btn("Remove"))`);
  check("Remove asks first", !!(await until(`text(".pb-dialog-title") === "Remove memory/lindgren-notes.md?"`)));
  await shot("files-remove-confirm");
  await ev(`click(btn("Remove file"))`);
  check("the file is removed", !!(await until(`!$(".pb-dialog") && !$$(".pb-file-path").some((x) => x.textContent === "memory/lindgren-notes.md")`)));
  check("and gone from the folder", (await ev(`window.pobotsMock.read("kaja", "memory/lindgren-notes.md")`)) === null);

  // ---------------- history: open, page, undo
  await goTo("Kaja", "history");
  check("history lists changes newest first", !!(await until(`text(".pb-change-summary") === "Removed memory/lindgren-notes.md"`)));
  const firstCount = await ev(`$$(".pb-change").length`);
  await ev(`(() => { const s = $(".app-history"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); })()`);
  check("more changes load at the bottom", !!(await until(`$$(".pb-change").length > ${firstCount}`)), firstCount);
  await ev(`$(".app-history").scrollTop = 0`);
  await ev(`click($(".pb-change"))`);
  check("opening a change shows the diff", !!(await until(`$$(".pb-diff-line[data-kind='del']").length > 0 && text(".pb-diff-file").includes("lindgren-notes.md")`)));
  await houseRules("history");
  await shot("history-diff");
  await ev(`click(btn("Undo this change"))`);
  check("Undo asks first", !!(await until(`text(".pb-dialog-title") === "Undo this change?"`)));
  await shot("history-undo-confirm");
  await ev(`click(btn("Undo change"))`);
  check("undo saves a new change on top", !!(await until(`!$(".pb-dialog") && text(".pb-change-summary") === "Undid: Removed memory/lindgren-notes.md"`)));
  check("and the file is back", (await ev(`window.pobotsMock.read("kaja", "memory/lindgren-notes.md")`)) !== null);
  await ev(`click($$(".pb-change").filter((c) => c.querySelector(".pb-change-summary").textContent === "Edited the job").pop())`);
  await until(`!!$(".pb-diff")`);
  await ev(`click(btn("Undo this change"))`);
  await until(`!!$(".pb-dialog")`);
  await ev(`click(btn("Undo change"))`);
  check("an undo that cannot be done cleanly says so and changes nothing", !!(await until(`text('.pb-dialog [role="alert"]').includes("Nothing was changed")`)));
  await key("Escape");

  // ---------------- settings
  await goTo("Inbox", "settings");
  await until(`!!$(".pb-settings")`);
  await houseRules("settings");
  await shot("settings-top");
  await ev(`(() => { const i = $("#set-inbox-purpose"); i.focus(); i.select(); })()`);
  await type("Reads Teams and email for the team");
  await key("Enter");
  check("purpose saves on Enter and says Saved", !!(await until(`$$(".pb-saved[data-show]").some((x) => x.textContent === "Saved")`)));
  await ev(`click($('.pb-face-pick[aria-label="Square eyes, far apart"]'))`);
  check("a new face is chosen and shows in the roster", !!(await until(`$('.pb-face-pick[aria-checked="true"]').getAttribute("aria-label") === "Square eyes, far apart" && $('.app-row[aria-current="true"] .pb-avatar').dataset.eyes === "square"`)));
  await ev(`$('.pb-face-pick[aria-checked="true"]').focus()`);
  await key("ArrowLeft");
  check("arrow keys pick faces", !!(await until(`$('.pb-face-pick[aria-checked="true"]').getAttribute("aria-label") === "Wide eyes, far apart"`)));
  await ev(`click($$('[aria-label="Model"] button').find((x) => x.textContent === "Haiku 5.5"))`);
  check("model changes and its own efforts show", !!(await until(`$('[aria-label="Model"] [aria-pressed="true"]').textContent === "Haiku 5.5" && $$('[aria-label="Effort"] button').length === 3`)));
  await ev(`click($$(".pb-choice").find((x) => x.textContent.startsWith("Full access")))`);
  check("access level changes", !!(await until(`$('.pb-choice[aria-checked="true"] .pb-choice-label').textContent === "Full access"`)));
  check("the main bot is always reachable", (await ev(`text(".pb-peer-always")`)) === "Always");
  await ev(`click($('.pb-switch[aria-label="May message Onboardings"]'))`);
  check("may message can be switched on", !!(await until(`$('.pb-switch[aria-label="May message Onboardings"]').checked`)));
  await ev(`$(".app-settings").scrollTop = 99999`);
  await shot("settings-bottom");
  check("saved rules are listed", (await ev(`$$(".pb-rule").length`)) === 1);
  await ev(`click(btn("Forget"))`);
  check("Forget removes the rule and says when there are none", !!(await until(`$$(".pb-rule").length === 0 && text(".app-settings").includes("Nothing is always allowed. Inbox asks each time.")`)));
  await goTo("Inbox", "chat");
  await goTo("Inbox", "settings");
  check("settings are kept", !!(await until(`$("#set-inbox-purpose").value === "Reads Teams and email for the team" && $('.pb-choice[aria-checked="true"] .pb-choice-label')?.textContent === "Full access"`)));
  await ev(`$(".pb-face-pick[tabindex='0']").focus()`);
  await key("Tab", 8);
  await focusRings("settings", 30);
  await goTo("Kaja", "settings");
  check("the main bot says it may message everyone", !!(await until(`text(".app-settings").includes("Kaja is the main bot, so it may message every bot.")`)));
  check("the main bot cannot be retired while others exist", (await ev(`btn("Retire Kaja").disabled`)) === true);

  // ---------------- retire
  await goTo("Reports", "settings");
  await ev(`$(".app-settings").scrollTop = 99999`);
  await ev(`click(btn("Retire Reports"))`);
  check("Retire asks first and says the folder is archived and the chat kept", !!(await until(`text(".pb-dialog-text").includes("Its folder is archived and its chat is kept")`)));
  await houseRules("retire confirm");
  await shot("retire-confirm");
  await ev(`click($(".pb-dialog .pb-btn-danger"))`);
  check("the bot leaves the roster and the main bot opens", !!(await until(`!$$(".pb-row-name").some((x) => x.textContent === "Reports") && $(".app-main")?.getAttribute("aria-label") === "Kaja"`)));

  // ---------------- folded turns
  await goTo("Kaja", "chat");
  check("a turn the person started is never folded", (await ev(`$$(".pb-fold").length`)) === 0);
  await goTo("Inbox", "chat");
  check("a turn another bot started is one line", !!(await until(`text(".pb-fold") .startsWith("Kaja asked Inbox, 2 messages")`)));
  check("folded items are hidden", !(await ev(`$(".app-tabpanel").innerText.includes("Anything new in the onboarding chat")`)));
  check("the person's own turn after it is shown", !!(await ev(`$(".app-tabpanel").innerText.includes("Keep an eye on Nordvik")`)));
  await ev(`click($(".pb-fold"))`);
  check("the fold opens on click", !!(await until(`$(".pb-fold").getAttribute("aria-expanded") === "true" && $(".pb-fold-body").innerText.includes("Anything new in the onboarding chat") && $(".pb-fold-body").innerText.includes("asked, waits for the answer")`)));
  await houseRules("chat with an open fold");
  await shot("chat-fold-open");
  await ev(`click($(".pb-fold"))`);
  check("and closes again", !!(await until(`$(".pb-fold").getAttribute("aria-expanded") === "false" && !$(".pb-fold-body")`)));
  await goTo("HubSpot tickets", "chat");
  check("a tell reads as told", !!(await until(`text(".pb-fold").startsWith("Inbox told HubSpot tickets, 2 messages")`)));
  await shot("chat-fold-closed");

  // ---------------- the rail
  const moreAccess = await ev(`(() => { const c = $$(".pb-card").find((x) => x.textContent.includes("Give Onboardings more access")); return c ? $$("button", c).map((x) => x.textContent).filter((t) => t !== "Show all").join("|") : $$(".pb-card-title").map((x) => x.textContent); })()`);
  check("an approval with noAlways (more access, the one card the main bot still raises) shows only Allow once and Deny", moreAccess === "Allow once|Deny", moreAccess);
  check("an approval without noAlways still offers Always allow", !!(await ev(`$$(".pb-card").find((x) => x.textContent.includes("Send this reply in Teams")).textContent.includes("Always allow")`)));
  check("an expiring card says when, gently", /^Expires in (28|29) min$/.test((await ev(`text(".pb-card .pb-card-foot")`)) ?? ""), await ev(`text(".pb-card .pb-card-foot")`));
  check("a note card shows its title, text and one Got it", (await ev(`(() => { const c = $(".pb-card-note"); return c && c.textContent.includes("The Nordvik import ran") && $$("button", c).map((x) => x.textContent).join("|"); })()`)) === "Got it");
  await ev(`$(".app-rail").scrollTop = 99999`);
  await houseRules("rail");
  await shot("rail-note");
  await ev(`click(btn("Got it"))`);
  check("Got it puts the note away", !!(await until(`!$(".pb-card-note")`, 2000)));

  // ---------------- keyboard on the page
  await open("");
  await focusRings("chat window", 24);
  await goTo("Kaja", "files");
  await until(`!!$(".pb-file")`);
  await ev(`$(".app-files-add").focus()`);
  await focusRings("files", 14);

  // ---------------- first run, as in step 1
  await open("scene=first-run");
  check("first run still asks for the first bot", (await until(`text(".app-first-title") === "Welcome to Pobots"`)) === true);
  await ev(`(() => { const i = $("#first-name"); i.focus(); i.select(); })()`);
  await type("Po");
  await key("Enter");
  check("and opens its chat as the main bot", !!(await until(`$(".app-main")?.getAttribute("aria-label") === "Po" && text(".app-head .pb-row-line") === "Main bot" && tabOpen() === "chat"`)));
  await ev(`click($('.pb-tab[data-tab="settings"]'))`);
  await until(`!!$(".pb-settings")`);
  check("a lone main bot can be retired", (await ev(`btn("Retire Po").disabled`)) === false);

  // ---------------- a card that expires
  await open("expire=3");
  check("a card about to expire says so", (await until(`text(".pb-card .pb-card-foot") === "Expires in a moment"`)) === true);
  await shot("rail-expiring");
  check("when it runs out it leaves the quiet way, not the answered way", !!(await until(`$$('.app-card-slot[data-leaving="quiet"]').some((x) => x.textContent.includes("Send this reply in Teams"))`, 6000)));
  check("and is gone", !!(await until(`!$$(".pb-card").some((x) => x.textContent.includes("Send this reply in Teams"))`, 3000)));
  await goTo("Inbox", "chat");
  check("the bot's chat says it was not answered in time", !!(await until(`$(".app-tabpanel").innerText.includes("Not answered in time")`)));

  // ---------------- machines
  check("on the engine's own machine it reads this one", (await ev(`$$(".pb-side-line")[0].innerText.includes("this one")`)) === true);
  await open("device=remote");
  check("from another device it reads connected", (await ev(`$$(".pb-side-line")[0].innerText.replace(/\\s+/g, " ")`)) === "Mac mini connected");

  // ---------------- protocol mismatch in a browser: one reload, then the words
  await ev(`sessionStorage.clear()`);
  await open("scene=mismatch");
  const refused = await until(`$$(".app-line").some((x) => x.textContent.includes("does not match the engine"))`, 6000);
  check("a refused page reloads once by itself, then shows the update words", !!refused && (await ev(`performance.getEntriesByType("navigation")[0].type`)) === "reload" && !!(await ev(`sessionStorage.getItem("pobots.reloadedForUpdate")`)));

  }
}
