import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { Bot, ConnectionChange, ConnectionLasts, PobotsConnection } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { clockTime } from "../lib/words";
import { setConnection } from "../state/actions";
import { useAppState } from "../state/store";
import { Face } from "./bits";
import { Dialog } from "./Dialog";
import { Swap } from "./Swap";

const COPY = ["Copy", "Copied"];
const ROW_ACTION = ["Pairing code", "Pause", "Resume"];
type Edit = { kind: "pair"; id?: string } | { kind: "edit" | "remove"; row: PobotsConnection };
const LASTS: { value: ConnectionLasts; label: string }[] = [
  { value: "24h", label: "24 hours" }, { value: "30d", label: "30 days" }, { value: "never", label: "Never" },
];
const LASTS_WORDS: Record<ConnectionLasts, string> = { "24h": "24 hours", "30d": "30 days", never: "never" };

/** "Ends in 23 hours", "Ends in 29 days", "Lasts until removed", "Will end 24 hours after connecting". */
export function lifetime(row: PobotsConnection, now = Date.now()): string {
  if (row.state === "ended") return "To connect again, pair with new codes";
  if (row.endsAt) {
    const left = Date.parse(row.endsAt) - now;
    const hours = Math.ceil(left / 3_600_000);
    if (left <= 3_600_000) return "Ends within an hour";
    if (hours <= 48) return `Ends in ${hours} hours`;
    return `Ends in ${Math.ceil(left / 86_400_000)} days`;
  }
  return row.lasts === "never" ? "Lasts until removed" : `Will end ${LASTS_WORDS[row.lasts]} after connecting`;
}

