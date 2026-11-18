// First run: no bots yet. One calm screen that asks for the first bot's name and creates it.
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../engine/types";
import { createBot } from "../state/actions";
import { Face } from "./bits";
import { QuietLines } from "./ChatPanel";

export function FirstRun() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const create = () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    createBot({ name: value }).catch((e: unknown) => {
      setBusy(false);
      setError(messageOf(e));
    });
  };

  return (
    <div className="app-first">
      <div className="app-first-drag" />
      <main className="app-first-body pb-arrive">
        <Face look={{ eyes: "tall", gap: "mid" }} size="xl" />
        <h1 className="display app-first-title">Your first bot</h1>
        <p className="app-first-text">It becomes your main bot. It keeps its own notes and remembers your talks, also after a restart.</p>
        <form
          className="app-first-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <div className="pb-field app-first-field">
            <label className="pb-label" htmlFor="first-name">
              Name
            </label>
            <input
              ref={input}
              id="first-name"
              className="pb-input"
              type="text"
              value={name}
              maxLength={60}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              aria-describedby="first-hint"
            />
            <span className={error ? "pb-hint app-hint-error" : "pb-hint"} id="first-hint" role={error ? "alert" : undefined}>
              {error ?? "You can change it later."}
            </span>
          </div>
          <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || !name.trim()}>
            Create bot
          </button>
        </form>
        <div className="app-first-lines">
          <QuietLines />
        </div>
      </main>
    </div>
  );
}
