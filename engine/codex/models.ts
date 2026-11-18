// The GPT models a bot can use, from Codex's `model/list`. Kept short the way the Claude list is:
// the newest model of each family (Sol, Terra, Luna, Astra). Codex's "ultra" effort is not offered.
import type { Effort, Harness, ModelInfo } from "../../shared/protocol.js";

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** The families in the order the picker shows them. Others follow, newest first. */
const FAMILIES = ["sol", "terra", "luna", "astra"];
const GPT_ID = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)$/;

type Loose = Record<string, unknown>;

/** The one tier Pobots offers as fast mode (Codex's id for ChatGPT's fast mode), and its older name. */
export const FAST_TIER = "priority";
const FAST_SPEED_TIER = "fast";
/** Codex's few words about fast mode are cut at this length. */
const FAST_HINT_MAX = 60;

/**
 * Whether a row of Codex's model/list has a fast mode, and Codex's own few words about it: a tier with
 * the id "priority" in `serviceTiers`, or, for a Codex that sends no `serviceTiers`, "fast" in the
 * older `additionalSpeedTiers`. No other tier is offered (docs/build/step-3b.md, A1).
 */
export function codexFastMode(row: unknown): { fast: true; fastHint?: string } | undefined {
  const r = row && typeof row === "object" ? (row as Loose) : {};
  if (Array.isArray(r.serviceTiers)) {
    const tier = (r.serviceTiers as unknown[]).map((t) => (t && typeof t === "object" ? (t as Loose) : {})).find((t) => t.id === FAST_TIER);
    if (!tier) return undefined;
    const hint = typeof tier.description === "string" ? tier.description.replace(/\s+/g, " ").trim().slice(0, FAST_HINT_MAX).trim() : "";
    return { fast: true, ...(hint ? { fastHint: hint } : {}) };
  }
  if (Array.isArray(r.additionalSpeedTiers) && (r.additionalSpeedTiers as unknown[]).includes(FAST_SPEED_TIER)) return { fast: true };
  return undefined;
}

/**
 * The ids of the models in Codex's model/list that cannot take pictures: their `inputModalities` is a
 * list without "image". A row without the field is taken to take pictures (every GPT model listed on
 * 13 Nov 2026 said ["text","image"]).
 */
export function codexNoPictures(rows: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of rows) {
    const r = raw && typeof raw === "object" ? (raw as Loose) : {};
    const id = typeof r.id === "string" ? r.id : typeof r.model === "string" ? r.model : "";
    if (id && Array.isArray(r.inputModalities) && !(r.inputModalities as unknown[]).includes("image") && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Codex's model list as Pobots offers it: the newest of each family. Rows that are hidden or not plain GPT ids are dropped. */
export function mapCodexModels(rows: unknown[]): ModelInfo[] {
  return newestPerCodexFamily(mapAllCodexModels(rows, { hidden: false }));
}

/**
 * Every model Codex listed (hidden ones too, unless `hidden: false`), sorted, before the list is cut to the newest of each family.
 * An older GPT model a bot still uses is looked up here, so it keeps its efforts and its fast mode.
 */
export function mapAllCodexModels(rows: unknown[], o: { hidden?: boolean } = {}): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const raw of rows) {
    const r = raw && typeof raw === "object" ? (raw as Loose) : {};
    const id = typeof r.id === "string" ? r.id : typeof r.model === "string" ? r.model : "";
    // A hidden model is not offered, but a bot may still be on it: it is looked up here with the rest.
    if (!id || (o.hidden === false && r.hidden === true) || out.some((m) => m.id === id)) continue;
    const offered = Array.isArray(r.supportedReasoningEfforts)
      ? (r.supportedReasoningEfforts as unknown[]).map((e) => (e && typeof e === "object" ? (e as Loose).reasoningEffort : e)).filter((e): e is Effort => ALL.includes(e as Effort))
      : [];
    const efforts = ALL.filter((e) => offered.includes(e));
    const list = efforts.length ? efforts : ["medium" as Effort];
    const own = r.defaultReasoningEffort as Effort;
    const label = typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : codexLabel(id);
    out.push({ id, harness: "codex", label, efforts: list, defaultEffort: list.includes(own) ? own : list.includes("medium") ? "medium" : list[0]!, ...codexFastMode(r) });
  }
  return sortCodexModels(out);
}

/**
 * Does this model have a fast mode right now: it is in the list of every model Codex gave and that
 * entry has one. Claude models and GPT ids Codex does not list have none. The one answer used by
 * everything that decides about fast mode (step 3b).
 */
export function modelHasFast(id: string, known: ModelInfo[]): boolean {
  return known.some((m) => m.id === id && m.harness === "codex" && m.fast === true);
}

function key(id: string): [number, number, number] {
  const m = GPT_ID.exec(id);
  if (!m) return [FAMILIES.length + 1, 0, 0];
  const f = FAMILIES.indexOf(m[3]!);
  return [f < 0 ? FAMILIES.length : f, Number(m[1]), Number(m[2] ?? 0)];
}

export function sortCodexModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const [fa, ma, na] = key(a.id);
    const [fb, mb, nb] = key(b.id);
    return fa - fb || mb - ma || nb - na || a.id.localeCompare(b.id);
  });
}

/** The newest model of each family. Expects a sorted list. Ids that are not plain GPT ids are kept. */
export function newestPerCodexFamily(sorted: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return sorted.filter((m) => {
    const family = GPT_ID.exec(m.id)?.[3];
    if (!family) return true;
    if (seen.has(family)) return false;
    seen.add(family);
    return true;
  });
}

/** "gpt-6.1-terra" becomes "GPT-6.1 Terra". Other ids are shown as they are. */
export function codexLabel(id: string): string {
  const m = GPT_ID.exec(id);
  if (!m) return id;
  return `GPT-${m[1]}${m[2] !== undefined ? `.${m[2]}` : ""} ${m[3]!.charAt(0).toUpperCase()}${m[3]!.slice(1)}`;
}

/** Whether an id looks like one of Codex's models, for ids that are in neither list (yet). */
export function looksLikeCodex(id: string): boolean {
  return /^(gpt-|o\d|codex-)/i.test(id.trim());
}

/** The harness of a model id: the list it is in, else what the id looks like. */
export function harnessOfModel(id: string, lists: { claude: ModelInfo[]; codex: ModelInfo[] }): Harness {
  if (lists.codex.some((m) => m.id === id)) return "codex";
  if (lists.claude.some((m) => m.id === id)) return "claude";
  return looksLikeCodex(id) ? "codex" : "claude";
}

/** A model entry for a GPT id a bot uses that is not in the list, so the picker can still show it. */
export function codexModelFor(id: string): ModelInfo {
  return { id, harness: "codex", label: codexLabel(id), efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" };
}
