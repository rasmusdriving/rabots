// First start (engine 0.33.0): no bots yet. One calm screen: a welcome, the main bot's name (filled in
// with "Po", the name the docs use for the main bot), its model as "Add a bot" offers them, and one
// button. The main bot made here greets the person by itself (`welcome`) and gets to know them.
// An install with bots never sees this screen (docs/build/step-first-start.md).
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../engine/types";
import { createBot } from "../state/actions";
import { useAppState } from "../state/store";
import { codexReady, offeredModels } from "../lib/models";
import { Face } from "./bits";
import { QuietLines } from "./ChatPanel";
import { ModelChoices } from "./ModelChoices";

const DEFAULT_NAME = "Po";
const DEFAULT_MODEL = "claude-opus-5-5";

export function FirstRun() {
  const [name, setName] = useState(DEFAULT_NAME);
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const allModels = useAppState((s) => s.models);
  const status = useAppState((s) => s.status);
  // While Codex is not ready, no GPT model is offered; one quiet line under the choices says why.
  const models = offeredModels(allModels, status);
  const codexProblem = !codexReady(status) ? status?.codex?.problem : undefined;
  // The list can arrive or change while the screen is open: a choice no longer offered falls back.
  const model = picked && models.some((m) => m.id === picked) ? picked : models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id;
  const chosen = models.find((m) => m.id === model);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const create = () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    createBot({ name: value, ...(chosen ? { model: chosen.id, effort: chosen.defaultEffort } : {}), welcome: true }).catch((e: unknown) => {
      setBusy(false);
      setError(messageOf(e));
    });
  };

  return (
    <div className="app-first">
      <div className="app-first-drag" />
      <main className="app-first-body pb-arrive">
        <Face look={{ eyes: "tall", gap: "mid" }} size="xl" />
        <h1 className="display app-first-title">Welcome to Pobots</h1>
        <p className="app-first-text">Start with your main bot. It looks after your other bots, makes new ones with you, and first gets to know you a little.</p>
        <form
          className="app-first-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <div className="pb-field app-first-field">
            <label className="pb-label" htmlFor="first-name">
              Name your main bot
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
          {models.length > 0 && model && (
            <div className="pb-field app-first-field">
              <span className="pb-label" id="first-model">
                Model
              </span>
              <ModelChoices models={models} value={model} onPick={(id) => !busy && setPicked(id)} labelledBy="first-model" />
              {codexProblem && <span className="pb-hint">{codexProblem}</span>}
            </div>
          )}
          <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || !name.trim()}>
            Create main bot
          </button>
        </form>
        <div className="app-first-lines">
          <QuietLines />
        </div>
      </main>
    </div>
  );
}
