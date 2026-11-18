// The app check, section "firststart" (engine 0.33.0, docs/build/step-first-start.md): a new install's
// first start on a real engine, an empty folder and the cheapest Claude model. Step 1 of the check
// (app-check.mjs) already made the main bot Kaja on the first-start screen, on Haiku, and saw it greet
// by itself. Here:
//
//   1. Kaja's chat starts with its greeting and a question, with no message from the person before it.
//   2. Answered as a made-up person (Ada, example.com), Kaja writes About you with change_settings:
//      the note is kept, and a quiet line in its chat gives the word count, not the words.
//   3. The window's Settings > General > About you shows it; a line added there and saved is kept.
//   4. A second bot made afterwards reads it from its own instructions.
//   5. The engine's log has none of the words.
//
// Nothing here reaches outside Pobots: no connector, no service, no file outside the check's folders.
// Run it alone: node scripts/app-check.mjs --only=firststart
import { sleep, check, sideChannel, run, js, cmd, until, engineLog } from "../lib.mjs";

const SAFE = "This is a check inside Pobots only. Use only your Pobots tools, no connectors or MCP servers, and change no files outside your own folder.";

export default async function section() {
  const { endpoint, cheap } = run;
  const s = await sideChannel(endpoint);
  const effort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  try {
    const snap0 = await s.request("snapshot");
    const kaja = snap0.bots.find((b) => b.id === "kaja");
    const cardsAtStart = new Set(snap0.cards.map((c) => c.id));
    const state = async (id) => (await s.request("snapshot")).bots.find((b) => b.id === id);
    const rested = async (id, ms = 180_000) => {
      const end = Date.now() + ms;
      await sleep(1200);
      while (Date.now() < end) {
        for (const c of (await s.request("snapshot")).cards) {
          if (cardsAtStart.has(c.id)) continue;
          await s.request("card.resolve", { cardId: c.id, decision: c.kind === "question" ? { type: "later" } : { type: "deny" } }).catch(() => undefined);
        }
        const b = await state(id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers) return true;
        await sleep(800);
      }
      return false;
    };

    // 1. The greeting is the first thing in the chat.
    const first = (await s.request("thread.read", { threadId: kaja.mainThreadId, limit: 50 })).items.filter((i) => i.kind === "user" || i.kind === "bot");
    check("firststart: the main bot's chat starts with its greeting and a question, nothing from the person before it", first[0]?.kind === "bot" && /\?/.test(first[0].text) && !first.some((i) => i.kind === "user"), JSON.stringify(first.map((i) => [i.kind, String(i.text).slice(0, 60)])));

    // 2. Answered as Ada, it writes About you.
    await s.request("message.send", {
      botId: "kaja",
      text: `${SAFE} I am Ada, I run customer onboarding at Example Ltd (example.com). What matters to me is clear plans. I am responsible for onboarding new customers. I like short, plain answers. That is enough for now: write the note about me with change_settings about_you, then reply with the word done.`,
    });
    check("firststart: the main bot answers", await rested("kaja"));
    const written = (await s.request("snapshot")).aboutYou;
    check("firststart: the main bot wrote About you with what it was told", /Ada/.test(written) && /onboarding/i.test(written) && written.length <= 4000, JSON.stringify(written).slice(0, 160));
    const lines = (await s.request("thread.read", { threadId: kaja.mainThreadId, limit: 100 })).items.filter((i) => i.kind === "notice" && !i.mark && i.text.startsWith("Pobots settings: ")).map((i) => i.text);
    check("firststart: a quiet line says About you was written, with the word count, not the words", lines.some((l) => /^Pobots settings: About you (written|changed) \(about \d+ words\)/.test(l)) && !lines.some((l) => /Ada|onboarding/i.test(l)), JSON.stringify(lines));

    // 3. The window shows it, and a line added there is kept.
    await js(`document.querySelector(".pb-foot-settings").click()`);
    const shown = await until(`document.querySelector("#about-you")?.value`, 10_000);
    check("firststart: Settings > General > About you shows the main bot's note", shown === written, JSON.stringify(shown).slice(0, 80));
    await js(`(() => { const t = document.querySelector("#about-you"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
    await cmd("Input.insertText", { text: "\nShe works from Stockholm." });
    await js(`[...document.querySelectorAll('[data-section="about"] button')].find((b) => b.textContent.trim() === "Save").click()`);
    const saved = await until(`document.querySelector('[data-section="about"] .pb-saved')?.hasAttribute("data-show")`, 10_000);
    const kept = (await s.request("snapshot")).aboutYou;
    check("firststart: a line added in the window is saved and kept by the engine", !!saved && kept.endsWith("She works from Stockholm."), JSON.stringify(kept).slice(-60));
    await js(`document.querySelector(".pb-appsettings-back")?.click()`);
    await sleep(400);

    // 4. A second bot made afterwards reads it from its own instructions.
    const reader = (await s.request("bot.create", { name: "Reader", purpose: "For the first-start check", job: "Answer briefly. Never use a connector or an MCP server.", model: cheap.id, effort, access: "asks-first" })).bot;
    await s.request("message.send", { botId: reader.id, text: `${SAFE} Use no tools at all. Your instructions from Pobots say something about the person you work for. From which city does that person work? Answer with the city only.` });
    check("firststart: the second bot answers", await rested(reader.id));
    const said = (await s.request("thread.read", { threadId: reader.mainThreadId, limit: 20 })).items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    check("firststart: a second bot reads About you from its instructions", /Stockholm/i.test(said), said.slice(0, 120));
    await s.request("bot.retire", { botId: reader.id }).catch(() => undefined);

    // 5. None of the words in the engine's log.
    // The check runs the engine with POBOTS_DEBUG=1, so this is the most it ever writes.
    const log = engineLog.join("");
    check("firststart: the engine's log has none of About you's words", !!log && !/Example Ltd|Stockholm|customer onboarding/i.test(log), log ? "" : "no log read");
  } finally {
    s.close();
  }
}
