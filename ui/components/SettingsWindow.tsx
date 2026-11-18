// Step 7b: the sections of the settings window that are new (Chats, Providers, Usage), the update
// dialog behind the round arrow at the foot of the left side, and the words they use. The window
// itself and its General section are in AppSettings.tsx. Follows T3 Code's settings
// (apps/web/src/components/settings/*: Providers, "Usage providers" with "Add hub", "Advanced" with the
// health check interval) and its usage view (apps/web/src/components/usage/UsageLimitsPooled.tsx: per
// provider and window the % left in big, a bar per account, the reset time).
import { useEffect, useState, type ReactNode } from "react";
import type { ChatTimingKey, Harness, ModelInfo, ProviderId, ProviderState, ProvidersState, UsageAccount, UsageProvider, UsageWindow } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { useNow, useSaver, type SaveState } from "../lib/hooks";
import { groupModels, offeredModels } from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { clockTime } from "../lib/words";
import { addUsageHub, checkProviders, readUsage, removeUsageHub, setSettings, updateProviders } from "../state/actions";
import { useAppState } from "../state/store";
import { Dialog } from "./Dialog";
import { Mark } from "./bits";

// ------------------------------------------------------------ small pieces

function SavedWord({ state }: { state: SaveState }) {
  const show = state.phase === "saved";
  return (
    <span className="pb-saved" role="status" data-show={show || undefined} aria-hidden={!show || undefined}>
      Saved
    </span>
  );
}

/** A line under a part that keeps its room, for a refusal from the engine. */
export function ProblemLine({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p className={`pb-hint pb-set7-problem ${className}`.trim()} role={text ? "alert" : undefined}>
      <span className="app-hint-error">{text || " "}</span>
    </p>
  );
}

const num = (n: number) => n.toLocaleString("en-US");
/** A stable empty list for a selector (a new [] each time would make the window draw for ever). */
const NO_HUBS: never[] = [];
const PROVIDER_WORD: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

/** "in 3 h 24 min", "in 5 days", "in 12 min". */
export function resetWords(at: string | undefined, now: number): string {
  if (!at) return "";
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 60_000) return "resets now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `resets in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `resets in ${h} h ${min % 60} min`;
  return `resets in ${Math.round(h / 24)} days`;
}

/** "Checked at 14:02", "Checked 4 minutes ago". */
export function checkedWords(at: string | undefined, now: number): string {
  if (!at) return "Not looked at yet.";
  const ms = now - Date.parse(at);
  if (ms < 60_000) return "Checked just now.";
  if (ms < 60 * 60_000) return `Checked ${Math.round(ms / 60_000)} min ago.`;
  return `Checked at ${clockTime(at)}.`;
}

// ------------------------------------------------------------ Chats

/** The values of the fresh-start timing, in the order shown, with their words and units. */
const TIMING_ROWS: { key: Exclude<ChatTimingKey, "enabled">; label: string; hint: string; unit: string; toShown: (v: number) => number; fromShown: (v: number) => number; step: number; claudeOnly?: boolean }[] = [
  {
    key: "minTokens",
    label: "Worth a fresh start from",
    hint: "A smaller session is left as it is before its cache runs out or after a quiet spell.",
    unit: "tokens",
    toShown: (v) => v,
    fromShown: (v) => Math.round(v),
    step: 10000,
  },
  {
    key: "fullTokens",
    label: "Nearly full at",
    hint: "Right after a turn, a session this big starts fresh at once.",
    unit: "tokens",
    toShown: (v) => v,
    fromShown: (v) => Math.round(v),
    step: 10000,
  },
  {
    key: "fullFraction",
    label: "Or at this share of what the model holds",
    hint: "Whichever of the two comes first.",
    unit: "%",
    toShown: (v) => Math.round(v * 100),
    fromShown: (v) => v / 100,
    step: 5,
  },
  {
    key: "warmMarginMinutes",
    label: "Before the cache runs out",
    hint: "The fresh start begins this long before the session's cache runs out, so the bot reads it cheaply one last time.",
    unit: "minutes",
    toShown: (v) => v,
    fromShown: (v) => v,
    step: 1,
    claudeOnly: true,
  },
  {
    key: "coldHours",
    label: "After a quiet spell of",
    hint: "A session not used for this long starts fresh, cache or not.",
    unit: "hours",
    toShown: (v) => v,
    fromShown: (v) => v,
    step: 1,
  },
];

