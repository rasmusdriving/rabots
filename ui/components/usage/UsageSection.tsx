import { useEffect, useRef, useState } from "react";
import { emptyUsageFigures, USAGE_PROVIDERS, USAGE_PROVIDER_NAMES, USAGE_RANGES, USAGE_RANGE_NAMES, type HistoryProvider, type UsageOverview, type UsageRange } from "../../../shared/protocol";
import { readUsageOverview } from "../../state/actions";
import { messageOf } from "../../engine/types";
import { UsageLimits } from "./UsageLimits";
import { UsageSummary } from "./UsageSummary";
import type { Metric } from "./format";

const POLL_MS = 1000;
type View = Metric | "limits";

export function UsageSection() {
  const [view, setView] = useState<View>("cost");
  const [provider, setProvider] = useState<HistoryProvider | "all">("all");
  const [request, setRequest] = useState<{ range: UsageRange; refresh?: boolean }>({ range: "30d" });
  const [overview, setOverview] = useState<UsageOverview>();
  const [reading, setReading] = useState(true);
  const [problem, setProblem] = useState("");
  const [limitsReading, setLimitsReading] = useState(false);
  const [limitsRefresh, setLimitsRefresh] = useState(0);
  const [by, setBy] = useState<"model" | "day">("model");
  const limits = view === "limits";
  const refreshed = useRef<typeof request | undefined>(undefined);

  useEffect(() => {
    if (limits) return;
    let gone = false;
    let pending: ReturnType<typeof setTimeout>;
    const load = (fresh: boolean) => {
      readUsageOverview(request.range, fresh).then((result) => {
        if (gone) return;
        if (result.overview) setOverview(result.overview);
        setProblem(result.problem ?? "");
        setReading(result.reading);
        if (result.reading) pending = setTimeout(() => load(false), POLL_MS);
      }).catch((e: unknown) => {
        if (gone) return;
        setProblem(messageOf(e));
        setReading(false);
      });
    };
    setReading(true);
    setProblem("");
    const fresh = request.refresh === true && refreshed.current !== request;
    refreshed.current = request;
    load(fresh);
    return () => { gone = true; clearTimeout(pending); };
  }, [limits, request]);

  const refresh = () => {
    if (limits) {
      if (!limitsReading) setLimitsRefresh((n) => n + 1);
    } else if (!reading) {
      setReading(true);
      setRequest({ range: request.range, refresh: true });
    }
  };
  const visible = USAGE_PROVIDERS.filter((id) => provider === "all" || id === provider);
  const partial = overview?.incomplete.filter((id) => visible.includes(id)) ?? [];
  const providers = visible.map((id) => overview?.providers.find((p) => p.id === id) ?? { id, totals: emptyUsageFigures(), models: [], days: [], trend: [] });
  const loading = reading || Boolean(overview && overview.range !== request.range && !problem);

  return (
    <section className="pb-usage" aria-labelledby="usage-title">
      <header className="pb-usage-top">
        <div className="pb-usage-scope">
          <h2 className="heading" id="usage-title">Usage</h2>
          <span className="pb-usage-faint" aria-hidden="true">/</span><span className="small">{limits ? "Plan limits" : "This computer"}</span>
          <span className="pb-usage-faint" aria-hidden="true">/</span>
          <select className="pb-input pb-select pb-usage-filter" aria-label="Filter by provider" value={provider} onChange={(e) => setProvider(e.target.value as HistoryProvider | "all")}>
            <option value="all">All providers</option>
            {USAGE_PROVIDERS.map((id) => <option value={id} key={id}>{USAGE_PROVIDER_NAMES[id]}</option>)}
          </select>
        </div>
        <div className="pb-usage-toolbar">
          <div className="pb-usage-choices pb-usage-views" role="group" aria-label="Usage view">
            {(["cost", "tokens", "limits"] as const).map((item) => (
              <button type="button" aria-pressed={view === item} onClick={() => setView(item)} key={item}>{item === "cost" ? "Cost" : item === "tokens" ? "Tokens" : "Limits"}</button>
            ))}
          </div>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-usage-refresh"
            aria-disabled={(limits ? limitsReading : reading) || undefined} onClick={refresh} title="Refresh">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 0 0-14-5l-2 2m0-4v4h4m-4 5a8 8 0 0 0 14 5l2-2m0 4v-4h-4" />
            </svg>
            <span>Refresh</span>
          </button>
          {!limits && (
            <div className="pb-usage-choices pb-usage-ranges" role="group" aria-label="Usage range">
              {USAGE_RANGES.map((range) => (
                <button type="button" aria-pressed={request.range === range} onClick={() => {
                  if (request.range !== range) { setReading(true); setRequest({ range }); }
                }} key={range}>{USAGE_RANGE_NAMES[range]}</button>
              ))}
            </div>
          )}
        </div>
      </header>
      {limits ? <UsageLimits provider={provider} refreshSignal={limitsRefresh} onReading={setLimitsReading} /> : (
        <>
          <div className="pb-usage-status small" role="status">
            {problem || (loading ? (overview ? `Reading ${USAGE_RANGE_NAMES[request.range].toLowerCase()}. Showing the last reading.` : "Reading session history.") : overview && overview.range !== request.range
              ? `Showing ${USAGE_RANGE_NAMES[overview.range].toLowerCase()} from the last reading.`
              : partial.length ? `Some history could not be read for ${partial.map((id) => USAGE_PROVIDER_NAMES[id]).join(", ")}.`
              : "Counts all Claude Code and Codex sessions saved on this computer.")}
          </div>
          <UsageSummary overview={overview} providers={providers} metric={view} loading={loading} by={by} onBy={setBy} />
        </>
      )}
    </section>
  );
}
