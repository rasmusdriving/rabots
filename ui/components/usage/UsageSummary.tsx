import { addUsageFigures, COST_TYPES, emptyUsageFigures, TOKEN_TYPES, USAGE_PROVIDER_NAMES, USAGE_SPEEDS, type UsageHistoryProvider, type UsageOverview } from "../../../shared/protocol";
import { UsageChart } from "./UsageChart";
import { UsageBreakdown } from "./UsageBreakdown";
import { amount, formatAmount, money, quantity, sessionCount, share, tokens, type Metric } from "./format";

const TYPE_NAMES = { input: "Input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", other: "Other" };
const SPEED_NAMES = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" };

function ShareBar({ title, segments, format, premium }: {
  title: string; segments: { key: string; label: string; value: number }[]; format(value: number): string; premium?: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <section className="pb-usage-share">
      <div className="pb-usage-heading-row">
        <h3 className="body-strong">{title}</h3>
        {premium != null && premium > 0 && <span className="small pb-usage-faint">Premium <strong>{money(premium)}</strong></span>}
      </div>
      <div className="pb-usage-stacked" aria-hidden="true">
        {segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.key} data-segment={s.key} style={{ flexBasis: `${100 * s.value / total}%` }} />
        ))}
      </div>
      <ul className="pb-usage-legend small">
        {segments.map((s) => <li key={s.key} data-segment={s.key}><span className="pb-usage-swatch" aria-hidden="true" />{s.label} <strong>{format(s.value)}</strong></li>)}
      </ul>
    </section>
  );
}

export function UsageSummary({ overview, providers, metric, loading, by, onBy }: {
  overview?: UsageOverview; providers: UsageHistoryProvider[]; metric: Metric; loading: boolean;
  by: "model" | "day"; onBy(value: "model" | "day"): void;
}) {
  const cost = metric === "cost";
  const ranked = [...providers].sort((a, b) => amount(b.totals, metric) - amount(a.totals, metric));
  const all = providers.reduce((sum, provider) => addUsageFigures(sum, provider.totals), emptyUsageFigures());
  const show = (value: string) => overview ? value : "—";
  const sum = amount(all, metric);
  const metrics = [
    ["Processed tokens", tokens(all.tokens)],
    ["Cached input", tokens(all.tokenType.cacheRead)],
    ["Uncached input", tokens(all.tokenType.input)],
    ["Output", tokens(all.tokenType.output)],
    ["Cache savings", money(all.cacheSavings)],
  ];
  const types = cost ? COST_TYPES.map((key) => ({ key, label: TYPE_NAMES[key], value: all.costType[key] }))
    : TOKEN_TYPES.map((key) => ({ key, label: TYPE_NAMES[key], value: all.tokenType[key] }));

  return (
    <div className="pb-usage-data" data-range={overview?.range} data-reading={loading || undefined} aria-busy={loading}>
      <section className="pb-usage-overview" aria-label={cost ? "Estimated cost" : "Processed tokens"}>
        <div className="pb-usage-summary">
          <div className="display pb-usage-total" data-usage-total title={overview && !cost ? quantity(all.tokens) : undefined}>{show(formatAmount(metric)(sum))}</div>
          <div className="pb-usage-caption small">
            <span>{overview ? sessionCount(all.sessions) : "Sessions"}</span>
            {cost && <> · <span title="Estimated at API prices. This is separate from your subscription bill.">API estimate</span><br />Your subscription bill is separate.</>}
          </div>
          {ranked.map((p) => {
            const value = amount(p.totals, metric);
            return (
              <div className="pb-usage-provider" data-provider={p.id} key={p.id}>
                <div className="pb-usage-provider-line body-strong">
                  <span><span className="pb-usage-dot" aria-hidden="true" />{USAGE_PROVIDER_NAMES[p.id]}</span>
                  <strong>{show(formatAmount(metric)(value))}</strong>
                </div>
                <div className="pb-usage-provider-details small">
                  {overview ? <>{sessionCount(p.totals.sessions)} · {share(value, sum)} of {metric}<br />{cost ? `${tokens(p.totals.tokens)} tokens` : `${money(p.totals.usd)} estimated cost`}</> : "Waiting for history"}
                </div>
              </div>
            );
          })}
        </div>
        <UsageChart overview={overview} providers={ranked} metric={metric} />
      </section>
      {overview && all.unpricedTokens > 0 && <p className="small pb-usage-faint">{tokens(all.unpricedTokens)} tokens have no known API price.</p>}
      {overview && all.sessions === 0 && <p className="small pb-usage-faint">No saved sessions in this range.</p>}
      <section className="pb-usage-totals" aria-labelledby="usage-totals-title">
        <h3 className="body-strong" id="usage-totals-title">Totals</h3>
        <dl>{metrics.map(([label, value]) => <div key={label}><dt className="small">{label}</dt><dd className="heading">{show(value!)}</dd></div>)}</dl>
      </section>
      {overview && (
        <>
          <div className="pb-usage-bands">
            <ShareBar title={cost ? "Cost by type" : "Tokens by type"} segments={types} format={formatAmount(metric)} />
            {cost && <ShareBar title="Cost by speed" segments={USAGE_SPEEDS.map((key) => ({ key, label: SPEED_NAMES[key], value: all.speedCost[key] }))} format={money} premium={all.premium} />}
          </div>
          <UsageBreakdown providers={providers} total={all} metric={metric} by={by} onBy={onBy} />
        </>
      )}
    </div>
  );
}
