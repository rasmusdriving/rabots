import { useRef, useState, type FormEvent } from "react";
import type { ConnectionChange, PobotsConnection } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { clockTime } from "../lib/words";
import { setConnection } from "../state/actions";
import { useAppState } from "../state/store";
import { Dialog } from "./Dialog";
import { Swap } from "./Swap";

const COPY = ["Copy", "Copied"];
const ROW_ACTION = ["Pairing code", "Pause", "Resume"];
type Edit = { kind: "pair"; id?: string } | { kind: "rename" | "remove"; row: PobotsConnection };

function status(row: PobotsConnection): string {
  switch (row.state) {
    case "draft": return "Add their pairing code";
    case "waiting": return `Waiting for ${row.name} to enter your code`;
    case "connected": return "Connected";
    case "paused": return "Paused";
    case "expired": return "Pairing code expired";
    case "unreached": return row.lastReached ? `Not reached since ${clockTime(row.lastReached)}` : "Not reached yet";
  }
}

export function ConnectionsSection() {
  const state = useAppState(s => s.connections);
  const [edit, setEdit] = useState<Edit>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const draft = edit?.kind === "pair" ? state?.connections.find(r => r.id === edit.id) : undefined;
  async function rowAction(row: PobotsConnection) {
    setBusy(row.id);
    setError("");
    try {
      await setConnection({ id: row.id, action: row.state === "paused" ? "resume" : "pause" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="pb-section pb-links" aria-labelledby="set-connections">
      <h2 className="pb-section-title" id="set-connections">Connections</h2>
      <p className="pb-section-text">Connect with another Pobots so your main bots can ask or tell each other things.</p>
      {state?.hasPublicAddress === false && <p className="pb-hint">This Pobots has no public address. A connection still works when the other Pobots has one.</p>}
      <div className="pb-link-actions">
        <button type="button" className="pb-btn" onClick={() => setEdit({ kind: "pair" })}>Connect to another Pobots</button>
      </div>
      <p className="pb-link-feedback pb-hint" role={error ? "alert" : undefined}>{error}</p>
      {!state ? <p className="pb-hint">Waiting for connections.</p> :
        !state.connections.length ? <p className="pb-hint">No connections yet.</p> :
        <ul className="pb-link-list">
          {state.connections.map(row => (
            <li className="pb-link-row" key={row.id} data-state={row.state}>
              <div className="pb-link-summary">
                <h3 className="body-strong">{row.name}</h3>
                <p className="pb-link-status" role="status">
                  <Swap lines={[`Waiting for ${row.name} to enter your code`, "Not reached since Yesterday at 23:59"]} shown={status(row)} />
                </p>
                <p className="pb-hint">{row.lastMessage ? `Last message ${clockTime(row.lastMessage)}` : "No messages yet"}</p>
              </div>
              <div className="pb-link-actions">
                {row.state === "draft" || row.state === "waiting" || (row.state === "unreached" && !row.lastReached)
                  ? <button type="button" className="pb-btn pb-btn-sm" onClick={() => setEdit({ kind: "pair", id: row.id })}><Swap lines={ROW_ACTION} shown="Pairing code" /></button>
                  : row.state !== "expired" && <button type="button" className="pb-btn pb-btn-sm" disabled={busy === row.id} onClick={() => void rowAction(row)}>
                      <Swap lines={ROW_ACTION} shown={row.state === "paused" ? "Resume" : "Pause"} />
                    </button>}
                <button type="button" className="pb-btn pb-btn-sm" onClick={() => setEdit({ kind: "rename", row })} aria-label={`Rename ${row.name}`}>Rename</button>
                <button type="button" className="pb-btn pb-btn-sm pb-btn-danger" onClick={() => setEdit({ kind: "remove", row })} aria-label={`Remove ${row.name}`}>Remove</button>
              </div>
            </li>
          ))}
        </ul>}
      {edit?.kind === "pair" && <PairFlow initial={draft} onClose={() => setEdit(undefined)} />}
      {edit && edit.kind !== "pair" && <EditFlow key={edit.row.id} edit={edit} onClose={() => setEdit(undefined)} />}
    </section>
  );
}

function PairFlow({ initial, onClose }: { initial?: PobotsConnection; onClose: () => void }) {
  const [id, setId] = useState(initial?.id);
  const [name, setName] = useState(initial?.name ?? "");
  const [mine, setMine] = useState("");
  const [theirs, setTheirs] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const codeField = useRef<HTMLInputElement>(null);
  const live = useAppState(s => s.connections?.connections.find(r => r.id === id));
  const canEnter = live?.state === "draft";
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const change: ConnectionChange = !id ? { action: "start", name } : !mine ? { action: "code", id } : { action: "connect", id, code: theirs };
    setBusy(true);
    setError("");
    try {
      const result = await setConnection(change);
      setId(result.id);
      if (result.code) setMine(result.code);
      if (change.action === "connect") onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(mine);
      setCopied(true);
    } catch {
      codeField.current?.focus();
      codeField.current?.select();
      setError("The code is selected. Copy it to share it.");
    }
  };
  return <Dialog title={id ? `Connect to ${name}` : "Connect to another Pobots"} size="sheet" onClose={onClose}>
    <form className="pb-link-form" onSubmit={onSubmit}>
      {!id ? <label className="pb-field">
        <span className="pb-label">Name for the other Pobots</span>
        <input className="pb-input" value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="For example, Sam" />
      </label> : <>
        <p className="pb-hint">Share your code with the other person. Each code can be used once and lasts 24 hours.</p>
        {mine && <>
          <div className="pb-link-code">
            <label className="pb-field">
              <span className="pb-label">Your pairing code</span>
              <input ref={codeField} className="pb-input" readOnly value={mine} spellCheck={false} />
            </label>
            <button className="pb-btn" type="button" onClick={() => void copy()}><Swap lines={COPY} shown={copied ? "Copied" : "Copy"} /></button>
          </div>
          {canEnter && <label className="pb-field">
            <span className="pb-label">Their pairing code</span>
            <input className="pb-input" value={theirs} onChange={e => setTheirs(e.target.value)} maxLength={2058} spellCheck={false} autoComplete="off" autoCapitalize="off" />
          </label>}
        </>}
      </>}
      <p className="pb-link-feedback pb-hint" role={error ? "alert" : undefined}>{error}</p>
      <div className="pb-dialog-actions">
        <button className="pb-btn" type="button" onClick={onClose}>{id ? "Close" : "Cancel"}</button>
        {(!id || !mine || canEnter) && <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || (!id ? !name.trim() : !!mine && !theirs.trim())}>
          {!id ? "Make pairing code" : !mine ? "Show pairing code" : "Connect"}
        </button>}
      </div>
    </form>
  </Dialog>;
}

function EditFlow({ edit, onClose }: { edit: Exclude<Edit, { kind: "pair" }>; onClose: () => void }) {
  const [name, setName] = useState(edit.row.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = edit.kind === "remove";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await setConnection(remove ? { action: "remove", id: edit.row.id } : { action: "rename", id: edit.row.id, name });
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title={remove ? `Remove ${edit.row.name}?` : "Rename connection"} onClose={onClose}
    size={remove ? "confirm" : "sheet"} text={remove ? "The main bots will stop exchanging messages. To reconnect, share new pairing codes." : undefined}>
    <form className="pb-link-form" onSubmit={submit}>
      {!remove && <label className="pb-field">
        <span className="pb-label">Connection name</span>
        <input className="pb-input" value={name} maxLength={60} onChange={e => setName(e.target.value)} />
      </label>}
      <p className="pb-link-feedback pb-hint" role={error ? "alert" : undefined}>{error}</p>
      <div className="pb-dialog-actions">
        <button type="button" className="pb-btn" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy || !name.trim()} className={remove ? "pb-btn pb-btn-danger pb-btn-danger-strong" : "pb-btn pb-btn-primary"}>
          {remove ? "Remove connection" : "Save name"}
        </button>
      </div>
    </form>
  </Dialog>;
}
