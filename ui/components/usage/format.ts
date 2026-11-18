import type { UsageFigures } from "../../../shared/protocol";

export type Metric = "cost" | "tokens";
export const money = (n: number) => usd.format(n);
export const tokens = (n: number) => compact.format(n);
export const quantity = (n: number) => integer.format(n);
export const amount = (f: UsageFigures, metric: Metric) => metric === "cost" ? f.usd : f.tokens;
export const formatAmount = (metric: Metric) => metric === "cost" ? money : tokens;
export const share = (n: number, total: number) => n > 0 && n / total < .001 ? "<0.1%" : percent.format(total > 0 ? n / total : 0);
export const sessionCount = (n: number) => `${quantity(n)} ${n === 1 ? "session" : "sessions"}`;
export const dayLabel = (iso: string) => day.format(new Date(iso));

const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumSignificantDigits: 3 });
const integer = new Intl.NumberFormat("en");
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
