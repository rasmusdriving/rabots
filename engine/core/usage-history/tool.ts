import { addUsageFigures, emptyUsageFigures, USAGE_PROVIDER_NAMES, USAGE_RANGE_NAMES, type HistoryProvider, type UsageFigures, type UsageRange } from "../../../shared/protocol.js";
import type { Engine } from "../../engine.js";
import { readUsageOverview } from "./service.js";

export interface UsageToolArgs {
  fresh?: boolean;
  usage_range?: UsageRange;
  usage_provider?: HistoryProvider;
  usage_breakdown?: "model" | "day";
}

const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en");
const line = (r: UsageFigures) => `${usd.format(r.usd)}, ${number.format(r.tokens)} tokens, ${number.format(r.sessions)} sessions`;

export function usageHistoryWords(eng: Engine, args: UsageToolArgs & { usage_range: UsageRange }): string {
  const { overview, reading, problem } = readUsageOverview(eng, { range: args.usage_range, refresh: args.fresh });
  const head = `Usage, ${USAGE_RANGE_NAMES[args.usage_range]}. API estimate, separate from the subscription bill. Counts Claude Code and Codex sessions saved on this computer.`;
  if (!overview) return `${head}\n${problem ?? "Reading history. Ask again in a moment, without fresh."}`;

  const providers = overview.providers.filter((p) => !args.usage_provider || p.id === args.usage_provider);
  const total = providers.reduce((sum, p) => addUsageFigures(sum, p.totals), emptyUsageFigures());
  const { tokenType: t, costType: c, speedCost: s } = total;
  const lines = [
    head, line(total), ...providers.map((p) => `${USAGE_PROVIDER_NAMES[p.id]}: ${line(p.totals)}`),
    `Tokens: input ${number.format(t.input)}, cache read ${number.format(t.cacheRead)}, cache write ${number.format(t.cacheWrite)}, output ${number.format(t.output)}.`,
    `Cost: input ${usd.format(c.input)}, cache read ${usd.format(c.cacheRead)}, cache write ${usd.format(c.cacheWrite)}, output ${usd.format(c.output)}, other ${usd.format(c.other)}. Cache savings ${usd.format(total.cacheSavings)}.`,
    `By speed: standard ${usd.format(s.standard)}, fast ${usd.format(s.fast)}, ultrafast ${usd.format(s.ultrafast)}. Speed premium ${usd.format(total.premium)}.`,
  ];
  if (total.unpricedTokens) lines.push(`Prices are missing for ${number.format(total.unpricedTokens)} tokens.`);
  const incomplete = overview.incomplete.filter((p) => !args.usage_provider || args.usage_provider === p);
  if (incomplete.length) lines.push(`Some history could not be read for ${incomplete.map((p) => USAGE_PROVIDER_NAMES[p]).join(", ")}.`);
  if (reading) lines.push("The last reading is shown while history is updated.");
  if (problem) lines.push(problem);
  if (args.usage_breakdown) {
    const rows = new Map<string, UsageFigures>();
    for (const provider of providers) {
      if (args.usage_breakdown === "model") {
        for (const row of provider.models) rows.set(`${USAGE_PROVIDER_NAMES[provider.id]} · ${row.model}`, row.totals);
      } else {
        for (const row of provider.days) rows.set(row.day, addUsageFigures(rows.get(row.day) ?? emptyUsageFigures(), row.totals));
      }
    }
    const order = [...rows].sort(([a, x], [b, y]) => args.usage_breakdown === "model" ? y.usd - x.usd || y.tokens - x.tokens : b.localeCompare(a));
    lines.push(...order.map(([name, total]) => `- ${name}: ${line(total)}`));
  }
  return lines.join("\n");
}
