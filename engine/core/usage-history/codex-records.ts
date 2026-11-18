// Codex has per-request ledger events in newer files and context snapshots in older ones.
// Only count a snapshot's last request; a resumed/forked session can carry an older baseline.
import type { UsageSpeed } from "../../../shared/protocol.js";
import { count, fields, fingerprint, modelName, speedOf, stamp, type Fields } from "./records.js";
import type { UsageRecord } from "./types.js";

type Counts = [input: number, cacheRead: number, cacheWrite: number, output: number, reasoning: number, total: number];
type Request = Pick<UsageRecord, "at" | "model" | "speed"> & { counts: Counts };
export interface CodexState {
  session: string;
  model: string;
  speed: UsageSpeed;
  copiedAt?: number;
  seenMeta?: boolean;
  ledger?: boolean;
  previous?: Counts;
  previousAt?: number;
  last?: string;
  restart?: string;
  pending?: Request[];
}

export const codexState = (session: string): CodexState => ({ session, model: "Unknown model", speed: "standard" });

function usage(v: unknown): Counts | undefined {
  const r = fields(v);
  if (typeof r.input_tokens !== "number" || typeof r.output_tokens !== "number") return;
  const raw = [r.input_tokens, r.cached_input_tokens ?? 0, r.cache_write_input_tokens ?? 0,
    r.output_tokens, r.reasoning_output_tokens ?? 0, r.total_tokens ?? (r.input_tokens + r.output_tokens)];
  if (raw.some((n) => !Number.isSafeInteger(n) || (n as number) < 0)) return;
  const values = raw.map(count) as Counts;
  return valid(values) ? values : undefined;
}
const valid = ([input, read, write, output, reasoning, total]: Counts) =>
  read >= 0 && write >= 0 && output >= 0 && reasoning >= 0 && read + write <= input && reasoning <= output && total >= input + output;
const add = (a: Counts | undefined, b: Counts) => b.map((n, i) => n + (a?.[i] ?? 0)) as Counts;
const sub = (a: Counts, b: Counts | undefined) => a.map((n, i) => n - (b?.[i] ?? 0)) as Counts;
const same = (a: Counts, b: Counts) => a.every((n, i) => n === b[i]);
const nonzero = (counts: Counts) => counts[0] + counts[3] > 0;

export function codexRecords(record: Fields, state: CodexState): UsageRecord[] {
  const p = fields(record.payload);
  const at = stamp(record.timestamp);
  if (record.type === "session_meta") {
    if (!state.seenMeta) {
      state.seenMeta = true;
      const id = p.id ?? p.session_id;
      if (typeof id === "string") state.session = fingerprint(id);
      const spawn = fields(fields(fields(p.source).subagent).thread_spawn);
      if (Number.isFinite(at) && (typeof p.forked_from_id === "string" || typeof spawn.parent_thread_id === "string")) state.copiedAt = at;
    }
    return [];
  }
  if (record.type === "turn_context") {
    state.ledger = false;
    if (typeof p.model === "string") state.model = modelName(p.model);
    if (Object.hasOwn(p, "service_tier")) state.speed = speedOf(p.service_tier);
    return [];
  }
  if (p.type === "thread_settings_applied") {
    state.speed = speedOf(fields(p.thread_settings).service_tier);
    return [];
  }
  const ledger = record.type === "token_usage_record";
  if ((!ledger && p.type !== "token_count") || !Number.isFinite(at)) return [];

  const info = fields(p.info);
  const last = usage(ledger ? p.usage : info.last_token_usage);
  const total = usage(info.total_token_usage);
  const before = state.previous;
  const previousAt = state.previousAt;
  const copied = state.copiedAt !== undefined && at - state.copiedAt < 1000;
  if (state.copiedAt !== undefined) state.copiedAt = copied ? at : undefined;

  const toRecord = ({ at, model, speed, counts: [input, cacheRead, cacheWrite, output] }: Request, id?: string): UsageRecord => ({
    at, model, speed, input: input - cacheRead - cacheWrite, cacheRead, cacheWrite, output, cacheWriteHour: 0,
    session: state.session,
    key: id ? fingerprint(state.session, id) : fingerprint(state.session, at, model, input, cacheRead, cacheWrite, output),
  });
  const request = last && { at, model: state.model, speed: state.speed, counts: last };
  if (ledger) {
    if (copied || !request || !nonzero(request.counts)) return [];
    if (typeof p.response_id !== "string" || !p.response_id) {
      state.ledger = false;
      if ((state.pending?.length ?? 0) < 256) (state.pending ??= []).push(request);
      return [];
    }
    state.ledger = true;
    const pending = state.pending ?? [];
    delete state.pending;
    state.previous = add(pending.reduce((a, r) => add(a, r.counts), before), request.counts);
    return [...pending.map((r) => toRecord(r)), toRecord(request, p.response_id)];
  }
  const pending = state.pending ?? [];
  if (total) {
    state.previous = total;
    state.previousAt = Math.max(previousAt ?? at, at);
    delete state.pending;
    if (!nonzero(total)) delete state.restart;
  }
  if (copied || state.ledger || !request || (info.total_token_usage != null && !total)) return [];
  if (!nonzero(request.counts)) { delete state.last; return []; }
  if (request.counts[5] !== request.counts[0] + request.counts[3]) return [];
  const signature = request.counts.join(",");
  let extra: Request[] = [];
  if (total) {
    if (before && same(total, before)) return [];
    const restarted = same(total, request.counts);
    const start = `${at}:${signature}`;
    if (restarted && state.restart === start) { state.previous = before; return []; }
    const rewound = before && at > (previousAt ?? 0) && total.some((n, i) => n < before[i]!);
    const delta = sub(total, before);
    if (!restarted && !(before && !rewound ? same(delta, request.counts) : valid(sub(total, request.counts)))) {
      const tail = pending.at(-1);
      const summed = pending.reduce((a, r) => add(a, r.counts), undefined as Counts | undefined);
      if (!before || !tail || !summed || !same(delta, summed)) return [];
      const remainder = sub(tail.counts, request.counts);
      if (!valid(remainder)) return [];
      extra = pending.slice(0, -1);
      if (nonzero(remainder)) extra.push({ ...tail, counts: remainder });
    }
    if (restarted) state.restart = start;
  } else {
    if (signature === state.last) return [];
    state.previous = add(before, request.counts);
  }
  state.last = signature;
  return [...extra.map((r) => toRecord(r)), toRecord(request)];
}
