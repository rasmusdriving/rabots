import type { Attachment, ConnectionChange, ConnectionChangeResult, ConnectionsState, PobotsConnection } from "../../shared/protocol";
import { EngineError, type EngineEvent } from "./types";

declare global {
  interface Window {
    pobotsMockConnection?: (state: PobotsConnection["state"]) => void;
    /** Protocol 35: a message from the first connection arrives in the main chat with these files. */
    pobotsMockConnectionFiles?: (text: string, files: { name: string; size: number }[]) => void;
  }
}

/** Protocol 35: `owner` is the bot the connection belongs to; the message lands in its chat. */
export type ConnectionArrival = (name: string, text: string, attachments: Attachment[], owner: string) => void;
type MockBot = { id: string; role: string; name: string };

export class MockConnections {
  private rows: PobotsConnection[] = [];

  constructor(private hasPublicAddress: boolean, private emit: (event: EngineEvent) => void, arrive: ConnectionArrival, private bots: () => MockBot[]) {
    window.pobotsMockConnectionFiles = (text, files) => {
      const month = new Date().toISOString().slice(0, 7);
      arrive(this.rows[0]?.name ?? "Sam", text, files.map(f => {
        const id = crypto.randomUUID();
        return { id, name: f.name, kind: "file", size: f.size, type: f.name.endsWith(".pdf") ? "application/pdf" : "text/markdown",
          path: `.attachments/${month}/${id}/${f.name}` };
      }), this.rows[0]?.owner ?? this.main());
    };
    window.pobotsMockConnection = state => {
      const row = this.rows[0];
      if (!row) return;
      row.state = state;
      if (state === "connected") {
        row.lastReached = row.lastMessage = new Date().toISOString();
        this.ends(row, Date.now());
      }
      if (state === "ended") {
        row.endedAt = new Date().toISOString();
        row.endedBy = "time";
        delete row.endsAt;
      }
      this.publish();
    };
  }

  private main(): string {
    return this.bots().find(b => b.role === "main")?.id ?? "";
  }

  /** As the engine: a bot that is gone hands its connections back to the main bot. */
  list(): ConnectionsState {
    const ids = new Set(this.bots().map(b => b.id));
    for (const row of this.rows) if (!ids.has(row.owner)) row.owner = this.main();
    return structuredClone({ hasPublicAddress: this.hasPublicAddress, connections: this.rows });
  }

  private owner(id: string): string {
    const bot = this.bots().find(b => b.id === id || b.name.toLowerCase() === id.trim().toLowerCase());
    if (!bot) throw new EngineError({ code: "bad_request", message: "There is no bot by that name." });
    return bot.id;
  }

  /** The end time once connected, as the engine counts it. */
  private ends(row: PobotsConnection, from: number) {
    const ms = row.lasts === "24h" ? 86_400_000 : row.lasts === "30d" ? 30 * 86_400_000 : 0;
    if (ms && (row.state === "connected" || row.state === "paused" || row.state === "unreached")) row.endsAt = new Date(from + ms).toISOString();
    else delete row.endsAt;
  }

  private publish() {
    this.emit({ event: "connection.changed", data: this.list() });
  }

  change(p: ConnectionChange): ConnectionChangeResult {
    if (p.action === "start") {
      const id = crypto.randomUUID();
      const owner = p.owner ? this.owner(p.owner) : this.main();
      this.rows.push({ id, name: p.name.trim(), state: "draft", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lasts: p.lasts ?? "never", owner });
      this.publish();
      return { state: this.list(), id, code: "pobots-link-1.example-local-public-code" };
    }
    const row = this.rows.find(r => r.id === p.id);
    if (!row) throw new EngineError({ code: "not_found", message: "That connection was not found." });
    if (row.state === "ended" && p.action !== "remove") throw new EngineError({ code: "conflict", message: "That connection has ended. Remove it, and pair again with new codes to connect again." });
    if (p.action === "code") return { state: this.list(), id: row.id, code: "pobots-link-1.example-local-public-code" };
    if (p.action === "connect") {
      if (p.code !== "pobots-link-1.example-peer-public-code") throw new EngineError({ code: "bad_request", message: "That pairing code is not complete or has a typo." });
      row.state = "waiting";
    } else if (p.action === "pause") row.state = "paused";
    else if (p.action === "resume") row.state = "connected";
    else if (p.action === "rename") row.name = p.name.trim();
    else if (p.action === "lasts") {
      row.lasts = p.lasts;
      this.ends(row, Date.now());
    }
    else if (p.action === "owner") row.owner = this.owner(p.owner);
    else if (p.action === "remove") this.rows = this.rows.filter(r => r !== row);
    this.publish();
    return { state: this.list(), id: row.id };
  }
}
