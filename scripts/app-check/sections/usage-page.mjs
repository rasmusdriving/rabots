// A built engine and browser, using only made-up history under an isolated home.
// The window and the websocket must agree on the estimates and include appended history.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, js, openWindow, shot, sideChannel, sleep, startEngine, stopEngine, until, work } from "../lib.mjs";

export default async function section() {
  await stopEngine();
  const home = join(work, "usage-home");
  const dataDir = join(work, "usage-data");
  const botsDir = join(work, "usage-bots");
  const claude = join(home, ".claude", "projects", "example");
  const codex = join(home, ".codex", "sessions", "example");
  for (const path of [dataDir, botsDir, claude, codex]) mkdirSync(path, { recursive: true });
  const timestamp = new Date(Date.now() - 10_000).toISOString();
  const usage = (n, id) => ({
    type: "assistant", timestamp, sessionId: "example-claude", requestId: id,
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: n, cache_read_input_tokens: 1_000_000, output_tokens: 10_000 }, content: "Fixture message must not leave the engine." },
  });
  const write = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const cFile = join(claude, "example.jsonl");
  write(cFile, [usage(100_000, "a"), usage(100_000, "a")]);
  write(join(codex, "example.jsonl"), [
    { timestamp, type: "session_meta", payload: { id: "example-codex" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-6-luna" } },
    { timestamp, type: "token_usage_record", payload: { response_id: "a", usage: { input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 1_000 } } },
  ]);
  const endpoint = await startEngine({ dataDir, botsDir, env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") } });
  const side = await sideChannel(endpoint);
  const read = async (range, refresh = false) => {
    let r = await side.request("usage.overview", { range, refresh });
    for (let i = 0; r.reading && i < 100; i++) {
      await sleep(100);
      r = await side.request("usage.overview", { range });
    }
    return r;
  };
  const select = (label) => js(`[...document.querySelectorAll(".pb-usage button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  try {
    await side.request("bot.create", { name: "Example", welcome: false });
    await openWindow(endpoint);
    await until(`!!document.querySelector(".pb-foot-usage")`, 10_000);
    await js(`document.querySelector(".pb-foot-usage").click()`);
    const result = await read("30d");
    const c = result.overview?.providers.find((p) => p.id === "claude");
    const x = result.overview?.providers.find((p) => p.id === "codex");
    check("usage-page: the engine deduplicates Claude and subtracts Codex's cache hits from input", c?.totals.sessions === 1 && c.totals.tokens === 1_110_000 && x?.totals.tokens === 101_000 && x.totals.tokenType.input === 50_000);
    check("usage-page: API pricing is split correctly", Math.abs((c?.totals.usd ?? 0) - .8) < 1e-9 && Math.abs((x?.totals.usd ?? 0) - .006) < 1e-9);
    check("usage-page: only labels and figures cross the websocket", !/Fixture message|example-claude|example-codex|\.jsonl/.test(JSON.stringify(result)));
    check("usage-page: the browser renders the same estimated cost", !!await until(`document.querySelector("[data-usage-total]")?.textContent === "$0.81"`, 8000));
    await select("Tokens");
    await select("Past 24h");
    check("usage-page: past 24h shows an hourly trend and the same tokens", !!await until(`document.querySelector('.pb-usage-data[data-range="24h"] [data-usage-total]')?.textContent === "1.21M" && /Hourly processed tokens/.test(document.querySelector(".pb-usage-chart").textContent)`, 8000));
    await select("Day");
    check("usage-page: day breakdown shows the date's figures", !!await until(`document.querySelector('[aria-label="Usage by day"] .pb-usage-table-row')?.textContent.includes("1.21M")`, 8000));
    await sleep(2100); // Allow the worker's duplicate-refresh floor to pass.
    appendFileSync(cFile, JSON.stringify(usage(0, "b")) + "\n");
    await select("Refresh");
    check("usage-page: refresh includes a new request from an appended line", !!await until(`document.querySelector('[data-usage-total]')?.textContent === "2.22M" && !document.querySelector(".pb-usage-data[data-reading]")`, 8000));
    await shot("usage-page-tokens");
  } finally {
    side.close();
    await stopEngine();
  }
}
