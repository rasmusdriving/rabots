// The calendar connection and what bots did in the person's calendar (engine 0.25.0, docs/build/step-calendar.md).
//
// Made with IF NOT EXISTS beside the numbered migrations (as the channel posts are), so the schema
// number stays and an older engine that opens the database never reads these tables.
//
// `calendar_settings` holds one row: the flow's address (a secret: it never leaves the engine), the
// mailbox the flow said it acts for, and the internal domains. `calendar_actions` keeps one row per
// create, move, cancel and answer a bot asked for, whatever became of it. No flow address in it.

import type { DatabaseSync } from "node:sqlite";

export interface CalendarSettingsRow {
  address?: string;
  mailboxName?: string;
  mailboxAddress?: string;
  checkedAt?: string;
  problem?: string;
  /** Set by the person; absent means the mailbox's own domain. */
  domains?: string[];
}

export type CalendarActionKind = "create" | "move" | "cancel" | "respond";
export type CalendarActionStatus = "done" | "failed" | "denied" | "refused" | "unknown";

export interface CalendarActionRow {
  id: string;
  botId: string;
  /** ISO 8601 time it was asked for. */
  at: string;
  action: CalendarActionKind;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  status: CalendarActionStatus;
  /** The meeting's id in Outlook, when known. */
  eventId?: string;
  /** What happened, for people. */
  note?: string;
}

export function makeCalendarTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      address TEXT,
      mailbox_name TEXT,
      mailbox_address TEXT,
      checked_at TEXT,
      problem TEXT,
      domains TEXT
    );
    CREATE TABLE IF NOT EXISTS calendar_actions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      start TEXT NOT NULL,
      end_at TEXT NOT NULL,
      attendees TEXT NOT NULL,
      status TEXT NOT NULL,
      event_id TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS calendar_actions_recent ON calendar_actions (bot_id, at);
  `);
}

const opt = (v: unknown) => (v == null ? undefined : String(v));

/** The calendar tables. Reached as `store.calendar`. */
export class CalendarStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  settings(): CalendarSettingsRow {
    const r = this.db.prepare("SELECT * FROM calendar_settings WHERE id = 1").get() as Record<string, unknown> | undefined;
    if (!r) return {};
    let domains: string[] | undefined;
    try {
      const d = r.domains == null ? undefined : (JSON.parse(String(r.domains)) as unknown);
      domains = Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : undefined;
    } catch {
      domains = undefined;
    }
    const out: CalendarSettingsRow = {};
    for (const [k, col] of [
      ["address", "address"],
      ["mailboxName", "mailbox_name"],
      ["mailboxAddress", "mailbox_address"],
      ["checkedAt", "checked_at"],
      ["problem", "problem"],
    ] as const) {
      const v = opt(r[col]);
      if (v !== undefined) out[k] = v;
    }
    if (domains) out.domains = domains;
    return out;
  }

  saveSettings(s: CalendarSettingsRow): void {
    this.db
      .prepare(
        `INSERT INTO calendar_settings (id, address, mailbox_name, mailbox_address, checked_at, problem, domains) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET address = excluded.address, mailbox_name = excluded.mailbox_name, mailbox_address = excluded.mailbox_address,
         checked_at = excluded.checked_at, problem = excluded.problem, domains = excluded.domains`,
      )
      .run(s.address ?? null, s.mailboxName ?? null, s.mailboxAddress ?? null, s.checkedAt ?? null, s.problem ?? null, s.domains ? JSON.stringify(s.domains) : null);
  }

  addAction(a: CalendarActionRow): void {
    this.db
      .prepare("INSERT INTO calendar_actions (id, bot_id, at, action, subject, start, end_at, attendees, status, event_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.botId, a.at, a.action, a.subject, a.start, a.end, JSON.stringify(a.attendees), a.status, a.eventId ?? null, a.note ?? null);
  }

  updateAction(a: CalendarActionRow): void {
    this.db.prepare("UPDATE calendar_actions SET status = ?, event_id = ?, note = ? WHERE id = ?").run(a.status, a.eventId ?? null, a.note ?? null, a.id);
  }

  /** A bot's actions, newest first. */
  actions(botId: string, limit = 50): CalendarActionRow[] {
    return (this.db.prepare("SELECT * FROM calendar_actions WHERE bot_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(botId, limit) as Record<string, unknown>[]).map(toAction);
  }
}

function toAction(r: Record<string, unknown>): CalendarActionRow {
  let attendees: string[] = [];
  try {
    const a = JSON.parse(String(r.attendees)) as unknown;
    attendees = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    attendees = [];
  }
  const status = String(r.status);
  return {
    id: String(r.id),
    botId: String(r.bot_id),
    at: String(r.at),
    action: String(r.action) as CalendarActionKind,
    subject: String(r.subject),
    start: String(r.start),
    end: String(r.end_at),
    attendees,
    status: (["done", "failed", "denied", "refused", "unknown"].includes(status) ? status : "unknown") as CalendarActionStatus,
    ...(r.event_id == null ? {} : { eventId: String(r.event_id) }),
    ...(r.note == null ? {} : { note: String(r.note) }),
  };
}
