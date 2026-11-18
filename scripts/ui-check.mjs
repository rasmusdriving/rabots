// Scripted check of the app window against its mock engine (protocol version 12), in headless
// Chromium. No engine, no model, no network: the built page is opened from the file system with
// ?mock=1. Drives what a person does on a bot's page and in the rail, and checks the house rules
// (no borders, focus rings, plain copy, no sideways scrolling at 1280, 1024 and 800 px).
//
// Run: npm run check:ui                 (builds the window first)
//      node scripts/ui-check.mjs [--shots=DIR] [--keep]
//   --shots=DIR  also takes pictures of every new screen in dark and light into DIR
//   --helper-shots=DIR  takes the pictures of helper rows and threads (step 2e) into DIR; with
//                only --shots they go to DIR/helpers
//   --flow-shots=DIR  takes the pictures of a turn in order and its folded work (step 2e addition)
//                into DIR; with only --shots they go to DIR/flow
//   --artifact-shots=DIR  takes the pictures of artifact rows, the panel and the Artifacts tab (step 2f)
//                into DIR; with only --shots they go to DIR/artifacts
//   --browser-shots=DIR  takes the pictures of the browser rows, the browser panel and the roster's Browser line
//                (step 2g) into DIR; with only --shots they go to DIR/browser
//   --fixes-shots=DIR  takes the pictures of step 2g's second round (the choices of a drop-down list, the
//                page's question, the wider default) into DIR; with only --shots they go to DIR/fixes
//   --tabs-shots=DIR  takes the pictures of step 2g's third round (the row of pages, the sharper picture,
//                close-ups of text before and after) into DIR; with only --shots they go to DIR/tabs
//   --gpt-shots=DIR  takes the pictures of step 3a (the model groups, the lines about Codex and about
//                changing between Claude and ChatGPT, a helper's model) into DIR; with only --shots they
//                go to DIR/gpt
//   --fast-shots=DIR  takes the pictures of step 3b (the switch Fast in the picker, the settings and
//                "Add a bot", the message box, a helper's label with fast) into DIR; with only --shots
//                they go to DIR/fast
//   --files-shots=DIR  takes the pictures of pictures and files in the chat (the tray, a sent message,
//                the large view, the drop outline) into DIR; with only --shots they go to DIR/files
//   --backup-shots=DIR  takes the pictures of the nightly backup (job 5: the roster's way in, Pobots
//                settings with and without a key, refusals, a run, the card from Pobots) into DIR; with
//                only --shots they go to DIR/backup
//   --only=3a    runs only the checks of step 3a, for trying them while building (the whole check is
//                what counts); --only=3b likewise runs only the checks of step 3b, --only=files
//                only those of pictures and files in the chat, and --only=backup those of the
//                nightly backup, and --only=phone those of the phone layout, and --only=push those of
//                notifications when the page is not open (job 4), and --only=steer those of steering
//                (a message sent while a bot works goes into its turn or waits; protocol 14), and
//                --only=settings7 those of step 7b (the icon row, the settings window, usage, the update
//                button, a bot's own steer or queue, earlier chats; --settings7-shots=DIR for pictures)
//                --only=chat7 those of job 7's chat (step 7a: waiting messages, the work line, provider
//                marks, a colour per bot, the bot's to-do list); its pictures with --chat7-shots=DIR
//   --phone-shots=DIR  takes the pictures of the phone layout (job 3) into DIR; with only --shots
//                they go to DIR/phone
//   --push-shots=DIR  takes the pictures of the Notifications section (job 4) in each state, at laptop
//                and phone width, into DIR; with only --shots they go to DIR/push
//   --keep       keeps the browser profile folder
//   CHROMIUM=/path/to/chrome-headless-shell overrides the browser
//   UI_CHECK_CLOCK=08:30  runs the window as if it were that time of day (the checks must pass at any time)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory, stopped, totals } from "./ui-check/lib.mjs";

// Every section lives in a file of its own under ui-check/sections/, named as in SECTIONS (lib.mjs).
// A new section: add its name there and a file here that exports its checks as the default function.
try {
  for (const name of SECTIONS) {
    if (skip(name)) continue;
    await (await import(`./ui-check/sections/${name}.mjs`)).default();
  }

  // ---------------- pictures in both themes
  if (shots && !skip("base")) {
    for (const theme of ["dark", "light"]) {
      for (const width of [1280, 1024, 800]) {
        const tag = `${theme}-${width}`;
        await open("", { width, theme });
        await goTo("Kaja", "job");
        await until(`!$(".pb-editor-text").disabled`);
        await shot(`${tag}-job`);
        await goTo("Kaja", "files");
        await until(`!!$(".pb-file")`);
        if (width === 800) await ev(`click($$(".pb-file")[1])`);
        await until(`!!$(".pb-editor-text") || true`);
        await shot(`${tag}-files`);
        await goTo("Kaja", "history");
        await until(`!!$(".pb-change")`);
        await ev(`click($$(".pb-change")[2])`);
        await until(`!!$(".pb-diff")`);
        await shot(`${tag}-history`);
        await goTo("Inbox", "settings");
        await shot(`${tag}-settings`);
        await ev(`$(".app-settings").scrollTop = 99999`);
        await shot(`${tag}-settings-bottom`);
        await goTo("Inbox", "chat");
        await ev(`click($(".pb-fold"))`);
        await shot(`${tag}-chat-fold`);
        await ev(`$(".app-rail").scrollTop = 99999`);
        await shot(`${tag}-rail`);
        if (width === 1280) {
          await ev(`click($(".app-add-bot"))`);
          await shot(`${tag}-add-bot`);
          await key("Escape");
          await goTo("Kaja", "job");
          await until(`!$(".pb-editor-text").disabled`);
          await ev(`(() => { const t = $(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
          await type("\nUnsaved.");
          await ev(`window.pobotsMock.botWrites("kaja", "AGENTS.md", "# Kaja\\n")`);
          await until(`!!$(".pb-editor-note")`);
          await shot(`${tag}-job-changed`);
          await ev(`click($('.pb-tab[data-tab="history"]'))`);
          await until(`!!$(".pb-dialog")`);
          await shot(`${tag}-leave-confirm`);
          await ev(`click(btn("Leave without saving"))`);
          await goTo("Onboardings", "settings");
          await ev(`$(".app-settings").scrollTop = 99999`);
          await ev(`click(btn("Retire Onboardings"))`);
          await until(`!!$(".pb-dialog")`);
          await shot(`${tag}-retire-confirm`);
          await key("Escape");
        }
      }
    }
    console.log(`Pictures in ${shots}`);
  }
} catch (error) {
  stopped(error);
} finally {
  await b.close();
  if (!keep) rmSync(work, { recursive: true, force: true });
}

const { passed, failed } = totals();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
