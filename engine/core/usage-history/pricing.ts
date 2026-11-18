import { emptyUsageFigures, type UsageFigures, type UsageSpeed } from "../../../shared/protocol.js";
import { MODEL_RATES, type Rates } from "./rate-table.js";
import type { UsageRecord } from "./types.js";

function ratesFor(model: string, prompt: number, speed: UsageSpeed): Rates | undefined {
  const key = model.toLowerCase().replace(/\[.*$/, "").replace(/^(openai|anthropic)\//, "");
  const rates = Object.hasOwn(MODEL_RATES, key) ? MODEL_RATES[key] : undefined;
  if (!rates) return undefined;
  const [base, ...tiers] = rates;
  const tier = tiers.find(([threshold]) => prompt > threshold)?.[1];
  const i = speed === "fast" ? 1 : speed === "ultrafast" ? 2 : 0;
  return tier?.[i] ?? base[i] ?? tier?.[0] ?? base[0];
}

export function priceUsage(record: UsageRecord): UsageFigures {
  const { input, cacheRead, cacheWrite, cacheWriteHour, output, speed, reported } = record;
  const result = emptyUsageFigures();
  const prompt = input + cacheRead + cacheWrite;
  result.tokens = prompt + output;
  result.tokenType = { input, cacheRead, cacheWrite, output };
  const rates = ratesFor(record.model, prompt, speed);
  if (!rates) {
    if (reported === undefined) result.unpricedTokens = result.tokens;
    else result.usd = result.costType.other = result.speedCost[speed] = reported;
    return result;
  }
  const cost = ([inRate, readRate, writeRate, hourRate, outRate]: Rates) => ({
    input: input * inRate / 1e6, cacheRead: cacheRead * readRate / 1e6,
    cacheWrite: ((cacheWrite - cacheWriteHour) * writeRate + cacheWriteHour * hourRate) / 1e6,
    output: output * outRate / 1e6, other: 0,
  });
  const total = (parts: ReturnType<typeof cost>) => parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
  const parts = cost(rates);
  result.costType = parts;
  result.usd = result.speedCost[speed] = total(parts);
  result.cacheSavings = cacheRead * (rates[0] - rates[1]) / 1e6;
  const standard = ratesFor(record.model, prompt, "standard");
  if (speed !== "standard" && standard) result.premium = Math.max(0, result.usd - total(cost(standard)));
  return result;
}
