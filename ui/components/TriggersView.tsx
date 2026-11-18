// The Triggers tab: what wakes a bot by itself. A list of its schedules and webhooks, each a soft row
// with when it runs in plain words, how the last run went, when it runs next and a switch. "New
// trigger" opens a sheet; a trigger opens in place with its runs, its address (a webhook), its
// settings and Remove. A run opens what happened: "Show in chat" for a run in the main chat, or
// the fresh run's own thread, read-only, built from the chat's own message pieces.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bot, Methods, Schedule, Trigger, TriggerRun, Weekday } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { ensureThread, hookAddress, loadOlderRuns, loadRuns, loadTriggers, newHookAddress, removeTrigger, runTriggerNow, saveTrigger, setTriggerOn } from "../state/actions";
import { emptyThread, store, useAppState } from "../state/store";
import { useNow } from "../lib/hooks";
import { carried, useCarry } from "../lib/carry";
import { dateWords, dayLong, dayShort, isoDate, localIso, MIN_EVERY_MINUTES, nextWords, readTime, scheduleSentence, triggerWhen, WEEKDAYS, WORK_DAYS } from "../lib/schedule";
import { whenWord } from "../lib/words";
import { BackIcon, CheckIcon, Mark } from "./bits";
import { HookAddress } from "./Address";
import { Confirm, Dialog } from "./Dialog";
import { radioKeys } from "./SettingsView";
import { ThreadBlocks } from "./Thread";

// ------------------------------------------------------------ words

export const RUN_WORD: Record<TriggerRun["status"], string> = {
  running: "Running",
  done: "Done",
  silent: "Nothing to report",
  skipped: "Skipped",
  failed: "Failed",
};

/** The status mark of a run: the existing marks, nothing new. Silent has no mark. */
export function RunMark({ status }: { status: TriggerRun["status"] }) {
  if (status === "running") return <Mark state="working" />;
  if (status === "done") return <Mark state="check" />;
  if (status === "failed") return <Mark state="blocked" />;
  if (status === "skipped") return <Mark state="idle" />;
  return <span className="pb-mark" aria-hidden="true" />;
}

const WHERE: { id: Trigger["where"]; label: string; hint: (bot: string) => string }[] = [
  { id: "main", label: "In its chat", hint: (bot) => `Runs in ${bot}'s chat, as if you had written it.` },
  { id: "fresh", label: "As a fresh run", hint: () => "A fresh run starts with a clean head and only reports back if there is something to say." },
];

// ------------------------------------------------------------ the tab

export function TriggersView({ bot }: { bot: Bot }) {
  const triggers = useAppState((s) => s.triggers[bot.id]);
  const openId = useAppState((s) => s.openTriggers[bot.id]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Read again each time the tab opens; events keep the list current after that.
    loadTriggers(bot.id).catch((e: unknown) => setError(messageOf(e)));
  }, [bot.id]);

  const open = triggers?.find((t) => t.id === openId);
  return (
    <div className="app-view pb-main-scroll app-triggers" key={open?.id ?? "list"}>
      {open ? <TriggerPage bot={bot} trigger={open} /> : <TriggerList bot={bot} triggers={triggers} error={error} />}
    </div>
  );
}

