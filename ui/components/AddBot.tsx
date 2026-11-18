// The sheet for adding a bot: name, purpose (one line), what its job is (a few sentences), model
// effort (the chosen model's, its default first, following the model), the switch "Fast" beside it
// for a model with a fast mode (on by default, step 3b) and access level with the defaults filled
// in. "Create bot" creates it and opens its chat.
import { useState } from "react";
import { ACCESS_LEVELS, type AccessLevel, type BotColor, type Effort } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { createBot } from "../state/actions";
import { store, useAppState } from "../state/store";
import { EFFORT_WORD, accessHint } from "../lib/words";
import { codexReady, offeredModels } from "../lib/models";
import { carried, useCarry } from "../lib/carry";
import { Dialog } from "./Dialog";
import { FastField } from "./FastSwitch";
import { ModelChoices } from "./ModelChoices";
import { ColorPicker, nextColor, nextLook } from "./ColorPicker";

const DEFAULT_MODEL = "claude-opus-5-5";
const CARRY = "add-bot";
interface AddBotFields {
  name: string;
  purpose: string;
  job: string;
  model: string;
  effort: Effort;
  fast: boolean;
  access: AccessLevel;
  color?: BotColor;
}

export function AddBotSheet() {
  const allModels = useAppState((s) => s.models);
  const status = useAppState((s) => s.status);
  // While Codex is not ready, no GPT model is offered; one quiet line under the choices says why.
  const models = offeredModels(allModels, status);
  const codexProblem = !codexReady(status) ? status?.codex?.problem : undefined;
  // What was filled in comes back when the window crosses between the layouts (lib/carry.ts).
  const [from] = useState(() => carried<AddBotFields>(CARRY));
  const [name, setName] = useState(from?.name ?? "");
  const [purpose, setPurpose] = useState(from?.purpose ?? "");
  const [job, setJob] = useState(from?.job ?? "");
  const [model, setModel] = useState(() => from?.model ?? (models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : (models[0]?.id ?? DEFAULT_MODEL)));
  const [effort, setEffort] = useState<Effort>(() => from?.effort ?? models.find((m) => m.id === model)?.defaultEffort ?? "medium");
  const [fast, setFast] = useState(from?.fast ?? true);
  const [access, setAccess] = useState<AccessLevel>(from?.access ?? "asks-first");
  // The colour of its face (step 7a): the one the engine would pick, unless another is chosen.
  const bots = useAppState((s) => s.bots);
  const [look] = useState(() => nextLook(bots));
  const [color, setColor] = useState<BotColor>(() => from?.color ?? nextColor(bots));
  useCarry(CARRY, { name, purpose, job, model, effort, fast, access, color } satisfies AddBotFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => store.setAdding(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await createBot({
        name: name.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(job.trim() ? { job: job.trim() } : {}),
        model,
        effort,
        fast,
        access,
        look: { ...look, color },
      });
      close();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  // The effort follows the model: an effort the new model lacks falls back to its default.
  const chosen = models.find((m) => m.id === model);
  const pickModel = (id: string) => {
    setModel(id);
    const m = models.find((x) => x.id === id);
    if (m && !m.efforts.includes(effort)) setEffort(m.defaultEffort);
  };
  // The row keeps its height whatever the model: under it, out of sight, stand every effort any
  // offered model has, so the box is always as tall as the longest row can be.
  const allEfforts = (Object.keys(EFFORT_WORD) as Effort[]).filter((e) => models.some((m) => m.efforts.includes(e)));
  // The switch "Fast" keeps its room on the effort's line whenever an offered model has a fast mode;
  // choosing a model without one hides it and keeps the choice made here.
  const fastModels = models.filter((m) => m.fast);

  return (
    <Dialog title="Add a bot" size="sheet" onClose={close}>
      <form
        className="pb-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="pb-field">
          {/* The colour of its face stands on the name's line (step 7a), so the sheet is no taller for it. */}
          <div className="pb-label-row">
            <label className="pb-label" htmlFor="add-name">
              Name
            </label>
            <span className="app-sr" id="add-color">
              Colour
            </span>
            <ColorPicker look={{ ...look, color }} value={color} onPick={setColor} labelledBy="add-color" small />
          </div>
          <input id="add-name" className="pb-input" type="text" value={name} maxLength={60} autoComplete="off" data-autofocus disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="pb-field">
          <label className="pb-label" htmlFor="add-purpose">
            Purpose <span className="pb-label-note">optional</span>
          </label>
          <input id="add-purpose" className="pb-input" type="text" value={purpose} maxLength={160} autoComplete="off" placeholder="What it is for, in one line" disabled={busy} onChange={(e) => setPurpose(e.target.value)} />
        </div>
        <div className="pb-field pb-field-wide">
          <label className="pb-label" htmlFor="add-job">
            Its job <span className="pb-label-note">optional</span>
          </label>
          <textarea id="add-job" className="pb-input pb-textarea" rows={4} value={job} disabled={busy} placeholder="A few sentences about what it does. You can change this later under Job." onChange={(e) => setJob(e.target.value)} />
        </div>
        <div className="pb-field pb-field-wide">
          <span className="pb-label" id="add-model">
            Model
          </span>
          <ModelChoices models={models} value={model} onPick={pickModel} labelledBy="add-model" />
          {codexProblem && <span className="pb-hint">{codexProblem}</span>}
        </div>
        <div className="pb-field pb-field-wide">
          {/* The switch "Fast" stands on the label's line, so the sheet is no taller for it. */}
          <div className="pb-label-row">
            <span className="pb-label" id="add-effort">
              Effort
            </span>
            {fastModels.length > 0 && (
              <FastField
                on={fast}
                shown={!!chosen?.fast}
                hint={chosen?.fast ? chosen.fastHint : undefined}
                hints={fastModels.flatMap((m) => (m.fastHint ? [m.fastHint] : []))}
                onChange={setFast}
              />
            )}
          </div>
          <div className="pb-effort-box">
            <div className="pb-seg app-seg-wrap pb-effort-ghost" aria-hidden="true">
              {allEfforts.map((e) => (
                <button key={e} type="button" tabIndex={-1}>
                  {EFFORT_WORD[e]}
                </button>
              ))}
            </div>
            <div className="pb-seg app-seg-wrap" role="group" aria-labelledby="add-effort">
              {(chosen?.efforts ?? [effort]).map((e) => (
                <button key={e} type="button" aria-pressed={e === effort} onClick={() => setEffort(e)}>
                  {EFFORT_WORD[e]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="pb-field pb-field-wide">
          <span className="pb-label" id="add-access">
            Access
          </span>
          <div className="pb-seg app-seg-wrap" role="group" aria-labelledby="add-access">
            {ACCESS_LEVELS.map((a) => (
              <button key={a.id} type="button" aria-pressed={a.id === access} onClick={() => setAccess(a.id)}>
                {a.label}
              </button>
            ))}
          </div>
          <span className="pb-hint">{accessHint(access)}</span>
        </div>
        {error && (
          <p className="pb-hint app-hint-error" role="alert">
            {error}
          </p>
        )}
        <div className="pb-dialog-actions">
          <button className="pb-btn pb-btn-quiet" type="button" onClick={close}>
            Cancel
          </button>
          <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || !name.trim()}>
            Create bot
          </button>
        </div>
      </form>
    </Dialog>
  );
}
