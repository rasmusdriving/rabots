// Types for scripts/calendar-standin.mjs, for the engine's tests.
import type { Server } from "node:http";

export interface StandinBusy {
  start: number;
  end: number;
  status?: string;
}

export interface StandinControl {
  fail: number;
  failOn: Record<string, number>;
  slowMs: number;
  busy: Record<string, StandinBusy[]>;
  errors: string[];
}

export interface CalendarStandin {
  server: Server;
  mailbox: { name: string; address: string };
  events: Map<string, Record<string, any>>;
  calls: Record<string, any>[];
  control: StandinControl;
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
}

export function makeCalendarStandin(opts?: {
  mailbox?: string;
  mailboxName?: string;
  fail?: number;
  failOn?: Record<string, number>;
  slowMs?: number;
  busy?: Record<string, StandinBusy[]>;
  errors?: string[];
  seed?: Record<string, unknown>[];
}): CalendarStandin;