function TriggerList({ bot, triggers, error }: { bot: Bot; triggers: Trigger[] | undefined; error?: string }) {
  // Open again when the window crossed between the layouts with the sheet open (lib/carry.ts).
  const [adding, setAdding] = useState(() => carried(newTriggerKey(bot.id)) !== undefined);
  const now = useNow(30_000);
  return (
    <div className="app-triggers-inner">
      <div className="pb-triggers-bar">
        <p className="pb-section-text">{`What wakes ${bot.name} by itself.`}</p>
        <button className="pb-btn pb-btn-sm app-new-trigger" type="button" onClick={() => setAdding(true)}>
          New trigger
        </button>
      </div>
      {error && <p className="pb-hint app-hint-error">{error}</p>}
      {triggers && triggers.length === 0 && (
        <p className="pb-files-empty pb-triggers-empty">{`No triggers yet. A trigger wakes ${bot.name} without you: at a time you choose, or when another system calls its address.`}</p>
      )}
      {triggers && triggers.length > 0 && (
        <ul className="pb-triggers" aria-label={`${bot.name}'s triggers`}>
          {triggers.map((t) => (
            <TriggerRow key={t.id} bot={bot} trigger={t} now={now} />
          ))}
        </ul>
      )}
      {adding && <TriggerSheet bot={bot} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** "Done · 07:31 · Next today 16:30". The parts keep their places, so a run finishing changes words only. */
function TriggerMeta({ trigger, now }: { trigger: Trigger; now: number }) {
  const last = trigger.lastRun;
  const next = !trigger.enabled ? "Switched off" : trigger.nextAt ? `Next ${nextWords(trigger.nextAt, new Date(now))}` : trigger.kind === "webhook" ? "Waits for a call" : "";
  return (
    <span className="pb-trigger-meta">
      {last ? (
        <span className="pb-trigger-last" data-status={last.status}>
          <RunMark status={last.status} />
          <span>{RUN_WORD[last.status]}</span>
          <time className="pb-time" dateTime={last.at}>
            {whenWord(last.at, new Date(now))}
          </time>
        </span>
      ) : (
        <span className="pb-trigger-last">Not run yet</span>
      )}
      {next && <span className="pb-trigger-next">{next}</span>}
    </span>
  );
}

function TriggerRow({ bot, trigger, now }: { bot: Bot; trigger: Trigger; now: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = (on: boolean) => {
    setBusy(true);
    setError(undefined);
    setTriggerOn(trigger, on)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <li className="pb-trigger" data-off={!trigger.enabled || undefined}>
      <button className="pb-trigger-open" type="button" onClick={() => store.openTrigger(bot.id, trigger.id)}>
        <span className="pb-trigger-title">
          <span className="pb-trigger-name">{trigger.name}</span>
          {trigger.createdBy === "bot" && <span className="pb-trigger-by">{`Made by ${madeBy(trigger, bot)}`}</span>}
        </span>
        <span className="pb-trigger-when">{triggerWhen(trigger)}</span>
        {error ? <span className="pb-trigger-meta app-hint-error">{error}</span> : <TriggerMeta trigger={trigger} now={now} />}
      </button>
      <input
        className="pb-switch"
        type="checkbox"
        role="switch"
        checked={trigger.enabled}
        disabled={busy}
        aria-label={`${trigger.name} on`}
        title={trigger.enabled ? "On" : "Off"}
        onChange={(e) => toggle(e.target.checked)}
      />
    </li>
  );
}

// ------------------------------------------------------------ the form: one draft for the sheet and the page

type Mode = Schedule["type"];

interface Draft {
  kind: Trigger["kind"];
  name: string;
  prompt: string;
  where: Trigger["where"];
  mode: Mode;
  /** Typed times, read when used. */
  time: string;
  days: Weekday[];
  everyN: string;
  everyUnit: "minutes" | "hours";
  from: string;
  to: string;
  onceDate: string;
  onceTime: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function newDraft(): Draft {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    kind: "schedule",
    name: "",
    prompt: "",
    where: "main",
    mode: "daily",
    time: "07:30",
    days: [...WORK_DAYS],
    everyN: "30",
    everyUnit: "minutes",
    from: "",
    to: "",
    onceDate: isoDate(tomorrow),
    onceTime: "09:00",
  };
}

function draftOf(t: Trigger): Draft {
  const d: Draft = { ...newDraft(), kind: t.kind, name: t.name, prompt: t.prompt, where: t.where };
  const s = t.schedule;
  if (!s) return d;
  d.mode = s.type;
  if (s.type === "daily") Object.assign(d, { time: s.time, days: [...s.days] });
  if (s.type === "every") {
    const hours = s.minutes % 60 === 0;
    Object.assign(d, { everyN: String(hours ? s.minutes / 60 : s.minutes), everyUnit: hours ? "hours" : "minutes", days: [...s.days], from: s.from ?? "", to: s.to ?? "" });
  }
  if (s.type === "once") {
    const at = new Date(s.at);
    Object.assign(d, { onceDate: isoDate(at), onceTime: `${pad(at.getHours())}:${pad(at.getMinutes())}` });
  }
  return d;
}

/** The schedule a draft describes, or the first thing wrong with it in plain words. */
function draftSchedule(d: Draft): { schedule?: Schedule; problem?: string } {
  const timeWord = "Write a time like 07:30.";
  if (d.mode === "daily") {
    const time = readTime(d.time);
    return time ? { schedule: { type: "daily", time, days: d.days } } : { problem: timeWord };
  }
  if (d.mode === "every") {
    const n = Number(d.everyN.trim());
    if (!d.everyN.trim() || !Number.isInteger(n) || n < 1) return { problem: d.everyUnit === "hours" ? "Write a whole number of hours." : "Write a whole number of minutes." };
    const from = d.from.trim() ? readTime(d.from) : undefined;
    const to = d.to.trim() ? readTime(d.to) : undefined;
    if (from === null || to === null) return { problem: timeWord };
    return { schedule: { type: "every", minutes: d.everyUnit === "hours" ? n * 60 : n, days: d.days, ...(from ? { from } : {}), ...(to ? { to } : {}) } };
  }
  const time = readTime(d.onceTime);
  if (!time || !d.onceDate) return { problem: timeWord };
  return { schedule: { type: "once", at: localIso(d.onceDate, time) } };
}

/** The name of the bot that made a trigger: the bot itself, or the main bot for another bot. */
function madeBy(trigger: Trigger, bot: Bot): string {
  if (!trigger.madeByBotId || trigger.madeByBotId === bot.id) return bot.name;
  return store.get().bots.find((b) => b.id === trigger.madeByBotId)?.name ?? "another bot";
}

type SaveParams = Methods["trigger.save"]["params"]["trigger"];

/** Changes part of a draft. A function gets the latest draft, so quick clicks in a row all count. */
type SetDraft = (d: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => void;
const merge = (x: Draft, d: Partial<Draft> | ((d: Draft) => Partial<Draft>)): Draft => ({ ...x, ...(typeof d === "function" ? d(x) : d) });

/** What a draft would save, or why it cannot be saved yet. */
function draftParams(d: Draft, base: { id?: string; enabled: boolean }, now: Date): { params?: SaveParams; problem?: string } {
  if (!d.name.trim()) return { problem: "Give it a name." };
  if (!d.prompt.trim()) return { problem: "Say what the bot is told." };
  const common = { ...(base.id ? { id: base.id } : {}), kind: d.kind, name: d.name.trim(), prompt: d.prompt.trim(), where: d.where, enabled: base.enabled };
  if (d.kind === "webhook") return { params: common };
  const { schedule, problem } = draftSchedule(d);
  if (!schedule) return { problem };
  const said = scheduleSentence(schedule, now);
  // A "once" that already ran and switched itself off may still be renamed; switching it on needs a new time.
  if (said.problem && !(schedule.type === "once" && base.id && !base.enabled)) return { problem: said.text };
  return { params: { ...common, schedule } };
}

function TriggerForm({ bot, draft, set, isNew, idBase, off = false }: { bot: Bot; draft: Draft; set: SetDraft; isNew: boolean; idBase: string; off?: boolean }) {
  const whereAt = WHERE.findIndex((w) => w.id === draft.where);
  return (
    <>
      {isNew && (
        <div className="pb-field pb-field-wide">
          <span className="pb-label" id={`${idBase}-kind`}>
            Kind
          </span>
          <div className="pb-seg" role="group" aria-labelledby={`${idBase}-kind`}>
            <button type="button" aria-pressed={draft.kind === "schedule"} onClick={() => set({ kind: "schedule" })}>
              Schedule
            </button>
            <button type="button" aria-pressed={draft.kind === "webhook"} onClick={() => set({ kind: "webhook" })}>
              Webhook
            </button>
          </div>
          <span className="pb-hint">{draft.kind === "schedule" ? "Runs at the times you choose." : "Runs when another system calls its address, such as a flow in Power Automate."}</span>
        </div>
      )}
      <div className="pb-field pb-field-wide">
        <label className="pb-label" htmlFor={`${idBase}-name`}>
          Name
        </label>
        <input
          id={`${idBase}-name`}
          className="pb-input"
          type="text"
          value={draft.name}
          maxLength={60}
          autoComplete="off"
          placeholder={draft.kind === "schedule" ? "Morning brief" : "New ticket"}
          data-autofocus={isNew || undefined}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="pb-field pb-field-wide">
        <label className="pb-label" htmlFor={`${idBase}-prompt`}>
          {`What ${bot.name} is told`}
        </label>
        <textarea
          id={`${idBase}-prompt`}
          className="pb-input pb-textarea"
          rows={3}
          value={draft.prompt}
          placeholder={draft.kind === "schedule" ? "Read the calendar and write a short plan for today." : "A ticket came in. Link it to the right customer."}
          onChange={(e) => set({ prompt: e.target.value })}
        />
        {draft.kind === "webhook" && <span className="pb-hint">What was sent is added after this, marked as data from outside, never as instructions.</span>}
      </div>
      {draft.kind === "schedule" && <SchedulePicker draft={draft} set={set} idBase={idBase} off={off} />}
      <div className="pb-field pb-field-wide">
        <span className="pb-label" id={`${idBase}-where`}>
          Where it runs
        </span>
        <div className="pb-choices" role="radiogroup" aria-labelledby={`${idBase}-where`} onKeyDown={(e) => radioKeys(e, WHERE.length, Math.max(0, whereAt), (i) => set({ where: WHERE[i]!.id }), 1)}>
          {WHERE.map((w, i) => (
            <button key={w.id} className="pb-choice" type="button" role="radio" aria-checked={w.id === draft.where} tabIndex={i === Math.max(0, whereAt) ? 0 : -1} onClick={() => set({ where: w.id })}>
              <span className="pb-choice-label">{w.label}</span>
              <span className="pb-choice-hint">{w.hint(bot.name)}</span>
              {w.id === draft.where && <CheckIcon />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** A time typed in plain digits; tidied to "07:30" when you leave the field. */
function TimeInput({ id, value, onChange, label, placeholder = "07:30" }: { id: string; value: string; onChange(v: string): void; label?: string; placeholder?: string }) {
  return (
    <input
      id={id}
      className="pb-input pb-time-input"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        const t = readTime(value);
        if (t && t !== value) onChange(t);
      }}
    />
  );
}

function DayToggles({ days, set, idBase }: { days: Weekday[]; set: SetDraft; idBase: string }) {
  const same = (a: Weekday[]) => a.length === days.length && a.every((d) => days.includes(d));
  return (
    <div className="pb-field pb-field-wide">
      <span className="pb-label" id={`${idBase}-days`}>
        Days
      </span>
      <div className="pb-days-row">
        <div className="pb-days" role="group" aria-labelledby={`${idBase}-days`}>
          {WEEKDAYS.map((d) => {
            const on = days.includes(d);
            return (
              <button
                key={d}
                className="pb-day"
                type="button"
                aria-pressed={on}
                aria-label={dayLong(d)}
                onClick={() => set((x) => ({ days: x.days.includes(d) ? x.days.filter((y) => y !== d) : WEEKDAYS.filter((y) => y === d || x.days.includes(y)) }))}
              >
                {dayShort(d)}
              </button>
            );
          })}
        </div>
        <span className="pb-days-quick">
          <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" aria-pressed={same(WORK_DAYS)} onClick={() => set({ days: [...WORK_DAYS] })}>
            Weekdays
          </button>
          <button className="pb-btn pb-btn-sm pb-btn-quiet" type="button" aria-pressed={same(WEEKDAYS)} onClick={() => set({ days: [...WEEKDAYS] })}>
            Every day
          </button>
        </span>
      </div>
    </div>
  );
}

const MODES: { id: Mode; label: string }[] = [
  { id: "daily", label: "At a time" },
  { id: "every", label: "Every" },
  { id: "once", label: "Once" },
];

/** The next 120 days as choices, so a date never needs typing. Keeps a chosen day outside them. */
function dayChoices(chosen: string, now: Date): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let n = 0; n < 120; n++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    out.push({ value: isoDate(d), label: n === 0 ? `Today, ${dateWords(d)}` : n === 1 ? `Tomorrow, ${dateWords(d)}` : dateWords(d) });
  }
  if (chosen && !out.some((o) => o.value === chosen)) {
    const [y, m, d] = chosen.split("-").map(Number);
    out.unshift({ value: chosen, label: dateWords(new Date(y!, m! - 1, d!)) });
  }
  return out;
}

function SchedulePicker({ draft, set, idBase, off }: { draft: Draft; set: SetDraft; idBase: string; off: boolean }) {
  const now = useNow(30_000);
  const built = draftSchedule(draft);
  const said = built.schedule ? scheduleSentence(built.schedule, new Date(now), off) : { text: built.problem ?? "", problem: true };
  const days = useMemo(() => dayChoices(draft.onceDate, new Date(now)), [draft.onceDate, now]);
  return (
    <div className="pb-field pb-field-wide pb-sched">
      <span className="pb-label" id={`${idBase}-when`}>
        When
      </span>
      <div className="pb-seg" role="group" aria-labelledby={`${idBase}-when`}>
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={draft.mode === m.id} onClick={() => set({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      {draft.mode === "daily" && (
        <>
          <div className="pb-sched-row">
            <label className="pb-sched-part">
              <span className="pb-label">Time</span>
              <TimeInput id={`${idBase}-time`} value={draft.time} onChange={(time) => set({ time })} />
            </label>
          </div>
          <DayToggles days={draft.days} set={set} idBase={idBase} />
        </>
      )}
      {draft.mode === "every" && (
        <>
          <div className="pb-sched-row">
            <label className="pb-sched-part">
              <span className="pb-label">Every</span>
              <input
                id={`${idBase}-every`}
                className="pb-input pb-number-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={draft.everyN}
                onChange={(e) => set({ everyN: e.target.value.replace(/[^\d]/g, "") })}
              />
            </label>
            <div className="pb-seg pb-sched-unit" role="group" aria-label="Unit">
              <button type="button" aria-pressed={draft.everyUnit === "minutes"} onClick={() => set({ everyUnit: "minutes" })}>
                Minutes
              </button>
              <button type="button" aria-pressed={draft.everyUnit === "hours"} onClick={() => set({ everyUnit: "hours" })}>
                Hours
              </button>
            </div>
          </div>
          <div className="pb-sched-row">
            <label className="pb-sched-part">
              <span className="pb-label">
                From <span className="pb-label-note">optional</span>
              </span>
              <TimeInput id={`${idBase}-from`} value={draft.from} placeholder="Any time" onChange={(from) => set({ from })} />
            </label>
            <label className="pb-sched-part">
              <span className="pb-label">
                To <span className="pb-label-note">optional</span>
              </span>
              <TimeInput id={`${idBase}-to`} value={draft.to} placeholder="Any time" onChange={(to) => set({ to })} />
            </label>
            <span className="pb-hint pb-sched-hint">{`Leave both empty to run all day. At least ${MIN_EVERY_MINUTES} minutes apart.`}</span>
          </div>
          <DayToggles days={draft.days} set={set} idBase={idBase} />
        </>
      )}
      {draft.mode === "once" && (
        <div className="pb-sched-row">
          <label className="pb-sched-part pb-sched-date">
            <span className="pb-label">Date</span>
            <span className="pb-select">
              <select id={`${idBase}-date`} className="pb-input" value={draft.onceDate} onChange={(e) => set({ onceDate: e.target.value })}>
                {days.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="pb-sched-part">
            <span className="pb-label">Time</span>
            <TimeInput id={`${idBase}-once-time`} value={draft.onceTime} onChange={(onceTime) => set({ onceTime })} />
          </label>
        </div>
      )}
      <p className="pb-sched-say" data-problem={said.problem || undefined} role={said.problem ? "alert" : "status"}>
        {said.text}
      </p>
    </div>
  );
}

// ------------------------------------------------------------ the sheet

/** Where the new trigger's form is kept while the window crosses between the layouts (lib/carry.ts); its being there means the sheet is open. */
const newTriggerKey = (botId: string) => `trigger-new:${botId}`;

function TriggerSheet({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const [draft, setDraft] = useState<Draft>(() => carried<Draft>(newTriggerKey(bot.id)) ?? newDraft());
  useCarry(newTriggerKey(bot.id), draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set: SetDraft = (d) => setDraft((x) => merge(x, d));
  const { params, problem } = draftParams(draft, { enabled: true }, new Date());

  const create = async () => {
    if (!params) return setError(problem);
    setBusy(true);
    setError(undefined);
    try {
      const t = await saveTrigger(bot.id, params);
      onClose();
      store.openTrigger(bot.id, t.id);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New trigger" size="sheet" onClose={onClose} text={`Something that wakes ${bot.name} without you writing.`}>
      <form
        className="pb-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TriggerForm bot={bot} draft={draft} set={set} isNew idBase="new-trigger" />
        {draft.kind === "webhook" && <p className="pb-hint">The address is made when you create it. You can show it on the trigger's page.</p>}
        {error && (
          <p className="pb-hint app-hint-error" role="alert">
            {error}
          </p>
        )}
        <div className="pb-dialog-actions">
          <button className="pb-btn pb-btn-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="pb-btn pb-btn-primary" type="submit" disabled={busy || !params}>
            Create trigger
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------ one trigger

/** The parts of a trigger the form edits, to tell whether the draft changed. */
const editable = (t: Trigger) => JSON.stringify({ name: t.name, prompt: t.prompt, where: t.where, schedule: t.schedule ?? null });

function TriggerPage({ bot, trigger }: { bot: Bot; trigger: Trigger }) {
  const carryKey = `trigger:${trigger.id}`;
  const [draft, setDraft] = useState<Draft>(() => carried<Draft>(carryKey) ?? draftOf(trigger));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const head = useRef<HTMLHeadingElement>(null);
  const now = useNow(30_000);

  const { params, problem } = draftParams(draft, { id: trigger.id, enabled: trigger.enabled }, new Date(now));
  const dirty = params ? editable({ ...trigger, ...params, schedule: params.schedule } as Trigger) !== editable(trigger) : true;
  const changedDraft = JSON.stringify(draft) !== JSON.stringify(draftOf(trigger));
  // A changed form is kept when the window crosses between the layouts (lib/carry.ts).
  useCarry(carryKey, changedDraft ? draft : undefined);

  // Changed elsewhere (the bot with its tool, another window) while nothing is typed here: follow it.
  const seen = useRef(editable(trigger));
  useEffect(() => {
    const now = editable(trigger);
    if (now === seen.current) return;
    seen.current = now;
    if (!changedDraft || !dirty) setDraft(draftOf(trigger));
  }, [trigger, changedDraft, dirty]);

  useEffect(() => head.current?.focus(), []);

  const set: SetDraft = (d) => {
    setSaved(false);
    setDraft((x) => merge(x, d));
  };

  const save = async () => {
    if (!params) return setError(problem);
    setSaving(true);
    setError(undefined);
    try {
      const t = await saveTrigger(bot.id, params);
      seen.current = editable(t);
      setDraft(draftOf(t));
      setSaved(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = () => {
    setRunError(undefined);
    runTriggerNow(trigger.id).catch((e: unknown) => setRunError(messageOf(e)));
  };

  const toggle = (on: boolean) => {
    setToggleError(undefined);
    setTriggerOn(trigger, on).catch((e: unknown) => setToggleError(messageOf(e)));
  };

  const remove = async () => {
    setRemoveError(undefined);
    try {
      await removeTrigger(trigger);
      store.openTrigger(bot.id, null);
    } catch (e) {
      setRemoveError(messageOf(e));
    }
  };

  const nextLine = !trigger.enabled ? "Switched off" : trigger.nextAt ? `Next ${nextWords(trigger.nextAt, new Date(now))}` : trigger.kind === "webhook" ? "Waits for a call" : "";
  const id = `trigger-${trigger.id}`;

  return (
    <div className="pb-trigger-page">
      <div className="pb-trigger-top">
        <div className="pb-trigger-bar">
          <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush app-trigger-back" type="button" onClick={() => store.openTrigger(bot.id, null)}>
            <BackIcon />
            All triggers
          </button>
        </div>
        <header className="pb-trigger-head">
          <div className="pb-trigger-head-text">
            <h2 className="pb-trigger-head-name" ref={head} tabIndex={-1}>
              {trigger.name}
            </h2>
            <p className="pb-trigger-head-when">{[triggerWhen(trigger), nextLine, trigger.createdBy === "bot" ? `Made by ${madeBy(trigger, bot)}` : ""].filter(Boolean).join(" · ")}</p>
          </div>
          <label className="pb-toggle pb-trigger-switch">
            <input className="pb-switch" type="checkbox" role="switch" checked={trigger.enabled} aria-label={`${trigger.name} on`} onChange={(e) => toggle(e.target.checked)} />
            <span>{trigger.enabled ? "On" : "Off"}</span>
          </label>
          <button className="pb-btn pb-btn-sm" type="button" onClick={runNow}>
            Run now
          </button>
        </header>
        {(runError || toggleError) && (
          <p className="pb-hint app-hint-error" role="alert">
            {runError ?? toggleError}
          </p>
        )}
      </div>

      <section className="pb-section" aria-labelledby={`${id}-runs`}>
        <h3 className="pb-section-title" id={`${id}-runs`}>
          Runs
        </h3>
        <RunList bot={bot} trigger={trigger} />
      </section>

      {trigger.kind === "webhook" && (
        <section className="pb-section" aria-labelledby={`${id}-address`}>
          <h3 className="pb-section-title" id={`${id}-address`}>
            Address
          </h3>
          <TriggerAddress bot={bot} trigger={trigger} />
        </section>
      )}

      <section className="pb-section" aria-labelledby={`${id}-settings`}>
        <div className="pb-section-head">
          <h3 className="pb-section-title" id={`${id}-settings`}>
            Settings
          </h3>
          <span className="pb-saved" role="status" data-show={(saved && !changedDraft) || undefined} aria-hidden={!(saved && !changedDraft) || undefined}>
            Saved
          </span>
        </div>
        <form
          className="pb-dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TriggerForm bot={bot} draft={draft} set={set} isNew={false} idBase={id} off={!trigger.enabled} />
          {error && (
            <p className="pb-hint app-hint-error" role="alert">
              {error}
            </p>
          )}
          <div className="pb-card-actions">
            <button className="pb-btn pb-btn-primary" type="submit" disabled={saving || !params || !dirty}>
              Save
            </button>
            {changedDraft && (
              <button className="pb-btn pb-btn-quiet" type="button" onClick={() => setDraft(draftOf(trigger))}>
                Put back
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="pb-section pb-section-last" aria-labelledby={`${id}-remove`}>
        <h3 className="pb-section-title" id={`${id}-remove`}>
          Remove this trigger
        </h3>
        <p className="pb-section-text">{`It stops waking ${bot.name}. What it already did stays in the chat.`}</p>
        <div>
          <button className="pb-btn pb-btn-sm pb-btn-danger" type="button" onClick={() => setRemoving(true)}>
            Remove trigger
          </button>
        </div>
      </section>
      {removing && (
        <Confirm
          title={`Remove ${trigger.name}?`}
          text={`It stops waking ${bot.name}${trigger.kind === "webhook" ? " and its address stops working" : ""}. What it already did stays in the chat.`}
          yes="Remove trigger"
          no="Keep it"
          tone="danger"
          error={removeError}
          onYes={() => void remove()}
          onNo={() => setRemoving(false)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ the address of a webhook

function TriggerAddress({ bot, trigger }: { bot: Bot; trigger: Trigger }) {
  return (
    <HookAddress
      key={trigger.id}
      sentence={`Anyone with this address can wake ${bot.name}. Keep it like a password.`}
      label="Webhook address"
      load={() => hookAddress(trigger.id)}
      renew={() => newHookAddress(trigger.id)}
      example={(url) => `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"text": "Hello"}'`}
      hint={`Send JSON with a POST. What was sent reaches ${bot.name} after what it is told.`}
    />
  );
}

// ------------------------------------------------------------ runs

function RunList({ bot, trigger }: { bot: Bot; trigger: Trigger }) {
  const runs = useAppState((s) => s.runs[trigger.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    loadRuns(trigger.id).catch((e: unknown) => setError(messageOf(e)));
  }, [trigger.id]);

  if (error) return <p className="pb-hint app-hint-error">{error}</p>;
  if (!runs?.loaded) return null;
  if (runs.runs.length === 0) return <p className="pb-section-text">Not run yet. Run now tries it at once.</p>;
  return (
    <>
      <ol className="pb-runs" aria-label={`Runs of ${trigger.name}`}>
        {runs.runs.map((r) => (
          <RunRow key={r.id} bot={bot} run={r} open={openId === r.id} now={now} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
        ))}
      </ol>
      {runs.hasMore && (
        <div>
          <button
            className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush"
            type="button"
            disabled={more}
            onClick={() => {
              setMore(true);
              loadOlderRuns(trigger.id)
                .catch((e: unknown) => setError(messageOf(e)))
                .finally(() => setMore(false));
            }}
          >
            Show earlier runs
          </button>
        </div>
      )}
    </>
  );
}

function runNote(run: TriggerRun): string {
  // The word already says "Nothing to report"; the line says what that meant.
  if (run.status === "silent" && (!run.note || run.note.replace(/[.\s]+$/, "").toLowerCase() === "nothing to report")) return "Nothing was passed on to the chat";
  if (run.note) return run.note;
  if (run.status === "running") return run.turnId ? "On it now" : "Waiting its turn";
  return RUN_WORD[run.status];
}

function RunRow({ bot, run, open, now, onToggle }: { bot: Bot; run: TriggerRun; open: boolean; now: number; onToggle(): void }) {
  const body: ReactNode = (
    <>
      <RunMark status={run.status} />
      <span className="pb-run-text">
        <span className="pb-run-word">{RUN_WORD[run.status]}</span>
        <span className="pb-run-note">{runNote(run)}</span>
      </span>
      <time className="pb-time" dateTime={run.at}>
        {whenWord(run.at, new Date(now))}
      </time>
    </>
  );
  // A run that never started has nothing more to show than its row.
  if (!run.threadId)
    return (
      <li className="pb-run" data-status={run.status}>
        <div className="pb-run-row">{body}</div>
      </li>
    );
  const inMain = run.threadId === bot.mainThreadId;
  const panel = `run-${run.id}`;
  return (
    <li className="pb-run" data-status={run.status}>
      <button className="pb-run-row" type="button" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>
        {body}
      </button>
      {open && (
        <div className="pb-run-open pb-arrive" id={panel}>
          {inMain ? (
            <>
              {run.note && <p className="pb-run-full">{run.note}</p>}
              <div>
                <button className="pb-btn pb-btn-sm pb-btn-quiet pb-btn-flush" type="button" disabled={!run.turnId} onClick={() => run.turnId && store.focusChat(bot.id, run.turnId)}>
                  Show in chat
                </button>
              </div>
            </>
          ) : (
            <RunThread threadId={run.threadId} />
          )}
        </div>
      )}
    </li>
  );
}

/** A fresh run's own thread, read-only, with the chat's own message pieces. */
function RunThread({ threadId }: { threadId: string }) {
  const thread = useAppState((s) => s.threads[threadId] ?? emptyThread);
  const bots = useAppState((s) => s.bots);
  useEffect(() => ensureThread(threadId), [threadId]);
  if (thread.error && !thread.loaded) return <p className="pb-hint app-hint-error">{thread.error}</p>;
  return (
    <div className="pb-run-thread pb-thread" role="log" aria-label="What happened in this run">
      {thread.loaded && thread.items.length === 0 && <p className="pb-hint">Nothing happened in this run yet.</p>}
      <ThreadBlocks items={thread.items} bots={bots} />
    </div>
  );
}
