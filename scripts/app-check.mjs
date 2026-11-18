// End-to-end check: the real app window against the real engine and the real Claude.
//
// Starts the built engine on temporary data and bots folders, opens the built window in a
// headless Chromium with a stand-in for the desktop bridge, and uses the window the way a
// person would: create the first bot, send a message, answer an approval card, restart.
//
// It makes a few small model calls on the cheapest model. Nothing touches the real data.
//
// The nightly backup (step 16) makes no model calls. It backs up into a folder of its own under
// OneDrive's Pobot/test-copy (so the Mac's real upload state is read) and removes it at the end; it
// touches nothing else in OneDrive. Its key pairs are made in the temporary folder and deleted.
//
// Notifications (step 17) never reach a real push service: the engine is started with
// --push-relay pointing at a small server inside this check, which gets the bytes instead.
//
// Job 7's chat (step 20): a bot on Claude and one on Codex keep a to-do list while they run three
// echo commands in their own temporary folders.
//
// Steering (step 18): a real bot on Claude and one on Codex, each on the cheapest model, get a message
// steered into a turn while it runs short commands, and act on it in that same turn. Only their own
// temporary folders are written.
//
// Run: npm run build && node scripts/app-check.mjs [--keep] [--shots=DIR] [--only=files|backup|push|steer|titles|chat7|fullaccess|anyfile|todo]
//   --keep         keep the temporary folders (their path is printed), for example to open them in the app
//   --shots=DIR    where pictures go (default: a folder in the system temp dir)
//   --only=files   only the first bot and step 15, pictures and files (a few calls instead of many)
//   --only=backup  the first bot and step 16, the backup, only (no model calls)
//   --only=push    the first bot and step 17, notifications, only (a few small calls)
//   --only=steer   the first bot and step 18, steering, only (two short turns)
//   --only=titles  the first bot and step 19 (step 7b): a chat titled by real Haiku, the main bot's
//                  change_settings, the providers and usage read for real (read-only; no update is run)
//   --only=chat7   the first bot and step 20, job 7's chat (step 7a): the bots' to-do lists, kinds of work, thinking summaries (two short turns)
//   --only=fullaccess  step 21 (7c): a bot on full access whose helper runs a heredoc command, no card
//   --only=anyfile     step 22 (7c): a zip attached to a Claude bot, which opens it
//   --only=todo        step 23 (7c): a bot adds a to-do, the window shows it, an answer wakes the bot
//   --only=sees        step 24: a bot's choice of services and skills reaches its real session (scripts/app-check/sections/sees.mjs)
//   --only=workers     step workers: a worker with two jobs shortens itself in between; a worker of a kind
//   --only=maintools   the main bot sets up another bot with its tools, at once, with notes and no card (scripts/app-check/sections/maintools.mjs)
//   CHROMIUM=/path/to/chrome-headless-shell overrides the browser
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  arg,
  keep,
  only,
  SECTIONS,
  sleep,
  work,
  dataDir,
  botsDir,
  shots,
  backupDir,
  backupReady,
  keysDir,
  results,
  failed,
  check,
  relayServer,
  startEngine,
  stopEngine,
  sideChannel,
  codexThreads,
  deleteCodexThreads,
  profile,
  browser,
  cdp,
  connectBrowser,
  cmd,
  js,
  shot,
  until,
  clickButton,
  openWindow,
  run,
} from "./app-check/lib.mjs";
import { keepOnly, onStop } from "./temp-cleanup.mjs";

// The temporary folder at the end: all of it goes when the check passed (pass --shots=DIR to keep
// the pictures, --keep to keep everything); when it failed or was stopped, only what is needed to
// read the failure stays: the pictures, the engine's data folder and the bots' folders. The big
// test files, the restored copies, the browser profile and the keys go (docs/build/step-check-cleanup.md).
function tidyWork(passed) {
  if (keep) return;
  if (passed) rmSync(work, { recursive: true, force: true });
  else keepOnly(work, ["shots", "data", "bots"]);
}
// Stopped (Ctrl-C, SIGTERM): the browser and the engine stop, the OneDrive folder and the temp folder are tidied.
onStop(async () => {
  console.log("\nStopped. Cleaning up.");
  browser.kill();
  await stopEngine();
  if (backupReady && existsSync(backupDir)) {
    chmodSync(backupDir, 0o700);
    rmSync(backupDir, { recursive: true, force: true });
  }
  await sleep(300);
  tidyWork(false);
});

