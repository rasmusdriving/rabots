// Settings > Usage history: aggregate figures only, independent of plan limit readings.
export const USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const USAGE_PROVIDERS = ["claude", "codex"] as const;
export type HistoryProvider = (typeof USAGE_PROVIDERS)[number];
export const USAGE_PROVIDER_NAMES = { claude: "Claude Code", codex: "Codex" } as const;
export const USAGE_RANGE_NAMES = { "24h": "Past 24h", "7d": "7 days", "30d": "30 days", "90d": "90 days" } as const;
export const TOKEN_TYPES = ["input", "cacheRead", "cacheWrite", "output"] as const;
export const COST_TYPES = [...TOKEN_TYPES, "other"] as const;
export const USAGE_SPEEDS = ["standard", "fast", "ultrafast"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type UsageSpeed = (typeof USAGE_SPEEDS)[number];

export interface UsageFigures {
  sessions: number;
  tokens: number;
  usd: number;
  tokenType: Record<TokenType, number>;
  costType: Record<(typeof COST_TYPES)[number], number>;
  speedCost: Record<UsageSpeed, number>;
  cacheSavings: number;
  premium: number;
  unpricedTokens: number;
}

export interface UsageHistoryProvider {
  id: HistoryProvider;
  totals: UsageFigures;
  models: { model: string; totals: UsageFigures }[];
  /** Local calendar days, even for the 24h range. */
  days: { day: string; totals: UsageFigures }[];
  /** In the same order as UsageOverview.points. */
  trend: { usd: number; tokens: number }[];
}

export interface UsageOverview {
  range: UsageRange;
  checkedAt: string;
  timeZone: string;
  /** Local dates for daily points, ISO instants for hourly points. */
  points: string[];
  providers: UsageHistoryProvider[];
  /** Providers whose history could not be fully read. */
  incomplete: HistoryProvider[];
}

export interface UsageOverviewRead {
  overview?: UsageOverview;
  reading: boolean;
  problem?: string;
}

export function emptyUsageFigures(): UsageFigures {
  return {
    sessions: 0, tokens: 0, usd: 0, cacheSavings: 0, premium: 0, unpricedTokens: 0,
    tokenType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    costType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
    speedCost: { standard: 0, fast: 0, ultrafast: 0 },
  };
}

export function addUsageFigures(to: UsageFigures, from: UsageFigures): UsageFigures {
  for (const key of ["sessions", "tokens", "usd", "cacheSavings", "premium", "unpricedTokens"] as const) to[key] += from[key];
  for (const key of TOKEN_TYPES) to.tokenType[key] += from.tokenType[key];
  for (const key of COST_TYPES) to.costType[key] += from.costType[key];
  for (const key of USAGE_SPEEDS) to.speedCost[key] += from.speedCost[key];
  return to;
}
