import type { UsageHistoryProvider, UsageOverview } from "../../../shared/protocol";
import { dayLabel, formatAmount, type Metric } from "./format";

const W = 600;
const H = 176;
const y = (value: number, maximum: number) => H * (1 - value / maximum);
const x = (index: number, count: number) => W * index / Math.max(1, count - 1);

function ceiling(peak: number): number {
  if (peak <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(peak));
  return ([1, 2, 5, 10].find((v) => v * scale >= peak) ?? 10) * scale;
}

export function UsageChart({ overview, providers, metric }: { overview?: UsageOverview; providers: UsageHistoryProvider[]; metric: Metric }) {
  const field = metric === "cost" ? "usd" : "tokens";
  const counts = providers.map((p) => ({ id: p.id, values: p.trend.map((d) => d[field]) }));
  const maximum = ceiling(Math.max(0, ...counts.flatMap((p) => p.values)));
  const hourly = overview?.range === "24h";
  const title = `${hourly ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "processed tokens"}`;
  const points = overview?.points ?? [];
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: overview?.timeZone, hour: "2-digit", minute: "2-digit" });
  const label = (s: string) => hourly ? clock.format(new Date(s)) : dayLabel(s);

  return (
    <div className="pb-usage-chart">
      <h3 className="body-strong">{title}</h3>
      <div className="pb-usage-plot" role="img" aria-label={`${title} by provider. See the breakdown by day for the numbers.`}>
        <div className="pb-usage-axis label" aria-hidden="true">
          {[maximum, maximum / 2, 0].map((n) => <span key={n}>{n ? formatAmount(metric)(n) : "0"}</span>)}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0, H / 2, H].map((n) => <line className="pb-usage-grid" key={n} x1="0" x2={W} y1={n} y2={n} vectorEffect="non-scaling-stroke" />)}
          {counts.map(({ id, values }) => {
            if (!values.some(Boolean)) return null;
            const line = values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i, values.length)},${y(value, maximum)}`).join(" ");
            return (
              <g data-provider={id} key={id}>
                <path className="pb-usage-area" d={`${line} L${W},${H} L0,${H} Z`} />
                <path className="pb-usage-line" d={line} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        <div className="pb-usage-dates label" aria-hidden="true">
          {points.length > 0 && [points[0]!, points[Math.floor(points.length / 2)]!, points.at(-1)!].map((s, i) => <span key={i}>{label(s)}</span>)}
        </div>
      </div>
    </div>
  );
}
