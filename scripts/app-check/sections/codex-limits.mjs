// Real signed-in Codex app-server through the engine, websocket and browser, without a model turn.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, js, openWindow, sideChannel, startEngine, stopEngine, until, work } from "../lib.mjs";

export default async function section() {
  await stopEngine();
  const dataDir = join(work, "codex-limits-data");
  const botsDir = join(work, "codex-limits-bots");
  for (const dir of [dataDir, botsDir]) mkdirSync(dir);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ providers: { claude: { enabled: false } } }));
  const endpoint = await startEngine({ dataDir, botsDir });
  const side = await sideChannel(endpoint);
  try {
    // Make the first use of the engine a limits request, with no readiness polling.
    const { usage: first } = await side.request("usage.read", {});
    check("codex-limits: the first read after startup includes local Codex", first.providers.some((p) =>
      p.id === "codex" && p.accounts.some((a) => a.via === "This Mac" && a.windows.length > 0 && !a.problem)));
    const snap = await side.request("snapshot");
    const model = snap.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap.models.find((m) => m.harness === "codex");
    check("codex-limits: the real Codex is ready", snap.status?.codex?.ready === true && !!model);
    if (!model || !snap.status?.codex?.ready) return;
    await side.request("bot.create", { name: "Example", model: model.id, effort: "low", welcome: false });
    await openWindow(endpoint);
    await until('!!document.querySelector(".pb-foot-usage")', 10000);
    await js('document.querySelector(".pb-foot-usage").click()');
    await until('!!document.querySelector(".pb-usage-views")', 8000);
    await js('[...document.querySelectorAll(".pb-usage-views button")].find((b) => b.textContent === "Limits").click()');
    const codex = first.providers.find((p) => p.id === "codex")?.accounts[0];
    check("codex-limits: the websocket reports local Codex limits", codex?.via === "This Mac" && codex.windows.length > 0 && !codex.problem);
    const group = 'document.querySelector(".pb-set7-meter-group[data-provider=codex]")';
    check("codex-limits: the window renders all of the local Codex limits", !!codex?.windows.length &&
      !!await until(`${group}?.querySelectorAll("[data-window]").length === ${codex.windows.length} &&
        ${group}.querySelector(".pb-usage-origin")?.textContent === "This Mac"`, 12000));
    const shown = await js(`(() => {
      const g = ${group};
      const value = (id) => g?.querySelector('[data-credit="' + id + '"] .pb-set7-meter-pct')?.textContent ?? null;
      return { balance: value("balance"), reset: value("reset"), expiry: g?.querySelector("[data-credit=reset] time")?.dateTime ?? null };
    })()`);
    const c = codex?.credits;
    const balance = !c ? null : c.unlimited ? "Unlimited" : c.balance !== undefined
      ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(c.balance)
      : c.hasCredits === false ? "None available" : "Balance not reported";
    check("codex-limits: the visible balance agrees with the real account reading", !!shown && shown.balance === balance);
    check("codex-limits: the reset count and expiry agree with the real account reading", !!shown &&
      shown.reset === (codex?.resetCredits ? String(codex.resetCredits.availableCount) : null) &&
      shown.expiry === (codex?.resetCredits?.nextExpiresAt ?? null));
  } finally {
    side.close();
    await stopEngine();
  }
}
