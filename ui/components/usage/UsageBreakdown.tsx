import { addUsageFigures, emptyUsageFigures, USAGE_PROVIDER_NAMES, type HistoryProvider, type UsageFigures, type UsageHistoryProvider } from "../../../shared/protocol";
import { amount, dayLabel, money, quantity, share, tokens, type Metric } from "./format";

interface Row {
  key: string;
  label: string;
  id?: HistoryProvider;
  figures: UsageFigures;
}

function rowsOf(providers: UsageHistoryProvider[], by: "model" | "day", metric: Metric): Row[] {
  if (by === "model") return providers.flatMap((provider) => provider.models.map((m) => ({
    id: provider.id, key: `${provider.id}/${m.model}`, label: m.model, figures: m.totals,
  }))).sort((a, b) => amount(b.figures, metric) - amount(a.figures, metric) || a.label.localeCompare(b.label));
  const days = new Map<string, UsageFigures>();
  for (const provider of providers) for (const { day, totals } of provider.days) {
    days.set(day, addUsageFigures(days.get(day) ?? emptyUsageFigures(), totals));
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, figures]) => ({ key: day, label: dayLabel(day), figures }));
}

export function UsageBreakdown({ providers, total, metric, by, onBy }: {
  providers: UsageHistoryProvider[]; total: UsageFigures; metric: Metric; by: "model" | "day"; onBy(value: "model" | "day"): void;
}) {
  const rows = rowsOf(providers, by, metric);
  const maximum = Math.max(0, ...rows.map((r) => amount(r.figures, metric)));
  return (
    <section className="pb-usage-breakdown" aria-labelledby="usage-breakdown-title">
      <div className="pb-usage-heading-row">
        <h3 className="body-strong" id="usage-breakdown-title">Breakdown</h3>
        <div className="pb-usage-choices" role="group" aria-label="Group breakdown by">
          <button type="button" aria-pressed={by === "model"} onClick={() => onBy("model")}>Model</button>
          <button type="button" aria-pressed={by === "day"} onClick={() => onBy("day")}>Day</button>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="pb-usage-table" role="table" aria-label={by === "model" ? "Usage by model" : "Usage by day"}>
          <div className="pb-usage-table-head label" role="row">
            <span role="columnheader">{by === "model" ? "Model" : "Day"}</span>
            <span role="columnheader">Cost</span><span role="columnheader">Share</span><span role="columnheader">Tokens</span>
          </div>
          {rows.map(({ id, key, label, figures }) => (
            <div className="pb-usage-table-row" role="row" key={key} data-provider={id}>
              <span className="pb-usage-table-name" role="rowheader">
                <span className="pb-usage-table-model">
                  {id && <span className="pb-usage-dot" role="img" aria-label={USAGE_PROVIDER_NAMES[id]} />}
                  <span>{label}{figures.unpricedTokens > 0 && <small className="label pb-usage-faint"> {figures.unpricedTokens === figures.tokens ? "Unpriced" : "Partly priced"}</small>}</span>
                </span>
                <span className="pb-usage-row-line" aria-hidden="true" style={{ width: `${maximum ? amount(figures, metric) / maximum * 100 : 0}%` }} />
              </span>
              <span role="cell"><span className="pb-usage-cell-label">Cost </span>{figures.unpricedTokens > 0 && figures.unpricedTokens === figures.tokens ? "Unpriced" : money(figures.usd)}</span>
              <span role="cell"><span className="pb-usage-cell-label">Share </span>{share(amount(figures, metric), amount(total, metric))}</span>
              <span role="cell" title={quantity(figures.tokens)}><span className="pb-usage-cell-label">Tokens </span>{tokens(figures.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
