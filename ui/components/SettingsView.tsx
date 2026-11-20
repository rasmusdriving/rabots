// The Settings tab: name, purpose, face, model and effort, access level, who the bot may message,
// what is always allowed, and retiring the bot. Changes save as they are made; each field says
// "Saved" quietly for a moment. There is no page-wide save button.
import { AheadBotSetting } from "./ahead/AheadBotSetting";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ACCESS_LEVELS, EYE_GAPS, EYE_SHAPES, type AccessLevel, type Bot, type BotLook, type Effort, type FollowUp, type SavedRule } from "../../shared/protocol";
import { EngineError, messageOf } from "../engine/types";
import { forgetRule, listRules, retireBot, setBotFollowUp, startFresh, updateBot } from "../state/actions";
import { FOLLOW_UPS } from "../lib/steer";
import { useAppState } from "../state/store";
import { SAVED_MS, useSaver, type SaveState } from "../lib/hooks";
import { useOnCross } from "../lib/carry";
import { EFFORT_WORD, sessionFacts } from "../lib/words";
import { CHANGE_LINE, CHANGE_REFUSED, RUNS_ON_CODEX, codexReady, crossesHarness, offeredModels } from "../lib/models";
import { FastField } from "./FastSwitch";
import { ModelChoices } from "./ModelChoices";
import { CheckIcon, Face } from "./bits";
import { ColorPicker } from "./ColorPicker";
import { Confirm } from "./Dialog";
import { SeesSetting } from "./SeesSetting";
import { SteerSetting } from "./SteerSetting";
import { VacationSetting } from "./VacationControls";
import { CalendarSetting } from "./CalendarSetting";

export function SettingsView({ bot }: { bot: Bot }) {
  return (
    <div className="app-view pb-main-scroll app-settings">
      <div className="pb-settings">
        <section className="pb-section" aria-labelledby={`set-${bot.id}-about`}>
          <h2 className="pb-section-title" id={`set-${bot.id}-about`}>
            About
          </h2>
          <TextSetting
            bot={bot}
            field="name"
            label="Name"
            hint="Shown in the roster and when it messages other bots."
            required
          />
          <TextSetting bot={bot} field="purpose" label="Purpose" hint={`One line for you and the other bots about what ${bot.name} is for.`} placeholder="What it is for" />
        </section>
        <FaceSetting bot={bot} />
        <ColorSetting bot={bot} />
        <ModelSetting bot={bot} />
        <MemorySetting bot={bot} />
        <AccessSetting bot={bot} />
        <FollowUpSetting bot={bot} />
        <PeersSetting bot={bot} />
        <SteerSetting bot={bot} />
        <CalendarSetting bot={bot} />
        <AheadBotSetting bot={bot} />
        <RulesSetting bot={bot} />
        <SeesSetting bot={bot} />
        <VacationSetting key={bot.id} bot={bot} />
        <RetireSetting bot={bot} />
      </div>
    </div>
  );
}

/** The quiet word beside a field: "Saved" for a moment, or what went wrong. */
function SavedWord({ state }: { state: SaveState }) {
  if (state.phase === "error")
    return (
      <span className="pb-saved app-hint-error" role="alert">
        {state.message}
      </span>
    );
  // The word stays in place and fades; it is only read out while it shows.
  const show = state.phase === "saved";
  return (
    <span className="pb-saved" role="status" data-show={show || undefined} aria-hidden={!show || undefined}>
      Saved
    </span>
  );
}

export function SectionHead({ id, title, state }: { id: string; title: string; state?: SaveState }) {
  return (
    <div className="pb-section-head">
      <h2 className="pb-section-title" id={id}>
        {title}
      </h2>
      {state && <SavedWord state={state} />}
    </div>
  );
}

// A name or purpose being typed when the window crossed between the layouts is saved then, as when
// the field is left (lib/carry.ts). The field it was typed in is gone by the time the save ends, so
// what was typed and how its save goes are kept here, under the bot and the field, until it is
// saved: the field in the other layout shows the text, and "Saved" or what went wrong, as its own.
interface Crossing {
  value: string;
  state: SaveState;
}
const crossings = new Map<string, Crossing>();
const crossWatchers = new Set<() => void>();
function setCrossing(key: string, c: Crossing | undefined): void {
  if (c) crossings.set(key, c);
  else crossings.delete(key);
  for (const w of crossWatchers) w();
}