/**
 * Not a fresh start: the size at which Claude Code or Codex itself summarises a conversation in
 * the middle of work. It is what a helper works under. Shown under the fresh-start values and
 * never dimmed with them, because it holds whether fresh starts are on or off.
 */
const LONG_WORK_ROW: (typeof TIMING_ROWS)[number] = {
  key: "compactTokens",
  label: "Shortened in the middle of work at",
  hint: "A helper, or a bot in one very long task, is summarised by Claude Code or Codex itself at this size and carries on. Bigger keeps more in mind and costs more on every step. Used from a session's next start.",
  unit: "tokens",
  toShown: (v) => v,
  fromShown: (v) => Math.round(v),
  step: 10000,
};

export function ChatsSection() {
  const settings = useAppState((s) => s.settings);
  const [which, setWhich] = useState<ProviderId>("claude");
  if (!settings) return <p className="pb-section-text">Pobots has not said its settings yet.</p>;
  const timing = settings.timing[which];
  const defaults = settings.timingDefaults[which];
  const set = settings.timingSet[which];
  return (
    <>
      <section className="pb-section pb-set7-timing" aria-labelledby="set7-timing">
        <div className="pb-section-head">
          <h2 className="pb-section-title" id="set7-timing">
            When chats start fresh
          </h2>
        </div>
        <p className="pb-section-text">
          Behind each bot's chat is a working session. At calm moments Pobots lets the bot write down what matters and starts the session fresh, so the bot stays quick and clear. The chat you see never
          changes.
        </p>
        <div className="pb-seg pb-set7-which" role="radiogroup" aria-label="For the bots on">
          {(["claude", "codex"] as ProviderId[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={which === p} data-provider={p} onClick={() => setWhich(p)}>
              {p === "claude" ? "Claude bots" : "Codex bots"}
            </button>
          ))}
        </div>
        <EnabledRow which={which} on={timing.enabled} isDefault={!set.includes("enabled")} defaultOn={defaults.enabled} />
        <div className="pb-set7-rows" data-off={!timing.enabled || undefined}>
          {TIMING_ROWS.map((row) => (
            <TimingRow key={`${which}-${row.key}`} which={which} row={row} value={timing[row.key]} def={defaults[row.key]} isDefault={!set.includes(row.key)} />
          ))}
        </div>
        <div className="pb-set7-rows" data-long-work>
          <TimingRow key={`${which}-compactTokens`} which={which} row={LONG_WORK_ROW} value={timing.compactTokens} def={defaults.compactTokens} isDefault={!set.includes("compactTokens")} />
        </div>
      </section>
      <TitleModelSection />
    </>
  );
}

function EnabledRow({ which, on, isDefault, defaultOn }: { which: ProviderId; on: boolean; isDefault: boolean; defaultOn: boolean }) {
  const [state, save] = useSaver();
  const id = `set7-enabled-${which}`;
  return (
    <div className="pb-set7-row pb-set7-enabled">
      <div className="pb-set7-row-text">
        <span className="pb-set7-row-label" id={id}>
          Fresh starts
        </span>
        <span className="pb-set7-row-hint">{`Off: a ${PROVIDER_WORD[which]} bot's session only gets shorter when ${which === "claude" ? "Claude Code" : "Codex"} shortens it by itself.`}</span>
      </div>
      <div className="pb-set7-row-control">
        <SavedWord state={state} />
        <input className="pb-switch" type="checkbox" role="switch" checked={on} aria-labelledby={id} onChange={(e) => void save(() => setSettings({ timing: { [which]: { enabled: e.target.checked } } }))} />
      </div>
      <ResetLine isDefault={isDefault} words={`Default: ${defaultOn ? "on" : "off"}`} onReset={() => void save(() => setSettings({ timing: { [which]: { enabled: null } } }))} />
      <ProblemLine text={state.phase === "error" ? state.message : ""} />
    </div>
  );
}