// Step 7c (job 7, files-todo): its own sections, each with --only=<name>.
const STEP7C = ["fullaccess", "anyfile", "todo"];
// What a bot sees (step 24, docs/sees.md) and the main bot's tools (docs/main-bot.md): their own sections, in files of their own.
const OWN_FILE = ["sees", "maintools", "cards-after-restart"];

// ------------------------------------------------------------ the check
try {
  let endpoint = await startEngine();
  await connectBrowser();
  await cmd("Page.enable");
  await openWindow(endpoint);

  // 1. First run: the window asks for the first bot.
  check("first run asks for the first bot", !!(await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Create bot")`, 15_000)));
  await shot("1-first-run");
  await js(`document.querySelector("input").focus()`);
  await cmd("Input.insertText", { text: "Kaja" });
  await clickButton("Create bot");
  check("the bot is created and its chat opens", !!(await until(`document.querySelector("textarea")?.placeholder === "Message Kaja"`, 15_000)));
  check("the bot folder exists with its job file", existsSync(join(botsDir, "kaja", "AGENTS.md")) && existsSync(join(botsDir, "kaja", "bot.json")));

  // Use the cheapest model for the rest. Set behind the window's back; the window must follow.
  const side = await sideChannel(endpoint);
  const snap = await side.request("snapshot");
  const cheap = snap.models.find((m) => /haiku/.test(m.id)) ?? snap.models[snap.models.length - 1];
  await side.request("bot.update", { botId: "kaja", patch: { model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort } });
  check("the window follows a settings change made elsewhere", !!(await until(`document.querySelector(".pb-composer")?.textContent.includes(${JSON.stringify(cheap.label)})`, 10_000)), cheap.label);
  // What every section uses (lib.mjs). A section that restarts the engine writes the new address back.
  Object.assign(run, { endpoint, side, snap, cheap });

  if (only === "backup" || only === "push" || only === "steer" || only === "titles" || only === "chat7" || only === "workers" || STEP7C.includes(only) || OWN_FILE.includes(only)) side.close();

  // Every section lives in a file of its own under app-check/sections/, named as in SECTIONS
  // (app-check/lib.mjs), and they run in that order. A new section: add its name there and a file
  // there whose default function holds its checks.
  for (const name of SECTIONS) {
    if (only && only !== name) continue;
    await (await import(`./app-check/sections/${name}.mjs`)).default();
  }
} catch (err) {
  check("the check ran to the end", false, err instanceof Error ? err.message : String(err));
} finally {
  cdp?.close();
  browser.kill();
  await stopEngine();
  relayServer.closeAllConnections();
  relayServer.close();
  await sleep(300);
  const gone = await deleteCodexThreads();
  if (codexThreads.size) check("the Codex threads this check made are deleted", !gone.failed.length, gone.failed.length ? gone.failed.join("; ") : `${gone.deleted} deleted`);
  rmSync(profile, { recursive: true, force: true });
  // The key pairs and the check's own backup folder go, whatever happened.
  rmSync(keysDir, { recursive: true, force: true });
  if (backupReady && existsSync(backupDir)) {
    chmodSync(backupDir, 0o700);
    rmSync(backupDir, { recursive: true, force: true });
    check("the check's own backup folder in OneDrive is removed", !existsSync(backupDir));
  }
  console.log(failed ? "\nSome checks failed." : `\nAll ${results.length} checks passed.`);
  if (keep || failed || arg("shots")) console.log(`Pictures: ${shots}`);
  if (keep || failed) console.log(`Kept: ${work}\n  data dir: ${dataDir}\n  bots dir: ${botsDir}`);
  else if (!arg("shots")) console.log("(The temp folder and its pictures are removed; pass --shots=DIR to keep the pictures.)");
  tidyWork(!failed);
  process.exit(failed ? 1 : 0);
}
