import { emptyUsageFigures, USAGE_PROVIDERS, type Methods, type UsageFigures } from "../../shared/protocol";

declare global {
  interface Window { pobotsUsage?: { waitMs: number }; }
}

const DAY = 86_400_000;

function figures(tokens: number, usd: number, sessions: number): UsageFigures {
  const f = emptyUsageFigures();
  Object.assign(f, { tokens, usd, sessions, cacheSavings: usd * 1.3, premium: usd * .1 });
  f.tokenType = { input: tokens / 10, cacheRead: tokens * .75, cacheWrite: tokens / 10, output: tokens * .05 };
  f.costType = { input: usd * .2, cacheRead: usd * .4, cacheWrite: usd * .2, output: usd * .2, other: 0 };
  f.speedCost = { standard: usd * .8, fast: usd * .15, ultrafast: usd * .05 };
  return f;
}

export function mockUsageOverview({ range }: Methods["usage.overview"]["params"]): Methods["usage.overview"]["result"] {
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[range];
  const now = Date.now();
  const hours = range === "24h";
  const points = Array.from({ length: hours ? 25 : days }, (_, i) => {
    const at = new Date(now - (hours ? (24 - i) * DAY / 24 : (days - 1 - i) * DAY)).toISOString();
    return hours ? at : at.slice(0, 10);
  });
  return {
    reading: false,
    overview: {
      range, points, checkedAt: new Date(now).toISOString(), timeZone: "UTC", incomplete: [],
      providers: USAGE_PROVIDERS.map((id, i) => {
        const tokens = (i ? 200_000 : 1_000_000) * days;
        const usd = (i ? 1.25 : 3.5) * days;
        const totals = figures(tokens, usd, days);
        return {
          id, totals,
          models: [{ model: i ? "gpt-6-luna" : "claude-opus-5-5", totals }],
          days: Array.from({ length: days }, (_, i) => ({
            day: new Date(now - i * DAY).toISOString().slice(0, 10),
            totals: figures(tokens / days, usd / days, 1),
          })),
          trend: points.map((_, n) => ({ usd: (1 + Math.sin(n + i)) * usd / points.length, tokens: (1 + Math.sin(n + i)) * tokens / points.length })),
        };
      }),
    },
  };
}