/** "Default: 100,000 tokens" and, while the value is set apart from it, "Reset". Both keep their room. */
function ResetLine({ isDefault, words, onReset }: { isDefault: boolean; words: string; onReset(): void }) {
  return (
    <div className="pb-set7-reset">
      <span className="pb-set7-default">{isDefault ? `${words} (in use)` : words}</span>
      <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-reset-btn" data-hide={isDefault || undefined} aria-hidden={isDefault || undefined} tabIndex={isDefault ? -1 : 0} onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

function TimingRow({ which, row, value, def, isDefault }: { which: ProviderId; row: (typeof TIMING_ROWS)[number]; value: number; def: number; isDefault: boolean }) {
  const [state, save] = useSaver();
  const shown = row.toShown(value);
  const [text, setText] = useState(String(shown));
  // A change from elsewhere (another window, the main bot) shows here unless he is typing.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(shown));
  }, [shown, editing]);
  const id = `set7-${which}-${row.key}`;
  const na = row.claudeOnly && which === "codex";
  const commit = () => {
    setEditing(false);
    const n = Number(text.replace(/[\s,]/g, ""));
    if (!text.trim() || !Number.isFinite(n)) {
      setText(String(shown));
      return;
    }
    const next = row.fromShown(n);
    if (next === value) return;
    void save(() => setSettings({ timing: { [which]: { [row.key]: next } } })).then((ok) => {
      if (!ok) setText(String(shown));
    });
  };
  const defWords = `Default: ${num(row.toShown(def))}${row.unit === "%" ? "%" : ` ${row.unit}`}`;
  return (
    <div className="pb-set7-row" data-key={row.key} data-na={na || undefined}>
      <div className="pb-set7-row-text">
        <label className="pb-set7-row-label" htmlFor={id}>
          {row.label}
        </label>
        <span className="pb-set7-row-hint">{na ? "Codex does not say how long its cache lives, so this does not apply to Codex bots." : row.hint}</span>
      </div>
      <div className="pb-set7-row-control">
        <SavedWord state={state} />
        <input
          id={id}
          className="pb-input pb-set7-input"
          inputMode="decimal"
          value={text}
          disabled={na}
          aria-describedby={`${id}-unit`}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape" && editing) {
              e.stopPropagation();
              setText(String(shown));
              setEditing(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="pb-set7-unit" id={`${id}-unit`}>
          {row.unit}
        </span>
      </div>
      <ResetLine isDefault={isDefault} words={defWords} onReset={() => void save(() => setSettings({ timing: { [which]: { [row.key]: null } } }))} />
      <ProblemLine text={state.phase === "error" ? state.message : ""} />
    </div>
  );
}

function TitleModelSection() {
  const settings = useAppState((s) => s.settings);
  const allModels = useAppState((s) => s.models);
  const status = useAppState((s) => s.status);
  const [state, save] = useSaver();
  if (!settings) return null;
  // Claude and ChatGPT models, as the bot picker offers them: a GPT model while Codex is ready, and the chosen one always (18 Nov 2026).
  const models = offeredModels(allModels, status, settings.titleModel);
  const known = models.find((m) => m.id === settings.titleModel);
  const list = known ? models : [...models, { id: settings.titleModel, label: settings.titleModel, harness: (/^gpt-/.test(settings.titleModel) ? "codex" : "claude") as Harness, efforts: [], defaultEffort: "low" as const }];
  const groups = groupModels(list);
  const chosen: Harness = list.find((m) => m.id === settings.titleModel)?.harness ?? "claude";
  const provider = PROVIDERS[chosen];
  const options = (ms: ModelInfo[]) =>
    ms.map((m) => (
      <option key={m.id} value={m.id}>
        {m.label}
      </option>
    ));
  return (
    <section className="pb-section pb-set7-titles" aria-labelledby="set7-titles">
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set7-titles">
          Chat titles
        </h2>
        <SavedWord state={state} />
      </div>
      <p className="pb-section-text">
        Each chat gets a short title when it ends or is set aside, so you and your bots can find it later. Pobots sends only the start and the end of the chat, a few thousand tokens at most.
      </p>
      <div className="pb-field">
        <label className="pb-field-label" htmlFor="set7-title-model">
          Made by
        </label>
        <div className="pb-set7-model-row">
          {provider && (
            <span className="pb-helper-mark pb-set7-model-mark" data-provider={chosen} title={provider.name} aria-hidden="true">
              <provider.Mark />
            </span>
          )}
          <select id="set7-title-model" className="pb-input pb-select pb-set7-select" value={settings.titleModel} onChange={(e) => void save(() => setSettings({ titleModel: e.target.value }))}>
            {groups.length > 1
              ? groups.map((g) => (
                  <optgroup key={g.harness} label={g.label}>
                    {options(g.models)}
                  </optgroup>
                ))
              : options(list)}
          </select>
        </div>
        <span className="pb-hint">The default is Haiku 5.5, the cheapest Claude model. A ChatGPT model names chats through Codex, so it uses none of your Claude usage; when Codex cannot, Haiku 5.5 does. Always at low effort.</span>
      </div>
      <ProblemLine text={state.phase === "error" ? state.message : ""} />
    </section>
  );
}

// ------------------------------------------------------------ Providers

const INSTALL_WORDS: Record<ProviderState["installedBy"], string> = {
  native: "Installed with its own installer",
  npm: "Installed with npm",
  homebrew: "Installed with Homebrew",
  other: "Installed in a way Pobots cannot update",
  none: "Not installed",
};

export function ProvidersSection() {
  const providers = useAppState((s) => s.providers);
  const now = useNow(30_000);
  const [checkError, setCheckError] = useState("");
  if (!providers) return <p className="pb-section-text">Pobots has not said how Claude Code and Codex are yet.</p>;
  const check = () => {
    setCheckError("");
    checkProviders().catch((e: unknown) => setCheckError(messageOf(e)));
  };
  return (
    <>
      <section className="pb-section pb-set7-providers" aria-labelledby="set7-providers">
        <div className="pb-section-head">
          <h2 className="pb-section-title" id="set7-providers">
            Providers
          </h2>
        </div>
        <p className="pb-section-text">{`The programs that run your bots' models on ${providers.machine}.`}</p>
        <div className="pb-set7-checked">
          <span className="pb-set7-checked-text" role="status">
            {providers.checking ? "Looking now." : checkedWords(providers.checkedAt, now)}
          </span>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-check" aria-disabled={providers.checking || undefined} onClick={() => !providers.checking && check()}>
            Check now
          </button>
        </div>
        <ProblemLine text={checkError} />
        <ul className="pb-set7-provider-list">
          {providers.providers.map((p) => (
            <li key={p.id}>
              <ProviderCard p={p} running={!!providers.update && !providers.update.endedAt} />
            </li>
          ))}
        </ul>
        <UpdateRunLine providers={providers} />
      </section>
      <HealthSection />
      <HubsSection />
    </>
  );
}

function ProviderCard({ p, running }: { p: ProviderState; running: boolean }) {
  const [state, save] = useSaver();
  const [asking, setAsking] = useState(false);
  const facts = [p.version ? `Version ${p.version}` : "", p.signedIn === true ? "Signed in" : p.signedIn === false ? "Not signed in" : "", INSTALL_WORDS[p.installedBy]].filter(Boolean).join(" · ");
  const latest = !p.enabled ? "Off: not looked at or updated." : p.updateAvailable ? `Version ${p.latest} is out.` : p.latest ? "Up to date." : "The newest version could not be read.";
  const nameId = `set7-prov-${p.id}`;
  return (
    <div className="pb-set7-provider" data-provider={p.id} data-on={p.enabled || undefined}>
      <div className="pb-set7-provider-head">
        <Mark state={!p.enabled ? "idle" : p.ready ? "check" : "blocked"} />
        <span className="pb-set7-provider-name" id={nameId}>
          {p.label}
        </span>
        <SavedWord state={state} />
        <input className="pb-switch" type="checkbox" role="switch" checked={p.enabled} aria-labelledby={nameId} onChange={(e) => void save(() => setSettings({ providers: { [p.id]: { enabled: e.target.checked } } }))} />
      </div>
      <p className="pb-set7-provider-facts">{facts || " "}</p>
      {p.problem && <p className="pb-set7-provider-problem">{p.problem}</p>}
      <div className="pb-set7-provider-update">
        <span className="pb-set7-provider-latest">{latest}</span>
        <button type="button" className="pb-btn pb-btn-sm pb-set7-update" data-hide={!p.updateAvailable || undefined} aria-hidden={!p.updateAvailable || undefined} tabIndex={p.updateAvailable ? 0 : -1} aria-disabled={running || undefined} onClick={() => !running && setAsking(true)}>
          Update
        </button>
      </div>
      {p.executable && (
        <p className="pb-set7-provider-path" title={p.executable}>
          {p.executable}
        </p>
      )}
      <ProblemLine text={state.phase === "error" ? state.message : ""} />
      {asking && <UpdateDialog onClose={() => setAsking(false)} />}
    </div>
  );
}

function UpdateRunLine({ providers }: { providers: ProvidersState }) {
  const run = providers.update;
  if (!run) return null;
  return (
    <p className="pb-set7-run" data-phase={run.phase} role="status">
      <Mark state={run.phase === "done" ? "check" : run.phase === "failed" ? "blocked" : "working"} />
      <span>{run.endedAt ? `Last update, ${clockTime(run.endedAt)}: ${run.line}` : run.line}</span>
    </p>
  );
}

function HealthSection() {
  const settings = useAppState((s) => s.settings);
  const [state, save] = useSaver();
  const value = settings?.healthCheckSeconds ?? 300;
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  if (!settings) return null;
  const commit = () => {
    setEditing(false);
    const n = Number(text.trim());
    if (!text.trim() || !Number.isFinite(n) || n === value) return setText(String(value));
    void save(() => setSettings({ healthCheckSeconds: Math.round(n) })).then((ok) => {
      if (!ok) setText(String(value));
    });
  };
  return (
    <section className="pb-section pb-set7-health" aria-labelledby="set7-health">
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set7-health">
          How often Pobots looks
        </h2>
      </div>
      <div className="pb-set7-row">
        <div className="pb-set7-row-text">
          <label className="pb-set7-row-label" htmlFor="set7-health-input">
            Look at Claude Code and Codex every
          </label>
          <span className="pb-set7-row-hint">Whether they work, their version, and whether an update is out. 0 is never; Check now still works.</span>
        </div>
        <div className="pb-set7-row-control">
          <SavedWord state={state} />
          <input
            id="set7-health-input"
            className="pb-input pb-set7-input"
            inputMode="numeric"
            value={text}
            onFocus={() => setEditing(true)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="pb-set7-unit">seconds</span>
        </div>
        <div className="pb-set7-reset">
          <span className="pb-set7-default">{value === 300 ? "Default: 300 seconds (in use)" : "Default: 300 seconds"}</span>
          <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-reset-btn" data-hide={value === 300 || undefined} aria-hidden={value === 300 || undefined} tabIndex={value === 300 ? -1 : 0} onClick={() => void save(() => setSettings({ healthCheckSeconds: 300 }))}>
            Reset
          </button>
        </div>
        <ProblemLine text={state.phase === "error" ? state.message : ""} />
      </div>
    </section>
  );
}

function HubsSection() {
  const hubs = useAppState((s) => s.settings?.hubs) ?? NO_HUBS;
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, saved] = useSaver();
  const add = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    const ok = await saved(() => addUsageHub(url, key));
    setBusy(false);
    if (ok) {
      setUrl("");
      setKey("");
    }
  };
  useEffect(() => {
    if (state.phase === "error") setError(state.message);
  }, [state]);
  return (
    <section className="pb-section pb-set7-hubs" aria-labelledby="set7-hubs">
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set7-hubs">
          Usage hubs
        </h2>
        <SavedWord state={state} />
      </div>
      <p className="pb-section-text">
        Add your CLIProxyAPI to see the usage of every account it holds. Without a hub, Pobots reads the usage of Claude Code and Codex on this Mac.
      </p>
      {hubs.length > 0 && (
        <ul className="pb-set7-hub-list">
          {hubs.map((h) => (
            <li key={h.id} className="pb-set7-hub">
              <span className="pb-set7-hub-text">
                <span className="pb-set7-hub-url">{h.url}</span>
                <span className="pb-set7-hub-line">{`CLI Proxy · ${h.keyKind === "1password" ? "Key read from 1Password" : "Key kept on this Mac"}`}</span>
              </span>
              <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-hub-remove" aria-label={`Remove ${h.url}`} onClick={() => void saved(() => removeUsageHub(h.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="pb-set7-hub-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="pb-field">
          <label className="pb-field-label" htmlFor="set7-hub-url">
            Hub address
          </label>
          <input id="set7-hub-url" className="pb-input" placeholder="https://host:8443" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="pb-field">
          <label className="pb-field-label" htmlFor="set7-hub-key">
            Management key
          </label>
          <input id="set7-hub-key" className="pb-input" type="password" autoComplete="off" spellCheck={false} placeholder="The key, or op://vault/item/field" value={key} onChange={(e) => setKey(e.target.value)} />
          <span className="pb-hint">Kept only on the Mac, never shown again. An op:// reference is read from 1Password when it is used.</span>
        </div>
        <div className="pb-set7-hub-act">
          <button type="submit" className="pb-btn pb-btn-sm pb-set7-hub-add" aria-disabled={busy || !url.trim() || !key.trim() || undefined}>
            Add hub
          </button>
        </div>
        <ProblemLine text={error} />
      </form>
    </section>
  );
}

// ------------------------------------------------------------ Usage

/** What is left of one window: 100 minus what is used, rounded. */
const left = (w: UsageWindow) => Math.max(0, Math.round(100 - w.usedPercent));

/** The windows of a provider in order, each with every account that reports it (pooled as in T3 Code). */
function poolWindows(p: UsageProvider): { id: string; label: string; members: { account: UsageAccount; window: UsageWindow }[] }[] {
  const out: { id: string; label: string; members: { account: UsageAccount; window: UsageWindow }[] }[] = [];
  for (const a of p.accounts) {
    for (const w of a.windows) {
      let row = out.find((r) => r.id === w.id);
      if (!row) out.push((row = { id: w.id, label: w.label, members: [] }));
      row.members.push({ account: a, window: w });
    }
  }
  return out;
}

function initials(email: string | undefined, fallback: string): string {
  if (!email) return fallback.slice(0, 2).toUpperCase();
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

export function UsageSection() {
  const usage = useAppState((s) => s.usage);
  const hubs = useAppState((s) => s.settings?.hubs) ?? NO_HUBS;
  const now = useNow(30_000);
  const [error, setError] = useState("");
  useEffect(() => {
    readUsage(false).catch((e: unknown) => setError(messageOf(e)));
  }, []);
  const refresh = () => {
    setError("");
    readUsage(true).catch((e: unknown) => setError(messageOf(e)));
  };
  const reading = !usage || usage.reading;
  const source = hubs.length ? `From ${hubs.map((h) => h.url.replace(/^https?:\/\//, "")).join(" and ")}.` : "From Claude Code and Codex on this Mac.";
  return (
    <section className="pb-section pb-set7-usage" aria-labelledby="set7-usage" data-reading={reading || undefined}>
      <div className="pb-section-head">
        <h2 className="pb-section-title" id="set7-usage">
          Usage
        </h2>
      </div>
      <div className="pb-set7-checked">
        <span className="pb-set7-checked-text" role="status">
          {reading ? "Reading now." : `${source} ${checkedWords(usage?.checkedAt, now)}`}
        </span>
        <button type="button" className="pb-btn pb-btn-sm pb-btn-quiet pb-set7-refresh" aria-disabled={reading || undefined} onClick={() => !reading && refresh()}>
          Refresh
        </button>
      </div>
      <ProblemLine text={error || usage?.problem || ""} />
      <div className="pb-set7-meters">
        {(usage?.providers ?? []).map((p) => (
          <ProviderMeters key={p.id} p={p} now={now} />
        ))}
      </div>
    </section>
  );
}

function ProviderMeters({ p, now }: { p: UsageProvider; now: number }) {
  const rows = poolWindows(p);
  const several = p.accounts.length > 1;
  return (
    <div className="pb-set7-meter-group" data-provider={p.id}>
      <h3 className="pb-set7-meter-title">{p.label}</h3>
      {p.accounts
        .filter((a) => a.problem)
        .map((a) => (
          <p key={a.id} className="pb-hint pb-set7-meter-problem">
            {several && a.email ? `${a.email}: ${a.problem}` : a.problem}
          </p>
        ))}
      {rows.map((r) => {
        const pooled = Math.round(r.members.reduce((n, m) => n + left(m.window), 0) / r.members.length);
        return (
          <div className="pb-set7-meter" key={r.id} data-window={r.id}>
            <div className="pb-set7-meter-head">
              <span className="pb-set7-meter-label">{r.label}</span>
              <span className="pb-set7-meter-left">
                <span className="pb-set7-meter-pct">{`${pooled}%`}</span> left
              </span>
            </div>
            <div className="pb-set7-bars" data-several={several || undefined}>
              {r.members.map(({ account, window }) => (
                <Bar key={account.id} account={account} window={window} now={now} several={several} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Bar({ account, window, now, several }: { account: UsageAccount; window: UsageWindow; now: number; several: boolean }) {
  const l = left(window);
  const reset = resetWords(window.resetsAt, now);
  const who = account.email ?? account.via;
  const label = `${several ? `${who}: ` : ""}${l}% left${reset ? `, ${reset}` : ""}`;
  return (
    <div className="pb-set7-bar" title={[who, account.plan, reset].filter(Boolean).join(" · ")} aria-label={label} role="img" data-low={l <= 15 || undefined}>
      {several && <span className="pb-set7-chip">{initials(account.email, account.via)}</span>}
      <span className="pb-set7-bar-track">
        <span className="pb-set7-bar-fill" style={{ width: `${l}%` }} />
      </span>
      <span className="pb-set7-bar-pct">{`${l}%`}</span>
      <span className="pb-set7-bar-reset">{reset}</span>
    </div>
  );
}

// ------------------------------------------------------------ the update dialog

/**
 * What the round arrow (and "Update" in Providers) opens: what will be updated and how, then the
 * run as it goes, and its result in plain words. Closing it does not stop the update.
 */
export function UpdateDialog({ onClose }: { onClose(): void }) {
  const providers = useAppState((s) => s.providers);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const run = providers?.update ?? null;
  const going = !!run && !run.endedAt;
  const todo = providers?.providers.filter((p) => p.updateAvailable) ?? [];
  const showRun = started || going;
  const start = () => {
    setError("");
    setStarted(true);
    updateProviders().catch((e: unknown) => {
      setStarted(false);
      setError(messageOf(e));
    });
  };
  const title = !showRun ? `Update ${todo.map((p) => p.label).join(" and ") || "the providers"}?` : going || !run ? "Updating" : run.phase === "done" ? "Update done" : "Update did not finish";
  const intro: ReactNode = !showRun ? (
    <>
      {todo.map((p) => (
        <span key={p.id} className="pb-set7-update-what">{`${p.label} ${p.version ?? ""} to ${p.latest ?? ""}`}</span>
      ))}
      <span>Pobots waits until your bots are done, updates, and restarts their {todo.map((p) => p.label).join(" and ") || "programs"}. Pobots itself keeps running.</span>
    </>
  ) : (
    <span className="pb-set7-update-line" role="status">
      {run?.line ?? "Starting the update."}
    </span>
  );
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="pb-dialog-text pb-set7-update-text">{intro}</p>
      {showRun && going && <p className="pb-hint">It goes on if you close this.</p>}
      <ProblemLine text={error} />
      <div className="pb-dialog-actions">
        {!showRun ? (
          <>
            <button className="pb-btn pb-btn-quiet" type="button" onClick={onClose}>
              Not now
            </button>
            <button className="pb-btn pb-btn-primary pb-set7-update-go" type="button" data-autofocus aria-disabled={todo.length === 0 || undefined} onClick={() => todo.length && start()}>
              Update
            </button>
          </>
        ) : (
          <button className="pb-btn pb-btn-primary" type="button" data-autofocus onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </Dialog>
  );
}
