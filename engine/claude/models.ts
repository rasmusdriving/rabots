// The models a bot can use. The harness's own list wins once a session has started; until then
// a fixed list of the current Claude models.
//
// The harness list can be long and noisy: behind a gateway it also lists models the gateway
// routes elsewhere under made-up "claude-..." ids, and old dated models. We keep only plain
// Claude ids ("claude-<family>-<major>[-<minor>]"), add the current models if the list lags
// behind, and offer only the newest of each family.
import type { ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, ModelInfo } from "../../shared/protocol.js";

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const PLAIN_ID = /^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?$/;

export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-fable-5-2", harness: "claude", label: "Fable 5.2", efforts: ALL, defaultEffort: "medium" },
  { id: "claude-opus-5-5", harness: "claude", label: "Opus 5.5", efforts: ALL, defaultEffort: "medium" },
  { id: "claude-sonnet-5-5", harness: "claude", label: "Sonnet 5.5", efforts: ALL, defaultEffort: "medium" },
  { id: "claude-haiku-5-5", harness: "claude", label: "Haiku 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

/** Turns the harness's model list into ours. Aliases ("opus", "default") count as the id they stand for. */
export function mapModels(rows: SdkModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const row of rows) {
    const id = PLAIN_ID.test(row.value) ? row.value : row.resolvedModel && PLAIN_ID.test(row.resolvedModel) ? row.resolvedModel : undefined;
    if (!id || byId.has(id)) continue;
    const efforts = row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? []).filter((e): e is Effort => ALL.includes(e));
    const list = efforts.length ? efforts : FALLBACK_MODELS.find((m) => m.id === id)?.efforts ?? ["medium"];
    byId.set(id, { id, harness: "claude", label: labelFor(id), efforts: list, defaultEffort: list.includes("medium") ? "medium" : list[0]! });
  }
  // The current models are always offered, also when the harness's list lags behind them.
  for (const m of FALLBACK_MODELS) if (!byId.has(m.id)) byId.set(m.id, m);
  return newestPerFamily(sortModels([...byId.values()]));
}

/** Keeps the newest model of each family, so the picker stays short. Expects a sorted list. */
export function newestPerFamily(sorted: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return sorted.filter((m) => {
    const family = PLAIN_ID.exec(m.id)?.[1];
    if (!family) return true;
    if (seen.has(family)) return false;
    seen.add(family);
    return true;
  });
}

export function sortModels(models: ModelInfo[]): ModelInfo[] {
  const key = (id: string): [number, number, number] => {
    const m = PLAIN_ID.exec(id);
    if (!m) return [FAMILIES.length, 0, 0];
    return [FAMILIES.indexOf(m[1]!), Number(m[2]), Number(m[3] ?? 0)];
  };
  return [...models].sort((a, b) => {
    const [fa, ma, na] = key(a.id);
    const [fb, mb, nb] = key(b.id);
    return fa - fb || mb - ma || nb - na || a.id.localeCompare(b.id);
  });
}

/** "claude-opus-5-5" becomes "Opus 5.5". Other ids are shown as they are. */
export function labelFor(id: string): string {
  const m = PLAIN_ID.exec(id) ?? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(id);
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

/** A model entry for an id a bot uses that is not in the list, so the picker can still show it. */
export function modelFor(id: string): ModelInfo {
  return FALLBACK_MODELS.find((m) => m.id === id) ?? { id, harness: "claude", label: labelFor(id), efforts: ALL, defaultEffort: "medium" };
}