function LastsField({ value, onChange, id }: { value: ConnectionLasts; onChange: (v: ConnectionLasts) => void; id: string }) {
  return <label className="pb-field" htmlFor={id}>
    <span className="pb-label">Ends after</span>
    <select id={id} className="pb-input pb-select" value={value} onChange={e => onChange(e.target.value as ConnectionLasts)}>
      {LASTS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
    </select>
  </label>;
}

/** Protocol 35: the bots a connection can belong to, the main bot first. */
function OwnerField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const bots = useAppState(s => s.bots);
  const ordered = [...bots.filter(b => b.role === "main"), ...bots.filter(b => b.role !== "main")];
  return <label className="pb-field" htmlFor={id}>
    <span className="pb-label">Belongs to</span>
    <select id={id} className="pb-input pb-select" value={value} onChange={e => onChange(e.target.value)}>
      {ordered.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  </label>;
}

/** "Belongs to Skifte", and while that bot is on vacation that its messages wait. Always there, so the row keeps its height. */
function OwnerLine({ row, bots }: { row: PobotsConnection; bots: Bot[] }) {
  const bot = bots.find(b => b.id === row.owner);
  return <p className="pb-link-owner">
    {bot && <Face look={bot.look} size="sm" />}
    <span>Belongs to <b>{bot?.name ?? "the main bot"}</b>{bot?.vacationSince ? ", on vacation. Messages wait until it is back" : ""}</span>
  </p>;
}

function status(row: PobotsConnection): string {
  switch (row.state) {
    case "ended": return row.endedBy === "other" ? "Ended by the other side" : "Ended";
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
  const bots = useAppState(s => s.bots);
  const [edit, setEdit] = useState<Edit>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const draft = edit?.kind === "pair" ? state?.connections.find(r => r.id === edit.id) : undefined;
  // The time left on a row is read again each minute; the line keeps its place.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const counting = !!state?.connections.some(r => r.endsAt);
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [counting]);
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
      <p className="pb-section-text">Connect with another Pobots so your bots can ask or tell each other things. Each connection belongs to one of your bots: its messages go to that bot's chat, and only that bot sends on it.</p>
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
                <OwnerLine row={row} bots={bots} />
                <p className="pb-link-status" role="status">
                  <Swap lines={[`Waiting for ${row.name} to enter your code`, "Not reached since Yesterday at 23:59"]} shown={status(row)} />
                </p>
                <p className="pb-hint">{row.lastMessage ? `Last message ${clockTime(row.lastMessage)}` : "No messages yet"}</p>
                <p className="pb-hint pb-link-lasts">{lifetime(row)}</p>
              </div>
              <div className="pb-link-actions">
                {row.state === "draft" || row.state === "waiting" || (row.state === "unreached" && !row.lastReached)
                  ? <button type="button" className="pb-btn pb-btn-sm" onClick={() => setEdit({ kind: "pair", id: row.id })}><Swap lines={ROW_ACTION} shown="Pairing code" /></button>
                  : row.state !== "expired" && row.state !== "ended" && <button type="button" className="pb-btn pb-btn-sm" disabled={busy === row.id} onClick={() => void rowAction(row)}>
                      <Swap lines={ROW_ACTION} shown={row.state === "paused" ? "Resume" : "Pause"} />
                    </button>}
                {row.state !== "ended" && <button type="button" className="pb-btn pb-btn-sm" onClick={() => setEdit({ kind: "edit", row })} aria-label={`Edit ${row.name}`}>Edit</button>}
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
  const [lasts, setLasts] = useState<ConnectionLasts>("never");
  const mainId = useAppState(s => s.bots.find(b => b.role === "main")?.id ?? "");
  const [owner, setOwner] = useState(mainId);
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
    const change: ConnectionChange = !id ? { action: "start", name, lasts, ...(owner && owner !== mainId ? { owner } : {}) } : !mine ? { action: "code", id } : { action: "connect", id, code: theirs };
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
      {!id ? <>
        <label className="pb-field">
          <span className="pb-label">Name for the other Pobots</span>
          <input className="pb-input" value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="For example, Sam" />
        </label>
        <LastsField id="pair-lasts" value={lasts} onChange={setLasts} />
        <p className="pb-hint">Counts from when both sides are connected. You can change it later.</p>
        <OwnerField id="pair-owner" value={owner} onChange={setOwner} />
        <p className="pb-hint">Its messages go to this bot's chat, and only this bot sends on it.</p>
      </> : <>
        <p className="pb-hint">Share your code with the other person. A code can be used once, within 24 hours. That limit is only for the code, not for the connection.</p>
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
  const [lasts, setLasts] = useState<ConnectionLasts>(edit.row.lasts);
  const [owner, setOwner] = useState(edit.row.owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = edit.kind === "remove";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const id = edit.row.id;
    try {
      if (remove) await setConnection({ action: "remove", id });
      else {
        if (name.trim() !== edit.row.name) await setConnection({ action: "rename", id, name });
        if (lasts !== edit.row.lasts) await setConnection({ action: "lasts", id, lasts });
        if (owner && owner !== edit.row.owner) await setConnection({ action: "owner", id, owner });
      }
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title={remove ? `Remove ${edit.row.name}?` : "Edit connection"} onClose={onClose}
    size={remove ? "confirm" : "sheet"} text={remove ? "The two bots will stop exchanging messages. To reconnect, share new pairing codes." : undefined}>
    <form className="pb-link-form" onSubmit={submit}>
      {!remove && <>
        <label className="pb-field">
          <span className="pb-label">Connection name</span>
          <input className="pb-input" value={name} maxLength={60} onChange={e => setName(e.target.value)} />
        </label>
        <LastsField id="edit-lasts" value={lasts} onChange={setLasts} />
        <p className="pb-hint">A new choice counts from now. When the time is up, this side ends the connection and tells the other side.</p>
        <OwnerField id="edit-owner" value={owner} onChange={setOwner} />
        <p className="pb-hint">New messages go to this bot's chat, and only this bot sends on it. What is already in a chat stays there.</p>
      </>}
      <p className="pb-link-feedback pb-hint" role={error ? "alert" : undefined}>{error}</p>
      <div className="pb-dialog-actions">
        <button type="button" className="pb-btn" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy || !name.trim()} className={remove ? "pb-btn pb-btn-danger pb-btn-danger-strong" : "pb-btn pb-btn-primary"}>
          {remove ? "Remove connection" : "Save"}
        </button>
      </div>
    </form>
  </Dialog>;
}
