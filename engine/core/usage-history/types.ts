import type { HistoryProvider, UsageSpeed } from "../../../shared/protocol.js";

export interface UsageRecord {
  at: number;
  model: string;
  speed: UsageSpeed;
  /** Token counts are disjoint. Reasoning is already in output. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteHour: number;
  output: number;
  reported?: number;
  /** Opaque request fingerprint, for repeated messages or copied history. */
  key: string;
  /** Opaque session fingerprint, used only for counting distinct sessions. */
  session: string;
}

export interface Source {
  provider: HistoryProvider;
  dir: string;
}