function saveAcross(key: string, botId: string, field: "name" | "purpose", value: string): void {
  const mine: Crossing = { value, state: { phase: "saving" } };
  setCrossing(key, mine);
  updateBot(botId, { [field]: value }).then(
    () => {
      if (crossings.get(key) !== mine) return;
      const done: Crossing = { value, state: { phase: "saved" } };
      setCrossing(key, done);
      setTimeout(() => crossings.get(key) === done && setCrossing(key, undefined), SAVED_MS);
    },
    (e: unknown) => {
      if (crossings.get(key) === mine) setCrossing(key, { value, state: { phase: "error", message: messageOf(e) } });
    },
  );
}

function TextSetting({ bot, field, label, hint, placeholder, required }: { bot: Bot; field: "name" | "purpose"; label: string; hint: string; placeholder?: string; required?: boolean }) {
  const key = `${bot.id}:${field}`;
  const [value, setValue] = useState(() => crossings.get(key)?.value ?? bot[field]);
  const [state, save] = useSaver();
  /** A save started as the window crossed, until a moment after it is saved (see above). */
  const [held, setHeld] = useState(() => crossings.get(key));
  const focused = useRef(false);
  const id = `set-${bot.id}-${field}`;

  // Follow changes made elsewhere (a rename in the head) while not typing here, and not while text
  // typed before the window crossed is not saved yet.
  useEffect(() => {
    const c = crossings.get(key);
    if (!focused.current && (!c || c.state.phase === "saved")) setValue(bot[field]);
  }, [bot, field, key]);

  // The save started as the window crossed: its text, and how it goes. (The field that started it
  // went just before this one came, so it is read here, after both.)
  useEffect(() => {
    const watch = () => {
      const c = crossings.get(key);
      setHeld(c);
      if (c && c.state.phase !== "saved" && !focused.current) setValue(c.value);
    };
    crossWatchers.add(watch);
    watch();
    return () => {
      crossWatchers.delete(watch);
    };
  }, [key]);

  /** A save of this field's own: the one started as the window crossed is no longer followed. */
  const letGo = () => {
    if (crossings.has(key)) setCrossing(key, undefined);
  };
  const commit = () => {
    letGo();
    const next = value.trim();
    if (next === bot[field]) return setValue(next);
    if (required && !next) return setValue(bot[field]);
    void save(() => updateBot(bot.id, { [field]: next }));
  };
  // The field saves when it is left; the window crossing between the layouts leaves it too.
  useOnCross(() => {
    if (!focused.current) return;
    const next = value.trim();
    if (next === bot[field] || (required && !next)) return;
    saveAcross(key, bot.id, field, next);
  });

  return (
    <div className="pb-field">
      <div className="pb-label-row">
        <label className="pb-label" htmlFor={id}>
          {label}
        </label>
        <SavedWord state={held?.state ?? state} />
      </div>
      <input
        id={id}
        className="pb-input"
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={field === "name" ? 60 : 160}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            letGo();
            setValue(bot[field]);
          }
        }}
      />
      <span className="pb-hint" id={`${id}-hint`}>
        {hint}
      </span>
    </div>
  );
}

/** Arrow keys move the choice in a radio group, as in any radio group. */
export function radioKeys(e: KeyboardEvent<HTMLElement>, count: number, at: number, pick: (i: number) => void, columns = count) {
  const step =
    e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? columns : e.key === "ArrowUp" ? -columns : 0;
  if (!step) return;
  e.preventDefault();
  const next = (at + step + count) % count;
  pick(next);
  const buttons = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  buttons[next]?.focus();
}

const EYE_WORD: Record<BotLook["eyes"], string> = { round: "Round eyes", tall: "Tall eyes", wide: "Wide eyes", square: "Square eyes" };
const GAP_WORD: Record<BotLook["gap"], string> = { near: "close together", mid: "normal spacing", far: "far apart" };

function FaceSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const looks: BotLook[] = EYE_GAPS.flatMap((gap) => EYE_SHAPES.map((eyes) => ({ eyes, gap })));
  const at = looks.findIndex((l) => l.eyes === bot.look.eyes && l.gap === bot.look.gap);
  const pick = (i: number) => {
    const look = looks[i]!;
    if (i !== at) void save(() => updateBot(bot.id, { look }));
  };
  const id = `set-${bot.id}-face`;
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Face" state={state} />
      <div className="pb-faces" role="radiogroup" aria-labelledby={id} onKeyDown={(e) => radioKeys(e, looks.length, Math.max(0, at), pick, EYE_SHAPES.length)}>
        {looks.map((look, i) => (
          <button
            key={`${look.eyes}-${look.gap}`}
            className="pb-face-pick"
            type="button"
            role="radio"
            aria-checked={i === at}
            tabIndex={i === Math.max(0, at) ? 0 : -1}
            aria-label={`${EYE_WORD[look.eyes]}, ${GAP_WORD[look.gap]}`}
            title={`${EYE_WORD[look.eyes]}, ${GAP_WORD[look.gap]}`}
            onClick={() => pick(i)}
          >
            <Face look={{ ...look, color: bot.look.color }} />
          </button>
        ))}
      </div>
    </section>
  );
}

/** The colour of the bot's face (step 7a). The eyes stay as they are. */
function ColorSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const id = `set-${bot.id}-color`;
  const value = bot.look.color ?? "grey";
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Colour" state={state} />
      <ColorPicker look={bot.look} value={value} labelledBy={id} onPick={(color) => color !== value && void save(() => updateBot(bot.id, { look: { eyes: bot.look.eyes, gap: bot.look.gap, color } }))} />
    </section>
  );
}

