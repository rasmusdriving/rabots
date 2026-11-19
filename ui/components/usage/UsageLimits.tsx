// The existing provider/hub reading, grouped into one card per plan limit.
import { useEffect, useRef, useState } from "react";
import type { HistoryProvider, UsageAccount, UsageProvider, UsageWindow } from "../../../shared/protocol";
import { useAppState } from "../../state/store";
import { readUsage } from "../../state/actions";
import { useNow } from "../../lib/hooks";
import { messageOf } from "../../engine/types";
import { checkedWords, ProblemLine, resetWords } from "../SettingsWindow";
import { accountInitials, UsageCredits } from "./UsageCredits";

/** What is left of one window: 100 minus what is used, rounded. */
const remaining = (w: UsageWindow) => Math.max(0, 100 - w.usedPercent);
const left = (w: UsageWindow) => Math.round(remaining(w));

/** The windows of a provider in order, each with every account that reports it (pooled as in T3 Code). */
function poolWindows(p: UsageProvider): { id: string; label: string; members: { account: UsageAccount; window: UsageWindow }[] }[] {
  const out: { id: string; label: string; members: { account: UsageAccount; window: UsageWindow }[] }[] = [];
  for (const a of p.accounts) {
    for (const w of a.windows) {
      let row = out.find((r) => r.id === w.id);
      if (!row) out.push((row = { id: w.id, label: w.label, members: [] }));
      row.members.push({ account: a, window: w });
    }
  }
  return out;
}

function sourceWords(providers: UsageProvider[]): string {
  const sources = new Set(providers.flatMap((p) => p.accounts.map((a) => a.via)));
  const local = sources.delete("This Mac");
  if (local && sources.size) return "From usage hubs and this Mac.";
  if (sources.size) return `From ${[...sources].join(" and ")}.`;
  if (local) {
    const names = providers.map((p) => p.id === "claude" ? "Claude Code" : p.label);
    return `From ${names.join(" and ")} on this Mac.`;
  }
  return "";
}

export function UsageLimits({ provider, refreshSignal, onReading }: { provider: HistoryProvider | "all"; refreshSignal: number; onReading(reading: boolean): void }) {
  const usage = useAppState((s) => s.usage);
  const now = useNow(30_000);
  const [error, setError] = useState("");
  const lastRefresh = useRef(refreshSignal);
  useEffect(() => {
    const refresh = lastRefresh.current !== refreshSignal;
    lastRefresh.current = refreshSignal;
    let gone = false;
    setError("");
    readUsage(refresh).catch((e: unknown) => { if (!gone) setError(messageOf(e)); });
    return () => { gone = true; };
  }, [refreshSignal]);
  const reading = !error && (!usage || usage.reading);
  useEffect(() => onReading(reading), [onReading, reading]);
  const providers = (usage?.providers ?? []).filter((p) => provider === "all" || p.id === provider);
  const source = sourceWords(providers);
  return (
    <section className="pb-section pb-set7-usage" aria-label="Plan limits" data-reading={reading || undefined}>
      <p className="pb-set7-checked-text pb-usage-status small" role="status">
        {[source, reading ? "Reading plan limits." : checkedWords(usage?.checkedAt, now)].filter(Boolean).join(" ")}
      </p>
      <ProblemLine text={error || usage?.problem || ""} />
      <div className="pb-set7-meters">
        {providers.map((p) => (
          <ProviderMeters key={p.id} p={p} now={now} />
        ))}
      </div>
      {!reading && !providers.length && !error && !usage?.problem && <p className="small pb-usage-faint">No plan limits were reported.</p>}
    </section>
  );
}

function ProviderMeters({ p, now }: { p: UsageProvider; now: number }) {
  const rows = poolWindows(p);
  const several = p.accounts.length > 1;
  return (
    <div className="pb-set7-meter-group" data-provider={p.id}>
      <div className="pb-usage-group-head">
        <h3 className="pb-set7-meter-title heading">{p.label}</h3>
        {p.accounts.length === 1 && p.accounts[0]?.via === "This Mac" && <span className="pb-usage-origin label">This Mac</span>}
      </div>
      {p.accounts
        .filter((a) => a.problem)
        .map((a) => (
          <p key={a.id} className="pb-hint pb-set7-meter-problem">
            {several && a.email ? `${accountInitials(a.email, a.via)}: ${a.problem}` : a.problem}
          </p>
        ))}
      {rows.map((r) => {
        const pooled = Math.round(r.members.reduce((n, m) => n + remaining(m.window), 0) / r.members.length);
        return (
          <div className="pb-set7-meter" key={r.id} data-window={r.id}>
            <div className="pb-set7-meter-head">
              <span className="pb-set7-meter-label body-strong">{r.label}</span>
              <span className="pb-set7-meter-left label">
                <span className="pb-set7-meter-pct title">{`${pooled}%`}</span> left
              </span>
            </div>
            <div className="pb-set7-bars" data-several={several || undefined}>
              {r.members.map(({ account, window }) => (
                <Bar key={account.id} account={account} window={window} now={now} several={several} />
              ))}
            </div>
          </div>
        );
      })}
      {p.id === "codex" && <UsageCredits accounts={p.accounts} now={now} />}
    </div>
  );
}

function Bar({ account, window, now, several }: { account: UsageAccount; window: UsageWindow; now: number; several: boolean }) {
  const l = left(window);
  const reset = resetWords(window.resetsAt, now);
  const who = account.email ?? account.via;
  const label = `${several ? `${who}: ` : ""}${l}% left${reset ? `, ${reset}` : ""}`;
  return (
    <div className="pb-set7-bar label" title={[who, account.plan, reset].filter(Boolean).join(" · ")} aria-label={label} role="img" data-low={l <= 15 || undefined}>
      {several && <span className="pb-set7-chip">{accountInitials(account.email, account.via)}</span>}
      <span className="pb-set7-bar-track">
        <span className="pb-set7-bar-fill" style={{ width: `${l}%` }} />
      </span>
      <span className="pb-set7-bar-pct">{`${l}%`}</span>
      <span className="pb-set7-bar-reset">{reset}</span>
    </div>
  );
}
