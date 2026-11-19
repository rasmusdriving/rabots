import type { UsageAccount } from "./protocol.js";

interface CreditRow {
  id: "balance" | "reset";
  label: string;
  value: string;
  expiresAt?: string;
  resetsAt?: string;
}

const balanceWords = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Keep the window and the main bot's reading in the same words and units. */
export function usageCreditRows({ credits, resetCredits }: UsageAccount): CreditRow[] {
  const rows: CreditRow[] = [];
  if (credits) {
    const value = credits.unlimited ? "Unlimited"
      : credits.balance !== undefined ? balanceWords.format(credits.balance)
        : credits.hasCredits === false ? "None available" : "Balance not reported";
    rows.push({ id: "balance", label: "Credits left", value, expiresAt: credits.expiresAt, resetsAt: credits.resetsAt });
  }
  if (resetCredits) {
    rows.push({
      id: "reset", label: "Reset credits left", value: String(resetCredits.availableCount),
      expiresAt: resetCredits.nextExpiresAt,
    });
  }
  return rows;
}