function ModelSetting({ bot }: { bot: Bot }) {
  const allModels = useAppState((s) => s.models);
  const status = useAppState((s) => s.status);
  const [state, save] = useSaver();
  /** A change between Claude and ChatGPT was chosen while this page is open, and not refused. */
  const [crossed, setCrossed] = useState(false);
  /** Why the engine refused the last change between the two, shown in the line's box. */
  const [refused, setRefused] = useState<string>();
  // While Codex is not ready no GPT model is offered, except the one the bot is on now.
  const models = offeredModels(allModels, status, bot.model);
  const model = allModels.find((m) => m.id === bot.model);
  const id = `set-${bot.id}-model`;
  const setModel = (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    if (!m || m.id === bot.model) return;
    const effort: Effort = m.efforts.includes(bot.effort) ? bot.effort : m.defaultEffort;
    setRefused(undefined);
    if (!crossesHarness(allModels, bot, m.id)) return void save(() => updateBot(bot.id, { model: m.id, effort }));
    // A change between the groups: the line comes at the moment of choosing, the change saves at
    // once as every setting here, and a refusal takes the line's place under the choices. It is not
    // said beside the title, where a long sentence could wrap and move the page.
    setCrossed(true);
    updateBot(bot.id, { model: m.id, effort }).then(
      () => void save(() => Promise.resolve()),
      (e: unknown) => {
        setCrossed(false);
        setRefused(e instanceof EngineError && e.code === "conflict" ? CHANGE_REFUSED : messageOf(e));
      },
    );
  };
  const setEffort = (effort: Effort) => {
    if (effort !== bot.effort) void save(() => updateBot(bot.id, { effort }));
  };
  // Fast mode (step 3b): saved at once, "Saved" beside the title as for effort. The switch stands on
  // its own line under the efforts, keeping its room whenever a model offered here has a fast mode,
  // and shows only while the bot's model has one. A refusal takes the line's place under the choices,
  // like a refused change of model: beside the title a sentence can wrap in a narrow column and move
  // the page.
  const setFast = (fast: boolean) => {
    setRefused(undefined);
    updateBot(bot.id, { fast }).then(
      () => void save(() => Promise.resolve()),
      (e: unknown) => setRefused(messageOf(e)),
    );
  };
  const fastModels = models.filter((m) => m.fast);
  // One quiet line under the choices, in a box that keeps its height whichever line it shows (or
  // none), so nothing below moves when it changes: a change between the groups just chosen; else
  // why ChatGPT is not offered; else, for a bot on a GPT model, which program runs it.
  const problem = !codexReady(status) ? status?.codex?.problem : undefined;
  const lines = [...new Set([CHANGE_LINE, CHANGE_REFUSED, ...(refused ? [refused] : []), ...(problem ? [problem] : []), RUNS_ON_CODEX])];
  const shown = refused ?? (crossed ? CHANGE_LINE : problem ? problem : bot.harness === "codex" ? RUNS_ON_CODEX : undefined);
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Model and effort" state={state} />
      <ModelChoices models={models} value={bot.model} onPick={setModel} current={bot.harness} />
      <div className="pb-effort-line">
        <div className="pb-seg app-seg-wrap" role="group" aria-label="Effort">
          {(model?.efforts ?? [bot.effort]).map((effort) => (
            <button key={effort} type="button" aria-pressed={effort === bot.effort} onClick={() => setEffort(effort)}>
              {EFFORT_WORD[effort]}
            </button>
          ))}
        </div>
        {fastModels.length > 0 && (
          <FastField
            on={bot.fast !== false}
            shown={!!model?.fast}
            hint={model?.fast ? model.fastHint : undefined}
            hints={fastModels.flatMap((m) => (m.fastHint ? [m.fastHint] : []))}
            onChange={setFast}
          />
        )}
      </div>
      <span className="pb-hint">More effort thinks longer and costs more. The change applies from the next turn.</span>
      <div className="pb-model-note" role="status">
        {lines.map((line) => (
          <span
            key={line}
            className={`pb-hint pb-model-note-line${line === refused ? " app-hint-error" : ""}`}
            data-show={line === shown || undefined}
            aria-hidden={line !== shown || undefined}
          >
            {line}
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * Working memory: how full the session behind the chat is, and "Start fresh now". The timing of
 * fresh starts lives in the engine's config, not here. Nothing to watch: no meter, just words.
 */
function MemorySetting({ bot }: { bot: Bot }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [nothing, setNothing] = useState(false);
  const id = `set-${bot.id}-memory`;
  const tidying = !!bot.context?.tidying;
  // While the bot is in a turn (a card it waits on counts), tidying or has helpers working, the engine would refuse.
  const helpers = bot.helpers ?? 0;
  const hint = bot.vacationSince ? "Bring this bot back before starting fresh." : tidying
    ? `${bot.name} is writing down what matters.`
    : helpers > 0
      ? helpers === 1
        ? `${bot.name}'s helper is working. Try again when it is done.`
        : `${bot.name}'s helpers are working. Try again when they are done.`
      : bot.state === "waiting" && !bot.atRest
      ? `${bot.name} is waiting for you. Try again once that is answered.`
      : bot.state === "thinking" || bot.state === "working"
        ? `${bot.name} is working. Try again when it is done.`
        : undefined;

  const ask = () => {
    if (hint) return;
    setError(undefined);
    setNothing(false);
    setAsking(true);
  };
  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await startFresh(bot.id);
      setAsking(false);
      setNothing(!started);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pb-section" aria-labelledby={id}>
      <div className="pb-section-head">
        <h2 className="pb-section-title" id={id}>
          Working memory
        </h2>
        <span className="pb-saved" role="status" data-show={nothing || undefined} aria-hidden={!nothing || undefined}>
          {nothing ? "There is nothing to tidy yet." : ""}
        </span>
      </div>
      <p className="pb-section-text">{`${bot.name} keeps one chat with you for good. What ${bot.name} can keep in mind at once is limited, so at calm moments ${bot.name} writes down what matters and starts fresh. This shows how much is in mind now. At 100% ${bot.name} starts fresh by itself.`}</p>
      <p className="pb-memory-facts">{sessionFacts(bot.context)}</p>
      <div className="pb-memory-act">
        <button className="pb-btn pb-btn-sm" type="button" aria-disabled={hint ? true : undefined} aria-describedby={hint ? `${id}-hint` : undefined} onClick={ask}>
          Start fresh now
        </button>
        {hint && (
          <span className="pb-hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </div>
      {asking && (
        <Confirm
          title="Start fresh now?"
          text={`${bot.name} first writes down what matters, then its next message starts in a fresh session. The chat stays as it is.`}
          yes="Start fresh"
          no="Cancel"
          busy={busy}
          error={error}
          onYes={() => void start()}
          onNo={() => setAsking(false)}
        />
      )}
    </section>
  );
}

function AccessSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const id = `set-${bot.id}-access`;
  const at = ACCESS_LEVELS.findIndex((a) => a.id === bot.access);
  const pick = (i: number) => {
    const level: AccessLevel = ACCESS_LEVELS[i]!.id;
    if (level !== bot.access) void save(() => updateBot(bot.id, { access: level }));
  };
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Access" state={state} />
      <div className="pb-choices" role="radiogroup" aria-labelledby={id} onKeyDown={(e) => radioKeys(e, ACCESS_LEVELS.length, Math.max(0, at), pick, 1)}>
        {ACCESS_LEVELS.map((a, i) => (
          <button
            key={a.id}
            className="pb-choice"
            type="button"
            role="radio"
            aria-checked={a.id === bot.access}
            tabIndex={i === Math.max(0, at) ? 0 : -1}
            onClick={() => pick(i)}
          >
            <span className="pb-choice-label">{a.label}</span>
            <span className="pb-choice-hint">{a.hint}</span>
            {a.id === bot.access && <CheckIcon />}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Step 7b: "When Kaja is working": the bot's own choice for a message sent while it works, or the
 * Pobots default (named with what it is now). Saves at once, like Access.
 */
function FollowUpSetting({ bot }: { bot: Bot }) {
  const [state, save] = useSaver();
  const def = useAppState((s) => s.chat.followUp);
  const id = `set-${bot.id}-followup`;
  const choices: { id: FollowUp | "default"; label: string; hint: string }[] = [
    { id: "default", label: `Pobots default (${def === "steer" ? "Steer" : "Queue"})`, hint: "As set for all bots in Settings, General." },
    ...FOLLOW_UPS.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
  ];
  const now = bot.followUp ?? "default";
  const at = Math.max(0, choices.findIndex((c) => c.id === now));
  const pick = (i: number) => {
    const next = choices[i]!.id;
    if (next !== now) void save(() => setBotFollowUp(bot.id, next === "default" ? null : next));
  };
  return (
    <section className="pb-section pb-bot-followup" aria-labelledby={id}>
      <SectionHead id={id} title={`When ${bot.name} is working`} state={state} />
      <p className="pb-section-text">{`What happens to a message you send while ${bot.name} is in the middle of something.`}</p>
      <div className="pb-choices" role="radiogroup" aria-labelledby={id} onKeyDown={(e) => radioKeys(e, choices.length, at, pick, 1)}>
        {choices.map((c, i) => (
          <button key={c.id} className="pb-choice" type="button" role="radio" data-follow={c.id} aria-checked={c.id === now} tabIndex={i === at ? 0 : -1} onClick={() => pick(i)}>
            <span className="pb-choice-label">{c.label}</span>
            <span className="pb-choice-hint">{c.hint}</span>
            {c.id === now && <CheckIcon />}
          </button>
        ))}
      </div>
    </section>
  );
}

function PeersSetting({ bot }: { bot: Bot }) {
  const bots = useAppState((s) => s.bots);
  const [state, save] = useSaver();
  const id = `set-${bot.id}-peers`;
  const others = bots.filter((b) => b.id !== bot.id);
  const toggle = (peer: Bot, on: boolean) => {
    const next = on ? [...new Set([...bot.mayMessage, peer.id])] : bot.mayMessage.filter((x) => x !== peer.id);
    void save(() => updateBot(bot.id, { mayMessage: next }));
  };
  let body: ReactNode;
  if (bot.role === "main") body = <p className="pb-section-text">{`${bot.name} is the main bot, so it may message every bot.`}</p>;
  else if (others.length === 0) body = <p className="pb-section-text">There are no other bots yet.</p>;
  else
    body = (
      <ul className="pb-peers">
        {others.map((peer) => (
          <li key={peer.id} className="pb-peer">
            <Face look={peer.look} size="sm" />
            <span className="pb-peer-text">
              <span className="pb-peer-name">{peer.name}</span>
              {peer.purpose && <span className="pb-peer-line">{peer.purpose}</span>}
            </span>
            {peer.role === "main" ? (
              <span className="pb-peer-always">Always</span>
            ) : (
              <input
                className="pb-switch"
                type="checkbox"
                role="switch"
                checked={bot.mayMessage.includes(peer.id)}
                aria-label={`May message ${peer.name}`}
                onChange={(e) => toggle(peer, e.target.checked)}
              />
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="May message" state={state} />
      {body}
      {bot.role !== "main" && others.length > 0 && <span className="pb-hint">Every bot may message the main bot. Messages from bots are information; they never approve anything.</span>}
    </section>
  );
}

function RulesSetting({ bot }: { bot: Bot }) {
  const [rules, setRules] = useState<SavedRule[] | null>(null);
  const [error, setError] = useState<string>();
  const [state, save] = useSaver();
  const id = `set-${bot.id}-rules`;
  // "Always allow" in the rail, or another window forgetting one, changes the list: read it again.
  const tick = useAppState((s) => s.rulesTicks[bot.id] ?? 0);

  useEffect(() => {
    listRules(bot.id).then(setRules, (e: unknown) => setError(messageOf(e)));
  }, [bot.id, tick]);

  const forget = (rule: SavedRule) =>
    void save(async () => {
      await forgetRule(rule.id);
      setRules((r) => (r ?? []).filter((x) => x.id !== rule.id));
    });

  return (
    <section className="pb-section" aria-labelledby={id}>
      <SectionHead id={id} title="Always allowed" state={state} />
      {error && <p className="pb-hint app-hint-error">{error}</p>}
      {rules && rules.length === 0 && <p className="pb-section-text">{`Nothing is always allowed. ${bot.name} asks each time.`}</p>}
      {rules && rules.length > 0 && (
        <ul className="pb-rules">
          {rules.map((rule) => (
            <li key={rule.id} className="pb-rule">
              <span className="pb-rule-text">
                <span className="pb-rule-label">{rule.label}</span>
                {rule.detail && <span className="pb-rule-detail">{rule.detail}</span>}
              </span>
              <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" aria-label={`Forget: ${rule.label}`} onClick={() => forget(rule)}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      {rules && rules.length > 0 && <span className="pb-hint">After you forget a rule, {bot.name} asks again next time.</span>}
    </section>
  );
}

function RetireSetting({ bot }: { bot: Bot }) {
  const count = useAppState((s) => s.bots.length);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = `set-${bot.id}-retire`;
  const locked = bot.role === "main" && count > 1;

  const retire = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await retireBot(bot.id);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <section className="pb-section pb-section-last" aria-labelledby={id}>
      <h2 className="pb-section-title" id={id}>
        Retire this bot
      </h2>
      <p className="pb-section-text">
        {locked
          ? "The main bot can only be retired when it is the last bot."
          : `${bot.name} stops and leaves the roster. Its folder is archived and its chat is kept.`}
      </p>
      <div>
        <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" disabled={locked} onClick={() => setAsking(true)}>
          {`Retire ${bot.name}`}
        </button>
      </div>
      {asking && (
        <Confirm
          title={`Retire ${bot.name}?`}
          text={`${bot.name} stops and leaves the roster. Its folder is archived and its chat is kept. Other bots can no longer message it.`}
          yes={`Retire ${bot.name}`}
          no="Keep it"
          tone="danger"
          busy={busy}
          error={error}
          onYes={() => void retire()}
          onNo={() => setAsking(false)}
        />
      )}
    </section>
  );
}
