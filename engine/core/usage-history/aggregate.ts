import { addUsageFigures, emptyUsageFigures, USAGE_PROVIDERS, type HistoryProvider, type UsageFigures, type UsageOverview, type UsageRange } from "../../../shared/protocol.js";
import { priceUsage } from "./pricing.js";
import { DAY, type Index } from "./scan.js";
import type { UsageRecord } from "./types.js";

const HOUR = DAY / 24;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Bucket {
  totals: UsageFigures;
  sessions: Set<string>;
}

function put(buckets: Map<string, Bucket>, key: string, record: UsageRecord, figures: UsageFigures) {
  let bucket = buckets.get(key);
  if (!bucket) buckets.set(key, bucket = { totals: emptyUsageFigures(), sessions: new Set() });
  addUsageFigures(bucket.totals, figures);
  if (!bucket.sessions.has(record.session)) {
    bucket.sessions.add(record.session);
    bucket.totals.sessions++;
  }
}

function distinct(index: Index, from: number, now: number) {
  const records = new Map<HistoryProvider, UsageRecord[]>(USAGE_PROVIDERS.map((id) => [id, []]));
  const keys = new Map<string, UsageRecord>();
  for (const entry of Object.values(index.files)) for (const r of entry.tail ? [...entry.records, ...entry.tail] : entry.records) {
    if (r.at < from || r.at > now) continue;
    const id = r.key && `${entry.provider}:${r.key}`;
    const prior = id && keys.get(id);
    if (!prior) {
      const copy = { ...r };
      if (id) keys.set(id, copy);
      records.get(entry.provider)?.push(copy);
    } else {
      if (r.at < prior.at || (r.at === prior.at && r.session < prior.session)) {
        prior.at = r.at;
        prior.session = r.session;
      }
      for (const k of ["input", "cacheRead", "cacheWrite", "cacheWriteHour", "output"] as const) prior[k] = Math.max(prior[k], r[k]);
      if (r.reported !== undefined) prior.reported = Math.max(prior.reported ?? 0, r.reported);
    }
  }
  return records;
}

export function aggregate(index: Index, now: number, timeZone: string, checkedAt: string): Record<UsageRange, UsageOverview> {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = Date.parse(day.format(now));
  const hour = Math.floor(now / HOUR) * HOUR;
  const ranges = {
    "24h": Array.from({ length: 25 }, (_, i) => new Date(hour - (24 - i) * HOUR).toISOString()),
    "7d": Array.from({ length: 7 }, (_, i) => isoDay(today - (6 - i) * DAY)),
    "30d": Array.from({ length: 30 }, (_, i) => isoDay(today - (29 - i) * DAY)),
    "90d": Array.from({ length: 90 }, (_, i) => isoDay(today - (89 - i) * DAY)),
  };
  const allRecords = distinct(index, now - 92 * DAY, now);
  const create = (range: UsageRange): UsageOverview => ({ range, timeZone, checkedAt, points: ranges[range], providers: [], incomplete: index.incomplete });
  const result = { "24h": create("24h"), "7d": create("7d"), "30d": create("30d"), "90d": create("90d") };

  for (const [id, records] of allRecords) {
    const priced = records.map((r) => ({
      r, date: day.format(r.at), time: new Date(Math.floor(r.at / HOUR) * HOUR).toISOString(), figures: priceUsage(r),
    }));
    for (const overview of Object.values(result)) {
      const hourly = overview.range === "24h";
      const first = overview.points[0]!;
      const models = new Map<string, Bucket>();
      const days = new Map<string, Bucket>();
      const totals = new Map<string, Bucket>();
      const trend = new Map<string, { usd: number; tokens: number }>();
      for (const { r, date, time, figures } of priced) {
        if (hourly ? r.at < now - DAY : date < first) continue;
        put(totals, "all", r, figures);
        put(models, r.model, r, figures);
        put(days, date, r, figures);
        const point = hourly ? time : date;
        const sum = trend.get(point) ?? { usd: 0, tokens: 0 };
        sum.usd += figures.usd;
        sum.tokens += figures.tokens;
        trend.set(point, sum);
      }
      overview.providers.push({
        id, totals: totals.get("all")?.totals ?? emptyUsageFigures(),
        models: [...models].map(([model, b]) => ({ model, totals: b.totals })),
        days: [...days].map(([day, b]) => ({ day, totals: b.totals })),
        trend: overview.points.map((point) => trend.get(point) ?? { usd: 0, tokens: 0 }),
      });
    }
  }
  return result;
}
