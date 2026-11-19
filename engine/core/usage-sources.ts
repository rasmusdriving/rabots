// Choose local fallbacks after all the hubs have listed their accounts.
import type { ProviderId, UsageAccount, UsageProvider } from "../../shared/protocol.js";

interface LocalReader {
  id: ProviderId;
  label: string;
  executable?: string;
  enabled: boolean;
  ready: boolean;
  read(executable: string): Promise<UsageAccount>;
}

export async function addLocalUsage(hub: UsageProvider[], local: LocalReader[]): Promise<UsageProvider[]> {
  const listed = new Set(hub.filter((p) => p.accounts.length).map((p) => p.id));
  const fallback = local.filter((p) => p.enabled && p.ready && p.executable && !listed.has(p.id));
  const providers = await Promise.all(fallback.map(async (p): Promise<UsageProvider> => {
    let account: UsageAccount;
    try {
      account = { ...await p.read(p.executable!), via: "This Mac" };
    } catch {
      const name = p.id === "claude" ? "Claude Code" : p.label;
      account = { id: `${p.id}-local`, windows: [], via: "This Mac", problem: `${name} could not be asked for its usage.` };
    }
    return { id: p.id, label: p.label, accounts: [account] };
  }));
  return [...hub.filter((p) => p.accounts.length), ...providers];
}
