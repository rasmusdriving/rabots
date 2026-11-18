// The app check, section "base": the first bot's steps 2 to 14 (they depend on each other, so one file).
// Run it alone: node scripts/app-check.mjs --only=base
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  only,
  sleep,
  botsDir,
  check,
  engineLog,
  startEngine,
  stopEngine,
  sideChannel,
  collectCodexThreads,
  collectCodexThreadIds,
  browser,
  cmd,
  js,
  shot,
  until,
  type,
  clickButton,
  lastAnswer,
  headStatus,
  openWindow,
  run,
} from "../lib.mjs";

// Steps 2 to 14. With --only=files, --only=backup or --only=push they are left out, and only the
// first bot and step 15 (files), step 16 (backup) or step 17 (notifications) run.
export default async function section() {
  let { endpoint } = run;
  const { side, cheap } = run;
  steps: {
    if (only && only !== "base") break steps;
    // 2. A message gets a real answer.
    await type("Remember the code word: lighthouse. Reply with one short sentence.");
    check("your message shows as a bubble", !!(await until(`document.querySelector(".pb-msg-you")?.textContent.includes("lighthouse")`, 10_000)));
    const answered = await until(`(${headStatus}) === "Done" && (${lastAnswer}).length > 0`, 120_000);
    check("the bot answers", !!answered, JSON.stringify(await js(lastAnswer)).slice(0, 80));
    await shot("2-answered");

    // 3. An approval card: the bot is on "Asks first" and wants to run a command.
    await type("Run exactly this shell command and nothing else: touch approved.txt");
    const card = await until(`document.querySelector(".pb-rail .pb-card-title")?.textContent`, 120_000);
    check("an approval card appears in the rail", !!card, String(card));
    check("the bot shows it is waiting for you", /Waiting/.test(String(await js(headStatus))), String(await js(headStatus)));
    await shot("3-approval");
    await clickButton("Allow once");
    check("allowing runs the command", !!(await until(`!document.querySelector(".pb-rail .pb-card-title")`, 20_000)) && !!(await until(`(${headStatus}) === "Done"`, 120_000)) && existsSync(join(botsDir, "kaja", "approved.txt")));
    await shot("4-allowed");

    // 4. Restart the engine on the same folders: history is there and the bot remembers.
    side.close();
    await stopEngine();
    endpoint = await startEngine();
    run.endpoint = endpoint;
    await openWindow(endpoint);
    check("after a restart the chat is still there", !!(await until(`document.querySelector(".pb-msg-you")?.textContent.includes("lighthouse")`, 15_000)));
    await type("What was the code word? Answer with the word only.");
    await until(`(${headStatus}) !== "Done" && (${headStatus}) !== "Idle"`, 15_000);
    const recalled = await until(`(${headStatus}) === "Done" && /lighthouse/i.test(${lastAnswer})`, 120_000);
    check("after a restart the bot remembers", !!recalled, JSON.stringify(await js(lastAnswer)).slice(0, 80));
    await shot("5-after-restart");

    // 5. A team: add a second bot in the window, let the main bot ask it, edit its job, see the history.
    const side2 = await sideChannel(endpoint);
    await js(`document.querySelector('[aria-label="Add a bot"]').click()`);
    check("the add sheet opens", !!(await until(`document.activeElement?.id === "add-name"`, 10_000)));
    await cmd("Input.insertText", { text: "Helper" });
    await js(`document.querySelector("#add-purpose").focus()`);
    await cmd("Input.insertText", { text: "Knows the colour of the day" });
    await js(`document.querySelector("#add-job").focus()`);
    await cmd("Input.insertText", { text: "The colour of the day is teal. When anyone asks for the colour of the day, answer with that one word." });
    await shot("6-add-bot");
    await clickButton("Create bot");
    check("the new bot opens in the window", !!(await until(`document.querySelector("textarea")?.placeholder === "Message Helper"`, 15_000)));
    check("its folder has the job it was given", existsSync(join(botsDir, "helper", "AGENTS.md")) && readFileSync(join(botsDir, "helper", "AGENTS.md"), "utf8").includes("teal"));
    await side2.request("bot.update", { botId: "helper", patch: { model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort } });

    const openBot = async (name) => {
      await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}).click()`);
      await until(`document.querySelector(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`, 10_000);
    };
    const openTab = (tab) => js(`document.querySelector('.pb-tab[data-tab="${tab}"]').click()`);

    await openBot("Kaja");
    await type("Use your message_bot tool with mode ask to ask the bot Helper for the colour of the day. Then tell me the colour in one word.");
    await until(`(${headStatus}) !== "Done" && (${headStatus}) !== "Idle"`, 15_000);
    const asked = await until(`(${headStatus}) === "Done" && /teal/i.test(${lastAnswer})`, 180_000);
    check("the main bot asks the other bot and uses its answer", !!asked, JSON.stringify(await js(lastAnswer)).slice(0, 80));
    check("no card was needed for a message between bots", !(await js(`!!document.querySelector(".pb-rail .pb-card-title")`)));
    await shot("7-asked-another-bot");

    await openBot("Helper");
    const fold = await until(`document.querySelector(".pb-fold")?.textContent.trim()`, 15_000);
    check("in the other bot's chat the turn is folded into one line", /^Kaja asked Helper/.test(String(fold)), String(fold));
    await js(`document.querySelector(".pb-fold").click()`);
    check("the fold opens and shows the answer", !!(await until(`/teal/i.test(document.querySelector(".pb-fold-body")?.innerText ?? "")`, 10_000)));
    await shot("8-folded-turn");

    await openTab("job");
    check("the job tab shows the bot's job", !!(await until(`!document.querySelector(".pb-editor-text")?.disabled && document.querySelector(".pb-editor-text")?.value.includes("teal")`, 15_000)));
    await js(`(() => { const t = document.querySelector(".pb-editor-text"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; })()`);
    await cmd("Input.insertText", { text: "\n- Added in the app by the check.\n" });
    await clickButton("Save");
    check("saving the job says Saved and reaches the folder", !!(await until(`document.querySelector(".pb-editor-state")?.textContent.trim() === "Saved"`, 15_000)) && readFileSync(join(botsDir, "helper", "AGENTS.md"), "utf8").includes("Added in the app by the check."));
    await shot("9-job-saved");

    await openTab("history");
    const top = await until(`document.querySelector(".pb-change-summary")?.textContent.trim()`, 15_000);
    check("the history shows the edit on top", /job/i.test(String(top)), String(top));
    await js(`document.querySelector(".pb-change").click()`);
    check("opening the change shows what was added", !!(await until(`[...document.querySelectorAll(".pb-diff-line[data-kind='add']")].some((l) => l.textContent.includes("Added in the app by the check."))`, 15_000)));
    await shot("10-history");
    await clickButton("Undo this change");
    await until(`!!document.querySelector(".pb-dialog")`, 10_000);
    await clickButton("Undo change");
    check("undo takes the edit out of the folder again", !!(await until(`!document.querySelector(".pb-dialog")`, 15_000)) && !readFileSync(join(botsDir, "helper", "AGENTS.md"), "utf8").includes("Added in the app by the check."));

    await openTab("settings");
    check("the settings tab opens", !!(await until(`!!document.querySelector(".pb-settings")`, 10_000)));
    await shot("11-settings");

    // 6. Bots that wake by themselves: a webhook, a trigger made in the window, and a fresh run with nothing to say.
    const httpBase = endpoint.url.replace(/^ws/, "http").replace(/\/ws$/, "").replace(/\/$/, "");
    const hook = (await side2.request("trigger.save", { botId: "helper", trigger: { kind: "webhook", name: "Order in", prompt: "Reply with only the value of the field city from what was sent.", where: "main", enabled: true } })).trigger;
    check("a webhook's address is not part of the trigger itself", hook.hookPath === undefined && !JSON.stringify(await side2.request("snapshot")).includes("/hook/"));
    hook.hookPath = (await side2.request("trigger.address", { triggerId: hook.id })).hookPath;
    check("the address comes only when asked for", /^\/hook\/[^/]+\/[A-Za-z0-9_-]{40,}$/.test(hook.hookPath ?? ""));
    const wrong = await fetch(`${httpBase}${hook.hookPath.slice(0, -4)}AAAA`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("a wrong address is a plain 404", wrong.status === 404, String(wrong.status));
    const called = await fetch(`${httpBase}${hook.hookPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ city: "Uppsala", order: 4711 }) });
    check("calling the address is accepted at once", called.status === 202, String(called.status));
    await openTab("chat");
    check("the call shows in the bot's chat as a message from the trigger", !!(await until(`[...document.querySelectorAll(".pb-msg-trigger .pb-msg-trigger-name")].some((n) => n.textContent === "Order in")`, 20_000)));
    const used = await until(`(${headStatus}) === "Done" && /uppsala/i.test(${lastAnswer})`, 120_000);
    check("the bot wakes and uses what was sent", !!used, JSON.stringify(await js(lastAnswer)).slice(0, 80));
    await shot("12-webhook-in-chat");

    await openTab("triggers");
    const rowOf = (name) => `[...document.querySelectorAll(".pb-trigger")].find((r) => r.querySelector(".pb-trigger-name")?.textContent === ${JSON.stringify(name)})`;
    check("the Triggers tab lists the webhook with how its last run went", !!(await until(`/^Done/.test(${rowOf("Order in")}?.querySelector(".pb-trigger-meta")?.innerText ?? "")`, 20_000)));
    await clickButton("New trigger");
    check("the new trigger sheet opens", !!(await until(`document.activeElement?.id === "new-trigger-name"`, 10_000)));
    await cmd("Input.insertText", { text: "Morning look" });
    await js(`document.querySelector("#new-trigger-prompt").focus()`);
    await cmd("Input.insertText", { text: "Look at your memory. If nothing needs the person, answer with exactly: Nothing to report" });
    await js(`[...document.querySelectorAll(".pb-dialog button")].find((b) => b.textContent.trim() === "As a fresh run")?.click()`);
    await shot("13-new-trigger");
    await clickButton("Create trigger");
    check("a schedule made in the window reaches the engine", !!(await until(`document.querySelector(".pb-trigger-head-name")?.textContent === "Morning look" && !document.querySelector(".pb-dialog")`, 15_000)));
    const made = (await side2.request("trigger.list", { botId: "helper" })).triggers.find((t) => t.name === "Morning look");
    check("it is a daily schedule with a next time", made?.kind === "schedule" && made.schedule?.type === "daily" && !!made.nextAt, JSON.stringify(made?.schedule));
    if (made && made.where !== "fresh") await side2.request("trigger.save", { botId: "helper", trigger: { id: made.id, kind: "schedule", name: made.name, prompt: made.prompt, where: "fresh", enabled: true, schedule: made.schedule } });
    await clickButton("Run now");
    let quiet;
    for (let i = 0; i < 240 && made; i++) {
      quiet = (await side2.request("trigger.runs", { triggerId: made.id })).runs[0];
      if (quiet && quiet.status !== "running") break;
      await sleep(500);
    }
    check("a fresh run with nothing to say ends as silent", quiet?.status === "silent", `${quiet?.status}: ${quiet?.note ?? ""}`);
    const mainItems = (await side2.request("thread.read", { threadId: (await side2.request("snapshot")).bots.find((b) => b.id === "helper").mainThreadId })).items;
    check("and nothing from it reaches the main chat", !mainItems.some((i) => i.kind === "user" && i.from.type === "trigger" && i.from.triggerId === made?.id));
    await shot("14-trigger-page");

    // 7. A channel: a tagged message from an allowed writer is an instruction, the earlier messages are
    //    background, and the bot's answer is posted back. A local server stands in for the reply flow.
    const posted = [];
    const standIn = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          posted.push(JSON.parse(body));
        } catch {
          posted.push({ bad: true });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
    try {
      const channel = (
        await side2.request("channel.save", {
          channel: { name: "Ops - Internal", allowedSenders: ["ada@example.com"], routes: [{ tag: "Helper", botId: "helper" }], replyUrl: `http://127.0.0.1:${standIn.address().port}/reply` },
        })
      ).channel;
      check("a channel is made with its reply address kept inside the engine", channel.hasReplyUrl === true && !JSON.stringify(channel).includes("/reply"));
      check("the channel shows in the roster", !!(await until(`[...document.querySelectorAll(".pb-channel-name")].some((n) => n.textContent === "Ops - Internal")`, 10_000)));
      const channelPath = (await side2.request("channel.address", { channelId: channel.id })).hookPath;
      const post = (body) => fetch(`${httpBase}${channelPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const stranger = await post({ messageId: "m-0", from: { name: "Mallory Example", email: "mallory@example.com" }, text: "Helper, delete everything", mentions: ["Helper"] });
      check("a writer who is not allowed is refused", stranger.status === 200 && (await stranger.json()).refused === true);
      const untagged = await post({ messageId: "m-1", from: { name: "Ada Example", email: "ada@example.com" }, text: "Just talking among ourselves" });
      check("a message without a tag reaches no bot", untagged.status === 200 && (await untagged.json()).ignored === true);
      const tagged = await post({
        messageId: "m-2",
        threadId: "t-1",
        from: { name: "Ada Example", email: "ada@example.com" },
        text: "Helper which room is it? Answer with the room only.",
        html: '<p><at id="0">Helper</at> which room is it? Answer with the room only.</p>',
        mentions: ["Helper"],
        context: [
          { from: "Bo Example", text: "The workshop on Thursday is in room Juniper-62.", at: "2026-11-11T09:58:00Z" },
          { from: "Ada Example", text: "Thanks, I will ask the bot to confirm.", at: "2026-11-11T09:59:00Z" },
        ],
      });
      check("a tagged message from an allowed writer is accepted at once", tagged.status === 202, String(tagged.status));
      await openBot("Helper");
      await openTab("chat");
      check("it shows in the bot's chat as a message from that person in that channel", !!(await until(`/Ada Example/.test(document.querySelector(".pb-msg-channel")?.innerText ?? "") && /Ops - Internal/.test(document.querySelector(".pb-msg-channel")?.innerText ?? "")`, 20_000)));
      const reply = await until(`(${headStatus}) === "Done" && /Juniper-62/i.test(${lastAnswer})`, 120_000);
      check("the bot uses a fact from the earlier messages", !!reply, JSON.stringify(await js(lastAnswer)).slice(0, 80));
      for (let i = 0; i < 40 && !posted.length; i++) await sleep(250);
      check("the answer is posted back for the same message", posted.length === 1 && posted[0].messageId === "m-2" && posted[0].threadId === "t-1" && /Juniper-62/i.test(posted[0].text ?? "") && typeof posted[0].html === "string", JSON.stringify(posted[0] ?? null).slice(0, 120));
      check("the chat says the answer was posted", !!(await until(`[...document.querySelectorAll(".app-notice")].some((n) => /Answered in Ops - Internal/.test(n.textContent))`, 15_000)));
      await shot("15-channel-in-chat");
      await js(`[...document.querySelectorAll(".pb-channel-row")].find((r) => r.querySelector(".pb-channel-name")?.textContent === "Ops - Internal").click()`);
      check("the channel's page lists what came in and what became of it", !!(await until(`(() => { const t = document.querySelector(".pb-cmsgs")?.innerText ?? ""; return /Answered/.test(t) && /Refused/.test(t) && /No tag matched/.test(t); })()`, 15_000)), String(await js(`document.querySelector(".pb-cmsgs")?.innerText.replace(/\\s+/g, " ").slice(0, 160)`)));
      check("no address is shown on the page until asked for", !(await js(`document.body.innerText.includes("/hook/") || document.body.innerText.includes("/reply")`)));
      await shot("16-channel-page");
    } finally {
      standIn.close();
    }
    // 8. Working memory: the bot writes down what matters, a line marks the fresh start, and the next
    //    message is answered in a fresh session that still knows what was said before.
    await openBot("Kaja");
    await openTab("settings");
    check("settings has a working memory section that says how full the session is", !!(await until(`/About [0-9]+% full/.test(document.querySelector(".pb-memory-facts")?.textContent ?? "")`, 15_000)), String(await js(`document.querySelector(".pb-memory-facts")?.textContent`)));
    const sessionBefore = (await side2.request("snapshot")).bots.find((b) => b.id === "kaja")?.context;
    await clickButton("Start fresh now");
    check("starting fresh asks first", !!(await until(`document.querySelector(".pb-dialog-title")?.textContent === "Start fresh now?"`, 10_000)));
    await clickButton("Start fresh");
    await until(`!document.querySelector(".pb-dialog")`, 15_000);
    await openTab("chat");
    check("while the bot writes its note the chat shows one quiet line", !!(await until(`/Writing down what matters|Started fresh/.test(document.querySelector(".pb-fresh")?.textContent ?? "")`, 30_000)));
    await shot("17-tidying");
    const fresh = await until(`/^Started fresh/.test(document.querySelector(".pb-fresh-btn")?.textContent?.trim() ?? "")`, 180_000);
    check("the chat gets a Started fresh line", !!fresh, String(await js(`document.querySelector(".pb-fresh")?.textContent`)));
    check("the request to tidy and the note are not drawn as messages", !(await js(`[...document.querySelectorAll(".pb-msg-you, .pb-msg-body")].some((m) => /Note from Pobots|fresh session/.test(m.textContent))`)));
    await js(`document.querySelector(".pb-fresh-btn").click()`);
    check("the line opens to the note the bot wrote", !!(await until(`(document.querySelector(".pb-fresh-note")?.textContent ?? "").trim().length > 10`, 10_000)), String(await js(`document.querySelector(".pb-fresh-note")?.textContent?.slice(0, 80)`)));
    await shot("18-fresh-open");
    const sessionAfter = (await side2.request("snapshot")).bots.find((b) => b.id === "kaja")?.context;
    check("the engine reports an empty new session", sessionAfter?.tokens === 0 && sessionAfter?.tidying === false && !!sessionAfter?.since && (sessionBefore?.tokens ?? 0) > 0, JSON.stringify({ sessionBefore, sessionAfter }));
    await type("What was the code word I gave you at the very start of this chat? Look in your note and your memory, and search the chat if you need to. Answer with the word only.");
    await until(`(${headStatus}) !== "Done" && (${headStatus}) !== "Idle"`, 15_000);
    const still = await until(`(${headStatus}) === "Done" && /lighthouse/i.test(${lastAnswer})`, 180_000);
    check("in the fresh session the bot still knows what was said before", !!still, JSON.stringify(await js(lastAnswer)).slice(0, 80));
    const sessionNow = (await side2.request("snapshot")).bots.find((b) => b.id === "kaja")?.context;
    // Not "smaller than the one before": a session starts at about 50 000 tokens of fixed text, and a bot
    // that reads its note, its memory and the chat to answer can end a little above the old one (13 Nov 2026:
    // 55 239 before, 55 632 after). What is promised is that the answer came in the session started fresh.
    check(
      "the answer came in the fresh session, not the one before",
      // The session's start is written at the fresh start and again when its first turn begins.
      (sessionNow?.tokens ?? 0) > 0 && Date.parse(sessionNow?.since ?? "") >= Date.parse(sessionAfter?.since ?? "") && Date.parse(sessionAfter?.since ?? "") > Date.parse(sessionBefore?.since ?? ""),
      JSON.stringify({ before: { tokens: sessionBefore?.tokens, since: sessionBefore?.since }, now: { tokens: sessionNow?.tokens, since: sessionNow?.since } }),
    );
    await shot("19-after-fresh");

    // 9. A helper in the background: a row while it works, the bot woken by its result and never left
    //    thinking, the finished turn folded into one "Worked for" line, and the helper's own thread.
    await side2.request("bot.update", { botId: "kaja", patch: { access: "edits-freely" } });
    await side2.request("bot.file.write", { botId: "kaja", path: "notes.txt", text: "kestrel\n" });
    const allowCards = setInterval(() => void clickButton("Allow once"), 1000);
    try {
      await type(
        "Start exactly one helper in the background with your Agent tool (run_in_background: true) and the description 'Read the word file'. " +
          "Its task: read the file notes.txt in your working folder and report the single word in it. " +
          "Right after starting it, tell me in one short sentence that you started it, and end your turn. When the helper reports back, tell me the word.",
      );
      const row = await until(`document.querySelector(".app-main .pb-helper .pb-helper-title")?.textContent`, 120_000, 100);
      check("a helper shows as a row in the chat while the turn is open", /word file/i.test(String(row)), String(row));
      await shot("20-helper-row");
      const woken = await until(`(${headStatus}) === "Done" && /kestrel/i.test(${lastAnswer})`, 240_000);
      check("the bot is woken by its helper, answers with the word and ends done, not thinking", !!woken, `${await js(headStatus)}: ${JSON.stringify(await js(lastAnswer)).slice(0, 80)}`);
      const kaja = (await side2.request("snapshot")).bots.find((b) => b.id === "kaja");
      check("the engine says no helper is working any more", kaja?.state === "done" && !kaja?.helpers, JSON.stringify({ state: kaja?.state, activity: kaja?.activity, helpers: kaja?.helpers }));
      const worked = `[...document.querySelectorAll(".app-main .pb-worked")].filter((b) => /helper/.test(b.textContent))`;
      const words = await until(`${worked}.at(-1)?.querySelector(".pb-worked-words")?.textContent`, 20_000);
      check("the finished turn folds its work into one line that names the helper", /^Worked for .*1 helper/.test(String(words)), String(words));
      check("the folded work is off the page", !(await js(`!!document.querySelector(".app-main .pb-helper")`)) && (await js(`${worked}.at(-1).getAttribute("aria-expanded")`)) === "false");
      await shot("21-worked-for");
      await js(`${worked}.at(-1).click()`);
      const done = await until(`document.querySelector('.app-main .pb-work .pb-helper[data-status="done"] .pb-helper-title')?.textContent`, 10_000);
      check("the line opens to the work, with the helper's row as finished", /word file/i.test(String(done)), `${done}: ${await js(`document.querySelector(".app-main .pb-work .pb-helper .pb-helper-state")?.textContent`)}`);
      await shot("22-worked-open");
      await js(`document.querySelector(".app-main .pb-work .pb-helper").click()`);
      check("the row opens the helper's own thread, with a way back to the bot", !!(await until(`!!document.querySelector(".pb-helper-bar") && /Kaja/.test(document.querySelector(".pb-helper-back")?.getAttribute("aria-label") ?? "")`, 10_000)), String(await js(`document.querySelector(".pb-helper-bar")?.textContent`)));
      const thread = `document.querySelector(".app-main .pb-thread[data-helper-thread]")`;
      check("the helper's thread starts with what the bot asked of it", !!(await until(`/notes\\.txt/.test(${thread}?.querySelector(".pb-msg-task")?.textContent ?? "")`, 15_000)), String(await js(`${thread}?.querySelector(".pb-msg-task")?.textContent?.slice(0, 80)`)));
      check("it shows the helper's work and its result", !!(await until(`!!${thread}?.querySelector(".pb-activity") && /kestrel/i.test([...(${thread}?.querySelectorAll("article[data-helper]") ?? [])].at(-1)?.textContent ?? "")`, 15_000)), String(await js(`${thread}?.querySelector(".pb-activity")?.textContent`)));
      check("there is no message box in a helper's thread, only a sentence", !(await js(`!!document.querySelector(".app-main textarea")`)) && /works for Kaja/.test(String(await js(`document.querySelector(".pb-helper-note")?.textContent`))), String(await js(`document.querySelector(".pb-helper-note")?.textContent`)));
      await shot("23-helper-thread");
      await js(`document.querySelector(".pb-helper-back").click()`);
      check("back returns to the bot's chat", !!(await until(`!document.querySelector(".pb-helper-bar") && document.querySelector("textarea")?.placeholder === "Message Kaja"`, 10_000)));
    } finally {
      clearInterval(allowCards);
    }

    // 10. An artifact: the bot writes a page and shows it, the row stays in sight when the work folds,
    //     the page opens sealed in the panel beside the chat, and reloads when its file changes.
    //     Nothing is published: the bot's folder denies the tools that could, and any card is denied.
    mkdirSync(join(botsDir, "kaja", ".claude"), { recursive: true });
    writeFileSync(join(botsDir, "kaja", ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Artifact", "mcp__claude_ai_Claude_Docs"] } }, null, 2));
    const denyCards = setInterval(() => void clickButton("Deny"), 1000);
    try {
      await type(
        'Make me a tiny artifact: write the file artifacts/hello/index.html in your folder, a small self-contained HTML page with the title "Hello check" and the word marigold in its body, then show it to me with your show_artifact tool. Do not publish anything to Claude. Then say done in one short sentence.',
      );
      const row = `document.querySelector(".app-main .pb-thread .pb-artifact")`;
      const made = await until(`${row}?.querySelector(".pb-artifact-title")?.textContent`, 180_000);
      check("the bot's artifact shows as a row in the chat", /Hello check/.test(String(made)), `${made}: ${await js(`${row}?.querySelector(".pb-artifact-line")?.textContent`)}`);
      await until(`(${headStatus}) === "Done"`, 120_000);
      check("the row stays in sight when the turn's work is folded away", !!(await until(`!!${row} && !${row}.closest(".pb-work") && ${row}.closest(".pb-answer")?.hasAttribute("data-folded")`, 20_000)));
      await shot("24-artifact-row");
      const listed = (await side2.request("artifact.list", { botId: "kaja" })).artifacts;
      check("the engine lists it as a page in the bot's folder, not on Claude", listed.length === 1 && listed[0].kind === "page" && listed[0].path === "artifacts/hello/index.html" && !listed[0].url && listed[0].available, JSON.stringify(listed.map((a) => ({ kind: a.kind, path: a.path, url: !!a.url, rev: a.rev }))));
      await js(`${row}.click()`);
      const frame = `document.querySelector(".app-artifact iframe[data-state='shown']")`;
      check("the row opens the artifact in a panel beside the chat", !!(await until(`document.querySelector(".app-shell")?.dataset.artifact === "side" && !!${frame}`, 20_000)), String(await js(`document.querySelector(".pb-artifact-bar-title")?.textContent`)));
      const sandbox = String(await js(`${frame}?.getAttribute("sandbox")`));
      check("the frame is sealed: scripts may run, but it has no origin of ours", /allow-scripts/.test(sandbox) && !/allow-same-origin|allow-top-navigation/.test(sandbox), sandbox);
      const opened = await side2.request("artifact.open", { botId: "kaja", artifactId: listed[0].id });
      const res = await fetch(opened.src);
      const html = await res.text();
      const csp = res.headers.get("content-security-policy") ?? "";
      check("the engine serves the page with the bot's word in it", res.status === 200 && /marigold/i.test(html), `${res.status}, ${html.length} characters`);
      check("and seals it by its headers too", /sandbox/.test(csp) && !/allow-same-origin/.test(csp) && /connect-src 'none'/.test(csp), csp.slice(0, 120));
      await shot("25-artifact-panel");
      const revBefore = Number(await js(`${frame}?.dataset.rev`));
      await side2.request("bot.file.write", { botId: "kaja", path: "artifacts/hello/index.html", text: "<!doctype html><html><head><meta charset=\"utf-8\"><title>Hello check</title></head><body><p>Now the word is juniper.</p></body></html>\n" });
      check("when the file changes the panel loads the new version by itself", !!(await until(`Number(${frame}?.dataset.rev) > ${revBefore}`, 20_000)), `${revBefore} -> ${await js(`${frame}?.dataset.rev`)}`);
      const again = await (await fetch((await side2.request("artifact.open", { botId: "kaja", artifactId: listed[0].id })).src)).text();
      check("and the engine serves the new version", /juniper/.test(again));
      await openTab("artifacts");
      check("the bot's Artifacts tab lists it", !!(await until(`document.querySelectorAll(".pb-artifact-item").length === 1 && /Hello check/.test(document.querySelector(".pb-artifact-item")?.textContent ?? "")`, 10_000)), String(await js(`document.querySelector(".pb-artifact-item")?.textContent`)));
      await shot("26-artifacts-tab");
      await js(`document.querySelector('.pb-artifact-tools .pb-tool[aria-label="Close"]').click()`);
      check("Close gives the space back to the rail", !!(await until(`!document.querySelector(".app-shell")?.hasAttribute("data-artifact") && !document.querySelector(".app-artifact iframe")`, 10_000)));
      await openTab("chat");
    } finally {
      clearInterval(denyCards);
    }

    // 11. The browser: the bot opens a harmless page in the browser it works in, the row shows in the
    //     chat and stays in sight while the workspace is open, the panel shows a live picture, and
    //     with "Take control" a click over the picture reaches the page. Only https://example.com, only
    //     in a workspace named "pobots test check", which the check closes itself.
    const egoInstalled = [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local", "bin")].some((d) => d && existsSync(join(d, "ego-browser")));
    const egoScript = (script, ms = 60_000) =>
      new Promise((resolve) => {
        const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("error", () => resolve(""));
        child.stdin.end(script);
        const timer = setTimeout(() => child.kill("SIGKILL"), ms);
        child.on("exit", () => (clearTimeout(timer), resolve(out.trim())));
      });
    const SPACE = "pobots test check";
    const closeTestSpaces = async () => {
      const out = await egoScript(
        [
          "for (const s of await listTaskSpaces()) {",
          '  if (typeof s.name !== "string" || !s.name.startsWith("pobots test")) continue;',
          '  try { const t = s.ownership === "agent" ? await taskSpace(s.id) : null; if (t) await t.finish({ keep: [] }); } catch (e) {}',
          "}",
          'console.log(JSON.stringify((await listTaskSpaces()).filter((s) => typeof s.name === "string" && s.name.startsWith("pobots test")).length));',
        ].join("\n"),
      );
      return Number(out.split("\n").pop());
    };
    if (!egoInstalled) {
      console.log("skip  the browser: ego-browser is not installed");
    } else {
      // The Mac's host rule (16 Nov 2026) has every bot create a workspace in the person's profile, so
      // the first command does that itself. Later commands use the workspace without a profile:
      // ego-browser refuses a profile for a workspace that exists already.
      const command = ["ego-browser nodejs <<'EOF'", `const task = await taskSpace("${SPACE}", { profileId: "Profile 1" });`, 'await task.page("p1").goto("https://example.com");', "console.log(task.spaceId);", "EOF"].join("\n");
      const allowed = (detail) => {
        const d = String(detail ?? "");
        const hosts = [...d.matchAll(/https?:\/\/([^/"'\s)]+)/g)].map((m) => m[1]);
        const names = [...d.matchAll(/taskSpace\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
        // A profile only as the host rule names it, the person's own ("Profile 1"); no other option.
        const profiles = [...d.matchAll(/profileId\s*:\s*["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
        const options = [...d.matchAll(/taskSpace\(\s*["'`][^"'`]+["'`]\s*,\s*\{([^}]*)\}/g)].map((m) => m[1].trim());
        return /ego-browser\s+nodejs/.test(d) && hosts.length > 0 && hosts.every((h) => h === "example.com" || /^127\.0\.0\.1:\d+$/.test(h)) && names.length === 1 && names[0] === SPACE
          && profiles.every((p) => p === "Profile 1") && options.every((o) => /^profileId\s*:\s*["'`]Profile 1["'`]\s*,?$/.test(o)) && !/takeOver|claim|handOff|finish|import|cookie|storage/i.test(d);
      };
      // The person's own instructions tell a bot to read the browser guide first ("ego-browser skill",
      // which only prints it); without it the bot stopped here on 13 Nov 2026. That is allowed too.
      const guide = (detail) => /^\s*ego-browser\s+skill\s*$/.test(String(detail ?? ""));
      // Only exactly that command (and the guide) is allowed; every other card is denied.
      const answerCards = setInterval(async () => {
        try {
          for (const card of (await side2.request("snapshot")).cards) {
            const yes = card.kind === "approval" && card.title === "Run this command?" && (allowed(card.detail) || guide(card.detail));
            await side2.request("card.resolve", { cardId: card.id, decision: { type: yes ? "allow-once" : "deny" } }).catch(() => undefined);
          }
        } catch {}
      }, 1000);
      try {
        await closeTestSpaces();
        await type(`Run exactly this command with your Bash tool, once, and nothing else. It creates the workspace in my profile, opens a page in it and leaves it open for me. Then say done in one short sentence.\n\n${command}`);
        const brow = `[...document.querySelectorAll(".app-main .pb-thread .pb-browser")].at(-1)`;
        const named = await until(`${brow}?.querySelector(".pb-browser-name")?.textContent`, 180_000);
        check("the bot's browser work shows as a row in the chat", String(named) === SPACE, `${named}: ${await js(`${brow}?.querySelector(".pb-browser-last")?.textContent`)}`);
        await until(`(${headStatus}) === "Done"`, 120_000);
        check("the row stays in sight after the turn, because the workspace is still open", !!(await until(`!!${brow} && ${brow}.dataset.status === "open" && !${brow}.closest(".pb-work")`, 20_000)), String(await js(`${brow}?.dataset.status`)));
        const line = await until(`document.querySelector(".app-browser .pb-browser-line .pb-browser-line-word")?.textContent`, 15_000);
        check("the roster has a quiet Browser line that says how much is open", /\d+ open/.test(String(line)), String(line));
        await shot("27-browser-row");
        const state = await side2.request("browser.state");
        const mine = state.spaces.find((x) => x.name === SPACE);
        check("the engine lists the workspace as the bot's", !!mine && mine.owner === "bot" && mine.botId === "kaja" && !state.spaces.some((x) => x.id === "0"), JSON.stringify(mine && { owner: mine.owner, botId: mine.botId, pages: mine.pages.length }));
        await js(`${brow}.click()`);
        const panel = `document.querySelector('section.app-artifact[data-content="browser"] .pb-browser-panel')`;
        check("the row opens the browser in the panel beside the chat", !!(await until(`document.querySelector(".app-shell")?.dataset.artifact === "side" && !!${panel}`, 20_000)), String(await js(`document.querySelector(".pb-browser-bar-title")?.textContent`)));
        check("a live picture of the page arrives", !!(await until(`!!document.querySelector(".pb-browser-body[data-shown]")`, 30_000)) && /example\.com/.test(String(await js(`document.querySelector(".pb-browser-where")?.textContent`))), String(await js(`document.querySelector(".pb-browser-where")?.textContent`)));
        await shot("28-browser-panel");
        // A click without control must not reach the page; with control it must.
        await egoScript(`const t = await taskSpace(${JSON.stringify(SPACE)}); await t.page("p1").evaluate(() => { window.__clicks = 0; document.addEventListener("click", () => { window.__clicks++; }); }); console.log("ready");`);
        const clicksNow = async () => Number((await egoScript(`const t = await taskSpace(${JSON.stringify(SPACE)}); console.log(await t.page("p1").evaluate(() => window.__clicks));`)).split("\n").pop());
        const clickPicture = async () => {
          const r = await js(`(() => { const c = document.querySelector(".pb-browser-canvas").getBoundingClientRect(); return { x: c.left + c.width * 0.8, y: c.top + c.height * 0.85 }; })()`);
          await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
          await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
          await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
          await sleep(1500);
        };
        await clickPicture();
        check("without control a click over the picture does not reach the page", (await clicksNow()) === 0);
        await js(`document.querySelector("button.pb-browser-take").click()`);
        check("Take control turns into Hand back", !!(await until(`document.querySelector("button.pb-browser-take")?.textContent.trim() === "Hand back"`, 15_000)), String(await js(`document.querySelector(".pb-browser-stateline")?.textContent`)));
        await clickPicture();
        const got = await clicksNow();
        check("in control a click over the picture reaches the page", got === 1, `clicks seen by the page: ${got}`);
        await shot("29-browser-control");
        // What the browser draws outside the page: a drop-down list and a question of the page. The
        // check serves a small page of its own on this Mac and sends the bot's workspace there.
        const PAGE =
          '<!doctype html><html><head><meta charset="utf-8"><title>Check page</title></head><body style="font:16px sans-serif;margin:40px">' +
          '<select id="pick"><option>Apple</option><option>Pear</option><option>Plum</option></select>' +
          '<p style="margin-top:60px"><button id="ask">Ask</button></p>' +
          '<script>document.getElementById("pick").addEventListener("change",function(e){window.__picked=e.target.value});' +
          'document.getElementById("ask").addEventListener("click",function(){window.__answer=confirm("Sure about this?")});</script></body></html>';
        const srv = createServer((req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE);
        });
        await new Promise((r) => srv.listen(0, "127.0.0.1", r));
        try {
          const local = `http://127.0.0.1:${srv.address().port}/`;
          // The bot moves its own page, as in real use. (A script from outside that moves a bot's page is
          // followed late by the picture: seen 12 Nov 2026, and nothing does that outside a check.)
          const move = ["ego-browser nodejs <<'EOF'", `const task = await taskSpace("${SPACE}");`, `await task.page("p1").goto("${local}");`, "console.log(task.spaceId);", "EOF"].join("\n");
          await type(`Run exactly this command with your Bash tool, once, and nothing else. It moves the page that is open in the browser. The workspace exists already, so run it word for word, without a profileId: ego-browser refuses a profile for a workspace that exists. Then say done in one short sentence.\n\n${move}`);
          check("when the bot moves its page, the line under the name follows at once", !!(await until(`/127\\.0\\.0\\.1/.test(document.querySelector(".pb-browser-where")?.textContent ?? "")`, 120_000)), String(await js(`document.querySelector(".pb-browser-where")?.textContent`)));
          await until(`(${headStatus}) === "Done"`, 120_000);
          const pageValue = async (expr) => (await egoScript(`const t = await taskSpace(${JSON.stringify(SPACE)}); console.log(JSON.stringify(await t.page("p1").evaluate(() => (${expr}))));`)).split("\n").pop();
          const clickInPage = async (selector) => {
            const at = JSON.parse(await pageValue(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight }; })()`));
            const r = await js(`(() => { const c = document.querySelector(".pb-browser-canvas").getBoundingClientRect(); return { x: c.left + (${at.x} / ${at.w}) * c.width, y: c.top + (${at.y} / ${at.h}) * c.height }; })()`);
            await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
            await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
            await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
          };
          await sleep(1500);
          await clickInPage("#pick");
          const choices = await until(`[...document.querySelectorAll(".pb-browser-over .pb-browser-choices .pb-browser-choice")].map((o) => o.textContent.trim()).join(",")`, 15_000);
          check("a press on a drop-down list opens its choices over the picture", String(choices) === "Apple,Pear,Plum", String(choices));
          await shot("29b-browser-choices");
          await js(`document.querySelector('.pb-browser-choices .pb-browser-choice[data-index="1"]').click()`);
          await until(`!document.querySelector(".pb-browser-choices")`, 10_000);
          await sleep(800);
          const picked = await pageValue(`({ value: document.getElementById("pick").value, heard: window.__picked })`);
          check("choosing one changes the list in the page, and the page hears it", picked === JSON.stringify({ value: "Pear", heard: "Pear" }), String(picked));
          await clickInPage("#ask");
          const asked = await until(`document.querySelector(".pb-browser-over .pb-browser-ask .pb-browser-ask-message")?.textContent`, 15_000);
          check("a question from the page shows as a card over the picture", /Sure about this\?/.test(String(asked)), String(asked));
          await shot("29c-browser-question");
          await js(`[...document.querySelectorAll(".pb-browser-ask button")].find((b) => b.textContent.trim() === "OK").click()`);
          await until(`!document.querySelector(".pb-browser-ask")`, 10_000);
          await sleep(800);
          const answer = await pageValue(`window.__answer`);
          check("OK on the card answers the page", answer === "true", String(answer));
          // Tabs: the bot opens a second page; both show in the row, and a click on a tab shows that page.
          const tabs = `[...document.querySelectorAll(".pb-browser-tabs .pb-browser-tab")]`;
          check("with one page the row of tabs is there, with one tab", (await js(`${tabs}.length`)) === 1 && !!(await js(`!!document.querySelector(".pb-browser-tabs")`)));
          const topBefore = await js(`document.querySelector(".pb-browser-picture").getBoundingClientRect().top`);
          const second = ["ego-browser nodejs <<'EOF'", `const task = await taskSpace("${SPACE}");`, "const page = await task.newPage();", 'await page.goto("https://example.com");', "console.log(page.label);", "EOF"].join("\n");
          await type(`Run exactly this command with your Bash tool, once, and nothing else. It opens a second page in the browser. The workspace exists already, so run it word for word, without a profileId: ego-browser refuses a profile for a workspace that exists. Then say done in one short sentence.\n\n${second}`);
          check("a second page the bot opens shows as a second tab", !!(await until(`${tabs}.length === 2`, 120_000)), String(await js(`${tabs}.map((t) => t.querySelector(".pb-browser-tab-name")?.textContent).join(" | ")`)));
          await until(`(${headStatus}) === "Done"`, 120_000);
          check("the picture follows the bot to its new page", !!(await until(`/example\\.com/.test(document.querySelector(".pb-browser-where")?.textContent ?? "") && /Example Domain/.test(${tabs}.find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? "")`, 20_000)), String(await js(`document.querySelector(".pb-browser-where")?.textContent`)));
          check("the new tab did not move the picture", (await js(`document.querySelector(".pb-browser-picture").getBoundingClientRect().top`)) === topBefore);
          await shot("29d-browser-tabs");
          await js(`${tabs}.find((t) => t.getAttribute("aria-selected") !== "true").click()`);
          check("a click on the other tab shows that page", !!(await until(`/127\\.0\\.0\\.1/.test(document.querySelector(".pb-browser-where")?.textContent ?? "") && /Check page/.test(${tabs}.find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? "")`, 20_000)), String(await js(`document.querySelector(".pb-browser-where")?.textContent`)));
          check("control is kept across the tabs", String(await js(`document.querySelector("button.pb-browser-take")?.textContent.trim()`)) === "Hand back");
          // A page that stands still gets a picture of exactly the size it is drawn at.
          const sharp = await until(`(() => { const c = document.querySelector(".pb-browser-canvas"); const w = Math.round(c.getBoundingClientRect().width * devicePixelRatio); return Math.abs(c.width - w) <= 2 ? c.width + " for " + w : ""; })()`, 20_000);
          check("a still page is drawn pixel for pixel", !!sharp, String(sharp || (await js(`document.querySelector(".pb-browser-canvas").width + " for " + Math.round(document.querySelector(".pb-browser-canvas").getBoundingClientRect().width * devicePixelRatio)`))));
        } finally {
          srv.close();
        }
        await js(`document.querySelector("button.pb-browser-take").click()`);
        check("Hand back gives control back", !!(await until(`document.querySelector("button.pb-browser-take")?.textContent.trim() === "Take control"`, 15_000)));
        await egoScript(`const t = await taskSpace(${JSON.stringify(SPACE)}); await t.finish({ keep: [] });`);
        check("when the workspace closes the row turns closed in its box and the panel says so", !!(await until(`${brow}?.dataset.status === "closed" && ${panel}?.hasAttribute("data-ended")`, 30_000)), `${await js(`${brow}?.querySelector(".pb-browser-word")?.textContent`)} / ${await js(`document.querySelector(".pb-browser-stateline")?.textContent`)}`);
        await shot("30-browser-closed");
        await js(`document.querySelector('.pb-browser-tools .pb-tool[aria-label="Close"]').click()`);
        check("Close gives the space back to the rail again", !!(await until(`!document.querySelector(".app-shell")?.hasAttribute("data-artifact")`, 10_000)));
      } catch (err) {
        // A failure here is recorded and the later steps still run.
        check("the browser part ran to the end", false, err instanceof Error ? err.message : String(err));
        await js(`document.querySelector('.pb-browser-tools .pb-tool[aria-label="Close"]')?.click()`);
      } finally {
        clearInterval(answerCards);
        const left = await closeTestSpaces();
        check("no test workspace is left in the browser", left === 0, `${left} left`);
      }
    }

    // 12. A webhook the main bot makes itself: since docs/build/step-main-bot-tools.md at once with a
    //     quiet line in its chat and no card (a bot that is not the main bot still asks,
    //     engine/tests/webhooks.spec.ts). The bot gets its address to set up the sender; the line says
    //     so and never holds it. Then it is in the Triggers tab, and a call to its address wakes the bot.
    await type("Use your set_webhook tool to make a webhook named Check webhook. When it is called you are told: Reply with only the value of the field code, nothing else. Do not repeat its address to me. Then say done in one short sentence.");
    const hookOf = async () => (await side2.request("trigger.list", { botId: "kaja" })).triggers.find((x) => x.kind === "webhook" && x.name === "Check webhook");
    for (let end = Date.now() + 120_000; !(await hookOf()) && Date.now() < end; ) await sleep(500);
    await until(`(${headStatus}) === "Done"`, 120_000);
    check("making a webhook asks no card of the main bot", !(await side2.request("snapshot")).cards.some((c) => c.kind === "approval" && /webhook/i.test(c.title)));
    // The person is told in a quiet line in the chat when the turn ends (the tester's walk of 15 Nov
    // 2026: no note card under Needs you).
    const hookLine = `[...document.querySelectorAll(".app-main .app-notice")].map((n) => n.textContent).find((t) => t.startsWith("Kaja: a new webhook Check webhook"))`;
    const hookNote = await until(hookLine, 20_000);
    check("a quiet line in the chat tells the person the webhook was made and that the bot has its address", typeof hookNote === "string" && /Kaja has its address, to set up the sender/.test(hookNote), String(hookNote));
    check("and nothing about it under Needs you", !(await side2.request("snapshot")).cards.some((c) => c.kind === "note"), JSON.stringify((await side2.request("snapshot")).cards.map((c) => [c.kind, c.title])));
    await shot("31-webhook-made");
    const madeHook = await hookOf();
    check("the webhook exists and says the bot made it", !!madeHook && madeHook.createdBy === "bot" && madeHook.madeByBotId === "kaja", JSON.stringify(madeHook && { createdBy: madeHook.createdBy, madeByBotId: madeHook.madeByBotId, enabled: madeHook.enabled }));
    await openTab("triggers");
    check("the Triggers tab lists it", !!(await until(`[...document.querySelectorAll(".pb-trigger-name")].some((n) => n.textContent === "Check webhook")`, 10_000)));
    await openTab("chat");
    if (madeHook) {
      const { hookPath } = await side2.request("trigger.address", { triggerId: madeHook.id });
      const port = new URL(endpoint.url.replace("ws:", "http:")).port;
      const res = await fetch(`http://127.0.0.1:${port}${hookPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "amber-2291" }) });
      check("a call to its address is taken", res.status === 202, String(res.status));
      check("and wakes the bot, which answers from what was sent", !!(await until(`(${headStatus}) === "Done" && /amber-2291/.test(${lastAnswer})`, 180_000)), JSON.stringify(await js(lastAnswer)).slice(0, 80));
      check("the address is nowhere in the chat", !(await js(`document.querySelector(".app-main .pb-thread").textContent.includes(${JSON.stringify(hookPath.split("/")[3])})`)));
      check("nor in the person's line", typeof hookNote === "string" && !hookNote.includes(hookPath.split("/")[3]) && !hookNote.includes("/hook/"));
    }
    // 13. GPT models through Codex: a Claude bot gives one task to a helper on a GPT model, and a bot
    //     runs on a GPT model itself (answer, card, settings line), then is changed back to Claude.
    const snap13 = await side2.request("snapshot");
    const gpt = snap13.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap13.models.find((m) => m.harness === "codex");
    check("Codex is found and signed in, and the list holds GPT models", snap13.status.codex.ready === true && !!gpt, snap13.status.codex.problem ?? gpt?.label ?? "no GPT model");
    // Step 3b, fast mode: which tier Codex reported for a bot's threads and turns, from the engine's log.
    const tiersOf = (botId, from = 0) => [...engineLog.join("").slice(from).matchAll(new RegExp(`Bot ${botId}: Codex reports the tier (\\S+) \\(asked for (\\S+)\\)`, "g"))].map((m) => [m[1], m[2]]);
    const fastSwitch = `document.querySelector('.app-picker [role="switch"]')`;
    if (gpt) {
      check("the list says the GPT model has a fast mode, with Codex's words about it", gpt.fast === true && !!gpt.fastHint, `${gpt.label}: ${gpt.fastHint ?? "no words"}`);
      check("and no Claude model has one", snap13.models.filter((m) => m.harness === "claude").every((m) => !m.fast));
      // A Claude bot's picker has no switch to reach.
      await openBot("Kaja");
      await js(`document.querySelector('.pb-composer-bar button[aria-haspopup="dialog"]').click()`);
      await until(`!!document.querySelector(".app-picker")`, 10_000);
      check("a Claude bot's picker offers no Fast switch", !!(await js(`(() => { const s = ${fastSwitch}; return !s || !!s.closest("[inert], [aria-hidden='true']") || getComputedStyle(s).visibility === "hidden" || getComputedStyle(s.parentElement).visibility === "hidden"; })()`)));
      await shot("32a-claude-picker");
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(`!document.querySelector(".app-picker")`, 10_000);
      const gptEffort = gpt.efforts.includes("low") ? "low" : gpt.defaultEffort;
      await openBot("Kaja");
      await type(`Use your start_helper tool once with title Word check, model ${gpt.id}, effort ${gptEffort} and this task: Answer with the single word osprey and nothing else. Wait for it, then tell me the word it gave, in one short sentence.`);
      // "Asks first" does not ask for the bot's own tools; should a card come all the same, allow it.
      const helped = await until(`(() => { const c = [...document.querySelectorAll(".pb-rail .pb-card button")].find((b) => b.textContent.trim() === "Allow once"); if (c) c.click(); return (${headStatus}) === "Done" && /osprey/i.test(${lastAnswer}); })()`, 240_000, 1000);
      check("a Claude bot gets the word from a helper on a GPT model", !!helped, JSON.stringify(await js(lastAnswer)).slice(0, 100));
      // The finished turn folds its work; open it to see the helper's row.
      await js(`[...document.querySelectorAll(".app-main .pb-worked")].filter((b) => /helper/.test(b.textContent)).at(-1)?.click()`);
      const helperRow = await until(`(() => { const r = [...document.querySelectorAll(".app-main .pb-thread .pb-helper")].find((h) => /word check/i.test(h.querySelector(".pb-helper-title")?.textContent ?? "")); return r ? { title: r.querySelector(".pb-helper-title")?.textContent ?? "", model: r.querySelector(".pb-helper-model")?.textContent ?? "" } : null; })()`, 10_000);
      check("the helper's row says which model it ran on", !!helperRow && helperRow.model.includes(gpt.label), JSON.stringify(helperRow));
      check("and that it ran fast, as a helper does when the bot says nothing about it", !!helperRow && /, fast$/.test(helperRow.model.trim()), JSON.stringify(helperRow?.model));
      await shot("32-gpt-helper");

      await side2.request("bot.create", { name: "Luna", purpose: "Runs on a GPT model", job: "Answer briefly.", model: gpt.id, effort: gptEffort });
      await until(`[...document.querySelectorAll(".app-row .pb-row-name")].some((n) => n.textContent === "Luna")`, 10_000);
      await openBot("Luna");
      check("a bot on a GPT model shows its model in the composer", !!(await until(`document.querySelector(".pb-composer")?.textContent.includes(${JSON.stringify(gpt.label)})`, 10_000)), gpt.label);
      const lunaBot = (await side2.request("snapshot")).bots.find((b) => b.id === "luna");
      check("the engine says it runs on Codex", lunaBot?.harness === "codex", String(lunaBot?.harness));
      check("a new GPT bot is fast, and the message box says so", lunaBot?.fast === true && !!(await until(`/, fast/.test(document.querySelector('.pb-composer-bar button[aria-haspopup="dialog"]')?.textContent ?? "")`, 10_000)), String(await js(`document.querySelector('.pb-composer-bar button[aria-haspopup="dialog"]')?.textContent`)));
      let logAt = engineLog.join("").length;
      await type("Remember the code word: heron. Reply with the single word heron.");
      check("the GPT bot answers", !!(await until(`(${headStatus}) === "Done" && /heron/i.test(${lastAnswer})`, 180_000)), JSON.stringify(await js(lastAnswer)).slice(0, 80));
      const fastTiers = tiersOf("luna", logAt);
      check("with fast on, Codex says it ran the turn fast", fastTiers.length > 0 && fastTiers.every(([reported, asked]) => reported === "priority" && asked === "priority"), JSON.stringify(fastTiers));
      // Switch it off in the picker above the message box, as the person would.
      await js(`document.querySelector('.pb-composer-bar button[aria-haspopup="dialog"]').click()`);
      check("its picker has the Fast switch, on, with Codex's words", (await until(`(() => { const s = ${fastSwitch}; return s && s.getAttribute("aria-checked") === "true" && s.textContent.includes("Fast") ? s.textContent : null; })()`, 10_000))?.includes(gpt.fastHint) === true, String(await js(`${fastSwitch}?.textContent`)));
      await shot("32b-gpt-picker-fast-on");
      // The picker rises a few pixels as it arrives: measure once it stands still.
      await until(`(() => { const r = JSON.stringify(document.querySelector(".app-picker").getBoundingClientRect()); const same = window.__pickerBox === r; window.__pickerBox = r; return same; })()`, 10_000, 400);
      const pickerBox = await js(`JSON.stringify(document.querySelector(".app-picker").getBoundingClientRect())`);
      await js(`${fastSwitch}.click()`);
      check("switching it off is saved", !!(await until(`${fastSwitch}?.getAttribute("aria-checked") === "false"`, 10_000)) && (await side2.request("snapshot")).bots.find((b) => b.id === "luna")?.fast === false);
      check("the picker stays open and does not move", (await js(`JSON.stringify(document.querySelector(".app-picker")?.getBoundingClientRect() ?? null)`)) === pickerBox);
      check("the message box no longer says fast", !(await js(`/fast/i.test(document.querySelector('.pb-composer-bar button[aria-haspopup="dialog"]')?.textContent ?? "")`)));
      await shot("32c-gpt-picker-fast-off");
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(`!document.querySelector(".app-picker")`, 10_000);
      const threadBefore = collectCodexThreadIds();
      logAt = engineLog.join("").length;
      await type("Reply with the single word ibis.");
      check("switched off, the GPT bot answers", !!(await until(`(${headStatus}) === "Done" && /ibis/i.test(${lastAnswer})`, 180_000)), JSON.stringify(await js(lastAnswer)).slice(0, 80));
      const slowTiers = tiersOf("luna", logAt);
      check("and Codex says it ran that turn at the usual speed", slowTiers.length > 0 && slowTiers.every(([reported, asked]) => reported === "default" && asked === "default"), JSON.stringify(slowTiers));
      check("in the same session as before", JSON.stringify(collectCodexThreadIds()) === JSON.stringify(threadBefore), `${threadBefore.length} before`);
      check("nothing in the engine's log says Codex ran another speed than asked", !/reports another tier/.test(engineLog.join("")));
      await type("Run exactly this shell command and nothing else: touch gpt-approved.txt");
      const gptCard = await until(`document.querySelector(".pb-rail .pb-card-title")?.textContent`, 180_000);
      check("the GPT bot asks on a card before a command", !!gptCard, String(gptCard));
      check("that card offers no Always allow", !(await js(`[...document.querySelectorAll(".pb-rail .pb-card button")].some((b) => b.textContent.trim() === "Always allow")`)));
      await shot("33-gpt-card");
      await clickButton("Allow once");
      check("allowing runs the command", !!(await until(`(${headStatus}) === "Done"`, 180_000)) && existsSync(join(botsDir, "luna", "gpt-approved.txt")));
      await openTab("settings");
      check("its settings say which program runs it", !!(await until(`document.querySelector(".pb-settings")?.textContent.includes("Runs on Codex with your ChatGPT login.")`, 10_000)));
      await shot("34-gpt-settings");
      await openTab("chat");
      collectCodexThreads();
      await side2.request("bot.update", { botId: "luna", patch: { model: cheap.id, effort: cheap.efforts.includes("low") ? "low" : cheap.defaultEffort } });
      check("changing it to Claude says so in the chat", !!(await until(`document.querySelector(".app-main .pb-thread")?.textContent.includes("Changed from ChatGPT to Claude")`, 15_000)));
      await type("What was the code word? Answer with the word only.");
      check("after the change the bot still knows the end of the chat", !!(await until(`(${headStatus}) === "Done" && /heron/i.test(${lastAnswer})`, 180_000)), JSON.stringify(await js(lastAnswer)).slice(0, 80));
      await shot("35-changed-to-claude");
    }

    // 14. Stop holds (step 3b, third part): a message that waited when Stop was pressed stays waiting,
    //     the bot starts nothing by itself, and the next message from the person lets both be read.
    await openBot("Helper");
    await side2.request("bot.update", { botId: "helper", patch: { access: "full-access" } });
    // This step is about a message that waits in line: the setting says queue for it (step 18 steers).
    await side2.request("chat.set", { followUp: "queue" });
    const helperBot = async () => (await side2.request("snapshot")).bots.find((b) => b.id === "helper");
    const helperThread = (await helperBot()).mainThreadId;
    const seqBefore = Math.max(0, ...(await side2.request("thread.read", { threadId: helperThread, limit: 5 })).items.map((i) => i.seq));
    const itemsSince = async () => (await side2.request("thread.read", { threadId: helperThread, limit: 40 })).items.filter((i) => i.seq > seqBefore);
    await type(`Run exactly this shell command in the foreground and wait for it, then answer with the single word first: node -e "setTimeout(()=>{},100000)"`);
    // What the bot does now is asked of the engine: the header's words for it are the window's own.
    const untilHelper = async (ok, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        const b = await helperBot();
        if (ok(b)) return b;
        if (Date.now() > end) return undefined;
        await sleep(250);
      }
    };
    const inCommand = await untilHelper((b) => b.state === "working" && b.activity === "Running a command", 90_000);
    check("the bot is in a command", !!inCommand, JSON.stringify(await helperBot().then((b) => [b.state, b.activity])));
    await type("Answer with the single word: second.");
    // Since step 7a a waiting message stands in the stack above the message box.
    check("a message sent meanwhile waits", !!(await until(`[...document.querySelectorAll(".app-main .pb-queued-text")].some((n) => n.textContent === "Answer with the single word: second.")`, 10_000)));
    check("Stop is offered", !!(await js(`(() => { const b = document.querySelector('.app-main button[aria-label="Stop Helper"]'); if (!b) return false; b.click(); return true; })()`)));
    const stoppedBot = await untilHelper((b) => b.state === "done" && /^Stopped/.test(b.activity), 30_000);
    check("the bot ends stopped", !!stoppedBot && !!(await until(`/Stopped/.test(${headStatus})`, 10_000)), `${JSON.stringify(await helperBot().then((b) => [b.state, b.activity]))} header: ${await js(headStatus)}`);
    // Watched for 12 seconds, twice a second: the bot never leaves rest and nothing new comes into the chat.
    const atStop = await itemsSince();
    const lastSeq = Math.max(...atStop.map((i) => i.seq));
    const seen = new Set();
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const b = await helperBot();
      seen.add(`${b.state}/${b.activity}`);
    }
    const held = await itemsSince();
    const heldBot = await helperBot();
    check("after Stop the bot is at rest in every one of 24 looks over 12 seconds", [...seen].every((x) => x === "done/Stopped, 1 message waiting"), JSON.stringify([...seen]));
    check("the waiting message still waits and nothing new came into the chat", held.filter((i) => i.kind === "user" && i.queued).length === 1 && !held.some((i) => i.seq > lastSeq) && atStop.filter((i) => i.kind === "notice" && i.text === "Stopped.").length === 1, JSON.stringify({ kinds: held.map((i) => i.kind + (i.queued ? ":queued" : "")), newer: held.filter((i) => i.seq > lastSeq).map((i) => i.kind) }));
    check("the roster says what waits", heldBot.activity === "Stopped, 1 message waiting" && !!(await js(`[...document.querySelectorAll(".app-row")].some((r) => r.querySelector(".pb-row-name")?.textContent === "Helper" && /Stopped, 1 message waiting/.test(r.querySelector(".pb-row-line")?.textContent ?? ""))`)), String(heldBot.activity));
    check("the line above the message box says what starts the bot again", (await js(`[...document.querySelectorAll(".app-main .app-line")].map((l) => l.textContent).join("|")`)) === "Queued, Helper will read this when you write again", String(await js(`[...document.querySelectorAll(".app-main .app-line")].map((l) => l.textContent).join("|")`)));
    check("the window still shows it waiting, above the message box, with no Steer now while the Stop holds", !!(await js(`(() => { const q = [...document.querySelectorAll(".app-main .pb-queued")].find((x) => x.querySelector(".pb-queued-text")?.textContent === "Answer with the single word: second."); return !!q && !q.querySelector(".app-you-steer"); })()`)));
    await shot("36-stop-holds");
    await type("Answer with the single word: third.");
    const released = await until(`(${headStatus}) === "Done" && /third/i.test(${lastAnswer})`, 180_000);
    const after = (await itemsSince()).filter((i) => i.kind === "bot").map((i) => (i.text ?? "").trim().toLowerCase());
    check("a new message from the person lets the bot read both, in order", !!released && after.some((t) => /second/.test(t)) && after.findIndex((t) => /second/.test(t)) < after.findIndex((t) => /third/.test(t)), JSON.stringify(after.map((t) => t.slice(0, 30))));
    check("nothing waits any more", !(await itemsSince()).some((i) => i.kind === "user" && i.queued));
    await shot("37-stop-released");
    await side2.request("chat.set", { followUp: "steer" });
    side2.close();
  }
}
