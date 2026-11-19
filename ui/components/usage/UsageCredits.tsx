import type { UsageAccount } from "../../../shared/protocol";
import { usageCreditRows } from "../../../shared/usage-credits";
import { resetWords } from "../SettingsWindow";

export function accountInitials(email: string | undefined, fallback: string): string {
  if (!email) return fallback.slice(0, 2).toUpperCase();
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

export function UsageCredits({ accounts, now }: { accounts: UsageAccount[]; now: number }) {
  return (
    <>
      {accounts.flatMap((account) => usageCreditRows(account).map((row) => (
        <div className="pb-set7-meter pb-usage-credit" data-credit={row.id} key={`${account.via}:${account.id}:${row.id}`}>
          <div className="pb-set7-meter-head">
            <span className="body-strong">{row.label}</span>
            <span className="pb-set7-meter-pct title">{row.value}</span>
          </div>
          <div className="pb-usage-credit-meta label">
            {accounts.length > 1 && (
              <span className="pb-usage-credit-account">
                <span className="pb-set7-chip">{accountInitials(account.email, account.via)}</span>
                <span>{account.via}</span>
              </span>
            )}
            {row.expiresAt && <time dateTime={row.expiresAt}>{resetWords(row.expiresAt, now).replace(/^resets/, row.id === "reset" ? "next expires" : "expires")}</time>}
            {row.resetsAt && <time dateTime={row.resetsAt}>{resetWords(row.resetsAt, now)}</time>}
          </div>
        </div>
      )))}
    </>
  );
}
