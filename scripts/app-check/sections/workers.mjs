// The app check's section "workers" (docs/build/step-workers.md): a real bot on the cheapest Claude
// model starts a worker with start_helper for two small jobs. The worker reads a made-up bulky file
// (about 30,000 tokens) for the first, asks to be shortened with its tool, does the second, and the bot
// gets a result that proves the worker knew what it kept. The worker's thread shows the line with the
// sizes, and the worker's next request really was smaller. Then a worker of a kind the check writes.
// Run it alone: node scripts/app-check.mjs --only=workers. What it shares with the other sections is
// in ../lib.mjs (step 1's bot and model in `run`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, botsDir, check, engineLog, sideChannel, run } from "../lib.mjs";

const WORD1 = "TANGERINE";
const WORD2 = "MAPLE";

/** About 30,000 tokens of made-up lines, with the word for the first job on line 1234 only. */
function bulky() {
  const lines = [];
  for (let i = 1; i <= 2500; i++) lines.push(i === 1234 ? `Line ${i}: the word to remember is ${WORD1}.` : `Line ${i}: the quick brown fox number ${(i * 7919) % 100000} jumps over the lazy dog.`);
  return lines.join("\n") + "\n";
}

export default async function section() {
  const { endpoint, cheap } = run;
  const side = await sideChannel(endpoint);
  try {
    const snap = await side.request("snapshot");
    const haiku = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
    const low = haiku.efforts.includes("low") ? "low" : haiku.defaultEffort;
    const bot = (await side.request("bot.create", { name: "Workman", purpose: "Starts workers for the workers check", job: "Do what you are asked, briefly.", model: haiku.id, effort: low, access: "edits-freely" })).bot;
    const dir = join(botsDir, bot.id);
    writeFileSync(join(dir, "bulky.txt"), bulky());
    writeFileSync(join(dir, "small.txt"), `The second word is ${WORD2}.\n`);
    check("workers: a new bot has WORKERS.md with the built-in text", (await side.request("bot.file.read", { botId: bot.id, path: "WORKERS.md" }).catch(() => undefined))?.text?.includes("shorten_conversation") ?? false);

    /** Sends one message and waits until the bot rests with no helper working. */
    const turn = async (text, ms = 300_000) => {
      await side.request("message.send", { botId: bot.id, text });
      const end = Date.now() + ms;
      let cards = 0;
      await sleep(1500);
      while (Date.now() < end) {
        const s = await side.request("snapshot");
        for (const card of s.cards.filter((x) => x.botId === bot.id)) {
          cards++;
          await side.request("card.resolve", { cardId: card.id, decision: { type: card.kind === "question" ? "later" : "deny" } }).catch(() => undefined);
        }
        const b = s.bots.find((x) => x.id === bot.id);
        if (b && (b.state === "done" || b.state === "idle" || b.state === "blocked") && !b.helpers) return { cards, rested: true };
        await sleep(1000);
      }
      return { cards, rested: false };
    };

    // 1. Two jobs, shortened in between.
    const task = [
      "You have two jobs. Use only your own tools (Read, and shorten_conversation); no connector or MCP server.",
      `Job 1: read the file bulky.txt in your folder in full, all of it, in as many reads as it takes. Line 1234 holds a word to remember.`,
      `When job 1 is done, call your tool shorten_conversation once, with keep set to the word from line 1234 and that job 1 is done, and next set to: job 2, read small.txt and answer. Then end your turn with one line.`,
      `Job 2 (after you are told to carry on): read small.txt in your folder. Then answer with one line only: the word from line 1234 of bulky.txt, a space, and the word in small.txt.`,
    ].join("\n\n");
    const logFrom = engineLog.join("").length;
    const ask = `This is a test inside Pobots only. Use your Pobots tool start_helper (mcp__pobots__start_helper) exactly once, with title "Two jobs", model ${haiku.id}, effort ${low}, and wait true, and this task, word for word:\n\n${task}\n\nWhen it returns, reply with the helper's result word for word and nothing else.`;
    const r1 = await turn(ask);
    check("workers: the bot's turn and its worker ended", r1.rested);
    check("workers: no card was raised", r1.cards === 0, `${r1.cards} cards`);
    const items = (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
    const row = items.find((i) => i.kind === "helper" && i.title === "Two jobs");
    check("workers: the worker's row names its model and is done", row?.status === "done" && row.model === haiku.id && row.harness === "claude", JSON.stringify(row && { status: row.status, model: row.model, harness: row.harness, last: row.last }));
    const said = items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    check("workers: the bot's answer holds the word the worker kept and the one it read after", new RegExp(WORD1, "i").test(said) && new RegExp(WORD2, "i").test(said), said.slice(-160));
    let lines = [];
    if (row) {
      const thread = (await side.request("thread.read", { threadId: row.helperThreadId, limit: 300 })).items;
      lines = thread.filter((i) => i.kind === "notice" && i.mark === "compacted").map((i) => i.text);
      const calls = thread.filter((i) => i.kind === "activity").map((i) => i.label);
      check("workers: the worker's thread shows a quiet line where it was shortened, with the sizes", lines.some((l) => /^Shortened on request: [\d,]+ to [\d,]+ tokens$/.test(l)), lines.join(" | ") || calls.join(" | "));
      const m = lines.map((l) => /^Shortened on request: ([\d,]+) to ([\d,]+) tokens$/.exec(l)).find(Boolean);
      if (m) {
        const pre = Number(m[1].replace(/,/g, ""));
        const post = Number(m[2].replace(/,/g, ""));
        check("workers: it was shortened from a big conversation to a small one", pre > 30_000 && post < pre / 2, `${pre} to ${post}`);
      }
    }
    // The engine logs the size of each of the worker's turns: the one that asked, then the summary's, then the last.
    const log = engineLog.join("").slice(logFrom);
    const sizes = [...log.matchAll(new RegExp(`Bot ${bot.id}: a helper's turn ended\\. Session (\\d+) tokens`, "g"))].map((x) => Number(x[1]));
    const asked = sizes[0];
    const last = sizes.at(-1);
    check("workers: the worker's next request really was smaller after it was shortened", sizes.length >= 2 && asked > 30_000 && last < asked, sizes.join(", "));

    // 2. A worker of a kind written by the check, with no model on the call.
    mkdirSync(join(dir, "workers"), { recursive: true });
    writeFileSync(join(dir, "workers", "closer.md"), `---\ndescription: Answers in one line and signs off\nmodel: ${haiku.id}\neffort: ${low}\nshorten: false\n---\nEnd every answer with the word OVER in capitals.\n`);
    const r2 = await turn(`This is a test inside Pobots only. Use your Pobots tool start_helper exactly once, with title "Kind check", kind closer, no model, wait true, and the task: Say hello in one short line. When it returns, reply with the helper's result word for word and nothing else.`, 180_000);
    const items2 = (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 200 })).items;
    const row2 = items2.find((i) => i.kind === "helper" && i.title === "Kind check");
    check("workers: a worker of a kind gets the kind's model", r2.rested && row2?.status === "done" && row2.model === haiku.id && row2.effort === low, JSON.stringify(row2 && { status: row2.status, model: row2.model, effort: row2.effort }));
    const thread2 = row2 ? (await side.request("thread.read", { threadId: row2.helperThreadId, limit: 50 })).items : [];
    const words2 = thread2.filter((i) => i.kind === "bot").map((i) => i.text).join(" ");
    check("workers: the worker followed what its kind tells it", /OVER/.test(words2), words2.slice(-120));
    const ownLog = engineLog.join("").slice(logFrom);
    check("workers: the kind worker had no shorten tool (the kind said so)", new RegExp(`Bot ${bot.id}: started a helper on ${haiku.id}, kind closer, summarised at \\d+ tokens(?!, may ask)`).test(ownLog), ownLog.match(/started a helper on [^\n]*kind closer[^\n]*/)?.[0] ?? "no such line");
  } finally {
    side.close();
  }
}
