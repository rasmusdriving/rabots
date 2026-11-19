import type { ConnectionChange, ConnectionChangeResult, ConnectionsState, PobotsConnection } from "../../shared/protocol";
import { EngineError, type EngineEvent } from "./types";

declare global {
  interface Window {
    pobotsMockConnection?: (state: PobotsConnection["state"]) => void;
  }
}

export class MockConnections {
  private rows: PobotsConnection[] = [];

  constructor(private hasPublicAddress: boolean, private emit: (event: EngineEvent) => void) {
    window.pobotsMockConnection = state => {
      const row = this.rows[0];
      if (!row) return;
      row.state = state;
      if (state === "connected") row.lastReached = row.lastMessage = new Date().toISOString();
      this.publish();
    };
  }

  list(): ConnectionsState {
    return structuredClone({ hasPublicAddress: this.hasPublicAddress, connections: this.rows });
  }

  private publish() {
    this.emit({ event: "connection.changed", data: this.list() });
  }

  change(p: ConnectionChange): ConnectionChangeResult {
    if (p.action === "start") {
      const id = crypto.randomUUID();
      this.rows.push({ id, name: p.name.trim(), state: "draft", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      this.publish();
      return { state: this.list(), id, code: "pobots-link-1.example-local-public-code" };
    }
    const row = this.rows.find(r => r.id === p.id);
    if (!row) throw new EngineError({ code: "not_found", message: "That connection was not found." });
    if (p.action === "code") return { state: this.list(), id: row.id, code: "pobots-link-1.example-local-public-code" };
    if (p.action === "connect") {
      if (p.code !== "pobots-link-1.example-peer-public-code") throw new EngineError({ code: "bad_request", message: "That pairing code is not complete or has a typo." });
      row.state = "waiting";
    } else if (p.action === "pause") row.state = "paused";
    else if (p.action === "resume") row.state = "connected";
    else if (p.action === "rename") row.name = p.name.trim();
    else if (p.action === "remove") this.rows = this.rows.filter(r => r !== row);
    this.publish();
    return { state: this.list(), id: row.id };
  }
}
